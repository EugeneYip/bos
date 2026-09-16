import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, DEPTH } from '../core/glsl';

/**
 * Velocity buffer + tile-max / neighbour-max reconstruction motion blur
 * (McGuire et al. 2012).
 *
 * Velocity is reconstructed from depth against the previous frame's
 * view-projection, which is exact for static geometry — i.e. for a city. The
 * reprojection matrix is built camera-relative on the CPU in double precision,
 * so a camera 13 km from the world origin does not shed precision.
 *
 * The tile-max / neighbour-max pyramid is what lets a fast-moving foreground
 * object smear *outside* its own silhouette; without it you get the "blur
 * stays inside the object" tell.
 */
const VELOCITY_FRAG = /* glsl */ `
${COMMON}
${DEPTH}
varying vec2 vUv;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uReproject;
uniform vec2 uSize;
uniform float uScale;      // shutterAngle/360 * (targetFps * dt) normalisation
uniform float uMaxPixels;

void main() {
  float d = texture2D(tDepth, vUv).r;
  vec3 P = viewPosFromDepth(vUv, d, uProjInv);
  vec4 prevClip = uReproject * vec4(P, 1.0);
  if (prevClip.w <= 0.0) { gl_FragColor = vec4(0.0, 0.0, d, 1.0); return; }
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
  vec2 v = (vUv - prevUv) * uScale;

  vec2 px = v * uSize;
  float len = length(px);
  if (len > uMaxPixels) px *= uMaxPixels / len;
  gl_FragColor = vec4(px / uSize, d, 1.0);
}
`;

/** Separable max-magnitude reduction into K x K tiles. */
const TILE_MAX_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tVel;
uniform vec2 uTexel;     // source texel
uniform vec2 uDir;
uniform int uSteps;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uSteps) break;
    vec2 o = uDir * uTexel * (float(i) + 0.5);
    vec2 v = texture2D(tVel, vUv + o).xy;
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

const NEIGHBOR_MAX_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tTile;
uniform vec2 uTexel;
void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texture2D(tTile, vUv + vec2(float(x), float(y)) * uTexel).xy;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

const RECONSTRUCT_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tVel;       // rg = velocity (uv), b = device depth
uniform sampler2D tNeighbor;
uniform vec2 uSize;
uniform vec2 uTexel;
uniform float uFrame;

#ifndef MB_SAMPLES
#define MB_SAMPLES 12
#endif

float softDepthCompare(float za, float zb) {
  // Both are device depths; smaller = nearer. 0.001 tolerance in device units
  // is a few centimetres up close and a few metres at the far plane, which is
  // the right shape for this test.
  return clamp(1.0 - (zb - za) / 0.0012, 0.0, 1.0);
}
float cone(float dist, float speed) { return clamp(1.0 - dist / max(speed, 1e-5), 0.0, 1.0); }
float cylinder(float dist, float speed) { return 1.0 - smoothstep(0.95 * speed, 1.05 * speed, dist); }

void main() {
  vec4 centerSample = texture2D(tColor, vUv);
  vec3 center = centerSample.rgb;
  vec2 vN = texture2D(tNeighbor, vUv).xy * uSize;     // pixels
  float lenN = length(vN);
  if (lenN < 0.75) { gl_FragColor = vec4(center, 1.0); return; }

  vec3 velC = texture2D(tVel, vUv).xyz;
  // Depth-reprojected velocity assumes the surface under this pixel also
  // existed last frame. tColor is TAA's resolve, which carries how well that
  // held up in its alpha (see taa.ts): low confidence means this pixel was
  // not corroborated by last frame's history — a building tile or a
  // vegetation-tier swap that streamed in this frame, not a real object in
  // motion — so the "velocity" is really just the depth gap between the new
  // surface and whatever used to be behind it, and is scaled down rather
  // than trusted at face value. A genuinely fast, freshly-disoccluded object
  // is also low-confidence at its leading edge, so this trades a hard,
  // unblurred silhouette there for not smearing streamed-in content.
  vec2 vC = velC.xy * uSize * mix(0.15, 1.0, centerSample.a);
  float lenC = max(length(vC), 0.5);
  float zC = velC.z;

  float jitter = ign(gl_FragCoord.xy + vec2(uFrame * 4.13, uFrame * 8.31)) - 0.5;

  vec3 sum = center * (1.0 / max(lenC, 1.0));
  float wsum = 1.0 / max(lenC, 1.0);

  for (int i = 0; i < MB_SAMPLES; i++) {
    float t = mix(-1.0, 1.0, (float(i) + jitter + 0.5) / float(MB_SAMPLES));
    // Alternate between the dominant tile direction and this pixel's own
    // velocity so both the smearing object and its background are sampled.
    vec2 dir = (i % 2 == 0) ? vN : vC;
    vec2 offPx = dir * t;
    vec2 suv = vUv + offPx * uTexel;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    vec3 velS = texture2D(tVel, suv).xyz;
    float zS = velS.z;
    float lenS = max(length(velS.xy * uSize), 0.5);
    float dist = length(offPx);

    float fg = softDepthCompare(zC, zS);   // sample is in front of centre
    float bg = softDepthCompare(zS, zC);   // centre is in front of sample
    float weight = fg * cone(dist, lenS) + bg * cone(dist, lenC)
                 + cylinder(dist, lenS) * cylinder(dist, lenC) * 2.0;

    // Same reasoning as centreSample above, applied to the sample this gather
    // is about to pull in: a low-confidence sample is streamed-in content
    // reached via the tile-max dilation (vN), not a real smear source, so its
    // contribution is damped rather than blended in at full strength.
    vec4 s = texture2D(tColor, suv);
    weight *= mix(0.2, 1.0, s.a);

    sum += s.rgb * weight;
    wsum += weight;
  }

  gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
}
`;

export function createVelocityPass(): Pass {
  return new Pass('post/velocity', VELOCITY_FRAG, {
    tDepth: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uReproject: u(new THREE.Matrix4()),
    uSize: u(new THREE.Vector2()),
    uScale: u(1),
    uMaxPixels: u(42),
  });
}

export function createTileMaxPass(): Pass {
  return new Pass('post/mb-tilemax', TILE_MAX_FRAG, {
    tVel: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uDir: u(new THREE.Vector2(1, 0)),
    uSteps: u(20),
  });
}

export function createNeighborMaxPass(): Pass {
  return new Pass('post/mb-neighbormax', NEIGHBOR_MAX_FRAG, {
    tTile: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
  });
}

export function createMotionBlurPass(samples: number): Pass {
  return new Pass('post/motion-blur', RECONSTRUCT_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tVel: u<THREE.Texture | null>(null),
    tNeighbor: u<THREE.Texture | null>(null),
    uSize: u(new THREE.Vector2()),
    uTexel: u(new THREE.Vector2()),
    uFrame: u(0),
  }, { MB_SAMPLES: samples });
}
