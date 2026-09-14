import {
  WATER_BRDF_GLSL,
  WATER_CONST_GLSL,
  WATER_SKY_GLSL,
  WATER_WIND_GLSL,
} from './common';

/**
 * Water surface fragment stage.
 *
 * The thing that makes water not look like a mirror is that its roughness is
 * never uniform. Wind arrives in cells; inside a cell the slope variance is
 * high and the sky is scattered into a matte sheet, between them the slicks
 * stay glassy and the reflection survives. Everything here hangs off that:
 *
 *   wind field  ->  ripple gain  ->  roughness  ->  reflection blur,
 *                                                   Fresnel ceiling,
 *                                                   glitter lobe width,
 *                                                   whitecap threshold
 *
 * Under that sits a turbid, shallow, strongly absorbing body — Beer-Lambert
 * against an estuary rather than a reef — and a shoreline whose waterline
 * actually moves and piles foam up on whichever bank the wind is pushing at.
 */
export const WATER_FRAG = /* glsl */ `
precision highp float;

#include <common>
#include <cube_uv_reflection_fragment>

uniform float uTime;
uniform float uSeaLevel;
uniform float uRippleGain;
uniform float uGlitter;
uniform float uFoamGain;
uniform float uDetail;     // 1 = full ripple stack, 0 = cheapest

uniform sampler2D uFieldDist;
uniform sampler2D uFieldAux;
uniform vec2 uFieldOrigin;
uniform vec2 uFieldInvSize;
uniform float uFieldTexel;

uniform sampler2D uWaves;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyAmbient;
uniform float uEnvIntensity;
uniform float uNight;

#if WATER_ENV == 1
uniform sampler2D envMap;
#endif

#if WATER_PLANAR == 1
uniform sampler2D uReflMap;
uniform mat4  uReflMatrix;
uniform float uReflStrength;
uniform float uReflMaxLod;
uniform float uReflBlur;
uniform float uReflSmear;
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
uniform vec3 uSiltA;
uniform vec3 uSiltB;
uniform vec3 uFoamColor;
uniform vec2 uHorizonFade;

varying vec3  vWorld;
varying vec3  vGN;
varying float vShore;
varying float vFetch;
varying float vViewDist;
varying float vCrest;
varying float vFold;
varying float vLostVar;

${WATER_CONST_GLSL}
${WATER_WIND_GLSL}
${WATER_SKY_GLSL}
${WATER_BRDF_GLSL}

/** One detail-normal octave, returned as an xz slope plus its breakup mask. */
vec3 rippleOctave(vec2 p, float tile, float speed, vec2 drift, float rot, float gain) {
  vec2 uv = (wRot(rot) * p + drift * (uTime * speed)) / tile;
  vec4 t = texture2D(uWaves, uv);
  vec3 n = t.xyz * 2.0 - 1.0;
  return vec3((n.xy / max(abs(n.z), 0.10)) * gain, t.w);
}

void main() {
  vec3 eye = cameraPosition - vWorld;
  float dist = length(eye);
  vec3 V = eye / max(dist, 1e-4);

  vec2 fuv = (vWorld.xz - uFieldOrigin) * uFieldInvSize;
  float sdf = textureLod(uFieldDist, fuv, 0.0).r;
  float shoreD = max(sdf, vShore);
  vec4 aux = textureLod(uFieldAux, fuv, 0.0);
  float bed = aux.r * 160.0 - 60.0;
  float fetch = clamp(max(aux.g, vFetch), 0.0, 1.0);
  float murk = aux.b;

  // Water depth from the carved seabed. This is the one signal we can always
  // trust: the terrain module burns the water polygons into the heightfield,
  // so anywhere the bed sits below the surface there is genuinely water here.
  float geoDepth = uSeaLevel - bed;

  // The surface meshes are cut to the water polygons already, so the body of
  // the river needs no masking; only the skirt — which spans the whole world
  // past the edge of the data — has to decide for itself what is ocean.
#ifdef WATER_SKIRT
  if (geoDepth < 0.15) discard;
#endif

  // There is no bathymetry for the harbour — 3DEP stops at the waterline — so
  // the carved bed is flat wherever the tide reaches. Backstop it with a
  // shore-distance ramp, which is how depth actually behaves: a steep drop off
  // the bank, then a plateau at the channel. Without this every body is
  // uniformly shallow and the single strongest depth cue disappears.
  float dmax = mix(2.6, 14.0, fetch);
  float ramp = dmax * (1.0 - exp(-max(shoreD, 0.0) / mix(55.0, 190.0, fetch)));
  float depth = max(geoDepth, ramp);

  vec2 p = vWorld.xz;
  vec2 wind = normalize(uWind + vec2(1e-5));
  vec2 perp = vec2(-wind.y, wind.x);

  // ------------------------------------------------------------- wind ----
  vec3 wf = windField(p, uTime);
  float gust = wf.x;
  float streak = wf.y;
  // Streaks only exist inside a gust; in the slicks the surface is glass.
  float windiness = clamp(gust * mix(0.55, 1.25, streak), 0.0, 1.0);

  // ---------------------------------------------------------- normals ----
  // Short fetch means short, fine chop; long fetch means a coarser, longer
  // ripple riding on the swell. This one number is most of why the Charles
  // and the harbour cannot be mistaken for each other.
  float rip = mix(0.36, 1.45, fetch);
  float shoal = smoothstep(0.0, 8.0, shoreD);
  // Real water rarely exceeds ~0.2 rms slope even in a fresh breeze; push
  // past that and every pixel finds a grazing angle somewhere, the Fresnel
  // saturates and the whole surface turns into flat sky-coloured paint.
  float windGain = mix(0.26, 1.15, windiness) * mix(0.62, 1.0, fetch) * shoal;
  float gain = uRippleGain * windGain;

  float t0 = 3.2 * rip, t1 = 11.5 * rip, t2 = 41.0 * rip;
  // Fade each octave out once its features are a couple of pixels wide, and
  // remember how much slope was lost so it can be added back as roughness.
  //
  // Distance alone is the wrong measure: at 20 degrees above a water plane one
  // pixel covers three times the ground it would head-on, so the texture is
  // three times as minified and the leftover slope turns into a lattice of
  // sparkling dots. Stretch the fade by the grazing factor of the *macro*
  // normal and the speckle goes away without flattening the near field.
  vec3 gn0 = normalize(vGN);
  float graze0 = 1.0 / clamp(abs(dot(gn0, V)), 0.055, 1.0);
  float eDist = vViewDist * min(graze0, 9.0);
  float f0 = 1.0 - smoothstep(t0 * 55.0, t0 * 190.0, eDist);
  float f1 = 1.0 - smoothstep(t1 * 55.0, t1 * 190.0, eDist);
  float f2 = 1.0 - smoothstep(t2 * 55.0, t2 * 190.0, eDist);
  f0 *= uDetail;

  const float G0 = 0.170, G1 = 0.125, G2 = 0.085;
  vec2 slope = vec2(0.0);
  vec3 o0 = rippleOctave(p, t0, 1.35 * sqrt(rip), wind, 0.31, G0 * gain * f0);
  vec3 o1 = rippleOctave(p, t1, 2.45 * sqrt(rip), wind * 0.78 + perp * 0.30, -0.87, G1 * gain * f1);
  vec3 o2 = rippleOctave(p, t2, 4.10 * sqrt(rip), wind, 1.94, G2 * gain * f2);
  slope += o0.xy + o1.xy + o2.xy;

  slope += gn0.xz / max(gn0.y, 0.25);

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // The surface is drawn double-sided *because the OSM ring winding is not
  // consistent*, so gl_FrontFacing is meaningless here — half the chunks
  // report back-facing and flipping on it points the normal at the seabed,
  // which pins NoV at the clamp and drives Fresnel to ~0.7 over the whole
  // harbour. That single line was most of why this read as a mirror. Decide
  // the side from geometry instead: above the waterline the normal is up.
  if (cameraPosition.y < vWorld.y) N = -N;
  float NoV = dot(N, V);
  if (NoV < 0.02) { N = normalize(N + V * (0.02 - NoV) * 1.6); NoV = 0.02; }

  // -------------------------------------------------------- roughness ----
  // Everything the surface lost to filtering comes back here. A glassy slick
  // sits near 0.03 and still mirrors; a gust cell climbs past 0.25 and the
  // reflection inside it dissolves into scattered sky. That contrast is the
  // whole difference between water and a sheet of glass.
  float lostRipple = ((1.0 - f0) * G0 + (1.0 - f1) * G1 + (1.0 - f2) * G2) * 0.72 * windGain;
  float rough = mix(0.020, 0.048, fetch)
              + 0.26 * windiness * mix(0.55, 1.0, fetch)
              + lostRipple
              + clamp(vLostVar, 0.0, 0.15);
  rough = clamp(rough, 0.016, 0.55);

  // -------------------------------------------------------- reflection ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);   // never sample below the horizon into the seabed

  vec3 sky = analyticSky(R, normalize(uSunDir), rough);

#if WATER_ENV == 1
  // The probe carries the sun, the clouds and the city's own bounce, all of
  // which belong in the reflection — but it also averages in a lot of ground,
  // so it tints rather than replaces the analytic sky.
  vec3 probe = textureCubeUV(envMap, R, clamp(rough * 1.6, 0.02, 1.0)).rgb;
  sky = mix(sky, probe, 0.50);
#endif
  sky *= uEnvIntensity;

#if WATER_PLANAR == 1
  if (uReflStrength > 0.001) {
    vec4 rc = uReflMatrix * vec4(vWorld, 1.0);
    vec2 ruv0 = rc.xy / max(rc.w, 1e-4);
    // Distort by the surface slope so the mirror image ripples with the
    // waves, and stretch that distortion at grazing angles the way a real
    // reflection smears when you look along the surface.
    float graze = 1.0 + 2.6 * (1.0 - NoV);
    vec2 ruv = ruv0 + slope * uReflDistort * graze
             * (1.0 - smoothstep(200.0, 2600.0, vViewDist));
    ruv = clamp(ruv, vec2(0.0015), vec2(0.9985));

    // Rough water blurs what it reflects, and stretches it vertically. Three
    // taps up the v axis is enough to turn a crisp window into the vertical
    // streak of light you actually see on a harbour at night.
    float lod = clamp(rough * uReflBlur, 0.0, uReflMaxLod);
    float smear = uReflSmear * (0.002 + rough * 0.085);
    vec4 r0 = textureLod(uReflMap, ruv, lod);
    vec4 r1 = textureLod(uReflMap, clamp(ruv + vec2(0.0, smear), vec2(0.0015), vec2(0.9985)), lod);
    vec4 r2 = textureLod(uReflMap, clamp(ruv - vec2(0.0, smear * 0.7), vec2(0.0015), vec2(0.9985)), lod);
    vec4 refl = r0 * 0.46 + r1 * 0.31 + r2 * 0.23;

    // The pass renders geometry only — no sky dome — so alpha is coverage and
    // the colour is already premultiplied by it. Everything the mirror does
    // not know about stays the analytic sky, which means no hard rectangle
    // where the reflection buffer runs out.
    float w = uReflStrength * (1.0 - smoothstep(3000.0, 7000.0, vViewDist));
    float cov = clamp(refl.a, 0.0, 1.0) * w;
    sky = sky * (1.0 - cov) + refl.rgb * w;
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
  vec3 siltCol = mix(uSiltA, uSiltB, murk);

  vec3 trans = exp(-absorb * path);
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);
  vec3 down = uSunColor * sunUp + uSkyAmbient;
  vec3 body = bedCol * down * trans + scatter * down * (1.0 - trans);

  // Depth reads as colour, not just as darkness: the channel is deep and
  // green, the margins are a shallow, silty, distinctly browner band. On the
  // Charles that band is tannin; in the harbour it is mud stirred by the tide.
  // The onset has to sit below the bed the terrain actually carves: the
  // Charles bottoms out near 3.6 m, so a 2.6 m threshold made the entire
  // basin silt and it read as pale tan from the air instead of green.
  float shallow = smoothstep(mix(1.1, 4.0, fetch), 0.3, dclamp);
  body = mix(body, siltCol * down, shallow * 0.72);
  // A slow silt plume so the shallows are not a clean contour line.
  float plume = texture2D(uWaves, p * 0.0018 + wind * uTime * 0.0012).w;
  body = mix(body, siltCol * down * 1.12, smoothstep(0.55, 1.0, shallow) * plume * 0.45);

  // ----------------------------------------------------------- fresnel ----
  float fres = fresnelWater(NoV, rough);

  vec3 color = mix(body, sky, fres);

  // ---------------------------------------------------------- specular ----
  // Anisotropic GGX on the wind axis: a low sun stretches into a long path of
  // separate highlights rather than one blown-out blob.
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float NoL = max(dot(N, L), 0.0);
  vec3 T = normalize(vec3(wind.x, 0.0, wind.y) - N * dot(N, vec3(wind.x, 0.0, wind.y)));
  vec3 Bt = cross(N, T);
  float aniso = clamp(0.30 + 0.55 * windiness, 0.0, 0.88);
  float ga = clamp(rough * 0.95, 0.007, 0.45);
  float ax = ga * (1.0 + aniso);
  float ay = ga * (1.0 - 0.72 * aniso);
  float D = ggxAniso(NoH, dot(T, H), dot(Bt, H), ax, ay);
  float Vs = smithVis(NoV, NoL, ga);
  // Near the camera the individual facets are resolved by the ripple map; the
  // breakup channel keeps them from merging into a continuous sheet.
  float sparkle = mix(1.0, 0.62 + 0.9 * o0.z, clamp(f0, 0.0, 1.0) * 0.8);
  float spec = D * Vs * NoL * fres * uGlitter * sparkle;
  // A glitter path is many small highlights, not a sheet. Clamped at 46 the
  // lobe saturated whole square kilometres of the Charles into flat white
  // under a low sun; 7 keeps the sparkle and loses the sheet.
  color += uSunColor * min(spec, 7.0) * smoothstep(-0.04, 0.09, uSunDir.y);

  // -------------------------------------------------------------- foam ----
  float foam = 0.0;
#ifndef WATER_SKIRT
  if (shoreD < 90.0) {
    // Shore normal straight off the distance field: it points from the bank
    // out into the water, so the dot with the wind says which bank the foam
    // is being pushed onto.
    vec2 st = uFieldTexel * uFieldInvSize;
    float dX = textureLod(uFieldDist, fuv + vec2(st.x, 0.0), 0.0).r - sdf;
    float dZ = textureLod(uFieldDist, fuv + vec2(0.0, st.y), 0.0).r - sdf;
    vec2 sn = normalize(vec2(dX, dZ) + vec2(1e-5));
    float windward = clamp(-dot(wind, sn), 0.0, 1.0);
    windward = 0.22 + 0.78 * windward * windward;

    // The waterline breathes. Phase varies along the bank so the whole
    // shoreline does not pulse in unison.
    float ph = texture2D(uWaves, p * 0.0042).w;
    float swash = 0.5 + 0.5 * sin(uTime * 0.72 + ph * 11.0 + dot(p, perp) * 0.012);
    float band = mix(1.8, 7.0, windward) * mix(0.5, 1.3, fetch);
    float edge = shoreD - swash * band * 0.55;

    // Two octaves of churn, one of them running up the beach.
    float ch1 = texture2D(uWaves, p * 0.055 - sn * (uTime * 0.16) + wind * 0.02).w;
    float ch2 = texture2D(uWaves, p * 0.014 + wind * (uTime * 0.03)).w;
    float churn = clamp((ch1 * 0.65 + ch2 * 0.55) * 1.5, 0.0, 1.4);

    float wash = (1.0 - smoothstep(0.0, band, edge)) * smoothstep(-2.2, 0.35, edge);
    float lace = (1.0 - smoothstep(band * 0.8, band * 3.4, edge)) * smoothstep(-1.0, 1.5, edge);
    foam = (wash * 0.95 + lace * 0.30 * churn) * churn * windward * uFoamGain;

    // Just inside the waterline the sheet is thin and glossy over wet sand.
    float wet = (1.0 - smoothstep(0.0, 2.6, edge)) * 0.55;
    color = mix(color, siltCol * down * 1.9, wet * (1.0 - foam));
  }
#endif

  // Whitecaps are *rare*. The inner harbour does not break below about
  // 7 m/s, and even then it is a scatter of streaks on the steepest crests,
  // never a field of white — that mistake is what makes game water look like
  // detergent. Gate on wind speed, fetch, an active gust and the top of the
  // crest distribution, then punch holes in it with noise.
  float capSeed = texture2D(uWaves, p * 0.028 + wind * (uTime * 0.09)).w;
  float caps = smoothstep(0.80, 0.98, vCrest)
             * smoothstep(0.55, 1.0, fetch)
             * smoothstep(0.55, 0.95, gust)
             * smoothstep(6.4, 10.5, uWindSpeed)
             * smoothstep(0.42, 0.78, capSeed);
  // Breaking crests add to it, but only genuinely steep ones: with the
  // threshold this low and the gain above 1, the fold term saturated foam
  // across the whole harbour and the water rendered as a white sheet.
  caps += clamp(vFold - 0.62, 0.0, 1.0) * 0.30 * smoothstep(0.72, 1.0, fetch);
  foam = clamp(foam + caps * 0.26 * uFoamGain, 0.0, 1.0);
  foam *= 1.0 - smoothstep(1400.0, 4200.0, vViewDist);

  // Foam is white *material*, not a light source: it has to be lit by the
  // same sun and sky as everything else, or it glows in the dark — and with
  // the night exposure lift a constant floor here clips the whole channel to
  // white.
  vec3 foamLit = uFoamColor * (down * 0.80 + uSkyAmbient * 0.55);
  color = mix(color, foamLit, foam);

  // At night the city is the brightest thing the water can reflect.
  color += uCityGlow * fres * 0.55 * uNight;

  // Far water melts into the horizon haze instead of ending at a hard line.
  // Far water has to become the horizon outright, not 85% of it: at grazing
  // incidence the surface mirrors the sky almost totally, and letting even a
  // sliver of that through left a hard white band across every distant view.
  float haze = smoothstep(uHorizonFade.x, uHorizonFade.y, vViewDist);
  // Far water has to become the horizon outright, not 85% of it: at grazing
  // incidence the surface mirrors the sky almost totally, and letting even a
  // sliver of that through left a hard white band across every distant view.
  color = mix(color, uSkyHorizon * uEnvIntensity * 0.95, haze);

  // The sky module lifts exposure ~2x after dark so the dim sky still reads.
  // Water has no light of its own, so without matching that lift downward the
  // river ends up the brightest thing in a night frame. uEnvIntensity already
  // tracks day-to-night, so reuse it as the scale.
  color *= mix(0.055, 1.0, clamp(uEnvIntensity, 0.0, 1.0));

  // Bound the HDR output. At a grazing angle the surface mirrors the sky
  // almost totally, and a bright dusk horizon pushed that past anything the
  // tonemapper could roll off — the harbour clipped to a hard white band and
  // dragged the auto-exposure down with it. 12 still reads as dazzling.
  color = min(color, vec3(12.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
