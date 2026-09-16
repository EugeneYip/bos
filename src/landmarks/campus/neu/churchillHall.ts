/**
 * Churchill Hall, Northeastern University — a first-year residence hall on
 * the north side of Centennial Common.
 *
 * Real-world dimensions used
 * --------------------------
 *  footprint   48.1 x 19.4 m (OSM w29618540), long axis bearing 60.4 deg —
 *              the campus-grid family shared with its neighbours
 *  storeys     5 (OSM `levels`), gabled roof (OSM `roof=gabled`) — the one
 *              pitched roof among the quad buildings, which is what marks it
 *              as a dormitory rather than an academic hall
 *  material    brick (OSM `material=brick`)
 *
 * A plain collegiate slab: red brick, a granite water table, punched sash
 * windows in a regular grid, a bracketed cornice, and a shingled gable roof
 * with a couple of dormers and chimneys so the silhouette reads as a real
 * dorm rather than a shoebox.
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { Builder, prism, box, gableRoof, cornice } from '../../lib/geom';
import { simpleWindow } from './common';
import { materialsFor } from '../../lib/materials';
import { rect } from '../../lib/util';

export const CHURCHILL_W = 48.1; // long face, local +X
export const CHURCHILL_D = 19.4;
const W = CHURCHILL_W;
const D = CHURCHILL_D;
const FLOORS = 5;
const FLOOR_H = 2.95;
const BASE_H = 0.85;
const EAVES = BASE_H + FLOORS * FLOOR_H; // 15.6 m
const ROOF_RISE = 5.4;

let pane = 21000;

export function buildChurchillHall(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const brick = M.surface('brick', { color: 0x8a3d2e, roughness: 0.92, tile: 2.1 });
  const trim = M.surface('granite', { color: 0xb9b2a4, roughness: 0.8, tile: 2.6 });
  const dark = M.surface('granite', { color: 0x6d685f, roughness: 0.85, tile: 2.6 });
  const roofMat = M.surface('slate', { color: 0x3a3630, roughness: 0.78, tile: 2.0 });
  const glass = M.litGlass(1948, { color: 0x1c2530, roughness: 0.22, metalness: 0.15 }, 0.42);

  /* ---------------------------------------------------------------- shaft */
  b.add(prism(rect(W + 0.5, D + 0.5), 0, BASE_H, { cap: false }), dark);
  b.add(prism(rect(W, D), BASE_H, EAVES, { cap: !detail }), brick);
  // Water-table line and a belt course under the top floor.
  b.add(prism(rect(W + 0.12, D + 0.12), BASE_H, BASE_H + 0.18, { cap: false }), trim);
  b.add(prism(rect(W + 0.1, D + 0.1), EAVES - FLOOR_H - 0.18, EAVES - FLOOR_H, { cap: false }), trim);

  /* ---------------------------------------------------------- windows --- */
  if (detail) {
    const longBays = 11;
    for (let i = 0; i < longBays; i++) {
      const x = -W / 2 + ((i + 0.5) / longBays) * W;
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.85;
        for (const s of [1, -1] as const) {
          const o = simpleWindow(1.5, 1.85, 0.4, pane++);
          b.addAt(o.reveal, brick, [x, y, (s * D) / 2], s > 0 ? 0 : Math.PI);
          b.addAt(o.glass, glass, [x, y, (s * D) / 2], s > 0 ? 0 : Math.PI);
        }
      }
    }
    const endBays = 3;
    for (let i = 0; i < endBays; i++) {
      const z = -D / 2 + ((i + 0.5) / endBays) * D;
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.85;
        for (const s of [1, -1] as const) {
          const o = simpleWindow(1.4, 1.75, 0.4, pane++);
          b.addAt(o.reveal, brick, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
          b.addAt(o.glass, glass, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
        }
      }
    }
  }

  /* --------------------------------------------------------- entrance --- */
  // A stone doorcase on the south long face, facing the quad.
  {
    const o = simpleWindow(2.6, 3.0, 0.55, pane++, 1.4);
    b.addAt(o.reveal, trim, [0, BASE_H, D / 2], 0);
    b.addAt(o.glass, glass, [0, BASE_H, D / 2], 0);
    b.addAt(box(3.4, 0.3, 0.5), trim, [0, BASE_H + 3.2, D / 2 - 0.05]);
  }

  /* ------------------------------------------------------------- cornice */
  b.addAt(cornice(W + 0.9, 0.75, 0.55, 3), trim, [0, EAVES, D / 2 + 0.02]);
  b.addAt(cornice(W + 0.9, 0.75, 0.55, 3), trim, [0, EAVES, -(D / 2 + 0.02)], Math.PI);
  b.addAt(cornice(D + 0.9, 0.75, 0.55, 3), trim, [W / 2 + 0.02, EAVES, 0], Math.PI / 2);
  b.addAt(cornice(D + 0.9, 0.75, 0.55, 3), trim, [-(W / 2 + 0.02), EAVES, 0], -Math.PI / 2);

  /* ----------------------------------------------------------------- roof */
  b.addAt(gableRoof(W + 1.1, D + 1.6, ROOF_RISE), roofMat, [0, EAVES, 0]);
  if (detail) {
    // Twin brick chimney stacks straddling the ridge line (height is a
    // function of z, the distance from the ridge — constant along x).
    for (const sx of [-1, 1] as const) {
      const cx = sx * (W / 2 - 5.5);
      b.addAt(box(1.1, 2.4, 1.6), brick, [cx, EAVES + ROOF_RISE, 0]);
      b.addAt(box(1.3, 0.2, 1.8), trim, [cx, EAVES + ROOF_RISE + 2.4, 0]);
    }
    // Shed dormers, three a side, breaking up the long roof slopes.
    const dormers = 3;
    for (const s of [1, -1] as const) {
      for (let i = 0; i < dormers; i++) {
        const x = -W / 2 + ((i + 0.5) / dormers) * W;
        const dz = (s * D) / 2 * 0.6;
        const roofY = EAVES + ROOF_RISE * (1 - Math.abs(dz) / (D / 2));
        b.addAt(box(2.6, 1.7, 1.9), brick, [x, roofY, dz]);
        b.addAt(box(2.8, 0.9, 2.1), roofMat, [x, roofY + 1.7, dz]);
        const o = simpleWindow(1.1, 1.1, 0.3, pane++);
        b.addAt(o.reveal, trim, [x, roofY + 0.25, dz + (s * 1.9) / 2 + 0.02 * s], s > 0 ? 0 : Math.PI);
        b.addAt(o.glass, glass, [x, roofY + 0.25, dz + (s * 1.9) / 2 + 0.02 * s], s > 0 ? 0 : Math.PI);
      }
    }
  }

  return b.build('neu-churchill-hall');
}
