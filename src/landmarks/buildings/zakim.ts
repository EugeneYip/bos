/**
 * Leonard P. Zakim Bunker Hill Memorial Bridge.
 * Christian Menn / HNTB, 2003. Carries I-93 over the Charles.
 *
 * Real-world dimensions used
 * --------------------------
 *  total length      1,432 ft = 436 m
 *  main span         745 ft  = 227 m between the towers
 *  back spans        ~105 m each
 *  towers            270 ft  = 82 m above the road deck; the north tower is
 *                    the taller of the two (asymmetric back spans)
 *  deck              ~30 m above the water; 183 ft = 56 m wide overall,
 *                    8 lanes between the cable planes plus a 2-lane span
 *                    cantilevered off the east side (10 lanes total)
 *  cables            116 stays in two inclined planes converging on the
 *                    tower shaft
 *
 * The form to get right is the **inverted Y**: two splayed legs straddling the
 * roadway that meet just above deck level, then a single tapering obelisk shaft
 * — a deliberate quotation of the Bunker Hill Monument half a mile north.
 * Everything else (deck, stays, approach viaducts) hangs off that.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, strut, loft, cyl } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, chamferedRect, rect, lerp, type P2 } from '../lib/util';

const DECK_Y = 30.0; // top of deck above the water
const DECK_T = 3.1; // structural depth
const HALF_W = 15.25; // cable-stayed deck half-width (30.5 m between planes)
const CANT_W = 12.0; // cantilevered 2-lane span on the east (+Z) side
const SPAN = 227; // main span, tower to tower
const TX = SPAN / 2; // tower stations at x = +/- 113.5
const BACK = 105; // back span length
const END = TX + BACK; // 218.5 m — end of the cable-stayed structure
const APPROACH = 118; // girder viaduct beyond each end
const N_TOP = DECK_Y + 82; // 112 m — north tower
const S_TOP = DECK_Y + 74; // 104 m — south tower
const JUNCTION = DECK_Y + 13.5; // where the splayed legs meet
const LEG_SPREAD = 20.5; // pier centres either side of the deck

/** Tower shaft cross-section: a chamfered rectangle, w along X, d along Z. */
const sect = (w: number, d: number): P2[] => chamferedRect(w, d, Math.min(w, d) * 0.26);

function tower(b: Builder, mat: THREE.Material, x: number, top: number, detail: boolean): void {
  const rings: { pts: P2[]; y: number }[] = [];
  const steps = detail ? 10 : 4;

  /* ----- the single shaft above the junction: a tapering obelisk --------- */
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = lerp(JUNCTION, top, t);
    rings.push({ pts: sect(lerp(6.6, 3.4, t), lerp(5.0, 2.8, t)), y });
  }
  // Flat faceted cap.
  rings.push({ pts: sect(2.2, 1.8), y: top + 1.6 });
  const shaft = loft(rings, { cap: true });
  shaft.translate(x, 0, 0);
  b.add(shaft, mat);

  /* ----- the two splayed legs ------------------------------------------- */
  for (const s of [-1, 1]) {
    const legRings: { pts: P2[]; y: number }[] = [];
    const n = detail ? 8 : 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = lerp(1.0, JUNCTION, t);
      const z = lerp(s * LEG_SPREAD, 0, t);
      // Legs are fat at the pier and slim where they meet.
      const w = lerp(8.2, 6.4, t);
      const d = lerp(6.0, 4.6, t);
      legRings.push({ pts: sect(w, d).map(([px, pz]) => [px, pz + z] as P2), y });
    }
    const leg = loft(legRings, { cap: false, floor: true });
    leg.translate(x, 0, 0);
    b.add(leg, mat);
    // Pier / pile cap at the waterline.
    const pier = prism(rect(13.5, 11.5), -3.0, 1.2, { cap: true });
    pier.translate(x, 0, s * LEG_SPREAD);
    b.add(pier, mat);
  }
}

/** Cable stays for one tower. `dir` = +1 fans north, -1 fans south. */
function stays(
  b: Builder,
  mat: THREE.Material,
  x: number,
  top: number,
  mainDir: number,
  detail: boolean,
): void {
  const anchorLo = JUNCTION + (top - JUNCTION) * 0.44;
  const anchorHi = top - 3.0;
  const r = detail ? 0.17 : 0.34;
  const seg = detail ? 6 : 4;

  const run = (count: number, dir: number, from: number, to: number, spreadHi: boolean): void => {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      // Highest tower anchor pairs with the furthest deck anchor.
      const ty = lerp(anchorHi, anchorLo, spreadHi ? 1 - t : 1 - t);
      const dx = lerp(to, from, t);
      for (const s of [-1, 1]) {
        const a = new THREE.Vector3(x, ty, s * 0.9);
        const c = new THREE.Vector3(x + dir * dx, DECK_Y - 0.6, s * (HALF_W - 1.1));
        b.add(strut(a, c, r, seg), mat);
      }
    }
  };

  // Main span: a long fan reaching almost to mid-span.
  run(detail ? 13 : 8, mainDir, 24, SPAN / 2 - 12, true);
  // Back span: fewer, steeper, anchored over the approach pier.
  run(detail ? 10 : 6, -mainDir, 26, BACK - 14, true);
}

function buildBridge(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const concrete = M.surface('concrete', { color: 0xc3bfb4, roughness: 0.82, tile: 4.0 });
  const pierConc = M.surface('concrete', { color: 0xa9a49a, roughness: 0.86, tile: 4.0 });
  const steel = M.surface('darkmetal', { color: 0x555b61, roughness: 0.5, metalness: 0.75 });
  const cable = M.surface('metal', { color: 0xdedbd4, roughness: 0.38, metalness: 0.55 });
  const asphalt = M.surface('concrete', { color: 0x3a3c3f, roughness: 0.95, tile: 6.0 });
  const paint = M.surface('paint', { color: 0xf2f0e6, roughness: 0.7 });
  const barrier = M.surface('concrete', { color: 0xb4b0a6, roughness: 0.85, tile: 3.0 });

  /* ------------------------------------------------------------ the deck */
  // Edge girders + soffit, running the whole cable-stayed length.
  const deckSection = (halfW: number): P2[] => [
    [-halfW, -DECK_T],
    [halfW, -DECK_T],
    [halfW + 0.0, 0],
    [-halfW - 0.0, 0],
  ];
  void deckSection;

  const deckLen = END * 2;
  b.addAt(box(deckLen, DECK_T, HALF_W * 2), concrete, [0, DECK_Y - DECK_T, 0]);
  // Edge fascia beams, slightly proud, which is what reads as the deck edge.
  for (const s of [-1, 1]) {
    b.addAt(box(deckLen, 1.9, 1.3), concrete, [0, DECK_Y - 2.0, s * (HALF_W + 0.55)]);
  }
  // Wearing surface + lane markings.
  b.addAt(box(deckLen, 0.12, HALF_W * 2 - 1.6), asphalt, [0, DECK_Y - 0.06, 0]);
  if (detail) {
    for (let l = -3; l <= 3; l++) {
      if (l === 0) continue;
      const z = l * 3.6;
      for (let x = -END + 4; x < END; x += 12) {
        b.addAt(box(6.5, 0.03, 0.16), paint, [x, DECK_Y + 0.07, z]);
      }
    }
  }
  // Median and edge barriers.
  b.addAt(box(deckLen, 1.05, 1.0), barrier, [0, DECK_Y, 0]);
  for (const s of [-1, 1]) {
    b.addAt(box(deckLen, 1.05, 0.55), barrier, [0, DECK_Y, s * (HALF_W - 0.6)]);
  }

  /* --------------------------------------- cantilevered east side span */
  const cantX0 = -TX - 30;
  const cantLen = END - cantX0;
  const cz = HALF_W + CANT_W / 2 + 0.6;
  b.addAt(box(cantLen, 1.5, CANT_W), concrete, [cantX0 + cantLen / 2, DECK_Y - 1.5, cz]);
  b.addAt(box(cantLen, 0.12, CANT_W - 1.2), asphalt, [cantX0 + cantLen / 2, DECK_Y - 0.06, cz]);
  b.addAt(box(cantLen, 1.05, 0.55), barrier, [cantX0 + cantLen / 2, DECK_Y, cz + CANT_W / 2 - 0.3]);
  if (detail) {
    // Outrigger brackets under the cantilever, every 9 m.
    for (let x = cantX0 + 4; x < END; x += 9) {
      b.add(
        strut(
          new THREE.Vector3(x, DECK_Y - DECK_T - 0.2, HALF_W - 1),
          new THREE.Vector3(x, DECK_Y - 1.6, cz + CANT_W / 2 - 1),
          0.28,
          5,
        ),
        steel,
      );
    }
  }

  /* ---------------------------------------------------------- the towers */
  tower(b, concrete, TX, N_TOP, detail);
  tower(b, concrete, -TX, S_TOP, detail);
  stays(b, cable, TX, N_TOP, -1, detail); // north tower fans south into the main span
  stays(b, cable, -TX, S_TOP, 1, detail);

  /* ----------------------------------------------- approach viaducts */
  for (const s of [-1, 1]) {
    const x0 = s * END;
    b.addAt(box(APPROACH, 2.4, HALF_W * 2), concrete, [x0 + (s * APPROACH) / 2, DECK_Y - 2.4, 0]);
    b.addAt(box(APPROACH, 0.12, HALF_W * 2 - 1.6), asphalt, [x0 + (s * APPROACH) / 2, DECK_Y - 0.06, 0]);
    b.addAt(box(APPROACH, 1.05, 0.55), barrier, [x0 + (s * APPROACH) / 2, DECK_Y, HALF_W - 0.6]);
    b.addAt(box(APPROACH, 1.05, 0.55), barrier, [x0 + (s * APPROACH) / 2, DECK_Y, -(HALF_W - 0.6)]);
    for (let i = 1; i <= 3; i++) {
      const px = x0 + s * (i * APPROACH) / 3.2;
      for (const zs of [-1, 1]) {
        b.addAt(cyl(2.2, 1.9, DECK_Y - 2.4, detail ? 14 : 7), pierConc, [px, 0, zs * 9]);
      }
      b.addAt(box(22, 1.8, 3.4), pierConc, [px, DECK_Y - 4.2, 0]);
    }
    // End pier under the cable-stayed deck.
    for (const zs of [-1, 1]) {
      b.addAt(cyl(2.6, 2.3, DECK_Y - DECK_T, detail ? 14 : 7), pierConc, [x0, 0, zs * 10]);
    }
  }

  /* ------------------------------------------------------------ lighting */
  // The towers are washed blue at night — the single most photographed thing
  // about this bridge after its silhouette.
  const blue = M.emissive(0x2f7bd6, 1.0, { night: true });
  blue.userData.nightPeak = 2.2;
  for (const [x, top] of [[TX, N_TOP], [-TX, S_TOP]] as const) {
    for (const s of [-1, 1]) {
      b.addAt(box(0.35, top - JUNCTION - 2, 0.35), blue, [x + s * 3.0, JUNCTION + 1, 0]);
    }
  }
  const lampPost = M.surface('metal', { color: 0x6b7076, roughness: 0.5 });
  const lampGlow = M.emissive(0xffd9a0, 1.2, { night: true });
  lampGlow.userData.nightPeak = 2.6;
  if (detail) {
    for (let x = -END + 10; x < END; x += 26) {
      for (const s of [-1, 1]) {
        b.addAt(cyl(0.16, 0.11, 9, 6), lampPost, [x, DECK_Y + 0.6, s * (HALF_W - 0.6)]);
        b.addAt(box(1.5, 0.25, 0.5), lampGlow, [x, DECK_Y + 9.4, s * (HALF_W - 1.2)]);
      }
    }
  }
  const beacon = M.emissive(0xff2a1a, 2.4);
  b.addAt(new THREE.SphereGeometry(0.55, 8, 6), beacon, [TX, N_TOP + 2.4, 0]);
  b.addAt(new THREE.SphereGeometry(0.55, 8, 6), beacon, [-TX, S_TOP + 2.4, 0]);

  return b.build('zakim');
}

export function buildZakim(ctx: Ctx): THREE.Object3D {
  return makeLOD('zakim', [
    { object: buildBridge(ctx, true), distance: 0 },
    { object: buildBridge(ctx, false), distance: 1100 },
  ]);
}
