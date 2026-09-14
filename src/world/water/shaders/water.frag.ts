/**
 * Water surface fragment stage.
 *
 * A dielectric surface over a turbid, shallow, strongly absorbing body. The
 * three things that make it read as Boston water rather than as a blue plane:
 * a correct Schlick Fresnel so grazing angles mirror the sky, Beer-Lambert
 * absorption tuned to an estuary rather than a reef, and a sun glitter path
 * built from many small GGX highlights on the ripple normals instead of one
 * blown-out blob.
 */
export const WATER_FRAG = /* glsl */ `
precision highp float;

#include <common>
#include <cube_uv_reflection_fragment>

uniform float uTime;
uniform float uSeaLevel;
uniform vec2  uWind;
uniform float uRippleGain;
uniform float uGlitter;
uniform float uFoamGain;

uniform sampler2D uFieldDist;
uniform sampler2D uFieldAux;
uniform vec2 uFieldOrigin;
uniform vec2 uFieldInvSize;

uniform sampler2D uWaves;
uniform sampler2D uNoise;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyAmbient;
uniform vec3  uCityGlow;
uniform float uEnvIntensity;

#if WATER_ENV == 1
uniform sampler2D envMap;
#endif

#if WATER_PLANAR == 1
uniform sampler2D uReflMap;
uniform mat4  uReflMatrix;
uniform float uReflStrength;
uniform float uReflMaxLod;
uniform vec2  uReflDistort;
#endif

// Extinction per metre, and the colour light scatters back as. The harbour is
// turbid green-brown; the impounded Charles is tannin-stained and murkier.
uniform vec3 uAbsorbA;
uniform vec3 uAbsorbB;
uniform vec3 uScatterA;
uniform vec3 uScatterB;
uniform vec3 uBedA;
uniform vec3 uBedB;
uniform vec3 uFoamColor;
uniform vec2 uHorizonFade;

varying vec3  vWorld;
varying vec3  vGN;
varying float vShore;
varying float vFetch;
varying float vViewDist;
varying float vCrest;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/** Tangent-space normal-map octave returned as an xz slope. */
vec2 slopeOf(vec2 uv, float gain) {
  vec3 n = texture2D(uWaves, uv).xyz * 2.0 - 1.0;
  return (n.xy / max(abs(n.z), 0.10)) * gain;
}

void main() {
  vec3 eye = cameraPosition - vWorld;
  float dist = length(eye);
  vec3 V = eye / max(dist, 1e-4);

  vec2 fuv = (vWorld.xz - uFieldOrigin) * uFieldInvSize;
  float shoreD = max(texture2D(uFieldDist, fuv).r, vShore);
  vec4 aux = texture2D(uFieldAux, fuv);
  float bed = aux.r * 160.0 - 60.0;
  float fetch = clamp(max(aux.g, vFetch), 0.0, 1.0);
  float murk = aux.b;

  // Water depth from the carved seabed. This is the one signal we can always
  // trust: the terrain module burns the water polygons into the heightfield,
  // so anywhere the bed sits below the surface there is genuinely water here.
  float depth = uSeaLevel - bed;

  // The surface meshes are cut to the water polygons already, so the body of
  // the river needs no masking; only the skirt — which spans the whole world
  // past the edge of the data — has to decide for itself what is ocean.
#ifdef WATER_SKIRT
  if (depth < 0.15) discard;
#endif

  // ----------------------------------------------------------- normals ----
  float rip = mix(0.55, 1.35, fetch);
  vec2 wind = normalize(uWind + vec2(1e-5));
  vec2 perp = vec2(-wind.y, wind.x);
  vec2 p = vWorld.xz;

  vec2 uv0 = (rot2(0.31) * p + wind * (uTime * 0.62)) / (2.6 * rip);
  vec2 uv1 = (rot2(-0.87) * p + (wind * 0.75 + perp * 0.35) * (uTime * 1.05)) / (9.5 * rip);
  vec2 uv2 = (rot2(1.94) * p + wind * (uTime * 1.75)) / (31.0 * rip);

  // Fine detail has to fade with distance or the specular boils into aliasing.
  float fine = 1.0 - smoothstep(140.0, 1500.0, vViewDist);
  float mid  = 1.0 - smoothstep(700.0, 5000.0, vViewDist);
  float shoal = smoothstep(0.0, 10.0, shoreD);
  float g = uRippleGain * mix(0.45, 1.0, fetch) * shoal;

  vec2 slope = vec2(0.0);
  slope += slopeOf(uv0, 0.30 * g * fine);
  slope += slopeOf(uv1, 0.22 * g * mid);
  slope += slopeOf(uv2, 0.16 * g);

  vec3 gn = normalize(vGN);
  slope += gn.xz / max(gn.y, 0.25);

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // The surface is drawn double-sided, so seen from beneath — under a bridge
  // deck, or with the camera below the waterline — the normal has to flip.
  if (!gl_FrontFacing) N = -N;
  float NoV = dot(N, V);
  if (NoV < 0.03) { N = normalize(N + V * (0.03 - NoV) * 1.6); NoV = 0.03; }

  // -------------------------------------------------------- reflection ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);   // never sample below the horizon into the seabed

  // Analytic sky, always available, and the fallback whenever the probe or the
  // planar pass misses.
  float up = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(up, 0.55));

#if WATER_ENV == 1
  // The probe carries the sun, the clouds and the city's own bounce, all of
  // which belong in the reflection — but it also averages in a lot of ground,
  // so it tints rather than replaces the analytic sky.
  float rough = clamp(0.02 + 0.30 * smoothstep(60.0, 4000.0, vViewDist), 0.0, 1.0);
  vec3 probe = textureCubeUV(envMap, R, rough).rgb;
  // Kept deliberately light: the probe refreshes only every few degrees of
  // solar motion, so leaning on it hard makes the water reflect a sky that
  // is minutes out of date — most visibly as a daylit river after sunset.
  sky = mix(sky, probe, 0.15);
#endif
  sky *= uEnvIntensity;

#if WATER_PLANAR == 1
  if (uReflStrength > 0.001) {
    vec4 rc = uReflMatrix * vec4(vWorld, 1.0);
    vec2 ruv = rc.xy / max(rc.w, 1e-4);
    // Distort by the surface slope so the mirror image ripples with the waves.
    ruv += slope * uReflDistort * (1.0 - smoothstep(0.0, 900.0, vViewDist));
    if (ruv.x > 0.001 && ruv.x < 0.999 && ruv.y > 0.001 && ruv.y < 0.999) {
      vec3 planar = texture2D(uReflMap, ruv).rgb;
      // Fade the mirror out at the screen edges and into the distance, where
      // it has no information to offer.
      float edge = min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y));
      float w = uReflStrength
              * smoothstep(0.0, 0.06, edge)
              * (1.0 - smoothstep(600.0, 2600.0, vViewDist));
      sky = mix(sky, planar, w);
    }
  }
#endif

  // ------------------------------------------------------------- body ----
  // Path length through the water for the refracted ray, clamped so a
  // grazing view does not integrate kilometres of absorption.
  float dclamp = max(depth, 0.05);
  float path = min(dclamp / max(NoV, 0.12), 26.0);

  vec3 absorb = mix(uAbsorbA, uAbsorbB, murk);
  vec3 scatter = mix(uScatterA, uScatterB, murk);
  vec3 bedCol = mix(uBedA, uBedB, murk);

  vec3 trans = exp(-absorb * path);
  // Light that reaches the bed and comes back, plus in-scattered light.
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);
  vec3 down = uSunColor * sunUp + uSkyAmbient;
  vec3 body = bedCol * down * trans + scatter * down * (1.0 - trans);

  // Very shallow water at the margin picks up the bank.
  body = mix(body, bedCol * down * 1.15, smoothstep(2.5, 0.0, dclamp));

  // ----------------------------------------------------------- fresnel ----
  // Schlick against IOR 1.333. Bias by roughness so distant water does not
  // turn into a perfect mirror and alias.
  float f0 = 0.02;
  float fres = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  fres = clamp(fres, 0.0, 0.96);

  vec3 color = mix(body, sky, fres);

  // ---------------------------------------------------------- specular ----
  // GGX against the ripple normals: many small highlights make the wind-
  // stretched glitter path, rather than one mirror blob.
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float NoL = max(dot(N, L), 0.0);
  float a = mix(0.020, 0.075, fetch);
  a = a * (1.0 + 2.5 * smoothstep(300.0, 4000.0, vViewDist)); // widen with distance
  float a2 = a * a;
  float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * d * d);
  float spec = D * NoL * fres * uGlitter;
  color += uSunColor * min(spec, 24.0) * smoothstep(-0.02, 0.10, uSunDir.y);

  // -------------------------------------------------------------- foam ----
  // Along the waterline, and on the steepest crests out in the fetch.
  // Shore wash is narrow; whitecaps only break on the steepest crests, and
  // only where there is enough fetch to build them. Boston's inner harbour is
  // not the open Atlantic — overdoing this reads as scum, not surf.
  float shoreFoam = (1.0 - smoothstep(0.0, 6.0, shoreD)) * smoothstep(-1.0, 0.8, shoreD);
  float crestFoam = smoothstep(0.86, 0.99, vCrest) * smoothstep(0.45, 1.0, fetch);
  // Two octaves so the wash breaks up instead of sitting in 30 m blobs.
  float churn = texture2D(uNoise, p * 0.11 + wind * uTime * 0.05).r
              * texture2D(uNoise, p * 0.023 - wind * uTime * 0.015).g;
  float foam = clamp((shoreFoam * 0.85 + crestFoam * 0.30) * churn * 2.2 * uFoamGain, 0.0, 1.0);
  foam *= 1.0 - smoothstep(900.0, 3000.0, vViewDist);
  // Foam is white *material*, not a light source: it has to be lit by the
  // same sun and sky as everything else, or it glows in the dark — and with
  // the night exposure lift a constant floor here clips the whole channel to
  // white.
  vec3 foamLit = uFoamColor * (down * 0.85 + uSkyAmbient * 0.6);
  color = mix(color, foamLit, foam);

  // At night the city is the brightest thing the water can reflect.
  color += uCityGlow * fres * 0.55 * (1.0 - smoothstep(0.0, 0.12, uSunDir.y));

  // Far water melts into the horizon haze instead of ending at a hard line.
  float haze = smoothstep(uHorizonFade.x, uHorizonFade.y, vViewDist);
  color = mix(color, uSkyHorizon * uEnvIntensity, haze * 0.85);

  // The sky module lifts exposure ~2x after dark so the dim sky still reads.
  // Water has no light of its own, so without matching that lift downward the
  // river ends up the brightest thing in a night frame. uEnvIntensity already
  // tracks day-to-night, so reuse it as the scale.
  color *= mix(0.055, 1.0, clamp(uEnvIntensity, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
