/**
 * Snell Library, Northeastern University — the campus's signature building,
 * closing the south end of Centennial Common across from Richards Hall.
 *
 * Real-world dimensions used
 * --------------------------
 *  footprint   an irregular, near-square blob in OSM (w29566437), ~85-88 m
 *              across; reduced here to a plain brick block with a rotunda
 *              reading room capping the quad-facing end, which is the
 *              identity the brief calls for rather than a literal trace
 *  storeys     5 (OSM `levels`), height 16 m, flat roof
 *  material    brick, with the drum in glass and dark metal
 *
 * The drum is deliberately the loudest thing on the quad: a 27 m glazed
 * rotunda on a dark metal ring, capped with a shallow faceted lantern roof
 * that pokes just above the brick block's roofline — legible in silhouette
 * from across Huntington Avenue, which is the whole point of it.
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { Builder, prism, cyl, revolve, cornice } from '../../lib/geom';
import { curtainWall } from '../../lib/curtainwall';
import { simpleWindow } from './common';
import { materialsFor } from '../../lib/materials';
import { rect, regularPolygon } from '../../lib/util';

export const SNELL_W = 58; // local +X, the quad-facing (short) end carries the drum
export const SNELL_D = 42;
const W = SNELL_W;
const D = SNELL_D;
const FLOORS = 5;
const FLOOR_H = 3.0;
const BASE_H = 1.0;
const EAVES = BASE_H + FLOORS * FLOOR_H; // 16 m

export const SNELL_DRUM_R = 13.5;
const DRUM_R = SNELL_DRUM_R;
const DRUM_SEG = 28;
export const SNELL_DRUM_X = W / 2 + DRUM_R - 4; // 4 m embedded into the block for a seamless join
const DRUM_X = SNELL_DRUM_X;
const DRUM_BASE = 0.6;
const DRUM_TOP = 19.4;
const DRUM_CAP = 23.6;

let pane = 20000;

export function buildSnellLibrary(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const brick = M.surface('brick', { color: 0x7c3a2c, roughness: 0.91, tile: 2.0 });
  const stone = M.surface('granite', { color: 0xb3ab9c, roughness: 0.78, tile: 2.8 });
  const dark = M.surface('darkmetal', { color: 0x33383e, roughness: 0.5, metalness: 0.75, tile: 2.0 });
  const roofMat = M.surface('concrete', { color: 0x48453f, roughness: 0.9, tile: 3.0 });
  const glass = M.litGlass(1990, { color: 0x24404f, roughness: 0.14, metalness: 0.3 }, 0.55);

  /* ------------------------------------------------------------ brick mass */
  b.add(prism(rect(W + 0.4, D + 0.4), 0, BASE_H, { cap: false }), stone);
  b.add(prism(rect(W, D), BASE_H, EAVES, { cap: true, floor: true }), brick);
  b.add(prism(rect(W + 0.12, D + 0.12), BASE_H, BASE_H + 0.2, { cap: false }), stone);

  if (detail) {
    const longBays = 9;
    for (let i = 0; i < longBays; i++) {
      const z = -D / 2 + ((i + 0.5) / longBays) * D;
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.7;
        for (const s of [1, -1] as const) {
          const o = simpleWindow(1.3, 2.35, 0.4, pane++);
          b.addAt(o.reveal, brick, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
          b.addAt(o.glass, glass, [(s * W) / 2, y, z], s > 0 ? Math.PI / 2 : -Math.PI / 2);
        }
      }
    }
    const endBays = 13;
    for (let i = 0; i < endBays; i++) {
      const x = -W / 2 + ((i + 0.5) / endBays) * W;
      if (x > 22) continue; // the drum's own footprint starts at x=25; skip windows there
      for (let f = 0; f < FLOORS; f++) {
        const y = BASE_H + f * FLOOR_H + 0.7;
        for (const zs of [1, -1] as const) {
          const o = simpleWindow(1.3, 2.35, 0.4, pane++);
          b.addAt(o.reveal, brick, [x, y, (zs * D) / 2], zs > 0 ? 0 : Math.PI);
          b.addAt(o.glass, glass, [x, y, (zs * D) / 2], zs > 0 ? 0 : Math.PI);
        }
      }
    }
  }
  b.addAt(cornice(D + 1.0, 0.8, 0.6, 3), stone, [W / 2 + 0.02, EAVES, 0], Math.PI / 2);
  b.addAt(cornice(D + 1.0, 0.8, 0.6, 3), stone, [-(W / 2 + 0.02), EAVES, 0], -Math.PI / 2);
  b.addAt(cornice(W + 1.0, 0.8, 0.6, 3), stone, [0, EAVES, -(D / 2 + 0.02)], Math.PI);

  /* -------------------------------------------------------------- the drum */
  const drumFootprint = regularPolygon(DRUM_SEG, DRUM_R);
  b.addAt(cyl(DRUM_R + 0.5, DRUM_R + 0.5, DRUM_BASE, detail ? DRUM_SEG : 14), stone, [DRUM_X, 0, 0]);
  b.addAt(prism(drumFootprint, DRUM_BASE, DRUM_TOP, { cap: false }), dark, [DRUM_X, 0, 0]);

  if (detail) {
    const cw = curtainWall(drumFootprint, DRUM_BASE, DRUM_TOP, {
      floorHeight: 3.0,
      paneWidth: 2.6,
      proud: 0.08,
      gap: 0.1,
      visionFraction: 0.82,
      seed: 5501,
    });
    b.addAt(cw.glass, glass, [DRUM_X, 0, 0]);
    if (cw.spandrel) b.addAt(cw.spandrel, dark, [DRUM_X, 0, 0]);
  } else {
    b.addAt(prism(drumFootprint, DRUM_BASE, DRUM_TOP, { cap: false, topScale: 1 }), glass, [DRUM_X, 0.02, 0]);
  }

  // Faceted lantern roof: a shallow cone with a raised centre finial.
  b.addAt(cyl(DRUM_R + 0.35, DRUM_R + 0.35, 0.35, detail ? DRUM_SEG : 14), stone, [DRUM_X, DRUM_TOP, 0]);
  const cap = revolve(
    [
      [DRUM_R, 0],
      [DRUM_R * 0.99, 0.25],
      [DRUM_R * 0.55, 2.8],
      [DRUM_R * 0.2, 3.8],
      [0.6, 4.2],
    ],
    detail ? DRUM_SEG : 14,
  );
  b.addAt(cap, roofMat, [DRUM_X, DRUM_TOP + 0.35, 0]);
  b.addAt(cyl(0.35, 0.12, 1.6, 10), dark, [DRUM_X, DRUM_CAP, 0]);
  if (detail) {
    // Ribs running up the cap, echoing the drum's mullions below.
    const ribs = 14;
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * Math.PI * 2;
      const rib = revolve(
        [
          [DRUM_R, 0],
          [DRUM_R * 0.55, 2.8],
          [DRUM_R * 0.2, 3.8],
        ],
        3,
        0.05,
      );
      rib.rotateY(a);
      b.addAt(rib, dark, [DRUM_X, DRUM_TOP + 0.35, 0]);
    }
  }

  return b.build('neu-snell-library');
}
