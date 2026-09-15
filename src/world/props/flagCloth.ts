/**
 * Cloth for the city's flags: the geometry, the wind, and the shader that
 * makes a rectangle behave like bunting.
 *
 * **The local frame.** Every flag — facade staff, roof pole, or a five-storey
 * banner — is authored in the same space, so one shader serves all three:
 *
 *   +X   the *fly*, running from the sleeve at x = 0 out to the free edge
 *   +Y   the *hoist*, running along the staff; y = hoist is the union end
 *   +Z   the flag's own normal, and the axis the wave displaces along
 *
 * The instance matrix does the rest. A roof pole maps +Y to world up; a
 * facade staff maps it 42 degrees out of the wall; a hanging banner maps +X
 * straight down. `uv.x` is the fly coordinate and `uv.y` the hoist one, which
 * is all the shader needs, so a builder is free to translate the sheet
 * anywhere in local space with `ClothOptions.offset`.
 *
 * **The motion.** A still flag reads as sheet metal, so:
 *
 *  - A travelling wave along the fly, two frequencies, with amplitude rising
 *    as `u^1.45` from the sleeve — cloth clamped along one edge cannot move
 *    there and moves most at the far corner.
 *  - A spanwise skew on the phase, so a crest runs diagonally across the
 *    sheet rather than as a straight bar, and a twist term weighted by
 *    `(v - 0.5)` that rolls the top and bottom of the free edge opposite
 *    ways. That is the furl, and it is what stops the flag looking like a
 *    corrugated roof.
 *  - Arc-length compensation. A rippling flag does not reach as far as a flat
 *    one; without the pull-in the cloth visibly stretches on every gust.
 *  - Analytic normals from the wave's own derivatives. This is the term that
 *    actually sells it: the folds have to *shade*, or the flag is a waving
 *    photograph.
 *  - A swing about the hoist axis. On a free-rotating pole that swing is the
 *    full wind alignment (`FLAG_VANE`), so flags across the city all stream
 *    the same way and veer together as the prevailing wind drifts.
 *
 * The wind driver is the trees' — same two-term direction wander, same
 * gustiness curve (see `world/vegetation/material.ts`). It is reproduced here
 * rather than shared because the vegetation module keeps its uniforms private;
 * both accumulate `dt` from frame one, so the city gusts as one.
 */
import * as THREE from 'three';

export type FlagMount = 'staff' | 'pole' | 'banner';

export interface FlagWind {
  time: THREE.IUniform<number>;
  /** xy = wind direction in world XZ, z = gustiness around 0.75. */
  wind: THREE.IUniform<THREE.Vector3>;
}

export function createFlagWind(): FlagWind {
  return { time: { value: 0 }, wind: { value: new THREE.Vector3(0.9394, 0.3429, 0.75) } };
}

/** The trees' driver, to the letter, so canopy and cloth gust together. */
export function advanceFlagWind(w: FlagWind, dt: number): void {
  w.time.value += dt;
  const t = w.time.value;
  const a = 0.35 + Math.sin(t * 0.031) * 0.55;
  const gust = 0.75 + 0.35 * Math.sin(t * 0.11 + 1.3);
  w.wind.value.set(Math.cos(a), Math.sin(a), gust);
}

/** The prevailing direction at t = 0, used to aim flags at build time. */
export const FLAG_WIND0 = new THREE.Vector2(Math.cos(0.35), Math.sin(0.35));

export interface ClothOptions {
  fly: number;
  hoist: number;
  segU: number;
  segV: number;
  /**
   * Reverse the hoist coordinate in UV. A banner hung with its hoist along the
   * top has to be turned to get the union uppermost *and* to the observer's
   * left; mirroring across the hoist axis does it, and on the US flag that
   * mirror is invisible — the stripe sequence is a palindrome.
   */
  mirrorHoist?: boolean;
  /** Translation applied after the sheet is built, in local metres. */
  offset?: THREE.Vector3;
}

/**
 * A quad grid in the XY plane, normal +Z. Enough segments along the fly to
 * carry two or three wavelengths without faceting.
 */
export function clothGeometry(o: ClothOptions): THREE.BufferGeometry {
  const nu = Math.max(2, o.segU);
  const nv = Math.max(1, o.segV);
  const verts = (nu + 1) * (nv + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const ox = o.offset?.x ?? 0;
  const oy = o.offset?.y ?? 0;
  const oz = o.offset?.z ?? 0;

  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const k = j * (nu + 1) + i;
      pos[k * 3] = ox + u * o.fly;
      pos[k * 3 + 1] = oy + v * o.hoist;
      pos[k * 3 + 2] = oz;
      nrm[k * 3 + 2] = 1;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = o.mirrorHoist ? 1 - v : v;
    }
  }

  const idx: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      // CCW seen from +Z, so the authored normal is the front face.
      idx.push(a, b, d, a, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

const PARS = /* glsl */ `
uniform float uTime;
uniform vec3  uWind;
uniform vec2  uSize;
uniform vec4  uWave;
uniform vec3  uSag;
uniform vec2  uSwing;
vec3 flagPos;
vec3 flagNrm;

void flagSolve() {
  // Phase from the instance's world origin rather than an instanced
  // attribute: distance culling compacts the matrix buffer every time the
  // camera moves, and an attribute that did not move with it would hand each
  // flag a new phase — a whole street snapping mid-gust.
#ifdef USE_INSTANCING
  vec3 flagOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
  vec3 flagOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#endif
  float ph = fract( sin( dot( floor( flagOrg.xz * 3.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 )
           * 6.2831853;
  float u = uv.x;
  float v = uv.y;

  float gust = 0.55 + 0.60 * uWind.z;
  float amp  = uWave.x * gust * pow( u, 1.45 );
  float dAmp = uWave.x * gust * 1.45 * pow( max( u, 1e-3 ), 0.45 );

  // Spatial frequency in radians per metre, so a small flag ripples and a
  // five-storey banner rolls.
  float k  = 6.2831853 / max( uWave.y, 0.05 );
  float kx = k * uSize.x;
  float w  = uTime * uWave.z * ( 0.70 + 0.50 * uWind.z ) - kx * u + ph + v * 1.25;

  float s1 = sin( w ), c1 = cos( w );
  float s2 = sin( w * 2.17 + 1.7 ), c2 = cos( w * 2.17 + 1.7 );
  float f  = s1 + 0.38 * s2;
  float df = c1 + 0.8246 * c2;

  // Furl: the free edge rolls, top and bottom in opposite directions.
  float tw = uWave.w * ( v - 0.5 ) * 2.0;
  float z    = amp * ( f + tw * s1 * 0.85 );
  float dzdu = dAmp * ( f + tw * s1 * 0.85 ) - amp * ( df + tw * c1 * 0.85 ) * kx;
  float dzdv = amp * ( df * 1.25 + uWave.w * 1.70 * s1 + tw * c1 * 0.85 * 1.25 );

  vec3 p = position;
  p.z += z;
  // Arc length: ripples eat reach.
  p.x -= 0.5 * amp * amp * k * u;
  p += uSag * ( u * u );

  vec3 nrm = normalize( vec3( -dzdu / uSize.x, -dzdv / uSize.y, 1.0 ) );

  float sw = uSwing.y
           + uSwing.x * ( 0.62 * sin( uTime * 0.31 + ph ) + 0.38 * sin( uTime * 0.73 + ph * 1.7 ) );
#ifdef FLAG_VANE
  // Free to rotate about the pole, so it points downwind like a windsock.
  #ifdef USE_INSTANCING
    vec3 ax = instanceMatrix[ 0 ].xyz;
  #else
    vec3 ax = vec3( 1.0, 0.0, 0.0 );
  #endif
  float d = atan( uWind.x, uWind.y ) - atan( ax.x, ax.z );
  sw += atan( sin( d ), cos( d ) ) * ( 0.86 + 0.14 * fract( ph ) );
#endif
  float ca = cos( sw ), sa = sin( sw );
  // Rotate about the hoist axis, pivoting on the sleeve at x = 0.
  p.xz   = vec2( p.x * ca + p.z * sa, -p.x * sa + p.z * ca );
  nrm.xz = vec2( nrm.x * ca + nrm.z * sa, -nrm.x * sa + nrm.z * ca );

  flagPos = p;
  flagNrm = nrm;
}
`;

export interface FlagMaterialOptions {
  name: string;
  map: THREE.Texture;
  wind: FlagWind;
  mount: FlagMount;
  /** Flag size in metres, (fly, hoist), for the wave's physical scaling. */
  size: THREE.Vector2;
  /** Peak out-of-plane displacement at the free edge, metres. */
  amplitude: number;
  /** Wavelength along the fly, metres. */
  wavelength: number;
  /** Temporal frequency, radians per second. */
  speed: number;
  /** Furl weight at the free edge, 0..1. */
  twist: number;
  /** Local-space sag at the free edge, metres. */
  sag: THREE.Vector3;
  /** Swing about the hoist axis: (oscillation amplitude, bias) in radians. */
  swing: THREE.Vector2;
  envMapIntensity?: number;
}

/**
 * Bunting, lit like bunting. Plain `MeshStandardMaterial` so it inherits the
 * sky module's aerial perspective, cascaded shadows and IBL — and pointedly
 * no emissive term: a flag is dyed cotton, and at night it should go dark
 * with the wall behind it.
 */
export function createFlagMaterial(o: FlagMaterialOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: `flag:${o.name}`,
    map: o.map,
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: o.envMapIntensity ?? 0.85,
    dithering: true,
  });

  mat.defines = mat.defines ?? {};
  if (o.mount === 'pole') (mat.defines as Record<string, unknown>).FLAG_VANE = '';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = o.wind.time;
    shader.uniforms.uWind = o.wind.wind;
    shader.uniforms.uSize = { value: o.size };
    shader.uniforms.uWave = {
      value: new THREE.Vector4(o.amplitude, o.wavelength, o.speed, o.twist),
    };
    shader.uniforms.uSag = { value: o.sag };
    shader.uniforms.uSwing = { value: o.swing };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  flagSolve();\n  objectNormal = flagNrm;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = flagPos;');
  };

  mat.customProgramCacheKey = () => `flag-cloth|${o.name}|${o.mount}`;
  return mat;
}
