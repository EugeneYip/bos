/**
 * The city's surface vocabulary.
 *
 * Every other module asks for its materials here by name, so the whole of
 * Boston shares one colour world, one texel density convention and one
 * disposal path. Nothing is authored on the CPU: each family is a full-screen
 * GPU bake (see `TextureForge`) of a procedural shader from `./shaders`, and
 * the normal map is always a Sobel derivative of the *same* height field the
 * shader authored, scaled by that family's real-world tile size.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **Colour management.** `map` is `SRGBColorSpace`; `normalMap`,
 *     `roughnessMap`, `metalnessMap` and `aoMap` are `NoColorSpace`. Getting
 *     this backwards is the single most common cause of a washed-out scene,
 *     so it is applied centrally in `adopt()` and never left to the caller.
 *  2. **Physical texel density.** `tileMeters` is a real measurement — a
 *     modular brick is 194 x 57 mm on a 10 mm joint, a travel lane is 3.6 m,
 *     a sidewalk panel is 5 ft. Consumers derive UVs as
 *     `worldMetres / tileMeters`, which is the only way the same material can
 *     look right on a 4 m garden wall and a 180 m tower.
 *  3. **Laziness and a hard VRAM ceiling.** Nothing bakes at boot. A family
 *     bakes on its first request, at a resolution chosen from `ctx.quality`
 *     and its own importance, and the ceiling in `BUDGET` clamps the total.
 *
 * `get()` never returns undefined. An unknown name falls back to a tinted
 * standard material and logs once, so a typo in another module degrades to
 * "slightly wrong grey" rather than a crash halfway through city generation.
 */
import * as THREE from 'three';
import type { Ctx, MaterialLibrary, TextureSet, WorldModule } from '../core/Context';
import { TextureForge, type BakedSet } from './TextureForge';
import { MASONRY_GLSL } from './shaders/masonry';
import { STONE_GLSL } from './shaders/stone';
import { GLASS_GLSL } from './shaders/glass';
import { METAL_GLSL } from './shaders/metal';
import { CEMENT_GLSL } from './shaders/cement';
import { COBBLE_GLSL } from './shaders/cobble';
import { ROOFING_GLSL } from './shaders/roofing';
import { GROUND_GLSL } from './shaders/ground';
import { ASPHALT_GLSL } from './shaders/asphalt';
import { WOOD_GLSL } from './shaders/wood';

// ============================================================== recipes ====

/** Relative texel budget. Resolved against the tier's base size at bake time. */
type Detail = 'hero' | 'high' | 'mid' | 'low';

/**
 * Uncompressed RGBA8 is brutal: a 2048 albedo + 2048 normal + 1024 ORM set is
 * ~50 MB with mips, so only a handful of surfaces can be hero-sized. The three
 * that earn it are the ones that cover the most screen area in Boston —
 * brick walls, curtain wall, and road.
 */
const DETAIL_SCALE: Record<Detail, number> = { hero: 1, high: 0.5, mid: 0.375, low: 0.1875 };

/** Floor per priority, so a late bake can never starve an important surface. */
const DETAIL_FLOOR: Record<Detail, number> = { hero: 1024, high: 512, mid: 384, low: 256 };

interface FamilyDef {
  /** Family shader providing `bosShade()`. */
  glsl: string;
  /** Fresh uniform objects per bake — the forge rebinds them on the shared program. */
  uniforms(): Record<string, THREE.IUniform>;
  /** World metres spanned by one UV tile. Physically measured, not invented. */
  tileMeters: number;
  detail: Detail;
  ormDiv?: number;
  normalStrength?: number;
  /** Tangent-space normal gain on the finished material. */
  normalScale?: number;
  envMapIntensity?: number;
  aoIntensity?: number;
  /** Use `MeshPhysicalMaterial` (glass wants the extra specular controls). */
  physical?: boolean;
  /** Applied when the caller passes no tint. */
  tint?: number;
  extra?: THREE.MeshPhysicalMaterialParameters;
}

/** Raw sRGB components for a `vec3` uniform the shader will linearise itself. */
function sRGB(hex: number): THREE.Vector3 {
  return new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}
const f = (value: number): THREE.IUniform => ({ value });
const v3 = (hex: number): THREE.IUniform => ({ value: sRGB(hex) });
const v2 = (x: number, y: number): THREE.IUniform => ({ value: new THREE.Vector2(x, y) });

// Physical modules, in metres. These drive every tileMeters below.
const BRICK_W = 0.194 + 0.010;   // modular brick + bed joint  -> 204 mm
const BRICK_H = 0.057 + 0.011;   // course height              ->  68 mm
const PAVER = 0.203;             // 200 mm clay paver + 3 mm joint
const LANE = 3.6;                // travel lane
const SIDEWALK_PANEL = 1.524;    // 5 ft scored panel
const FLOOR = 3.6;               // curtain-wall floor-to-floor
const VISION_PANE = 1.2;         // curtain-wall module width

/**
 * Every baked family. Names are the public API — other modules hold these
 * strings, so they are additive-only.
 */
const FAMILIES: Record<string, FamilyDef> = {
  // ---------------------------------------------------------- masonry ----
  brick: {
    glsl: MASONRY_GLSL,
    tileMeters: 12 * BRICK_W,          // 2.448 m: 12 stretchers x 36 courses
    detail: 'hero',
    normalScale: 0.95,
    envMapIntensity: 0.85,
    uniforms: () => ({
      uMode: f(0), uUnits: v2(12, 36),
      uJointFrac: v2(0.010 / BRICK_W, 0.011 / BRICK_H),
      uJointDepth: f(0.0055), uFaceRelief: f(0.0026),
      uWPeriod: f(4), uPaverW: f(2.8284),
      uEfflor: f(0.09), uGrime: f(0.34), uWear: f(0),
      uMortar: v3(0xb4aea4), uPalette: f(0),
    }),
  },
  brick_paver: {
    glsl: MASONRY_GLSL,
    tileMeters: 6 * Math.SQRT2 * PAVER, // 1.723 m: herringbone lattice period
    detail: 'mid',
    normalScale: 0.9,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(1), uUnits: v2(12, 36),
      uJointFrac: v2(0.003 / PAVER, 0.003 / PAVER),
      uJointDepth: f(0.005), uFaceRelief: f(0.0018),
      uWPeriod: f(12), uPaverW: f(6 * Math.SQRT2),
      uEfflor: f(0.10), uGrime: f(0.50), uWear: f(0.85),
      uMortar: v3(0x9b948a), uPalette: f(1),
    }),
  },

  // ------------------------------------------------------------ stone ----
  brownstone: {
    glsl: STONE_GLSL,
    tileMeters: 3.0,                    // 4 blocks of 750 x 375 mm
    detail: 'high',
    normalScale: 0.85,
    envMapIntensity: 0.85,
    uniforms: () => ({
      uMode: f(0), uBlocks: v2(4, 8),
      uJointFrac: v2(0.008 / 0.75, 0.008 / 0.375),
      uJointDepth: f(0.006), uJoints: f(1),
      uGrain: f(40), uSoot: f(0.55), uDrafted: f(0.15),
    }),
  },
  limestone: {
    glsl: STONE_GLSL,
    tileMeters: 3.6,                    // 4 blocks of 900 x 600 mm
    detail: 'mid',
    normalScale: 0.7,
    envMapIntensity: 0.95,
    uniforms: () => ({
      uMode: f(1), uBlocks: v2(4, 6),
      uJointFrac: v2(0.006 / 0.9, 0.006 / 0.6),
      uJointDepth: f(0.004), uJoints: f(1),
      uGrain: f(40), uSoot: f(0.40), uDrafted: f(0.45),
    }),
  },
  stone: {
    // Quincy granite: Boston's bedrock material, in 600 mm cubic ashlar.
    glsl: STONE_GLSL,
    tileMeters: 2.4,
    detail: 'high',
    normalScale: 0.8,
    envMapIntensity: 1.0,
    uniforms: () => ({
      uMode: f(2), uBlocks: v2(4, 4),
      uJointFrac: v2(0.008 / 0.6, 0.008 / 0.6),
      uJointDepth: f(0.005), uJoints: f(1),
      uGrain: f(240),                   // ~10 mm crystals (coarse Quincy)
      uSoot: f(0.42), uDrafted: f(0.3),
    }),
  },

  // ------------------------------------------------------------ glass ----
  glass: {
    glsl: GLASS_GLSL,
    tileMeters: 6 * VISION_PANE,        // 7.2 m: 6 panes x 2 floors
    detail: 'hero',
    physical: true,
    normalScale: 1.0,
    envMapIntensity: 1.45,
    ormDiv: 2,
    extra: { ior: 1.52, specularIntensity: 1, clearcoat: 0.12, clearcoatRoughness: 0.06 },
    uniforms: () => ({
      uPanes: v2(6, 2),
      uSpandrel: f(0.9 / FLOOR),
      uMullionW: f(0.065 / VISION_PANE),
      uMullionH: f(0.090 / FLOOR),
      uMullionDepth: f(0.055),
      uBow: f(0.013),
      uGlass: v3(0x8ea6ba), uSpandrelCol: v3(0x2b3238), uFrame: v3(0x8d9498),
      uGlassRough: f(0.045), uGlassMetal: f(0.86), uGrime: f(0.32),
    }),
  },

  // ---------------------------------------------------------- cement ----
  concrete: {
    glsl: CEMENT_GLSL,
    tileMeters: 4.0,                    // 2 x 2 m precast panels
    detail: 'high',
    normalScale: 0.8,
    envMapIntensity: 0.85,
    uniforms: () => ({
      uMode: f(1), uBase: v3(0xa9a59c),
      uPlanks: f(8), uTies: f(2), uPanels: f(2),
      uJointDepth: f(0.012), uStain: f(0.45), uAggregate: f(0.35),
    }),
  },
  concrete_board: {
    // Board-formed brutalism: Boston City Hall, the Hurley Building.
    glsl: CEMENT_GLSL,
    tileMeters: 8 * 0.2286,             // 1.829 m: eight 9-inch planks
    detail: 'mid',
    normalScale: 1.0,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(0), uBase: v3(0xa6a49d),
      uPlanks: f(8), uTies: f(2), uPanels: f(2),
      uJointDepth: f(0.010), uStain: f(0.60), uAggregate: f(0.22),
    }),
  },
  concrete_sidewalk: {
    glsl: CEMENT_GLSL,
    tileMeters: 2 * SIDEWALK_PANEL,     // 3.048 m: two 5 ft scored panels
    detail: 'high',
    normalScale: 0.9,
    envMapIntensity: 0.75,
    uniforms: () => ({
      uMode: f(2), uBase: v3(0xb1ada4),
      uPlanks: f(8), uTies: f(2), uPanels: f(2),
      uJointDepth: f(0.009), uStain: f(0.38), uAggregate: f(0.45),
    }),
  },
  plaster: {
    glsl: CEMENT_GLSL,
    tileMeters: 2.5,
    detail: 'mid',
    normalScale: 0.75,
    envMapIntensity: 0.85,
    uniforms: () => ({
      uMode: f(3), uBase: v3(0xded9cd),
      uPlanks: f(8), uTies: f(2), uPanels: f(1),
      uJointDepth: f(0), uStain: f(0.40), uAggregate: f(0.12),
    }),
  },

  // ----------------------------------------------------------- metal ----
  metal: {
    // Anodised aluminium rainscreen. Base colour is the measured F0.
    glsl: METAL_GLSL,
    tileMeters: 4.8,                    // 1.2 m panels
    detail: 'mid',
    normalScale: 0.7,
    envMapIntensity: 1.25,
    uniforms: () => ({
      uMode: f(0), uBase: v3(0xf6f7f7), uPanels: f(4),
      uSeamDepth: f(0.004), uWear: f(0.20), uRough: f(0.34),
    }),
  },
  metal_painted: {
    glsl: METAL_GLSL,
    tileMeters: 2.0,
    detail: 'low',
    normalScale: 0.6,
    envMapIntensity: 1.0,
    uniforms: () => ({
      uMode: f(2), uBase: v3(0xf0efe9), uPanels: f(2),
      uSeamDepth: f(0.002), uWear: f(0.35), uRough: f(0.46),
    }),
  },
  copper: {
    glsl: METAL_GLSL,
    tileMeters: 1.8,                    // 450 mm flat-lock bays
    detail: 'low',
    normalScale: 0.8,
    envMapIntensity: 1.0,
    uniforms: () => ({
      uMode: f(1), uBase: v3(0xfad1c1), uPanels: f(4),
      uSeamDepth: f(0.002), uWear: f(0.88), uRough: f(0.55),
    }),
  },
  gold: {
    // 23.75 kt leaf. F0 linear (1.000, 0.766, 0.336) -> sRGB #ffe39d.
    glsl: METAL_GLSL,
    tileMeters: 1.7,                    // 20 leaves of 85 mm
    detail: 'mid',
    normalScale: 1.0,
    envMapIntensity: 1.7,
    uniforms: () => ({
      uMode: f(3), uBase: v3(0xffe39d), uPanels: f(20),
      uSeamDepth: f(0.0002), uWear: f(0.18), uRough: f(0.15),
    }),
  },

  // --------------------------------------------------------- roofing ----
  slate: {
    glsl: ROOFING_GLSL,
    tileMeters: 8 * 0.254,              // 2.032 m: 8 slates x 10 courses
    detail: 'mid',
    normalScale: 1.0,
    envMapIntensity: 0.9,
    uniforms: () => ({
      uMode: f(0), uUnits: v2(8, 10), uThickness: f(0.0065),
      uGap: f(0.020), uWear: f(0.45), uBase: v3(0xffffff),
    }),
  },
  roof_shingle: {
    glsl: ROOFING_GLSL,
    tileMeters: 3.0,                    // 1 m tabs x 143 mm exposure
    detail: 'low',
    normalScale: 0.9,
    envMapIntensity: 0.7,
    uniforms: () => ({
      uMode: f(1), uUnits: v2(3, 21), uThickness: f(0.005),
      uGap: f(0.012), uWear: f(0.5), uBase: v3(0xffffff),
    }),
  },
  roof_tile: {
    glsl: ROOFING_GLSL,
    tileMeters: 2.5,                    // 250 mm cover x 312 mm exposure
    detail: 'low',
    normalScale: 1.0,
    envMapIntensity: 0.85,
    uniforms: () => ({
      uMode: f(2), uUnits: v2(10, 8), uThickness: f(0.007),
      uGap: f(0.010), uWear: f(0.5), uBase: v3(0xffffff),
    }),
  },
  roof_metal: {
    glsl: ROOFING_GLSL,
    tileMeters: 3.3,                    // 8 pans of 412 mm
    detail: 'low',
    normalScale: 0.85,
    envMapIntensity: 1.15,
    uniforms: () => ({
      uMode: f(3), uUnits: v2(8, 1), uThickness: f(0.010),
      uGap: f(0.01), uWear: f(0.38), uBase: v3(0xb8bcbc),
    }),
  },
  roof_membrane: {
    glsl: ROOFING_GLSL,
    tileMeters: 6.1,                    // two 10 ft EPDM sheets
    detail: 'mid',
    normalScale: 0.8,
    envMapIntensity: 0.7,
    uniforms: () => ({
      uMode: f(4), uUnits: v2(1, 2), uThickness: f(0.004),
      uGap: f(0.01), uWear: f(0.55), uBase: v3(0x73776f),
    }),
  },

  // ------------------------------------------------------- pavements ----
  asphalt: {
    glsl: ASPHALT_GLSL,
    tileMeters: LANE,                   // one travel lane across the tile
    detail: 'hero',
    normalScale: 0.85,
    envMapIntensity: 0.6,
    uniforms: () => ({
      uMode: f(0), uBase: v3(0x4b4a4c), uAggregate: f(0.60),
      uCracks: f(0.55), uSeal: f(0.45), uPatch: f(0.30), uWear: f(0.55),
    }),
  },
  asphalt_lot: {
    glsl: ASPHALT_GLSL,
    tileMeters: 4.0,
    detail: 'low',
    normalScale: 0.85,
    envMapIntensity: 0.6,
    uniforms: () => ({
      uMode: f(1), uBase: v3(0x525153), uAggregate: f(0.72),
      uCracks: f(0.75), uSeal: f(0.35), uPatch: f(0.45), uWear: f(0.75),
    }),
  },
  cobblestone: {
    // Acorn Street: rounded glacial field stone, ~120 mm across.
    glsl: COBBLE_GLSL,
    tileMeters: 2.4,
    detail: 'high',
    normalScale: 1.0,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(0), uCells: f(20), uJitter: v2(0.85, 0.35),
      uDome: f(0.015), uVary: f(0.006), uJointW: f(0.18), uMoss: f(0.35),
    }),
  },
  sett: {
    glsl: COBBLE_GLSL,
    tileMeters: 2.4,                    // cut granite setts, 200 x 100 mm
    detail: 'low',
    normalScale: 1.0,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(1), uCells: f(24), uJitter: v2(0.4, 0.2),
      uDome: f(0.007), uVary: f(0.003), uJointW: f(0.12), uMoss: f(0.22),
    }),
  },

  // ------------------------------------------------------------ wood ----
  wood: {
    glsl: WOOD_GLSL,
    tileMeters: 16 * 0.1143,            // 1.829 m: 16 courses at 4.5" exposure
    detail: 'mid',
    normalScale: 0.9,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(0), uBase: v3(0xe7e4d9), uCourses: f(16),
      uLap: f(0.010), uWear: f(0.42), uGrain: f(0.85),
    }),
  },
  wood_plank: {
    glsl: WOOD_GLSL,
    tileMeters: 8 * 0.2286,             // 1.829 m: 8 boards at 9"
    detail: 'low',
    normalScale: 1.0,
    envMapIntensity: 0.75,
    uniforms: () => ({
      uMode: f(1), uBase: v3(0xa87f52), uCourses: f(8),
      uLap: f(0.005), uWear: f(0.75), uGrain: f(1.0),
    }),
  },

  // ---------------------------------------------------------- ground ----
  grass: {
    glsl: GROUND_GLSL,
    tileMeters: 2.0,
    detail: 'high',
    normalScale: 0.55,                  // a lawn at a grazing angle over-reads slope
    envMapIntensity: 0.7,
    uniforms: () => ({
      uMode: f(0), uBase: v3(0xffffff), uCells: f(16),
      uRelief: f(0.010), uWear: f(0.30), uDebris: f(0.06),
    }),
  },
  dirt: {
    glsl: GROUND_GLSL,
    tileMeters: 2.0,
    detail: 'mid',
    normalScale: 0.7,
    envMapIntensity: 0.65,
    uniforms: () => ({
      uMode: f(1), uBase: v3(0xffffff), uCells: f(16),
      uRelief: f(0.012), uWear: f(0.55), uDebris: f(0.10),
    }),
  },
  gravel: {
    glsl: GROUND_GLSL,
    tileMeters: 1.6,
    detail: 'mid',
    normalScale: 0.9,
    envMapIntensity: 0.7,
    uniforms: () => ({
      uMode: f(2), uBase: v3(0xffffff), uCells: f(32),   // ~50 mm stone
      uRelief: f(0.018), uWear: f(0.40), uDebris: f(0.05),
    }),
  },
  sand: {
    glsl: GROUND_GLSL,
    tileMeters: 1.6,
    detail: 'low',
    normalScale: 0.6,
    envMapIntensity: 0.8,
    uniforms: () => ({
      uMode: f(3), uBase: v3(0xffffff), uCells: f(8),
      uRelief: f(0.007), uWear: f(0.35), uDebris: f(0.25),
    }),
  },
  mulch: {
    glsl: GROUND_GLSL,
    tileMeters: 1.2,
    detail: 'low',
    normalScale: 0.9,
    envMapIntensity: 0.6,
    uniforms: () => ({
      uMode: f(4), uBase: v3(0xffffff), uCells: f(12),   // ~100 mm chips
      uRelief: f(0.012), uWear: f(0.40), uDebris: f(0.10),
    }),
  },
};

/**
 * Names that resolve onto a baked family, optionally with a default tint.
 * These exist because other modules legitimately think in their own
 * vocabulary — the roads module says `tarmac`, the landmarks module says
 * `granite` — and a name that fails to resolve is a visual bug.
 */
interface Derived { family: string; tint?: number }

const DERIVED: Record<string, Derived> = {
  // stone family
  granite: { family: 'stone' },
  marble: { family: 'limestone', tint: 0xf2efe7 },
  sandstone: { family: 'brownstone', tint: 0xd9b68e },
  ashlar: { family: 'limestone' },
  // cement family
  cement: { family: 'concrete' },
  precast: { family: 'concrete' },
  board_concrete: { family: 'concrete_board' },
  sidewalk: { family: 'concrete_sidewalk' },
  paving: { family: 'concrete_sidewalk' },
  stucco: { family: 'plaster' },
  paint: { family: 'plaster' },
  render: { family: 'plaster' },
  // metal family
  aluminium: { family: 'metal' },
  aluminum: { family: 'metal' },
  steel: { family: 'metal', tint: 0xd3d7da },
  darkmetal: { family: 'metal_painted', tint: 0x464c54 },
  painted_steel: { family: 'metal_painted' },
  bronze: { family: 'copper', tint: 0xb98f5e },
  brass: { family: 'gold', tint: 0xd8bf7a },
  // roofing
  roof: { family: 'roof_membrane' },
  epdm: { family: 'roof_membrane' },
  shingle: { family: 'roof_shingle' },
  asphalt_shingle: { family: 'roof_shingle' },
  terracotta: { family: 'roof_tile' },
  pantile: { family: 'roof_tile' },
  standing_seam: { family: 'roof_metal' },
  zinc: { family: 'roof_metal', tint: 0xa8adb0 },
  lead: { family: 'roof_metal', tint: 0x8d9196 },
  roof_slate: { family: 'slate' },
  // pavements
  road: { family: 'asphalt' },
  tarmac: { family: 'asphalt' },
  bitumen: { family: 'asphalt' },
  parking: { family: 'asphalt_lot' },
  cobble: { family: 'cobblestone' },
  cobbles: { family: 'cobblestone' },
  setts: { family: 'sett' },
  granite_sett: { family: 'sett' },
  paver: { family: 'brick_paver' },
  brick_pavers: { family: 'brick_paver' },
  // wood
  timber: { family: 'wood' },
  clapboard: { family: 'wood' },
  siding: { family: 'wood' },
  plank: { family: 'wood_plank' },
  decking: { family: 'wood_plank' },
  // ground
  lawn: { family: 'grass' },
  turf: { family: 'grass' },
  earth: { family: 'dirt' },
  soil: { family: 'dirt' },
  ballast: { family: 'gravel' },
  beach: { family: 'sand' },
  bark: { family: 'mulch' },
};

/** Every name `get()` and `textures()` resolve, in registration order. */
export const MATERIAL_NAMES: readonly string[] = [
  ...Object.keys(FAMILIES),
  ...Object.keys(DERIVED),
];

/** Base albedo/normal resolution per tier. */
const BASE_RES: Record<string, number> = { ultra: 2048, high: 2048, medium: 1024, low: 512 };

/** Hard ceiling on baked texture memory, bytes. Later bakes degrade to fit. */
const BUDGET: Record<string, number> = {
  ultra: 330 * 1024 * 1024,
  high: 260 * 1024 * 1024,
  medium: 96 * 1024 * 1024,
  low: 28 * 1024 * 1024,
};

// ========================================================= anti-tiling ====

export interface AntiTilingOptions {
  /**
   * Hex-cell stochastic sampling. Three offset copies of the texture are
   * blended by the barycentric weights of a triangle grid, which removes the
   * UV-tile lattice entirely. Correct for *stochastic* surfaces — grass,
   * gravel, dirt, sand, asphalt, water-stained concrete. Leave it off for
   * anything with a bond pattern (brick, setts, clapboard): random offsets
   * would tear the courses apart. Default true.
   */
  hex?: boolean;
  /**
   * Triangle-grid frequency in texture tiles. Smaller cells break the tile up
   * more aggressively but blend more often; larger cells keep more of the
   * source texture intact. 0.4 means roughly one hex per 1.5 tiles. Default 0.4.
   */
  hexScale?: number;
  /**
   * Weight sharpening exponent. Higher pushes each pixel toward a single
   * source sample, which preserves contrast at the cost of slightly visible
   * cell borders. 3 is soft, 8 is crisp. Default 5.
   */
  hexContrast?: number;
  /**
   * Wavelength in world metres of a low-frequency albedo breakup driven by
   * world position. This is what kills the "quilt" read on a brick wall seen
   * from 200 m, where the tile itself is far below a pixel. 0 disables.
   * Default 0 for `applyAntiTiling`, 34 m when requested through `tiled()`.
   */
  macroMeters?: number;
  /** Peak +/- albedo swing of the macro breakup, 0..1. Default 0.16. */
  macroStrength?: number;
}

/**
 * GLSL for modules that write their own shaders instead of using a
 * `MeshStandardMaterial`. Declares `bosAtSample(sampler2D, vec2)` and
 * `bosAtMacro(vec3 worldPos)`; both expect `BOS_AT_SCALE`, `BOS_AT_CONTRAST`,
 * `BOS_AT_MACRO_FREQ` and `BOS_AT_MACRO_AMP` to be `#define`d beforehand.
 */
export const ANTI_TILING_GLSL = /* glsl */ `
vec2 bosAtHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float bosAtHash1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * Barycentric weights and lattice ids of the three hexagon centres nearest
 * 'uv'. The skew turns the hex lattice into a unit triangle grid, so the
 * lookup is two floors and a compare.
 */
void bosAtTriGrid(vec2 uv, out vec3 w, out vec2 v1, out vec2 v2, out vec2 v3) {
  uv *= 3.4641016;
  vec2 skew = mat2(1.0, 0.0, -0.5773503, 1.1547005) * uv;
  vec2 base = floor(skew);
  vec3 t = vec3(fract(skew), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(t.z, 0.0);
  float s2 = 2.0 * s - 1.0;
  w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  v1 = base + vec2(s, s);
  v2 = base + vec2(s, 1.0 - s);
  v3 = base + vec2(1.0 - s, s);
}

/**
 * Three-tap stochastic sample. Explicit gradients keep the mip level tied to
 * the *unoffset* UV, so the offsets cannot smear the texture at cell borders.
 */
vec4 bosAtSample(sampler2D tex, vec2 uv) {
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec3 w; vec2 v1, v2, v3;
  bosAtTriGrid(uv * BOS_AT_SCALE, w, v1, v2, v3);
  vec4 c1 = textureGrad(tex, uv + bosAtHash2(v1), dx, dy);
  vec4 c2 = textureGrad(tex, uv + bosAtHash2(v2), dx, dy);
  vec4 c3 = textureGrad(tex, uv + bosAtHash2(v3), dx, dy);
  vec3 ww = pow(max(w, vec3(0.0)), vec3(BOS_AT_CONTRAST));
  ww /= max(ww.x + ww.y + ww.z, 1e-5);
  return c1 * ww.x + c2 * ww.y + c3 * ww.z;
}

/** Tileable-free value noise on a world-space plane, for the macro breakup. */
float bosAtValue(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = bosAtHash1(i);
  float b = bosAtHash1(i + vec2(1.0, 0.0));
  float c = bosAtHash1(i + vec2(0.0, 1.0));
  float d = bosAtHash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Low-frequency albedo multiplier keyed to world position. The domain is
 * sheared by Y so vertical faces vary up the building, not just across it.
 */
float bosAtMacro(vec3 wp) {
  vec2 q = vec2(wp.x + wp.y * 0.37, wp.z + wp.y * 0.61) * BOS_AT_MACRO_FREQ;
  float n = bosAtValue(q) * 0.6 + bosAtValue(q * 2.17 + 11.3) * 0.3
          + bosAtValue(q * 4.61 + 5.7) * 0.1;
  return 1.0 + (n - 0.5) * 2.0 * BOS_AT_MACRO_AMP;
}
`;

const AT_MAP = /* glsl */ `
#ifdef USE_MAP
  diffuseColor *= bosAtSample( map, vMapUv );
#endif`;

const AT_NORMAL = /* glsl */ `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = bosAtSample( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = bosAtSample( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`;

const AT_ROUGHNESS = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= bosAtSample( roughnessMap, vRoughnessMapUv ).g;
#endif`;

const AT_METALNESS = /* glsl */ `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  metalnessFactor *= bosAtSample( metalnessMap, vMetalnessMapUv ).b;
#endif`;

const AT_AO = /* glsl */ `
#ifdef USE_AOMAP
  float ambientOcclusion = ( bosAtSample( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif`;

const AT_WORLDPOS_VERT = /* glsl */ `
vec4 bosAtWp = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  bosAtWp = batchingMatrix * bosAtWp;
#endif
#ifdef USE_INSTANCING
  bosAtWp = instanceMatrix * bosAtWp;
#endif
bosWorldPos = ( modelMatrix * bosAtWp ).xyz;`;

/**
 * Anti-tiling for a `MeshStandardMaterial`/`MeshPhysicalMaterial`.
 *
 * Terrain and Roads: call this on a material you own (it mutates, and a
 * library material is shared, so clone first — or use
 * `Materials.tiled(name, opts)` which clones for you).
 *
 * ```ts
 * const road = ctx.materials.get('asphalt').clone() as THREE.MeshStandardMaterial;
 * applyAntiTiling(road, { hexScale: 0.3, macroMeters: 40 });
 * ```
 */
export function applyAntiTiling<T extends THREE.Material>(
  material: T,
  opts: AntiTilingOptions = {},
): T {
  const hex = opts.hex ?? true;
  const scale = opts.hexScale ?? 0.4;
  const contrast = opts.hexContrast ?? 5;
  const macro = opts.macroMeters ?? 0;
  const macroAmp = opts.macroStrength ?? 0.16;
  if (!hex && macro <= 0) return material;

  const defines =
    `#define BOS_AT_SCALE ${scale.toFixed(4)}\n` +
    `#define BOS_AT_CONTRAST ${contrast.toFixed(3)}\n` +
    `#define BOS_AT_MACRO_FREQ ${(1 / Math.max(macro, 1e-3)).toFixed(6)}\n` +
    `#define BOS_AT_MACRO_AMP ${macroAmp.toFixed(4)}\n`;

  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec3 bosWorldPos;\n${defines}${ANTI_TILING_GLSL}`,
    );
    if (hex) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', AT_MAP)
        .replace('#include <normal_fragment_maps>', AT_NORMAL)
        .replace('#include <roughnessmap_fragment>', AT_ROUGHNESS)
        .replace('#include <metalnessmap_fragment>', AT_METALNESS)
        .replace('#include <aomap_fragment>', AT_AO);
    }
    if (macro > 0) {
      // After the albedo fetch, before lighting.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        '#include <alphamap_fragment>\ndiffuseColor.rgb *= bosAtMacro( bosWorldPos );',
      );
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 bosWorldPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>${AT_WORLDPOS_VERT}`);
  };
  // Patched and unpatched variants must not share a compiled program.
  material.customProgramCacheKey = () => `bosAT|${hex ? 1 : 0}|${scale}|${contrast}|${macro}|${macroAmp}`;
  material.needsUpdate = true;
  return material;
}

/**
 * Families whose pattern is a *bond* rather than a scatter. Hex-cell offsets
 * would slice their courses apart, so they get macro breakup only.
 */
const STRUCTURED = new Set([
  'brick', 'brick_paver', 'sett', 'cobblestone', 'glass', 'slate',
  'roof_shingle', 'roof_tile', 'roof_metal', 'wood', 'wood_plank',
  'brownstone', 'limestone', 'stone', 'concrete_sidewalk', 'concrete_board',
  'metal',
]);

/**
 * Sensible anti-tiling settings for a family, so callers do not have to know
 * whether a surface is stochastic. Pass the result straight to
 * `applyAntiTiling` or `Materials.tiled`.
 */
export function antiTilingPreset(name: string): AntiTilingOptions {
  const key = FAMILIES[name] ? name : (DERIVED[name]?.family ?? name);
  return STRUCTURED.has(key)
    ? { hex: false, macroMeters: 30, macroStrength: 0.18 }
    : { hex: true, hexScale: 0.38, hexContrast: 5, macroMeters: 46, macroStrength: 0.18 };
}

// ============================================================== module ====

/** Owns the procedural PBR texture library shared by every other module. */
export class Materials implements WorldModule {
  readonly name = 'Materials';

  private ctx!: Ctx;
  private forge!: TextureForge;
  /** Baked family name -> texture set. */
  private sets = new Map<string, BakedSet>();
  /** Externally registered sets, tracked so they participate in disposal. */
  private external = new Map<string, TextureSet>();
  private cache = new Map<string, THREE.Material>();
  private owned: THREE.Material[] = [];
  private fallback!: THREE.MeshStandardMaterial;
  private envRef: THREE.Texture | null = null;
  private missing = new Set<string>();
  private retiring: THREE.WebGLRenderTarget[] = [];
  private retireAt = 0;

  /** Milliseconds spent in `init()`. Baking is lazy, so this is tiny by design. */
  bootMs = 0;
  /** Cumulative GPU bake time, milliseconds. */
  bakeMs = 0;
  /** Estimated texture memory in bytes, mip chains included. */
  bytes = 0;

  init(ctx: Ctx): void {
    const t0 = performance.now();
    this.ctx = ctx;
    this.forge = new TextureForge(ctx.renderer);

    this.fallback = new THREE.MeshStandardMaterial({
      color: 0x9d988e,
      roughness: 0.88,
      metalness: 0,
    });
    this.fallback.name = 'bos:fallback';
    this.owned.push(this.fallback);

    const library: MaterialLibrary = {
      textures: (name) => this.textures(name),
      get: (name, tint) => this.get(name, tint),
      register: (name, set) => this.register(name, set),
    };
    ctx.materials = library;

    ctx.on('quality-changed', () => this.onQualityChanged());

    this.bootMs = performance.now() - t0;
    ctx.stats['mat.boot'] = `${this.bootMs.toFixed(1)}ms`;
  }

  update(_dt: number, ctx: Ctx): void {
    // Sky publishes the IBL after we initialise, so adopt it when it appears.
    if (ctx.envMap !== this.envRef) {
      this.envRef = ctx.envMap;
      for (const m of this.owned) {
        const s = m as THREE.MeshStandardMaterial;
        if ('envMap' in s) {
          s.envMap = this.envRef;
          s.needsUpdate = true;
        }
      }
    }
    // Targets replaced by a quality change are freed a beat later so anything
    // still holding a clone gets one frame to notice `materials-rebuilt`.
    if (this.retiring.length && ctx.elapsed > this.retireAt) {
      for (const rt of this.retiring) rt.dispose();
      this.retiring.length = 0;
    }
  }

  // ------------------------------------------------------------ lookup ----

  /** Family key for a public name, or undefined if nothing matches. */
  private resolve(name: string): string | undefined {
    if (FAMILIES[name]) return name;
    const d = DERIVED[name];
    if (d) return d.family;
    if (this.external.has(name)) return name;
    return undefined;
  }

  textures(name: string): TextureSet | undefined {
    const ext = this.external.get(name);
    if (ext) return ext;
    const key = this.resolve(name);
    if (!key) return undefined;
    const already = this.external.get(key);
    if (already) return already;
    return this.ensure(key);
  }

  /** Baked set for a family, baking it on first request. */
  private ensure(key: string): BakedSet | undefined {
    const hit = this.sets.get(key);
    if (hit) return hit;
    const def = FAMILIES[key];
    if (!def) return undefined;
    const set = this.bakeFamily(key, def);
    this.sets.set(key, set);
    return set;
  }

  get(name: string, tint?: number): THREE.Material {
    const key = this.resolve(name);
    const derived = DERIVED[name];
    const colour = tint ?? derived?.tint ?? FAMILIES[key ?? '']?.tint;
    const id = `${key ?? `?${name}`}|${colour ?? ''}`;
    const hit = this.cache.get(id);
    if (hit) return hit;

    const built = key ? this.build(key, colour) : this.buildFallback(name, colour);
    this.cache.set(id, built);
    return built;
  }

  register(name: string, set: TextureSet): void {
    Materials.adopt(set, this.ctx?.quality.anisotropy ?? 4);
    this.external.set(name, set);
  }

  /**
   * Cloned copy of a library material with anti-tiling compiled in. This is
   * the entry point Terrain and Roads should use: the library keeps ownership
   * (so disposal still works) but the caller gets a material it cannot
   * accidentally share.
   */
  tiled(name: string, opts: AntiTilingOptions = {}, tint?: number): THREE.Material {
    const base = this.get(name, tint);
    const key = `${name}|${tint ?? ''}|at|${JSON.stringify(opts)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const clone = base.clone();
    clone.name = `${base.name}:tiled`;
    applyAntiTiling(clone, { ...antiTilingPreset(name), ...opts });
    this.cache.set(key, clone);
    this.owned.push(clone);
    return clone;
  }

  /** Force a family (or several) to bake now rather than on first use. */
  warm(...names: string[]): void {
    for (const n of names) this.textures(n);
  }

  // ------------------------------------------------------------- bake ----

  private baseRes(): number {
    return BASE_RES[this.ctx.tier] ?? 1024;
  }

  private budget(): number {
    return BUDGET[this.ctx.tier] ?? BUDGET.medium;
  }

  /**
   * Resolution for a family: the tier's base scaled by the family's
   * importance, then halved as many times as it takes to fit the remaining
   * memory ceiling. Never below 256, which still reads at distance.
   */
  private resolutionFor(def: FamilyDef): number {
    const floor = Math.min(DETAIL_FLOOR[def.detail], this.baseRes());
    const wanted = Math.max(floor, Math.round((this.baseRes() * DETAIL_SCALE[def.detail]) / 64) * 64);
    const div = def.ormDiv ?? 2;
    let res = wanted;
    while (res > floor && this.bytes + Materials.estimate(res, div) > this.budget()) {
      res = Math.max(floor, res >> 1);
    }
    return res;
  }

  /** Bytes for an albedo + normal + ORM set at this resolution, mips included. */
  private static estimate(res: number, ormDiv: number): number {
    const px = (n: number) => Math.round(n * n * 4 * 1.3334);
    return px(res) * 2 + px(Math.max(64, Math.floor(res / ormDiv)));
  }

  private bakeFamily(key: string, def: FamilyDef): BakedSet {
    const t0 = performance.now();
    const res = this.resolutionFor(def);
    const set = this.forge.bake({
      fragment: def.glsl,
      uniforms: def.uniforms(),
      res,
      tileMeters: def.tileMeters,
      ormDiv: def.ormDiv ?? 2,
      normalStrength: def.normalStrength ?? 1,
      anisotropy: this.ctx.quality.anisotropy,
    });
    Materials.adopt(set, this.ctx.quality.anisotropy, key);
    this.bytes += set.bytes;
    this.bakeMs += performance.now() - t0;
    this.ctx.stats['mat.vram'] = `${(this.bytes / 1048576).toFixed(0)}MB`;
    this.ctx.stats['mat.baked'] = this.sets.size + 1;
    return set;
  }

  /**
   * The colour-management gate. Nothing leaves this module without `map` in
   * sRGB and every data map in `NoColorSpace`.
   */
  private static adopt(set: TextureSet, anisotropy: number, name?: string): void {
    set.map.colorSpace = THREE.SRGBColorSpace;
    if (name) set.map.name = `bos:${name}:albedo`;
    const data = [set.normalMap, set.roughnessMap, set.metalnessMap, set.aoMap];
    for (const t of data) {
      if (!t) continue;
      t.colorSpace = THREE.NoColorSpace;
    }
    if (set.normalMap && name) set.normalMap.name = `bos:${name}:normal`;
    if (set.roughnessMap && name) set.roughnessMap.name = `bos:${name}:orm`;
    for (const t of [set.map, ...data]) {
      if (!t) continue;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
      t.needsUpdate = true;
    }
  }

  // --------------------------------------------------------- materials ----

  private build(key: string, tint?: number): THREE.Material {
    const set = this.external.get(key) ?? this.ensure(key);
    const def = FAMILIES[key];
    if (!set) return this.buildFallback(key, tint);

    const params: THREE.MeshPhysicalMaterialParameters = {
      color: tint ?? 0xffffff,
      map: set.map,
      normalMap: set.normalMap ?? null,
      roughnessMap: set.roughnessMap ?? null,
      metalnessMap: set.metalnessMap ?? null,
      aoMap: set.aoMap ?? null,
      // The ORM pack carries the real values; the scalars are pure multipliers.
      roughness: set.roughnessMap ? 1 : 0.85,
      metalness: set.metalnessMap ? 1 : 0,
      envMapIntensity: def?.envMapIntensity ?? 1,
      ...(def?.extra ?? {}),
    };

    const m = def?.physical
      ? new THREE.MeshPhysicalMaterial(params)
      : new THREE.MeshStandardMaterial(params);
    m.name = `bos:${key}${tint !== undefined ? `#${tint.toString(16)}` : ''}`;
    if (m.normalMap) {
      const n = def?.normalScale ?? 1;
      m.normalScale.set(n, n);
    }
    m.aoMapIntensity = def?.aoIntensity ?? 1;
    if (this.envRef) m.envMap = this.envRef;
    this.owned.push(m);
    return m;
  }

  private buildFallback(name: string, tint?: number): THREE.Material {
    if (!this.missing.has(name)) {
      this.missing.add(name);
      console.warn(`[Materials] no family for '${name}' — using a tinted fallback`);
    }
    if (tint === undefined) return this.fallback;
    const m = this.fallback.clone();
    m.color.setHex(tint, THREE.SRGBColorSpace);
    m.name = `bos:fallback:${name}`;
    this.owned.push(m);
    return m;
  }

  // ----------------------------------------------------------- quality ----

  /**
   * Anisotropy is free to change in place. Resolution is not: a different
   * tier means a re-bake, so the texture objects on every live material are
   * swapped and the old targets are retired a frame later.
   */
  private onQualityChanged(): void {
    const aniso = this.ctx.quality.anisotropy;
    for (const set of [...this.sets.values(), ...this.external.values()]) {
      for (const t of [set.map, set.normalMap, set.roughnessMap, set.metalnessMap, set.aoMap]) {
        if (t) t.anisotropy = aniso;
      }
    }

    const keys = [...this.sets.keys()];
    let rebaked = 0;
    this.bytes = 0;
    for (const key of keys) {
      const def = FAMILIES[key];
      const old = this.sets.get(key);
      if (!def || !old) continue;
      if (old.map.image?.width === this.resolutionFor(def)) {
        this.bytes += old.bytes;
        continue;
      }
      const next = this.bakeFamily(key, def);
      this.sets.set(key, next);
      this.retiring.push(...old.targets);
      this.swap(old, next);
      rebaked++;
    }
    this.retireAt = this.ctx.elapsed + 0.5;
    if (rebaked) this.ctx.emit('materials-rebuilt', rebaked);
  }

  /** Repoint every live material from an old texture set to a new one. */
  private swap(from: TextureSet, to: TextureSet): void {
    for (const mat of this.owned) {
      const m = mat as THREE.MeshStandardMaterial;
      let touched = false;
      if (m.map === from.map) { m.map = to.map; touched = true; }
      if (m.normalMap && m.normalMap === from.normalMap) { m.normalMap = to.normalMap ?? null; touched = true; }
      if (m.roughnessMap && m.roughnessMap === from.roughnessMap) { m.roughnessMap = to.roughnessMap ?? null; touched = true; }
      if (m.metalnessMap && m.metalnessMap === from.metalnessMap) { m.metalnessMap = to.metalnessMap ?? null; touched = true; }
      if (m.aoMap && m.aoMap === from.aoMap) { m.aoMap = to.aoMap ?? null; touched = true; }
      if (touched) m.needsUpdate = true;
    }
  }

  // ----------------------------------------------------------- teardown ----

  dispose(ctx: Ctx): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.cache.clear();

    for (const set of this.sets.values()) for (const rt of set.targets) rt.dispose();
    this.sets.clear();

    for (const set of this.external.values()) {
      for (const t of [set.map, set.normalMap, set.roughnessMap, set.metalnessMap, set.aoMap]) {
        t?.dispose();
      }
    }
    this.external.clear();

    for (const rt of this.retiring) rt.dispose();
    this.retiring.length = 0;

    this.forge.dispose();
    this.bytes = 0;

    // Leave a working stub so anything that outlives us still renders.
    const stub = new THREE.MeshStandardMaterial({ color: 0x9d988e, roughness: 0.9 });
    ctx.materials = {
      textures: () => undefined,
      get: () => stub,
      register: () => {},
    };
  }
}
