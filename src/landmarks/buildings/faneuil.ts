/**
 * Faneuil Hall and Quincy Market — the Faneuil Hall Marketplace complex.
 *
 * Faneuil Hall: John Smibert 1742, doubled in width and raised a storey by
 * Charles Bulfinch in 1806. Quincy Market: Alexander Parris, 1826.
 *
 * Real-world dimensions used
 * --------------------------
 *  Faneuil Hall   100 x 80 ft = 30.5 x 24.4 m, three storeys of brick,
 *                 cupola with the gilded grasshopper weathervane at ~30 m
 *  grasshopper    Shem Drowne, 1742, 38 in = 0.97 m long, gilded copper
 *  Quincy Market  535 x 50 ft = 163.1 x 15.2 m of Quincy granite, a Greek
 *                 Revival colonnade at each end and a copper dome over the
 *                 central rotunda
 *  flanking       North and South Market Streets' long brick warehouse rows
 *
 * The complex reads as one very long granite bar with a dome in the middle,
 * with the little brick hall sitting square at its west end.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, gableRoof, column, cornice, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

/* Model +X runs west -> east, along the length of Quincy Market. */
const FH_W = ft(100); // 30.48 m
const FH_D = ft(80); // 24.38 m
const FH_WALL = 14.6;
const FH_RIDGE = 5.2;

const QM_L = ft(535); // 163.07 m
const QM_W = ft(50); // 15.24 m
const QM_WALL = 11.6;
const QM_X = FH_W / 2 + 34.0 + QM_L / 2; // east of the hall, across the plaza
const DOME_R = 8.4;

function buildFH(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0x8b5340, roughness: 0.92, tile: 2.2 });
  const brickDark = M.surface('brick', { color: 0x7a4635, roughness: 0.93, tile: 2.0 });
  const white = M.surface('paint', { color: 0xefece4, roughness: 0.55, tile: 2.4 });
  const granite = M.surface('granite', { color: 0x9d9a92, roughness: 0.82, tile: 3.0 });
  const graniteLight = M.surface('granite', { color: 0xaeaba2, roughness: 0.78, tile: 2.6 });
  const copper = M.surface('copper', { color: 0x5c9d87, roughness: 0.6, tile: 2.0 });
  const slate = M.surface('slate', { color: 0x4f545b, roughness: 0.72, tile: 1.6 });
  const gold = M.gold({ roughness: 0.3 });
  const glass = M.litGlass(1742, { color: 0x222d36, roughness: 0.22, metalness: 0.12 }, 0.5);

  /* ------------------------------------------------------- Faneuil Hall */
  b.addAt(prism(rect(FH_W, FH_D), 0, FH_WALL, { cap: false }), brick, [0, 0, 0]);
  b.addAt(gableRoof(FH_W, FH_D, FH_RIDGE), slate, [0, FH_WALL, 0]);
  b.addAt(cornice(FH_W, 1.0, 0.9, 2), white, [0, FH_WALL - 0.9, FH_D / 2]);

  if (detail) {
    // Arcaded ground floor (the market), sash above.
    for (let i = 0; i < 7; i++) {
      const x = -FH_W / 2 + ((i + 0.5) / 7) * FH_W;
      for (const z of [-FH_D / 2 - 0.06, FH_D / 2 + 0.06]) {
        b.addAt(box(2.3, 3.6, 0.16), glass, [x, 0.6, z]);
        const arch = revolve([[0, 0], [1.15, 0], [1.15, 0.2], [0, 0.2]], 12, Math.PI);
        arch.rotateX(-Math.PI / 2);
        arch.translate(x, 4.2, z - (z > 0 ? 0.08 : -0.08));
        b.add(arch, white);
        for (const y of [6.2, 10.4]) b.addAt(box(1.4, 2.3, 0.12), glass, [x, y, z]);
      }
    }
    // Dormers.
    for (let i = 0; i < 4; i++) {
      const x = -FH_W / 2 + ((i + 0.5) / 4) * FH_W;
      for (const sz of [-1, 1]) b.addAt(box(1.7, 1.7, 1.7), white, [x, FH_WALL + 1.1, sz * FH_D * 0.22]);
    }
  }

  /* --------------------------------------- cupola & the gilded grasshopper */
  const cupY = FH_WALL + FH_RIDGE;
  b.addAt(box(7.0, 1.2, 7.0), white, [0, cupY - 0.4, 0]);
  b.add(prism(rect(6.0, 6.0), cupY + 0.8, cupY + 5.4, { cap: false }), white);
  if (detail) {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      b.addAt(box(2.6, 3.2, 0.2), glass, [Math.sin(a) * 3.05, cupY + 1.6, Math.cos(a) * 3.05], a);
    }
  }
  b.addAt(box(7.2, 0.7, 7.2), white, [0, cupY + 5.4, 0]);
  // Octagonal lantern and ogee cap.
  b.addAt(cyl(2.4, 2.2, 3.4, 8), white, [0, cupY + 6.1, 0], Math.PI / 8);
  b.addAt(revolve([[2.5, 0], [2.3, 0.9], [1.3, 2.2], [0.4, 3.1], [0, 3.4]], 12), copper, [0, cupY + 9.5, 0]);
  const vaneY = cupY + 12.9;
  b.add(strut(new THREE.Vector3(0, vaneY, 0), new THREE.Vector3(0, vaneY + 2.4, 0), 0.05, 6), gold);
  if (detail) {
    // The grasshopper: 0.97 m long, gilded, riding the vane.
    const gh = new THREE.Shape();
    gh.moveTo(-0.48, -0.1); gh.lineTo(-0.2, 0.14); gh.lineTo(0.2, 0.1);
    gh.lineTo(0.48, -0.04); gh.lineTo(0.22, -0.2); gh.lineTo(-0.2, -0.22);
    const g = new THREE.ExtrudeGeometry(gh, { depth: 0.05, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    g.translate(0, vaneY + 2.5, 0);
    b.add(g, gold);
    for (const s of [-1, 1]) {
      b.add(strut(new THREE.Vector3(0, vaneY + 2.42, s * 0.12),
        new THREE.Vector3(0, vaneY + 2.78, s * 0.34), 0.025, 4), gold);
    }
  }

  /* ------------------------------------------------------- Quincy Market */
  b.addAt(prism(rect(QM_L, QM_W), 0, QM_WALL, { cap: false }), granite, [QM_X, 0, 0]);
  b.addAt(gableRoof(QM_L, QM_W, 3.0), slate, [QM_X, QM_WALL, 0]);
  b.addAt(cornice(QM_L, 0.9, 0.8, 2), graniteLight, [QM_X, QM_WALL - 0.8, QM_W / 2]);

  if (detail) {
    // The long granite pier rhythm down both flanks.
    const bays = 22;
    for (let i = 0; i < bays; i++) {
      const x = QM_X - QM_L / 2 + ((i + 0.5) / bays) * QM_L;
      for (const z of [-QM_W / 2 - 0.06, QM_W / 2 + 0.06]) {
        b.addAt(box(1.5, QM_WALL - 1.2, 0.5), graniteLight, [x, 0, z]);
        b.addAt(box(QM_L / bays - 1.8, 3.6, 0.16), glass, [x + QM_L / bays / 2, 1.2, z]);
        b.addAt(box(QM_L / bays - 2.4, 2.4, 0.14), glass, [x + QM_L / bays / 2, 6.4, z]);
      }
    }
  }

  // Greek Revival porticos at both ends: four Doric columns and a pediment.
  for (const sx of [-1, 1]) {
    const px = QM_X + sx * (QM_L / 2 + 3.2);
    for (let i = 0; i < 4; i++) {
      const z = -QM_W / 2 + 2.0 + (i / 3) * (QM_W - 4.0);
      b.addAt(column(10.2, 1.5, 'doric', detail ? 14 : 7), graniteLight, [px, 0.9, z]);
    }
    b.addAt(box(6.0, 1.6, QM_W + 1.5), graniteLight, [px, 11.1, 0]);
    // Pediment.
    const ped = gableRoof(QM_W + 1.5, 5.0, 2.6);
    ped.rotateY(Math.PI / 2);
    ped.translate(px, 12.7, 0);
    b.add(ped, graniteLight);
    b.addAt(box(7.0, 0.9, QM_W + 2.5), granite, [px, 0, 0]);
  }

  // Central rotunda and copper dome.
  b.addAt(prism(rect(DOME_R * 2 + 4.0, QM_W + 6.0), 0, QM_WALL + 2.4, { cap: false }), granite, [QM_X, 0, 0]);
  b.addAt(cyl(DOME_R, DOME_R, 3.2, detail ? 28 : 12), granite, [QM_X, QM_WALL + 2.4, 0]);
  const domeProfile: [number, number][] = [];
  const steps = detail ? 14 : 7;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2) * 0.94;
    domeProfile.push([Math.cos(a) * DOME_R, Math.sin(a) * DOME_R * 0.82]);
  }
  b.addAt(revolve(domeProfile, detail ? 28 : 12), copper, [QM_X, QM_WALL + 5.6, 0]);
  b.addAt(cyl(1.5, 1.3, 2.2, detail ? 12 : 6), copper, [QM_X, QM_WALL + 5.6 + DOME_R * 0.82 - 0.3, 0]);
  b.addAt(revolve([[1.6, 0], [1.2, 0.7], [0, 1.5]], 12), copper, [QM_X, QM_WALL + 7.5 + DOME_R * 0.82, 0]);

  /* ------------------------------- North & South Market brick warehouse rows */
  for (const sz of [-1, 1]) {
    const z = sz * (QM_W / 2 + 17.0);
    b.addAt(prism(rect(QM_L - 14.0, 16.0), 0, 15.5, { cap: true }), sz > 0 ? brick : brickDark, [QM_X, 0, z]);
    if (detail) {
      const bays = 26;
      for (let i = 0; i < bays; i++) {
        const x = QM_X - (QM_L - 14) / 2 + ((i + 0.5) / bays) * (QM_L - 14);
        for (const y of [1.0, 5.0, 8.6, 12.0]) {
          b.addAt(box(1.5, 2.4, 0.14), glass, [x, y, z - sz * 8.05]);
        }
      }
      b.addAt(cornice(QM_L - 14.0, 0.8, 0.7, 2), graniteLight, [QM_X, 14.8, z - sz * 8.0]);
    }
  }

  return b.build('faneuil-hall');
}

export function buildFaneuil(ctx: Ctx): THREE.Object3D {
  return makeLOD('faneuil-hall', [
    { object: buildFH(ctx, true), distance: 0 },
    { object: buildFH(ctx, false), distance: 800 },
  ]);
}
