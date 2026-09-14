/**
 * Boston Public Library, McKim Building, Copley Square.
 * McKim, Mead & White, 1895. "Free to All" is carved over the entrance.
 *
 * Real-world dimensions used
 * --------------------------
 *  plan        225 x 227 ft = 68.6 x 69.2 m, a hollow square around a
 *              cloistered courtyard modelled on the Palazzo della Cancelleria
 *  height      ~70 ft = 21.3 m to the cornice
 *  fabric      pink Milford granite ashlar
 *  arcade      thirteen great round-arched windows along the Dartmouth Street
 *              front, over a rusticated base
 *  roof        low-pitched red tile, barely visible from the square
 *
 * Renaissance Revival, so the discipline is in the proportions: a heavy
 * rusticated base, a tall arcaded piano nobile, and a deep bracketed cornice.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, revolve, cornice } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const W = ft(225); // 68.58 m, Dartmouth St front faces +Z
const D = ft(227); // 69.19 m
const COURT_W = 30.0;
const COURT_D = 30.0;
const BASE_H = 6.4; // rusticated base
const ARCADE_H = 10.6; // piano nobile
const CORNICE_Y = BASE_H + ARCADE_H;
const H = 21.3;
const ARCHES = 13;

function buildMcKim(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  // Milford granite is distinctly pink-grey, not the blue-grey of Quincy.
  const granite = M.surface('granite', { color: 0xb8a79a, roughness: 0.8, tile: 3.0 });
  const graniteRust = M.surface('granite', { color: 0xa8978b, roughness: 0.86, tile: 1.8 });
  const graniteLight = M.surface('granite', { color: 0xc4b4a6, roughness: 0.76, tile: 2.6 });
  const tile = M.surface('slate', { color: 0x8c5b46, roughness: 0.8, tile: 1.4 });
  const glass = M.litGlass(1895, { color: 0x222c35, roughness: 0.2, metalness: 0.12 }, 0.55);
  const bronze = M.surface('copper', { color: 0x6b5f43, roughness: 0.55, metalness: 0.6 });

  /* ----------------------------------------------------- hollow square mass */
  // Four wings around the courtyard, so the court actually reads from above.
  const wingZ = (D - COURT_D) / 2;
  const wingX = (W - COURT_W) / 2;
  const mass = (w: number, d: number, x: number, z: number): void => {
    b.addAt(prism(rect(w, d), 0, BASE_H, { cap: false }), graniteRust, [x, 0, z]);
    b.addAt(prism(rect(w, d), BASE_H, CORNICE_Y, { cap: false }), granite, [x, 0, z]);
    b.addAt(prism(rect(w + 1.6, d + 1.6), CORNICE_Y, CORNICE_Y + 2.0, { cap: false }), graniteLight, [x, 0, z]);
    b.addAt(prism(rect(w, d), CORNICE_Y + 2.0, H, { cap: true }), granite, [x, 0, z]);
  };
  mass(W, wingZ, 0, (D - wingZ) / 2); // Dartmouth St front (+Z)
  mass(W, wingZ, 0, -(D - wingZ) / 2); // Boylston St rear
  mass(wingX, COURT_D, (W - wingX) / 2, 0);
  mass(wingX, COURT_D, -(W - wingX) / 2, 0);

  // Low tile roof over each wing, and the courtyard floor.
  b.addAt(box(W + 1.0, 0.5, wingZ), tile, [0, H, (D - wingZ) / 2]);
  b.addAt(box(W + 1.0, 0.5, wingZ), tile, [0, H, -(D - wingZ) / 2]);
  b.addAt(box(wingX, 0.5, COURT_D), tile, [(W - wingX) / 2, H, 0]);
  b.addAt(box(wingX, 0.5, COURT_D), tile, [-(W - wingX) / 2, H, 0]);
  b.addAt(box(COURT_W, 0.3, COURT_D), graniteLight, [0, 0.3, 0]);

  /* ----------------------------- the thirteen great arches, Dartmouth front */
  const zf = D / 2 + 0.06;
  const bay = W / ARCHES;
  for (let i = 0; i < ARCHES; i++) {
    const x = -W / 2 + (i + 0.5) * bay;
    // Arched window: a tall rectangle with a semicircular head.
    const wWin = bay * 0.62;
    const hWin = ARCADE_H * 0.62;
    b.addAt(box(wWin, hWin, 0.2), glass, [x, BASE_H + 1.6, zf]);
    const arch = revolve([[0, 0], [wWin / 2, 0], [wWin / 2, 0.22], [0, 0.22]], detail ? 16 : 8, Math.PI);
    arch.rotateX(-Math.PI / 2);
    arch.translate(x, BASE_H + 1.6 + hWin, zf - 0.1);
    b.add(arch, glass);
    if (detail) {
      // Keystone and the pilaster strips between bays.
      b.addAt(box(0.8, 1.1, 0.45), graniteLight, [x, BASE_H + 1.6 + hWin + wWin / 2 - 0.3, zf + 0.1]);
      b.addAt(box(0.9, ARCADE_H, 0.35), graniteLight, [x - bay / 2, BASE_H, zf]);
      // Small square attic window above the cornice.
      b.addAt(box(1.3, 1.3, 0.16), glass, [x, CORNICE_Y + 2.6, zf]);
    }
  }
  if (detail) {
    b.addAt(box(0.9, ARCADE_H, 0.35), graniteLight, [W / 2, BASE_H, zf]);
    // Rusticated base openings.
    for (let i = 0; i < ARCHES; i++) {
      const x = -W / 2 + (i + 0.5) * bay;
      b.addAt(box(bay * 0.4, 2.4, 0.16), glass, [x, 2.6, zf]);
    }
    // The three bronze entrance doors, centred.
    for (const dx of [-3.4, 0, 3.4]) {
      b.addAt(box(2.5, 4.6, 0.35), bronze, [dx, 0.4, zf + 0.1]);
    }
    b.addAt(box(13.0, 1.1, 1.1), graniteLight, [0, 5.2, zf + 0.3]);
  }

  // Deep bracketed cornice along the front.
  b.addAt(cornice(W, 2.0, 2.0, 3), graniteLight, [0, CORNICE_Y, D / 2]);

  return b.build('boston-public-library');
}

export function buildBPL(ctx: Ctx): THREE.Object3D {
  return makeLOD('boston-public-library', [
    { object: buildMcKim(ctx, true), distance: 0 },
    { object: buildMcKim(ctx, false), distance: 700 },
  ]);
}
