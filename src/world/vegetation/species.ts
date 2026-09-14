/**
 * The six street/park tree species the data pipeline assigns, chosen to match
 * what actually grows in Boston.
 *
 * The city's street inventory is dominated by red maple, honey locust, little-
 * leaf/American linden and red oak; cherry lines the park walks and white pine
 * turns up on the wilder edges of the Emerald Necklace. Each entry carries
 * enough to build a *distinguishable silhouette* — crown archetype, leaf
 * outline, branching habit — because a canopy where every species is the same
 * green ball is the single loudest tell of a procedural city.
 *
 * Autumn colour is a real feature of Boston, so each species carries a summer
 * and an autumn canopy colour plus how early it turns. Peak foliage in eastern
 * Massachusetts is the third week of October.
 */
import * as THREE from 'three';

/** Outer envelope of the leaf mass. Drives both geometry and impostor art. */
export type CrownShape =
  | 'rounded'    // red maple: dense ovoid
  | 'spreading'  // red oak: wide, heavy horizontal limbs, flattish top
  | 'pyramidal'  // linden: broad-based cone, dense to the ground
  | 'vase'       // honey locust: high, open, airy, widest at the top
  | 'conical'    // white pine: whorled tiers
  | 'umbrella';  // cherry: low dome, wider than tall

/** Leaf outline drawn into the foliage-card texture. */
export type LeafShape = 'maple' | 'oak' | 'cordate' | 'pinnate' | 'needle' | 'ovate';

export type BarkKind = 'ridged' | 'plated' | 'lenticel';

/** Where in the city a species is likely to be planted. Weights, not shares. */
export interface Habitat {
  street: number;
  park: number;
  forest: number;
  lawn: number;
}

export interface Species {
  name: string;
  /** Mature height in metres, before the per-tree size multiplier. */
  height: number;
  /** Crown width as a fraction of total height. */
  spread: number;
  /** Height of the crown base as a fraction of total height. */
  crownBase: number;
  shape: CrownShape;
  leaf: LeafShape;
  bark: BarkKind;
  conifer: boolean;
  /** Primary limbs leaving the trunk. */
  limbs: number;
  /** Relative leaf-card density. 1.0 = solid canopy, 0.6 = you see sky through it. */
  density: number;
  /** Foliage-card size as a fraction of crown radius. */
  cardScale: number;
  /** Trunk radius at the base as a fraction of height. */
  trunkRadius: number;
  summerColor: number;
  autumnColor: number;
  /** Bark albedo tint (sRGB). */
  barkColor: number;
  /** How strongly the crown sways; open-crowned species move more. */
  sway: number;
  /** <1 turns late (oak), >1 turns early (maple). */
  turnBias: number;
  habitat: Habitat;
}

export const SPECIES: Species[] = [
  {
    name: 'red maple',
    height: 16, spread: 0.64, crownBase: 0.33, shape: 'rounded', leaf: 'maple',
    bark: 'ridged', conifer: false, limbs: 4, density: 0.95, cardScale: 0.62,
    trunkRadius: 0.019,
    summerColor: 0x6d9a4e, autumnColor: 0xd4491f, barkColor: 0x6a6157,
    sway: 1.0, turnBias: 1.35,
    habitat: { street: 1.5, park: 0.9, forest: 0.9, lawn: 1.0 },
  },
  {
    name: 'red oak',
    height: 21, spread: 0.88, crownBase: 0.36, shape: 'spreading', leaf: 'oak',
    bark: 'ridged', conifer: false, limbs: 5, density: 0.9, cardScale: 0.68,
    trunkRadius: 0.024,
    summerColor: 0x5d8a43, autumnColor: 0xa85c2c, barkColor: 0x736a5e,
    sway: 0.72, turnBias: 0.7,
    habitat: { street: 0.8, park: 1.8, forest: 1.6, lawn: 1.3 },
  },
  {
    name: 'american linden',
    height: 18, spread: 0.56, crownBase: 0.26, shape: 'pyramidal', leaf: 'cordate',
    bark: 'ridged', conifer: false, limbs: 5, density: 1.05, cardScale: 0.56,
    trunkRadius: 0.018,
    summerColor: 0x6f9a48, autumnColor: 0xd2b148, barkColor: 0x6d675c,
    sway: 0.85, turnBias: 1.1,
    habitat: { street: 1.4, park: 0.9, forest: 0.4, lawn: 0.8 },
  },
  {
    name: 'honey locust',
    height: 15, spread: 0.82, crownBase: 0.47, shape: 'vase', leaf: 'pinnate',
    bark: 'plated', conifer: false, limbs: 4, density: 0.6, cardScale: 0.74,
    trunkRadius: 0.016,
    summerColor: 0x86a851, autumnColor: 0xe0c04d, barkColor: 0x5e564b,
    sway: 1.4, turnBias: 1.2,
    habitat: { street: 1.7, park: 0.6, forest: 0.15, lawn: 0.6 },
  },
  {
    name: 'white pine',
    height: 24, spread: 0.44, crownBase: 0.18, shape: 'conical', leaf: 'needle',
    bark: 'plated', conifer: true, limbs: 7, density: 0.88, cardScale: 0.5,
    trunkRadius: 0.017,
    summerColor: 0x4a6b4a, autumnColor: 0x4a6b4a, barkColor: 0x584d42,
    sway: 0.5, turnBias: 0,
    habitat: { street: 0.05, park: 0.7, forest: 1.5, lawn: 0.3 },
  },
  {
    name: 'cherry',
    height: 9, spread: 0.98, crownBase: 0.30, shape: 'umbrella', leaf: 'ovate',
    bark: 'lenticel', conifer: false, limbs: 5, density: 1.0, cardScale: 0.6,
    trunkRadius: 0.021,
    summerColor: 0x6b9349, autumnColor: 0xd06a44, barkColor: 0x7a5a4c,
    sway: 1.2, turnBias: 1.5,
    habitat: { street: 0.7, park: 1.4, forest: 0.2, lawn: 1.1 },
  },
];

/** Index of the habitat weights, matching `LandClass` in landmask.ts. */
export type HabitatKey = keyof Habitat;

/**
 * Fraction of autumn colour for a given day of year at Boston's latitude.
 * Peak foliage in eastern Massachusetts is around 20 October (day ~293);
 * leaves are down by mid-November and the canopy is green again by late May.
 */
export function autumnFactor(dayOfYear: number): number {
  const d = dayOfYear;
  if (d < 248 || d > 332) return 0;
  return THREE.MathUtils.clamp(d <= 293 ? (d - 248) / 45 : 1 - (d - 293) / 39, 0, 1);
}

/**
 * Radius of the crown envelope at height fraction `t` (0 at the crown base,
 * 1 at the apex), normalised so the maximum is 1. This is the silhouette; it
 * is what makes an oak read as an oak from 80 m away.
 */
export function crownRadius(shape: CrownShape, t: number): number {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  switch (shape) {
    case 'rounded':
      return Math.pow(Math.sin(Math.PI * (0.13 + 0.8 * u)), 0.62);
    case 'spreading':
      // Widest low down, then a broad, almost flat top.
      return Math.pow(Math.sin(Math.PI * (0.22 + 0.62 * u)), 0.42) * (1 - 0.14 * u * u);
    case 'pyramidal':
      return Math.pow(1 - u, 0.58) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, u * 3.2)));
    case 'vase':
      return (0.28 + 0.72 * Math.pow(u, 0.75)) * (1 - 0.25 * Math.pow(u, 6));
    case 'conical':
      return Math.pow(1 - u, 0.92) * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, u * 6)));
    case 'umbrella':
      return Math.pow(Math.sin(Math.PI * (0.3 + 0.62 * u)), 0.32) * (1 - 0.5 * Math.pow(u, 4));
  }
}
