/**
 * GLSL for the physical atmosphere.
 *
 * This is an implementation of Hillaire's *A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique* (EGSR 2020) on top of the Bruneton
 * medium: two exponential layers (Rayleigh, Mie) plus a tent-shaped ozone
 * layer, with energy-conserving multiple scattering folded in from a small
 * precomputed LUT.
 *
 * Three LUTs:
 *   1. transmittance  256 x 64   — built once, sun-zenith x altitude.
 *   2. multiscatter    32 x 32   — built once, needs (1).
 *   3. sky-view       256 x 144  — rebuilt every frame, needs (1) and (2).
 *
 * The sky-view LUT is parameterised in azimuth *relative to the sun* and in a
 * square-root-warped altitude angle, which puts most of its resolution where
 * the gradient is: the ten degrees either side of the horizon.
 *
 * Distances are megametres so that the numbers stay near 1.0 and half-float
 * targets behave.
 */

/** Shared medium description, ray-sphere maths and phase functions. */
export const ATMOSPHERE_COMMON = /* glsl */ `
#ifndef ATMOSPHERE_COMMON
#define ATMOSPHERE_COMMON

#define PI 3.141592653589793
#define ATM_GROUND 6.360
#define ATM_TOP    6.460
/** World metres -> megametres. */
#define M_TO_MM 0.000001

uniform vec3  uRayleighScatter;   // 1 / Mm
uniform vec3  uMieScatter;        // 1 / Mm
uniform vec3  uMieAbsorb;         // 1 / Mm
uniform vec3  uOzoneAbsorb;       // 1 / Mm
uniform float uGroundAlbedo;

float safeacos( float x ) { return acos( clamp( x, -1.0, 1.0 ) ); }

/**
 * Distance along 'rd' to the sphere of radius 'rad' centred on the origin,
 * or -1 if it is missed. Handles the ray origin being inside the sphere.
 */
float raySphere( vec3 ro, vec3 rd, float rad ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - rad * rad;
  if ( c > 0.0 && b > 0.0 ) return -1.0;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  if ( disc > b * b ) return ( -b + sqrt( disc ) );
  return -b - sqrt( disc );
}

/** Scattering and extinction coefficients of the medium at a point. */
void atmosphereMedium( vec3 pos, out vec3 rayleighS, out vec3 mieS, out vec3 extinction ) {
  float altitudeKm = ( length( pos ) - ATM_GROUND ) * 1000.0;
  float rayleighDensity = exp( -altitudeKm / 8.0 );
  float mieDensity = exp( -altitudeKm / 1.2 );
  // Ozone: a linear tent peaking at 25 km, half-width 15 km.
  float ozoneDensity = max( 0.0, 1.0 - abs( altitudeKm - 25.0 ) / 15.0 );

  rayleighS = uRayleighScatter * rayleighDensity;
  mieS = uMieScatter * mieDensity;
  extinction = rayleighS + mieS + uMieAbsorb * mieDensity + uOzoneAbsorb * ozoneDensity;
  extinction = max( extinction, vec3( 1e-7 ) );
}

/** Cornette-Shanks approximation to the Mie phase function. */
float miePhase( float cosTheta, float g ) {
  float k = 3.0 / ( 8.0 * PI ) * ( 1.0 - g * g ) / ( 2.0 + g * g );
  float d = 1.0 + g * g - 2.0 * g * cosTheta;
  return k * ( 1.0 + cosTheta * cosTheta ) / ( d * sqrt( max( d, 1e-4 ) ) );
}

float rayleighPhase( float cosTheta ) {
  return 3.0 / ( 16.0 * PI ) * ( 1.0 + cosTheta * cosTheta );
}
#endif
`;

/** Lookups into the transmittance and multiple-scattering LUTs. */
export const ATMOSPHERE_LUT_SAMPLERS = /* glsl */ `
uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatterLut;

vec3 sunTransmittance( vec3 pos, vec3 sunDir ) {
  float height = length( pos );
  vec3 up = pos / height;
  float cosZenith = dot( sunDir, up );
  vec2 uv = vec2(
    clamp( 0.5 + 0.5 * cosZenith, 0.0, 1.0 ),
    clamp( ( height - ATM_GROUND ) / ( ATM_TOP - ATM_GROUND ), 0.0, 1.0 )
  );
  return texture2D( uTransmittanceLut, uv ).rgb;
}

vec3 multiScatter( vec3 pos, vec3 sunDir ) {
  float height = length( pos );
  vec3 up = pos / height;
  float cosZenith = dot( sunDir, up );
  vec2 uv = vec2(
    clamp( 0.5 + 0.5 * cosZenith, 0.0, 1.0 ),
    clamp( ( height - ATM_GROUND ) / ( ATM_TOP - ATM_GROUND ), 0.0, 1.0 )
  );
  return texture2D( uMultiScatterLut, uv ).rgb;
}
`;

/** Pass that fills the transmittance LUT. */
export const TRANSMITTANCE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_COMMON}

const int STEPS = 48;

void main() {
  float cosZenith = vUv.x * 2.0 - 1.0;
  float height = mix( ATM_GROUND, ATM_TOP, vUv.y );
  vec3 pos = vec3( 0.0, height, 0.0 );
  vec3 dir = normalize( vec3( sqrt( max( 0.0, 1.0 - cosZenith * cosZenith ) ), cosZenith, 0.0 ) );

  if ( raySphere( pos, dir, ATM_GROUND ) > 0.0 ) {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }
  float tMax = raySphere( pos, dir, ATM_TOP );
  if ( tMax < 0.0 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 transmittance = vec3( 1.0 );
  float t = 0.0;
  for ( int i = 0; i < STEPS; i ++ ) {
    float newT = ( ( float( i ) + 0.3 ) / float( STEPS ) ) * tMax;
    float dt = newT - t;
    t = newT;
    vec3 rs, ms, ext;
    atmosphereMedium( pos + t * dir, rs, ms, ext );
    transmittance *= exp( -dt * ext );
  }
  gl_FragColor = vec4( transmittance, 1.0 );
}
`;

/** Pass that fills the multiple-scattering LUT (needs the transmittance LUT). */
export const MULTISCATTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_COMMON}
uniform sampler2D uTransmittanceLut;

vec3 sunTransmittance( vec3 pos, vec3 sunDir ) {
  float height = length( pos );
  vec3 up = pos / height;
  float cosZenith = dot( sunDir, up );
  vec2 uv = vec2(
    clamp( 0.5 + 0.5 * cosZenith, 0.0, 1.0 ),
    clamp( ( height - ATM_GROUND ) / ( ATM_TOP - ATM_GROUND ), 0.0, 1.0 )
  );
  return texture2D( uTransmittanceLut, uv ).rgb;
}

const int SQRT_SAMPLES = 8;
const int MS_STEPS = 20;

vec3 sphericalDir( float theta, float phi ) {
  float sp = sin( phi );
  return vec3( sp * sin( theta ), cos( phi ), sp * cos( theta ) );
}

void main() {
  float cosZenith = vUv.x * 2.0 - 1.0;
  float height = mix( ATM_GROUND, ATM_TOP, vUv.y );
  vec3 pos = vec3( 0.0, height, 0.0 );
  vec3 sunDir = normalize( vec3( sqrt( max( 0.0, 1.0 - cosZenith * cosZenith ) ), cosZenith, 0.0 ) );

  vec3 lumTotal = vec3( 0.0 );
  vec3 fms = vec3( 0.0 );
  float invSamples = 1.0 / float( SQRT_SAMPLES * SQRT_SAMPLES );

  for ( int i = 0; i < SQRT_SAMPLES; i ++ ) {
    for ( int j = 0; j < SQRT_SAMPLES; j ++ ) {
      float theta = ( float( i ) + 0.5 ) / float( SQRT_SAMPLES ) * 2.0 * PI;
      float phi = safeacos( 1.0 - 2.0 * ( float( j ) + 0.5 ) / float( SQRT_SAMPLES ) );
      vec3 rayDir = sphericalDir( theta, phi );

      float atmoDist = raySphere( pos, rayDir, ATM_TOP );
      float groundDist = raySphere( pos, rayDir, ATM_GROUND );
      float tMax = groundDist > 0.0 ? groundDist : atmoDist;

      float cosT = dot( rayDir, sunDir );
      float mp = miePhase( cosT, 0.8 );
      float rp = rayleighPhase( cosT );

      vec3 lum = vec3( 0.0 );
      vec3 lumFactor = vec3( 0.0 );
      vec3 transmittance = vec3( 1.0 );
      float t = 0.0;
      for ( int s = 0; s < MS_STEPS; s ++ ) {
        float newT = ( ( float( s ) + 0.3 ) / float( MS_STEPS ) ) * tMax;
        float dt = newT - t;
        t = newT;
        vec3 p = pos + t * rayDir;
        vec3 rs, ms, ext;
        atmosphereMedium( p, rs, ms, ext );
        vec3 sampleT = exp( -dt * ext );

        // Integrate the segment analytically rather than with a midpoint.
        vec3 scatterNoPhase = rs + ms;
        lumFactor += transmittance * ( ( scatterNoPhase - scatterNoPhase * sampleT ) / ext );

        vec3 sunT = sunTransmittance( p, sunDir );
        vec3 inScatter = ( rs * rp + ms * mp ) * sunT;
        lum += transmittance * ( ( inScatter - inScatter * sampleT ) / ext );
        transmittance *= sampleT;
      }

      if ( groundDist > 0.0 && dot( pos, sunDir ) > 0.0 ) {
        vec3 hit = normalize( pos + groundDist * rayDir ) * ATM_GROUND;
        lum += transmittance * uGroundAlbedo * sunTransmittance( hit, sunDir );
      }

      fms += lumFactor * invSamples;
      lumTotal += lum * invSamples;
    }
  }

  // Geometric series over the infinite scattering orders.
  vec3 psi = lumTotal / max( vec3( 1e-5 ), 1.0 - fms );
  gl_FragColor = vec4( psi, 1.0 );
}
`;

/**
 * Raymarch used by the sky-view LUT and by the cloud pass' background fade.
 * Requires ATMOSPHERE_COMMON and ATMOSPHERE_LUT_SAMPLERS in scope.
 */
export const ATMOSPHERE_RAYMARCH = /* glsl */ `
uniform float uMieG;

/**
 * Single + multiple scattering along a ray. 'tMax' in megametres.
 * The sun's own shadow volume falls out for free: sunTransmittance() is zero
 * wherever the path to the sun is blocked by the planet, which is what paints
 * the Earth's shadow and the Belt of Venus at twilight.
 */
vec3 atmosphereRaymarch( vec3 pos, vec3 rayDir, vec3 sunDir, float tMax, int steps, out vec3 outTransmittance ) {
  float cosT = dot( rayDir, sunDir );
  float mp = miePhase( cosT, uMieG );
  float rp = rayleighPhase( cosT );

  vec3 lum = vec3( 0.0 );
  vec3 transmittance = vec3( 1.0 );
  float t = 0.0;
  float inv = 1.0 / float( steps );
  for ( int i = 0; i < 64; i ++ ) {
    if ( i >= steps ) break;
    // Samples crowd toward the observer, quadratically.
    //
    // A ray at the horizon has a 'tMax' of several hundred kilometres, of
    // which the first thirty carry nearly all the scattering. Spaced evenly,
    // 32 samples put the first one twenty kilometres out and collapse the
    // entire near field into one segment, so the same physical path came out
    // brighter when integrated as a 700 km miss than as a 92 km ground hit --
    // which is precisely where those two cases meet, and drew a hard dark
    // stripe across the horizon in every distant view.
    float u = float( i + 1 ) * inv;
    float newT = tMax * u * u;
    float dt = newT - t;
    // Midpoint, not the far end: once the segments are graded, a late one is
    // tens of kilometres long and its far end is measurably thinner air than
    // its near end.
    vec3 p = pos + ( t + 0.5 * dt ) * rayDir;
    t = newT;

    vec3 rs, ms, ext;
    atmosphereMedium( p, rs, ms, ext );
    vec3 sampleT = exp( -dt * ext );

    vec3 sunT = sunTransmittance( p, sunDir );
    vec3 psiMs = multiScatter( p, sunDir );

    vec3 inScatter = rs * ( rp * sunT + psiMs ) + ms * ( mp * sunT + psiMs );
    lum += transmittance * ( ( inScatter - inScatter * sampleT ) / ext );
    transmittance *= sampleT;
  }
  outTransmittance = transmittance;
  return lum;
}
`;

/**
 * Sky-view LUT parameterisation, shared by the generator and every consumer.
 * 'viewHeight' is the observer's distance from the planet centre, in Mm.
 */
export const SKYVIEW_PARAM = /* glsl */ `
/** Ray direction -> sky-view LUT uv. Azimuth is measured from the sun. */
vec2 skyViewUv( vec3 rayDir, vec3 up, vec3 sunDir, float viewHeight ) {
  float horizonAngle = safeacos( clamp( sqrt( viewHeight * viewHeight - ATM_GROUND * ATM_GROUND ) / viewHeight, 0.0, 1.0 ) );
  float altitudeAngle = horizonAngle - safeacos( dot( rayDir, up ) );

  float azimuth;
  if ( abs( altitudeAngle ) > ( 0.5 * PI - 0.0005 ) ) {
    azimuth = 0.0;
  } else {
    vec3 right = normalize( cross( sunDir, up ) );
    vec3 forward = cross( up, right );
    vec3 proj = normalize( rayDir - up * dot( rayDir, up ) );
    azimuth = atan( dot( proj, right ), dot( proj, forward ) ) + PI;
  }

  float v = 0.5 + 0.5 * sign( altitudeAngle ) * sqrt( abs( altitudeAngle ) * 2.0 / PI );
  return vec2( azimuth / ( 2.0 * PI ), v );
}

/** Sky-view LUT uv -> ray direction, in the same frame. */
vec3 skyViewDir( vec2 uv, vec3 up, vec3 sunDir, float viewHeight ) {
  float azimuth = uv.x * 2.0 * PI - PI;
  float v = uv.y;
  float coord = 2.0 * v - 1.0;
  float altitudeAngle = sign( coord ) * coord * coord * 0.5 * PI;

  float horizonAngle = safeacos( clamp( sqrt( viewHeight * viewHeight - ATM_GROUND * ATM_GROUND ) / viewHeight, 0.0, 1.0 ) );
  float zenith = horizonAngle - altitudeAngle;

  vec3 right = normalize( cross( sunDir, up ) );
  vec3 forward = cross( up, right );
  float sa = sin( zenith );
  return normalize( up * cos( zenith ) + forward * ( sa * cos( azimuth ) ) + right * ( sa * sin( azimuth ) ) );
}
`;

/** Pass that rebuilds the sky-view LUT for the current sun and camera height. */
export const SKYVIEW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LUT_SAMPLERS}
${ATMOSPHERE_RAYMARCH}
${SKYVIEW_PARAM}

uniform vec3 uSunDir;        // world space, +Y up
uniform float uViewHeight;   // Mm from planet centre
uniform int uSteps;

void main() {
  vec3 up = vec3( 0.0, 1.0, 0.0 );
  vec3 pos = vec3( 0.0, uViewHeight, 0.0 );
  vec3 rayDir = skyViewDir( vUv, up, uSunDir, uViewHeight );

  float atmoDist = raySphere( pos, rayDir, ATM_TOP );
  float groundDist = raySphere( pos, rayDir, ATM_GROUND );
  float tMax = groundDist > 0.0 ? groundDist : atmoDist;
  if ( tMax <= 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  vec3 tr;
  vec3 lum = atmosphereRaymarch( pos, rayDir, uSunDir, tMax, uSteps, tr );

  // Rays that hit the planet see ground rather than space. Beyond the modelled
  // terrain this is all we have, and at those distances it is nearly pure haze
  // anyway, so it blends into the horizon instead of cutting a hard edge.
  if ( groundDist > 0.0 ) {
    vec3 hit = normalize( pos + groundDist * rayDir ) * ATM_GROUND;
    float ndl = max( 0.0, dot( normalize( hit ), uSunDir ) );
    vec3 ground = uGroundAlbedo * ( sunTransmittance( hit, uSunDir ) * ndl + multiScatter( hit, uSunDir ) * 2.0 ) / PI;
    lum += tr * ground;
  }

  gl_FragColor = vec4( lum, 1.0 );
}
`;
