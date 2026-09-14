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
    float mask = gGlass * mix(gFacade, 1.0, 0.35);
    totalEmissiveRadiance += lamp * (bright * litMix * mask * uNight * uWindowGain);
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
