import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, DEPTH } from '../core/glsl';

/**
 * Folds ambient occlusion and screen-space reflections back into the HDR scene
 * colour, in one pass so the full-res buffer is only read and written once.
 *
 * AO is bilaterally upsampled from half resolution using the view depth the
 * GTAO pass stored alongside it, so occlusion never bleeds across a silhouette
 * (which is the other classic source of AO halos).
 *
 * AO is applied with Jimenez's multi-bounce approximation: a red brick wall in
 * an occluded corner goes dark *red*, not dark grey. Straight multiplication is
 * the reason so much SSAO reads as smeared dirt.
 */
const COMPOSITE_FRAG = /* glsl */ `
${COMMON}
${DEPTH}

varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform sampler2D tGBuffer;

uniform mat4  uProjInv;
uniform vec2  uAoTexel;
uniform float uAoIntensity;
uniform float uAoBounce;
uniform float uSsrIntensity;
uniform float uHasAO;
uniform float uHasSSR;

// Jimenez 2016 multi-bounce fit: albedo-aware AO so occlusion tints rather
// than just darkens.
vec3 multiBounceAO(float ao, vec3 albedo) {
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  return clamp(((ao * a + b) * ao + c) * ao, vec3(ao), vec3(1.0));
}

float upsampleAO(vec2 uv, float viewZ) {
  // 4 nearest half-res taps weighted by depth agreement.
  vec2 base = uv;
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -1; y <= 1; y += 2) {
    for (int x = -1; x <= 1; x += 2) {
      vec2 o = vec2(float(x), float(y)) * 0.5 * uAoTexel;
      vec2 t = texture2D(tAO, base + o).xy;
      float dz = abs(t.y - viewZ) / max(viewZ, 1e-3);
      float w = 1.0 / (1.0 + dz * 220.0);
      sum += t.x * w;
      wsum += w;
    }
  }
  return wsum > 1e-5 ? sum / wsum : texture2D(tAO, uv).x;
}

void main() {
  vec3 color = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  float depth = texture2D(tDepth, vUv).r;

  if (isSky(depth)) { gl_FragColor = vec4(color, 1.0); return; }

  float viewZ = -viewPosFromDepth(vUv, depth, uProjInv).z;

  if (uHasAO > 0.5) {
    float ao = saturate1(upsampleAO(vUv, viewZ));
    float occ = mix(1.0, ao, uAoIntensity);
    // Treat the pixel's own colour as a stand-in for albedo; it is the best
    // proxy available without a full G-buffer and it behaves well.
    vec3 proxy = saturate3(color * 0.6);
    vec3 bounced = multiBounceAO(occ, proxy);
    color *= mix(vec3(occ), bounced, uAoBounce);
  }

  if (uHasSSR > 0.5) {
    vec4 ssr = texture2D(tSSR, vUv);
    vec4 g = texture2D(tGBuffer, vUv);
    float conf = ssr.a * uSsrIntensity;
    if (conf > 0.001) {
      vec3 N = octDecode(g.rg);
      vec3 P = viewPosFromDepth(vUv, depth, uProjInv);
      vec3 V = normalize(-P);
      float ndv = saturate1(abs(dot(N, V)));
      float f0 = max(g.a * 0.08, 0.02);
      // Schlick, with the roughness-aware horizon fade.
      float fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
      fres *= (1.0 - g.b * 0.6);
      float w = saturate1(conf) * saturate1(fres * 6.0);
      // Energy conserving: take out the Fresnel-weighted share of whatever the
      // base pass reflected and put the screen-space result in its place.
      color = color * (1.0 - w) + ssr.rgb * w;
    }
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export function createCompositePass(): Pass {
  return new Pass('post/composite', COMPOSITE_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    tAO: u<THREE.Texture | null>(null),
    tSSR: u<THREE.Texture | null>(null),
    tGBuffer: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uAoTexel: u(new THREE.Vector2()),
    uAoIntensity: u(0.95),
    uAoBounce: u(0.22),
    uSsrIntensity: u(1),
    uHasAO: u(0),
    uHasSSR: u(0),
  });
}
