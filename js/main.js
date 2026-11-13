import { COLORMAPS } from "./colormaps.js";
import { FieldLayer } from "./field-layer.js";
import { FrameStore } from "./frames.js";
import { renderChart } from "./chart.js";
import { WindLayer } from "./wind-layer.js";

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const HOURS_PER_SECOND = 12; // playback rate at 1x: one 6 h step every half second

const LAYERS = {
  t2m: {
    title: "2 m temperature", unit: "°C", mode: 0,
    vmin: -50, vmax: 50, ticks: [-40, -20, 0, 20, 40],
    contour: 5, major: 2,
    cmaps: ["roma", "berlin", "vik", "batlow", "magma", "cividis"],
    flowAlpha: 0.6,
  },
  wind: {
    title: "10 m wind speed", unit: "m/s", mode: 1,
    vmin: 0, vmax: 30, ticks: [0, 5, 10, 15, 20, 25, 30],
    contour: 5, major: 2,
    cmaps: ["viridis", "lapaz", "oslo", "tokyo", "inferno", "cividis"],
    flowAlpha: 0.85,
  },
};

// Jump-off points per dataset. `init` is where the timeline starts, a few days ahead of the peak.
const STORIES = {
  forecast: [
    { title: "Storm Ciara", when: "7 Feb", blurb: "Atlantic windstorm sweeps north-west Europe",
      init: "2020-02-07T00:00Z", layer: "wind", center: [-12, 53], zoom: 3.3 },
    { title: "Cyclone Amphan", when: "16 May", blurb: "Super cyclone tracks up the Bay of Bengal",
      init: "2020-05-16T00:00Z", layer: "wind", center: [88, 15], zoom: 4.1 },
    { title: "Siberian heatwave", when: "17 Jun", blurb: "Record 38 °C north of the Arctic Circle",
      init: "2020-06-17T00:00Z", layer: "t2m", center: [125, 64], zoom: 3.1 },
    { title: "Hurricane Laura", when: "24 Aug", blurb: "Category 4 landfall in Louisiana",
      init: "2020-08-24T00:00Z", layer: "wind", center: [-88, 25], zoom: 4.2 },
    { title: "Typhoon Goni", when: "29 Oct", blurb: "Year's most intense landfall, Philippines",
      init: "2020-10-29T00:00Z", layer: "wind", center: [130, 15], zoom: 4.2 },
  ],
  reanalysis: [
    { title: "Central Europe heatwave", when: "23 Jun", blurb: "National records in Germany, Czechia and Poland",
      init: "2026-06-23T00:00Z", layer: "t2m", center: [12, 50], zoom: 3.5 },
    { title: "Typhoon Bavi", when: "3 Jul", blurb: "Crosses the Marianas at Rota, then heads for China",
      init: "2026-07-03T00:00Z", layer: "wind", center: [138, 19], zoom: 3.3 },
    { title: "Mediterranean heat", when: "14 Jul", blurb: "Sardinia reaches the mid-40s °C",
      init: "2026-07-14T00:00Z", layer: "t2m", center: [10, 41], zoom: 3.8 },
    { title: "Typhoon Noul", when: "23 Jul", blurb: "Through the Luzon Strait to a Guangdong landfall",
      init: "2026-07-23T00:00Z", layer: "wind", center: [119, 19], zoom: 4 },
    { title: "Typhoon Dolphin", when: "1 Aug", blurb: "Long Pacific track to Okinawa and Zhejiang",
      init: "2026-08-01T00:00Z", layer: "wind", center: [140, 25], zoom: 3.3 },
  ],
};

// Wording that differs between a forecast (run + lead time) and the reanalysis
// (a 10-day window of analyses).
const COPY = {
  forecast: {
    tab: "Forecasts", tagline: "0.25° global · IFS initialised from ERA5",
    runHead: "Forecast run", count: (n) => `${n} runs`,
    prev: "Previous run (−12 h)", next: "Next run (+12 h)",
    clock: (run) => `Valid time · run <span>${run}</span>`, lead: "lead time",
    timeline: "Forecast lead time", probe: "Point forecast", origin: "run",
    none: "No forecast run on that date",
  },
  reanalysis: {
    tab: "Reanalysis", tagline: "0.25° global · hourly ERA5 reanalysis",
    runHead: "10-day window", count: (n) => `${n} start times`,
    prev: "Start 12 h earlier", next: "Start 12 h later",
    clock: (run) => `ERA5 analysis · window from <span>${run}</span>`, lead: "since start",
    timeline: "Time since window start", probe: "Point time series", origin: "start",
    none: "No ERA5 window starts on that date",
  },
};

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const fmtDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
const fmtShort = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:00`;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const ARROW = (deg) =>
  `<svg class="arrow" viewBox="0 0 12 12" style="transform:rotate(${deg.toFixed(0)}deg)"><path d="M6 1.200L9.500 10 6 8 2.500 10z" fill="currentColor"/></svg>`;

const state = {
  layer: "t2m",
  cmap: { t2m: "roma", wind: "viridis" },
  init: 0,
  hours: 0,          // continuous lead time
  playing: false,
  speed: 1,
  flow: true,
  iso: true,
  pin: null,         // { lng, lat }
  cursor: null,      // { lng, lat, x, y }
  hoverLead: null,   // lead index hovered in the point-forecast charts
};

const datasets = new Map(); // id -> dataset description (see loadCatalog)
const lastInit = {};        // dataset id -> run last viewed there
let meta;                   // the dataset on screen
let store, map, field, wind, marker;
let shown = null;    // { init, i, j, mix } currently on the GPU
let holdUntil = 0;
let lastTick = 0;
let booted = false;

boot().catch((err) => {
  console.error(err);
  $("#splash").classList.add("error");
  $("#splash-sub").textContent = `Could not start: ${err.message}`;
});

// ====================================================================== boot

async function boot() {
  if (!window.maplibregl) throw new Error("the map library failed to load (are you offline?)");
  for (const ds of (await loadCatalog()).datasets) {
    ds.maxH = ds.leads.at(-1);
    ds.initIndex = new Map(ds.inits.map((s, i) => [s, i]));
    ds.stories = (STORIES[ds.id] ?? []).filter((s) => ds.initIndex.has(s.init));
    datasets.set(ds.id, ds);
  }
  const first = datasets.get(new URLSearchParams(location.search).get("dataset")) ?? datasets.values().next().value;
  const opening = first.stories[0];
  if (opening) state.layer = opening.layer;

  store = new FrameStore();
  store.addEventListener("frame", onFrame);
  store.addEventListener("error", (e) => {
    tickEls[e.detail.lead]?.classList.add("failed");
    toast(`Couldn't load +${meta.leads[e.detail.lead]} h — click to retry`, () => {
      document.querySelectorAll(".ticks i.failed").forEach((el) => el.classList.remove("failed"));
      store.retryFailed();
    });
  });

  $("#splash-sub").textContent = "Preparing the map…";
  const style = await loadBasemap();
  map = new maplibregl.Map({
    container: "map",
    style,
    center: opening?.center ?? [10, 30],
    zoom: opening?.zoom ?? 2,
    minZoom: minZoomForViewport(),
    maxZoom: 8.5,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    fadeDuration: 150,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: "ECMWF ERA5-Forecasts via WeatherBench 2 · ERA5 reanalysis via ARCO-ERA5 · contains modified Copernicus Climate Change Service information",
  }), "bottom-right");
  // Start collapsed to the (i) button; it expands on click.
  const attrib = document.querySelector(".maplibregl-ctrl-attrib");
  attrib?.classList.remove("maplibregl-compact-show");
  attrib?.removeAttribute("open");
  map.on("error", (e) => console.warn("map:", e.error?.message ?? e));
  window.addEventListener("resize", () => map.setMinZoom(minZoomForViewport()));

  field = new FieldLayer({ nx: first.grid.nx, ny: first.grid.ny });
  wind = new WindLayer({ nx: first.grid.nx, ny: first.grid.ny });
  map.once("style.load", () => {
    const ids = map.getStyle().layers.map((l) => l.id);
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    try {
      // Stack: basemap fills < field < streamlets < coast & borders < labels.
      const above = ids.includes("coast-case") ? "coast-case" : firstSymbol;
      map.addLayer(field, above);
      map.addLayer(wind, above);
    } catch (err) {
      $("#splash").classList.add("error");
      $("#splash-sub").textContent = `Could not start: ${err.message}`;
      throw err;
    }
    applyLayer();
    if (meta) applyTime(true);
  });

  buildLayerUI();
  buildRunUI();
  buildTimelineUI();
  buildProbeUI();
  bindKeys();

  $("#splash-sub").textContent = "Downloading the first fields…";
  setDataset(first.id);
  if (new URLSearchParams(location.search).has("debug")) {
    window.__app = { state, store, map, field, wind, datasets, setDataset, get meta() { return meta; } };
  }
}

/**
 * Dataset descriptions: from the Python server when the page is served by it, otherwise
 * (static hosting, or ?backend=direct) read from the archives by the browser itself.
 */
async function loadCatalog() {
  if (new URLSearchParams(location.search).get("backend") !== "direct") {
    const res = await fetch("api/meta").catch(() => null);
    if (res?.ok && res.headers.get("content-type")?.includes("json")) return res.json();
    // A server that cannot reach the archives answers 502 and says why; a static host has no /api at all.
    if (res?.status >= 500) throw new Error((await res.json().catch(() => ({}))).detail ?? `metadata request failed (${res.status})`);
  }
  return (await import("./direct.js")).loadCatalog();
}

// ================================================================== dataset

/** Switch between the forecast archive and the reanalysis; returns to the run last viewed there. */
function setDataset(id) {
  const ds = datasets.get(id);
  if (!ds || ds === meta) return;
  if (ds.grid.nx !== field.nx || ds.grid.ny !== field.ny) return toast("That dataset is on a different grid");
  setPlaying(false);
  if (meta) lastInit[meta.id] = state.init;
  meta = ds;
  shown = null;
  store.setDataset(ds);

  const C = COPY[ds.id];
  $("#tagline").textContent = C.tagline;
  for (const btn of document.querySelectorAll("#dataset-seg button")) {
    btn.setAttribute("aria-checked", String(btn.dataset.id === ds.id));
  }
  $("#run-head").textContent = C.runHead;
  $("#run-count").textContent = C.count(ds.inits.length);
  $("#run-date").min = ds.inits[0].slice(0, 10);
  $("#run-date").max = ds.inits.at(-1).slice(0, 10);
  for (const [sel, text] of [["#run-prev", C.prev], ["#run-next", C.next]]) {
    $(sel).title = text;
    $(sel).setAttribute("aria-label", text);
  }
  $("#lead-label").textContent = C.lead;
  $("#probe-head").textContent = C.probe;
  $("#timeline").setAttribute("aria-label", C.timeline);
  buildTicks();
  buildStories();
  setInit(lastInit[id] ?? ds.initIndex.get(ds.stories[0]?.init) ?? 0, { hours: 0 });
}

function minZoomForViewport() {
  // Never show more than one copy of the world: keeps the particle field simple.
  return Math.max(1, Math.log2(window.innerWidth / 512) + 0.01);
}

async function loadBasemap() {
  const fallback = {
    version: 8, sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#0b0f17" } }],
  };
  try {
    const res = await fetch(BASEMAP_STYLE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const style = await res.json();
    const water = style.layers.find((l) => l.id === "water");
    const labelIds = /^(watername_(ocean|sea)|place_(continent|country_[12]|state|city_dot_\w+|capital_dot_z7|city_r[56]|town))$/;
    const layers = [{ id: "background", type: "background", paint: { "background-color": "#0b0f17" } }];
    if (water) {
      layers.push({ ...water, paint: { "fill-color": "#111827" } });
      // Coastlines and lake shores, drawn above the data field: a dark casing under
      // a light line, so the shore reads on every colour of every scale.
      layers.push({
        id: "coast-case", type: "line", source: water.source, "source-layer": water["source-layer"],
        filter: ["==", ["geometry-type"], "Polygon"],
        layout: { "line-join": "round" },
        paint: {
          "line-color": "rgba(5,8,14,0.36)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.1, 4, 2.4, 8, 3.6],
        },
      });
      layers.push({
        id: "coast", type: "line", source: water.source, "source-layer": water["source-layer"],
        filter: ["==", ["geometry-type"], "Polygon"],
        layout: { "line-join": "round" },
        paint: {
          "line-color": "rgba(255,255,255,0.78)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 4, 0.9, 8, 1.4],
        },
      });
    }
    for (const l of style.layers) {
      if (l.id === "boundary_country_inner" || l.id === "boundary_state") {
        const country = l.id === "boundary_country_inner";
        // Same casing trick as the coast, one step quieter.
        layers.push({
          ...l, id: `${l.id}_case`,
          paint: {
            "line-color": country ? "rgba(5,8,14,0.3)" : "rgba(5,8,14,0.16)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 2, country ? 1.2 : 0.8, 8, country ? 2.8 : 2],
          },
        });
        layers.push({
          ...l,
          paint: {
            "line-color": country ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.26)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 2, country ? 0.45 : 0.3, 8, country ? 1.1 : 0.7],
            ...(country ? {} : { "line-dasharray": [2, 2] }),
          },
        });
      }
    }
    for (const l of style.layers) {
      if (l.type !== "symbol" || !labelIds.test(l.id)) continue;
      const waterName = l.id.startsWith("watername");
      layers.push({
        ...l,
        paint: {
          ...l.paint,
          "text-color": waterName ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.94)",
          "text-halo-color": "rgba(5,8,14,0.7)",
          "text-halo-width": 1.3,
          "text-halo-blur": 0.6,
        },
      });
    }
    return { ...style, layers };
  } catch (err) {
    console.warn("basemap unavailable, continuing without it:", err);
    setTimeout(() => toast("Basemap unavailable — showing data only"), 1500);
    return fallback;
  }
}

// ====================================================================== time

/** Frames bracketing a lead time: [i, j, mix]. */
function bracket(hours) {
  const L = meta.leads;
  let i = 0;
  while (i < L.length - 1 && L[i + 1] <= hours) i++;
  if (i >= L.length - 1) return [L.length - 1, L.length - 1, 0];
  const mix = (hours - L[i]) / (L[i + 1] - L[i]);
  if (mix < 0.002) return [i, i, 0];
  if (mix > 0.998) return [i + 1, i + 1, 0];
  return [i, i + 1, mix];
}

function nearestLead(hours) {
  let best = 0;
  for (let k = 1; k < meta.leads.length; k++) {
    if (Math.abs(meta.leads[k] - hours) < Math.abs(meta.leads[best] - hours)) best = k;
  }
  return best;
}

const validDate = (hours) => new Date(Date.parse(meta.inits[state.init]) + hours * 3600e3);

/** Push the frames for state.hours to the GPU (if they are loaded) and refresh the UI. */
function applyTime(force = false) {
  const [i, j, mix] = bracket(state.hours);
  store.setFocus(i);
  const ready = store.has(i) && store.has(j);
  if (ready && field?.map) {
    if (force || !shown || shown.init !== state.init || shown.i !== i || shown.j !== j || shown.mix !== mix) {
      const run = `${meta.id}:${state.init}`;
      const a = { key: `${run}:${i}`, data: store.get(i) };
      const b = j !== i ? { key: `${run}:${j}`, data: store.get(j) } : null;
      field.setFrames(a, b, mix);
      wind.setWind(a.data, b?.data, mix);
      shown = { init: state.init, i, j, mix };
      if (!booted) finishBoot();
    }
  }
  document.body.classList.toggle("busy", !ready);
  updateTimeUI();
  updateReadouts();
}

function finishBoot() {
  booted = true;
  $("#splash").classList.add("done");
  document.body.classList.remove("booting");
}

function seek(hours, { snap = false } = {}) {
  state.hours = clamp(snap ? meta.leads[nearestLead(hours)] : hours, 0, meta.maxH);
  applyTime();
}

function step(dir) {
  setPlaying(false);
  const k = clamp(nearestLead(state.hours) + dir, 0, meta.leads.length - 1);
  seek(meta.leads[k]);
}

function setPlaying(on) {
  if (state.playing === on) return;
  state.playing = on;
  $("#btn-play").classList.toggle("playing", on);
  $("#btn-play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) {
    if (state.hours >= meta.maxH) state.hours = 0;
    holdUntil = 0;
    lastTick = performance.now();
    requestAnimationFrame(tick);
  } else {
    seek(state.hours, { snap: true }); // rest on real model output, not a blend
  }
}

function tick(now) {
  if (!state.playing) return;
  const dt = Math.min(now - lastTick, 100);
  lastTick = now;
  if (holdUntil) {
    if (now >= holdUntil) { holdUntil = 0; state.hours = 0; }
  } else {
    const target = Math.min(state.hours + (dt / 1000) * HOURS_PER_SECOND * state.speed, meta.maxH);
    const [i, j] = bracket(target);
    if (store.has(i) && store.has(j)) {
      state.hours = target;
      if (target >= meta.maxH) holdUntil = now + 1400; // linger on the last frame, then loop
    } else {
      store.setFocus(i); // buffering: wait here
      document.body.classList.add("busy");
      updateTimeUI();
      requestAnimationFrame(tick);
      return;
    }
  }
  applyTime();
  requestAnimationFrame(tick);
}

function setInit(idx, { hours = state.hours } = {}) {
  idx = clamp(idx, 0, meta.inits.length - 1);
  state.init = idx;
  state.hours = hours;
  field.invalidate();
  store.setInit(idx, bracket(state.hours)[0]);
  tickEls.forEach((el) => (el.className = ""));
  updateRunUI();
  buildDayLabels();
  applyTime();
  updateProbeSeries();
}

function onFrame(e) {
  const k = e.detail.lead;
  tickEls[k]?.classList.add("loaded");
  const [i, j] = bracket(state.hours);
  if (k === i || k === j) applyTime();
  else updateTimeUI();
  scheduleProbeSeries();
}

// ==================================================================== layers

function buildLayerUI() {
  for (const btn of document.querySelectorAll("#layer-seg button")) {
    btn.addEventListener("click", () => setLayer(btn.dataset.layer));
  }
  $("#tg-wind").addEventListener("change", (e) => setFlow(e.target.checked));
  $("#tg-iso").addEventListener("change", (e) => setIso(e.target.checked));
  if (window.innerWidth < 760) $("#panel-main").classList.add("collapsed"); // phones: map first
  $("#btn-collapse").addEventListener("click", () => {
    const collapsed = $("#panel-main").classList.toggle("collapsed");
    $("#btn-collapse").setAttribute("aria-expanded", String(!collapsed));
  });
  applyLayer();
}

function setLayer(id) {
  if (!LAYERS[id] || state.layer === id) return;
  state.layer = id;
  applyLayer();
}

function setFlow(on) {
  state.flow = on;
  $("#tg-wind").checked = on;
  wind?.setEnabled(on);
}

function setIso(on) {
  state.iso = on;
  $("#tg-iso").checked = on;
  applyLayer();
}

function applyLayer() {
  const L = LAYERS[state.layer];
  const cmap = COLORMAPS[state.cmap[state.layer]];
  for (const btn of document.querySelectorAll("#layer-seg button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.layer === state.layer));
  }
  $("#legend-title").textContent = L.title;
  $("#legend-unit").textContent = L.unit;

  // Legend bar straight from the colour stops the shader uses.
  const cv = $("#legend-canvas");
  const ctx = cv.getContext("2d");
  const n = cmap.stops.length;
  for (let x = 0; x < 256; x++) {
    ctx.fillStyle = cmap.stops[Math.round((x / 255) * (n - 1))];
    ctx.fillRect(x, 0, 1, 1);
  }
  $("#legend-ticks").innerHTML = L.ticks
    .filter((_, i, a) => a.length <= 5 || i % 2 === 0)
    .map((t) => `<span style="left:${(((t - L.vmin) / (L.vmax - L.vmin)) * 100).toFixed(2)}%">${t}</span>`)
    .join("");

  const list = $("#cmap-list");
  list.innerHTML = "";
  for (const id of L.cmaps) {
    const c = COLORMAPS[id];
    const btn = document.createElement("button");
    const picks = Array.from({ length: 12 }, (_, i) => c.stops[Math.round((i / 11) * (c.stops.length - 1))]);
    btn.style.background = `linear-gradient(90deg, ${picks.join(",")})`;
    btn.title = `${c.label} (${c.kind})`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-label", c.label);
    btn.setAttribute("aria-checked", String(id === state.cmap[state.layer]));
    btn.addEventListener("click", () => { state.cmap[state.layer] = id; applyLayer(); });
    list.append(btn);
  }
  let name = $("#cmap-name");
  if (!name) {
    name = Object.assign(document.createElement("div"), { id: "cmap-name", className: "cmap-name" });
    list.after(name);
  }
  name.innerHTML = `<b>${cmap.label}</b> · ${cmap.kind}, perceptually uniform`;

  if (field) {
    field.setColormap(cmap.stops.map(hexToRgb));
    field.setStyle({
      mode: L.mode, vmin: L.vmin, vmax: L.vmax, opacity: 0.94,
      contour: state.iso ? L.contour : 0, major: L.major,
    });
    wind.alpha = L.flowAlpha;
  }
  updateReadouts();
}

// ======================================================================= run

function buildRunUI() {
  const seg = $("#dataset-seg");
  seg.hidden = datasets.size < 2;
  for (const ds of datasets.values()) {
    const y0 = ds.inits[0].slice(0, 4), y1 = ds.inits.at(-1).slice(0, 4);
    const btn = document.createElement("button");
    btn.setAttribute("role", "radio");
    btn.dataset.id = ds.id;
    btn.title = ds.dataset;
    btn.innerHTML = `<span>${COPY[ds.id].tab}</span><small>${y0 === y1 ? y0 : `${y0}–${y1.slice(2)}`}</small>`;
    btn.addEventListener("click", () => setDataset(ds.id));
    seg.append(btn);
  }

  const date = $("#run-date");
  date.addEventListener("change", () => {
    if (!date.value) return updateRunUI();
    pickRun(date.value, new Date(meta.inits[state.init]).getUTCHours());
  });
  for (const btn of document.querySelectorAll("#run-hour button")) {
    btn.addEventListener("click", () => pickRun(meta.inits[state.init].slice(0, 10), Number(btn.dataset.h)));
  }
  $("#run-prev").addEventListener("click", () => setInit(state.init - 1));
  $("#run-next").addEventListener("click", () => setInit(state.init + 1));
}

function buildStories() {
  const wrap = $("#stories");
  wrap.innerHTML = "";
  wrap.hidden = $("#stories-head").hidden = !meta.stories.length;
  if (!meta.stories.length) return;
  $("#stories-title").textContent = `Notable weather of ${meta.stories[0].init.slice(0, 4)}`;
  for (const s of meta.stories) {
    const btn = document.createElement("button");
    btn.className = "story";
    btn.innerHTML = `<b>${s.title}</b><time>${s.when}</time><span>${s.blurb}</span>`;
    btn.addEventListener("click", () => playStory(s));
    s.el = btn;
    wrap.append(btn);
  }
}

function pickRun(dateStr, hour) {
  const iso = `${dateStr}T${String(hour).padStart(2, "0")}:00Z`;
  const idx = meta.initIndex.get(iso) ?? meta.initIndex.get(`${dateStr}T00:00Z`);
  if (idx === undefined) { toast(COPY[meta.id].none); return updateRunUI(); }
  setInit(idx);
}

function updateRunUI() {
  const iso = meta.inits[state.init];
  const d = new Date(iso);
  $("#run-date").value = iso.slice(0, 10);
  for (const btn of document.querySelectorAll("#run-hour button")) {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.h) === d.getUTCHours()));
  }
  $("#run-prev").disabled = state.init === 0;
  $("#run-next").disabled = state.init === meta.inits.length - 1;
  $("#clock-sub").innerHTML = COPY[meta.id].clock(`${fmtShort.format(d)} ${String(d.getUTCHours()).padStart(2, "0")}Z`);
  for (const s of meta.stories) s.el?.setAttribute("aria-current", String(s.init === iso));

  // Reanalysis: say so when the window reaches into the not-yet-final ERA5T stream.
  const final = meta.final_until ? new Date(meta.final_until) : null;
  const note = $("#run-note");
  note.hidden = !final || validDate(meta.maxH) <= final;
  if (!note.hidden) {
    note.innerHTML = d > final
      ? "<b>ERA5T</b> · preliminary, not yet final ERA5"
      : `<b>ERA5T</b> · preliminary after ${fmtShort.format(final)}`;
  }
}

function playStory(s) {
  setPlaying(false);
  setLayer(s.layer);
  setInit(meta.initIndex.get(s.init), { hours: 0 });
  map.flyTo({ center: s.center, zoom: Math.max(s.zoom, minZoomForViewport()), duration: 2600, essential: true });
  setPlaying(true);
}

// ================================================================== timeline

let tickEls = [];

function buildTicks() {
  const ticks = $("#ticks");
  ticks.innerHTML = "";
  tickEls = meta.leads.map((h) => {
    const el = document.createElement("i");
    el.style.left = `${(h / meta.maxH) * 100}%`;
    ticks.append(el);
    return el;
  });
  $("#timeline").setAttribute("aria-valuemax", String(meta.maxH));
}

function buildTimelineUI() {
  const tl = $("#timeline");
  const track = tl.querySelector(".track");
  const tip = $("#hover-tip");
  const hoursAt = (e) => {
    const r = track.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * meta.maxH;
  };
  let dragging = false;
  tl.addEventListener("pointerdown", (e) => {
    dragging = true;
    tl.setPointerCapture(e.pointerId);
    tl.classList.add("dragging");
    setPlaying(false);
    seek(hoursAt(e));
  });
  tl.addEventListener("pointermove", (e) => {
    const h = hoursAt(e);
    if (dragging) seek(h);
    const lead = meta.leads[nearestLead(h)];
    tip.hidden = false;
    tip.style.left = `${(lead / meta.maxH) * 100}%`;
    const d = validDate(lead);
    tip.textContent = `+${lead} h · ${fmtShort.format(d)} ${hhmm(d)}`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    tl.classList.remove("dragging");
    seek(state.hours, { snap: true });
  };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", () => { tip.hidden = true; });
  tl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { step(e.key === "ArrowLeft" ? -1 : 1); e.preventDefault(); e.stopPropagation(); }
    if (e.key === "Home") { setPlaying(false); seek(0); e.preventDefault(); }
    if (e.key === "End") { setPlaying(false); seek(meta.maxH); e.preventDefault(); }
  });

  $("#btn-play").addEventListener("click", () => setPlaying(!state.playing));
  $("#btn-prev").addEventListener("click", () => step(-1));
  $("#btn-next").addEventListener("click", () => step(1));
  for (const btn of document.querySelectorAll("#speed-seg button")) {
    btn.addEventListener("click", () => {
      state.speed = Number(btn.dataset.speed);
      document.querySelectorAll("#speed-seg button").forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
    });
  }
}

function buildDayLabels() {
  const initHour = new Date(meta.inits[state.init]).getUTCHours();
  const out = [];
  for (let h = (24 - initHour) % 24; h < meta.maxH - 8; h += 24) {
    out.push(`<span style="left:${(h / meta.maxH) * 100}%">${fmtDay.format(validDate(h))}</span>`);
  }
  $("#days").innerHTML = out.join("");
}

function updateTimeUI() {
  const pct = `${(state.hours / meta.maxH) * 100}%`;
  $("#thumb").style.left = pct;
  $("#track-fill").style.width = pct;
  const hr = Math.round(state.hours);
  const d = validDate(hr);
  $("#valid-date").textContent = fmtDate.format(d);
  $("#valid-hour").textContent = hhmm(d);
  $("#lead-chip").innerHTML = `+${hr}<small>h</small>`;
  const tl = $("#timeline");
  tl.setAttribute("aria-valuenow", String(hr));
  tl.setAttribute("aria-valuetext", `plus ${hr} hours, ${fmtDate.format(d)} ${hhmm(d)} UTC`);
  for (let k = 0; k < tickEls.length; k++) tickEls[k].classList.toggle("passed", meta.leads[k] <= state.hours);
}

// ===================================================================== probe

const tmpA = [0, 0, 0], tmpB = [0, 0, 0];

/** [T, u, v] at a point for the time currently on screen, or null. */
function sampleNow(lng, lat) {
  if (!shown || shown.init !== state.init) return null;
  const a = store.sample(shown.i, lng, lat, tmpA);
  if (!a) return null;
  if (shown.j === shown.i) return a;
  const b = store.sample(shown.j, lng, lat, tmpB);
  if (!b) return a;
  return a.map((v, c) => v + (b[c] - v) * shown.mix);
}

function describeWind(u, v) {
  const speed = Math.hypot(u, v);
  const to = (Math.atan2(u, v) * 180) / Math.PI;          // direction it blows towards
  const from = (to + 180 + 360) % 360;                     // meteorological convention
  return { speed, to, from, compass: COMPASS[Math.round(from / 22.5) % 16] };
}

function buildProbeUI() {
  map.on("mousemove", (e) => {
    state.cursor = { lng: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y };
    updateReadouts();
  });
  map.on("mouseout", () => { state.cursor = null; updateReadouts(); });
  map.on("dragstart", () => { $("#map").classList.add("dragging"); state.cursor = null; updateReadouts(); });
  map.on("dragend", () => $("#map").classList.remove("dragging"));
  map.on("click", (e) => setPin({ lng: e.lngLat.lng, lat: e.lngLat.lat }));
  $("#probe-close").addEventListener("click", () => setPin(null));

  for (const id of ["#chart-t", "#chart-w"]) {
    const svg = $(`${id} svg`);
    const leadAt = (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
      const { x0, x1 } = svg.__scale ?? { x0: 0, x1: 1 };
      return nearestLead(clamp((x - x0) / (x1 - x0), 0, 1) * meta.maxH);
    };
    svg.addEventListener("pointermove", (e) => { state.hoverLead = leadAt(e); drawCharts(); });
    svg.addEventListener("pointerleave", () => { state.hoverLead = null; drawCharts(); });
    svg.addEventListener("click", (e) => { setPlaying(false); seek(meta.leads[leadAt(e)]); });
  }
}

function setPin(p) {
  state.pin = p;
  marker?.remove();
  marker = null;
  $("#probe").hidden = !p;
  $("#right-col").classList.toggle("has-probe", !!p);
  if (!p) return;
  const el = Object.assign(document.createElement("div"), { className: "pin" });
  marker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
  const lon = ((((p.lng + 180) % 360) + 360) % 360) - 180;
  $("#probe-coord").textContent =
    `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
  updateProbeSeries();
  updateReadouts();
}

let series = null; // { t: [], w: [] } per lead (null where not loaded)
let seriesQueued = false;

function scheduleProbeSeries() {
  if (!state.pin || seriesQueued) return;
  seriesQueued = true;
  requestAnimationFrame(() => { seriesQueued = false; updateProbeSeries(); });
}

function updateProbeSeries() {
  if (!state.pin) return;
  const t = [], w = [];
  for (let k = 0; k < meta.leads.length; k++) {
    const s = store.sample(k, state.pin.lng, state.pin.lat, tmpA);
    t.push(s ? s[0] : null);
    w.push(s ? Math.hypot(s[1], s[2]) : null);
  }
  series = { t, w };
  drawCharts();
}

function drawCharts() {
  if (!state.pin || !series) return;
  const common = { leads: meta.leads, nowHours: state.hours, hoverLead: state.hoverLead, origin: COPY[meta.id].origin, label: (h) => {
    const d = validDate(h);
    return `${fmtShort.format(d)} ${hhmm(d)}`;
  } };
  renderChart($("#chart-t"), { ...common, values: series.t, unit: "°C", id: "t" });
  renderChart($("#chart-w"), { ...common, values: series.w, unit: "m/s", id: "w", zeroBased: true });
}

/** Everything that depends on "value under a point at the current time". */
function updateReadouts() {
  if (!meta || !map) return;
  const L = LAYERS[state.layer];
  const tip = $("#tip");
  const legendMarker = $("#legend-marker");
  const c = state.cursor;
  const s = c ? sampleNow(c.lng, c.lat) : null;
  if (s) {
    const w = describeWind(s[1], s[2]);
    const windTxt = `${ARROW(w.to)}${w.speed.toFixed(1)} m/s · ${w.compass}`;
    tip.innerHTML = state.layer === "t2m"
      ? `<div class="tip-main">${s[0].toFixed(1)}<small>°C</small></div><div class="tip-sub">${windTxt}</div>`
      : `<div class="tip-main">${w.speed.toFixed(1)}<small>m/s</small></div><div class="tip-sub">${ARROW(w.to)}from ${w.compass} · ${s[0].toFixed(1)} °C</div>`;
    tip.hidden = false;
    const flipX = c.x > window.innerWidth - 190, flipY = c.y > window.innerHeight - 230;
    tip.style.transform = `translate(${c.x + (flipX ? -18 : 18)}px, ${c.y + (flipY ? -18 : 18)}px) translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`;
    const val = state.layer === "t2m" ? s[0] : w.speed;
    legendMarker.hidden = false;
    legendMarker.style.left = `${clamp((val - L.vmin) / (L.vmax - L.vmin), 0, 1) * 100}%`;
  } else {
    tip.hidden = true;
    legendMarker.hidden = true;
  }

  if (state.pin) {
    const p = sampleNow(state.pin.lng, state.pin.lat);
    if (p) {
      const w = describeWind(p[1], p[2]);
      $("#probe-t").innerHTML = `${p[0].toFixed(1)}<small>°C</small>`;
      $("#probe-w").innerHTML = `${w.speed.toFixed(1)}<small>m/s</small>`;
      $("#probe-wl").innerHTML = `10 m wind from ${w.compass}`;
    }
    drawCharts();
  }
}

// ====================================================================== misc

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case " ": setPlaying(!state.playing); break;
      case "ArrowLeft": step(-1); break;
      case "ArrowRight": step(1); break;
      case "t": case "1": setLayer("t2m"); break;
      case "2": setLayer("wind"); break;
      case "w": setFlow(!state.flow); break;
      case "i": setIso(!state.iso); break;
      case "Escape": setPin(null); break;
      default: return;
    }
    e.preventDefault();
  });
}

let toastTimer = 0;
function toast(msg, onClick) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.style.cursor = onClick ? "pointer" : "";
  el.onclick = onClick ? () => { el.hidden = true; onClick(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, onClick ? 12000 : 4000);
}
