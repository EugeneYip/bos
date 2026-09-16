/**
 * Centennial Common — the brick-paved lawn tying Snell Library, Churchill
 * Hall and Richards Hall together. Modelled as ground dressing (a thin lawn
 * prism plus paver-strip walks) sitting on the terrain the same way Fenway's
 * infield or Faneuil's market square do: a few centimetres of relief so nothing
 * z-fights with the terrain mesh underneath.
 *
 * The lawn's outline is computed from the three buildings' actual rotated
 * footprints (see `common.ts`) so it fills the real gap between them rather
 * than a guessed rectangle.
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { Builder, prism } from '../../lib/geom';
import { materialsFor } from '../../lib/materials';
import type { P2 } from '../../lib/util';
import { ROT_A, ROT_B, SNELL_LOCAL, CHURCHILL_LOCAL, RICHARDS_LOCAL } from './common';
import { CHURCHILL_W, CHURCHILL_D } from './churchillHall';
import { RICHARDS_W, RICHARDS_D } from './richardsHall';
import { SNELL_W, SNELL_D, SNELL_DRUM_R, SNELL_DRUM_X } from './snellLibrary';

/** Rotate a local (x,z) offset by `rot` radians about +Y and add a centre. */
function place(cx: number, cz: number, x: number, z: number, rot: number): P2 {
  const s = Math.sin(rot);
  const c = Math.cos(rot);
  return [cx + (x * c + z * s), cz + (-x * s + z * c)];
}

/** Convex hull (monotone chain), CCW. Guarantees a simple polygon regardless
 *  of how its input points — corners pulled from three separately-rotated
 *  buildings — happen to be ordered. */
function convexHull(points: P2[]): P2[] {
  const pts = points.slice().sort((a, c) => (a[0] === c[0] ? a[1] - c[1] : a[0] - c[0]));
  const cross = (o: P2, a: P2, c: P2): number => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** A `width`-metre-wide paver strip from `a` to `b`. */
function strip(a: P2, b: P2, width: number): P2[] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * (width / 2);
  const nz = (dx / len) * (width / 2);
  return [
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
  ];
}

export function buildCentennialCommon(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const lawn = M.surface('paint', { color: 0x4f7c3f, roughness: 0.96, tile: 5 });
  const paver = M.surface('brick', { color: 0x8d7a63, roughness: 0.9, tile: 0.7 });
  const border = M.surface('granite', { color: 0x9a9488, roughness: 0.85, tile: 2.0 });

  /* --------------------------------------------------------------- corners */
  // Rather than guess which face of each rotated rectangle looks onto the
  // quad, take all four corners and keep whichever two sit closest to the
  // anchor (0, 0) — the quad's own centre. That is robust to which way each
  // building's long axis happens to run.
  const hubGuess: P2 = [0, 0];
  const corners4 = (cx: number, cz: number, halfW: number, halfD: number, rot: number): P2[] => [
    place(cx, cz, -halfW, -halfD, rot),
    place(cx, cz, halfW, -halfD, rot),
    place(cx, cz, halfW, halfD, rot),
    place(cx, cz, -halfW, halfD, rot),
  ];
  const nearestTwo = (pts: P2[]): [P2, P2] => {
    const d = (p: P2): number => Math.hypot(p[0] - hubGuess[0], p[1] - hubGuess[1]);
    const sorted = pts.slice().sort((a, c) => d(a) - d(c));
    return [sorted[0], sorted[1]];
  };

  const richardsCorners = corners4(RICHARDS_LOCAL[0], RICHARDS_LOCAL[1], RICHARDS_W / 2, RICHARDS_D / 2, ROT_B);
  const churchillCorners = corners4(CHURCHILL_LOCAL[0], CHURCHILL_LOCAL[1], CHURCHILL_W / 2, CHURCHILL_D / 2, ROT_A);
  const snellCorners = corners4(SNELL_LOCAL[0], SNELL_LOCAL[1], SNELL_W / 2, SNELL_D / 2, ROT_B);
  const [r1, r2] = nearestTwo(richardsCorners);
  const [c1, c2] = nearestTwo(churchillCorners);
  const drumFront = place(SNELL_LOCAL[0], SNELL_LOCAL[1], SNELL_DRUM_X + SNELL_DRUM_R * 0.55, 0, ROT_B);

  // Convex hull of every corner of all three buildings (not just the two
  // nearest the anchor), so the lawn's boundary actually wraps each
  // building's nearest-facing edge instead of cutting a straight chord
  // behind whichever one is least convex from the anchor's point of view.
  // `NE_OPEN` extends the hull toward the anchor and a little beyond, since
  // the common opens out that way toward Huntington Avenue rather than
  // being boxed in on all sides.
  const NE_OPEN: P2 = [46, -34];
  const hull = convexHull([...richardsCorners, ...churchillCorners, ...snellCorners, drumFront, [0, 0], NE_OPEN]);
  const hullCentre: P2 = hull.reduce<P2>((a, p) => [a[0] + p[0] / hull.length, a[1] + p[1] / hull.length], [0, 0]);
  const inset = 4;
  const lawnPts: P2[] = hull.map((p) => inward(p, hullCentre, inset));

  b.add(prism(lawnPts, -0.06, 0.05, { cap: true }), lawn);
  b.add(prism(offsetRing(lawnPts, 0.6), -0.07, 0.055, { cap: false }), border);

  /* ------------------------------------------------------------- the walks */
  const hub: P2 = [
    (r1[0] + r2[0] + c1[0] + c2[0]) / 4,
    (r1[1] + r2[1] + c1[1] + c2[1]) / 4,
  ];
  const richardsMid: P2 = [(r1[0] + r2[0]) / 2, (r1[1] + r2[1]) / 2];
  const churchillMid: P2 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  const snellMid: P2 = drumFront;

  for (const [a, bpt] of [
    [richardsMid, hub],
    [churchillMid, hub],
    [snellMid, hub],
  ] as const) {
    b.add(prism(strip(a, bpt, 3.4), -0.045, 0.06, { cap: true }), paver);
  }
  if (detail) {
    b.add(prism(strip(richardsMid, churchillMid, 2.6), -0.045, 0.06, { cap: true }), paver);
  }

  return b.build('neu-centennial-common');
}

/** Nudge a point toward a centre by `d` metres — a cheap per-vertex inset. */
function inward(p: P2, centre: P2 | [number, number], d: number): P2 {
  const dx = centre[0] - p[0];
  const dz = centre[1] - p[1];
  const len = Math.hypot(dx, dz) || 1;
  return [p[0] + (dx / len) * d, p[1] + (dz / len) * d];
}

/** Expand a closed polygon outward by `d` metres — a cheap mowing-strip border. */
function offsetRing(pts: P2[], d: number): P2[] {
  const c: P2 = [0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; }
  c[0] /= pts.length;
  c[1] /= pts.length;
  return pts.map((p) => inward(p, c, -d));
}
