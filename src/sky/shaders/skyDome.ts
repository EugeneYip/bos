import {
  ATMOSPHERE_COMMON,
  ATMOSPHERE_LUT_SAMPLERS,
  SKYVIEW_PARAM,
} from './atmosphere';
import { NOISE_GLSL } from './noise';

/**
 * The sky dome. Drawn as a single full-screen triangle before everything else
 * with depth test and write off, so it costs exactly one full-screen pass and
 * the city paints straight over it.
 *
 * On top of the scattering LUT it adds, in order:
 *   - the solar disc, with wavelength-dependent limb darkening and an
 *     analytic Mie aureole that the 256x144 LUT cannot resolve;
 *   - the moon: correct phase for the date, a Lommel-Seeliger lunar BRDF with
 *     the opposition surge, earthshine on the dark limb, and the scattered
 *     moonlight it puts into the air around it;
 *   - natural airglow, and Boston's very real sodium-and-LED skyglow, which
 *     hugs the horizon and points at downtown;
 *   - the volumetric cloud buffer;
 *   - a triangular-PDF dither, because an 8-bit sky gradient bands horribly.
 */

export const SKY_DOME_VERT = /* glsl */ `
varying vec3 vRay;
uniform mat4 uInverseViewProjection;

void main() {
  vec4 clip = vec4( position.xy, 1.0, 1.0 );
  vec4 world = uInverseViewProjection * clip;
  vRay = world.xyz / world.w - cameraPosition;
  gl_Position = clip;
}
`;

const SKY_DOME_COMMON = /* glsl */ `
precision highp float;

${ATMOSPHERE_COMMON}
${ATMOSPHERE_LUT_SAMPLERS}
${SKYVIEW_PARAM}
${NOISE_GLSL}

uniform sampler2D uSkyViewLut;
uniform float     uHorizonHold;
uniform sampler2D uCloudBuffer;
uniform vec2  uResolution;
uniform float uFrame;

uniform vec3  uSunDir;
uniform vec3  uSunDiscRadiance;
uniform float uSunAngularRadius;
uniform float uAureole;

uniform vec3  uMoonDir;
uniform vec3  uMoonRight;     // on-sky direction of the bright limb
uniform vec3  uMoonUp;
uniform float uMoonAngularRadius;
uniform float uMoonPhaseAngle;   // 0 = full, PI = new
uniform float uMoonIllum;
uniform vec3  uMoonRadiance;

uniform float uViewHeight;       // Mm from planet centre
uniform float uNightFactor;      // 0 by day, 1 once the sun is well down

uniform vec3  uSkyglowColor;
uniform float uSkyglowStrength;
uniform vec2  uCityDir;          // horizontal unit vector toward downtown
uniform float uCityDistance;     // metres, fades the directional bias when far

uniform float uExposureHint;     // only used to scale the dither amplitude
uniform float uCloudsEnabled;

/** Classic linear limb darkening, stronger toward the blue. */
vec3 limbDarkening( float mu ) {
  vec3 u = vec3( 0.56, 0.65, 0.78 );
  return vec3( 1.0 ) - u * ( 1.0 - mu );
}

/** Low-frequency maria pattern so the lunar disc is not a flat white coin. */
float lunarAlbedo( vec3 n ) {
  float m = 0.0;
  m += 0.5 * hash13( floor( n * 4.0 ) );
  m += 0.3 * hash13( floor( n * 9.0 ) + 17.0 );
  m += 0.2 * hash13( floor( n * 19.0 ) + 41.0 );
  // Smooth it by blending with the raw direction so blocks do not show.
  float s = 0.5 + 0.5 * sin( n.x * 11.0 + n.y * 7.0 ) * cos( n.z * 9.0 - n.y * 5.0 );
  return mix( 0.72, 1.18, mix( m, s, 0.55 ) );
}

vec3 moonContribution( vec3 rayDir ) {
  float cosMoon = dot( rayDir, uMoonDir );
  vec3 result = vec3( 0.0 );

  // Scattered moonlight: a faint blue wash around the moon, plus a Mie halo.
  float above = smoothstep( -0.09, 0.02, uMoonDir.y );
  float airmass = 1.0 / max( 0.06, rayDir.y * 0.85 + 0.15 );
  float scatter =
    rayleighPhase( cosMoon ) * 9.0 + miePhase( cosMoon, 0.7 ) * 0.7 + miePhase( cosMoon, 0.93 ) * 0.25;
  result += uMoonRadiance * uMoonIllum * above * scatter * airmass * 0.00042;

  if ( cosMoon < cos( uMoonAngularRadius * 6.0 ) ) return result;

  // The disc itself.
  vec3 tangent = rayDir - uMoonDir * cosMoon;
  float px = dot( tangent, uMoonRight ) / uMoonAngularRadius;
  float py = dot( tangent, uMoonUp ) / uMoonAngularRadius;
  float r2 = px * px + py * py;

  if ( r2 < 1.02 ) {
    float z = sqrt( max( 0.0, 1.0 - min( r2, 1.0 ) ) );
    vec3 n = vec3( px, py, z );
    // The bright limb is at +x by construction, so the solar direction in the
    // disc's frame is (sin p, 0, cos p) for phase angle p.
    vec3 l = vec3( sin( uMoonPhaseAngle ), 0.0, cos( uMoonPhaseAngle ) );
    float ndl = max( 0.0, dot( normalize( n ), l ) );
    // Lommel-Seeliger: the moon is a dusty, backscattering, near-Lambertian
    // mess, and this is why a full moon is uniformly bright to the limb.
    float brdf = ndl / max( 0.02, ndl + z );
    float opposition = 1.0 + 0.42 * exp( -uMoonPhaseAngle * 6.0 );

    float edge = 1.0 - smoothstep( 0.985, 1.0, sqrt( r2 ) );
    vec3 disc = uMoonRadiance * lunarAlbedo( normalize( n ) ) * brdf * opposition;
    // Earthshine: the dark limb lit by a gibbous Earth.
    disc += uMoonRadiance * vec3( 0.55, 0.72, 1.0 ) * 0.018 * ( 1.0 - uMoonIllum ) * z;
    result += disc * edge;
  }

  return result;
}

/**
 * The complete sky radiance in one direction: atmosphere, sun, moon, airglow
 * and urban skyglow. Shared by the on-screen dome and by the equirectangular
 * pass that feeds the IBL probe.
 */
vec3 skyRadiance( vec3 rayDir ) {
  vec3 up = vec3( 0.0, 1.0, 0.0 );

  // ---- atmosphere -------------------------------------------------------
  vec2 lutUv = skyViewUv( rayDir, up, uSunDir, uViewHeight );
  // Below the tangent, the table describes the planet: those rows are the air
  // over a path that ends on the ground at h / sin(depression), and that
  // distance collapses from the horizon's eighty-odd kilometres to twenty
  // within a single degree. So the rows darken fast, and correctly -- for a
  // planet whose surface is modelled all the way out. This one stops at a
  // 23 km radius, and the degree of sky between that rim and the true horizon
  // showed those rows through as a hard dark-blue stripe under a warm sunset,
  // brighter terrain on one side of it and brighter sky on the other.
  //
  // So hold the sample at the tangent row. Continuous in value at the
  // crossing, and what it holds is the asymptotic haze that the ground out
  // there would be buried in at any visibility this model offers.
  //
  // Only on screen: the probe wants the real lower hemisphere, because the
  // ambient arriving at a wall from below is ground, not horizon.
  lutUv.y = mix( lutUv.y, max( lutUv.y, 0.5 ), uHorizonHold );
  vec3 col = texture2D( uSkyViewLut, lutUv ).rgb;

  vec3 pos = vec3( 0.0, uViewHeight, 0.0 );
  vec3 sunT = sunTransmittance( pos, uSunDir );

  // ---- sun --------------------------------------------------------------
  float cosSun = dot( rayDir, uSunDir );
  float sunAngle = safeacos( cosSun );
  if ( sunAngle < uSunAngularRadius * 1.06 ) {
    float r = sunAngle / uSunAngularRadius;
    float mu = sqrt( max( 0.0, 1.0 - min( r * r, 1.0 ) ) );
    float edge = 1.0 - smoothstep( 0.985, 1.03, r );
    col += uSunDiscRadiance * limbDarkening( mu ) * edge * sunT;
  }

  // Analytic aureole. The sky-view LUT is far too coarse to resolve the Mie
  // forward peak, and without this the sun sits on the sky like a sticker.
  {
    float airmass = 1.0 / max( 0.05, rayDir.y * 0.9 + 0.1 );
    float halo = miePhase( cosSun, 0.86 ) * 0.55 + miePhase( cosSun, 0.965 ) * 0.45;
    col += uSunDiscRadiance * sunT * halo * airmass * uAureole;
  }

  // ---- moon -------------------------------------------------------------
  col += moonContribution( rayDir ) * uNightFactor;

  // ---- airglow ----------------------------------------------------------
  // Natural night-sky brightness: 557.7 nm oxygen green near the horizon over
  // a faint blue zodiacal/integrated-starlight floor.
  {
    float h = max( 0.0, rayDir.y );
    float band = exp( -h * 5.5 );
    col += uNightFactor * ( vec3( 0.0009, 0.0016, 0.0013 ) * band + vec3( 0.0007, 0.0010, 0.0019 ) );
  }

  // ---- urban skyglow ----------------------------------------------------
  {
    float h = max( 0.0, rayDir.y );
    float vertical = exp( -h * 7.0 ) * 0.82 + exp( -h * 2.2 ) * 0.18;
    vec2 flat2 = rayDir.xz;
    float len = length( flat2 );
    float bias = 0.5;
    if ( len > 1e-4 ) {
      float aim = dot( flat2 / len, uCityDir );
      // Standing in the middle of it, the glow is everywhere; from a distance
      // it collapses into a dome over downtown.
      float focus = clamp( uCityDistance / 6000.0, 0.0, 1.0 );
      bias = mix( 0.85, 0.32 + 0.68 * max( 0.0, aim ), focus );
    }
    col += uSkyglowColor * uSkyglowStrength * vertical * bias;
  }

  return col;
}
`;

/** Screen pass: the dome the camera actually sees, with clouds and dither. */
export const SKY_DOME_FRAG = /* glsl */ `
varying vec3 vRay;
${SKY_DOME_COMMON}

void main() {
  vec3 rayDir = normalize( vRay );
  vec2 screenUv = gl_FragCoord.xy / uResolution;
  vec3 col = skyRadiance( rayDir );

  // ---- clouds -----------------------------------------------------------
  if ( uCloudsEnabled > 0.5 ) {
    vec4 cloud = texture2D( uCloudBuffer, screenUv );
    col = col * cloud.a + cloud.rgb;
  }

  // ---- dither -----------------------------------------------------------
  // Relative dither: one 8-bit step is a roughly constant *fraction* of the
  // value after ACES + sRGB, so scaling by the colour keeps night and noon
  // equally band-free without adding visible grain.
  float d = triDither( gl_FragCoord.xy, mod( uFrame, 64.0 ) );
  col *= 1.0 + d * 0.0075;
  col += d * 0.00012;

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Equirectangular pass used to feed `PMREMGenerator`. Same radiance function,
 * no clouds and no dither, and the caller widens the solar disc so a 128-pixel
 * cube face does not alias it into a strobing pixel.
 *
 * The uv convention matches three's `equirectUv()`:
 * `u = atan(z, x) / 2PI + 0.5`, `v = asin(y) / PI + 0.5`.
 */
export const SKY_EQUIRECT_FRAG = /* glsl */ `
varying vec2 vUv;
${SKY_DOME_COMMON}

void main() {
  float a = ( vUv.x - 0.5 ) * 2.0 * PI;
  float t = ( vUv.y - 0.5 ) * PI;
  float ct = cos( t );
  vec3 rayDir = vec3( ct * cos( a ), sin( t ), ct * sin( a ) );
  gl_FragColor = vec4( max( skyRadiance( rayDir ), vec3( 0.0 ) ), 1.0 );
}
`;

