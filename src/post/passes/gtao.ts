import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, DEPTH } from '../core/glsl';

/**
 * Ground-truth ambient occlusion (Jimenez et al. 2016), horizon-search form.
 *
 * Why GTAO rather than classic SSAO: the horizon-based visibility integral is
 * the actual cosine-weighted visibility of the hemisphere, so building bases
 * sit on the ground and window reveals darken correctly instead of getting the
 * uniform grey wash a range-checked SSAO produces. It also does not halo,
 * because there is no range-check discontinuity to produce one — sky samples
 * are rejected outright and occluders fade out smoothly with distance.
 *
 * Output is RG16F: R = visibility (1 = unoccluded), G = linear view depth in
 * metres, which the denoiser and the bilateral upsample both key off.
 */
const GTAO_FRAG = /* glsl */ `
${COMMON}
${DEPTH}

varying vec2 vUv;

uniform sampler2D tDepth;
uniform mat4  uProjInv;
uniform vec2  uTexelFull;
uniform float uProjScale;     // 0.5 * P11 * fullHeightPixels
uniform float uRadius;        // metres
uniform float uThickness;     // metres
uniform float uMaxDistance;   // metres
uniform float uMaxRadiusPx;
uniform float uFrame;
uniform float uPower;

#ifndef AO_SLICES
#define AO_SLICES 3
#endif
#ifndef AO_STEPS
#define AO_STEPS 6
#endif

float horizonSearch(vec2 uv, vec3 P, vec3 V, vec2 omega, float sideSign, float radiusPx, float noiseOff) {
  float cHorizon = -1.0;
  float falloffRange = max(uRadius * 0.75, 0.05);
  for (int t = 0; t < AO_STEPS; t++) {
    // Quadratic step distribution: contact occlusion (the part the eye reads
    // as "this object is touching the ground") gets most of the samples.
    float s = (float(t) + noiseOff) / float(AO_STEPS);
    float distPx = max(s * s * radiusPx, float(t) + 1.0);
    vec2 sUv = uv + sideSign * omega * distPx * uTexelFull;
    if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;

    float sd = texture2D(tDepth, sUv).r;
    if (isSky(sd)) continue;               // sky is never an occluder

    vec3 sp = viewPosFromDepth(sUv, sd, uProjInv);
    vec3 delta = sp - P;
    float len = length(delta);
    if (len < 1e-4) continue;

    float cosH = dot(delta, V) / len;

    // Smooth distance attenuation replaces the hard range check of SSAO; this
    // is the reason there is no bright halo around silhouettes.
    float w = saturate1((uRadius - len) / falloffRange);
    // Thin-occluder compensation: a sample that is only just in front of the
    // receiver (a railing, a mullion) should not occlude a whole hemisphere.
    float slabZ = abs((-sp.z) - (-P.z));
    w *= saturate1(1.0 - (slabZ - uThickness) / max(uThickness * 3.0, 1e-3));

    float shc = mix(cHorizon, cosH, w);
    cHorizon = max(cHorizon, shc);
  }
  return cHorizon;
}

void main() {
  vec2 uv = vUv;
  float depth = texture2D(tDepth, uv).r;
  if (isSky(depth)) { gl_FragColor = vec4(1.0, 1.0e7, 0.0, 1.0); return; }

  vec3 P = viewPosFromDepth(uv, depth, uProjInv);
  float viewZ = -P.z;
  if (viewZ > uMaxDistance) { gl_FragColor = vec4(1.0, viewZ, 0.0, 1.0); return; }

  vec3 N = normalFromDepth(tDepth, uv, uTexelFull, uProjInv, P, depth);
  vec3 V = normalize(-P);

  float radiusPx = clamp(uRadius * uProjScale / max(viewZ, 0.05), 3.0, uMaxRadiusPx);

  vec2 px = gl_FragCoord.xy;
  float noiseDir = ign(px + vec2(uFrame * 5.588238, uFrame * 3.141593));
  float noiseOff = hash12(px + vec2(uFrame * 17.13, uFrame * 9.77));

  float visibility = 0.0;
  for (int s = 0; s < AO_SLICES; s++) {
    float phi = (float(s) + noiseDir) * (PI / float(AO_SLICES));
    vec2 omega = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(omega, 0.0);

    vec3 orthoDir = dirV - dot(dirV, V) * V;
    vec3 axis = cross(dirV, V);
    vec3 projN = N - axis * dot(N, axis);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    vec3 projNn = projN / projLen;

    float cosN = clamp(dot(projNn, V), -1.0, 1.0);
    float sgn = dot(orthoDir, projNn) < 0.0 ? -1.0 : 1.0;
    float n = sgn * acos(cosN);
    float sinN = sin(n);

    float c0 = horizonSearch(uv, P, V, omega, -1.0, radiusPx, noiseOff);
    float c1 = horizonSearch(uv, P, V, omega,  1.0, radiusPx, noiseOff);

    float h0 = n + max(-PI * 0.5, min(PI * 0.5, -acos(clamp(c0, -1.0, 1.0)) - n));
    float h1 = n + max(-PI * 0.5, min(PI * 0.5,  acos(clamp(c1, -1.0, 1.0)) - n));

    visibility += projLen * 0.25 * (
      (-cos(2.0 * h0 - n) + cosN + 2.0 * h0 * sinN) +
      (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN));
  }

  float ao = saturate1(visibility / float(AO_SLICES));
  ao = pow(ao, uPower);

  // Fade AO out with distance; at 900 m a 2.6 m radius is sub-pixel anyway.
  float fade = saturate1(1.0 - (viewZ / uMaxDistance));
  ao = mix(1.0, ao, fade * fade);

  gl_FragColor = vec4(ao, viewZ, 0.0, 1.0);
}
`;

/** Depth-aware spatial denoise matched to the per-pixel noise rotation. */
const GTAO_DENOISE_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tAO;
uniform vec2 uTexel;
uniform vec2 uDir;      // (1,0) then (0,1): separable, 2 x 5 taps
uniform float uSigmaZ;  // relative depth tolerance

void main() {
  vec4 c = texture2D(tAO, vUv);
  float z0 = c.y;
  if (z0 > 1.0e6) { gl_FragColor = c; return; }

  float sum = c.x;
  float wsum = 1.0;
  // Gaussian-ish weights over +-2 taps.
  float gw[3];
  gw[0] = 1.0; gw[1] = 0.72; gw[2] = 0.32;
  for (int i = 1; i <= 2; i++) {
    for (int s = 0; s < 2; s++) {
      vec2 o = uDir * uTexel * float(i) * (s == 0 ? 1.0 : -1.0);
      vec4 t = texture2D(tAO, vUv + o);
      if (t.y > 1.0e6) continue;
      float dz = abs(t.y - z0) / max(z0, 1e-3);
      float w = gw[i] * exp(-dz * dz / (uSigmaZ * uSigmaZ));
      sum += t.x * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, z0, 0.0, 1.0);
}
`;

/** Temporal accumulation of AO, reprojected with the camera delta. */
const GTAO_TEMPORAL_FRAG = /* glsl */ `
${COMMON}
${DEPTH}
varying vec2 vUv;
uniform sampler2D tAO;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uReproject;     // prevProj * prevView * inverse(currView)
uniform mat4 uPrevView;      // prevView * inverse(currView)
uniform float uValid;
uniform float uFeedback;

void main() {
  vec4 cur = texture2D(tAO, vUv);
  if (cur.y > 1.0e6 || uValid < 0.5) { gl_FragColor = cur; return; }

  float depth = texture2D(tDepth, vUv).r;
  vec3 P = viewPosFromDepth(vUv, depth, uProjInv);
  vec4 prevClip = uReproject * vec4(P, 1.0);
  if (prevClip.w <= 0.0) { gl_FragColor = cur; return; }
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
  if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    gl_FragColor = cur; return;
  }

  vec4 hist = texture2D(tHistory, prevUv);
  // Disocclusion test in the *previous* camera's view space.
  float prevZ = -(uPrevView * vec4(P, 1.0)).z;
  float rel = abs(hist.y - prevZ) / max(prevZ, 1e-3);
  float accept = saturate1(1.0 - rel * 40.0);

  float f = uFeedback * accept;
  gl_FragColor = vec4(mix(cur.x, hist.x, f), cur.y, 0.0, 1.0);
}
`;

export function createGtaoPass(slices: number, steps: number): Pass {
  return new Pass('post/gtao', GTAO_FRAG, {
    tDepth: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uTexelFull: u(new THREE.Vector2()),
    uProjScale: u(1),
    uRadius: u(2.6),
    uThickness: u(1.2),
    uMaxDistance: u(900),
    uMaxRadiusPx: u(96),
    uFrame: u(0),
    uPower: u(1.6),
  }, { AO_SLICES: slices, AO_STEPS: steps });
}

export function createGtaoDenoisePass(): Pass {
  return new Pass('post/gtao-denoise', GTAO_DENOISE_FRAG, {
    tAO: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uDir: u(new THREE.Vector2(1, 0)),
    uSigmaZ: u(0.035),
  });
}

export function createGtaoTemporalPass(): Pass {
  return new Pass('post/gtao-temporal', GTAO_TEMPORAL_FRAG, {
    tAO: u<THREE.Texture | null>(null),
    tHistory: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uReproject: u(new THREE.Matrix4()),
    uPrevView: u(new THREE.Matrix4()),
    uValid: u(0),
    uFeedback: u(0.88),
  });
}
