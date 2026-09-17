/**
 * The eight street/park tree species the data pipeline assigns, chosen to
 * match what actually grows in Boston.
 *
 * The city's street inventory is dominated by honey locust, Norway/red maple,
 * London plane and littleleaf linden; red oak and white pine hold the wilder
 * edges of the Emerald Necklace; cherry lines the park walks; and the
 * Commonwealth Avenue Mall carries one of the largest surviving stands of
 * American elm in the country, which is the single most recognisable tree
 * silhouette in Boston. Each entry carries enough to build a *distinguishable
 * silhouette* — crown archetype, leaf outline, leaf *size*, branching habit —
 * because a canopy where every species is the same green ball is the loudest
 * tell of a procedural city, and a canopy whose individual leaves are half a
 * metre across is the second loudest.
 *
 * Autumn colour is a real feature of Boston, and it is emphatically *not*
 * uniform: the turn runs about six weeks from the first red maples in a wet
 * hollow to the last brown London planes, and on any given day in October a
 * street holds green, turning and turned trees side by side. So each species
 * carries a summer colour, a peak colour, and a *turn bias* that shifts when
 * it starts rather than how strongly it finishes — see `autumnFactor` and the
 * per-tree threshold in `material.ts`.
 */
import * as THREE from 'three';

/** Outer envelope of the leaf mass. Drives both geometry and impostor art. */
export type CrownShape =
  | 'rounded'    // red maple: dense ovoid
  | 'spreading'  // red oak, London plane: wide heavy limbs, flattish top
  | 'pyramidal'  // linden: broad-based cone, dense to the ground
  | 'vase'       // honey locust: high, open, airy, widest at the top
  | 'goblet'     // american elm: narrow bole, arching limbs, very broad fan
  | 'conical'    // white pine: whorled tiers
  | 'umbrella';  // cherry: low dome, wider than tall

/** Leaf outline drawn into the foliage-card texture. */
export type LeafShape =
  | 'maple' | 'oak' | 'cordate' | 'pinnate' | 'needle' | 'ovate'
  | 'elliptic'  // elm: asymmetric toothed ellipse
  | 'palmate';  // London plane: three big shallow lobes

export type BarkKind = 'ridged' | 'plated' | 'lenticel' | 'mottled';

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
  /**
   * Length of one leaf in metres. This is what sets the texel scale of the
   * foliage card, and getting it wrong by 5x — which is the default outcome of
   * authoring a card as "a tile with some leaves on it" — is instantly
   * readable at street level.
   */
  leafMeters: number;
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
  /** >1 turns early (red maple, cherry), <1 turns late (oak, plane). */
  turnBias: number;
  habitat: Habitat;
}

export const SPECIES: Species[] = [
  {
    name: 'red maple',
    height: 16, spread: 0.66, crownBase: 0.33, shape: 'rounded', leaf: 'maple',
    leafMeters: 0.10,
    bark: 'ridged', conifer: false, limbs: 4, density: 0.95, cardScale: 0.34,
    trunkRadius: 0.019,
    summerColor: 0x5f8a45, autumnColor: 0xa8523a, barkColor: 0x6a6157,
    sway: 1.0, turnBias: 1.45,
    habitat: { street: 1.5, park: 0.9, forest: 0.9, lawn: 1.0 },
  },
  {
    name: 'red oak',
    height: 21, spread: 0.88, crownBase: 0.36, shape: 'spreading', leaf: 'oak',
    leafMeters: 0.16,
    bark: 'ridged', conifer: false, limbs: 5, density: 0.9, cardScale: 0.32,
    trunkRadius: 0.024,
    summerColor: 0x557f3e, autumnColor: 0x96552f, barkColor: 0x736a5e,
    sway: 0.72, turnBias: 0.62,
    habitat: { street: 0.6, park: 1.8, forest: 1.6, lawn: 1.3 },
  },
  {
    name: 'littleleaf linden',
    height: 18, spread: 0.56, crownBase: 0.28, shape: 'pyramidal', leaf: 'cordate',
    leafMeters: 0.08,
    bark: 'ridged', conifer: false, limbs: 5, density: 1.05, cardScale: 0.30,
    trunkRadius: 0.018,
    summerColor: 0x6a9349, autumnColor: 0xb09750, barkColor: 0x6d675c,
    sway: 0.85, turnBias: 1.05,
    habitat: { street: 1.5, park: 0.9, forest: 0.35, lawn: 0.8 },
  },
  {
    name: 'honey locust',
    height: 15, spread: 0.84, crownBase: 0.47, shape: 'vase', leaf: 'pinnate',
    leafMeters: 0.20,
    bark: 'plated', conifer: false, limbs: 4, density: 0.58, cardScale: 0.40,
    trunkRadius: 0.016,
    summerColor: 0x7ea24f, autumnColor: 0xbda95a, barkColor: 0x5e564b,
    sway: 1.4, turnBias: 1.15,
    habitat: { street: 1.9, park: 0.6, forest: 0.12, lawn: 0.6 },
  },
  {
    name: 'white pine',
    height: 24, spread: 0.44, crownBase: 0.18, shape: 'conical', leaf: 'needle',
    leafMeters: 0.11,
    bark: 'plated', conifer: true, limbs: 7, density: 0.88, cardScale: 0.30,
    trunkRadius: 0.017,
    summerColor: 0x46664a, autumnColor: 0x46664a, barkColor: 0x584d42,
    sway: 0.5, turnBias: 0,
    habitat: { street: 0.04, park: 0.7, forest: 1.5, lawn: 0.3 },
  },
  {
    name: 'cherry',
    height: 9, spread: 0.98, crownBase: 0.30, shape: 'umbrella', leaf: 'ovate',
    leafMeters: 0.09,
    bark: 'lenticel', conifer: false, limbs: 5, density: 1.0, cardScale: 0.32,
    trunkRadius: 0.021,
    summerColor: 0x5d8443, autumnColor: 0xab6243, barkColor: 0x7a5a4c,
    sway: 1.2, turnBias: 1.35,
    habitat: { street: 0.6, park: 1.4, forest: 0.2, lawn: 1.1 },
  },
  {
    // Commonwealth Avenue Mall, the Public Garden, the Common. A narrow bole
    // to well above head height, then limbs that arch out into a fan twice as
    // wide as the trunk is tall. Nothing else in the city looks like it.
    name: 'american elm',
    height: 24, spread: 0.92, crownBase: 0.40, shape: 'goblet', leaf: 'elliptic',
    leafMeters: 0.10,
    bark: 'ridged', conifer: false, limbs: 5, density: 0.82, cardScale: 0.32,
    trunkRadius: 0.020,
    summerColor: 0x5b8442, autumnColor: 0xb09a52, barkColor: 0x6f6659,
    sway: 0.9, turnBias: 1.0,
    habitat: { street: 0.9, park: 1.5, forest: 0.2, lawn: 1.2 },
  },
  {
    // The city's other workhorse: mottled cream-and-olive bark, a leaf the
    // size of a hand, and it holds its brown leaves until December.
    name: 'london plane',
    height: 20, spread: 0.82, crownBase: 0.38, shape: 'spreading', leaf: 'palmate',
    leafMeters: 0.19,
    bark: 'mottled', conifer: false, limbs: 4, density: 0.9, cardScale: 0.38,
    trunkRadius: 0.022,
    // Pale, but not five times paler than every other trunk in the city.
    //
    // Every colour in this table is converted from sRGB to linear *twice* on
    // its way to the shader (`material.ts` says so and declines to change it,
    // because the whole palette was chosen by eye against the doubled
    // result). Squaring a conversion squares the ratios between colours as
    // well: at 0x9a9382 this bark came out at 0.070 linear against the ridged
    // barks' 0.0138 — a 5.1x spread where the real one is about 2.2 — and
    // with the trunk's un-occluded skylight gather on top of it (`canopy` is
    // 1.3 for bark, three times the leaves' share) a London plane standing in
    // the shade on Boston Common measured *brighter than sunlit foliage*:
    // 1.55x the frame's mean luma against 0.35x for a red oak's trunk four
    // metres away. What it read as was a dead tree — a bare white armature
    // among full crowns, which is exactly how it was first reported.
    //
    // 0x817a6c is the same hue at 83 % of the value, which after the doubling
    // lands at 0.0324 linear: 2.35x the ridged barks, which is about what a
    // plane's cream-and-olive plates really are against an oak's grey.
    summerColor: 0x6b8c4a, autumnColor: 0x9c8451, barkColor: 0x817a6c,
    sway: 0.8, turnBias: 0.42,
    habitat: { street: 1.6, park: 0.8, forest: 0.1, lawn: 0.5 },
  },
];

/** Index of the habitat weights, matching `LandClass` in landmask.ts. */
export type HabitatKey = keyof Habitat;

/** Dead-leaf brown every species passes through on its way out. */
export const SENESCENT = 0x7d6038;

/**
 * Progress through the autumn turn for a given day of year, 0 = full summer,
 * 1 = the far end of the turn. This is a *clock*, not an amount: the per-tree
 * threshold in the shader decides which trees have started, so a value of 0.25
 * means the earliest quarter of the city has begun and everything else is
 * still green.
 *
 * Eastern Massachusetts: first colour on the red maples around 20 September,
 * the city's peak in the third week of October, leaves down through mid
 * November. Boston proper runs a week or two behind the Berkshires.
 */
export function autumnFactor(dayOfYear: number): number {
  const d = dayOfYear;
  if (d < 252 || d > 334) return 0;
  // 252 (9 Sep) -> 0, 308 (4 Nov) -> 1, then the tail holds while the leaves
  // come down rather than snapping back to June.
  if (d <= 308) return THREE.MathUtils.clamp((d - 252) / 56, 0, 1);
  return THREE.MathUtils.clamp(1 - (d - 308) / 26, 0, 1);
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
    case 'goblet':
      // Flares faster and further than a vase, then flattens off at the rim.
      return (0.14 + 0.86 * Math.pow(u, 0.5)) * (1 - 0.30 * Math.pow(u, 5));
    case 'conical':
      return Math.pow(1 - u, 0.92) * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, u * 6)));
    case 'umbrella':
      return Math.pow(Math.sin(Math.PI * (0.3 + 0.62 * u)), 0.32) * (1 - 0.5 * Math.pow(u, 4));
  }
}
