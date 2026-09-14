import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON } from '../core/glsl';

/**
 * FSR 1.0 EASU (Edge Adaptive Spatial Upsampling) + RCAS (Robust Contrast
 * Adaptive Sharpening), ported from AMD's reference.
 *
 * EASU fits an anisotropic 12-tap Lanczos-ish kernel oriented along the local
 * gradient, which reconstructs edges far better than bilinear or bicubic when
 * going from e.g. 1280x720 to 1920x1080. RCAS then restores the high-frequency
 * detail EASU necessarily softens, without the ringing a plain unsharp mask
 * produces on a city full of hard vertical edges.
 *
 * Both operate on perceptually-encoded (already tonemapped, sRGB) colour, which
 * is what FSR expects and why the grade pass runs before the upscale.
 */
const EASU_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uInputSize;
uniform vec2 uOutputSize;

vec3 fetch(vec2 p) { return texture2D(tSrc, (p + 0.5) / uInputSize).rgb; }

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len;
  float d2 = min(dot(v, v), clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void easuSet(inout vec2 dir, inout float len, vec2 pp, bool biS, bool biT, bool biU, bool biV,
             float lA, float lB, float lC, float lD, float lE) {
  float w = 0.0;
  if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
  if (biT) w = pp.x * (1.0 - pp.y);
  if (biU) w = (1.0 - pp.x) * pp.y;
  if (biV) w = pp.x * pp.y;

  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-5);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;

  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-5);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

void main() {
  vec2 scale = uInputSize / uOutputSize;
  vec2 pos = vUv * uOutputSize * scale - 0.5;   // source-space position
  vec2 fp = floor(pos);
  vec2 pp = pos - fp;

  //  b c
  // e f g h
  // i j k l
  //  n o
  vec3 bC = fetch(fp + vec2(0.0, -1.0));
  vec3 cC = fetch(fp + vec2(1.0, -1.0));
  vec3 eC = fetch(fp + vec2(-1.0, 0.0));
  vec3 fC = fetch(fp + vec2(0.0, 0.0));
  vec3 gC = fetch(fp + vec2(1.0, 0.0));
  vec3 hC = fetch(fp + vec2(2.0, 0.0));
  vec3 iC = fetch(fp + vec2(-1.0, 1.0));
  vec3 jC = fetch(fp + vec2(0.0, 1.0));
  vec3 kC = fetch(fp + vec2(1.0, 1.0));
  vec3 lC = fetch(fp + vec2(2.0, 1.0));
  vec3 nC = fetch(fp + vec2(0.0, 2.0));
  vec3 oC = fetch(fp + vec2(1.0, 2.0));

  // FSR uses green as the luma proxy; matching it keeps the kernel behaviour.
  float bL = bC.g * 0.5 + (bC.r * 0.25 + bC.b * 0.25);
  float cL = cC.g * 0.5 + (cC.r * 0.25 + cC.b * 0.25);
  float eL = eC.g * 0.5 + (eC.r * 0.25 + eC.b * 0.25);
  float fL = fC.g * 0.5 + (fC.r * 0.25 + fC.b * 0.25);
  float gL = gC.g * 0.5 + (gC.r * 0.25 + gC.b * 0.25);
  float hL = hC.g * 0.5 + (hC.r * 0.25 + hC.b * 0.25);
  float iL = iC.g * 0.5 + (iC.r * 0.25 + iC.b * 0.25);
  float jL = jC.g * 0.5 + (jC.r * 0.25 + jC.b * 0.25);
  float kL = kC.g * 0.5 + (kC.r * 0.25 + kC.b * 0.25);
  float lL = lC.g * 0.5 + (lC.r * 0.25 + lC.b * 0.25);
  float nL = nC.g * 0.5 + (nC.r * 0.25 + nC.b * 0.25);
  float oL = oC.g * 0.5 + (oC.r * 0.25 + oC.b * 0.25);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, pp, true,  false, false, false, bL, eL, fL, gL, jL);
  easuSet(dir, len, pp, false, true,  false, false, cL, fL, gL, hL, kL);
  easuSet(dir, len, pp, false, false, true,  false, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp, false, false, false, true,  gL, jL, kL, lL, oL);

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < 1.0 / 32768.0;
  dirR = inversesqrt(max(dirR, 1e-8));
  dirR = zro ? 1.0 : dirR;
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;

  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 1e-5);
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 - 0.29 * len;
  float clp = 1.0 / lob;

  vec3 minC = min(min(fC, gC), min(jC, kC));
  vec3 maxC = max(max(fC, gC), max(jC, kC));

  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, iC);
  easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, jC);
  easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, fC);
  easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, eC);
  easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, kC);
  easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, lC);
  easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, hC);
  easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, gC);
  easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, oC);
  easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, nC);

  vec3 res = aC / max(aW, 1e-5);
  gl_FragColor = vec4(clamp(res, minC, maxC), 1.0);
}
`;

const RCAS_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uSharpness;   // 0 = none, 1 = maximum

void main() {
  //    b
  //  d e f
  //    h
  vec3 b = texture2D(tSrc, vUv + vec2(0.0, -1.0) * uTexel).rgb;
  vec3 d = texture2D(tSrc, vUv + vec2(-1.0, 0.0) * uTexel).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + vec2(1.0, 0.0) * uTexel).rgb;
  vec3 h = texture2D(tSrc, vUv + vec2(0.0, 1.0) * uTexel).rgb;

  if (uSharpness <= 0.001) { gl_FragColor = vec4(e, 1.0); return; }

  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));

  // FSR's per-channel limiter: the largest negative lobe that still keeps the
  // result inside the local range, so hard city edges sharpen without ringing.
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (vec3(1.0) - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(maxc(lobeRGB), 0.0));
  // sharpness 1 -> full strength, 0.25 at the gentle end.
  lobe *= exp2(-mix(2.0, 0.0, clamp(uSharpness, 0.0, 1.0)));

  vec3 res = (lobe * (b + d + f + h) + e) / (1.0 + 4.0 * lobe);
  vec3 mn = min(mn4, e);
  vec3 mx = max(mx4, e);
  gl_FragColor = vec4(clamp(res, mn, mx), 1.0);
}
`;

export function createEasuPass(): Pass {
  return new Pass('post/easu', EASU_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uInputSize: u(new THREE.Vector2()),
    uOutputSize: u(new THREE.Vector2()),
  });
}

export function createRcasPass(): Pass {
  return new Pass('post/rcas', RCAS_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uSharpness: u(0.35),
  });
}
