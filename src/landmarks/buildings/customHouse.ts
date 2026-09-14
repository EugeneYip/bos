/**
 * Custom House Tower, McKinley Square.
 * Greek Revival base: Ammi B. Young, 1847. Tower: Peabody & Stearns, 1915.
 *
 * Real-world dimensions used
 * --------------------------
 *  base           Greek-cross plan, 140 x 95 ft = 42.7 x 29.0 m
 *  base columns   32 monolithic Quincy granite Doric columns,
 *                 32 ft = 9.75 m tall, 5 ft 4 in = 1.63 m diameter
 *  tower          496 ft = 151.2 m, 32 floors — Boston's first skyscraper,
 *                 built only because federal land was exempt from the city's
 *                 125 ft height limit
 *  clock faces    22 ft = 6.7 m diameter, one on each side
 *
 * Silhouette: a squat colonnaded temple with an impossibly thin tower growing
 * straight out of its middle, finished with an illuminated stepped pyramid.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, column, cornice, revolve, pyramid } from '../lib/geom';
import { windowOpening } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect, type P2 } from '../lib/util';

const BASE_W = ft(140); // 42.7 m
const BASE_D = ft(95); // 29.0 m
const PODIUM = 3.3;
const COL_H = ft(32); // 9.75 m
const COL_D = ft(5.33); // 1.63 m
const ENTAB = PODIUM + COL_H; // 13.05
const BASE_TOP = 21.0;
const TOWER_W = 22.6;
const SHAFT_TOP = 112.0;
const CLOCK_Y = 118.5; // centre of the dials
const CLOCK_R = ft(22) / 2; // 3.35 m
const STAGE_TOP = 128.0;
const CROWN_TOP = 151.2;

let pane = 9000;

function buildCH(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const granite = M.surface('granite', { color: 0x9b9790, roughness: 0.78, tile: 3.0 });
  const graniteLight = M.surface('granite', { color: 0xaba79f, roughness: 0.74, tile: 2.6 });
  const glass = M.litGlass(1915, { color: 0x1e2a33, roughness: 0.16, metalness: 0.3 }, 0.45);
  const gold = M.gold({ roughness: 0.3 });
  const dark = M.surface('darkmetal', { color: 0x2c3238, roughness: 0.5, metalness: 0.6 });
  const clockFace = M.emissive(0xf6ecd2, 0.35, { night: true });
  clockFace.userData.nightPeak = 2.2;
  const copperRoof = M.surface('copper', { color: 0x5c9d88, roughness: 0.62, tile: 2.0 });

  /* ------------------------------------------------- 1847 Greek Revival base */
  b.add(prism(rect(BASE_W + 5, BASE_D + 5), -1.4, PODIUM, { cap: true }), granite);
  b.add(prism(rect(BASE_W, BASE_D), PODIUM, BASE_TOP, { cap: true }), granite);

  // Porticos on all four faces. 8 columns on the long faces, 6 on the short.
  const portico = (n: number, len: number, z: number, rotY: number): void => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = -len / 2 + t * len;
      const px = rotY === 0 ? x : 0;
      const pz = rotY === 0 ? z : x;
      const zz = rotY === 0 ? z : z;
      void zz;
      const pos: [number, number, number] = rotY === 0 ? [px, PODIUM, z] : [z, PODIUM, pz];
      b.addAt(column(COL_H, COL_D, 'doric', detail ? 16 : 8), granite, pos);
    }
  };
  portico(8, BASE_W - 8, BASE_D / 2 + 2.6, 0);
  portico(8, BASE_W - 8, -(BASE_D / 2 + 2.6), 0);
  portico(6, BASE_D - 8, BASE_W / 2 + 2.6, Math.PI / 2);
  portico(6, BASE_D - 8, -(BASE_W / 2 + 2.6), Math.PI / 2);

  // Entablature carried on the columns, then the attic.
  b.addAt(cornice(BASE_W + 8, 8.0, 2.2, 3), granite, [0, ENTAB, BASE_D / 2 + 2.6]);
  b.addAt(cornice(BASE_W + 8, 8.0, 2.2, 3), granite, [0, ENTAB, -(BASE_D / 2 + 2.6)]);
  b.addAt(cornice(BASE_D + 8, 8.0, 2.2, 3), granite, [BASE_W / 2 + 2.6, ENTAB, 0], Math.PI / 2);
  b.addAt(cornice(BASE_D + 8, 8.0, 2.2, 3), granite, [-(BASE_W / 2 + 2.6), ENTAB, 0], Math.PI / 2);
  b.add(prism(rect(BASE_W + 3.2, BASE_D + 3.2), ENTAB + 2.2, BASE_TOP - 1.1, { cap: false }), graniteLight);
  b.add(prism(rect(BASE_W + 4.6, BASE_D + 4.6), BASE_TOP - 1.1, BASE_TOP, { cap: true }), graniteLight);

  // Windows behind the colonnade.
  for (let i = 0; i < 9; i++) {
    const x = -BASE_W / 2 + ((i + 0.5) / 9) * BASE_W;
    for (const s of [1, -1]) {
      const o = windowOpening(2.0, 5.2, 0.5, pane++, 1.0);
      b.addAt(o.reveal, granite, [x, PODIUM + 1.0, (s * BASE_D) / 2], s > 0 ? 0 : Math.PI);
      b.addAt(o.glass, glass, [x, PODIUM + 1.0, (s * BASE_D) / 2], s > 0 ? 0 : Math.PI);
    }
  }

  /* ---------------------------------------------------------- tower shaft */
  // Transitional block, then the shaft proper.
  b.add(prism(rect(TOWER_W + 8, TOWER_W + 8), BASE_TOP, BASE_TOP + 7.5, { cap: true }), graniteLight);
  b.add(prism(rect(TOWER_W + 5.4, TOWER_W + 5.4), BASE_TOP + 7.5, BASE_TOP + 10.5, { cap: true }), graniteLight);

  const shaftBottom = BASE_TOP + 10.5;
  b.add(prism(rect(TOWER_W, TOWER_W), shaftBottom, SHAFT_TOP, { cap: true }), graniteLight);

  // Corner pilasters + a recessed centre panel on each face: the vertical
  // emphasis that makes a 22 m shaft look like a tower rather than a chimney.
  const bays = 5;
  for (let f = 0; f < 4; f++) {
    const rotY = (f * Math.PI) / 2;
    const nx = Math.sin(rotY);
    const nz = Math.cos(rotY);
    const fx = nx * (TOWER_W / 2);
    const fz = nz * (TOWER_W / 2);
    for (const e of [-1, 1]) {
      const ox = -nz * e * (TOWER_W / 2 - 1.4);
      const oz = nx * e * (TOWER_W / 2 - 1.4);
      b.addAt(box(2.6, SHAFT_TOP - shaftBottom, 0.6), granite, [fx + ox, shaftBottom, fz + oz], rotY);
    }
    if (!detail) continue;
    const floors = Math.round((SHAFT_TOP - shaftBottom - 6) / 3.75);
    for (let i = 0; i < bays; i++) {
      const t = (i + 0.5) / bays;
      const off = (t - 0.5) * (TOWER_W - 6.5);
      const ox = -nz * off;
      const oz = nx * off;
      for (let fl = 0; fl < floors; fl++) {
        const y = shaftBottom + 3.0 + fl * 3.75;
        const o = windowOpening(1.55, 2.35, 0.45, pane++);
        b.addAt(o.reveal, graniteLight, [fx + ox, y, fz + oz], rotY);
        b.addAt(o.glass, glass, [fx + ox, y, fz + oz], rotY);
      }
    }
  }
  // Spandrel string courses every four floors.
  if (detail) {
    for (let y = shaftBottom + 18; y < SHAFT_TOP - 6; y += 15) {
      b.add(prism(rect(TOWER_W + 1.0, TOWER_W + 1.0), y, y + 0.7, { cap: true, floor: true }), granite);
    }
  }

  /* ----------------------------------------------------------- clock stage */
  b.add(prism(rect(TOWER_W + 3.2, TOWER_W + 3.2), SHAFT_TOP, SHAFT_TOP + 2.2, { cap: true }), granite);
  b.add(prism(rect(TOWER_W + 1.0, TOWER_W + 1.0), SHAFT_TOP + 2.2, STAGE_TOP, { cap: true }), graniteLight);

  for (let f = 0; f < 4; f++) {
    const rotY = (f * Math.PI) / 2;
    const nx = Math.sin(rotY);
    const nz = Math.cos(rotY);
    const fx = nx * (TOWER_W / 2 + 0.5);
    const fz = nz * (TOWER_W / 2 + 0.5);
    // Surround, dial, and hands.
    b.addAt(cyl(CLOCK_R + 0.85, CLOCK_R + 0.85, 0.55, detail ? 28 : 12), granite, [fx, CLOCK_Y, fz], 0, 1);
    const ring = b as Builder;
    void ring;
    const dial = cyl(CLOCK_R, CLOCK_R, 0.3, detail ? 28 : 12);
    dial.rotateX(Math.PI / 2);
    b.addAt(dial, clockFace, [fx + nx * 0.35, CLOCK_Y, fz + nz * 0.35], rotY);
    if (detail) {
      for (let h = 0; h < 12; h++) {
        const a = (h / 12) * Math.PI * 2;
        const rx = Math.sin(a) * (CLOCK_R - 0.45);
        const ry = Math.cos(a) * (CLOCK_R - 0.45);
        b.addAt(box(0.22, 0.55, 0.1), dark, [fx + nx * 0.55 - nz * rx, CLOCK_Y + ry, fz + nz * 0.55 + nx * rx], rotY);
      }
      // 10:10, because every clock in every render is set to 10:10.
      b.addAt(box(0.22, CLOCK_R * 1.3, 0.12), dark, [fx + nx * 0.62 - nz * -0.72, CLOCK_Y + 0.62, fz + nz * 0.62 + nx * -0.72], rotY);
      b.addAt(box(0.18, CLOCK_R * 1.6, 0.12), dark, [fx + nx * 0.62 - nz * 0.78, CLOCK_Y + 0.75, fz + nz * 0.62 + nx * 0.78], rotY);
    }
  }
  // Rotate the hour marks out of the dial plane is fiddly; the surround ring
  // needs the dial axis horizontal, done above by pre-rotating the cylinder.

  /* --------------------------------------------------------------- crown */
  b.add(prism(rect(TOWER_W + 3.6, TOWER_W + 3.6), STAGE_TOP, STAGE_TOP + 2.4, { cap: true }), granite);
  // Open colonnaded belvedere.
  const belH = 6.0;
  b.add(prism(rect(TOWER_W - 3.0, TOWER_W - 3.0), STAGE_TOP + 2.4, STAGE_TOP + 2.4 + belH, { cap: true }), graniteLight);
  if (detail) {
    for (let f = 0; f < 4; f++) {
      const rotY = (f * Math.PI) / 2;
      const nx = Math.sin(rotY);
      const nz = Math.cos(rotY);
      for (let i = 0; i < 5; i++) {
        const off = (i / 4 - 0.5) * (TOWER_W - 1.5);
        b.addAt(
          column(belH, 0.85, 'doric', 10),
          granite,
          [nx * (TOWER_W / 2 - 0.4) - nz * off, STAGE_TOP + 2.4, nz * (TOWER_W / 2 - 0.4) + nx * off],
        );
      }
    }
  }
  b.add(prism(rect(TOWER_W + 2.2, TOWER_W + 2.2), STAGE_TOP + 2.4 + belH, STAGE_TOP + 4.6 + belH, { cap: true }), granite);

  // Stepped pyramidal roof.
  const pyBase = STAGE_TOP + 4.6 + belH; // 139.0
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const w = (TOWER_W - 1.0) * (1 - t * 0.62);
    const y0 = pyBase + t * 6.0;
    b.add(prism(rect(w, w), y0, y0 + 6.0 / steps + 0.25, { cap: true }), copperRoof);
  }
  b.addAt(pyramid(TOWER_W * 0.38, TOWER_W * 0.38, 3.4), copperRoof, [0, pyBase + 6.0, 0]);

  // Lantern + gilded finial; the beacon is lit at night.
  b.addAt(cyl(1.5, 1.4, 2.6, detail ? 14 : 8), graniteLight, [0, pyBase + 9.2, 0]);
  b.addAt(cyl(1.15, 1.15, 1.9, detail ? 14 : 8), M.emissive(0xffe3ab, 0.5, { night: true }), [0, pyBase + 9.6, 0]);
  b.add(
    revolve(
      [
        [1.6, pyBase + 11.8],
        [1.2, pyBase + 12.5],
        [0.55, pyBase + 13.4],
        [0.22, CROWN_TOP - 1.1],
        [0.34, CROWN_TOP - 0.8],
        [0.09, CROWN_TOP],
      ],
      detail ? 16 : 8,
    ),
    gold,
  );

  return b.build('custom-house');
}

function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const granite = M.surface('granite', { color: 0x9b9790, roughness: 0.78, tile: 3.0 });
  const light = M.surface('granite', { color: 0xaba79f, roughness: 0.74, tile: 2.6 });
  b.add(prism(rect(BASE_W + 6, BASE_D + 6), 0, BASE_TOP, { cap: true }), granite);
  b.add(prism(rect(TOWER_W + 8, TOWER_W + 8), BASE_TOP, BASE_TOP + 10.5, { cap: true }), light);
  b.add(prism(rect(TOWER_W, TOWER_W), BASE_TOP + 10.5, SHAFT_TOP, { cap: true }), light);
  b.add(prism(rect(TOWER_W + 3.2, TOWER_W + 3.2), SHAFT_TOP, STAGE_TOP, { cap: true }), granite);
  b.add(prism(rect(TOWER_W - 3, TOWER_W - 3), STAGE_TOP, 139, { cap: true }), light);
  const copper = M.surface('copper', { color: 0x5c9d88, roughness: 0.62 });
  b.add(prism(rect(TOWER_W - 1, TOWER_W - 1), 139, 145, { cap: true, topScale: 0.4 }), copper);
  b.addAt(pyramid(6, 6, 6.2), copper, [0, 145, 0]);
  return b.build('custom-house-far');
}

export function buildCustomHouse(ctx: Ctx): THREE.Object3D {
  return makeLOD('custom-house', [
    { object: buildCH(ctx, true), distance: 0 },
    { object: buildCH(ctx, false), distance: 700 },
    { object: buildFar(ctx), distance: 2600 },
  ]);
}

const _p: P2[] = [];
void _p;
