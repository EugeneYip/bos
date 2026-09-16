/**
 * Matthews Arena, 238 Saint Botolph Street — the oldest indoor ice hockey
 * arena in the world (opened as Boston Arena, 1910; rebuilt after a 1918
 * fire, reopened 1921). A long brick shed under a shallow barrel-vault roof,
 * fronting Saint Botolph Street with a lower brick entrance block carrying
 * the arched doorway the real building has kept since 1901.
 *
 * Real-world dimensions used
 * --------------------------
 *  ice surface   200 x 90 ft = 61 x 27 m (the 1995 dimensions) inside a
 *                larger shed; overall building footprint estimated at
 *                ~82 x 40 m for the rink hall plus a ~24 m entrance block
 *  roof          shallow segmental barrel vault, not a full semicircle —
 *                real arena/train-shed roofs of this era rise gently
 *  capacity      4,666 (hockey), 5,066 (basketball) — the reason the hall
 *                reads as a big single volume rather than a stack of floors
 *
 * This is its own landmark (not part of the Centennial Common core): it
 * sits on Saint Botolph Street, ~950 m north-east of the quad, on a
 * different street grid — bearing 42 deg, read off that street's own
 * centreline in roads-01.json.
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { Builder, prism, box, cornice } from '../../lib/geom';
import { simpleWindow } from './common';
import { materialsFor } from '../../lib/materials';
import { makeLOD } from '../../lib/lod';
import { rect } from '../../lib/util';

const HALL_L = 82; // local +X, parallel to Saint Botolph Street
const HALL_W = 40;
const EAVES = 10.5;
const VAULT_RISE = 7.5;

const WING_L = 22;
const WING_W = 18;
const WING_H = 12.4;

let pane = 23000;

/** A shallow segmental barrel vault, chord `span`, rise `rise`, run `length`
 *  along local +X, eaves at local y = 0. Includes its own arched end caps. */
function vaultRoof(span: number, rise: number, length: number, segs: number): THREE.BufferGeometry {
  const chordHalf = span / 2;
  const phi = 2 * Math.atan(rise / chordHalf);
  const R = chordHalf / Math.sin(phi);
  const apex = (3 * Math.PI) / 2;
  const geo = new THREE.CylinderGeometry(R, R, length, segs, 1, false, apex - phi, 2 * phi);
  geo.rotateZ(-Math.PI / 2);
  geo.translate(0, -R * Math.cos(phi), 0);
  return geo;
}

function buildArena(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const brick = M.surface('brick', { color: 0x7a3628, roughness: 0.92, tile: 2.2 });
  const trim = M.surface('granite', { color: 0xb7b0a1, roughness: 0.8, tile: 2.6 });
  const roofMat = M.surface('darkmetal', { color: 0x454b52, roughness: 0.55, metalness: 0.4, tile: 3.0 });
  const glass = M.litGlass(1921, { color: 0x1c2530, roughness: 0.25, metalness: 0.1 }, 0.35);

  /* ------------------------------------------------------------- rink hall */
  b.add(prism(rect(HALL_L, HALL_W), 0, EAVES, { cap: false }), brick);
  b.add(prism(rect(HALL_L + 0.14, HALL_W + 0.14), 0, 0.9, { cap: false }), trim);
  b.addAt(vaultRoof(HALL_W - 0.4, VAULT_RISE, HALL_L + 1.6, detail ? 28 : 12), roofMat, [0, EAVES, 0]);
  b.addAt(cornice(HALL_L + 0.9, 0.8, 0.55, 3), trim, [0, EAVES, HALL_W / 2 + 0.02]);
  b.addAt(cornice(HALL_L + 0.9, 0.8, 0.55, 3), trim, [0, EAVES, -(HALL_W / 2 + 0.02)], Math.PI);

  if (detail) {
    // High clerestory windows just under the eaves, both long faces.
    const bays = 16;
    for (let i = 0; i < bays; i++) {
      const x = -HALL_L / 2 + ((i + 0.5) / bays) * HALL_L;
      for (const s of [1, -1] as const) {
        const o = simpleWindow(2.0, 1.7, 0.35, pane++, 0.5);
        b.addAt(o.reveal, brick, [x, EAVES - 3.0, (s * HALL_W) / 2], s > 0 ? 0 : Math.PI);
        b.addAt(o.glass, glass, [x, EAVES - 3.0, (s * HALL_W) / 2], s > 0 ? 0 : Math.PI);
      }
    }
    // A second, lower band of round-arched windows for the concourse.
    const bays2 = 10;
    for (let i = 0; i < bays2; i++) {
      const x = -HALL_L / 2 + ((i + 0.5) / bays2) * HALL_L;
      for (const s of [1, -1] as const) {
        const o = simpleWindow(1.9, 3.4, 0.4, pane++, 1.0);
        b.addAt(o.reveal, trim, [x, 1.4, (s * HALL_W) / 2], s > 0 ? 0 : Math.PI);
        b.addAt(o.glass, glass, [x, 1.4, (s * HALL_W) / 2], s > 0 ? 0 : Math.PI);
      }
    }
  }

  /* --------------------------------------------------------- gable ends -- */
  for (const s of [1, -1] as const) {
    const o = simpleWindow(6.5, 5.4, 0.45, pane++, 3.2);
    b.addAt(o.reveal, brick, [(s * HALL_L) / 2, 1.2, 0], s > 0 ? Math.PI / 2 : -Math.PI / 2);
    b.addAt(o.glass, glass, [(s * HALL_L) / 2, 1.2, 0], s > 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  /* --------------------------------------------------- entrance block --- */
  // A lower brick lobby off one end, carrying the preserved 1901 arch.
  const wingX = HALL_L / 2 + WING_L / 2 - 1.0;
  b.addAt(prism(rect(WING_L, WING_W), 0, WING_H, { cap: true }), brick, [wingX, 0, 0]);
  b.addAt(prism(rect(WING_L + 0.14, WING_W + 0.14), 0, 0.9, { cap: false }), trim, [wingX, 0, 0]);
  b.addAt(cornice(WING_W + 0.8, 0.7, 0.45, 3), trim, [wingX + WING_L / 2 + 0.02, WING_H, 0], Math.PI / 2);
  {
    const o = simpleWindow(4.2, 5.2, 0.6, pane++, 2.4);
    b.addAt(o.reveal, trim, [wingX + WING_L / 2, 0, 0], Math.PI / 2);
    b.addAt(o.glass, glass, [wingX + WING_L / 2, 0, 0], Math.PI / 2);
    // The archivolt banding around the historic arch.
    if (detail) b.addAt(box(0.5, 6.4, 5.6), trim, [wingX + WING_L / 2 + 0.05, 0, 0]);
  }
  if (detail) {
    const wbays = 4;
    for (let i = 0; i < wbays; i++) {
      const z = -WING_W / 2 + ((i + 0.5) / wbays) * WING_W;
      for (let f = 0; f < 2; f++) {
        const o = simpleWindow(1.6, 1.9, 0.35, pane++);
        b.addAt(o.reveal, brick, [wingX - WING_L / 2, 4.2 + f * 3.4, z], -Math.PI / 2);
        b.addAt(o.glass, glass, [wingX - WING_L / 2, 4.2 + f * 3.4, z], -Math.PI / 2);
      }
    }
  }

  return b.build('neu-matthews-arena');
}

export function buildMatthewsArena(ctx: Ctx): THREE.Object3D {
  return makeLOD('neu-matthews-arena', [
    { object: buildArena(ctx, true), distance: 0 },
    { object: buildArena(ctx, false), distance: 850 },
  ]);
}
