import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, TONEMAP } from '../core/glsl';

/**
 * The single place the image leaves linear HDR.
 *
 * Order matters and is deliberately physical:
 *   lens (CA, vignette) -> bloom/halation -> exposure -> white balance
 *   -> tonemap -> creative grade -> grain -> sRGB encode -> dither
 *
 * CA and vignette happen on the *scene-referred* HDR signal because that is
 * where a real lens applies them: the corners of the frame receive less light,
 * so highlights there roll off earlier rather than merely getting darker after
 * the fact. Everything creative happens after the tonemap in display space,
 * which is where a colourist actually works.
 *
 * This is the only pass in the whole engine that performs an sRGB encode.
 * 'renderer.toneMapping' is forced to 'NoToneMapping' by the Post module so
 * three never applies ACES a second time.
 */
const GRADE_FRAG = /* glsl */ `
${COMMON}
${TONEMAP}

varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tExposure;
uniform sampler2D tLut;

uniform vec2  uTexel;
uniform float uAspect;

// exposure
uniform float uExposureBase;   // artistic exposure published by Sky
uniform float uAutoStrength;
uniform float uIsoGain;        // >1 when auto-exposure is pushing a dark scene

// bloom
uniform float uBloomIntensity;
uniform vec3  uStreakTint;
uniform float uStreakIntensity;
uniform float uHalation;

// lens
uniform float uCA;
uniform float uVignette;
uniform float uVignetteRoundness;
uniform float uGrain;
uniform float uGrainShadowBias;
uniform float uTime;

// grade
uniform float uWhitePoint;
uniform float uContrast;
uniform float uContrastPivot;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uSplitBalance;
uniform float uLutStrength;
uniform float uLutSize;

vec3 fetchScene(vec2 uv) { return max(texture2D(tColor, uv).rgb, vec3(0.0)); }

#ifdef USE_LUT
// 3D LUT packed as a horizontal strip of 'uLutSize' slices, tetrahedral-free
// but with proper slice interpolation (the visible difference from tetrahedral
// only shows on extreme looks).
vec3 sampleLut(vec3 c) {
  float n = uLutSize;
  c = clamp(c, 0.0, 1.0);
  float slice = c.b * (n - 1.0);
  float s0 = floor(slice);
  float s1 = min(s0 + 1.0, n - 1.0);
  float f = slice - s0;
  vec2 uvScale = vec2(1.0 / (n * n), 1.0 / n);
  vec2 base = vec2(c.r, 1.0 - c.g) * (vec2(n - 1.0) / vec2(n * n, n)) + vec2(0.5 / (n * n), 0.5 / n);
  vec3 a = texture2D(tLut, base + vec2(s0 / n, 0.0)).rgb;
  vec3 b = texture2D(tLut, base + vec2(s1 / n, 0.0)).rgb;
  return mix(a, b, f);
}
#endif

// Approximate white balance in linear light via a von-Kries-ish channel scale.
vec3 whiteBalance(vec3 c, float temp, float tint) {
  float t = temp * 0.12;
  float g = tint * 0.10;
  vec3 k = vec3(1.0 + t, 1.0 + g * 0.5, 1.0 - t);
  k /= max(dot(k, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  return c * k;
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  // ---- chromatic aberration (edges only, r^2 weighted) ---------------------
  vec3 color;
#ifdef USE_CA
  vec2 off = d * r2 * (uCA * 2.83) * uTexel * 2.0;
  color.r = fetchScene(uv + off).r;
  color.g = fetchScene(uv).g;
  color.b = fetchScene(uv - off).b;
#else
  color = fetchScene(uv);
#endif

  // ---- optical vignette: cos^4 falloff, applied before exposure ------------
#ifdef USE_VIGNETTE
  float rv = length(vec2(d.x * uAspect, d.y)) * 2.0 * uVignetteRoundness;
  float cos4 = 1.0 / ((1.0 + rv * rv) * (1.0 + rv * rv));
  color *= mix(1.0, cos4, uVignette);
#endif

  // ---- bloom ---------------------------------------------------------------
#ifdef USE_BLOOM
  vec3 bloom = max(texture2D(tBloom, uv).rgb, vec3(0.0));
  // Energy-conserving blend: bloom is the fraction of light the lens scattered
  // out of the direct path, so it replaces rather than adds.
  color = mix(color, bloom, clamp(uBloomIntensity, 0.0, 1.0));
  // Halation: the warm bleed a film emulsion produces around hot highlights.
  color += bloom * vec3(1.0, 0.42, 0.26) * uHalation;
#endif
#ifdef USE_STREAK
  vec3 streak = max(texture2D(tStreak, uv).rgb, vec3(0.0));
  color += streak * uStreakTint * uStreakIntensity;
#endif

  // ---- exposure ------------------------------------------------------------
  float ev = texture2D(tExposure, vec2(0.5)).x;
  float baseEV = log2(max(uExposureBase, 1e-5));
  float exposure = exp2(mix(baseEV, ev, clamp(uAutoStrength, 0.0, 1.0)));
  color *= exposure;

  // ---- white balance (linear) ---------------------------------------------
  color = whiteBalance(color, uTemperature, uTint);

  // Scale by the white point so the tonemapper's shoulder lands where the
  // artist asked rather than always at 1.0.
  color /= max(uWhitePoint * 0.125, 1e-3);

  // ---- tonemap -------------------------------------------------------------
#if TONEMAP_MODE == 1
  vec3 graded = tonemapACES(color);
#elif TONEMAP_MODE == 2
  vec3 graded = tonemapAgX(color);
#else
  vec3 graded = saturate3(color);
#endif

  // ---- creative grade, display-referred ------------------------------------
  // Lift / gamma / gain (ASC CDL ordering: gain, then lift, then gamma).
  graded = graded * uGain + uLift;
  graded = pow(max(graded, vec3(0.0)), max(uGamma, vec3(0.02)));

  // Contrast about a pivot, as a power rather than as a straight line.
  //
  // '(g - pivot) * contrast + pivot' is a line, and with pivot 0.42 and
  // contrast 1.04 it crosses zero at g = 0.0162 -- so everything that should
  // present below about 34/255 was clamped to pure black. Over half the paving
  // under the Commonwealth Avenue Mall's elms came out at exactly 0,0,0: not
  // dark, nothing, with no gradation left in it. Rendered without the post
  // chain the same pixels sit around 11/255 against a sunlit road at 44, which
  // is what open shade under a closed canopy should look like, so the light was
  // right and the curve was throwing it away.
  //
  // A power about the same pivot has the same slope there, so the look through
  // the midtones is unchanged, but it only reaches zero at zero.
  graded = uContrastPivot * pow(max(graded, vec3(1e-6)) / uContrastPivot, vec3(uContrast));

  // Split toning.
  float lum = luma(graded);
  float sw = saturate1(1.0 - lum * 2.0 + uSplitBalance);
  float hw = saturate1(lum * 2.0 - 1.0 - uSplitBalance);
  graded += uShadowTint * sw + uHighlightTint * hw;

  // Saturation last so tinting does not get amplified.
  lum = luma(graded);
  graded = mix(vec3(lum), graded, uSaturation);
  graded = saturate3(graded);

#ifdef USE_LUT
  graded = mix(graded, sampleLut(graded), clamp(uLutStrength, 0.0, 1.0));
#endif

  // ---- output --------------------------------------------------------------
#ifdef OUTPUT_SRGB
  vec3 outc = linearToSrgb(graded);
#else
  vec3 outc = graded;
#endif

  // ---- grain ---------------------------------------------------------------
  // Grain belongs in display space, not in light.
  //
  // It used to be added to 'graded' — tonemapped, but still linear — and then
  // encoded. The encode expands small values by roughly a factor of ten, so a
  // fixed amplitude that is invisible in a highlight is larger than the signal
  // itself in a shadow. The Charles at grazing incidence sits near 0.01 linear,
  // correctly, because it is reflecting a genuinely dark sky; against that,
  // 0.013 of grain biased toward the shadows and multiplied by the ISO gain was
  // several times the signal, and gamma turned it into salt-and-pepper static.
  // The water shader was blamed for that twice and rewritten once.
  //
  // Applied after the encode, one unit of grain is one unit of visible grain
  // wherever it lands — which is what film does, and what a sensor looks like
  // once an image has been developed off it.
#ifdef USE_GRAIN
  // Two hashes combined approximate a Gaussian.
  vec2 gseed = gl_FragCoord.xy + uTime * 137.0;
  float n = (hash12(gseed) + hash12(gseed + 41.7) - 1.0);
  float gl = luma(outc);
  float shadowW = mix(1.0, uGrainShadowBias, saturate1(1.0 - gl * 1.6));
  float hiRoll = 1.0 - smoothstep(0.75, 1.0, gl);
  // Undeveloped grains carry no density, so film is clean in the deep shadow as
  // well as in the highlight. Without this the grain simply moves from eating
  // the water to speckling the night sky.
  float loRoll = smoothstep(0.0, 0.05, gl);
  outc += n * uGrain * shadowW * hiRoll * loRoll * uIsoGain;
  outc = max(outc, vec3(0.0));
#endif

#ifdef USE_DITHER
  // Triangular-PDF dither at 1 LSB kills 8-bit banding in the sky gradient.
  float dn = hash12(gl_FragCoord.xy + uTime * 7.0) + hash12(gl_FragCoord.xy + 19.3 + uTime * 7.0) - 1.0;
  outc += dn * (1.0 / 255.0);
#endif

  gl_FragColor = vec4(outc, 1.0);
}
`;

export function createGradePass(): Pass {
  return new Pass('post/grade', GRADE_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tBloom: u<THREE.Texture | null>(null),
    tStreak: u<THREE.Texture | null>(null),
    tExposure: u<THREE.Texture | null>(null),
    tLut: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uAspect: u(1.777),
    uExposureBase: u(0.78),
    uAutoStrength: u(0.85),
    uIsoGain: u(1),
    uBloomIntensity: u(0.045),
    uStreakTint: u(new THREE.Vector3(0.45, 0.6, 1)),
    uStreakIntensity: u(0),
    uHalation: u(0.18),
    uCA: u(0.9),
    uVignette: u(0.3),
    uVignetteRoundness: u(1.1),
    uGrain: u(0.028),
    uGrainShadowBias: u(1.6),
    uTime: u(0),
    uWhitePoint: u(8),
    uContrast: u(1.04),
    uContrastPivot: u(0.42),
    uSaturation: u(1.02),
    uTemperature: u(0),
    uTint: u(0),
    uLift: u(new THREE.Vector3()),
    uGamma: u(new THREE.Vector3(1, 1, 1)),
    uGain: u(new THREE.Vector3(1, 1, 1)),
    uShadowTint: u(new THREE.Vector3()),
    uHighlightTint: u(new THREE.Vector3()),
    uSplitBalance: u(0),
    uLutStrength: u(0),
    uLutSize: u(32),
  }, { TONEMAP_MODE: 1, USE_BLOOM: 1, OUTPUT_SRGB: 1 });
}
