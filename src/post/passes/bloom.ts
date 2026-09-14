import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON } from '../core/glsl';

/**
 * Dual-filter (Kawase) bloom pyramid, COD:AW style.
 *
 * - Prefilter: 13-tap downsample with a per-group Karis average so a single
 *   blown pixel cannot bloom into a dinner plate, plus a soft-knee threshold.
 * - Down: 13-tap box-of-boxes, stable under motion, no shimmer.
 * - Up: 9-tap tent blended with `mix(dst, tent, spread)`, which bounds the
 *   total energy instead of letting the pyramid accumulate without limit. This
 *   is what keeps a night scene from turning into global milk: the wide mips
 *   are averaged in, not stacked.
 * - Composite (in the grade pass): `mix(scene, bloom, intensity)` with
 *   intensity around 0.045. Physically it is the fraction of light scattered by
 *   the lens, and real lenses scatter a few percent, not thirty.
 */
const PREFILTER_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;        // texel of the SOURCE
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

vec3 fetch(vec2 uv) { return max(texture2D(tSrc, uv).rgb, vec3(0.0)); }
float karis(vec3 c) { return 1.0 / (1.0 + lumaFast(c)); }

void main() {
  vec2 uv = vUv;
  vec2 t = uTexel;

  // 13-tap "box of boxes" arrangement.
  vec3 a = fetch(uv + vec2(-2.0, 2.0) * t);
  vec3 b = fetch(uv + vec2( 0.0, 2.0) * t);
  vec3 c = fetch(uv + vec2( 2.0, 2.0) * t);
  vec3 d = fetch(uv + vec2(-2.0, 0.0) * t);
  vec3 e = fetch(uv);
  vec3 f = fetch(uv + vec2( 2.0, 0.0) * t);
  vec3 g = fetch(uv + vec2(-2.0,-2.0) * t);
  vec3 h = fetch(uv + vec2( 0.0,-2.0) * t);
  vec3 i = fetch(uv + vec2( 2.0,-2.0) * t);
  vec3 j = fetch(uv + vec2(-1.0, 1.0) * t);
  vec3 k = fetch(uv + vec2( 1.0, 1.0) * t);
  vec3 l = fetch(uv + vec2(-1.0,-1.0) * t);
  vec3 m = fetch(uv + vec2( 1.0,-1.0) * t);

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;

  float w0 = karis(g0) * 0.5;
  float w1 = karis(g1) * 0.125;
  float w2 = karis(g2) * 0.125;
  float w3 = karis(g3) * 0.125;
  float w4 = karis(g4) * 0.125;
  float wsum = w0 + w1 + w2 + w3 + w4;
  vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(wsum, 1e-5);

  // Soft-knee high pass. The knee is what stops a hard threshold edge from
  // crawling across a gradient as the exposure drifts.
  float br = maxc(col);
  float knee = uThreshold * uKnee;
  float rq = clamp(br - (uThreshold - knee), 0.0, 2.0 * knee);
  rq = (0.25 / max(knee, 1e-4)) * rq * rq;
  col *= max(rq, br - uThreshold) / max(br, 1e-4);

  // Hard ceiling so a sun disc cannot saturate the half-float pyramid.
  col = min(col, vec3(uClamp));
  gl_FragColor = vec4(col, 1.0);
}
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
vec3 fetch(vec2 uv) { return max(texture2D(tSrc, uv).rgb, vec3(0.0)); }
void main() {
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = fetch(uv + vec2(-2.0, 2.0) * t);
  vec3 b = fetch(uv + vec2( 0.0, 2.0) * t);
  vec3 c = fetch(uv + vec2( 2.0, 2.0) * t);
  vec3 d = fetch(uv + vec2(-2.0, 0.0) * t);
  vec3 e = fetch(uv);
  vec3 f = fetch(uv + vec2( 2.0, 0.0) * t);
  vec3 g = fetch(uv + vec2(-2.0,-2.0) * t);
  vec3 h = fetch(uv + vec2( 0.0,-2.0) * t);
  vec3 i = fetch(uv + vec2( 2.0,-2.0) * t);
  vec3 j = fetch(uv + vec2(-1.0, 1.0) * t);
  vec3 k = fetch(uv + vec2( 1.0, 1.0) * t);
  vec3 l = fetch(uv + vec2(-1.0,-1.0) * t);
  vec3 m = fetch(uv + vec2( 1.0,-1.0) * t);
  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

const UPSAMPLE_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel of the SOURCE (smaller) mip
uniform float uRadius;
uniform float uSpread;    // becomes the blend alpha: mix(dst, tent, uSpread)
vec3 fetch(vec2 uv) { return max(texture2D(tSrc, uv).rgb, vec3(0.0)); }
void main() {
  vec2 uv = vUv;
  vec2 t = uTexel * uRadius;
  vec3 col = fetch(uv + vec2(-1.0,  1.0) * t) * 1.0;
  col += fetch(uv + vec2( 0.0,  1.0) * t) * 2.0;
  col += fetch(uv + vec2( 1.0,  1.0) * t) * 1.0;
  col += fetch(uv + vec2(-1.0,  0.0) * t) * 2.0;
  col += fetch(uv) * 4.0;
  col += fetch(uv + vec2( 1.0,  0.0) * t) * 2.0;
  col += fetch(uv + vec2(-1.0, -1.0) * t) * 1.0;
  col += fetch(uv + vec2( 0.0, -1.0) * t) * 2.0;
  col += fetch(uv + vec2( 1.0, -1.0) * t) * 1.0;
  col *= 0.0625;
  gl_FragColor = vec4(col, uSpread);
}
`;

/**
 * Anamorphic-ish streak: three Kawase steps along one axis at a low mip. Used
 * for the low sun over the Charles; off by default in the `lens` settings for
 * anything else.
 */
const STREAK_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uStride;
uniform float uAtten;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float o = (float(i) - 2.0) * uStride;
    float w = pow(uAtten, abs(o));
    sum += max(texture2D(tSrc, vUv + uDir * uTexel * o).rgb, vec3(0.0)) * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
}
`;

export function createBloomPrefilterPass(): Pass {
  return new Pass('post/bloom-prefilter', PREFILTER_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uThreshold: u(1.15),
    uKnee: u(0.6),
    uClamp: u(48),
  });
}

export function createBloomDownPass(): Pass {
  return new Pass('post/bloom-down', DOWNSAMPLE_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
  });
}

export function createBloomUpPass(): Pass {
  const p = new Pass('post/bloom-up', UPSAMPLE_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uRadius: u(1),
    uSpread: u(0.55),
  });
  // mix(dst, src, srcAlpha) via standard source-alpha blending.
  p.material.blending = THREE.NormalBlending;
  p.material.transparent = true;
  p.material.premultipliedAlpha = false;
  return p;
}

export function createStreakPass(): Pass {
  return new Pass('post/bloom-streak', STREAK_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uDir: u(new THREE.Vector2(1, 0)),
    uStride: u(1),
    uAtten: u(0.88),
  });
}
