import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, DEPTH } from '../core/glsl';

/** Layer reserved for "this surface receives screen-space reflections". */
export const SSR_LAYER = 11;

/**
 * Reflective G-buffer material.
 *
 * Only surfaces that actually reflect (glass, water, polished metal, wet
 * asphalt) are drawn into it, so it costs a handful of draw calls rather than a
 * full scene re-submit. It carries the *shading* normal, not a depth-derived
 * one, because a flat curtain wall needs its reflection ray to be exact.
 *
 * Output: RG = octahedral view-space normal, B = roughness, A = F0 luminance.
 */
const GBUF_VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>
varying vec3 vViewNormal;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vViewNormal = normalize(transformedNormal);
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}
`;

const GBUF_FRAG = /* glsl */ `
${COMMON}
varying vec3 vViewNormal;
uniform float uRoughness;
uniform float uReflectivity;
void main() {
  vec3 n = normalize(vViewNormal);
  if (!gl_FrontFacing) n = -n;
  gl_FragColor = vec4(octEncode(n), uRoughness, uReflectivity);
}
`;

export function createGBufferMaterial(roughness: number, reflectivity: number): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'post/ssr-gbuffer',
    vertexShader: GBUF_VERT,
    fragmentShader: GBUF_FRAG,
    uniforms: {
      uRoughness: { value: roughness },
      uReflectivity: { value: reflectivity },
    },
    side: THREE.FrontSide,
    toneMapped: false,
    blending: THREE.NoBlending,
  });
  return m;
}

/**
 * Screen-space reflections.
 *
 * Linear march in perspective-correct screen space (1/w interpolated, so the
 * step size in pixels is uniform rather than bunching up near the camera),
 * followed by a binary refinement of the crossing. One GGX-importance-sampled
 * ray per pixel with per-frame jitter; the noise is resolved by the following
 * spatial blur and then integrated by TAA, which is why SSR is composited
 * *before* TAA in the chain.
 *
 * Misses do not invent anything: confidence goes to zero and the composite
 * leaves the base pass's IBL reflection (`ctx.envMap`) in place, which is the
 * correct fallback and costs nothing.
 */
const SSR_FRAG = /* glsl */ `
${COMMON}
${DEPTH}

varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tGBuffer;

uniform mat4  uProj;
uniform mat4  uProjInv;
uniform vec2  uTexel;         // 1 / ssrSize
uniform float uMaxDistance;
uniform float uThickness;
uniform float uMaxRoughness;
uniform float uFrame;
uniform float uNear;

#ifndef SSR_STEPS
#define SSR_STEPS 28
#endif
#ifndef SSR_REFINE
#define SSR_REFINE 5
#endif

// GGX visible-normal-ish perturbation. One sample, jittered per pixel & frame.
vec3 perturbGGX(vec3 n, float roughness, vec2 xi) {
  float a = roughness * roughness;
  float phi = TAU * xi.x;
  float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
  vec3 up = abs(n.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tx = normalize(cross(up, n));
  vec3 ty = cross(n, tx);
  return normalize(tx * h.x + ty * h.y + n * h.z);
}

float sceneLinZ(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  if (isSky(d)) return 1.0e9;
  return -viewPosFromDepth(uv, d, uProjInv).z;
}

void main() {
  vec4 g = texture2D(tGBuffer, vUv);
  float mask = g.a;
  float roughness = g.b;
  if (mask <= 0.001 || roughness > uMaxRoughness) { gl_FragColor = vec4(0.0); return; }

  float depth = texture2D(tDepth, vUv).r;
  if (isSky(depth)) { gl_FragColor = vec4(0.0); return; }

  vec3 P = viewPosFromDepth(vUv, depth, uProjInv);
  vec3 N = octDecode(g.rg);
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  vec2 xi = hash22(gl_FragCoord.xy + vec2(uFrame * 11.37, uFrame * 7.91));
  vec3 Nr = roughness > 0.02 ? perturbGGX(N, roughness, xi) : N;
  vec3 R = normalize(reflect(-V, Nr));

  // Rays that come back out of the screen have no data behind them.
  float facing = saturate1(1.0 - dot(R, V) * 2.0);
  if (facing <= 0.0) { gl_FragColor = vec4(0.0); return; }

  float rayLen = uMaxDistance;
  vec3 endV = P + R * rayLen;
  if (endV.z > -uNear) {
    rayLen = (-uNear - P.z) / R.z;
    endV = P + R * rayLen;
  }
  if (rayLen <= 0.01) { gl_FragColor = vec4(0.0); return; }

  vec4 c0 = uProj * vec4(P, 1.0);
  vec4 c1 = uProj * vec4(endV, 1.0);
  if (c0.w <= 0.0 || c1.w <= 0.0) { gl_FragColor = vec4(0.0); return; }

  vec2 uvA = (c0.xy / c0.w) * 0.5 + 0.5;
  vec2 uvB = (c1.xy / c1.w) * 0.5 + 0.5;
  float kA = 1.0 / c0.w;      // 1/w is linear in screen space
  float kB = 1.0 / c1.w;

  float jitter = ign(gl_FragCoord.xy + vec2(uFrame * 3.11, uFrame * 5.07));

  float tPrev = 0.0;
  float zPrev = -P.z;
  float hitT = -1.0;
  vec2 hitUv = vec2(0.0);

  for (int i = 1; i <= SSR_STEPS; i++) {
    float t = (float(i) - jitter) / float(SSR_STEPS);
    t = clamp(t, 0.0, 1.0);
    vec2 uv = mix(uvA, uvB, t);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float rayZ = 1.0 / mix(kA, kB, t);
    float sZ = sceneLinZ(uv);

    if (rayZ > sZ && (rayZ - sZ) < uThickness + rayZ * 0.02) {
      // ---- binary refinement of the crossing ------------------------------
      float lo = tPrev, hi = t;
      for (int r = 0; r < SSR_REFINE; r++) {
        float mid = 0.5 * (lo + hi);
        vec2 muv = mix(uvA, uvB, mid);
        float mz = 1.0 / mix(kA, kB, mid);
        float ms = sceneLinZ(muv);
        if (mz > ms) hi = mid; else lo = mid;
      }
      hitT = hi;
      hitUv = mix(uvA, uvB, hi);
      break;
    }
    tPrev = t;
    zPrev = rayZ;
  }

  if (hitT < 0.0) { gl_FragColor = vec4(0.0); return; }

  vec3 refl = max(texture2D(tColor, hitUv).rgb, vec3(0.0));

  // Confidence: screen-edge fade, distance fade, facing fade.
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), hitUv) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), hitUv));
  float edge = e.x * e.y;
  float distFade = 1.0 - smoothstep(0.65, 1.0, hitT);
  float conf = edge * distFade * facing * mask;

  gl_FragColor = vec4(refl, conf);
}
`;

/** Roughness-weighted cross-bilateral resolve of the stochastic SSR samples. */
const SSR_RESOLVE_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSSR;
uniform sampler2D tGBuffer;
uniform vec2 uTexel;
uniform vec2 uDir;

void main() {
  vec4 c = texture2D(tSSR, vUv);
  float rough = texture2D(tGBuffer, vUv).b;
  if (c.a <= 0.0 && rough <= 0.0) { gl_FragColor = c; return; }

  // Cone width grows with roughness: a mirror stays a mirror.
  float radius = 1.0 + rough * 7.0;
  vec4 sum = c * 2.0;
  float wsum = 2.0;
  for (int i = 1; i <= 3; i++) {
    float o = float(i) * radius / 3.0;
    float w = 1.0 - float(i) / 4.0;
    vec4 a = texture2D(tSSR, vUv + uDir * uTexel * o);
    vec4 b = texture2D(tSSR, vUv - uDir * uTexel * o);
    sum += (a + b) * w;
    wsum += 2.0 * w;
  }
  gl_FragColor = sum / wsum;
}
`;

export function createSsrPass(steps: number, refine: number): Pass {
  return new Pass('post/ssr', SSR_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    tGBuffer: u<THREE.Texture | null>(null),
    uProj: u(new THREE.Matrix4()),
    uProjInv: u(new THREE.Matrix4()),
    uTexel: u(new THREE.Vector2()),
    uMaxDistance: u(420),
    uThickness: u(1.6),
    uMaxRoughness: u(0.45),
    uFrame: u(0),
    uNear: u(0.35),
  }, { SSR_STEPS: steps, SSR_REFINE: refine });
}

export function createSsrResolvePass(): Pass {
  return new Pass('post/ssr-resolve', SSR_RESOLVE_FRAG, {
    tSSR: u<THREE.Texture | null>(null),
    tGBuffer: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uDir: u(new THREE.Vector2(1, 0)),
  });
}
