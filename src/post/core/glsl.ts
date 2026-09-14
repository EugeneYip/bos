/**
 * Shared GLSL building blocks. Written GLSL-ES-1 style (`varying`, `texture2D`,
 * `gl_FragColor`) because three.js rewrites those to GLSL ES 3.00 for WebGL2,
 * which keeps `textureLod`/`textureGather` available while staying portable.
 */

/** Luminance, colour-space conversions, packing. */
export const COMMON = /* glsl */ `
#ifndef POST_COMMON
#define POST_COMMON

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float lumaFast(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float maxc(vec3 c) { return max(c.x, max(c.y, c.z)); }
float saturate1(float x) { return clamp(x, 0.0, 1.0); }
vec3  saturate3(vec3 x) { return clamp(x, vec3(0.0), vec3(1.0)); }

// YCoCg is the right space for TAA neighbourhood clipping: the chroma axes are
// perceptually cheap to clip hard, so the luma AABB stays tight.
vec3 rgbToYCoCg(vec3 c) {
  float y  = dot(c, vec3(0.25, 0.5, 0.25));
  float co = dot(c, vec3(0.5, 0.0, -0.5));
  float cg = dot(c, vec3(-0.25, 0.5, -0.25));
  return vec3(y, co, cg);
}
vec3 ycoCgToRgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

// Tonemapped-space weighting (Karis) so a single firefly cannot dominate a
// temporal or spatial average.
vec3 tonemapReinhard(vec3 c)    { return c / (1.0 + maxc(c)); }
vec3 untonemapReinhard(vec3 c)  { return c / max(1e-4, 1.0 - maxc(c)); }

// Octahedral normal packing: two channels, uniform error, no seams that matter.
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.xy;
  if (n.z < 0.0) e = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e;
}
vec3 octDecode(vec2 e) {
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

// Interleaved gradient noise (Jimenez): the cheapest spatial dither that still
// looks like blue noise once TAA integrates it over time.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// sRGB OETF, applied exactly once, in the final pass.
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
#endif
`;

/** Depth → view space, plus normal reconstruction from the depth buffer. */
export const DEPTH = /* glsl */ `
#ifndef POST_DEPTH
#define POST_DEPTH

// Reconstructs the view-space position of a pixel. Camera-relative, so the
// numbers stay small even though the world spans 26 km.
vec3 viewPosFromDepth(vec2 uv, float depth, mat4 projInv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 v = projInv * clip;
  return v.xyz / v.w;
}

float viewZFromDepth(float depth, float near, float far) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

bool isSky(float depth) { return depth >= 0.9999999; }

/**
 * Geometric normal from depth, "best of four" variant: for each screen axis we
 * keep the neighbour whose depth is closest to the centre, which stops the
 * cross product from straddling a silhouette and firing off a bogus normal.
 * This is what keeps AO from haloing along building edges against the sky.
 */
vec3 normalFromDepth(sampler2D depthTex, vec2 uv, vec2 texel, mat4 projInv, vec3 P, float depthC) {
  float dL = texture2D(depthTex, uv - vec2(texel.x, 0.0)).r;
  float dR = texture2D(depthTex, uv + vec2(texel.x, 0.0)).r;
  float dD = texture2D(depthTex, uv - vec2(0.0, texel.y)).r;
  float dU = texture2D(depthTex, uv + vec2(0.0, texel.y)).r;

  vec3 pL = viewPosFromDepth(uv - vec2(texel.x, 0.0), dL, projInv);
  vec3 pR = viewPosFromDepth(uv + vec2(texel.x, 0.0), dR, projInv);
  vec3 pD = viewPosFromDepth(uv - vec2(0.0, texel.y), dD, projInv);
  vec3 pU = viewPosFromDepth(uv + vec2(0.0, texel.y), dU, projInv);

  vec3 dpdx = abs(pR.z - P.z) < abs(P.z - pL.z) ? (pR - P) : (P - pL);
  vec3 dpdy = abs(pU.z - P.z) < abs(P.z - pD.z) ? (pU - P) : (P - pD);

  vec3 n = cross(dpdx, dpdy);
  float len = length(n);
  return len > 1e-12 ? n / len : vec3(0.0, 0.0, 1.0);
}
#endif
`;

/** Catmull-Rom history resampling: 5 bilinear taps, no over-blurring. */
export const CATMULL_ROM = /* glsl */ `
#ifndef POST_CATROM
#define POST_CATROM
// 9-tap Catmull-Rom collapsed to 5 bilinear fetches. Sharper than bilinear by a
// long way, which is the difference between resolving the Zakim's cable stays
// and smearing them into grey mush.
vec4 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;

  vec4 result = vec4(0.0);
  result += texture2D(tex, vec2(texPos0.x, texPos0.y))  * w0.x * w0.y;
  result += texture2D(tex, vec2(texPos12.x, texPos0.y)) * w12.x * w0.y;
  result += texture2D(tex, vec2(texPos3.x, texPos0.y))  * w3.x * w0.y;

  result += texture2D(tex, vec2(texPos0.x, texPos12.y))  * w0.x * w12.y;
  result += texture2D(tex, vec2(texPos12.x, texPos12.y)) * w12.x * w12.y;
  result += texture2D(tex, vec2(texPos3.x, texPos12.y))  * w3.x * w12.y;

  result += texture2D(tex, vec2(texPos0.x, texPos3.y))  * w0.x * w3.y;
  result += texture2D(tex, vec2(texPos12.x, texPos3.y)) * w12.x * w3.y;
  result += texture2D(tex, vec2(texPos3.x, texPos3.y))  * w3.x * w3.y;
  return result;
}
#endif
`;

/** ACES (Hill's fit, not the Narkowicz approximation) and AgX. */
export const TONEMAP = /* glsl */ `
#ifndef POST_TONEMAP
#define POST_TONEMAP

// Stephen Hill's sRGB <-> ACEScg fit. Columns, GLSL order.
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/** Full RRT+ODT fit through ACEScg. Rolls highlights off instead of clipping. */
vec3 tonemapACES(vec3 color) {
  color = ACES_INPUT * color;
  color = rrtOdtFit(color);
  color = ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}

const mat3 SRGB_TO_REC2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0113, 0.8956
);
const mat3 REC2020_TO_SRGB = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187
);
const mat3 AGX_INSET = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);
const mat3 AGX_OUTSET = mat3(
   1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272,  -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** AgX: flatter, more neutral hue handling than ACES, great for night. */
vec3 tonemapAgX(vec3 color) {
  color = SRGB_TO_REC2020 * color;
  color = AGX_INSET * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color + 12.47393) / (4.026069 + 12.47393);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = AGX_OUTSET * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
#endif
`;

/** Concatenate chunks into a fragment shader body. */
export function frag(...parts: string[]): string {
  return parts.join('\n');
}

export const PRECISION = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;
