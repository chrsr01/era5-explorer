// Worker for server-less mode: downloads the three Zarr chunks of a frame, decodes them
// and packs them into the frame format of the Python server (see era5view/store.py):
// float16 [T degC, u10, v10] interleaved, rows north -> south, values snapped to 1/16.
// (The server rounds twice, so about 5 % of its values sit one 1/16 step away.)
//
//   in:  { id, urls: [t2m, u10, v10], nx, ny, flip }   or   { cancel: id }
//   out: { id, frame: ArrayBuffer }                    or   { id, error }

import { bloscDecode } from "./blosc.js";

// QUANT[n + 32768] = half-float bits of n / 16, rounded to nearest even.
const QUANT = new Uint16Array(65536);
{
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let n = -32768; n < 32768; n++) {
    f32[0] = n / 16;
    const sign = (u32[0] >>> 16) & 0x8000;
    const exp = ((u32[0] >>> 23) & 0xff) - 127;
    const mant = u32[0] & 0x7fffff;
    let bits = 0;                         // n == 0; every other |n / 16| is a normal half
    if (n !== 0) {
      bits = ((exp + 15) << 10) | (mant >>> 13);
      const rest = mant & 0x1fff;
      if (rest > 0x1000 || (rest === 0x1000 && (bits & 1))) bits++;
    }
    QUANT[n + 32768] = sign | bits;
  }
}

function quantise(x) {
  const n = Math.round(x * 16);
  if (n >= -32768 && n <= 32767) return QUANT[n + 32768];
  return n > 32767 ? QUANT[65535] : n < -32768 ? QUANT[0] : 0x7e00;  // clamp; NaN stays NaN
}

function pack([t, u, v], nx, ny, flip) {
  if (t.length !== nx * ny || u.length !== nx * ny || v.length !== nx * ny) {
    throw new Error("unexpected chunk size");
  }
  const out = new Uint16Array(nx * ny * 3);
  for (let row = 0, o = 0; row < ny; row++) {
    let i = (flip ? ny - 1 - row : row) * nx;
    for (const end = i + nx; i < end; i++, o += 3) {
      out[o] = quantise(t[i] - 273.15);
      out[o + 1] = quantise(u[i]);
      out[o + 2] = quantise(v[i]);
    }
  }
  return out;
}

const jobs = new Map();  // id -> AbortController

self.onmessage = async ({ data }) => {
  if (data.cancel !== undefined) {
    jobs.get(data.cancel)?.abort();
    return;
  }
  const { id, urls, nx, ny, flip } = data;
  const abort = new AbortController();
  jobs.set(id, abort);
  try {
    const fields = await Promise.all(urls.map(async (url) => {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Float32Array(bloscDecode(new Uint8Array(await res.arrayBuffer())).buffer);
    }));
    const frame = pack(fields, nx, ny, flip);
    self.postMessage({ id, frame: frame.buffer }, [frame.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  } finally {
    jobs.delete(id);
  }
};
