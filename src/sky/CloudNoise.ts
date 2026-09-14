import * as THREE from 'three';
import { FullScreenPass, PASS_VERT } from './util';

/**
 * The two tiling 3D noise volumes the cloud raymarcher samples. Both are
 * generated on the GPU at startup — one draw call per Z slice into a
 * `WebGL3DRenderTarget` — which costs a few milliseconds instead of the
 * second-plus a JavaScript implementation would need.
 *
 * Recipe follows Schneider & Vos, *The Real-Time Volumetric Cloudscapes of
 * Horizon Zero Dawn* (SIGGRAPH 2015):
 *
 *   shape   96^3 RGBA   R = Perlin-Worley, G/B/A = Worley fBm at 1x / 2x / 4x
 *   detail  32^3 RGBA   Worley fBm at 1x / 2x / 4x, for edge erosion
 *
 * Both volumes tile exactly, so they can be repeated across tens of kilometres
 * of sky without a seam. Worley cells wrap with a modulo on the cell index and
 * the distance is measured in unwrapped cell space, which is what makes the
 * seam disappear.
 */

const NOISE3_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uSlice;    // 0..1 centre of this Z slice

vec3 hash33( vec3 p ) {
  p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ),
            dot( p, vec3( 269.5, 183.3, 246.1 ) ),
            dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
  return fract( sin( p ) * 43758.5453123 );
}

/** Tiling Worley. Returns 1 at a feature point, falling to 0 between cells. */
float worley( vec3 p, float cells ) {
  vec3 sp = p * cells;
  vec3 base = floor( sp );
  float best = 1e9;
  for ( int z = -1; z <= 1; z ++ ) {
    for ( int y = -1; y <= 1; y ++ ) {
      for ( int x = -1; x <= 1; x ++ ) {
        vec3 cell = base + vec3( float( x ), float( y ), float( z ) );
        vec3 pt = cell + hash33( mod( cell, vec3( cells ) ) );
        vec3 d = sp - pt;
        best = min( best, dot( d, d ) );
      }
    }
  }
  return 1.0 - clamp( sqrt( best ), 0.0, 1.0 );
}

float worleyFbm( vec3 p, float a, float b, float c ) {
  return worley( p, a ) * 0.625 + worley( p, b ) * 0.25 + worley( p, c ) * 0.125;
}

/** Tiling 3D gradient noise, roughly [-0.7, 0.7]. */
float perlin( vec3 p, float cells ) {
  vec3 sp = p * cells;
  vec3 i = floor( sp );
  vec3 f = fract( sp );
  vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float n = 0.0;
  for ( int k = 0; k < 8; k ++ ) {
    vec3 o = vec3( float( k & 1 ), float( ( k >> 1 ) & 1 ), float( ( k >> 2 ) & 1 ) );
    vec3 g = normalize( hash33( mod( i + o, vec3( cells ) ) ) * 2.0 - 1.0 );
    float w = mix( 1.0 - u.x, u.x, o.x ) * mix( 1.0 - u.y, u.y, o.y ) * mix( 1.0 - u.z, u.z, o.z );
    n += dot( g, f - o ) * w;
  }
  return n;
}

float perlinFbm( vec3 p, float cells ) {
  return perlin( p, cells ) * 0.55 + perlin( p, cells * 2.0 ) * 0.3 + perlin( p, cells * 4.0 ) * 0.15;
}

float remap( float v, float a, float b, float c, float d ) {
  return c + ( v - a ) / ( b - a ) * ( d - c );
}
`;

const SHAPE_FRAG = /* glsl */ `
${NOISE3_GLSL}
void main() {
  vec3 p = vec3( vUv, uSlice );
  float pfbm = clamp( perlinFbm( p, 4.0 ) * 1.6 + 0.5, 0.0, 1.0 );
  float w4 = worleyFbm( p, 4.0, 8.0, 16.0 );
  float w8 = worleyFbm( p, 8.0, 16.0, 24.0 );
  float w16 = worleyFbm( p, 16.0, 24.0, 32.0 );
  // Perlin-Worley: dilate the Perlin field with the Worley so the noise gets
  // the billowy, connected look of convective cloud instead of soap suds.
  float pw = clamp( remap( pfbm, w4 - 1.0, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
  gl_FragColor = vec4( pw, w4, w8, w16 );
}
`;

const DETAIL_FRAG = /* glsl */ `
${NOISE3_GLSL}
void main() {
  vec3 p = vec3( vUv, uSlice );
  gl_FragColor = vec4(
    worleyFbm( p, 3.0, 6.0, 12.0 ),
    worleyFbm( p, 6.0, 12.0, 24.0 ),
    worleyFbm( p, 12.0, 24.0, 32.0 ),
    1.0
  );
}
`;

export interface CloudVolumes {
  shape: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  /** Milliseconds spent generating, for the stats readout. */
  buildMs: number;
  dispose(): void;
}

/** Builds both volumes. Call once, after the renderer exists. */
export function buildCloudVolumes(
  renderer: THREE.WebGLRenderer,
  shapeSize = 96,
  detailSize = 32,
): CloudVolumes {
  const t0 = performance.now();
  const shapeRt = renderVolume(renderer, shapeSize, SHAPE_FRAG);
  const detailRt = renderVolume(renderer, detailSize, DETAIL_FRAG);
  return {
    shape: shapeRt.texture as THREE.Data3DTexture,
    detail: detailRt.texture as THREE.Data3DTexture,
    buildMs: performance.now() - t0,
    dispose(): void {
      shapeRt.dispose();
      detailRt.dispose();
    },
  };
}

/** Renders `frag` into every Z slice of a fresh 3D render target. */
function renderVolume(
  renderer: THREE.WebGLRenderer,
  size: number,
  frag: string,
): THREE.WebGL3DRenderTarget {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.wrapR = THREE.RepeatWrapping;
  rt.texture.colorSpace = THREE.NoColorSpace;

  const material = new THREE.ShaderMaterial({
    vertexShader: PASS_VERT,
    fragmentShader: frag,
    uniforms: { uSlice: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const pass = new FullScreenPass(material);

  for (let z = 0; z < size; z++) {
    material.uniforms.uSlice.value = (z + 0.5) / size;
    // The second argument of setRenderTarget selects the layer for 3D targets.
    pass.render(renderer, rt as unknown as THREE.WebGLRenderTarget, z);
  }
  renderer.setRenderTarget(null);
  material.dispose();
  return rt;
}
