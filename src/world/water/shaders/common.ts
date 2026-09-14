/**
 * GLSL shared by the water vertex and fragment stages.
 *
 * The wave table is a small, hand-tuned gravity-wave spectrum. Wavelengths are
 * real metres and the angular frequency comes from the deep-water dispersion
 * relation w = sqrt(g k), so the swell moves at the speed water actually moves
 * at — about 13 m/s for the 118 m component. Getting this wrong is the fastest
 * way to make an ocean look like a bedsheet.
 */
export const WATER_WAVES_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

// wavelength (m), amplitude (m), steepness, direction spread (rad)
const vec4 WAVE_A = vec4(118.0, 0.300, 0.78, -0.62);
const vec4 WAVE_B = vec4( 67.0, 0.168, 0.70,  0.41);
const vec4 WAVE_C = vec4( 37.0, 0.086, 0.62, -0.24);
const vec4 WAVE_D = vec4( 20.0, 0.038, 0.55,  0.88);

struct WaveOut {
  vec3 disp;   // world-space displacement
  vec3 normal; // analytic surface normal
  float fold;  // 0 = flat, ->1 where the crest pinches (whitecap seed)
};

/**
 * Sum-of-Gerstner surface.
 *
 * @param p      world XZ
 * @param wind   unit wind direction
 * @param amp    overall amplitude scale (fetch x shoaling)
 * @param t      seconds
 * @param count  1..4 active components
 */
WaveOut gerstner(vec2 p, vec2 wind, float amp, float t, int count) {
  vec3 disp = vec3(0.0);
  // Jacobian accumulators: d(displacement)/d(x,z)
  float dXdx = 0.0, dXdz = 0.0, dZdx = 0.0, dZdz = 0.0;
  float dHdx = 0.0, dHdz = 0.0;

  vec4 tab[4];
  tab[0] = WAVE_A; tab[1] = WAVE_B; tab[2] = WAVE_C; tab[3] = WAVE_D;

  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    vec4 w = tab[i];
    float ang = w.w;
    float cs = cos(ang), sn = sin(ang);
    vec2 d = vec2(wind.x * cs - wind.y * sn, wind.x * sn + wind.y * cs);

    float k = 2.0 * PI / w.x;
    float omega = sqrt(9.81 * k);
    float A = w.y * amp;
    float Q = w.z;

    float phase = k * dot(d, p) - omega * t;
    float s = sin(phase), c = cos(phase);

    disp.xz += Q * A * d * c;
    disp.y += A * s;

    float qak = Q * A * k * s;
    dXdx -= qak * d.x * d.x;
    dXdz -= qak * d.x * d.y;
    dZdx -= qak * d.y * d.x;
    dZdz -= qak * d.y * d.y;

    float ak = A * k * c;
    dHdx += ak * d.x;
    dHdz += ak * d.y;
  }

  vec3 tx = vec3(1.0 + dXdx, dHdx, dZdx);
  vec3 tz = vec3(dXdz, dHdz, 1.0 + dZdz);

  WaveOut o;
  o.disp = disp;
  o.normal = normalize(cross(tz, tx));
  o.fold = clamp(1.0 - ((1.0 + dXdx) * (1.0 + dZdz) - dXdz * dZdx), 0.0, 1.0);
  return o;
}
`;

/**
 * The sky the water sees when nothing better is available.
 *
 * Not a substitute for the Sky module's IBL — the priority in the shader is
 * planar reflection, then `ctx.envMap`, then this. But it is what keeps the
 * Charles from turning into a black hole before Sky finishes its probe, and
 * its horizon term is reused as the colour the water melts into at 20 km, so
 * there is never a hard line where the harbour stops.
 */
export const WATER_SKY_GLSL = /* glsl */ `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uCityGlow;

vec3 analyticSky(vec3 dir, vec3 sunDir) {
  float up = clamp(dir.y, -1.0, 1.0);
  float t = pow(1.0 - clamp(up, 0.0, 1.0), 4.5);
  vec3 col = mix(uSkyZenith, uSkyHorizon, t);
  // Rays that dip below the horizon (steep grazing on a chopped surface) get
  // the horizon band rather than a hole.
  col = mix(uSkyHorizon * 0.72, col, smoothstep(-0.10, 0.015, up));

  float cosT = max(dot(dir, sunDir), 0.0);
  col += uSkyGlow * (pow(cosT, 36.0) * 1.6 + pow(cosT, 5.0) * 0.20);
  // Sodium/LED spill off the city, strongest just above the horizon.
  col += uCityGlow * pow(1.0 - clamp(abs(up), 0.0, 1.0), 12.0);
  return col;
}
`;

/** Schlick Fresnel for an air/water interface, plus the GGX pieces. */
export const WATER_BRDF_GLSL = /* glsl */ `
// n_water = 1.333 -> F0 = ((1-n)/(1+n))^2 = 0.02037
const float WATER_F0 = 0.02037;

float fresnelWater(float NoV, float rough) {
  float f = pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);
  // Rough surfaces never reach a perfect mirror at grazing; clamping the
  // ceiling to (1 - rough) is the standard fix and stops a white rim.
  float ceilF = max(1.0 - rough, WATER_F0);
  return WATER_F0 + (ceilF - WATER_F0) * f;
}

// Anisotropic GGX NDF (Burley, via Filament). ax runs along the wind.
float ggxAniso(float NoH, float ToH, float BoH, float ax, float ay) {
  vec3 v = vec3(ay * ToH, ax * BoH, ax * ay * NoH);
  float v2 = dot(v, v);
  float w2 = (ax * ay) / max(v2, 1e-9);
  return ax * ay * w2 * w2 * (1.0 / PI);
}

float smithVis(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
`;
