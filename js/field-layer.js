// MapLibre custom layer that colour-maps a scalar field on the GPU.
//
// Each forecast frame is one RGB16F texture (T, u, v) in equirectangular layout.
// The fragment shader inverts Web-Mercator per pixel, samples the two frames that
// bracket the current time with bicubic filtering, blends them, and looks the value
// up in a 256-texel colour-map texture. Isolines are drawn analytically from screen
// space derivatives, so they stay one pixel wide at every zoom.

const VERT = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;            // Web-Mercator unit square (x extended over world copies)
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_cmap;
uniform float u_mix;
uniform float u_opacity;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_contour;   // isoline interval in data units, 0 = off
uniform float u_major;     // every n-th isoline is emphasised
uniform int u_mode;        // 0 = temperature (R), 1 = wind speed |GB|
in vec2 v_merc;
out vec4 o_color;

const float PI = 3.141592653589793;

vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}

// Bicubic B-spline from four bilinear taps.
vec3 bicubic(sampler2D tex, vec2 uv) {
  vec2 size = vec2(textureSize(tex, 0));
  vec2 inv = 1.0 / size;
  vec2 tc = uv * size - 0.5;
  vec2 f = fract(tc);
  tc -= f;
  vec4 xc = cubic(f.x);
  vec4 yc = cubic(f.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) * inv.xxyy;
  vec3 s0 = texture(tex, off.xz).rgb;
  vec3 s1 = texture(tex, off.yz).rgb;
  vec3 s2 = texture(tex, off.xw).rgb;
  vec3 s3 = texture(tex, off.yw).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

float value(vec3 s) { return u_mode == 0 ? s.r : length(s.gb); }

float isoline(float v, float interval, float width) {
  float c = v / interval;
  float w = fwidth(c);
  float d = abs(fract(c - 0.5) - 0.5) / max(w, 1e-6);
  // Fade out where the field is flat: there is no meaningful line on a plateau.
  return (1.0 - smoothstep(width - 0.5, width + 0.5, d)) * smoothstep(1e-4, 8e-4, w);
}

void main() {
  vec2 size = vec2(textureSize(u_a, 0));
  float lat = atan(sinh(PI * (1.0 - 2.0 * v_merc.y)));
  // Grid column i sits at lon = i * 360/nx (0..360E); row j at lat = 90 - j * 180/(ny-1).
  vec2 uv = vec2(
    v_merc.x + 0.5 + 0.5 / size.x,
    (0.5 - lat / PI) * (size.y - 1.0) / size.y + 0.5 / size.y
  );
  float val = mix(value(bicubic(u_a, uv)), value(bicubic(u_b, uv)), u_mix);
  float t = clamp((val - u_vmin) / (u_vmax - u_vmin), 0.0, 1.0);
  vec3 col = texture(u_cmap, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;

  if (u_contour > 0.0) {
    float minor = isoline(val, u_contour, 0.55);
    float major = isoline(val, u_contour * u_major, 0.9);
    // Pick ink that contrasts with the local colour so lines read on any map.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 ink = luma > 0.45 ? vec3(0.02, 0.03, 0.06) : vec3(1.0);
    col = mix(col, ink, max(minor * 0.13, major * 0.3));
  }
  o_color = vec4(col * u_opacity, u_opacity);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

export function createProgram(gl, vert, frag, attribs = {}) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, uniforms };
}

const MAX_TEXTURES = 6;

export class FieldLayer {
  constructor({ id = "field", nx, ny }) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.nx = nx;
    this.ny = ny;
    this.a = null; // { key, data }
    this.b = null;
    this.mix = 0;
    this.style = { mode: 0, vmin: 0, vmax: 1, opacity: 0.9, contour: 0, major: 2 };
    this.cmapStops = null;
    this.cmapDirty = false;
    this.textures = new Map(); // key -> { tex, used }
    this.tick = 0;
  }

  onAdd(map, gl) {
    this.map = map;
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("WebGL2 is required");
    }
    const { program, uniforms } = createProgram(gl, VERT, FRAG, { a_pos: 0 });
    this.program = program;
    this.u = uniforms;

    // One quad spanning several world copies; the texture repeats in longitude.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-3, 0, 4, 0, -3, 1, 4, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.cmapTex = gl.createTexture();
    this.cmapDirty = true;
  }

  onRemove(_map, gl) {
    for (const { tex } of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    gl.deleteTexture(this.cmapTex);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** a/b: { key, data: Uint16Array } frames bracketing the current time; mix in [0,1]. */
  setFrames(a, b, mix) {
    this.a = a;
    this.b = b ?? a;
    this.mix = b ? mix : 0;
    this.map?.triggerRepaint();
  }

  setStyle(style) {
    Object.assign(this.style, style);
    this.map?.triggerRepaint();
  }

  /** stops: array of [r, g, b] in 0..255. */
  setColormap(stops) {
    this.cmapStops = stops;
    this.cmapDirty = true;
    this.map?.triggerRepaint();
  }

  /** Drop GPU copies (e.g. when the forecast run changes). */
  invalidate() {
    this.stale = true;
  }

  _uploadColormap(gl) {
    const stops = this.cmapStops;
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (stops.length - 1);
      const k = Math.min(Math.floor(f), stops.length - 2);
      const t = f - k;
      for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(stops[k][c] * (1 - t) + stops[k + 1][c] * t);
      px[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cmapDirty = false;
  }

  _texture(gl, frame) {
    let entry = this.textures.get(frame.key);
    if (!entry) {
      if (this.textures.size >= MAX_TEXTURES) {
        let oldestKey = null, oldest = Infinity;
        for (const [key, e] of this.textures) {
          if (e.used < oldest && key !== this.a?.key && key !== this.b?.key) { oldest = e.used; oldestKey = key; }
        }
        if (oldestKey !== null) {
          gl.deleteTexture(this.textures.get(oldestKey).tex);
          this.textures.delete(oldestKey);
        }
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // float16 bits straight from the server -> half-float texture, no conversion.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, this.nx, this.ny, 0, gl.RGB, gl.HALF_FLOAT, frame.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, used: 0 };
      this.textures.set(frame.key, entry);
    }
    entry.used = ++this.tick;
    return entry.tex;
  }

  render(gl, args) {
    if (!this.a || !this.cmapStops) return;
    const matrix = args?.defaultProjectionData?.mainMatrix ?? args?.modelViewProjectionMatrix ?? args;

    // All uploads happen here, inside MapLibre's render pass, so its GL state
    // tracking (which is reset after custom layers) never gets out of sync.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.stale) {
      for (const [key, e] of this.textures) {
        if (key !== this.a.key && key !== this.b.key) { gl.deleteTexture(e.tex); this.textures.delete(key); }
      }
      this.stale = false;
    }
    if (this.cmapDirty) this._uploadColormap(gl);
    const texA = this._texture(gl, this.a);
    const texB = this._texture(gl, this.b);

    const { u, style } = this;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA); gl.uniform1i(u.u_a, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB); gl.uniform1i(u.u_b, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.cmapTex); gl.uniform1i(u.u_cmap, 2);
    gl.uniform1f(u.u_mix, this.mix);
    gl.uniform1f(u.u_opacity, style.opacity);
    gl.uniform1f(u.u_vmin, style.vmin);
    gl.uniform1f(u.u_vmax, style.vmax);
    gl.uniform1f(u.u_contour, style.contour);
    gl.uniform1f(u.u_major, style.major);
    gl.uniform1i(u.u_mode, style.mode);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
