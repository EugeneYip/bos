import { NOISE_GLSL } from './noise';
import { ATMOSPHERE_COMMON, ATMOSPHERE_LUT_SAMPLERS, SKYVIEW_PARAM } from './atmosphere';

/**
 * Volumetric clouds.
 *
 * Raymarched through a spherical shell around a 6360 km planet, so the deck
 * bends down and meets the horizon instead of running to infinity as a flat
 * slab would. Density is the Horizon Zero Dawn recipe — a Perlin-Worley base
 * dilated by Worley fBm, shaped by a height gradient that morphs between
 * stratus and cumulus, gated by a scrolling weather field and eroded at the
 * edges by a high-frequency Worley volume.
 *
 * Lighting is Beer-Lambert extinction with:
 *   - a six-tap light march toward the sun plus one long cone tap;
 *   - three "multiple scattering octaves" (Wrenninge et al.), which is what
 *     stops a thick cloud turning into a black blob and gives the lit interior;
 *   - a dual-lobe Henyey-Greenstein phase, so a backlit edge blows out into a
 *     silver lining;
 *   - the powder term, for the dark rims of a front-lit cumulus.
 *
 * The pass runs at a fraction of the main resolution into an RGBA16F buffer:
 * rgb is in-scattered radiance, alpha is transmittance, so compositing is a
 * single multiply-add in the sky dome.
 */

/** Shared cloud field description: density, weather, and the shell geometry. */
export const CLOUD_FIELD = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler3D uShapeTex;
uniform sampler3D uDetailTex;

uniform float uCloudBottom;     // metres above sea level
uniform float uCloudTop;
uniform float uCoverage;        // 0..1
uniform float uDensity;         // extinction per metre at full density
uniform float uCumuliform;      // 0 stratus .. 1 cumulus
uniform float uFeatureScale;    // metres per weather-map feature
uniform float uShapeScale;      // metres per repeat of the shape volume
uniform float uDetailScale;     // metres per repeat of the detail volume
uniform float uErosion;
uniform vec2  uWind;            // metres of accumulated drift
uniform float uCirrus;

#define PLANET_R 6360000.0

float cRemap( float v, float a, float b, float c, float d ) {
  return c + ( v - a ) / max( b - a, 1e-5 ) * ( d - c );
}

/** 0 at the deck base, 1 at its top. Negative or >1 means outside. */
float cloudHeightFraction( vec3 p ) {
  float alt = length( p - vec3( 0.0, -PLANET_R, 0.0 ) ) - PLANET_R;
  return ( alt - uCloudBottom ) / max( uCloudTop - uCloudBottom, 1.0 );
}

/** Vertical density profile, morphing stratus -> cumulus with uCumuliform. */
float heightGradient( float h ) {
  float stratus = smoothstep( 0.0, 0.06, h ) * ( 1.0 - smoothstep( 0.22, 0.62, h ) );
  float cumulus = smoothstep( 0.0, 0.16, h ) * ( 1.0 - smoothstep( 0.48, 1.0, h ) );
  return mix( stratus, cumulus, uCumuliform );
}

/** Large-scale coverage field. Scrolls with the wind and slowly evolves. */
float weatherCoverage( vec2 xz ) {
  vec2 p = ( xz + uWind ) / uFeatureScale;
  float a = fbm2( p, 4 ) * 0.5 + 0.5;
  float b = fbm2( p * 2.7 + vec2( 19.3, 7.1 ), 3 ) * 0.5 + 0.5;
  float f = mix( a, b, 0.34 );
  return clamp( cRemap( f, 1.0 - uCoverage, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
}

/**
 * Cloud density at a world point.
 * @param cheap skips the detail erosion, for the empty-space search and for
 *   the tail of the light march.
 */
float cloudDensity( vec3 p, bool cheap ) {
  float h = cloudHeightFraction( p );
  if ( h < 0.0 || h > 1.0 ) return 0.0;

  vec3 sp = p + vec3( uWind.x, 0.0, uWind.y );
  float cov = weatherCoverage( p.xz );
  if ( cov <= 0.001 ) return 0.0;

  vec4 shape = texture( uShapeTex, sp / uShapeScale );
  float lowFbm = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
  float base = clamp( cRemap( shape.r, lowFbm - 1.0, 1.0, 0.0, 1.0 ), 0.0, 1.0 );

  base *= heightGradient( h );
  float d = clamp( cRemap( base, 1.0 - cov, 1.0, 0.0, 1.0 ), 0.0, 1.0 ) * cov;
  if ( d <= 0.0 ) return 0.0;

  if ( !cheap ) {
    vec3 det = texture( uDetailTex, sp / uDetailScale ).rgb;
    float hi = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
    // Wispy at the base, billowy at the top.
    hi = mix( 1.0 - hi, hi, clamp( h * 4.0, 0.0, 1.0 ) );
    d = clamp( cRemap( d, hi * uErosion, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
  }
  return d;
}

/** Both roots of |ro + t*rd| = rad. Returns false when the ray misses. */
bool sphereRoots( vec3 ro, vec3 rd, float rad, out float t0, out float t1 ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - rad * rad;
  float disc = b * b - c;
  if ( disc < 0.0 ) return false;
  float s = sqrt( disc );
  t0 = -b - s;
  t1 = -b + s;
  return true;
}

/**
 * Segment of the ray that lies inside the cloud shell.
 * `ro` is relative to the planet centre. Returns (start, end); end < start
 * means the ray never enters the deck.
 */
vec2 cloudShellRange( vec3 ro, vec3 rd ) {
  float rIn = PLANET_R + uCloudBottom;
  float rOut = PLANET_R + uCloudTop;
  float i0, i1, o0, o1;
  bool hitIn = sphereRoots( ro, rd, rIn, i0, i1 );
  bool hitOut = sphereRoots( ro, rd, rOut, o0, o1 );
  if ( !hitOut || o1 < 0.0 ) return vec2( 0.0, -1.0 );

  float r = length( ro );
  if ( r < rIn ) {
    if ( !hitIn || i1 < 0.0 ) return vec2( 0.0, -1.0 );
    return vec2( max( i1, 0.0 ), max( o1, 0.0 ) );
  }
  if ( r > rOut ) {
    if ( o0 < 0.0 ) return vec2( 0.0, -1.0 );
    float end = ( hitIn && i0 > 0.0 ) ? i0 : o1;
    return vec2( o0, end );
  }
  float end = ( hitIn && i0 > 0.0 ) ? i0 : o1;
  return vec2( 0.0, end );
}
`;

/** The full volumetric march. */
export const CLOUD_VOLUMETRIC_FRAG = /* glsl */ `
varying vec2 vUv;

${NOISE_GLSL}
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LUT_SAMPLERS}
${SKYVIEW_PARAM}
${CLOUD_FIELD}

uniform sampler2D uSkyViewLut;
uniform mat4  uInverseViewProjection;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform vec3  uSunRadiance;
uniform vec3  uGroundBounce;
uniform vec3  uCityGlow;
uniform float uViewHeight;      // Mm, for the sky LUT lookup
uniform int   uSteps;
uniform float uFrame;
uniform vec2  uResolution;
uniform float uMaxDistance;
uniform float uAmbientScale;
uniform float uAerialFalloff;

float dualLobe( float cosT, float g0, float g1, float w ) {
  return mix( miePhase( cosT, g0 ), miePhase( cosT, g1 ), w );
}

/** Optical depth from a point toward the sun, in metres of density. */
float lightMarch( vec3 p, vec3 sunDir, float baseStep ) {
  float od = 0.0;
  float t = 0.0;
  for ( int i = 0; i < 6; i ++ ) {
    float s = baseStep * ( 1.0 + float( i ) * 0.62 );
    t += s;
    od += cloudDensity( p + sunDir * t, i < 3 ) * s;
  }
  // One long tap so a distant thunderhead still shadows what is behind it.
  od += cloudDensity( p + sunDir * ( t + baseStep * 10.0 ), true ) * baseStep * 9.0;
  return od;
}

void main() {
  // Reconstruct the world ray for this pixel.
  vec4 clip = vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
  vec4 world = uInverseViewProjection * clip;
  vec3 rd = normalize( world.xyz / world.w - uCameraPos );

  vec3 ro = uCameraPos - vec3( 0.0, -PLANET_R, 0.0 );

  // Rays that meet the ground before the deck see no cloud.
  float g0, g1;
  bool hitGround = sphereRoots( ro, rd, PLANET_R, g0, g1 );
  vec2 range = cloudShellRange( ro, rd );
  if ( range.y <= range.x ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
  if ( hitGround && g0 > 0.0 && g0 < range.x ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  float tStart = range.x;
  float tEnd = min( range.y, tStart + uMaxDistance );
  float span = tEnd - tStart;
  if ( span <= 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  float steps = float( uSteps );
  float ds = span / steps;
  // Blue-noise-ish start offset: turns the marching stairstep into grain that
  // the half-res upsample then hides.
  float jitter = interleavedGradient( gl_FragCoord.xy + vec2( mod( uFrame, 8.0 ) * 5.588, 0.0 ) );

  float cosT = dot( rd, uSunDir );
  vec3 up = vec3( 0.0, 1.0, 0.0 );

  // Ambient: the actual sky above the cloud and the actual ground below it.
  vec3 skyAbove = texture2D( uSkyViewLut, skyViewUv( up, up, uSunDir, uViewHeight ) ).rgb;
  vec3 skyAhead = texture2D( uSkyViewLut, skyViewUv( rd, up, uSunDir, uViewHeight ) ).rgb;

  vec3 scattered = vec3( 0.0 );
  float transmittance = 1.0;
  float depthSum = 0.0;
  float depthWeight = 0.0;

  float t = tStart + ds * jitter;
  float emptyRun = 0.0;

  for ( int i = 0; i < 128; i ++ ) {
    if ( float( i ) >= steps || transmittance < 0.012 || t > tEnd ) break;
    vec3 p = ro + rd * t;

    // Cheap empty-space skipping: while the coarse field is empty, stride.
    if ( emptyRun > 0.0 ) {
      float coarse = cloudDensity( p, true );
      if ( coarse <= 0.0 ) { t += ds * 2.0; continue; }
      emptyRun = 0.0;
      t -= ds; // step back into the boundary before sampling properly
      continue;
    }

    float density = cloudDensity( p, false );
    if ( density <= 0.0005 ) {
      emptyRun = 1.0;
      t += ds;
      continue;
    }

    float sigmaE = density * uDensity;
    float lightOd = lightMarch( p, uSunDir, max( ds * 0.35, 28.0 ) );

    // Three scattering octaves: attenuation, contribution and eccentricity
    // each fall off geometrically. This is what lights the inside of a cloud.
    vec3 energy = vec3( 0.0 );
    float a = 1.0;
    float b = 1.0;
    float c = 1.0;
    for ( int n = 0; n < 3; n ++ ) {
      float ph = dualLobe( cosT, 0.80 * c, -0.28 * c, 0.28 );
      energy += a * exp( -lightOd * uDensity * b ) * ph;
      a *= 0.52;
      b *= 0.58;
      c *= 0.82;
    }

    // Powder: the dark rim you see on the lit side of a cumulus.
    float powder = 1.0 - exp( -density * uDensity * ds * 3.0 );
    float powderMix = 0.5 - 0.5 * cosT;
    energy *= mix( 1.0, powder * 1.9, powderMix * 0.65 );

    float h = clamp( cloudHeightFraction( p ), 0.0, 1.0 );
    vec3 ambient = mix( uGroundBounce + uCityGlow, skyAbove, h * 0.75 + 0.25 ) * uAmbientScale;

    vec3 s = uSunRadiance * energy + ambient;
    float sampleT = exp( -sigmaE * ds );
    // Energy-conserving analytic integration of the segment.
    vec3 integral = ( s * sigmaE - s * sigmaE * sampleT ) / max( sigmaE, 1e-6 );
    scattered += transmittance * integral;

    float w = transmittance * ( 1.0 - sampleT );
    depthSum += t * w;
    depthWeight += w;
    transmittance *= sampleT;

    t += ds;
  }

  float alpha = 1.0 - transmittance;
  float depth = depthWeight > 1e-5 ? depthSum / depthWeight : tStart;

  // Aerial perspective in front of the cloud: fade toward the sky colour in
  // this direction so distant decks sit behind the haze instead of on top.
  float fade = 1.0 - exp( -depth * uAerialFalloff );
  scattered = mix( scattered, skyAhead * alpha, fade * 0.85 );

  gl_FragColor = vec4( scattered, transmittance );
}
`;

/**
 * Billboard fallback for the `low` tier: one analytic layer on the shell,
 * with a three-tap horizontal self-shadow so it still has a lit side and a
 * shaded side. No 3D textures, no march, about a tenth of the cost.
 */
export const CLOUD_BILLBOARD_FRAG = /* glsl */ `
varying vec2 vUv;

${NOISE_GLSL}
${ATMOSPHERE_COMMON}
${ATMOSPHERE_LUT_SAMPLERS}
${SKYVIEW_PARAM}

uniform sampler2D uSkyViewLut;
uniform mat4  uInverseViewProjection;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform vec3  uSunRadiance;
uniform vec3  uGroundBounce;
uniform vec3  uCityGlow;
uniform float uViewHeight;
uniform float uCoverage;
uniform float uDensity;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uFeatureScale;
uniform vec2  uWind;
uniform float uFrame;
uniform float uAerialFalloff;
uniform float uAmbientScale;

#define PLANET_R 6360000.0

float layerCoverage( vec2 xz ) {
  vec2 p = ( xz + uWind ) / uFeatureScale;
  float a = fbm2( p, 5 ) * 0.5 + 0.5;
  float b = fbm2( p * 3.3 + vec2( 11.0, 5.0 ), 4 ) * 0.5 + 0.5;
  float f = mix( a, b, 0.4 );
  return clamp( ( f - ( 1.0 - uCoverage ) ) / max( uCoverage * 0.75, 0.05 ), 0.0, 1.0 );
}

void main() {
  vec4 clip = vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
  vec4 world = uInverseViewProjection * clip;
  vec3 rd = normalize( world.xyz / world.w - uCameraPos );

  vec3 ro = uCameraPos - vec3( 0.0, -PLANET_R, 0.0 );
  float mid = PLANET_R + mix( uCloudBottom, uCloudTop, 0.4 );
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - mid * mid;
  float disc = b * b - c;
  if ( disc < 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
  float t = -b + sqrt( disc );
  if ( t <= 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  vec3 hit = ro + rd * t;
  vec2 xz = hit.xz;

  float cov = layerCoverage( xz );
  if ( cov <= 0.002 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  // Fake thickness, and a three-tap shadow along the sun's ground track.
  float thickness = cov * ( uCloudTop - uCloudBottom );
  vec2 sunStep = normalize( uSunDir.xz + vec2( 1e-4 ) ) * ( uFeatureScale * 0.035 );
  float occ = 0.0;
  occ += layerCoverage( xz + sunStep ) * 0.5;
  occ += layerCoverage( xz + sunStep * 2.4 ) * 0.32;
  occ += layerCoverage( xz + sunStep * 5.0 ) * 0.18;
  float sunUp = clamp( uSunDir.y, 0.0, 1.0 );
  float lightOd = occ * thickness * ( 0.55 / max( sunUp, 0.12 ) );

  float cosT = dot( rd, uSunDir );
  float ph = mix( miePhase( cosT, 0.8 ), miePhase( cosT, -0.28 ), 0.3 );
  vec3 energy = vec3( 0.0 );
  float a = 1.0, bb = 1.0;
  for ( int n = 0; n < 3; n ++ ) {
    energy += a * exp( -lightOd * uDensity * bb ) * ph;
    a *= 0.52;
    bb *= 0.58;
  }

  vec3 up = vec3( 0.0, 1.0, 0.0 );
  vec3 skyAbove = texture2D( uSkyViewLut, skyViewUv( up, up, uSunDir, uViewHeight ) ).rgb;
  vec3 skyAhead = texture2D( uSkyViewLut, skyViewUv( rd, up, uSunDir, uViewHeight ) ).rgb;
  vec3 ambient = mix( uGroundBounce + uCityGlow, skyAbove, 0.7 ) * uAmbientScale;

  float alpha = 1.0 - exp( -thickness * uDensity );
  // Thin the deck near the horizon so it does not become a hard band.
  alpha *= smoothstep( 0.0, 0.05, rd.y );
  vec3 scattered = ( uSunRadiance * energy + ambient ) * alpha;

  float fade = 1.0 - exp( -t * uAerialFalloff );
  scattered = mix( scattered, skyAhead * alpha, fade * 0.85 );

  float d = triDither( gl_FragCoord.xy, mod( uFrame, 64.0 ) );
  alpha = clamp( alpha + d * 0.004, 0.0, 1.0 );

  gl_FragColor = vec4( scattered, 1.0 - alpha );
}
`;

/**
 * Cloud shadows on the city. Renders a top-down transmittance map centred on
 * the camera: for each ground texel, march from the ground toward the sun
 * through the deck and record how much light survives. Eight taps at 256x256
 * is nothing, and it is by far the cheapest way to make a city look like it is
 * under a real sky.
 */
export const CLOUD_SHADOW_FRAG = /* glsl */ `
varying vec2 vUv;

${NOISE_GLSL}
${CLOUD_FIELD}

uniform vec3  uSunDir;
uniform vec2  uShadowCentre;
uniform float uShadowExtent;
uniform float uStrength;

void main() {
  vec2 xz = uShadowCentre + ( vUv - 0.5 ) * uShadowExtent;
  vec3 p = vec3( xz.x, 0.0, xz.y ) - vec3( 0.0, -PLANET_R, 0.0 );

  float sunUp = uSunDir.y;
  if ( sunUp <= 0.02 ) { gl_FragColor = vec4( 1.0 ); return; }

  // Walk the deck in eight even slabs of altitude.
  float lo = uCloudBottom / sunUp;
  float hi = uCloudTop / sunUp;
  float ds = ( hi - lo ) / 8.0;
  float od = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    float t = lo + ( float( i ) + 0.5 ) * ds;
    od += cloudDensity( p + uSunDir * t, true ) * ds;
  }
  float transmittance = exp( -od * uDensity );
  gl_FragColor = vec4( mix( 1.0, transmittance, uStrength ), 0.0, 0.0, 1.0 );
}
`;
