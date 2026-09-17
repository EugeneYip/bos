/**
 * The vegetation shader.
 *
 * Built on `MeshStandardMaterial` so it keeps the Sky module's aerial
 * perspective, cascaded shadows, IBL and tone mapping for free (see
 * `SceneShading.ts` — it enrols any material whose `fog` is not false).
 * Five things are added on top:
 *
 *  - **Wind.** Three frequencies of gust displacing the crown along a wind
 *    direction, plus a high-frequency flutter on the leaf cards only. Phase
 *    comes from the instance's world position, so 89 000 trees never pulse in
 *    unison and a tree keeps its phase as it crosses LOD tiers.
 *  - **Leaf transmission,** both halves. `RE_Direct` is overridden so every
 *    light also deposits the fraction that came *through* the leaf, and the
 *    IBL gather gains the opposite hemisphere for the same reason. Thin leaves
 *    are why a backlit canopy glows instead of reading as a black cut-out —
 *    and under a *closed* canopy, where there is no direct sun to transmit,
 *    the indirect half is very nearly the only light there is.
 *  - **Canopy skylight.** The remaining half of that problem: a trunk, and the
 *    inside of a crown, are lit almost entirely by sky that has already passed
 *    through the leaves above. The renderer's only occlusion is screen-space,
 *    which under a closed canopy removes essentially all of the ambient, so
 *    Boston Common's trunks rendered as black cut-outs at three in the
 *    afternoon. A small green-tinted upward gather, keyed to the real sky so
 *    it vanishes at night, puts it back.
 *  - **Season.** A *turn clock* rather than a turn amount: every tree carries
 *    its own threshold, derived from the species' bias and a per-tree hash, and
 *    colours over a couple of weeks once the clock passes it. A crown turns
 *    from the outside in, and a tree that turned a fortnight ago has already
 *    gone dull brown. Which is how a Boston October actually looks: green,
 *    turning and spent trees in the same block.
 *  - **LOD cross-fade.** Interleaved-gradient-noise screen-door dither between
 *    the near, mid and impostor tiers, so nothing pops and nothing has to be
 *    alpha-blended or sorted. The impostor's own two cards — a crossed
 *    vertical pair and a horizontal canopy plate — are partitioned by the same
 *    dither on the view's elevation angle, so the plate is invisible at eye
 *    level and carries the whole tree from overhead.
 */
import * as THREE from 'three';
import { SENESCENT, type Species } from './species';

export type Lod = 'near' | 'mid' | 'far';
export type Role = 'bark' | 'leaf';

export interface SharedUniforms {
  time: THREE.IUniform<number>;
  /** xy = wind direction, z = strength. */
  wind: THREE.IUniform<THREE.Vector3>;
  /** Progress through the autumn turn, 0 = summer, 1 = the far end. */
  season: THREE.IUniform<number>;
  /**
   * Per-frame offset into the dither pattern. Zero disables it.
   * @see vegIGN
   */
  dither: THREE.IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    time: { value: 0 },
    wind: { value: new THREE.Vector3(0.82, 0.57, 1) },
    season: { value: 0 },
    dither: { value: 0 },
  };
}

/**
 * Cheap, low-discrepancy screen-space dither, offset per frame.
 *
 * It used to be purely spatial, on the claim that TAA would resolve it. TAA
 * cannot: `gl_FragCoord.xy` is the pixel centre, so a still camera discards
 * exactly the same pixels every frame and the accumulator averages identical
 * images. A tree parked halfway through a cross-fade therefore rendered as a
 * permanent chain-link mesh -- plainly visible in the Common at every tier,
 * ultra included, which is where this was finally caught.
 *
 * `uDither` walks the pattern by the golden ratio each frame, so a different
 * half of the pixels survives each time and TAA integrates a real blend.
 *
 * With no accumulator -- the low tier turns TAA off -- there is nothing to
 * integrate, and a moving pattern would be worse than a still one: the canopy
 * would fizz. `uDither` goes negative there instead, and the hand-over
 * becomes a hard switch at the middle of the band. That pops when the camera
 * moves, which is what an LOD does on hardware that cannot afford the blend,
 * and it is a great deal better than a chain-link mesh that never resolves.
 *
 * Every tier's test reads this same function and the same uniform, so the
 * exact partitions between them -- near against mid, mid against impostor,
 * and the impostor's own cards against its canopy plate -- still tile the
 * pixels between them with no gaps and no double coverage.
 */
const IGN = /* glsl */ `
uniform float uDither;
float vegIGN( vec2 p ) {
  p += max( uDither, 0.0 );
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
/**
 * The threshold a LOD hand-over compares its fade against. A constant 0.5 is
 * still an exact partition, because the two tiers meeting in a band carry
 * complementary fades -- one is above 0.5 exactly where the other is below.
 */
float vegFadeCut( vec2 p ) { return uDither < 0.0 ? 0.5 : vegIGN( p ); }
`;

const VERT_PARS = /* glsl */ `
attribute float foliage;
attribute float lever;
attribute float phase;
attribute float cardKind;
uniform float uTime;
uniform vec3  uWind;
uniform float uSway;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uFadeBand;
uniform float uFadeInBand;
varying float vFade;
varying float vJitter;
varying float vPhase;
varying float vLever;
varying float vDist;
varying float vCardMix;
varying float vCardKind;
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
vLever = lever;
vCardKind = cardKind;
vCardMix = 1.0;
float vegBc = 1.0;
float vegBs = 0.0;
#ifdef VEG_BILLBOARD
  vec3 vegToCam = cameraPosition - vegOrigin;
  float vegYaw = atan( vegToCam.x, vegToCam.z );
  vegBc = cos( vegYaw );
  vegBs = sin( vegYaw );
  objectNormal.xz = mat2( vegBc, -vegBs, vegBs, vegBc ) * objectNormal.xz;
  // Elevation of the camera above the tree: 0 looking along the ground, 1
  // straight down. The share of pixels the crossed vertical cards keep.
  //
  // The hand-over has to be *late and narrow*. The two cards cover different
  // pixels, so partitioning them by a screen-door dither punches holes in
  // whichever one is losing, and the dark ground shows through: at a 0.20-0.66
  // band a 25-degree oblique — which is every aerial shot of the city — ran a
  // permanent 30/70 screen door over the whole distant canopy and turned the
  // Fens into black static. A vertical billboard still presents plenty of
  // area at 40 degrees, so it keeps everything until 38 and is gone by 62.
  float vegUp = abs( vegToCam.y ) / max( length( vegToCam ), 1e-3 );
  vCardMix = 1.0 - smoothstep( 0.62, 0.88, vegUp );
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
// A branch under load twists as well as bends; without it a close-range crown
// slides sideways as one rigid lump.
transformed += foliage * vegAmp * 0.016 * vec3(
  sin( uTime * 2.3 + phase * 19.0 ), sin( uTime * 1.9 + phase * 11.0 ) * 0.6,
  cos( uTime * 2.1 + phase * 23.0 ) );

#ifdef VEG_BILLBOARD
  transformed.xz = mat2( vegBc, -vegBs, vegBs, vegBc ) * transformed.xz;
#endif

// The fade-in and fade-out spans are independent widths (uFadeInBand,
// uFadeBand): mid is the one lod with both terms active at once, and its
// near-side hand-over has to survive a single 'Vegetation.rebuild' step
// (trees are only re-triaged every REBUILD_MOVE metres of camera travel),
// while its far-side one is the already-tuned, purely distance-driven
// mid/impostor cross-fade. They must not share a width.
vFade = smoothstep( uFadeIn, uFadeIn + uFadeInBand, vDist )
      * ( 1.0 - smoothstep( uFadeOut - uFadeBand, uFadeOut, vDist ) );

// A tier that is entirely faded out still rasterises — and a 16 m impostor
// standing 10 m from the camera covers the whole screen in fragments that all
// get discarded. Collapse the primitive instead: zero area, zero fill.
bool vegDead = vFade <= 0.002;
#ifdef VEG_BILLBOARD
  vegDead = vegDead
    || ( cardKind < 0.5 && vCardMix <= 0.003 )
    || ( cardKind > 0.5 && vCardMix >= 0.997 );
#endif
if ( vegDead ) transformed = vec3( 0.0 );
`;

const FRAG_PARS = /* glsl */ `
varying float vFade;
varying float vJitter;
varying float vPhase;
varying float vLever;
varying float vDist;
varying float vCardMix;
varying float vCardKind;
uniform float uSeason;
uniform float uTurnBias;
uniform vec3  uSummer;
uniform vec3  uAutumn;
uniform vec3  uSenescent;
uniform float uDistWash;
uniform float uMapMean;
// Declared here too (not just in VERT_PARS) because VEG_NEARMID's dither
// split needs them on the fragment side, to pick which of the two boundaries
// this fragment is closer to.
uniform float uFadeIn;
uniform float uFadeInBand;
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

/**
 * The indirect half of the same physics, and the half that was missing.
 *
 * `RE_Direct_Veg` handles sunlight arriving through a leaf, but under a closed
 * canopy direct sun is precisely the thing that is not there — what lights the
 * interior of a tree, the trunk, and the ground beneath it is *skylight* that
 * has come through the leaves above. Without this term that path carries no
 * light at all, and Boston Common's tree line rendered as a black cut-out
 * against the sky even at three in the afternoon.
 *
 * It also rescues the ground cover. Grass tufts are double-sided cards whose
 * normals are deliberately not flipped for the back face (see the
 * `normal_fragment_begin` patch below), so every back-facing card was gathering
 * its irradiance from the lower hemisphere and coming out pure black; sampling
 * the opposite hemisphere as well is exactly what a translucent blade does.
 *
 * `uCanopy` is the second term: a flat upward gather that every part of a tree
 * gets, leaf and bark alike. It is deliberately *not* occluded — the renderer
 * has no idea a crown is above a trunk, and its screen-space AO overstates the
 * case badly, so this is the term that stands in for multiply-scattered
 * skylight and green bounce off the leaves.
 */
const INDIRECT_TRANSMISSION = /* glsl */ `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  #ifdef VEG_LEAF
    iblIrradiance += getIBLIrradiance( -geometryNormal ) * uTransTint * uTransAmount * 0.55;
  #endif
  iblIrradiance += getIBLIrradiance( vec3( 0.0, 1.0, 0.0 ) ) * uCanopyTint * uCanopy;
#endif
`;

export interface MaterialOptions {
  species: Species;
  lod: Lod;
  role: Role;
  map: THREE.Texture;
  shared: SharedUniforms;
  fadeIn: number;
  fadeOut: number;
  /** Width of the fade-*out* span (uFadeOut - fadeBand .. uFadeOut). */
  fadeBand: number;
  /**
   * Width of the fade-*in* span (uFadeIn .. uFadeIn + fadeInBand). Defaults to
   * `fadeBand` — every lod except mid only ever has one of the two terms
   * active, so one width serves both until mid needs them to differ.
   */
  fadeInBand?: number;
  envMapIntensity: number;
  /** Extra un-occluded skylight, standing in for canopy multiple scattering. */
  canopy?: number;
  alphaTest?: number;
  /**
   * Mean linear luminance of `map`, from `textures.mapMean`. The shader divides
   * the map through by it so the species tint lands on the albedo asked for.
   */
  mapMean?: number;
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
    // A card carrying 150 small leaves loses alpha fast down the mip chain,
    // so the test has to be low enough that a crown does not erode into lace
    // at 80 m. 0.36 was tuned for cards holding six huge leaves.
    alphaTest: leaf ? (o.alphaTest ?? (lod === 'far' ? 0.2 : lod === 'mid' ? 0.22 : 0.26)) : 0,
    transparent: false,
    envMapIntensity: o.envMapIntensity,
    dithering: true,
  });

  const fadeIn: THREE.IUniform<number> = { value: o.fadeIn };
  const fadeOut: THREE.IUniform<number> = { value: o.fadeOut };
  const fadeBand: THREE.IUniform<number> = { value: o.fadeBand };
  const fadeInBand: THREE.IUniform<number> = { value: o.fadeInBand ?? o.fadeBand };

  // These four convert sRGB to linear twice over — `new THREE.Color(hex)` has
  // already done it, since three's `ColorManagement` is enabled. The species
  // palette in `species.ts` was picked by eye against the doubled result, and
  // these tints multiply an albedo map rather than standing alone, so undoing
  // it means re-choosing every colour in that table against the map. Recorded
  // rather than changed.
  const summer = new THREE.Color(sp.summerColor).convertSRGBToLinear();
  const autumn = new THREE.Color(sp.autumnColor).convertSRGBToLinear();
  const senescent = new THREE.Color(SENESCENT).convertSRGBToLinear();
  const bark = new THREE.Color(sp.barkColor).convertSRGBToLinear();

  mat.defines = mat.defines ?? {};
  if (lod === 'far') {
    (mat.defines as Record<string, unknown>).VEG_BILLBOARD = '';
    (mat.defines as Record<string, unknown>).VEG_FADE_INVERT = '';
  }
  // Mid is the *complement* tier at both of its borders: standard dither
  // against the impostor at MID_RADIUS (unchanged), inverted dither against
  // the near tier at NEAR_RADIUS. The two bands never overlap (FADE_BAND is
  // 30 m either side of a 155 m gap), so a single runtime branch on distance
  // picks the right one — see the dithering_fragment patch below.
  if (lod === 'mid') (mat.defines as Record<string, unknown>).VEG_NEARMID = '';
  if (leaf) (mat.defines as Record<string, unknown>).VEG_LEAF = '';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = o.shared.time;
    shader.uniforms.uDither = o.shared.dither;
    shader.uniforms.uWind = o.shared.wind;
    shader.uniforms.uSeason = o.shared.season;
    shader.uniforms.uSway = { value: leaf ? sp.sway : sp.sway * 0.45 };
    shader.uniforms.uFadeIn = fadeIn;
    shader.uniforms.uFadeOut = fadeOut;
    shader.uniforms.uFadeBand = fadeBand;
    shader.uniforms.uFadeInBand = fadeInBand;
    shader.uniforms.uSummer = { value: leaf ? summer : bark };
    shader.uniforms.uAutumn = { value: leaf ? autumn : bark };
    shader.uniforms.uSenescent = { value: leaf ? senescent : bark };
    shader.uniforms.uTurnBias = { value: leaf ? sp.turnBias : 0 };
    shader.uniforms.uTransTint = { value: new THREE.Vector3(1.05, 1.3, 0.5) };
    shader.uniforms.uTransAmount = { value: leaf ? (lod === 'far' ? 1.25 : 0.95) : 0 };
    shader.uniforms.uCanopy = { value: o.canopy ?? 0 };
    shader.uniforms.uMapMean = { value: o.mapMean ?? 1 };
    shader.uniforms.uCanopyTint = { value: new THREE.Vector3(0.78, 1.0, 0.66) };
    shader.uniforms.uDistWash = { value: lod === 'far' ? 1 : lod === 'mid' ? 0.3 : 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uCanopy;\nuniform vec3 uCanopyTint;\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        {
          // Reduce the map to a modulation whose mean is 1, so the species tint
          // that follows *is* the albedo.
          //
          // Both families of art are drawn in near-neutral luminance and then
          // multiplied by a tint — but the tint is a real albedo (bark 0.15
          // linear, leaf 0.11/0.26/0.06) and the art is not white, so the two
          // dark numbers multiplied gave bark an albedo of 0.033 against a
          // real tree's 0.10-0.20. That is four to six stops of missing bark,
          // and it is why no amount of extra skylight would lift a trunk off
          // black: there was nothing there to reflect it.
          float vegLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
          vec3  vegHue = diffuseColor.rgb / vegLum;
          // Square-rooted, because the art's own contrast is doing double duty
          // as form shading and a straight rescale blows the highlight ridges.
          float vegK = clamp( sqrt( vegLum / uMapMean ), 0.45, 1.85 );
          diffuseColor.rgb = mix( vec3( 1.0 ), vegHue, 0.35 ) * vegK;
        }
        {
          // The turn is a clock, not a dial. Every tree carries its own
          // threshold — early for red maple and cherry, late for oak and
          // London plane, spread half a window wide by a per-tree hash — and
          // once the clock passes it the tree colours over about a fortnight.
          // The base is set so that on 19 September — the scene's default day,
          // and 18 % of the way through the clock — only the earliest tenth of
          // the red maples show any colour at all, which is what Boston looks
          // like that week. At 0.86 a fifth of them were half turned.
          float thr = clamp( 1.04 - 0.42 * uTurnBias + 0.46 * ( vJitter - 0.5 ), 0.0, 1.4 );
          // A crown turns from the tips inward: the lever attribute is 1 at
          // the branch ends and 0 at the bole.
          float t0 = thr - 0.16 * vLever;
          float turn = smoothstep( t0, t0 + 0.34, uSeason );
          // Per-card scatter, so one spray colours a little before its
          // neighbour. Small: at +-0.13 of a 0.34-wide ramp a single crown
          // held fully-green and fully-red sprays at once, which reads as a
          // tree in flower rather than a tree turning.
          turn = clamp( turn + ( vPhase - 0.5 ) * 0.10, 0.0, 1.0 );
          // And a tree that turned a fortnight ago has already gone dull.
          float late = clamp( ( uSeason - thr - 0.30 ) / 0.45, 0.0, 1.0 );

          vec3 canopy = mix( uSummer, uAutumn, turn );
          canopy = mix( canopy, uSenescent, late * 0.60 );
          diffuseColor.rgb *= canopy * ( 0.84 + 0.32 * vJitter );

          // Distant foliage loses contrast and saturation before the haze even
          // touches it; without this, impostors read as dark specks.
          // Sub-pixel canopy mixing, not haze: once a whole crown is thirty
          // pixels tall every pixel averages lit and shaded leaves together,
          // and the average is much brighter than the shaded side alone. On a
          // 260-2400 m ramp this contributed 3 % at the far edge of the Fens
          // and the whole Emerald Necklace read as a black hole in the city.
          float wash = uDistWash * smoothstep( 180.0, 1200.0, vDist );
          float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb,
            mix( vec3( lum ), diffuseColor.rgb, 0.5 ) * 1.2 + vec3( 0.028, 0.036, 0.030 ),
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
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_maps>', INDIRECT_TRANSMISSION);

    // The impostor's dither is the *complement* of the mid tier's, so across
    // the hand-over band the two tiers tile the pixels between them exactly
    // instead of both drawing the same tree into the same pixels. Mid does
    // the same thing a second time at its other border, against near.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <dithering_fragment>', /* glsl */ `
        #include <dithering_fragment>
        #ifdef VEG_FADE_INVERT
          if ( vFade < 1.0 - vegFadeCut( gl_FragCoord.xy ) ) discard;
          // Partition the impostor's own pixels between its vertical cards and
          // its horizontal canopy plate. An exact partition, on a second
          // independent noise, so the two never both claim a pixel and never
          // both abandon one.
          float vegSel = vegIGN( gl_FragCoord.xy + vec2( 23.0, 41.0 ) );
          if ( vCardKind > 0.5 ) { if ( vegSel < vCardMix ) discard; }
          else                   { if ( vegSel >= vCardMix ) discard; }
        #elif defined( VEG_NEARMID )
          // uFadeIn + uFadeInBand is NEAR_RADIUS for the mid material (see
          // Vegetation.ts's materialsFor). Below it this fragment is in the
          // near hand-over band, where near itself uses the plain (below)
          // test, so mid has to take the inverted one to be its exact
          // complement; at or beyond it mid is handing off to the impostor
          // instead, which already expects mid to run the plain test.
          if ( vDist < uFadeIn + uFadeInBand ) {
            if ( vFade < 1.0 - vegFadeCut( gl_FragCoord.xy ) ) discard;
          } else {
            if ( vFade < vegFadeCut( gl_FragCoord.xy ) ) discard;
          }
        #else
          if ( vFade < vegFadeCut( gl_FragCoord.xy ) ) discard;
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
  opts: {
    sway: number; alphaTest: number; fadeOut: number; turnBias: number;
    canopy?: number; mapMean?: number;
  },
): VegMaterial {
  return createVegMaterial({
    species: {
      name,
      height: 1, spread: 1, crownBase: 0, shape: 'rounded', leaf: 'ovate',
      leafMeters: 0.05,
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
    canopy: opts.canopy,
    alphaTest: opts.alphaTest,
    mapMean: opts.mapMean,
  });
}
