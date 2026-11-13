// MapLibre custom layer: animated wind streamlets.
//
// Particles are advected on the CPU in Web-Mercator space (so they stay glued to the
// map while it is dragged or zoomed) and each keeps a short history of positions.
// The history lives in one GPU buffer laid out slot-major -- [slot][particle] -- so a
// simulation step uploads just one slot (N x 3 floats), and every trail segment is an
// instanced, anti-aliased quad between two neighbouring slots.

import { createProgram } from "./field-layer.js";
import { HALF } from "./frames.js";

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_p0;      // older point: mercator x, y, intensity
layout(location = 1) in vec3 a_p1;      // newer point (intensity < 0 = trail break)
layout(location = 2) in vec2 a_corner;  // x: 0 -> p0, 1 -> p1; y: side -1 / +1
uniform vec2 u_center;   // map centre, mercator
uniform float u_world;   // world size in CSS px
uniform vec2 u_view;     // viewport in CSS px
uniform float u_width;   // line width in CSS px
uniform vec2 u_fade;     // trail alpha at p0 / p1
out float v_alpha;
out float v_side;
void main() {
  if (a_p1.z < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 d0 = a_p0.xy - u_center;
  d0.x -= floor(d0.x + 0.5);                 // nearest world copy
  vec2 dd = a_p1.xy - a_p0.xy;
  dd.x -= floor(dd.x + 0.5);                 // keep segments whole across the antimeridian
  vec2 s0 = d0 * u_world;
  vec2 s1 = s0 + dd * u_world;
  vec2 dir = s1 - s0;
  float len = length(dir);
  vec2 t = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  vec2 p = mix(s0, s1, a_corner.x) + n * a_corner.y * u_width * 0.5;
  gl_Position = vec4(p.x * 2.0 / u_view.x, -p.y * 2.0 / u_view.y, 0.0, 1.0);
  v_alpha = mix(max(a_p0.z, 0.0) * u_fade.x, a_p1.z * u_fade.y, a_corner.x);
  v_side = a_corner.y;
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform vec3 u_color;
uniform float u_alpha;
in float v_alpha;
in float v_side;
out vec4 o_color;
void main() {
  float edge = 1.0 - smoothstep(0.35, 1.0, abs(v_side));
  float a = v_alpha * edge * u_alpha;
  o_color = vec4(u_color * a, a);
}`;

const TRAIL = 30;          // history length (simulation steps)
const CAPACITY = 14000;    // max particles
const STEP_MS = 1000 / 60; // fixed simulation step
const Y_MIN = 0.012;       // ~ +-85 deg: stay inside the Mercator square
const Y_MAX = 0.988;

export class WindLayer {
  constructor({ id = "wind", nx, ny }) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.nx = nx;
    this.ny = ny;
    this.enabled = true;
    this.alpha = 0.8;
    this.color = [1, 1, 1];
    this.halo = [0.03, 0.05, 0.1];
    this.dataA = null;
    this.dataB = null;
    this.mix = 0;
    this.count = 0;
    this.head = 0;
    this.acc = 0;
    this.last = 0;
    this.x = new Float32Array(CAPACITY);
    this.y = new Float32Array(CAPACITY);
    this.age = new Float32Array(CAPACITY).fill(1e9);
    this.life = new Float32Array(CAPACITY);
    this.points = new Float32Array(TRAIL * CAPACITY * 3);
    for (let i = 2; i < this.points.length; i += 3) this.points[i] = -1;
  }

  onAdd(map, gl) {
    this.map = map;
    const { program, uniforms } = createProgram(gl, VERT, FRAG);
    this.program = program;
    this.u = uniforms;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    this.pointBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.points, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(0, 1);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  onRemove(_map, gl) {
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.pointBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  setEnabled(on) {
    this.enabled = on;
    this.last = 0;
    this.map?.triggerRepaint();
  }

  /** Wind comes from the same frames as the field layer: channels 1 (u) and 2 (v). */
  setWind(dataA, dataB, mix) {
    this.dataA = dataA;
    this.dataB = dataB ?? dataA;
    this.mix = dataB ? mix : 0;
  }

  _step(gl, cx, cy, world, viewW, viewH, zoom) {
    const { nx, ny, x, y, age, life, points } = this;
    const A = this.dataA, B = this.dataB, mix = this.mix;
    const blend = B !== A && mix > 0;
    const N = this.count;
    this.head = (this.head + 1) % TRAIL;
    const base = this.head * CAPACITY * 3;
    const halfW = Math.min(0.5, viewW / 2 / world + 12 / world);
    const halfH = viewH / 2 / world + 12 / world;
    // Screen px travelled per step for each m/s. Slightly faster when zoomed in so
    // motion keeps pace with the larger features.
    const k = (0.13 * Math.pow(1.22, Math.min(Math.max(zoom - 3, -1), 5))) / world;
    const row = nx * 3;

    for (let p = 0; p < N; p++) {
      let px = x[p], py = y[p], w;
      let dx = px - cx;
      dx -= Math.round(dx);
      const dy = py - cy;
      if (age[p] >= life[p] || dx > halfW || dx < -halfW || dy > halfH || dy < -halfH || py < Y_MIN || py > Y_MAX) {
        px = cx + (Math.random() * 2 - 1) * halfW;
        px -= Math.floor(px);
        py = cy + (Math.random() * 2 - 1) * halfH;
        w = -1; // break the trail: no segment from the previous life to this one
        if (py < Y_MIN || py > Y_MAX) {
          age[p] = 1e9; // landed outside the map, try again next step
        } else {
          age[p] = 0;
          life[p] = 45 + Math.random() * 120;
        }
      } else {
        const gx = (px + 0.5) * nx;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * py)));
        const gy = (0.5 - lat / Math.PI) * (ny - 1);
        const cf = Math.floor(gx);
        const fx = gx - cf;
        const c0 = cf % nx, c1 = (cf + 1) % nx;
        const r0 = Math.min(Math.floor(gy), ny - 2);
        const fy = gy - r0;
        const i00 = (r0 * nx + c0) * 3, i10 = (r0 * nx + c1) * 3;
        const i01 = i00 + row, i11 = i10 + row;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        let u = HALF[A[i00 + 1]] * w00 + HALF[A[i10 + 1]] * w10 + HALF[A[i01 + 1]] * w01 + HALF[A[i11 + 1]] * w11;
        let v = HALF[A[i00 + 2]] * w00 + HALF[A[i10 + 2]] * w10 + HALF[A[i01 + 2]] * w01 + HALF[A[i11 + 2]] * w11;
        if (blend) {
          const u2 = HALF[B[i00 + 1]] * w00 + HALF[B[i10 + 1]] * w10 + HALF[B[i01 + 1]] * w01 + HALF[B[i11 + 1]] * w11;
          const v2 = HALF[B[i00 + 2]] * w00 + HALF[B[i10 + 2]] * w10 + HALF[B[i01 + 2]] * w01 + HALF[B[i11 + 2]] * w11;
          u += (u2 - u) * mix;
          v += (v2 - v) * mix;
        }
        // Mercator is conformal: east/north map straight onto screen right/up.
        px += u * k;
        py -= v * k;
        px -= Math.floor(px);
        const a = ++age[p];
        const speed = Math.sqrt(u * u + v * v);
        const fade = Math.min(1, a / 10) * Math.min(1, (life[p] - a) / 14);
        w = Math.min(1, 0.16 + speed / 15) * Math.max(fade, 0);
      }
      x[p] = px;
      y[p] = py;
      const o = base + p * 3;
      points[o] = px;
      points[o + 1] = py;
      points[o + 2] = w;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, points, base, N * 3);
  }

  render(gl) {
    if (!this.enabled || !this.dataA) { this.last = 0; return; }
    const map = this.map;
    const canvas = map.getCanvas();
    const viewW = canvas.clientWidth, viewH = canvas.clientHeight;
    const zoom = map.getZoom();
    const world = 512 * Math.pow(2, zoom);
    const c = map.getCenter();
    const cx = (((c.lng + 180) / 360) % 1 + 1) % 1;
    const s = Math.sin((c.lat * Math.PI) / 180);
    const cy = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);

    this.count = Math.min(CAPACITY, Math.max(1500, Math.round((viewW * viewH) / 250)));

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);

    const now = performance.now();
    const dt = this.last ? Math.min(now - this.last, 80) : STEP_MS;
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP_MS && steps < 4) {
      this._step(gl, cx, cy, world, viewW, viewH, zoom);
      this.acc -= STEP_MS;
      steps++;
    }
    if (this.acc > STEP_MS * 4) this.acc = 0;

    const u = this.u;
    gl.useProgram(this.program);
    gl.uniform2f(u.u_center, cx, cy);
    gl.uniform1f(u.u_world, world);
    gl.uniform2f(u.u_view, viewW, viewH);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Two passes: a soft dark halo so streamlets read on pale colours, then the core.
    const stride = CAPACITY * 12;
    for (const pass of [
      { width: 3.6, color: this.halo, alpha: this.alpha * 0.34 },
      { width: 1.6, color: this.color, alpha: this.alpha },
    ]) {
      gl.uniform1f(u.u_width, pass.width);
      gl.uniform3f(u.u_color, pass.color[0], pass.color[1], pass.color[2]);
      gl.uniform1f(u.u_alpha, pass.alpha);
      for (let j = 0; j < TRAIL - 1; j++) {
        const s1 = (this.head - j + TRAIL) % TRAIL;   // newer slot, age j
        const s0 = (s1 - 1 + TRAIL) % TRAIL;          // older slot, age j + 1
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, s0 * stride);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, s1 * stride);
        const f1 = Math.pow(1 - j / (TRAIL - 1), 1.5);
        const f0 = Math.pow(1 - (j + 1) / (TRAIL - 1), 1.5);
        gl.uniform2f(u.u_fade, f0, f1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      }
    }
    gl.bindVertexArray(null);

    map.triggerRepaint(); // keep animating
  }
}
