// Small single-series line chart for the point forecast (one measure, one axis).
// Values may contain nulls for lead times that have not been downloaded yet.

const H = 92;
const M = { l: 30, r: 8, t: 8, b: 16 };

function niceStep(span, maxTicks) {
  const raw = span / maxTicks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/**
 * @param {HTMLElement} fig  <figure> containing <figcaption><span/><span class=readout/></figcaption><svg/>
 * @param {{leads:number[], values:(number|null)[], nowHours:number, hoverLead:number|null,
 *          unit:string, id:string, zeroBased?:boolean, origin?:string, label:(h:number)=>string}} o
 */
export function renderChart(fig, o) {
  const svg = fig.querySelector("svg");
  const readout = fig.querySelector(".readout");
  const W = Math.max(svg.clientWidth || 272, 160);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.removeAttribute("preserveAspectRatio");
  const x0 = M.l, x1 = W - M.r, y0 = H - M.b, y1 = M.t;
  svg.__scale = { x0, x1 };
  const maxH = o.leads.at(-1);
  const X = (h) => x0 + (h / maxH) * (x1 - x0);

  const present = o.values.filter((v) => v !== null);
  if (!present.length) {
    svg.innerHTML = `<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">loading…</text>`;
    readout.textContent = "";
    return;
  }
  let lo = Math.min(...present), hi = Math.max(...present);
  if (o.zeroBased) lo = 0;
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = o.zeroBased ? 0 : mid - 2; hi = Math.max(hi, lo + 4); }
  const step = niceStep(hi - lo, 3);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const Y = (v) => y0 + ((v - lo) / (hi - lo)) * (y1 - y0);

  let out = `<defs><linearGradient id="chart-grad-${o.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7cf5ff" stop-opacity=".28"/><stop offset="1" stop-color="#7cf5ff" stop-opacity="0"/>
    </linearGradient></defs>`;

  for (let v = lo; v <= hi + 1e-9; v += step) {
    out += `<line class="grid" x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    out += `<text class="axis" x="${x0 - 6}" y="${Y(v) + 3}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  for (let h = 0; h <= maxH; h += 48) {
    const anchor = h === 0 ? "start" : h >= maxH ? "end" : "middle";
    out += `<text class="axis" x="${X(h)}" y="${H - 3}" text-anchor="${anchor}">${h === 0 ? (o.origin ?? "run") : `+${h / 24}d`}</text>`;
  }

  // Contiguous runs of loaded values -> one line + area each.
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const d = run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
      out += `<path d="${d}L${run.at(-1)[0].toFixed(1)},${y0}L${run[0][0].toFixed(1)},${y0}Z" fill="url(#chart-grad-${o.id})"/>`;
      out += `<path class="line" d="${d}"/>`;
    } else if (run.length === 1) {
      out += `<circle cx="${run[0][0]}" cy="${run[0][1]}" r="1.500" fill="#7cf5ff"/>`;
    }
    run = [];
  };
  o.values.forEach((v, k) => (v === null ? flush() : run.push([X(o.leads[k]), Y(v)])));
  flush();

  const at = (hours) => {
    // linear interpolation between loaded neighbours
    let k = 0;
    while (k < o.leads.length - 1 && o.leads[k + 1] <= hours) k++;
    const a = o.values[k], b = o.values[Math.min(k + 1, o.leads.length - 1)];
    if (a === null) return null;
    if (b === null || k === o.leads.length - 1) return a;
    return a + (b - a) * ((hours - o.leads[k]) / (o.leads[k + 1] - o.leads[k]));
  };

  const nowV = at(o.nowHours);
  out += `<line class="now" x1="${X(o.nowHours)}" x2="${X(o.nowHours)}" y1="${y1 - 4}" y2="${y0}"/>`;
  if (nowV !== null) out += `<circle class="dot" cx="${X(o.nowHours)}" cy="${Y(nowV)}" r="4"/>`;

  const hv = o.hoverLead !== null ? o.values[o.hoverLead] : null;
  if (o.hoverLead !== null) {
    const hx = X(o.leads[o.hoverLead]);
    out += `<line class="hover" x1="${hx}" x2="${hx}" y1="${y1 - 4}" y2="${y0}"/>`;
    if (hv !== null) out += `<circle class="dot h" cx="${hx}" cy="${Y(hv)}" r="4"/>`;
  }
  svg.innerHTML = out;

  if (o.hoverLead !== null) {
    readout.textContent = hv === null ? "not loaded yet" : `${o.label(o.leads[o.hoverLead])} · ${hv.toFixed(1)} ${o.unit}`;
  } else {
    readout.textContent = nowV === null ? "" : `${nowV.toFixed(1)} ${o.unit}`;
  }
}
