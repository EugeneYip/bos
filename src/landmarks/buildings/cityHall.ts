/**
 * Boston City Hall, Government Center. Kallmann, McKinnell & Knowles, 1968.
 *
 * The most argued-about building in the city and an unmistakable silhouette:
 * an inverted ziggurat in board-formed concrete, where the upper floors
 * cantilever out over a recessed, deeply shadowed middle.
 *
 * Real-world dimensions used
 * --------------------------
 *  plan        ~156 x 156 ft core on a 512 x 512 ft brick plaza
 *  height      144 ft = 43.9 m, nine storeys
 *  base        two lower storeys of brick-clad concrete, set well back
 *  middle      the ceremonial floors: giant projecting concrete hoods over
 *              the Mayor's office and the Council chamber, all different sizes
 *  top         three floors of regular office bays, a dense repeating grid of
 *              precast mullions, cantilevered furthest out
 *
 * The whole design is the section: base recessive, middle sculptural and
 * irregular, top a heavy overhanging grid. Getting that three-part rhythm
 * right matters far more than any surface detail.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const PLAZA = ft(430); // the modelled part of City Hall Plaza
const BASE_W = ft(156); // 47.5 m
const BASE_D = ft(148); // 45.1 m
const H = ft(144); // 43.9 m

const BASE_TOP = 13.0; // two brick storeys
const MID_TOP = 28.0; // ceremonial floors
const TOP_OVERHANG = 4.6; // how far the office floors cantilever past the base

function buildCH(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  // Board-formed concrete: warm grey, matte, with strong horizontal grain.
  const concrete = M.surface('concrete', { color: 0x9d9890, roughness: 0.9, tile: 2.6, normalScale: 1.0 });
  const concreteDark = M.surface('concrete', { color: 0x827d76, roughness: 0.92, tile: 2.2, normalScale: 1.1 });
  const brick = M.surface('brick', { color: 0x8f6449, roughness: 0.93, tile: 2.0 });
  const glass = M.litGlass(1968, { color: 0x1d2830, roughness: 0.14, metalness: 0.35 }, 0.4);

  /* ---------------------------------------------------------------- plaza */
  b.add(prism(rect(PLAZA, PLAZA * 0.78), -1.2, 0.0, { cap: true }), brick);

  /* ------------------------------------------------ base: recessed, brick */
  const bw = BASE_W - 9.0;
  const bd = BASE_D - 9.0;
  b.add(prism(rect(bw, bd), 0, BASE_TOP, { cap: false }), brick);
  // The base is pierced by the great open undercroft on the plaza side.
  if (detail) {
    for (let i = 0; i < 7; i++) {
      const x = -bw / 2 + ((i + 0.5) / 7) * bw;
      b.addAt(box(3.2, 7.0, 0.4), glass, [x, 3.0, bd / 2 + 0.05]);
    }
  }

  /* ------------------------------- middle: the sculptural ceremonial floors */
  b.add(prism(rect(BASE_W, BASE_D), BASE_TOP, MID_TOP, { cap: false }), concrete);

  // The signature projecting hoods. Deliberately irregular in width and depth:
  // each expresses a different room behind it.
  const hoods: [number, number, number, number][] = [
    // [centre x fraction, width, projection, height]
    [-0.33, 12.0, 4.2, 11.0],
    [-0.06, 8.4, 6.0, 13.2],
    [0.22, 15.0, 3.2, 9.4],
    [0.46, 6.6, 5.2, 12.0],
  ];
  for (const [fx, w, proj, hh] of hoods) {
    const x = fx * BASE_W;
    const z = BASE_D / 2;
    b.addAt(box(w, hh, proj), concreteDark, [x, BASE_TOP + 1.0, z + proj / 2]);
    // Deep reveal so the hood reads as a hood, not a lump.
    b.addAt(box(w - 2.0, hh - 2.2, 0.3), glass, [x, BASE_TOP + 2.0, z + proj + 0.02]);
    if (detail) {
      b.addAt(box(w + 0.8, 0.7, proj + 0.5), concrete, [x, BASE_TOP + 1.0 + hh, z + proj / 2]);
    }
  }
  // A smaller set on the west flank.
  for (const [fz, w, proj, hh] of [[-0.22, 9.0, 3.6, 10.0], [0.18, 11.0, 2.8, 8.6]] as const) {
    const z = fz * BASE_D;
    const x = -BASE_W / 2;
    b.addAt(box(proj, hh, w), concreteDark, [x - proj / 2, BASE_TOP + 1.0, z]);
    b.addAt(box(0.3, hh - 2.2, w - 2.0), glass, [x - proj - 0.02, BASE_TOP + 2.0, z]);
  }

  /* ------------------------- top: three cantilevered floors of office bays */
  const tw = BASE_W + TOP_OVERHANG * 2;
  const td = BASE_D + TOP_OVERHANG * 2;
  // The underside of the cantilever is a strongly shadowed coffered soffit.
  b.add(prism(rect(tw, td), MID_TOP, MID_TOP + 1.6, { cap: false }), concreteDark);
  b.add(prism(rect(tw, td), MID_TOP + 1.6, H, { cap: true }), concrete);

  // The dense precast mullion grid that gives the top its texture. Modelled as
  // real fins, because their self-shadowing is the entire character of it.
  if (detail) {
    const floors = 3;
    const fh = (H - MID_TOP - 1.6) / floors;
    for (let f = 0; f < floors; f++) {
      const y = MID_TOP + 1.6 + f * fh;
      for (const [len, axis] of [[tw, 'x'], [td, 'z']] as const) {
        const n = Math.round(len / 2.44); // ~8 ft bay
        for (let i = 0; i < n; i++) {
          const t = -len / 2 + (i + 0.5) * (len / n);
          for (const s of [-1, 1]) {
            const pos: [number, number, number] =
              axis === 'x' ? [t, y, s * (td / 2 + 0.28)] : [s * (tw / 2 + 0.28), y, t];
            b.addAt(box(axis === 'x' ? 0.42 : 0.62, fh, axis === 'x' ? 0.62 : 0.42), concrete, pos);
          }
        }
        // Recessed glazing behind the fins.
        for (const s of [-1, 1]) {
          const pos: [number, number, number] =
            axis === 'x' ? [0, y + fh * 0.5, s * (td / 2 - 0.08)] : [s * (tw / 2 - 0.08), y + fh * 0.5, 0];
          b.addAt(box(axis === 'x' ? len - 1.2 : 0.1, fh * 0.72, axis === 'x' ? 0.1 : len - 1.2), glass, pos);
        }
      }
      // Spandrel band between floors.
      b.add(prism(rect(tw + 0.5, td + 0.5), y + fh - 0.55, y + fh, { cap: false }), concreteDark);
    }
  }

  // Parapet and the mechanical penthouse.
  b.add(prism(rect(tw, td), H, H + 1.1, { cap: false }), concreteDark);
  b.addAt(box(26.0, 4.2, 18.0), concrete, [4.0, H, -3.0]);

  return b.build('boston-city-hall');
}

export function buildCityHall(ctx: Ctx): THREE.Object3D {
  return makeLOD('boston-city-hall', [
    { object: buildCH(ctx, true), distance: 0 },
    { object: buildCH(ctx, false), distance: 800 },
  ]);
}
