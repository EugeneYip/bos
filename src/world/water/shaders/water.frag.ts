import { WATER_BRDF_GLSL, WATER_SKY_GLSL } from './common';

/**
 * Water surface shading.
 *
 * The pipeline, in order of how much each part matters to the image:
 *
 *  1. **Fresnel.** Schlick at n = 1.333 (F0 = 0.0204). Almost everything the
 *     water looks like at a city viewing angle is the sky and the buildings
 *     arriving through this term; the body colour only wins when you look
 *     steeply down.
 *  2. **Reflection.** Planar mirror pass where it is valid, falling back to
 *     `ctx.envMap` and then to an analytic sky. Perturbed by the surface slope
 *     with the vertical component amplified by 1/NoV, which is what turns a
 *     point of light into the long vertical streak you get across the Charles
 *     at night.
 *  3. **Absorption.** Beer–Lambert through twice the water depth against a
 *     silt bed. Boston Harbor's extinction is tuned so green survives longest
 *     and blue dies first — turbid green-brown. The Charles is murkier still
 *     and goes olive. There is no path through this code that produces
 *     Caribbean blue.
 *  4. **Foam and the waterline.** A wide, noise-broken alpha ramp off the
 *     shore-distance field plus foam that washes in and out with it, and
 *     Gerstner-fold whitecaps out where the fetch is long.
 *  5. **Glitter.** Anisotropic GGX aligned to the wind, with a roughness floor
 *     that rises with distance (otherwise the sun path aliases into a boiling
 *     mess) and a stochastic sparkle mask that breaks the highlight into many
 *     small ones instead of a single blown-out blob.
 */
export const WATER_FRAG = /* glsl */ `
precision highp float;

#ifndef PI
#define PI 3.141592653589793
#endif

varying vec3  vWorld;
varying vec3  vGN;
varying float vFold;
varying float vShore;
varying float vFetch;
varying float vViewDist;

uniform float uTime;
uniform vec2  uWind;
uniform vec3  uSunDir;
uniform vec3  uSunColor;

uniform sampler2D uFieldDist;
uniform sampler2D uFieldAux;
uniform vec2  uFieldOrigin;
uniform vec2  uFieldInvSize;

uniform sampler2D uWaves;
uniform sampler2D uNoise;

uniform vec3  uAbsorbA;
uniform vec3  uAbsorbB;
uniform vec3  uScatterA;
uniform vec3  uScatterB;
uniform vec3  uBedA;
uniform vec3  uBedB;
uniform vec3  uFoamColor;
uniform vec3  uSkyAmbient;
uniform float uEnvIntensity;
uniform float uRippleGain;
uniform float uFoamGain;
uniform float uGlitter;
uniform vec2  uHorizonFade;

#ifdef WATER_PLANAR
uniform sampler2D uReflMap;
uniform mat4  uReflMatrix;
uniform float uReflStrength;
uniform float uReflMaxLod;
uniform vec2  uReflDistort;
#endif

#if WATER_ENV > 0
uniform sampler2D envMap;
#endif

${WATER_SKY_GLSL}
${WATER_BRDF_GLSL}

#if WATER_ENV == 1
#include <cube_uv_reflection_fragment>
#endif

#include <fog_pars_fragment>
#include <dithering_pars_fragment>

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/** Tangent-space normal -> world XZ slope, so layers can be summed linearly. */
vec2 slopeOf(vec2 uv, float gain) {
  vec3 n = texture2D(uWaves, uv).xyz * 2.0 - 1.0;
  return (n.xy / max(abs(n.z), 0.10)) * gain;
}

vec3 sampleEnv(vec3 dir, float rough) {
#if WATER_ENV == 1
  return textureCubeUV(envMap, dir, rough).rgb * uEnvIntensity;
#elif WATER_ENV == 2
  vec3 d = normalize(dir);
  vec2 uv = vec2(atan(d.z, d.x) * (0.5 / PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) * (1.0 / PI));
  return textureLod(envMap, uv, rough * 7.0).rgb * uEnvIntensity;
#else
  return analyticSky(dir, uSunDir);
#endif
}

void main() {
  vec3 eye = cameraPosition - vWorld;
  float dist = length(eye);
  vec3 V = eye / max(dist, 1e-4);

  // ------------------------------------------------------- world field ----
  vec2 fuv = (vWorld.xz - uFieldOrigin) * uFieldInvSize;
  float shoreD = texture2D(uFieldDist, fuv).r;
  vec4 aux = texture2D(uFieldAux, fuv);
  float bed = aux.r * 160.0 - 60.0;
  float fetch = max(aux.g, vFetch * 0.5);
  float murk = aux.b;

  // Wide, field-error-tolerant waterline. The alpha ramp is what lets the
  // bank show through instead of stopping at a razor edge, and it is also the
  // only antialiasing the coastline gets at a distance.
  float alpha = smoothstep(-3.0, 7.0, shoreD);

#ifdef WATER_SKIRT
  // Past the edge of the dataset the shoreline field is clamp-extended, which
  // continues Boston's coast outward: harbour to the east, dry land to the
  // west. Anything the field calls land is simply not ocean.
  if (alpha < 0.004) discard;
#endif

  // --------------------------------------------------------- geometry ----
  float rip = mix(0.52, 1.30, fetch);
  vec2 wind = uWind;
  vec2 perp = vec2(-wind.y, wind.x);

  vec2 p = vWorld.xz;
  vec2 uv0 = (rot2(0.31) * p + wind * (uTime * 0.62)) / (2.7 * rip);
  vec2 uv1 = (rot2(-0.87) * p + (wind * 0.75 + perp * 0.35) * (uTime * 1.05)) / (9.5 * rip);
  vec2 uv2 = (rot2(1.94) * p + wind * (uTime * 1.75)) / (33.0 * rip);

  // Fine ripple detail has to die off with distance or the specular boils.
  float fine = 1.0 - smoothstep(180.0, 1700.0, vViewDist);
  float mid = 1.0 - smoothstep(900.0, 6000.0, vViewDist);

  float shoal = smoothstep(0.0, 12.0, shoreD);
  float g = uRippleGain * mix(0.30, 1.0, fetch) * shoal;

  vec2 slope = vec2(0.0);
  slope += slopeOf(uv0, 0.55 * g * fine);
  slope += slopeOf(uv1, 0.85 * g * mid);
  slope += slopeOf(uv2, 1.00 * g);

  // Gerstner normal folded in as a slope so the sum stays linear.
  vec3 gn = normalize(vGN);
  slope += gn.xz / max(gn.y, 0.2) * -1.0;

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  if (!gl_FrontFacing) N = -N;
  // Never let a crest turn the normal away from the eye; that is what makes
  // black speckles at grazing angles.
  float NoV = dot(N, V);
  if (NoV < 0.02) {
    N = normalize(N + V * (0.02 - NoV) * 1.6);
    NoV = max(dot(N, V), 0.02);
  }

  // ------------------------------------------------------------ depth ----
  // Refracted lookup: the bed wobbles under the surface in shallow water.
  vec2 rfuv = (vWorld.xz + N.xz * 1.4 - uFieldOrigin) * uFieldInvSize;
  float shoreR = texture2D(uFieldDist, rfuv).r;
  float terr = max(vWorld.y - bed, 0.0);
  // Before the terrain module carves the harbour floor this falls back to a
  // fixed 4.5 m, which still gives a correct-looking shallow band.
  float deep = max(terr, 4.5);
  float depth = deep * smoothstep(0.0, 24.0, shoreR);

  // ------------------------------------------------------------- foam ----
  float breakup = texture2D(uWaves, p * 0.055 + wind * (uTime * 0.02)).a;
  float breakup2 = texture2D(uNoise, p * 0.021 - wind * (uTime * 0.013)).b;
  float band = mix(5.0, 17.0, fetch);
  float wash = sin(shoreD * 0.42 - uTime * 0.75 + breakup2 * 5.5) * 0.5 + 0.5;
  float shoreFoam = (1.0 - smoothstep(0.0, band, shoreD)) * (0.30 + 0.70 * wash);
  shoreFoam *= smoothstep(0.30, 0.78, breakup * 0.65 + breakup2 * 0.5);
  shoreFoam *= smoothstep(-2.0, 2.5, shoreD);

  float caps = smoothstep(0.42, 0.95, vFold) * fetch * smoothstep(0.38, 0.80, breakup);
  float foam = clamp((shoreFoam + caps) * uFoamGain, 0.0, 1.0);

  // -------------------------------------------------------- roughness ----
  // Cat's-paws: without large-scale roughness variation water reads as vinyl.
  float gust = texture2D(uNoise, p * 0.0013 + wind * (uTime * 0.004)).a;
  float rough = mix(0.030, 0.105, fetch) * mix(0.70, 1.55, gust);
  rough += 0.085 * (1.0 - fine);           // detail lost to mips becomes blur
  rough += 0.055 * (1.0 - mid);
  rough = clamp(rough + foam * 0.55, 0.022, 0.9);

  // ------------------------------------------------------- reflection ----
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.004);
  vec3 refl = sampleEnv(R, rough);
  vec3 horizon = analyticSky(vec3(V.x, 0.02, V.z), uSunDir);

#ifdef WATER_PLANAR
  vec4 pr = uReflMatrix * vec4(vWorld, 1.0);
  if (pr.w > 0.0) {
    vec2 ruv = pr.xy / pr.w;
    float grazing = 1.0 / max(NoV, 0.09);
    vec2 off = vec2(slope.x * uReflDistort.x, slope.y * uReflDistort.y * grazing);
    off *= 1.0 / (1.0 + dist * 0.0011);
    ruv += off;
    vec2 e = smoothstep(vec2(0.0), vec2(0.055), ruv) * smoothstep(vec2(1.0), vec2(0.945), ruv);
    float valid = e.x * e.y * uReflStrength;
    if (valid > 0.001) {
      float lod = clamp(log2(1.0 + rough * 34.0), 0.0, uReflMaxLod);
      vec3 planar = textureLod(uReflMap, clamp(ruv, vec2(0.0015), vec2(0.9985)), lod).rgb;
      refl = mix(refl, planar, valid);
    }
  }
#endif

  float F = fresnelWater(NoV, rough);

  // ------------------------------------------------------------- body ----
  vec3 sunIrr = uSunColor * max(uSunDir.y, 0.0);
  vec3 incoming = uSkyAmbient * 0.95 + sunIrr * 0.42;
  vec3 sigma = mix(uAbsorbA, uAbsorbB, murk);
  vec3 T = exp(-sigma * (depth * 2.0 + 0.08));
  vec3 bedCol = mix(uBedA, uBedB, murk) * incoming;
  vec3 scatter = mix(uScatterA, uScatterB, murk) * incoming;
  vec3 body = bedCol * T + scatter * (1.0 - T);

  // --------------------------------------------------------- specular ----
  vec3 H = normalize(uSunDir + V);
  float NoL = max(dot(N, uSunDir), 0.0);
  float NoH = max(dot(N, H), 0.0);
  vec3 wdir = normalize(vec3(wind.x, 0.0, wind.y) - N * dot(N, vec3(wind.x, 0.0, wind.y)));
  vec3 bdir = cross(N, wdir);
  float aniso = 0.34 + 0.42 * fetch;
  float a = rough * rough;
  // Distance floor: a sub-pixel specular lobe aliases, a widened one twinkles.
  float floorA = 0.0026 + 0.010 * smoothstep(300.0, 5000.0, vViewDist);
  float ax = max(a * (1.0 + aniso), floorA);
  float ay = max(a * (1.0 - aniso * 0.62), floorA * 0.7);
  float D = ggxAniso(NoH, dot(wdir, H), dot(bdir, H), ax, ay);
  float Vis = smithVis(NoV, NoL, (ax + ay) * 0.5);
  float Fs = fresnelWater(max(dot(H, V), 0.0), rough);
  vec3 spec = uSunColor * (D * Vis * Fs * NoL);

  // Break the sun path into individual glints rather than one hot blob.
  float s1 = texture2D(uNoise, p * 0.46 + wind * (uTime * 0.16)).r;
  float s2 = texture2D(uNoise, p * 0.137 - perp * (uTime * 0.09)).g;
  float sparkle = smoothstep(0.20, 0.66, s1 * 0.6 + s2 * 0.6);
  spec *= mix(1.0, mix(0.35, 2.9, sparkle), uGlitter * fine);
  spec = min(spec, vec3(120.0));
  spec *= 1.0 - foam * 0.8;

  // ------------------------------------------------------------ merge ----
  vec3 col = mix(body, refl, F) + spec;

  vec3 foamLit = uFoamColor * (uSkyAmbient * 0.9 + sunIrr * 0.6);
  col = mix(col, foamLit, foam * 0.92);

  // Melt into the horizon so the ocean never ends on a line.
  col = mix(col, horizon, smoothstep(uHorizonFade.x, uHorizonFade.y, dist) * 0.92);

  gl_FragColor = vec4(col, clamp(max(alpha, foam * 0.85), 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <dithering_fragment>
}
`;
