/**
 * The six street/park tree species the data pipeline assigns (variant 0-5),
 * chosen to match what actually grows in Boston.
 *
 * Boston's street tree inventory is dominated by maple, honey locust, linden
 * and oak, with cherry in the parks and white pine on the Emerald Necklace's
 * wilder edges. Autumn colour is a real feature of the city, so each species
 * carries a summer and an autumn canopy colour that the module blends by
 * day-of-year.
 */
import * as THREE from 'three';

export interface Species {
  name: string;
  /** Mature height in metres before the per-tree scale jitter. */
  height: number;
  /** Canopy width as a fraction of height. */
  spread: number;
  /** Height of the crown base as a fraction of total height. */
  crownBase: number;
  /** Conifers get stacked cones instead of a broadleaf mass. */
  conifer: boolean;
  summer: number;
  autumn: number;
  bark: number;
  /** How strongly the crown sways; open-crowned species move more. */
  sway: number;
}

export const SPECIES: Species[] = [
  { name: 'red maple',      height: 14, spread: 0.68, crownBase: 0.30, conifer: false, summer: 0x4a7a34, autumn: 0xc0431f, bark: 0x4e463d, sway: 1.0 },
  { name: 'red oak',        height: 18, spread: 0.78, crownBase: 0.34, conifer: false, summer: 0x41692c, autumn: 0x9c5426, bark: 0x574d42, sway: 0.8 },
  { name: 'american linden',height: 16, spread: 0.58, crownBase: 0.28, conifer: false, summer: 0x53823a, autumn: 0xc6a63a, bark: 0x5b5247, sway: 0.9 },
  { name: 'honey locust',   height: 15, spread: 0.72, crownBase: 0.42, conifer: false, summer: 0x6a8f45, autumn: 0xd9b544, bark: 0x4a4239, sway: 1.35 },
  { name: 'white pine',     height: 20, spread: 0.46, crownBase: 0.18, conifer: true,  summer: 0x2d4a33, autumn: 0x2d4a33, bark: 0x453b32, sway: 0.55 },
  { name: 'cherry',         height: 9,  spread: 0.80, crownBase: 0.26, conifer: false, summer: 0x4f7538, autumn: 0xc9563a, bark: 0x6a4f42, sway: 1.15 },
];

/**
 * Fraction of autumn colour for a given day of year at Boston's latitude.
 * Peak foliage in eastern Massachusetts is around the third week of October
 * (day ~292); leaves are fully down by mid-November and green by late May.
 */
export function autumnFactor(dayOfYear: number): number {
  const d = dayOfYear;
  if (d < 250 || d > 330) return 0; // high summer / bare-and-reset
  const t = (d - 250) / 42; // 250 -> 292
  return THREE.MathUtils.clamp(d <= 292 ? t : 1 - (d - 292) / 38, 0, 1);
}
