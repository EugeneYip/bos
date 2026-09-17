import {
  WATER_BRDF_GLSL,
  WATER_CONST_GLSL,
  WATER_GLOW_GLSL,
  WATER_WIND_GLSL,
} from './common';
import { WAVE_SLOPE_RANGE } from '../textures';

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
 *
 * The detail normal is a four-octave *cascade*, not a sum: each octave is
 * sampled at a position pushed back along the slope of everything coarser than
 * it, and its amplitude is modulated by the coarser height. That is the two
 * things a plain sum of octaves cannot give you — crests that narrow while
 * troughs broaden, and fine ripple that piles onto the crests and is smoothed
 * out of the troughs — and between them they are most of the difference
 * between chop and a bumpy carpet.
 */
export const waterFrag = (aerialGlsl: string): string => /* glsl */ `
precision highp float;

#include <common>
#include <cube_uv_reflection_fragment>

uniform float uTime;
uniform float uSeaLevel;
uniform float uRippleGain;
uniform float uGlitter;
uniform float uFoamGain;
uniform float uChop;       // detail-cascade crest sharpening
uniform float uDetail;     // 1 = full ripple stack, 0 = cheapest

uniform sampler2D uFieldDist;
uniform sampler2D uFieldAux;
uniform vec2 uFieldOrigin;
uniform vec2 uFieldInvSize;
uniform float uFieldTexel;

#ifdef WATER_FAR_BATHY
uniform sampler2D uFarBathy;
uniform vec2 uFarOrigin;
uniform vec2 uFarInvSize;
uniform float uFarMaxDepth;
#endif

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

#ifdef WATER_DEBUG
// QA only, compiled in behind '?wdbg' (see Water.ts). Per-term gains so a
// single page session can ablate one contribution at a time -- the only way
// to attribute brightness, since auto-exposure moves under any rebuild and
// makes absolute luma incomparable between builds.
//   uDbg  = (body, reflection, specular, foam)
//   uDbg2 = (city glow, aerial perspective, view mode, spare)
// View modes: 1 fetch/murk/shallow, 2 depth/20, 3 roughness, 4 fresnel.
uniform vec4 uDbg;
uniform vec4 uDbg2;
#endif

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
${WATER_GLOW_GLSL}
${WATER_BRDF_GLSL}

// The atlas stores slope and height directly rather than a packed unit normal:
// the shader wants slope, and re-deriving it from a normal cost a divide and
// clipped the range exactly where it matters, at the crests.
#define WAVE_SLOPE_RANGE ${WAVE_SLOPE_RANGE.toFixed(1)}

// The atmosphere, shared verbatim with every other material in the city. See
// 'ctx.aerial'. It brings 'skyApRadiance' and 'skyApplyOffset' with it.
${aerialGlsl}

/**
 * One detail octave.
 *
 * 'q' is the position in the *wind* frame — x downwind, y across it — and the
 * slope comes back in that frame too. The atlas spectrum is biased along its
 * own u axis, so sampling it in world coordinates pointed every ripple crest
 * at world north whatever the wind was doing. Crests run across the wind; it
 * is the single most recognisable thing about a wind-blown surface.
 *
 * 'R' decorrelates one octave from the next by a few degrees. It rotates the
 * sampling frame, so the slope has to come back through its transpose or the
 * normals belong to a surface rotated away from the one the heights describe.
 */
struct Rip { vec2 s; float h; float b; };

Rip ripOct(vec2 q, mat2 R, float tile, vec2 drift) {
  vec2 uv = (R * (q + drift)) / tile;
  vec4 c = texture2D(uWaves, uv);
  Rip r;
  r.s = ((c.rg - 0.5) * (2.0 * WAVE_SLOPE_RANGE)) * R;
  r.h = c.b * 2.0 - 1.0;
  r.b = c.a;
  return r;
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
  // How much surf this stretch of shore can break. See 'WaterField.paintSurf'.
  float surfable = aux.a;

  // Water depth from the carved seabed. This is the one signal we can always
  // trust: the terrain module burns the water polygons into the heightfield,
  // so anywhere the bed sits below the surface there is genuinely water here.
  float geoDepth = uSeaLevel - bed;

  // The surface meshes are cut to the water polygons already, so the body of
  // the river needs no masking; only the skirt — which spans the whole world
  // past the edge of the data — has to decide for itself what is ocean.
#ifdef WATER_SKIRT
#ifdef WATER_FAR_BATHY
  // Past the field the four samplers above are all clamping to their boundary
  // texel, so each compass direction inherits whatever the city box happened
  // to end on: a ray of ocean where the edge was wet, a ray of nothing where
  // it was dry, fanning out over the bay. Out here the coarse USGS soundings
  // are the authority instead.
  vec2 e = step(vec2(0.0), fuv) * step(fuv, vec2(1.0));
  if (e.x * e.y < 0.5) {
    float code = texture2D(uFarBathy, (vWorld.xz - uFarOrigin) * uFarInvSize).r;
    if (code < 0.002) discard; // dry land
    geoDepth = (code * 255.0 - 1.0) / 254.0 * uFarMaxDepth;
    // Open ocean, which the clamped field cannot say: full fetch, no shore,
    // and the clear-water end of the absorption ramp rather than the harbour's.
    fetch = 1.0;
    shoreD = max(shoreD, 600.0);
    murk = min(murk, 0.12);
  } else
#endif
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
  // Amplitude of the octaves that are actually *resolved* into a normal.
  //
  // Measured against the atlas (per-axis slope rms 0.52 along the wind), the
  // gains below put the four-octave sum at 0.131 * gain. Cox-Munk gives the
  // rms slope of a clean sea as sqrt(0.003 + 0.00512 U): 0.13 at 4 m/s, 0.20
  // at 8. The old factor left the Charles at gain 0.49, i.e. an rms slope of
  // 0.064 — three degrees, which is not chop, it is glass, and it is why the
  // near field of a bankside view had no relief at all to beat the grain.
  //
  // Two changes get it onto the physical scale. The wind range opens up, and
  // the fetch penalty nearly goes away: fetch limits wave *height* and
  // *length*, not short-wave *steepness* — a fetch-limited sea is if anything
  // steeper than a developed one — and 'rip' above already shortens every
  // tile by a factor of four for the basin. Taxing the slope as well counted
  // the same limit twice.
  float windGain = mix(0.30, 1.55, windiness) * mix(0.88, 1.0, fetch) * shoal;
  float gain = uRippleGain * windGain;

  // The variance handed to the *roughness* when an octave fades out below the
  // sampling limit keeps its old calibration, deliberately. It is the term
  // that stops the far field turning into flat sky-coloured paint, it was
  // tuned from altitude, and unlike the resolved slope it describes scales
  // that fetch genuinely does suppress.
  float varGain = mix(0.26, 1.15, windiness) * mix(0.62, 1.0, fetch) * shoal;

  // Tile sizes in metres, coarsest to finest. On the Charles that is roughly
  // 15 / 4.2 / 1.2 / 0.4 m, in the outer harbour 60 / 17 / 4.7 / 1.7 m. The
  // finest is the capillary band and lives only in the near field.
  float tA = 41.0 * rip, tB = 11.5 * rip, tC = 3.2 * rip, tD = 1.15 * rip;
  // Fade each octave out once its features are a couple of pixels wide, and
  // remember how much slope was lost so it can be added back as roughness.
  //
  // Distance alone is the wrong measure: at 20 degrees above a water plane one
  // pixel covers three times the ground it would head-on, so the texture is
  // three times as minified and the leftover slope turns into a lattice of
  // sparkling dots. Stretching the fade by the grazing factor of the *macro*
  // normal is what stops that — but the stretch has to be *bounded*, because
  // the sampler is not helpless: it has eight-to-one anisotropy and a mip
  // chain, and it filters a stretched footprint correctly up to that ratio.
  // At the ninefold clamp this used to carry, the first thing a camera did on
  // dropping toward the water was throw away every octave but the coarsest,
  // and the harbour — the one view that should be all texture — came out as
  // three soft bands of airbrush.
  vec3 gn0 = normalize(vGN);
  float graze0 = 1.0 / clamp(abs(dot(gn0, V)), 0.055, 1.0);
  float eDist = vViewDist * min(graze0, 4.0);
  float fA = 1.0 - smoothstep(tA * 55.0, tA * 190.0, eDist);
  float fB = 1.0 - smoothstep(tB * 55.0, tB * 190.0, eDist);
  float fC = (1.0 - smoothstep(tC * 55.0, tC * 190.0, eDist)) * uDetail;
  float fD = (1.0 - smoothstep(tD * 48.0, tD * 150.0, eDist)) * uDetail;

  const float GA = 0.090, GB = 0.125, GC = 0.150, GD = 0.130;

  // World -> wind frame. Rows are the downwind and cross-wind axes.
  mat2 WF = mat2(wind.x, -wind.y, wind.y, wind.x);
  vec2 q = WF * p;
  // The macro Gerstner slope is the coarsest rung of the cascade, and it has
  // to be in the same frame as everything the cascade does with it.
  vec2 macro = gn0.xz / max(gn0.y, 0.25);
  vec2 macroQ = WF * macro;
  // Slope converts to a horizontal Gerstner offset through lambda / 2pi.
  float chop = uChop * 0.159;
  // Deep-water phase speed of each octave's dominant mode, lambda ~ tile/3.2:
  // c = sqrt(g * lambda / 2pi). Nothing to tune, and the coarse octaves come
  // out four to six times faster than the capillary one, which is what makes a
  // long look at the water read as a spectrum rather than a scrolling texture.
  // The sample point moves *upwind* so the pattern travels downwind; the drift
  // used to carry the opposite sign and every wave on the Charles ran into the
  // breeze.
  float cA = -uTime * 0.70 * sqrt(tA);
  float cB = -uTime * 0.70 * sqrt(tB);
  float cC = -uTime * 0.70 * sqrt(tC);
  float cD = -uTime * 0.70 * sqrt(tD);
  // Directional spread: short waves run a few degrees off the wind.
  mat2 RA = wRot(0.05), RB = wRot(-0.21), RC = wRot(0.29), RD = wRot(-0.13);

  Rip rA = ripOct(q - macroQ * (uChop * 3.0), RA, tA, vec2(cA, 0.0));
  vec2 sA = rA.s * (GA * gain * fA);

  // Wind ripple rides the crests of the chop under it and is smoothed out of
  // the troughs; without this the octaves are a uniform carpet.
  float mB = 1.0 + 0.55 * rA.h;
  Rip rB = ripOct(q - (macroQ * 0.5 + sA) * (chop * tA), RB, tB,
                  vec2(cB, uTime * 0.22));
  vec2 sB = rB.s * (GB * gain * fB * mB);

  // The last two octaves are dead over most of the frame in any wide shot, so
  // they are branched rather than faded to zero: the test is on view distance
  // and is therefore coherent across a warp.
  vec2 sC = vec2(0.0), sD = vec2(0.0);
  float bC = 0.5, bD = 0.5;
  if (fC > 0.002) {
    float mC = 1.0 + 0.62 * rB.h;
    Rip rC = ripOct(q - (sA + sB) * (chop * tB), RC, tC, vec2(cC, uTime * -0.09));
    sC = rC.s * (GC * gain * fC * mC);
    bC = rC.b;
    // Capillary band. Cat's paws are exactly this: a patch where the smallest
    // scale suddenly exists. It is gated hard on the gust so the slicks stay
    // glassy right up to the camera.
    if (fD > 0.002) {
      float mD = (1.0 + 0.70 * rC.h) * (0.25 + 0.95 * windiness);
      Rip rD = ripOct(q - (sB + sC) * (chop * tC), RD, tD, vec2(cD, 0.0));
      sD = rD.s * (GD * gain * fD * mD);
      bD = rD.b;
    }
  }

  // Back to world before it meets the Gerstner normal.
  vec2 slope = (sA + sB + sC + sD) * WF;
  slope += macro;

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
  float lostRipple = ((1.0 - fA) * GA + (1.0 - fB) * GB
                    + (1.0 - fC) * GC + (1.0 - fD) * GD * 0.45) * 0.62 * varGain;
  // Capillary roughness, from the scales below the finest octave. It used to
  // be an unconditional 0.26 * windiness, which counted the same slope
  // variance twice wherever the octaves still resolved it: the Fresnel ceiling
  // (1 - rough) collapsed to about a half a metre from the camera, the mirror
  // was blurred by nine mips and the glitter lobe was a dome — at the one
  // distance where all of those should be at their sharpest. It now backs off
  // as the capillary octave fades in.
  float micro = 0.058 + 0.215 * windiness * mix(0.55, 1.0, fetch);
  float rough = mix(0.020, 0.048, fetch)
              + micro * (1.0 - 0.78 * clamp(fD, 0.0, 1.0))
              + lostRipple
              + clamp(vLostVar, 0.0, 0.15);
  rough = clamp(rough, 0.016, 0.55);

  // The sky module winds exposure up after sunset so the dim sky still reads.
  // Everything *authored* here — the bed, the backscatter, the silt, the foam,
  // the city's glow — is display-referred and has to come down by the same
  // factor or the river is the brightest thing in a night frame. The reflected
  // sky and the sun's glitter need no such correction: they come from the
  // atmosphere and from 'ctx.sun', which are already as dim as the real thing.
  //
  // 'uEnvIntensity' is the *measured* compensation, 2.5 / exposure. It used to
  // be a proxy for daylight — 0.05 + 0.95 * day^2 — which at five in the
  // afternoon reads 0.46 and halved the body of the river four hours before
  // the exposure it was compensating for moves at all. The golden hour is the
  // hour the water matters most and it was the hour that was wrong.
  float authored = clamp(uEnvIntensity, 0.04, 1.25);

  // ------------------------------------------------------------- body ----
  //
  // Computed before the reflection, not after, because the reflection needs
  // it: at a grazing angle most of what a wave face mirrors is *other water*,
  // and the only honest colour for that is the body colour of the water it
  // is looking at. See the inter-reflection term below.
  //
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
  // Downwelling *irradiance*. Everything below scatters it back diffusely, so
  // it converts to radiance the same way every other Lambertian surface in the
  // city does — rho * E / PI, three's 'BRDF_Lambert'. This shader was written
  // without the 1/PI, which made the water PI times brighter than the land for
  // the same nominal albedo. At a grazing angle Fresnel hides that; from the
  // air, where the body is ninety-seven per cent of the pixel, it does not,
  // and the Charles read as a sheet of pale sage paint laid over the basin.
  vec3 down = (uSunColor * sunUp + uSkyAmbient) * RECIPROCAL_PI;
  vec3 body = bedCol * down * trans + scatter * down * (1.0 - trans);

  // Depth reads as colour, not just as darkness: the channel is deep and
  // green, the margins are a shallow, silty, distinctly browner band. On the
  // Charles that band is tannin; in the harbour it is mud stirred by the tide.
  // The onset has to sit below the bed the terrain actually carves: the
  // Charles bottoms out near 3.6 m, so a 2.6 m threshold made the entire
  // basin silt and it read as pale tan from the air instead of green.
  float shallow = smoothstep(mix(1.1, 4.0, fetch), 0.3, dclamp);
  body = mix(body, siltCol * down, shallow * 0.72);
  // A slow silt plume so the shallows are not a clean contour line — and, at a
  // fifth of the strength, everywhere else as well. Suspended sediment is
  // patchy across a whole basin, and from altitude that patchiness is the only
  // structure the water has: the ripples are long since sub-pixel and Fresnel
  // is down at two per cent, so without it the river is a solid fill.
  float silty = smoothstep(0.55, 1.0, shallow);
  if (silty > 0.002) {
    float plume = texture2D(uNoise, p * 0.00055 + wind * uTime * 0.0004).b;
    body = mix(body, siltCol * down * 1.12, silty * plume * 0.45);
  }
  // Across the open basin the patchiness rides on 'swell' — the wind field's
  // ~1.4 km octave, already computed above and otherwise unused here. It costs
  // nothing and, unlike another tap into the ripple atlas, it does not tile:
  // that atlas repeats every 1.8 km at the frequency this wants, and laid a
  // visible chequerboard the length of the Charles.
  body *= 1.0 + (wf.z - 0.5) * 0.36 * (1.0 - 0.45 * fetch);

  // Sunlight that made it through a crest and back out toward the eye. Only a
  // thin, back-lit, raised crest does this, which is why it reads as the wave
  // *shape* rather than as a wash: it picks out the top few centimetres of
  // whatever is between you and a low sun.
  vec3 L = normalize(uSunDir);
  float back = pow(clamp(dot(V, -normalize(L + N * 0.45)), 0.0, 1.0), 3.0);
  float lift = clamp(0.35 + 0.65 * vCrest, 0.0, 1.0) * clamp(1.0 - 2.4 * uSunDir.y, 0.0, 1.0);
  body += scatter * uSunColor * (back * lift * 1.6);

  // -------------------------------------------------------- reflection ----
  vec3 Rraw = reflect(-V, N);
  vec3 R = Rraw;
  R.y = abs(R.y);   // never sample below the horizon into the seabed

  // The sky the water reflects is the sky-view table the dome itself is drawn
  // from, sampled in the mirror direction. It used to be a hand-authored
  // gradient tuned by eye to sit *below* the real sky so the harbour could
  // never come out brighter than the air above it — which meant the two could
  // never agree either, and any seam between them showed.
  vec3 sky = skyApRadiance(R, rough);

#if WATER_ENV == 1
  // The probe is the same atmosphere, prefiltered: 'EnvProbe' renders the sky
  // dome's radiance function to a 512x256 equirect and runs PMREM over it, so
  // it carries a correctly widened solar disc and a roughness-prefiltered
  // lobe the analytic sample does not. What it emphatically does *not* carry
  // is the city, the ground, or anything else in the scene -- an earlier
  // comment here claimed it 'averages in a lot of ground' and that was simply
  // wrong, which is worth stating because it is exactly the thing the tiers
  // without a planar pass would need and cannot get from here.
  vec3 probe = textureCubeUV(envMap, R, clamp(rough * 1.6, 0.02, 1.0)).rgb;
  sky = mix(sky, probe, 0.35);
#endif

  // Boston's own skyglow: sodium and LED spill scattered by the air over the
  // city. The atmosphere's sky-view table is physical and knows nothing about
  // it, so after dark it has to be added by hand -- but it belongs *in the
  // reflected radiance*, not bolted onto the shaded colour, and that is what
  // it was: a flat add after the Fresnel mix. Three things were wrong with
  // that, and together they painted the seaport at 9:30 pm as a sheet of wet
  // sand at 126 mean luma against a 16-luma sky.
  //
  //  - It double-counted the city. The planar pass already mirrors every lit
  //    window; adding an untextured wash on top of it is the same light
  //    twice. Here it goes under 'cov' below, so the mirror *replaces* it
  //    exactly where it has the real thing, and survives only where the
  //    mirror has nothing -- which is also the whole of the low tier, where
  //    there is no planar pass at all.
  //  - It escaped the roughness cone. A rough grazing surface reflects mostly
  //    other water, and the 'below' term downweights the sky for that; the
  //    glow was exempt. It no longer is.
  //  - It was far too strong. 'uCityGlow' is authored at (0.95, 0.62, 0.30)
  //    and the shore weight took 35% of it, i.e. a third of a unit of sodium
  //    orange on water that should be nearly black. Measured against the
  //    ablation sweep at 'seaport-night' -- glow at 100/50/25/12/6/0 per cent
  //    gives a harbour band of 126/85/51/32/24/11 mean luma against a sky of
  //    17 -- the honest number is about an eighth of what was there.
  float glowNear = 1.0 - smoothstep(120.0, 1400.0, shoreD);
  vec3 cityGlow = uCityGlow * uNight * authored * (0.008 + 0.040 * glowNear);
#ifdef WATER_DEBUG
  cityGlow *= uDbg2.x;
#endif
  sky += cityGlow;

  // A rough surface reflects a *cone*, and at a grazing angle a good half of
  // that cone points below the horizon — at the water in between, at the far
  // bank, at a hull. Folding R up (which we must, or the lobe reads the
  // seabed) silently replaces all of it with more sky, and that is most of why
  // rough grazing water used to render as a sheet of pale sky rather than the
  // dark, streaky matte it is. Because the occluded fraction is driven by
  // roughness, it also hands the gust cells the internal structure they were
  // missing: the rough patches go matte and dark, the slicks stay bright.
  // How much of the lobe that is. The Beckmann rms facet slope is about
  // 0.9 * rough and tilting a facet by s turns the mirror ray by 2s, so the
  // reflected lobe has an rms angular spread near 1.8 * rough; approximating
  // its cumulative by a linear ramp of half-width 1.25 sigma puts the ramp at
  // 2.25 * rough, plus a floor so a dead-flat slick still has a width. The
  // old 0.75 * rough was a third of that and had no derivation behind it.
  float cone = 2.25 * rough + 0.02;
  float below = clamp(0.5 - Rraw.y * (0.5 / cone), 0.0, 1.0);

  // What that part of the cone actually sees is the *next wave*, and a wave
  // seen from above is its own body colour with a little sky in it. Scaling
  // the sky down by (1 - 0.55 * below), which is what this used to do, gets
  // the darkening right and the hue wrong: it leaves a grey-blue wash where
  // the water is olive-green.
  //
  // It matters most where there is no planar pass to overrule it. At 'low'
  // the Charles had nothing in its mirror but horizon sky, and measured
  // *brighter* than the same view at 'high' — 76.9 against 66.5 mean luma
  // with the sky pinned at 93 in both — because the mirror at 'high' is full
  // of dark far bank and the analytic sky is not. A grey plate, in other
  // words, and the env probe cannot help: it is the sky dome's own radiance
  // function rendered to an equirect (see 'EnvProbe'), so it contains no
  // ground at all. One bounce of the water against itself is the only thing
  // available, and it is also the physically right one.
  //
  // Where the planar pass does have geometry this is replaced by 'cov'
  // below, so no tier is paying for it twice.
  vec3 inter = body * authored + sky * 0.12;
  float interW = 1.0;
#ifdef WATER_DEBUG
  interW = uDbg2.w;
#endif
  sky = mix(sky, inter, interW * below);

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
    // streak of light you actually see on a harbour at night. The stretch also
    // has to grow at a grazing angle whatever the roughness: a slick a
    // kilometre away is seen along the surface, so even a centimetre of relief
    // drags the mirror image into a streak. Without that, every slick on the
    // Charles reflected sunlit brick as a hard-edged white cut-out.
    float lod = clamp(rough * uReflBlur, 0.0, uReflMaxLod);
    float smear = uReflSmear * (0.002 + rough * 0.085) * (0.45 + 1.5 * (1.0 - NoV));
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

  // ----------------------------------------------------------- fresnel ----
  float fres = fresnelWater(NoV, rough);

#ifdef WATER_DEBUG
  body *= uDbg.x;
  sky  *= uDbg.y;
#endif

  vec3 color = mix(body * authored, sky, fres);

  // ---------------------------------------------------------- specular ----
  // Anisotropic Beckmann on the wind axis: a Gaussian slope distribution, not
  // GGX. A low sun still stretches into a long path of separate highlights —
  // the stretch is area-preserving, ax * ay held at ga^2 — but the lobe now
  // has the falloff a real sea has, so a sun *behind* the camera contributes
  // nothing instead of washing the whole surface warm. See 'beckmannAniso'.
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float NoL = max(dot(N, L), 0.0);
  vec3 T = normalize(vec3(wind.x, 0.0, wind.y) - N * dot(N, vec3(wind.x, 0.0, wind.y)));
  vec3 Bt = cross(N, T);
  float aniso = clamp(0.28 + 0.38 * windiness, 0.0, 0.66);
  // 'ga' is an rms facet slope now that the lobe is Gaussian, so the old cap
  // at 0.30 is exactly Cox-Munk's value for a near-gale and there is no
  // reason to go past it.
  float ga = clamp(rough * 0.90, 0.007, 0.30);
  float st = sqrt((1.0 + aniso) / (1.0 - aniso));
  float ax = clamp(ga * st, 0.008, 0.62);
  float ay = clamp(ga / st, 0.006, 0.62);
  float D = beckmannAniso(NoH, dot(T, H), dot(Bt, H), ax, ay);
  float Vs = smithVis(NoV, NoL, ga);
  // Facet statistics. A glitter path is a Poisson field of facets that happen
  // to be tilted into the mirror direction, so a smooth lobe is wrong twice
  // over — too uniform, and too dim where it does spike. Four scales carry it,
  // and they have to span the whole frame: the wind streaks are tens of metres
  // across and hold up two kilometres out, the coarse breakup mask carries
  // ten-metre flecks, and the two fine ones are centimetres and gone inside a
  // few hundred. With only the streaks the glitter path came out as blobs of
  // cotton wool the size of a gust cell.
  float sparkle = (0.26 + 1.85 * streak * streak)
                * mix(1.0, 0.42 + 1.16 * rA.b, clamp(fA, 0.0, 1.0))
                * mix(1.0, 0.52 + 0.96 * rB.b, clamp(fB, 0.0, 1.0) * 0.8)
                * mix(1.0, 0.40 + 1.30 * bC, clamp(fC, 0.0, 1.0) * 0.85)
                * mix(1.0, 0.55 + 0.95 * bD, clamp(fD, 0.0, 1.0) * 0.7);
  float spec = D * Vs * NoL * fres * uGlitter * sparkle;
  // A glitter path is many small highlights, not a sheet. Clamped at 46 the
  // lobe saturated whole square kilometres of the Charles into flat white
  // under a low sun; 7 keeps the sparkle and loses the sheet.
  // A comparison rather than a bare min: any comparison against a NaN is
  // false, so this contributes nothing for one, whereas 'min(spec, 7.0)' would
  // pass it straight through on any driver that returns its NaN argument.
  // 'beckmannAniso' is NaN-free at the source now; this is the second line.
  float specOut = (spec > 0.0 ? min(spec, 7.0) : 0.0)
                * smoothstep(-0.04, 0.09, uSunDir.y);
#ifdef WATER_DEBUG
  specOut *= uDbg.z;
#endif
  color += uSunColor * specOut;

  // -------------------------------------------------------------- foam ----
  float cov = 0.0;
#ifndef WATER_SKIRT
  if (shoreD < 90.0) {
    // Shore normal straight off the distance field: it points from the bank
    // out into the water, so the dot with the wind says which bank the foam
    // is being pushed onto.
    vec2 st2 = uFieldTexel * uFieldInvSize;
    float dX = textureLod(uFieldDist, fuv + vec2(st2.x, 0.0), 0.0).r - sdf;
    float dZ = textureLod(uFieldDist, fuv + vec2(0.0, st2.y), 0.0).r - sdf;
    vec2 sn = normalize(vec2(dX, dZ) + vec2(1e-5));
    float windward = clamp(-dot(wind, sn), 0.0, 1.0);
    windward = 0.22 + 0.78 * windward * windward;

    // Surf needs a beach. Boston's waterline is overwhelmingly seawall,
    // sheet pile, riprap and wharf, and against a vertical bulkhead the
    // water is dark right up to the wall -- a thin line of scum at most.
    // This block used to lay the same nine-metre wash band along every metre
    // of coast in the city, which from the air reads as snow piled against
    // the Seaport quays. 'surfable' comes from the beach and sand polygons
    // (see 'WaterField.paintSurf'); off a hard edge what is left is the
    // scum line.
    float soft = mix(0.16, 1.0, surfable);

    // The waterline breathes. Phase varies along the bank so the whole
    // shoreline does not pulse in unison.
    float ph = texture2D(uNoise, p * 0.0013).a;
    float swash = 0.5 + 0.5 * sin(uTime * 0.72 + ph * 11.0 + dot(p, perp) * 0.012);
    float band = mix(1.8, 7.0, windward) * mix(0.5, 1.3, fetch) * mix(0.42, 1.0, surfable);
    float edge = shoreD - swash * band * 0.55;

    // Two octaves of churn, one of them running up the beach.
    float ch1 = texture2D(uWaves, p * 0.055 - sn * (uTime * 0.16) + wind * 0.02).a;
    float ch2 = texture2D(uNoise, p * 0.0045 + wind * (uTime * 0.01)).b;
    float churn = clamp((ch1 * 0.65 + ch2 * 0.55) * 1.5, 0.0, 1.4);

    float wash = (1.0 - smoothstep(0.0, band, edge)) * smoothstep(-2.2, 0.35, edge);
    float lace = (1.0 - smoothstep(band * 0.8, band * 3.4, edge)) * smoothstep(-1.0, 1.5, edge);
    // 'band' already narrows the wash on a short-fetch shore, but that alone
    // left a sheltered pond or lagoon breaking white at full opacity, just in
    // a thinner ribbon — a duck pond does not surf. Fetch has to cut the
    // *strength* as well as the width, or a dead-calm bank reads like a beach.
    cov = (wash * 1.15 + lace * 0.36 * churn) * churn * windward * uFoamGain
        * mix(0.28, 1.0, fetch) * soft;

    // Just inside the waterline the sheet is thin and glossy over wet sand.
    // Wet sand is only wet *sand*; a granite wall does not shine.
    float wet = (1.0 - smoothstep(0.0, 2.6, edge)) * 0.55 * mix(0.25, 1.0, surfable);
    color = mix(color, siltCol * down * 1.9 * authored, wet * (1.0 - clamp(cov, 0.0, 1.0)));
  }
#endif

  // Whitecaps are *rare*. The inner harbour does not break below about
  // 7 m/s, and even then it is a scatter of streaks on the steepest crests,
  // never a field of white — that mistake is what makes game water look like
  // detergent. Gate on wind speed, fetch, an active gust and the top of the
  // crest distribution, then punch holes in it with noise.
  float capGate = smoothstep(0.80, 0.98, vCrest)
                * smoothstep(0.55, 1.0, fetch)
                * smoothstep(0.55, 0.95, gust)
                * smoothstep(6.4, 10.5, uWindSpeed);
  float caps = 0.0;
  if (capGate > 0.002) {
    float capSeed = texture2D(uNoise, p * 0.0065 + wind * (uTime * 0.02)).r;
    caps = capGate * smoothstep(0.42, 0.78, capSeed);
  }
  // Breaking crests add to it, but only genuinely steep ones: with the
  // threshold this low and the gain above 1, the fold term saturated foam
  // across the whole harbour and the water rendered as a white sheet.
  caps += clamp(vFold - 0.62, 0.0, 1.0) * 0.30 * smoothstep(0.72, 1.0, fetch);
  cov = clamp(cov + caps * 0.34 * uFoamGain, 0.0, 1.0);
  cov *= 1.0 - smoothstep(1400.0, 4200.0, vViewDist);

  float foam = 0.0;
  if (cov > 0.002) {
    // Foam dissolves by *breaking up*, not by fading. Thresholding a
    // broadband mask against the coverage gives lace at a metre and bubbles at
    // a few centimetres, and the edge erodes from the outside in as the
    // coverage drops — which is what a receding wash actually does. A smooth
    // field faded by a scalar reads as airbrush every time.
    float b1 = texture2D(uWaves, p * 0.46 + wind * (uTime * 0.06)).a;
    float b2 = texture2D(uWaves, wRot(1.7) * p * 0.115 - perp * (uTime * 0.03)).a;
    // Mean 0.5 either way, so the threshold below is calibrated once.
    float bub = b1 * 0.62 + b2 * 0.38;
    // Blur the threshold back to a plain fade once the bubbles are sub-pixel,
    // or the foam line crawls with aliasing at a kilometre.
    float res = 1.0 - smoothstep(180.0, 700.0, eDist);
    float thr = 1.15 - cov * 1.45;
    float hard = smoothstep(thr, thr + 0.30, bub);
    foam = mix(cov, hard, res);
    // A bubble raft is white where it is thick and merely bright where it is
    // thin, so keep a little of the coverage under the dissolve.
    foam = clamp(max(foam, cov * 0.35), 0.0, 1.0);
  }

  // Foam is white *material*, not a light source: it has to be lit by the
  // same sun and sky as everything else, or it glows in the dark — and with
  // the night exposure lift a constant floor here clips the whole channel to
  // white.
  vec3 foamLit = uFoamColor * (down * 0.80 + uSkyAmbient * RECIPROCAL_PI * 0.55) * authored;
#ifdef WATER_DEBUG
  foam *= uDbg.w;
#endif
  color = mix(color, foamLit, foam);

  // Distance. Not a fade toward somebody's idea of the horizon colour — the
  // same physical aerial perspective the buildings, the hills and the dome all
  // use, so at twenty kilometres the sea *is* the sky it sits in front of, at
  // every azimuth and every sun elevation, and there is nothing left to seam.
#ifdef WATER_DEBUG
  if (uDbg2.y > 0.5) color = skyApplyOffset(color, vWorld - cameraPosition);
#else
  color = skyApplyOffset(color, vWorld - cameraPosition);
#endif

#ifdef WATER_DEBUG
  // Flat false-colour readouts. Written straight to the framebuffer with no
  // tone map, so the byte value in a screenshot is the quantity itself.
  int vm = int(uDbg2.z + 0.5);
  if (vm == 1) { gl_FragColor = vec4(fetch, murk, shallow, 1.0); return; }
  if (vm == 2) { gl_FragColor = vec4(depth / 20.0, geoDepth / 20.0, ramp / 20.0, 1.0); return; }
  if (vm == 3) { gl_FragColor = vec4(rough * 2.0, windiness, clamp(vLostVar, 0.0, 1.0), 1.0); return; }
  if (vm == 4) { gl_FragColor = vec4(fres, NoV, clamp(cov, 0.0, 1.0), 1.0); return; }
  if (vm == 5) { gl_FragColor = vec4(clamp(shoreD / 300.0, 0.0, 1.0), clamp(foam, 0.0, 1.0), 0.0, 1.0); return; }
  if (vm == 6) { gl_FragColor = vec4(surfable, clamp(cov, 0.0, 1.0), clamp(shoreD / 60.0, 0.0, 1.0), 1.0); return; }
#endif

  // Bound the HDR output, and do it with a comparison rather than a bare
  // 'min'.
  //
  // Two reasons, and the second is the one that matters. At a grazing angle
  // the surface mirrors the sky almost totally, and a bright dusk horizon
  // pushed that past anything the tonemapper could roll off -- the harbour
  // clipped to a hard white band and dragged the auto-exposure down with it.
  // 12 still reads as dazzling.
  //
  // But 'min' is not a guard against a bad value. GLSL leaves min-with-NaN
  // implementation-defined, so one driver clamps it and the next hands it
  // straight through, and a non-finite fragment renders as flat white. That
  // is not hypothetical here: a half-precision underflow in the Beckmann lobe
  // did exactly this, over square kilometres, on a machine where none of the
  // local tests could see it. Every comparison against a NaN is false, so
  // testing the value is a real guard where clamping it is not.
  //
  // The fallback is dim sky rather than black: a patch of water that loses a
  // little light is invisible, and it cannot poison the metering the way a
  // non-finite texel does.
  vec3 safe = uSkyAmbient * 0.25;
  color = vec3(
    (color.r >= 0.0 && color.r < 1.0e6) ? min(color.r, 12.0) : safe.r,
    (color.g >= 0.0 && color.g < 1.0e6) ? min(color.g, 12.0) : safe.g,
    (color.b >= 0.0 && color.b < 1.0e6) ? min(color.b, 12.0) : safe.b);

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
