/**
 * Richards Hall, Northeastern University — a classroom/academic building
 * closing the north-west side of Centennial Common.
 *
 * Real-world dimensions used
 * --------------------------
 *  footprint   60.8 x 37.0 m (OSM w29942264), long axis bearing 330.4 deg —
 *              the cross axis of the campus-grid family (Churchill Hall runs
 *              the other way, 60.4 deg)
 *  storeys     5 (OSM `levels`), flat roof
 *  material    brick (OSM `material=brick`)
 *
 * The collegiate-brick idiom: a raised limestone basement, five floors of
 * plain sash windows in a disciplined grid, quoined corners, and a projecting
 * entrance pavilion with a pedimented doorcase facing the quad.
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { Builder, prism, box, cornice } from '../../lib/geom';
import { simpleWindow } from './common';
import { materialsFor } from '../../lib/materials';
import { rect } from '../../lib/util';

export const RICHARDS_W = 60.8; // long face, local +X
export const RICHARDS_D = 37.0;
const W = RICHARDS_W;
const D = RICHARDS_D;
const FLOORS = 5;
const FLOOR_H = 2.98;
const BASE_H = 1.6; // raised limestone basement
const EAVES = BASE_H + FLOORS * FLOOR_H; // 16.5 m

/** Which long face (+Z or -Z) gets the entrance pavilion; flip after a look. */
const ENTRANCE_SIDE = 1 as 1 | -1;

let pane = 22000;

export function buildRichardsHall(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const brick = M.surface('brick', { color: 0x8c4231, roughness: 0.9, tile: 2.2 });
  const stone = M.surface('granite', { color: 0xc4bca9, roughness: 0.76, tile: 2.8 });
  const stoneDark = M.surface('granite', { color: 0x9d9686, roughness: 0.8, tile: 2.6 });
  const roofMat = M.surface('concrete', { color: 0x4a4844, roughness: 0.9, tile: 3.0 });
  const glass = M.litGlass(1922, { color: 0x1c2530, roughness: 0.2, metalness: 0.15 }, 0.42);

  /* -------------------------------------------------------- basement/shaft */
  b.add(prism(rect(W + 0.4, D + 0.4), 0, BASE_H, { cap: false }), stoneDark);
  b.add(prism(rect(W, D), BASE_H, EAVES - 0.5, { cap: false }), brick);
  b.add(prism(rect(W + 0.16, D + 0.16), EAVES - 0.5, EAVES, { cap: true }), stone);
  b.add(prism(rect(W + 0.1, D + 0.1), BASE_H - 0.12, BASE_H + 0.12, { cap: false }), stone);

  // Quoined corners: alternating stone blocks up the full height.
  if (detail) {
    const quoin = 1.1;
    const rows = Math.round((EAVES - BASE_H) / 1.4);
    for (const cx of [-W / 2, W / 2] as const) {
      for (let r = 0; r < rows; r++) {
        if (r % 2 === 0) continue;
        const y = BASE_H + r * 1.4;
        b.addAt(box(quoin, 1.3, quoin), stone, [cx - (cx > 0 ? quoin / 2 : -quoin / 2), y, D / 2 - quoin / 2]);
        b.addAt(box(quoin, 1.3, quoin), stone, [cx - (cx > 0 ? quoin / 2 : -quoin / 2), y, -(D / 2 - quoin / 2)]);
      }
    }
  }

  /* ---------------------------------------------------------- windows --- */
  if (detail) {
    const longBays = 14;
    for (let i = 0; i < longBays; i++) {
      const t = (i + 0.5) / longBays;
      if (t > 0.44 && t < 0.56) continue; // leave room for the entrance bay
      const x = -W / 2 + t * W;
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.9;
        const arch = f === 0 ? 0.5 : 0;
        for (const s of [1, -1] as const) {
          const o = simpleWindow(1.7, f === 0 ? 2.3 : 1.9, 0.42, pane++, arch);
          b.addAt(o.reveal, f === 0 ? stone : brick, [x, y, (s * D) / 2], s > 0 ? 0 : Math.PI);
          b.addAt(o.glass, glass, [x, y, (s * D) / 2], s > 0 ? 0 : Math.PI);
        }
      }
    }
    const endBays = 5;
    for (let i = 0; i < endBays; i++) {
      const z = -D / 2 + ((i + 0.5) / endBays) * D;
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.9;
        for (const s of [1, -1] as const) {
          const o = simpleWindow(1.6, 1.85, 0.42, pane++);
          b.addAt(o.reveal, brick, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
          b.addAt(o.glass, glass, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
        }
      }
    }
  }

  /* --------------------------------------------------------- entrance --- */
  {
    const ez = (ENTRANCE_SIDE * D) / 2;
    const faceRotY = ENTRANCE_SIDE > 0 ? 0 : Math.PI;
    // Projecting pavilion, full height, capped with a pediment above the cornice.
    b.addAt(prism(rect(10.5, 1.6), BASE_H, EAVES + 1.4, { cap: true }), stone,
      [0, 0, ez + (ENTRANCE_SIDE * 1.6) / 2]);
    const o = simpleWindow(3.0, 3.6, 0.6, pane++, 1.6);
    b.addAt(o.reveal, stone, [0, BASE_H, ez + ENTRANCE_SIDE * 1.6], faceRotY);
    b.addAt(o.glass, glass, [0, BASE_H, ez + ENTRANCE_SIDE * 1.6], faceRotY);
    // Paired pilasters flanking the door, and a bracketed pediment over it.
    for (const s of [-1, 1] as const) {
      b.addAt(box(0.6, EAVES - BASE_H, 0.5), stoneDark, [s * 2.7, BASE_H, ez + ENTRANCE_SIDE * 1.6]);
    }
    b.addAt(box(7.2, 0.5, 2.1), stone, [0, EAVES + 0.3, ez + (ENTRANCE_SIDE * 1.6) / 2]);
  }

  /* ------------------------------------------------------------- cornice */
  b.addAt(cornice(W + 1.0, 0.85, 0.65, 3), stone, [0, EAVES, D / 2 + 0.02]);
  b.addAt(cornice(W + 1.0, 0.85, 0.65, 3), stone, [0, EAVES, -(D / 2 + 0.02)], Math.PI);
  b.addAt(cornice(D + 1.0, 0.85, 0.65, 3), stone, [W / 2 + 0.02, EAVES, 0], Math.PI / 2);
  b.addAt(cornice(D + 1.0, 0.85, 0.65, 3), stone, [-(W / 2 + 0.02), EAVES, 0], -Math.PI / 2);

  /* --------------------------------------------------------------- roof */
  b.add(prism(rect(W - 0.6, D - 0.6), EAVES, EAVES + 0.5, { cap: true, floor: true }), roofMat);
  // Roof-top mechanical penthouse, set well back from the parapet edge.
  if (detail) {
    b.addAt(box(9.0, 2.6, 6.0), M.surface('concrete', { color: 0x8b877d, roughness: 0.85, tile: 2.4 }),
      [W / 4, EAVES + 0.5, 0]);
  }

  return b.build('neu-richards-hall');
}
