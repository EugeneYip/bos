/**
 * Hash, value-noise and fBm helpers used by the weather map, the cloud
 * shadow pass and the dithering in the sky dome.
 *
 * The heavy 3D Perlin-Worley volumes are generated once on the CPU
 * (see `CloudNoise.ts`); everything here is the cheap 2D work that has to be
 * evaluated per fragment.
 */
export const NOISE_GLSL = /* glsl */ `
#ifndef SKY_NOISE
#define SKY_NOISE

float hash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  p *= p + p;
  return fract( p );
}

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}

float hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

/** Gradient noise in [-1,1]. */
float gradientNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = dot( hash22( i + vec2( 0.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 0.0 ) );
  float b = dot( hash22( i + vec2( 1.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 0.0 ) );
  float c = dot( hash22( i + vec2( 0.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 1.0 ) );
  float d = dot( hash22( i + vec2( 1.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 1.0 ) );
  return 2.0 * mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

/** Five-octave ridged-free fBm in roughly [-1,1]. */
float fbm2( vec2 p, int octaves ) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat2 rot = mat2( 0.8, 0.6, -0.6, 0.8 );
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= octaves ) break;
    sum += amp * gradientNoise2( p );
    norm += amp;
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return sum / max( norm, 1e-4 );
}

/**
 * Interleaved-gradient noise: cheap, well distributed on a pixel grid, and
 * does not have the visible tiling of a value-noise hash. Used for dithering
 * and for jittering raymarch start offsets.
 */
float interleavedGradient( vec2 pixel ) {
  return fract( 52.9829189 * fract( dot( pixel, vec2( 0.06711056, 0.00583715 ) ) ) );
}

/** Triangular-PDF dither value in [-1,1], for band-free gradients. */
float triDither( vec2 pixel, float frame ) {
  float a = interleavedGradient( pixel + vec2( frame * 5.588238, frame * 3.141593 ) );
  float b = interleavedGradient( pixel + vec2( 17.0 - frame * 2.71828, 41.0 + frame * 1.61803 ) );
  return a - b;
}
#endif
`;
