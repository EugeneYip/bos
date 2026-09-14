import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { CATMULL_ROM, COMMON, DEPTH } from '../core/glsl';

/**
 * Temporal antialiasing.
 *
 * - Halton(2,3) sub-pixel jitter on the projection matrix, 8 or 16 phases.
 * - Velocity reconstructed from the depth buffer with a *closest-depth* 3x3
 *   dilation, so silhouettes fetch the history of the foreground surface and
 *   do not drag a ghost behind them.
 * - History resampled with Catmull-Rom (5 bilinear taps) instead of bilinear;
 *   this is what keeps one-pixel features like the Zakim's cable stays from
 *   dissolving after a few frames of accumulation.
 * - Neighbourhood variance clipping in YCoCg, clipping the history towards the
 *   neighbourhood mean along the line to it (AABB clip, not clamp).
 * - Disocclusion is handled by the clip plus an explicit history-validity test
 *   (off-screen, first frame, large velocity) that collapses the feedback.
 * - Luminance-weighted blending (Karis) so a firefly cannot latch on.
 */
const TAA_FRAG = /* glsl */ `
${COMMON}
${DEPTH}
${CATMULL_ROM}

varying vec2 vUv;

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;

uniform vec2  uTexel;        // 1 / renderSize
uniform vec2  uSize;         // renderSize
uniform mat4  uProjInv;      // current, unjittered
uniform mat4  uReproject;    // prevViewProj * inverse(currView), applied to view pos
uniform float uFeedbackStill;
uniform float uFeedbackMoving;
uniform float uClipGamma;
uniform float uValid;        // 0 on the first frame / after a resize
uniform vec2  uJitter;       // current jitter in UV units (for debug/off paths)

void main() {
  vec2 uv = vUv;

  // ---- closest-depth velocity dilation -------------------------------------
  // Sample a 3x3 cross of depths and keep the nearest; using the foreground
  // sample's motion for the whole footprint is what removes edge ghosting.
  float bestD = texture2D(tDepth, uv).r;
  vec2  bestUv = uv;
  vec2 oL = vec2(-uTexel.x, 0.0), oR = vec2(uTexel.x, 0.0);
  vec2 oD = vec2(0.0, -uTexel.y), oU = vec2(0.0, uTexel.y);
  float dL = texture2D(tDepth, uv + oL).r; if (dL < bestD) { bestD = dL; bestUv = uv + oL; }
  float dR = texture2D(tDepth, uv + oR).r; if (dR < bestD) { bestD = dR; bestUv = uv + oR; }
  float dD = texture2D(tDepth, uv + oD).r; if (dD < bestD) { bestD = dD; bestUv = uv + oD; }
  float dU = texture2D(tDepth, uv + oU).r; if (dU < bestD) { bestD = dU; bestUv = uv + oU; }

  vec3 viewPos = viewPosFromDepth(bestUv, bestD, uProjInv);
  vec4 prevClip = uReproject * vec4(viewPos, 1.0);
  float pw = prevClip.w;
  vec2 prevUv = (prevClip.xy / (abs(pw) < 1e-6 ? 1e-6 : pw)) * 0.5 + 0.5;
  vec2 velocity = prevUv - bestUv;
  vec2 histUv = uv + velocity;

  vec3 current = max(texture2D(tCurrent, uv).rgb, vec3(0.0));

  bool outside = any(lessThan(histUv, vec2(0.0))) || any(greaterThan(histUv, vec2(1.0)));
  if (uValid < 0.5 || outside || pw <= 0.0) {
    gl_FragColor = vec4(current, 1.0);
    return;
  }

  // ---- 3x3 neighbourhood statistics in YCoCg --------------------------------
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 nMin = vec3(1e9);
  vec3 nMax = vec3(-1e9);
  vec3 centerY = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec3 c = rgbToYCoCg(texture2D(tCurrent, uv + o).rgb);
      m1 += c;
      m2 += c * c;
      nMin = min(nMin, c);
      nMax = max(nMax, c);
      if (x == 0 && y == 0) centerY = c;
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));

  // Variance box, intersected with the true neighbourhood box so a wide
  // variance on a noisy pixel cannot open the gate to obvious ghosts.
  vec3 lo = max(mu - uClipGamma * sigma, nMin);
  vec3 hi = min(mu + uClipGamma * sigma, nMax);
  // Always admit the centre sample; a degenerate box would freeze the pixel.
  lo = min(lo, centerY);
  hi = max(hi, centerY);

  // ---- history fetch --------------------------------------------------------
  vec3 history = max(sampleCatmullRom(tHistory, histUv, uSize).rgb, vec3(0.0));
  vec3 histY = rgbToYCoCg(history);

  // AABB clip towards the neighbourhood mean (Karis / Playdead).
  vec3 center = 0.5 * (hi + lo);
  vec3 extent = 0.5 * (hi - lo) + 1e-6;
  vec3 dir = histY - center;
  vec3 units = abs(dir / extent);
  float divisor = max(units.x, max(units.y, units.z));
  if (divisor > 1.0) histY = center + dir / divisor;
  history = ycoCgToRgb(histY);

  // ---- feedback weight ------------------------------------------------------
  float speedPx = length(velocity * uSize);
  float motion = saturate1(speedPx / 12.0);
  float feedback = mix(uFeedbackStill, uFeedbackMoving, motion);

  // Extra rejection when the clip had to move the history a long way: that is
  // the signature of a disocclusion rather than of ordinary temporal noise.
  float clipDist = saturate1((divisor - 1.0) * 0.6);
  feedback *= (1.0 - 0.7 * clipDist);

  // Luminance weighting: equalises the contribution of bright and dark samples
  // so highlights do not "pump" as they are accumulated.
  float wc = 1.0 / (1.0 + lumaFast(current));
  float wh = 1.0 / (1.0 + lumaFast(history));
  float a = (1.0 - feedback) * wc;
  float b = feedback * wh;
  vec3 result = (current * a + history * b) / max(a + b, 1e-5);

  gl_FragColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;

export interface TaaUniforms {
  [k: string]: THREE.IUniform;
  tCurrent: { value: THREE.Texture | null };
  tHistory: { value: THREE.Texture | null };
  tDepth: { value: THREE.Texture | null };
  uTexel: { value: THREE.Vector2 };
  uSize: { value: THREE.Vector2 };
  uProjInv: { value: THREE.Matrix4 };
  uReproject: { value: THREE.Matrix4 };
  uFeedbackStill: { value: number };
  uFeedbackMoving: { value: number };
  uClipGamma: { value: number };
  uValid: { value: number };
  uJitter: { value: THREE.Vector2 };
}

export function createTaaPass(): Pass<TaaUniforms> {
  return new Pass<TaaUniforms>('post/taa', TAA_FRAG, {
    tCurrent: u<THREE.Texture | null>(null),
    tHistory: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uSize: u(new THREE.Vector2()),
    uProjInv: u(new THREE.Matrix4()),
    uReproject: u(new THREE.Matrix4()),
    uFeedbackStill: u(0.94),
    uFeedbackMoving: u(0.82),
    uClipGamma: u(1.15),
    uValid: u(0),
    uJitter: u(new THREE.Vector2()),
  });
}

/** Radical-inverse Halton sequence, the standard TAA jitter generator. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** 16 phases of Halton(2,3) centred on zero, in pixel units. */
export function haltonJitterTable(count = 16): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= count; i++) out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  return out;
}
