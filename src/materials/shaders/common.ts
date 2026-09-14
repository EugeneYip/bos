/**
 * Shared GLSL prelude for every procedural surface shader.
 *
 * Everything in here is *tileable by construction*: each noise function takes an
 * explicit integer `period` and wraps its lattice coordinates with `mod()` before
 * hashing, so a texture baked over [0,1) with a period of N repeats seamlessly.
 *
 * Colour authoring convention: palette constants are written as sRGB (the values
 * you'd read off a colour picker) and converted to linear with `bosSrgb()`.
 * The albedo render target is allocated as SRGB8_ALPHA8, so the hardware
 * re-encodes on write and decodes on sample — the shader must emit **linear**.
 */
export const COMMON_GLSL = /* glsl */ `
precision highp float;
precision highp int;

#define BOS_PI 3.14159265359
#define BOS_TAU 6.28318530718

// ---------------------------------------------------------------- colour ----

// sRGB electro-optical transfer function (Hoskins' cheap fit, max err ~0.001).
vec3 bosSrgb(vec3 c) {
  return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}
vec3 bosSrgb8(float r, float g, float b) {
  return bosSrgb(vec3(r, g, b) * (1.0 / 255.0));
}
float bosLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// --------------------------------------------------------------- hashing ----
// Dave Hoskins, "Hash without Sine" (MIT). Good avalanche, no trig.

vec2 bosWrap(vec2 p, vec2 period) {
  return mod(mod(p, period) + period, period);
}

float bosHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float bosHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 bosHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 bosHash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

vec4 bosHash42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

/** Per-cell hash that respects the tiling period. */
float bosCell1(vec2 cell, vec2 period) { return bosHash12(bosWrap(cell, period) + 0.37); }
vec2  bosCell2(vec2 cell, vec2 period) { return bosHash22(bosWrap(cell, period) + 0.37); }
vec3  bosCell3(vec2 cell, vec2 period) { return bosHash32(bosWrap(cell, period) + 0.37); }
vec4  bosCell4(vec2 cell, vec2 period) { return bosHash42(bosWrap(cell, period) + 0.37); }

// ----------------------------------------------------------------- noise ----

/** Tileable value noise, quintic interpolation. Range [0,1]. */
float bosValue(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = bosCell1(i + vec2(0.0, 0.0), period);
  float b = bosCell1(i + vec2(1.0, 0.0), period);
  float c = bosCell1(i + vec2(0.0, 1.0), period);
  float d = bosCell1(i + vec2(1.0, 1.0), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float bosGradDot(vec2 cell, vec2 f, vec2 period) {
  vec2 g = bosCell2(cell, period) * BOS_TAU;
  return dot(vec2(cos(g.x), sin(g.x)), f);
}

/** Tileable gradient (Perlin) noise. Range approx [-1,1]. */
float bosPerlin(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = bosGradDot(i + vec2(0.0, 0.0), f - vec2(0.0, 0.0), period);
  float b = bosGradDot(i + vec2(1.0, 0.0), f - vec2(1.0, 0.0), period);
  float c = bosGradDot(i + vec2(0.0, 1.0), f - vec2(0.0, 1.0), period);
  float d = bosGradDot(i + vec2(1.0, 1.0), f - vec2(1.0, 1.0), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142;
}

/**
 * Tileable fBm. Lacunarity is fixed at 2 so the period stays integral on every
 * octave — that is what keeps the result seamless.
 */
float bosFbm(vec2 p, vec2 period, int octaves, float gain) {
  float amp = 1.0, sum = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    sum += amp * bosPerlin(pp, per);
    norm += amp;
    amp *= gain;
    pp *= 2.0;
    per *= 2.0;
  }
  return sum / max(norm, 1e-4);
}

/** fBm remapped to [0,1]. */
float bosFbm01(vec2 p, vec2 period, int octaves, float gain) {
  return bosFbm(p, period, octaves, gain) * 0.5 + 0.5;
}

/** Ridged multifractal — sharp creases, good for cracks and rock. */
float bosRidge(vec2 p, vec2 period, int octaves, float gain) {
  float amp = 1.0, sum = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(bosPerlin(pp, per));
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= gain;
    pp *= 2.0;
    per *= 2.0;
  }
  return sum / max(norm, 1e-4);
}

/** Billowy fBm — rounded lumps, good for aggregate and foliage. */
float bosBillow(vec2 p, vec2 period, int octaves, float gain) {
  float amp = 1.0, sum = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    sum += amp * abs(bosPerlin(pp, per));
    norm += amp;
    amp *= gain;
    pp *= 2.0;
    per *= 2.0;
  }
  return sum / max(norm, 1e-4);
}

/** Domain-warped fBm. `w` is the warp strength in lattice units. */
float bosWarpFbm(vec2 p, vec2 period, int octaves, float gain, float w) {
  vec2 q = vec2(bosFbm(p + vec2(1.7, 9.2), period, 3, 0.5),
                bosFbm(p + vec2(8.3, 2.8), period, 3, 0.5));
  return bosFbm(p + w * q, period, octaves, gain);
}

/** Anisotropic fBm: stretches the domain by `aniso` along `dir`. */
float bosStreak(vec2 p, vec2 period, float angle, float aniso, int octaves) {
  float c = cos(angle), s = sin(angle);
  mat2 r = mat2(c, -s, s, c);
  // Stretching must keep the period integral, so scale the period identically.
  vec2 sc = vec2(1.0, 1.0 / max(aniso, 1e-3));
  return bosFbm(r * p * sc, period * sc, octaves, 0.5);
}

// -------------------------------------------------------------- cellular ----

/**
 * Tileable Worley. Returns (F1, F2, cellHash).
 * `jitter` in [0,1] controls how irregular the point set is.
 */
vec3 bosWorley(vec2 p, vec2 period, float jitter) {
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = bosCell2(i + o, period);
      vec2 r = o + 0.5 + (h - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = bosCell1(i + o, period); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

/**
 * Two-pass Voronoi (Quilez). Returns:
 *   .x  = distance to the nearest *cell border* (0 on the border, grows inward)
 *   .y  = cell id hash in [0,1)
 *   .zw = offset from the sample point to its cell's site
 * Far better than F2-F1 for laid stone: gives a clean, even border everywhere.
 */
vec4 bosVoronoi(vec2 p, vec2 period, float jitter) {
  vec2 i = floor(p), f = fract(p);

  vec2 mo = vec2(0.0), mi = vec2(0.0);
  float best = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + 0.5 + (bosCell2(i + o, period) - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < best) { best = d; mo = r; mi = o; }
    }
  }

  float edge = 8.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = mi + vec2(float(x), float(y));
      vec2 r = o + 0.5 + (bosCell2(i + o, period) - 0.5) * jitter - f;
      vec2 diff = r - mo;
      float len = dot(diff, diff);
      if (len > 1e-5) {
        edge = min(edge, dot(0.5 * (mo + r), normalize(diff)));
      }
    }
  }
  return vec4(edge, bosCell1(i + mi, period), mo);
}

// ------------------------------------------------------------- utilities ----

mat2 bosRot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float bosSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/** Antialiased-ish box mask: 1 inside, 0 outside, `soft` wide falloff. */
float bosBox(vec2 p, vec2 halfSize, float soft) {
  vec2 d = halfSize - abs(p);
  float m = min(d.x, d.y);
  return smoothstep(0.0, soft, m);
}

/** Signed distance to a rectangle centred at the origin. */
float bosSdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/** Rounded-rectangle SDF (stone blocks, pavers, panes). */
float bosSdRound(vec2 p, vec2 b, float r) {
  return bosSdBox(p, b - r) - r;
}

float bosRemap(float v, float a, float b, float c, float d) {
  return c + (d - c) * clamp((v - a) / max(b - a, 1e-6), 0.0, 1.0);
}

/** Interleaved gradient noise — cheap per-pixel dither for 8-bit encodes. */
float bosIGN(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

/**
 * The surface description every family shader fills in. `height` is in metres
 * of relief above the nominal plane; the Sobel pass converts it into a
 * physically-scaled normal map using the family's tileMeters.
 */
struct BosSurface {
  vec3 albedo;    // linear RGB
  float rough;    // perceptual roughness 0..1
  float metal;    // 0..1
  float ao;       // baked cavity occlusion 0..1
  float height;   // metres
};

BosSurface bosDefault() {
  BosSurface s;
  s.albedo = vec3(0.5);
  s.rough = 0.8;
  s.metal = 0.0;
  s.ao = 1.0;
  s.height = 0.0;
  return s;
}
`;
