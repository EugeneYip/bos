/**
 * The single material that draws the entire city shell.
 *
 * Because every facade, roof and rooftop unit lives in one `DataArrayTexture`
 * pair, one `MeshStandardMaterial` can render a whole 500 m tile — walls,
 * gable ends, parapets, cornices, dormers and all — in one draw call, with the
 * atlas layer chosen *per fragment*. That is what keeps 63k buildings inside a
 * few hundred draw calls while still giving each one its own colour, floor
 * height, bay width and window-lighting pattern.
 *
 * Per fragment the shader:
 *  1. picks the ground / field / crown atlas layer from the height up the wall,
 *     so a building gets a taller glazed ground floor, correct floor lines and
 *     a cornice without any of that being geometry;
 *  2. marches a short parallax-occlusion ray through the atlas depth channel so
 *     window reveals, mortar joints and panel gaps have real depth up close;
 *  3. rebuilds a tangent frame from the interpolated normal (no tangent
 *     attribute needed — walls are vertical and roofs are +X/-Z aligned);
 *  4. turns the deep parts of the depth channel into the glass mask, which
 *     drives reflectivity by day and per-window emissive lighting by night.
 *
 * Extending `MeshStandardMaterial` rather than writing a raw `ShaderMaterial`
 * keeps IBL, cascaded shadows, fog and tone mapping working exactly as the
 * rest of the scene expects.
 */
import * as THREE from 'three';
import { BAYS, CROWN_FRAC, LAYER_COUNT, LAYER_TILE_M, type FacadeAtlas } from './atlas';

export interface ShellUniforms {
  uAlbedo: { value: THREE.DataArrayTexture | null };
  uSurface: { value: THREE.DataArrayTexture | null };
  uCamPos: { value: THREE.Vector3 };
  /** 0 by day, 1 at night; drives window lighting. */
  uNight: { value: number };
  /** Emissive gain for lit windows. */
  uWindowGain: { value: number };
  /** Distance band over which parallax fades out, metres. */
  uPom: { value: THREE.Vector2 };
  /** Detail-distance scale, 1.0 at the `high` tier. */
  uLod: { value: number };
  /** Metres covered by one tile of each atlas layer (clutter needs this). */
  uTileM: { value: Float32Array };
}

export function createShellUniforms(atlas: FacadeAtlas | null): ShellUniforms {
  const tiles = new Float32Array(LAYER_COUNT).fill(4);
  for (const k of Object.keys(LAYER_TILE_M)) tiles[Number(k)] = LAYER_TILE_M[Number(k)];
  return {
    uAlbedo: { value: atlas?.albedo ?? null },
    uSurface: { value: atlas?.surface ?? null },
    uCamPos: { value: new THREE.Vector3() },
    uNight: { value: 0 },
    uWindowGain: { value: 2.6 },
    uPom: { value: new THREE.Vector2(45, 150) },
    uLod: { value: 1 },
    uTileM: { value: tiles },
  };
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const COMMON_DECL = /* glsl */ `
#define BAYS ${BAYS.toFixed(1)}
#define CROWN_FRAC ${CROWN_FRAC.toFixed(4)}
#define LAYER_COUNT ${LAYER_COUNT}
varying vec2 vMuv;
varying vec4 vPar;
varying vec3 vTintC;
varying float vWeather;
varying float vLayerBase;
varying float vKind;
varying float vOrient;
varying float vSeed;
varying vec3 vWPos;
varying vec3 vWN;
`;

const VERT_DECL = /* glsl */ `
#ifdef SHELL_CLUTTER
attribute vec4 aTint;   // rgb linear, a = per-instance seed
attribute float aLayer;
uniform float uTileM[LAYER_COUNT];
uniform float uLod;
#else
attribute vec2 aMuv;
attribute vec4 aTint;   // srgb 0..1, a = weathering
attribute vec4 aSurf;   // layer, flags, seed lo, seed hi  (raw 0..255)
attribute vec4 aPar;    // floorH/32, groundH/32, wallTop/512, bayW/32
#endif
uniform vec3 uCamPos;
`;

const VERT_BEGIN = /* glsl */ `
#ifdef SHELL_CLUTTER
  // Unit primitive scaled by the instance matrix: recover metres locally so
  // rooftop plant shares the city's world-scale texel density.
  vec3 iScale = vec3(
    length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec3 lp = position * iScale;
  vec3 an = abs(normal);
  vMuv = an.y > 0.7 ? lp.xz : (an.x > an.z ? lp.zy : lp.xy);
  vOrient = an.y > 0.7 ? 1.0 : 0.0;
  vLayerBase = aLayer;
  vKind = 1.0;
  float tm = uTileM[int(aLayer + 0.5)];
  vPar = vec4(0.0, 0.0, 0.0, tm);
  vTintC = aTint.rgb;
  vWeather = 0.5;
  vSeed = aTint.a;

  // Screen-space-error LOD: a 1 m vent vanishes at 350 m, a 20 m mechanical
  // penthouse survives to several kilometres, and the depth pass agrees.
  vec3 iCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.5, 0.0, 1.0)).xyz;
  float sMax = max(iScale.x, max(iScale.y, iScale.z));
  float far = clamp(sMax * 700.0, 350.0, 7000.0) * uLod;
  float keep = 1.0 - smoothstep(far * 0.82, far, distance(uCamPos, iCenter));
  transformed *= keep;
#else
  vMuv = aMuv;
  vTintC = aTint.rgb;
  vWeather = aTint.a;
  vLayerBase = aSurf.x;
  vKind = mod(aSurf.y, 4.0);
  vOrient = step(3.5, aSurf.y);
  vSeed = aSurf.z + aSurf.w * 256.0;
  vPar = aPar * vec4(32.0, 32.0, 512.0, 32.0);
#endif
`;

const VERT_WORLD = /* glsl */ `
  vec4 shellWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    shellWp = instanceMatrix * shellWp;
  #endif
  vWPos = (modelMatrix * shellWp).xyz;
  vec3 shellN = objectNormal;
  #ifdef USE_INSTANCING
    mat3 shellIm = mat3(instanceMatrix);
    shellN /= vec3(dot(shellIm[0], shellIm[0]), dot(shellIm[1], shellIm[1]), dot(shellIm[2], shellIm[2]));
    shellN = shellIm * shellN;
  #endif
  vWN = normalize(mat3(modelMatrix) * shellN);
`;

const FRAG_DECL = /* glsl */ `
uniform highp sampler2DArray uAlbedo;
uniform highp sampler2DArray uSurface;
uniform vec3 uCamPos;
uniform float uNight;
uniform float uWindowGain;
uniform vec2 uPom;

vec3 shellSrgb(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
float shellHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
`;

/**
 * Everything interesting happens here: layer selection, parallax, tangent
 * frame, glass mask. The results are reused by the roughness, metalness,
 * normal and emissive chunks further down `main()`.
 */
const FRAG_MAP = /* glsl */ `
  float gDist = distance(uCamPos, vWPos);
  float gLayer = vLayerBase;
  vec2 gUv;
  vec2 gUvPerM = vec2(0.25);
  float gFloor = 0.0;
  float gBay = 0.0;
  float gFacade = 0.0;

  if (vKind < 0.5) {
    float floorH = max(vPar.x, 0.4);
    float groundH = max(vPar.y, 0.4);
    float wallTop = max(vPar.z, 0.6);
    float bayW = max(vPar.w, 0.3);
    float tileW = bayW * BAYS;
    float crownH = max(floorH * CROWN_FRAC, 0.12);
    float h = vMuv.y;
    float u = vMuv.x / tileW;
    gFacade = 1.0;
    gBay = floor(vMuv.x / bayW);
    if (h > wallTop - crownH) {
      gLayer = vLayerBase + 16.0;
      gUv = vec2(u, clamp((h - (wallTop - crownH)) / crownH, 0.0, 1.0));
      gFloor = 900.0;
      gUvPerM = vec2(1.0 / tileW, 1.0 / crownH);
    } else if (h < groundH) {
      gLayer = vLayerBase + 8.0;
      gUv = vec2(u, clamp(h / groundH, 0.0, 1.0));
      gUvPerM = vec2(1.0 / tileW, 1.0 / groundH);
    } else {
      float f = (h - groundH) / floorH;
      gLayer = vLayerBase;
      gUv = vec2(u, fract(f));
      gFloor = floor(f) + 1.0;
      gUvPerM = vec2(1.0 / tileW, 1.0 / floorH);
    }
  } else if (vKind < 1.5) {
    float tm = max(vPar.w, 0.05);
    gUv = vMuv / tm;
    gUvPerM = vec2(1.0 / tm);
  } else {
    gUv = vMuv;
    gUvPerM = vec2(1.0);
  }

  // ---- tangent frame from the interpolated normal -----------------------
  vec3 gN = normalize(vWN);
  vec3 gT, gB;
  if (vOrient < 0.5) {
    vec2 hz = vec2(-gN.z, gN.x);
    float hl = length(hz);
    gT = hl > 1e-4 ? vec3(hz.x, 0.0, hz.y) / hl : vec3(1.0, 0.0, 0.0);
    gB = vec3(0.0, 1.0, 0.0);
  } else {
    vec3 t = vec3(1.0, 0.0, 0.0) - gN * gN.x;
    float tl = length(t);
    gT = tl > 1e-4 ? t / tl : vec3(0.0, 0.0, -1.0);
    gB = normalize(cross(gN, gT));
  }

  // ---- parallax occlusion on the window reveals -------------------------
  float gPom = 1.0 - smoothstep(uPom.x, uPom.y, gDist);
  int gLayerI = int(gLayer + 0.5);
  if (gPom > 0.02 && vKind < 1.5) {
    vec3 vdir = uCamPos - vWPos;
    vec3 vt = vec3(dot(vdir, gT), dot(vdir, gB), dot(vdir, gN));
    if (vt.z > 0.08) {
      float steps = mix(5.0, 14.0, gPom);
      float relief = 0.115 * gPom;
      vec2 p = (vt.xy / vt.z) * relief * gUvPerM;
      vec2 dUv = p / steps;
      float layerStep = 1.0 / steps;
      float cur = 0.0;
      vec2 uvp = gUv;
      float d = texture(uSurface, vec3(uvp, gLayer)).a;
      for (int i = 0; i < 14; i++) {
        if (cur >= d || float(i) >= steps) break;
        uvp -= dUv;
        cur += layerStep;
        d = texture(uSurface, vec3(uvp, gLayer)).a;
      }
      vec2 prevUv = uvp + dUv;
      float after = d - cur;
      float before = texture(uSurface, vec3(prevUv, gLayer)).a - cur + layerStep;
      float w = after / max(after - before, 1e-4);
      gUv = mix(uvp, prevUv, clamp(w, 0.0, 1.0));
    }
  }

  vec4 gAlb = texture(uAlbedo, vec3(gUv, gLayer));
  vec4 gSrf = texture(uSurface, vec3(gUv, gLayer));
  float gDepth = gSrf.a;
  float gGlass = smoothstep(0.60, 0.80, gDepth);

  vec3 gTint = shellSrgb(clamp(vTintC, 0.0, 1.0));
  #ifdef SHELL_CLUTTER
    gTint = vTintC;
  #endif
  vec3 gBase = shellSrgb(gAlb.rgb) * mix(vec3(1.0), gTint, gAlb.a);
  // Weathering: a touch of soot in the recesses, a touch of sun-bleach on the
  // faces, so a terrace of identically tagged buildings still reads varied.
  gBase *= mix(0.80, 1.10, vWeather) * mix(1.0, 0.72, gDepth * 0.55 * vWeather);
  diffuseColor.rgb *= gBase;
`;

const FRAG_ROUGH = /* glsl */ `
  float gMetalFam = (abs(vLayerBase - 5.0) < 0.5 || abs(vLayerBase - 28.0) < 0.5
    || abs(vLayerBase - 30.0) < 0.5) ? 0.62 : 0.0;
  float roughnessFactor = clamp(mix(gSrf.b, 0.055, gGlass) * mix(1.08, 0.9, vWeather), 0.035, 1.0);
`;

const FRAG_METAL = /* glsl */ `
  float metalnessFactor = clamp(max(gMetalFam * (1.0 - gGlass), gGlass * 0.34), 0.0, 1.0);
`;

const FRAG_NORMAL = /* glsl */ `
  vec3 gTn;
  gTn.xy = gSrf.rg * 2.0 - 1.0;
  gTn.z = sqrt(max(1e-4, 1.0 - dot(gTn.xy, gTn.xy)));
  // Damp relief with distance so the city doesn't shimmer from the air.
  gTn.xy *= mix(1.0, 0.35, smoothstep(120.0, 900.0, gDist));
  normal = normalize(mat3(viewMatrix) * normalize(gT * gTn.x + gB * gTn.y + gN * gTn.z));
`;

const FRAG_EMISSIVE = /* glsl */ `
  if (uNight > 0.003) {
    float hFloor = shellHash(vec3(gFloor, vSeed * 0.0173, 3.3));
    float hWin = shellHash(vec3(gBay, gFloor, vSeed * 0.0131 + 1.7));
    // Offices empty floor by floor, so lighting clusters vertically.
    float litFrac = gFloor < 0.5 ? mix(0.55, 0.95, hFloor) : mix(0.20, 0.88, hFloor);
    float lit = step(hWin, litFrac);
    float warm = step(shellHash(vec3(gBay * 1.7, gFloor * 2.3, vSeed * 0.0117)), 0.70);
    float bright = 0.5 + 0.95 * shellHash(vec3(gBay + 5.0, gFloor * 3.1, vSeed * 0.019));
    // Individual windows go sub-pixel with distance; fade to an average glow
    // instead of aliasing into noise.
    float faraway = smoothstep(260.0, 1300.0, gDist);
    float litMix = mix(lit, 0.52, faraway);
    vec3 lamp = mix(mix(vec3(0.76, 0.86, 1.0), vec3(1.0, 0.72, 0.40), warm),
                    vec3(0.99, 0.82, 0.60), faraway);

    // ---- what is actually behind the glass ---------------------------------
    //
    // A lit window is not a panel of light, it is a hole into a room, and the
    // room has a bright ceiling, a dim floor and something hanging in front of
    // it. Emitting one constant per pane is what made every shopfront clip to
    // a solid 255 rectangle with a 1 px frame and nothing inside it.
    //
    // Coordinates: gUv.x runs across BAYS bays of the atlas tile, so its
    // fractional part is the position across one bay with the opening centred
    // in it; gUv.y runs up one storey. The opening occupies roughly the middle
    // 74% of the storey in every family (0.16-0.82 upstairs, 0.10-0.66 for a
    // shopfront, 0.30-0.86 for a parlour), and being a little wrong only
    // stretches the gradient — gGlass is zero outside the pane either way.
    float wx = fract(gUv.x * BAYS);
    float wy = clamp((gUv.y - 0.12) * 1.3514, 0.0, 1.0);
    // Ceiling and its fittings are the bright part; the cill is in the dark.
    float room = mix(0.26, 1.0, smoothstep(0.0, 0.78, wy));
    // Falls off into the reveals rather than meeting the frame at full value.
    room *= 1.0 - 0.34 * pow(abs(wx - 0.5) * 2.0, 3.0);
    // Blinds and curtains, drawn to a different height in every window; most
    // are up, a few are most of the way down. Squaring the hash biases it.
    float hBlind = shellHash(vec3(gBay * 3.1, gFloor + 11.0, vSeed * 0.0157));
    float drop = hBlind * hBlind * 1.08;
    float open = smoothstep(0.0, 0.05, (1.0 - drop) - wy);
    // Behind a blind the room still glows, dimly, through the slats.
    float slats = 0.80 + 0.20 * sin(wy * 190.0);
    room = mix(room * 0.30 * slats + 0.055, room, open);
    // And a warm lamp or a screen close to the glass in some of them.
    float hLamp = shellHash(vec3(gBay * 0.7, gFloor * 5.3, vSeed * 0.0211 + 4.1));
    if (hLamp > 0.72) {
      vec2 d = vec2(wx, wy)
        - vec2(mix(0.22, 0.78, fract(hLamp * 37.0)), mix(0.18, 0.50, fract(hLamp * 91.0)));
      room += 0.55 * open * exp(-14.0 * d.x * d.x - 26.0 * d.y * d.y);
    }
    // All of that is pane-scale detail. Once a pane is a couple of pixels it
    // can only alias, so collapse it to its own average instead — 0.52 is the
    // mean of the profile above, measured over the unit square.
    room = mix(room, 0.52, smoothstep(70.0, 420.0, gDist));
    // Glass, and only on a facade. Roofs and rooftop plant carry the same
    // surface atlas, so their depth channel reads as 'glass' too, and handing
    // non-facade geometry a third of the window glow lit every flat roof
    // downtown as a slab brighter than the towers under it. Dimming the glow
    // cannot fix that: the windows are most of the light in a night frame, so
    // the metering simply raises exposure to compensate and the picture comes
    // back where it started. What has to change is the ratio.
    float mask = gGlass * gFacade;
    // Shoulder, not a scale. The windows are most of the light in a night
    // frame, so simply turning them down moves the meter and roughly half of
    // it comes straight back as exposure. Dividing by (1 + e) instead leaves
    // a dim window almost untouched and only bites on the bright tail, which
    // is the part that was clipping, so the mean the meter sees barely moves.
    float e = bright * litMix * room;
    e = e / (1.0 + 0.62 * e);
    totalEmissiveRadiance += lamp * (e * mask * uNight * uWindowGain * 1.35);
  }
`;

// ---------------------------------------------------------------------------

function patch(mat: THREE.MeshStandardMaterial, uniforms: ShellUniforms, clutter: boolean): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    const defs = (clutter ? '#define SHELL_CLUTTER\n' : '') + COMMON_DECL;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${defs}\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BEGIN}`)
      .replace('#include <project_vertex>', `${VERT_WORLD}\n#include <project_vertex>`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${defs}\n${FRAG_DECL}`)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
  };
  mat.customProgramCacheKey = () => (clutter ? 'bos-shell-clutter' : 'bos-shell');
}

export function createShellMaterial(uniforms: ShellUniforms, envMap: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
    envMap,
    envMapIntensity: 1.0,
    dithering: true,
    side: THREE.FrontSide,
  });
  mat.name = 'BuildingShell';
  patch(mat, uniforms, false);
  return mat;
}

export function createClutterMaterial(uniforms: ShellUniforms, envMap: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.0,
    envMap,
    envMapIntensity: 1.0,
    dithering: true,
    side: THREE.FrontSide,
  });
  mat.name = 'BuildingClutter';
  patch(mat, uniforms, true);
  return mat;
}

/**
 * Depth material for the instanced clutter, carrying the same distance
 * collapse so shadows never outlive the geometry that casts them.
 */
export function createClutterDepthMaterial(uniforms: ShellUniforms): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n#define LAYER_COUNT ${LAYER_COUNT}\nuniform vec3 uCamPos;\nuniform float uLod;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec3 dScale = vec3(
    length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec3 dCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.5, 0.0, 1.0)).xyz;
  float dMax = max(dScale.x, max(dScale.y, dScale.z));
  float dFar = clamp(dMax * 700.0, 350.0, 7000.0) * uLod;
  transformed *= 1.0 - smoothstep(dFar * 0.82, dFar, distance(uCamPos, dCenter));`,
      );
  };
  mat.customProgramCacheKey = () => 'bos-clutter-depth';
  return mat;
}

// ---------------------------------------------------------------------------
// Window spill
// ---------------------------------------------------------------------------

/**
 * The unit pool: a 1x1 quad lying in the XZ plane, centred on the origin, with
 * v running 0 to 1 along +Z. `Buildings` scales it to (frontage, 1, reach) and
 * rotates it so +Z is the wall's outward normal, which puts v = 0 against the
 * glass and v = 1 at the far edge of the pool.
 *
 * Double-sided because the rotation puts the plane's own normal underground,
 * and the camera goes up on the bridges and down onto the pavement.
 */
export function spillGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Additive pavement light.
 *
 * Deliberately not a lit material: there is nothing to light, it *is* the
 * light. The falloff is the 1/(1 + kd^2) of a source a couple of metres back
 * from the glass rather than a true inverse square, because a shopfront is a
 * wall of glass metres across and behaves like an area source at the range
 * this covers — a true inverse square from a point puts almost everything in
 * the first metre and reads as a hard rim against the kerb.
 *
 * `uNight` is the same uniform the windows above run on, so the pavement
 * lights up on exactly the same civil-twilight curve as the glass.
 */
export function createSpillMaterial(uniforms: ShellUniforms): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNight: uniforms.uNight,
      uWindowGain: uniforms.uWindowGain,
      uCamPos: uniforms.uCamPos,
      uSpillGain: { value: 0.075 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aSpill;
      varying vec2 vPUv;
      varying vec2 vSpill;
      varying float vFade;
      uniform vec3 uCamPos;
      void main() {
        vPUv = uv;
        vSpill = aSpill;
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        // Pools are pavement detail. Past a couple of hundred metres a whole
        // street of them is a few pixels tall and can only turn into a haze
        // over the roofs of the buildings in front, so take them out.
        vFade = 1.0 - smoothstep(110.0, 260.0, distance(uCamPos, wp.xyz));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vPUv;
      varying vec2 vSpill;
      varying float vFade;
      uniform float uNight;
      uniform float uWindowGain;
      uniform float uSpillGain;
      void main() {
        // v = 0 at the glass, 1 at the far edge of the pool.
        float d = vPUv.y;
        float f = max(1.0 / (1.0 + 5.0 * d * d) - 0.16667, 0.0) * 1.2;
        // Taper the ends so a frontage does not stamp a rectangle on the road.
        float a = vPUv.x;
        f *= smoothstep(0.0, 0.18, a) * smoothstep(0.0, 0.18, 1.0 - a);
        // Warm shopfront tungsten through to a colder retail white.
        vec3 tint = mix(vec3(1.0, 0.74, 0.46), vec3(0.86, 0.90, 1.0), vSpill.x * vSpill.x);
        gl_FragColor = vec4(tint * (f * vSpill.y * vFade * uNight * uWindowGain * uSpillGain), 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  mat.name = 'BuildingSpill';
  return mat;
}
