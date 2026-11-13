// Server-less mode: the browser reads the two ERA5 Zarr stores itself, so the app can be
// hosted as plain static files. This is the JavaScript twin of era5view/store.py and
// must describe the datasets exactly as /api/meta does; keep the two in step.
//
// The buckets' ordinary URLs send no CORS headers, but the Cloud Storage JSON API does,
// for any origin, so everything here goes through that.

import { bloscDecode } from "./blosc.js";

const FORECAST_URL = "https://storage.googleapis.com/weatherbench2/datasets/era5-forecasts/2020-1440x721.zarr";
const REANALYSIS_URL = "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3";
const REANALYSIS_START = "2026-01-01";

const API = "https://storage.googleapis.com/storage/v1";
const T2M = "2m_temperature";
const FRAME_VARS = [T2M, "10m_u_component_of_wind", "10m_v_component_of_wind"];
const HOUR = 3600e3;
const UNIT_MS = { seconds: 1e3, minutes: 60e3, hours: HOUR, days: 24 * HOUR };
const ARRAY_TYPES = { "<i4": Int32Array, "<i8": BigInt64Array, "<f4": Float32Array, "<f8": Float64Array };

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return res;
}

/** Split CF time units such as "hours since 2020-01-01" into [unit, epoch in ms]. */
function parseUnits(units) {
  const m = /^(hours|days|minutes|seconds) since (\d{4}-\d\d-\d\d)(?:[ T](\d\d:\d\d(?::\d\d)?))?$/.exec(units);
  if (!m) throw new Error(`unsupported time units: ${units}`);
  return [m[1], Date.parse(`${m[2]}T${m[3] ?? "00:00"}Z`)];
}

class Zarr {
  constructor(url) {
    this.url = url;
    [, this.bucket, this.path] = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/.exec(url);
  }

  objectUrl(key) {
    return `${API}/b/${this.bucket}/o/${encodeURIComponent(`${this.path}/${key}`)}?alt=media`;
  }

  async json(key) {
    return (await get(this.objectUrl(key))).json();
  }

  async open() {
    this.meta = (await this.json(".zmetadata")).metadata;
    return this;
  }

  /** First chunk of a 1-D coordinate array, as plain numbers. */
  async coord(name) {
    const za = this.meta[`${name}/.zarray`];
    const type = ARRAY_TYPES[za.dtype];
    if (!type || za.filters || za.compressor?.id !== "blosc") throw new Error(`${name}: unsupported encoding`);
    const raw = new Uint8Array(await (await get(this.objectUrl(`${name}/0`))).arrayBuffer());
    return Array.from(new type(bloscDecode(raw).buffer), Number);
  }

  /** Leading chunk indices of the chunks of `name` that exist, within [from, to]. */
  async chunksPresent(name, from, to) {
    // Object names sort as text: fine here because both ends have the same number of digits.
    const key = (index) => encodeURIComponent(`${this.path}/${name}/${index}.`);
    const list = await (await get(
      `${API}/b/${this.bucket}/o?startOffset=${key(from)}&endOffset=${key(to + 1)}` +
      `&maxResults=${to - from + 1}&fields=items/name`)).json();
    return new Set((list.items ?? []).map((item) => parseInt(item.name.split("/").pop(), 10)));
  }
}

/** The description /api/meta gives of a dataset, plus a loader for its frames. */
function describe(zarr, { id, dataset, inits, leads, nx, ny, flip, finalUntil = null, chunkKey }) {
  return {
    id,
    dataset,
    source: zarr.url,
    inits,
    leads,
    final_until: finalUntil,
    grid: { nx, ny, lon0: 0, dlon: 360 / nx, lat0: 90, dlat: -180 / (ny - 1) },
    channels: ["t2m_degC", "u10_ms", "v10_ms"],
    dtype: "float16",
    /** Resolves to the frame as a Uint16Array of half floats, as the server would send it. */
    loadFrame: (init, lead, signal) => requestFrame({
      urls: FRAME_VARS.map((name) => zarr.objectUrl(chunkKey(name, init, lead))),
      nx,
      ny,
      flip,
    }, signal),
  };
}

/** ERA5-Forecasts: (time, prediction_timedelta, latitude, longitude), one chunk per field. */
async function forecast() {
  const zarr = await new Zarr(FORECAST_URL).open();
  const [time, lead, lat] = await Promise.all(["time", "prediction_timedelta", "latitude"].map((n) => zarr.coord(n)));
  const [unit, epoch] = parseUnits(zarr.meta["time/.zattrs"].units);
  const leadHours = UNIT_MS[zarr.meta["prediction_timedelta/.zattrs"].units ?? "hours"] / HOUR;
  const [, , ny, nx] = zarr.meta[`${T2M}/.zarray`].shape;
  return describe(zarr, {
    id: "forecast",
    dataset: "ERA5-Forecasts (WeatherBench 2)",
    inits: time.map((v) => iso(epoch + v * UNIT_MS[unit])),
    leads: lead.map((v) => Math.round(v * leadHours)),
    nx,
    ny,
    flip: lat[0] < lat.at(-1),
    chunkKey: (name, init, k) => `${name}/${init}.${k}.0.0`,
  });
}

/**
 * ARCO-ERA5: hourly (time, latitude, longitude), one chunk per hour, shown as 10-day
 * windows. The time axis is allocated far ahead; the store's attributes say how far it
 * is filled, and the newest days can still have holes, so those are checked.
 */
async function reanalysis() {
  const WINDOW_HOURS = 240, FRAME_EVERY = 6, START_EVERY = 12, PROBE_DAYS = 14;
  const zarr = await new Zarr(REANALYSIS_URL).open();
  const [time, lat, attrs] = await Promise.all([zarr.coord("time"), zarr.coord("latitude"), zarr.json(".zattrs")]);
  const [unit, epoch] = parseUnits(zarr.meta["time/.zattrs"].units);
  if (unit !== "hours" || time[1] - time[0] !== 1) throw new Error("expected an hourly time axis");
  const origin = epoch + time[0] * HOUR;  // time of chunk 0
  const chunkOf = (ms) => Math.round((ms - origin) / HOUR);
  const day = (key, hour) => Date.parse(`${attrs[key].slice(0, 10)}T00:00Z`) + hour * HOUR;

  // Last frame time up to which the newest days are gap-free in all three variables.
  const stop = day("valid_time_stop_era5t", 23);
  const probeFrom = day("valid_time_stop_era5t", 0) - (PROBE_DAYS - 1) * 24 * HOUR;
  const present = await Promise.all(
    FRAME_VARS.map((name) => zarr.chunksPresent(name, chunkOf(probeFrom), chunkOf(stop))));
  let filled = probeFrom - FRAME_EVERY * HOUR;
  for (let t = probeFrom; t <= stop && present.every((set) => set.has(chunkOf(t))); t += FRAME_EVERY * HOUR) {
    filled = t;
  }

  const first = Math.max(day("valid_time_start", 0), Date.parse(`${REANALYSIS_START}T00:00Z`));
  const count = Math.floor((filled - WINDOW_HOURS * HOUR - first) / (START_EVERY * HOUR)) + 1;
  if (count < 1) throw new Error(`no complete ${WINDOW_HOURS} h window after ${iso(first).slice(0, 10)}`);
  const firstChunk = chunkOf(first);
  const [, ny, nx] = zarr.meta[`${T2M}/.zarray`].shape;
  return describe(zarr, {
    id: "reanalysis",
    dataset: "ERA5 reanalysis (ARCO-ERA5)",
    inits: Array.from({ length: count }, (_, k) => iso(first + k * START_EVERY * HOUR)),
    leads: Array.from({ length: WINDOW_HOURS / FRAME_EVERY + 1 }, (_, k) => k * FRAME_EVERY),
    nx,
    ny,
    flip: lat[0] < lat.at(-1),
    finalUntil: iso(day("valid_time_stop", 23)),
    chunkKey: (name, init, k) => `${name}/${firstChunk + init * START_EVERY + k * FRAME_EVERY}.0.0`,
  });
}

/** Every dataset that can be reached right now; fails only if none can. */
export async function loadCatalog() {
  const results = await Promise.allSettled([forecast(), reanalysis()]);
  const datasets = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!datasets.length) throw results[0].reason;
  return { datasets };
}

// ------------------------------------------------------------------ frames

let worker = null;
let nextId = 0;
const waiting = new Map();  // job id -> { resolve, reject }

function startWorker() {
  const w = new Worker(new URL("./direct-worker.js", import.meta.url), { type: "module" });
  w.onmessage = ({ data }) => {
    const job = waiting.get(data.id);
    if (!job) return;  // cancelled
    waiting.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(new Uint16Array(data.frame));
  };
  w.onerror = (e) => {  // the worker itself failed (e.g. could not load): start afresh next time
    worker = null;
    for (const job of waiting.values()) job.reject(new Error(e.message || "frame decoder failed"));
    waiting.clear();
  };
  return w;
}

function requestFrame(job, signal) {
  worker ??= startWorker();
  const w = worker;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    signal.addEventListener("abort", () => {
      if (!waiting.delete(id)) return;
      w.postMessage({ cancel: id });
      reject(signal.reason);
    }, { once: true });
    w.postMessage({ id, ...job });
  });
}
