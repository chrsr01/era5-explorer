// Frame store: downloads forecast frames (float16, [T degC, u10, v10] interleaved,
// rows north -> south, columns 0 -> 360 degE) and samples them on the CPU.

// 64k-entry half-float decode table: HALF[bits] -> number. Lets us keep frames as
// raw Uint16Array (uploadable as-is to a HALF_FLOAT texture) and still read them in JS.
export const HALF = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const s = i & 0x8000 ? -1 : 1;
  const e = (i >> 10) & 31;
  const f = i & 1023;
  HALF[i] =
    e === 0 ? s * 2 ** -14 * (f / 1024)
    : e === 31 ? (f ? NaN : s * Infinity)
    : s * 2 ** (e - 15) * (1 + f / 1024);
}

const CONCURRENCY = 4;
const FORMAT_VERSION = 1; // bump if the frame encoding changes (frames are cached as immutable)
const MAX_ATTEMPTS = 3;

export class FrameStore extends EventTarget {
  constructor() {
    super();
    this.dataset = null;
    this.init = -1;
    this.gen = 0;            // bumped whenever the dataset or run changes
    this.frames = new Map(); // lead index -> Uint16Array
    this.pending = new Set();
    this.attempts = new Map();
    this.focus = 0;
    this.active = 0;
    this.abort = null;
  }

  /** Switch dataset: drops everything in memory; buffering starts at the next setInit. */
  setDataset(meta) {
    this.dataset = meta.id;
    this.loadFrame = meta.loadFrame ?? null;  // set when there is no server (see direct.js)
    this.nx = meta.grid.nx;
    this.ny = meta.grid.ny;
    this.nLeads = meta.leads.length;
    this._reset(-1, 0);
  }

  /** Switch forecast run: drops everything in memory and starts buffering. */
  setInit(init, focus = 0) {
    if (init === this.init) return;
    this._reset(init, focus);
    this._pump();
  }

  _reset(init, focus) {
    this.abort?.abort();
    this.abort = new AbortController();
    this.gen++;
    this.init = init;
    this.focus = focus;
    this.frames.clear();
    this.pending.clear();
    this.attempts.clear();
    this.dispatchEvent(new Event("reset"));
  }

  /** Tell the store which lead the user is looking at so it buffers around it. */
  setFocus(lead) {
    this.focus = lead;
    this._pump();
  }

  has(lead) { return this.frames.has(lead); }
  get(lead) { return this.frames.get(lead); }
  get loadedCount() { return this.frames.size; }

  _wanted(k) {
    return !this.frames.has(k) && !this.pending.has(k) && (this.attempts.get(k) ?? 0) < MAX_ATTEMPTS;
  }

  _next() {
    // Forward from the focus first (that is where playback is heading), then backwards.
    for (let k = this.focus; k < this.nLeads; k++) if (this._wanted(k)) return k;
    for (let k = this.focus - 1; k >= 0; k--) if (this._wanted(k)) return k;
    return null;
  }

  _pump() {
    if (this.init < 0) return;
    while (this.active < CONCURRENCY) {
      const k = this._next();
      if (k === null) break;
      this._load(k);
    }
  }

  async _load(k) {
    const gen = this.gen;
    const signal = this.abort.signal;
    this.pending.add(k);
    this.active++;
    let retryDelay = 0;
    try {
      const frame = await this._fetch(k, signal);
      if (gen !== this.gen) return;
      if (frame.length !== this.nx * this.ny * 3) throw new Error("unexpected frame size");
      this.frames.set(k, frame);
      this.dispatchEvent(new CustomEvent("frame", { detail: { lead: k } }));
    } catch (err) {
      if (signal.aborted || gen !== this.gen) return;
      const n = (this.attempts.get(k) ?? 0) + 1;
      this.attempts.set(k, n);
      retryDelay = 1200 * n;
      if (n >= MAX_ATTEMPTS) {
        this.dispatchEvent(new CustomEvent("error", { detail: { lead: k, error: err } }));
      }
    } finally {
      this.active--;
      if (gen === this.gen) this.pending.delete(k);
      if (retryDelay) setTimeout(() => this._pump(), retryDelay);
      else this._pump();
    }
  }

  async _fetch(k, signal) {
    if (this.loadFrame) return this.loadFrame(this.init, k, signal);
    const res = await fetch(`api/frame/${this.dataset}/${this.init}/${k}?v=${FORMAT_VERSION}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint16Array(await res.arrayBuffer());
  }

  /** Retry frames that exhausted their attempts (e.g. after the network came back). */
  retryFailed() {
    this.attempts.clear();
    this._pump();
  }

  /**
   * Bilinear sample of one frame at a geographic point.
   * Returns [T degC, u m/s, v m/s] or null if that lead is not loaded.
   */
  sample(lead, lon, lat, out = [0, 0, 0]) {
    const d = this.frames.get(lead);
    if (!d) return null;
    const { nx, ny } = this;
    const gx = ((((lon % 360) + 360) % 360) / 360) * nx;
    const gy = Math.min(Math.max(((90 - lat) / 180) * (ny - 1), 0), ny - 1);
    const c0 = Math.floor(gx) % nx;
    const c1 = (c0 + 1) % nx;
    const fx = gx - Math.floor(gx);
    const r0 = Math.min(Math.floor(gy), ny - 2);
    const fy = gy - r0;
    const i00 = (r0 * nx + c0) * 3;
    const i10 = (r0 * nx + c1) * 3;
    const i01 = i00 + nx * 3;
    const i11 = i10 + nx * 3;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    for (let c = 0; c < 3; c++) {
      out[c] = HALF[d[i00 + c]] * w00 + HALF[d[i10 + c]] * w10 + HALF[d[i01 + c]] * w01 + HALF[d[i11 + c]] * w11;
    }
    return out;
  }
}
