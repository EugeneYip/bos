/**
 * The vegetation shader.
 *
 * Built on `MeshStandardMaterial` so it keeps the Sky module's aerial
 * perspective, cascaded shadows, IBL and tone mapping for free (see
 * `SceneShading.ts` — it enrols any material whose `fog` is not false).
 * Four things are added on top:
 *
 *  - **Wind.** Three frequencies of gust displacing the crown along a wind
 *    direction, plus a high-frequency flutter on the leaf cards only. Phase
 *    comes from the instance's world position, so 88 000 trees never pulse in
 *    unison and a tree keeps its phase as it crosses LOD tiers.
 *  - **Leaf transmission.** `RE_Direct` is overridden so every light also
 *    deposits the fraction that came *through* the leaf. Thin leaves are the
 *    reason a backlit canopy glows instead of reading as a black cut-out, and
 *    this single term is most of what separates a live tree from a prop.
 *  - **Season.** Summer and autumn albedos blended by day-of-year, jittered
 *    per tree and per card so a street turns over three weeks, not overnight.
 *  - **LOD cross-fade.** Interleaved-gradient-noise screen-door dither between
 *    the near, mid and impostor tiers, so nothing pops and nothing has to be
 *    alpha-blended or sorted.
 */
import * as THREE from 'three';
import type { Species } from './species';

export type Lod = 'near' | 'mid' | 'far';
export type Role = 'bark' | 'leaf';

export interface SharedUniforms {
  time: THREE.IUniform<number>;
  /** xy = wind direction, z = strength. */
  wind: THREE.IUniform<THREE.Vector3>;
  season: THREE.IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    time: { value: 0 },
    wind: { value: new THREE.Vector3(0.82, 0.57, 1) },
    season: { value: 0 },
  };
}

/** Cheap, low-discrepancy screen-space dither. Resolves cleanly under TAA. */
const IGN = /* glsl */ `
float vegIGN( vec2 p ) {
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
`;

const VERT_PARS = /* glsl */ `
attribute float foliage;
attribute float lever;
attribute float phase;
uniform float uTime;
uniform vec3  uWind;
uniform float uSway;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uFadeBand;
varying float vFade;
varying float vJitter;
varying float vPhase;
varying float vDist;
`;

/** Runs inside `beginnormal_vertex`, so the billboard yaw reaches the normal. */
const VERT_NORMAL = /* glsl */ `
#ifdef USE_INSTANCING
  vec3 vegOrigin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
  vec3 vegOrigin = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#endif
vDist = distance( cameraPosition, vegOrigin );
vJitter = fract( sin( dot( floor( vegOrigin.xz * 4.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
vPhase = phase;
float vegBc = 1.0;
float vegBs = 0.0;
#ifdef VEG_BILLBOARD
  vec3 vegToCam = cameraPosition - vegOrigin;
  float vegYaw = atan( vegToCam.x, vegToCam.z );
  vegBc = cos( vegYaw );
  vegBs = sin( vegYaw );
  objectNormal.xz = mat2( vegBc, -vegBs, vegBs, vegBc ) * objectNormal.xz;
#endif
`;

const VERT_BODY = /* glsl */ `
float vegPh = vegOrigin.x * 0.0331 + vegOrigin.z * 0.0277 + phase * 6.2831853;
float vegGust = sin( uTime * 0.62 + vegPh ) * 0.58
              + sin( uTime * 1.47 + vegPh * 1.7 ) * 0.27
              + sin( uTime * 3.10 + vegPh * 3.3 ) * 0.11;
float vegAmp = lever * uSway * uWind.z;
transformed.x += vegGust * vegAmp * 0.062 * uWind.x;
transformed.z += vegGust * vegAmp * 0.062 * uWind.y;
// Leaf cards also flutter about their own axis, much faster and much smaller.
float vegFlut = sin( uTime * 5.7 + phase * 37.0 ) + 0.6 * sin( uTime * 9.1 + phase * 61.0 );
transformed += foliage * vegFlut * vegAmp * 0.011 * normalize( vec3( uWind.x, 0.7, uWind.y ) );

#ifdef VEG_BILLBOARD
  transformed.xz = mat2( vegBc, -vegBs, vegBs, vegBc ) * transformed.xz;
#endif

vFade = smoothstep( uFadeIn, uFadeIn + uFadeBand, vDist )
      * ( 1.0 - smoothstep( uFadeOut - uFadeBand, uFadeOut, vDist ) );

// A tier that is entirely faded out still rasterises — and a 16 m impostor
// standing 10 m from the camera covers the whole screen in fragments that all
// get discarded. Collapse the primitive instead: zero area, zero fill.
if ( vFade <= 0.002 ) transformed = vec3( 0.0 );
`;

const FRAG_PARS = /* glsl */ `
varying float vFade;
varying float vJitter;
varying float vPhase;
varying float vDist;
uniform float uSeason;
uniform float uTurnBias;
uniform vec3  uSummer;
uniform vec3  uAutumn;
uniform float uDistWash;
${IGN}
`;

/**
 * Thin-leaf transmission, added to every light *after* its shadow and cascade
 * weight have been applied, so a leaf in shadow does not glow.
 */
const TRANSMISSION = /* glsl */ `
uniform vec3  uTransTint;
uniform float uTransAmount;

void RE_Direct_Veg( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

  // How much of this light is arriving from behind the leaf.
  float behind = clamp( -dot( geometryNormal, directLight.direction ), 0.0, 1.0 );
  // Wrapped diffuse: leaves scatter round the terminator instead of cutting.
  float wrap = clamp( ( dot( geometryNormal, directLight.direction ) + 0.75 ) / 1.75, 0.0, 1.0 );
  // Forward lobe: strongest when you are looking toward the sun through the tree.
  float through = pow( clamp( dot( geometryViewDir, -directLight.direction ), 0.0, 1.0 ), 2.5 );

  vec3 t = directLight.color * uTransTint * ( through * 1.7 + 0.30 )
         * ( behind * 0.9 + wrap * 0.28 );
  reflectedLight.directDiffuse += t * uTransAmount * RECIPROCAL_PI * material.diffuseColor;
}

#undef RE_Direct
#define RE_Direct RE_Direct_Veg
`;

export interface MaterialOptions {
  species: Species;
  lod: Lod;
  role: Role;
  map: THREE.Texture;
  shared: SharedUniforms;
  fadeIn: number;
  fadeOut: number;
  fadeBand: number;
  envMapIntensity: number;
}

export interface VegMaterial {
  material: THREE.MeshStandardMaterial;
  fadeIn: THREE.IUniform<number>;
  fadeOut: THREE.IUniform<number>;
}

export function createVegMaterial(o: MaterialOptions): VegMaterial {
  const { species: sp, lod, role } = o;
  const leaf = role === 'leaf';

  const mat = new THREE.MeshStandardMaterial({
    name: `veg:${sp.name}:${lod}:${role}`,
    map: o.map,
    color: 0xffffff,
    roughness: leaf ? (lod === 'far' ? 0.95 : 0.78) : 0.94,
    metalness: 0,
    side: leaf ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: leaf ? (lod === 'far' ? 0.22 : lod === 'mid' ? 0.3 : 0.36) : 0,
    transparent: false,
    envMapIntensity: o.envMapIntensity,
    dithering: true,
  });

  const fadeIn: THREE.IUniform<number> = { value: o.fadeIn };
  const fadeOut: THREE.IUniform<number> = { value: o.fadeOut };
  const fadeBand: THREE.IUniform<number> = { value: o.fadeBand };

  const summer = new THREE.Color(sp.summerColor).convertSRGBToLinear();
  const autumn = new THREE.Color(sp.autumnColor).convertSRGBToLinear();
  const bark = new THREE.Color(sp.barkColor).convertSRGBToLinear();

  mat.defines = mat.defines ?? {};
  if (lod === 'far') {
    (mat.defines as Record<string, unknown>).VEG_BILLBOARD = '';
    (mat.defines as Record<string, unknown>).VEG_FADE_INVERT = '';
  }
  if (leaf) (mat.defines as Record<string, unknown>).VEG_LEAF = '';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = o.shared.time;
    shader.uniforms.uWind = o.shared.wind;
    shader.uniforms.uSeason = o.shared.season;
    shader.uniforms.uSway = { value: leaf ? sp.sway : sp.sway * 0.45 };
    shader.uniforms.uFadeIn = fadeIn;
    shader.uniforms.uFadeOut = fadeOut;
    shader.uniforms.uFadeBand = fadeBand;
    shader.uniforms.uSummer = { value: leaf ? summer : bark };
    shader.uniforms.uAutumn = { value: leaf ? autumn : bark };
    shader.uniforms.uTurnBias = { value: leaf ? sp.turnBias : 0 };
    shader.uniforms.uTransTint = { value: new THREE.Vector3(1.05, 1.3, 0.5) };
    shader.uniforms.uTransAmount = { value: leaf ? (lod === 'far' ? 1.25 : 0.95) : 0 };
    shader.uniforms.uDistWash = { value: lod === 'far' ? 1 : lod === 'mid' ? 0.35 : 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        {
          // Autumn arrives tree by tree and card by card.
          float turn = clamp( uSeason * uTurnBias * ( 0.55 + 0.95 * vJitter )
                            - 0.22 * ( 1.0 - vPhase ), 0.0, 1.0 );
          vec3 canopy = mix( uSummer, uAutumn, turn );
          diffuseColor.rgb *= canopy * ( 0.84 + 0.32 * vJitter );

          // Distant foliage loses contrast and saturation before the haze even
          // touches it; without this, impostors read as dark specks.
          float wash = uDistWash * smoothstep( 260.0, 2400.0, vDist );
          float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb,
            mix( vec3( lum ), diffuseColor.rgb, 0.45 ) * 1.28 + vec3( 0.035, 0.045, 0.040 ),
            wash * 0.8 );
        }
      `);

    if (leaf) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_physical_pars_fragment>',
          `#include <lights_physical_pars_fragment>\n${TRANSMISSION}`)
        .replace('#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          // Undo three's double-sided flip: the card's normals were authored
          // pointing out of the crown and the back of a leaf really does face
          // away from the viewer. Transmission handles the rest.
          normal *= faceDirection;
        `);
    }

    // The impostor's dither is the *complement* of the mid tier's, so across
    // the hand-over band the two tiers tile the pixels between them exactly
    // instead of both drawing the same tree into the same pixels.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <dithering_fragment>', /* glsl */ `
        #include <dithering_fragment>
        #ifdef VEG_FADE_INVERT
          if ( vFade < 1.0 - vegIGN( gl_FragCoord.xy ) ) discard;
        #else
          if ( vFade < vegIGN( gl_FragCoord.xy ) ) discard;
        #endif
      `);
  };

  mat.customProgramCacheKey = () => `veg|${sp.name}|${lod}|${role}`;
  return { material: mat, fadeIn, fadeOut };
}

/** Ground cover shares the tree shader minus the LOD machinery. */
export function createGroundMaterial(
  name: string,
  map: THREE.Texture,
  shared: SharedUniforms,
  summerColor: number,
  autumnColor: number,
  opts: { sway: number; alphaTest: number; fadeOut: number; turnBias: number },
): VegMaterial {
  return createVegMaterial({
    species: {
      name,
      height: 1, spread: 1, crownBase: 0, shape: 'rounded', leaf: 'ovate',
      bark: 'ridged', conifer: false, limbs: 1, density: 1, cardScale: 1,
      trunkRadius: 0.02,
      summerColor, autumnColor, barkColor: summerColor,
      sway: opts.sway, turnBias: opts.turnBias,
      habitat: { street: 0, park: 1, forest: 1, lawn: 1 },
    },
    lod: 'near',
    role: 'leaf',
    map,
    shared,
    fadeIn: -1e6,
    fadeOut: opts.fadeOut,
    fadeBand: Math.min(30, opts.fadeOut * 0.28),
    envMapIntensity: 1,
  });
}
