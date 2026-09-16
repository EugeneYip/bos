import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON } from '../core/glsl';

/**
 * Auto-exposure.
 *
 * WebGL2 has no compute shaders, so a proper luminance histogram is off the
 * table. What is available — and what this does — is a mip-chain reduction of
 * log2(luminance) with per-texel outlier rejection and a centre weight, which
 * gives the geometric mean of the scene's luminance (the same quantity a
 * histogram's median is standing in for) at a cost of about 40 microseconds.
 *
 * Outlier rejection matters: a raw average is dominated by the sun disc and by
 * a single specular hit on a window. Clamping each texel's luminance into
 * [minLuminance, maxLuminance] *before* the log makes the metering behave like
 * a spot meter with a wide acceptance angle rather than an averaging meter.
 *
 * Reduction is 128 -> 32 -> 8 -> 2 -> 1, then a 1x1 ping-pong holds the adapted
 * value across frames so nothing is ever read back to the CPU.
 */
const LUM_SEED_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uSrcTexel;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uCenterWeight;

void main() {
  // 2x2 box of the source; the source is already much larger than 128px so
  // this is a sparse sample, which is fine for metering.
  vec3 c = vec3(0.0);
  c += max(texture2D(tColor, vUv + vec2(-0.5, -0.5) * uSrcTexel).rgb, vec3(0.0));
  c += max(texture2D(tColor, vUv + vec2( 0.5, -0.5) * uSrcTexel).rgb, vec3(0.0));
  c += max(texture2D(tColor, vUv + vec2(-0.5,  0.5) * uSrcTexel).rgb, vec3(0.0));
  c += max(texture2D(tColor, vUv + vec2( 0.5,  0.5) * uSrcTexel).rgb, vec3(0.0));
  c *= 0.25;

  // Reject a non-finite texel rather than metering it.
  //
  // 'clamp' with a NaN argument is implementation-defined, as is 'max', so a
  // single NaN pixel anywhere in the scene can poison the reduction and
  // mis-expose the entire frame. That is not hypothetical: a Beckmann lobe in
  // the water shader was dividing by an underflowed cos^4 and producing NaN
  // across whole square kilometres of harbour, and the frames that came back
  // wrong were wrong *everywhere* -- blown pavement, crushed shadows -- while
  // the one view with no water in it metered correctly.
  //
  // A comparison against a NaN is false, so this substitutes the middle of the
  // metering range for one: it contributes its weight but does not drag the
  // average. Fixing the source is the real fix; a meter should not be able to
  // be broken by one pixel either way.
  float lRaw = luma(c);
  float l = (lRaw > 0.0 && lRaw < 1.0e8)
    ? clamp(lRaw, uMinLum, uMaxLum)
    : sqrt(uMinLum * uMaxLum);

  // Centre-weighted metering: a radial falloff from the frame centre, so the
  // sky in the top corners does not stop the street from being readable.
  vec2 d = (vUv - 0.5) * 2.0;
  float r = saturate1(dot(d, d));
  float w = mix(1.0, 1.0 - r * 0.85, uCenterWeight);

  gl_FragColor = vec4(log2(max(l, 1e-6)) * w, w, 0.0, 1.0);
}
`;

/** Box reduction: sums the weighted log-luma and the weights together. */
const LUM_REDUCE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
uniform float uTaps;   // 2 => 2x2 box, 4 => 4x4 box

void main() {
  vec2 acc = vec2(0.0);
  float n = uTaps;
  float half_ = (n - 1.0) * 0.5;
  for (int y = 0; y < 4; y++) {
    if (float(y) >= n) break;
    for (int x = 0; x < 4; x++) {
      if (float(x) >= n) break;
      vec2 o = (vec2(float(x), float(y)) - half_) * uSrcTexel;
      acc += texture2D(tSrc, vUv + o).xy;
    }
  }
  gl_FragColor = vec4(acc, 0.0, 1.0);
}
`;

/**
 * 1x1 adaptation. Exponential approach with separate up/down speeds: the eye
 * (and a camera's AE) darkens faster than it brightens. Walking out of a tunnel
 * into the sun settles in about a second.
 */
const ADAPT_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tReduced;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform float uKey;
uniform float uCompensation;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uValid;

void main() {
  vec2 acc = texture2D(tReduced, vec2(0.5)).xy;
  float avgLogLum = acc.x / max(acc.y, 1e-5);
  float avgLum = clamp(exp2(avgLogLum), uMinLum, uMaxLum);

  // Target exposure that maps the metered luminance onto middle grey.
  float target = uKey / max(avgLum, 1e-5);
  target *= exp2(uCompensation);
  float targetEV = log2(max(target, 1e-6));

  float prevEV = texture2D(tPrev, vec2(0.5)).x;
  if (uValid < 0.5) { gl_FragColor = vec4(targetEV, avgLum, 0.0, 1.0); return; }

  float speed = targetEV < prevEV ? uSpeedDown : uSpeedUp;
  float k = 1.0 - exp(-uDt * speed);
  float ev = mix(prevEV, targetEV, clamp(k, 0.0, 1.0));
  gl_FragColor = vec4(ev, avgLum, 0.0, 1.0);
}
`;

export function createLumSeedPass(): Pass {
  return new Pass('post/lum-seed', LUM_SEED_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    uSrcTexel: u(new THREE.Vector2()),
    uMinLum: u(0.0025),
    uMaxLum: u(14),
    uCenterWeight: u(0.45),
  });
}

export function createLumReducePass(): Pass {
  return new Pass('post/lum-reduce', LUM_REDUCE_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uSrcTexel: u(new THREE.Vector2()),
    uTaps: u(4),
  });
}

export function createAdaptPass(): Pass {
  return new Pass('post/exposure-adapt', ADAPT_FRAG, {
    tReduced: u<THREE.Texture | null>(null),
    tPrev: u<THREE.Texture | null>(null),
    uDt: u(0.016),
    uSpeedUp: u(2.6),
    uSpeedDown: u(1.1),
    uKey: u(0.16),
    uCompensation: u(0),
    uMinLum: u(0.0025),
    uMaxLum: u(14),
    uValid: u(0),
  });
}
