/**
 * MIT Great Dome (Building 10) over Killian Court, Cambridge.
 * William Welles Bosworth, 1916.
 *
 * Across the Charles from Back Bay and squarely in frame from the Boston bank,
 * so it belongs in a Boston model even though it is in Cambridge.
 *
 * Real-world dimensions used
 * --------------------------
 *  dome         ~108 ft = 33 m external diameter, modelled on the Pantheon,
 *               limestone over a concrete shell, with an oculus
 *  drum         ringed by a colonnade of Ionic columns
 *  crown        ~150 ft = 45.7 m above Killian Court
 *  Building 10  the flanking neoclassical wings, five storeys of limestone
 *  portico      ten Ionic columns facing the court
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, column, cornice } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const WING_W = 116.0; // the Building 10 frontage, model +X
const WING_D = 26.0;
const WING_H = 21.5;
const CORE = 40.0; // the square block carrying the dome
const DRUM_R = ft(108) / 2; // 16.46 m
const DRUM_Y = WING_H + 2.2;
const DRUM_H = 7.0;
const CROWN = ft(150); // 45.72 m

function buildMIT(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const limestone = M.surface('stone', { color: 0xc9c2b2, roughness: 0.78, tile: 3.0 });
  const limeLight = M.surface('stone', { color: 0xd5cfc0, roughness: 0.74, tile: 2.6 });
  const lead = M.surface('darkmetal', { color: 0x7d8288, roughness: 0.62, metalness: 0.55 });
  const glass = M.litGlass(1916, { color: 0x27333d, roughness: 0.2, metalness: 0.15 }, 0.5);

  /* --------------------------------------------------------------- wings */
  for (const sx of [-1, 1]) {
    const w = (WING_W - CORE) / 2;
    b.addAt(prism(rect(w, WING_D), 0, WING_H, { cap: true }), limestone,
      [sx * (CORE / 2 + w / 2), 0, 0]);
    b.addAt(cornice(w, 1.5, 1.4), limeLight, [sx * (CORE / 2 + w / 2), WING_H - 1.4, WING_D / 2]);
    if (detail) {
      const cols = 9;
      for (let i = 0; i < cols; i++) {
        const x = sx * (CORE / 2) + sx * ((i + 0.5) / cols) * w;
        for (const z of [-WING_D / 2 - 0.06, WING_D / 2 + 0.06]) {
          for (const y of [2.0, 6.0, 10.0, 14.0, 17.6]) {
            b.addAt(box(1.7, 2.5, 0.12), glass, [x, y, z]);
          }
        }
      }
    }
  }

  /* ------------------------------------------------- central block & portico */
  b.add(prism(rect(CORE, WING_D + 6.0), 0, WING_H + 2.2, { cap: true }), limestone);
  // Ten Ionic columns across the Killian Court face.
  const pz = (WING_D + 6.0) / 2 + 1.2;
  const colH = 15.5;
  for (let i = 0; i < 10; i++) {
    const x = -CORE / 2 + 2.6 + (i / 9) * (CORE - 5.2);
    b.addAt(column(colH, 1.65, 'ionic', detail ? 14 : 7), limeLight, [x, 2.4, pz]);
  }
  b.addAt(box(CORE + 1.0, 2.0, 4.0), limeLight, [0, 2.4 + colH, pz - 0.4]);
  b.addAt(box(CORE + 2.0, 1.2, 5.2), limestone, [0, 2.4, pz - 0.4]);

  /* ----------------------------------------------------------------- drum */
  b.addAt(cyl(DRUM_R + 1.2, DRUM_R + 1.2, 1.0, detail ? 48 : 18), limestone, [0, DRUM_Y - 1.0, 0]);
  b.addAt(cyl(DRUM_R, DRUM_R, DRUM_H, detail ? 48 : 18), limestone, [0, DRUM_Y, 0]);
  if (detail) {
    // The ring of engaged columns around the drum.
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      b.addAt(column(DRUM_H - 1.0, 1.0, 'ionic', 8), limeLight,
        [Math.sin(a) * (DRUM_R + 0.35), DRUM_Y, Math.cos(a) * (DRUM_R + 0.35)], a);
    }
  }
  b.addAt(cyl(DRUM_R + 1.6, DRUM_R + 1.4, 1.3, detail ? 48 : 18), limeLight, [0, DRUM_Y + DRUM_H, 0]);

  /* ----------------------------------------------------------------- dome */
  // Pantheon profile: a hemisphere slightly stilted on the drum, stepped at
  // the springing, with an oculus rather than a lantern.
  const domeY = DRUM_Y + DRUM_H + 1.3;
  const domeH = CROWN - domeY;
  const seg = detail ? 40 : 16;
  const profile: [number, number][] = [];
  const steps = detail ? 20 : 9;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Oculus: stop short of the pole.
    const a = t * (Math.PI / 2) * 0.93;
    profile.push([Math.cos(a) * DRUM_R, Math.sin(a) * domeH]);
  }
  b.addAt(revolve(profile, seg), lead, [0, domeY, 0]);
  // Stepped rings at the springing, as on the Pantheon.
  if (detail) {
    for (let i = 0; i < 3; i++) {
      b.addAt(cyl(DRUM_R + 0.9 - i * 0.55, DRUM_R + 0.9 - i * 0.55, 0.62, seg), limeLight,
        [0, domeY + i * 0.62, 0]);
    }
  }
  // Oculus rim.
  const ocR = Math.cos((Math.PI / 2) * 0.93) * DRUM_R;
  b.addAt(cyl(ocR + 0.5, ocR + 0.5, 0.7, detail ? 24 : 10), limeLight, [0, CROWN - 0.55, 0]);

  return b.build('mit-great-dome');
}

export function buildMitDome(ctx: Ctx): THREE.Object3D {
  return makeLOD('mit-great-dome', [
    { object: buildMIT(ctx, true), distance: 0 },
    { object: buildMIT(ctx, false), distance: 1400 },
  ]);
}
