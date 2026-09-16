/**
 * GLSL shared by the water vertex and fragment stages.
 *
 * Three pieces live here because both stages have to agree on them to the
 * last decimal, or the shading detaches from the geometry:
 *
 *  1. 'WATER_WIND_GLSL' — the wind field. Gust cells, Langmuir streaks and
 *     the slicks between them. This is the single most important function in
 *     the module: water only stops reading as a mirror when its roughness
 *     varies in patches, and everything else (chop amplitude, glitter width,
 *     foam, reflection blur) is driven from it.
 *  2. 'WATER_WAVE_GLSL' — the gravity-wave spectrum. Wavelengths are real
 *     metres and the angular frequency comes from the deep-water dispersion
 *     relation w = sqrt(g k), so a 88 m swell travels at 11.7 m/s, which is
 *     what water actually does. Fetch squeezes the whole spectrum, length
 *     harder than height: the impounded Charles gets 3.5-21 m chop about
 *     16 cm high, the outer harbour a 0.3 m, 88 m swell.
 *  3. 'WATER_GLOW_GLSL' / 'WATER_BRDF_GLSL' — Boston's own skyglow and the
 *     dielectric response. The sky itself comes from 'ctx.aerial'.
 */

export const WATER_CONST_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
#define WATER_G 9.81

mat2 wRot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/** Wind-aligned frame: x runs downwind, y across it. */
vec2 windFrame(vec2 p, vec2 w) { return vec2(dot(p, w), dot(p, vec2(-w.y, w.x))); }
`;

/**
 * Wind field.
 *
 * Boston's basin winds are gusty and patchy — from the Longfellow you can
 * watch a cat's paw cross the river and turn a mirror into matte grey in
 * about four seconds, leaving a smooth slick behind it. Two decorrelated
 * octaves do the work: ~1.4 km cells for the gust fronts, and a strongly
 * anisotropic ~90 m-across / 560 m-along octave for the Langmuir streaks
 * that line up with the wind.
 *
 * Returns
 *   .x  gust   0 = glassy slick, 1 = fully roughened cat's paw
 *   .y  streak 0..1, wind-aligned banding inside a gust
 *   .z  swell  0..1, very large-scale energy for the geometric wave height
 */
export const WATER_WIND_GLSL = /* glsl */ `
uniform sampler2D uNoise;
uniform vec2  uWind;        // unit vector, the direction the wind blows toward
uniform float uWindSpeed;   // m/s
uniform float uGustiness;   // 0 = steady breeze, 1 = squally

// Vertex and fragment stages disagree about how to pick a mip, so the fetch
// itself is a macro each stage defines before including this.
#ifndef WATER_NOISE_FETCH
#define WATER_NOISE_FETCH(uv) texture2D(uNoise, uv)
#endif

vec3 windField(vec2 p, float t) {
  vec2 q = windFrame(p, uWind);

  // Gust cells, drifting downwind at roughly half the wind speed.
  vec2 uvA = (q + vec2(t * uWindSpeed * 0.42, t * uWindSpeed * 0.04)) * vec2(1.0 / 1450.0, 1.0 / 820.0);
  vec4 nA = WATER_NOISE_FETCH(uvA);

  // Streaks: six times longer than they are wide, moving a little faster.
  vec2 uvB = (q + vec2(t * uWindSpeed * 0.66, 0.0)) * vec2(1.0 / 520.0, 1.0 / 84.0);
  vec4 nB = WATER_NOISE_FETCH(uvB);

  float cell = (nA.r * 0.58 + nA.b * 0.42 - 0.5) * 2.5 + 0.5;
  float streak = (nB.g * 0.55 + nB.a * 0.45 - 0.5) * 1.7 + 0.5;

  // Gustiness widens the histogram: a steady breeze roughens everything a
  // little, a squally day leaves half the river glassy and half of it matte.
  float lo = mix(0.06, 0.34, uGustiness);
  float hi = mix(0.52, 0.92, uGustiness);
  float gust = smoothstep(lo, hi, cell);
  gust = mix(gust, gust * smoothstep(0.05, 0.80, streak), 0.32 * uGustiness);

  float swell = smoothstep(0.18, 0.86, (nA.g - 0.5) * 1.8 + 0.5);
  return vec3(clamp(gust, 0.0, 1.0), clamp(streak, 0.0, 1.0), swell);
}
`;

/**
 * Fetch-limited gravity-wave spectrum.
 *
 * Four Gerstner components. 'fetch' (0 = a duck pond, 1 = the outer harbour)
 * compresses both axes of the spectrum, but not equally: short-fetch wind
 * chop is proportionally steeper than swell, which is why the Charles looks
 * textured rather than smooth even though its waves are only centimetres high.
 *
 * Each component carries two independent fades:
 *  - 'geo'  how much of it survives as vertex displacement. Killed for
 *           wavelengths the 6 m lattice cannot resolve, and rolled off with
 *           distance so far water does not crawl.
 *  - 'nrm'  how much of it survives as a normal. Fades much later; whatever
 *           is lost is handed to the fragment stage as slope *variance*, so
 *           the specular lobe widens exactly as the geometry flattens and the
 *           horizon never turns back into a mirror.
 */
export const WATER_WAVE_GLSL = /* glsl */ `
// wavelength (m), amplitude (m), direction offset (rad), steepness weight
const vec4 WAVE_0 = vec4(88.0, 0.300, -0.28, 1.00);
const vec4 WAVE_1 = vec4(49.0, 0.182,  0.47, 0.92);
const vec4 WAVE_2 = vec4(27.0, 0.098, -0.79, 0.80);
const vec4 WAVE_3 = vec4(14.5, 0.046,  1.12, 0.66);

struct WaveOut {
  vec3  disp;     // world displacement
  vec3  normal;   // analytic normal of the *shaded* surface
  float fold;     // 0 flat, ->1 where the crest pinches (whitecap seed)
  float crest;    // signed, normalised height: -1 trough, +1 crest
  float lostVar;  // slope variance dropped by the distance fades
};

/**
 * @param p        world XZ
 * @param wind     unit wind direction
 * @param t        seconds
 * @param fetch    0..1
 * @param energy   gust-modulated energy multiplier
 * @param amp      global amplitude trim
 * @param dist     view distance, metres
 * @param cell     lattice spacing, metres (0 = no geometric displacement)
 * @param peak     crest sharpening, 0..0.7
 */
WaveOut oceanWaves(
  vec2 p, vec2 wind, float t, float fetch, float energy,
  float amp, float dist, float cell, float peak
) {
  float f = clamp(fetch, 0.0, 1.0);
  float fs = f * f * (3.0 - 2.0 * f);
  // Fetch-limited growth: H ~ U sqrt(F), lambda ~ F^(2/3). Between the Charles
  // (about 1.2 km of fetch) and the outer harbour (25 km) that is a length
  // ratio near 0.13 and a *height* ratio near 0.22 — so the short-fetch sea is
  // shorter than it is flat, which is the same thing as saying a young wind
  // sea is steep. The 0.155 floor on length is right. The floor on height was
  // 0.030 and squared the shaping term on top of that, which put the basin at
  // four per cent: waves about a centimetre high on wavelengths of twenty
  // metres. That is a mirror, and it is why the Charles had no structure left
  // at any distance where the detail octaves had faded out — the long waves
  // are the only thing that survives to a kilometre.
  float lenS = mix(0.155, 1.0, fs);
  float ampS = mix(0.20, 1.0, fs) * amp * energy;

  vec4 tab[4];
  tab[0] = WAVE_0; tab[1] = WAVE_1; tab[2] = WAVE_2; tab[3] = WAVE_3;

  vec3 disp = vec3(0.0);
  float dXdx = 0.0, dXdz = 0.0, dZdx = 0.0, dZdz = 0.0;
  float dHdx = 0.0, dHdz = 0.0;
  float crest = 0.0, total = 1e-5, lost = 0.0;

  for (int i = 0; i < 4; i++) {
    vec4 wv = tab[i];
    float lambda = wv.x * lenS;
    float A = wv.y * ampS;
    if (A < 1e-5) continue;

    float k = 2.0 * PI / lambda;
    float omega = sqrt(WATER_G * k);
    vec2 d = wRot(wv.z) * wind;
    float phase = k * dot(d, p) - omega * t;
    float s = sin(phase), c = cos(phase);

    // Normals survive out to ~140 wavelengths; past that the component is
    // sub-pixel and is folded into roughness instead.
    float nrm = 1.0 - smoothstep(lambda * 45.0, lambda * 150.0, dist);
    // Geometry needs at least ~4 lattice samples per wave to mean anything.
    float geo = nrm * step(0.5, cell) * smoothstep(3.2 * cell, 5.4 * cell, lambda)
              * (1.0 - smoothstep(lambda * 34.0, lambda * 110.0, dist));

    float An = A * nrm;
    float Ag = A * geo;
    float Q = wv.w * min(0.78 / max(k * A * 4.0, 1e-4), 1.0);

    // Stokes-style peaking: crests narrow and rise, troughs broaden and fill.
    float peaked = s - peak * 0.5 * cos(2.0 * phase);
    disp.xz += Q * Ag * d * c;
    disp.y  += Ag * peaked;

    crest += An * s;
    total += A;

    float qak = Q * An * k * s;
    dXdx -= qak * d.x * d.x;
    dXdz -= qak * d.x * d.y;
    dZdx -= qak * d.y * d.x;
    dZdz -= qak * d.y * d.y;

    float ak = An * k;
    dHdx += ak * (c + peak * sin(2.0 * phase)) * d.x;
    dHdz += ak * (c + peak * sin(2.0 * phase)) * d.y;

    // What the fade threw away, expressed as rms slope so the fragment stage
    // can add it straight onto roughness.
    lost += (1.0 - nrm) * k * A * 0.707;
  }

  vec3 tx = vec3(1.0 + dXdx, dHdx, dZdx);
  vec3 tz = vec3(dXdz, dHdz, 1.0 + dZdz);

  WaveOut o;
  o.disp = disp;
  o.normal = normalize(cross(tz, tx));
  o.fold = clamp(1.0 - ((1.0 + dXdx) * (1.0 + dZdz) - dXdz * dZdx), 0.0, 1.0);
  o.crest = clamp(crest / total, -1.0, 1.0);
  o.lostVar = lost;
  return o;
}
`;

/**
 * What the city itself contributes to the water.
 *
 * There used to be a hand-authored analytic sky here — a zenith-to-horizon
 * gradient with a sun lobe bolted on — which the surface reflected and which
 * it also melted into at twenty kilometres. It had to be tuned deliberately
 * *dimmer* than the rendered dome so the harbour could never come out brighter
 * than the air above it, and that guaranteed the two would never match either.
 * The reflection now samples the atmosphere's own sky-view table through
 * 'ctx.aerial', which is the same table the dome is drawn from, so there is
 * nothing left to calibrate.
 *
 * Sodium and LED spill off Boston is not in that table, and after dark it is
 * the brightest thing the river can reflect, so it stays here.
 */
export const WATER_GLOW_GLSL = /* glsl */ `
uniform vec3 uCityGlow;
`;

/** Schlick Fresnel for an air/water interface, plus the GGX pieces. */
export const WATER_BRDF_GLSL = /* glsl */ `
// n_water = 1.333 -> F0 = ((1-n)/(1+n))^2 = 0.02037
const float WATER_F0 = 0.02037;

float fresnelWater(float NoV, float rough) {
  float f = pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);
  // Rough surfaces never reach a perfect mirror at grazing; clamping the
  // ceiling to (1 - rough) is the standard fix and stops a white rim.
  float ceilF = max(1.0 - rough * 1.15, WATER_F0);
  return WATER_F0 + (ceilF - WATER_F0) * f;
}

/**
 * Anisotropic Beckmann NDF — a *Gaussian* distribution of surface slopes.
 *
 * This is Cox & Munk's 1954 measurement of the sea surface, and it is not
 * interchangeable with GGX here. GGX carries a Cauchy-like tail: at eighty
 * degrees off the mirror direction it still returns about one per cent of its
 * peak, which is the response of a surface containing forty-degree facets. The
 * sea contains no such facets. With the sun *behind* the camera — the Charles
 * at five in the afternoon, the harbour at half past eight in the morning —
 * that tail was painting the whole surface with a warm off-specular wash, and
 * because 'sparkle' multiplies it by anything from a ninth to three times, the
 * wash arrived as a field of tan dashes: measured at 28 per cent of the
 * river's brightness in a view that should have had no glitter in it at all.
 *
 * A Gaussian falls off as exp(-s^2), so the same geometry returns exp(-961),
 * i.e. nothing, while the peak is untouched: at NoH = 1 both distributions are
 * exactly 1 / (PI * ax * ay), so a real glitter path keeps its brightness and
 * its wind-aligned stretch. 'ax' runs along the wind and is, to within a root
 * two, the rms slope of the facets the lobe is made of.
 */
float beckmannAniso(float NoH, float ToH, float BoH, float ax, float ay) {
  // 'c^4' in the denominator is the hazard here, and it is why square
  // kilometres of water can come out flat white.
  //
  // At grazing incidence NoH goes to zero. With the old floor of 1e-4 the
  // denominator reached 1e-16 * PI * ax * ay, which is about 2e-20 -- fine in
  // single precision, but below the smallest half-float subnormal, so on any
  // path that runs this at mediump it is simply zero. 'exp(-e)' has gone to
  // zero by then as well, because the slope term blows up as 1/c. So the
  // result is 0/0: a NaN. And a NaN that reaches the framebuffer renders
  // white, while 'min(spec, 7.0)' downstream is not a guard against it --
  // GLSL leaves min with a NaN argument implementation-defined, so one driver
  // clamps it and the next one hands the NaN straight through.
  //
  // Two changes, both exact where it matters. The floor on c is raised to a
  // value whose fourth power survives half precision, and the Gaussian is
  // short-circuited before the division once its exponent is past the point
  // where exp(-e) is zero to any precision. exp(-60) is 1e-26, so nothing
  // visible is being thrown away.
  float c = max(NoH, 0.05);
  // Half-vector slope, i.e. tan(theta_h) resolved onto the wind axes.
  float sx = ToH / c;
  float sy = BoH / c;
  float e = sx * sx / (ax * ax) + sy * sy / (ay * ay);
  if (!(e < 60.0)) return 0.0;
  float c2 = c * c;
  return exp(-e) / max(PI * ax * ay * c2 * c2, 1e-12);
}

float smithVis(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
`;
