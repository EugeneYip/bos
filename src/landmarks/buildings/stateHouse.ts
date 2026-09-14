/**
 * Massachusetts State House, Beacon Hill.
 * Charles Bulfinch, 1798; white marble wings 1917; Brigham extension 1895.
 *
 * Real-world dimensions used
 * --------------------------
 *  Bulfinch front   173 ft = 52.7 m wide, 61 ft = 18.6 m deep
 *  storeys          rusticated brick arcade, main storey, attic; cornice ~20.6 m
 *  dome             50 ft = 15.2 m diameter, springing ~31.5 m,
 *                   top of the gilded pine cone ~47 m above the terrace
 *  gilding          23.75-carat gold leaf (first gilded 1874)
 *  wings            two 1917 white marble wings, ~31 m each, cornice at 19 m
 *  orientation      the Bulfinch front faces SSE over Boston Common; the
 *                   facade runs ENE-WSW (bearing 75 deg), which is local +X
 *                   here, so the front elevation faces local +Z.
 *
 * The dome is the point of this model. It gets a metal-workflow gold with a
 * leaf-quilt roughness map so it gleams and reads gold in shadow, not just when
 * a highlight happens to land on it.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, revolve, column, cornice, cyl, gableRoof } from '../lib/geom';
import { windowOpening } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect, regularPolygon, type P2 } from '../lib/util';

const FRONT_W = ft(173); // 52.7 m
const FRONT_D = ft(61); // 18.6 m
const ARCADE = 6.6;
const MAIN = 15.5;
const ATTIC = 19.4;
const CORNICE = 20.6;
const BALUST = 22.0;
const DOME_BASE = CORNICE;
const DRUM_Y = 24.6;
const SPRING = 31.5;
const DOME_R = ft(50) / 2; // 7.62 m
const OCULUS = 40.6;
const LANTERN_TOP = 45.0;
const FINIAL_TOP = 47.0;

const PORTICO_W = 23.2;
const PORTICO_PROJ = 2.6;

let paneIdx = 5000;

/** Place a punched window on a wall facing +Z at z, centred at (x, y). */
function addWindow(
  b: Builder,
  wall: THREE.Material,
  glass: THREE.Material,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  rotY: number,
  arch = 0,
): void {
  const o = windowOpening(w, h, 0.42, paneIdx++, arch);
  b.addAt(o.reveal, wall, [x, y, z], rotY);
  b.addAt(o.glass, glass, [x, y, z], rotY);
}

function buildStateHouseMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const brick = M.surface('brick', { color: 0xa2513c, roughness: 0.92, tile: 2.2 });
  const yellowBrick = M.surface('brick', { color: 0xc2a56d, roughness: 0.9, tile: 2.2 });
  const marble = M.surface('marble', { color: 0xe6e2d7, roughness: 0.46, tile: 3.2 });
  const stoneTrim = M.surface('marble', { color: 0xf0ece2, roughness: 0.42, tile: 2.6 });
  const gold = M.gold();
  const glass = M.litGlass(1798, { color: 0x1d2b35, roughness: 0.18, metalness: 0.25 }, 0.4);
  glass.userData.nightPeak = 1.4;
  const slate = M.surface('slate', { color: 0x4a4f55, roughness: 0.7, tile: 2.0 });

  /* ------------------------------------------------------ terrace + steps */
  b.add(prism(rect(FRONT_W + 74, FRONT_D + 46), -2.6, 0, { cap: true }), M.surface('granite', { color: 0x8d8a84, roughness: 0.8 }));
  for (let s = 0; s < 7; s++) {
    b.addAt(box(PORTICO_W + 9, 0.36, 0.9), M.surface('granite', { color: 0x999590 }), [
      0, s * 0.36, FRONT_D / 2 + PORTICO_PROJ + 6.0 - s * 0.9,
    ]);
  }

  /* ------------------------------------------------------- main brick block */
  const main: P2[] = rect(FRONT_W, FRONT_D);
  b.add(prism(main, 0, CORNICE, { cap: true }), brick);
  // Rusticated granite base to the arcade storey.
  b.add(prism(rect(FRONT_W + 0.5, FRONT_D + 0.5), 0, ARCADE, { cap: false }), M.surface('granite', { color: 0xbab5aa, roughness: 0.72, tile: 2.0 }));
  // String course, main cornice and roof balustrade.
  b.addAt(cornice(FRONT_W + 1.6, 1.0, 0.75, 2), stoneTrim, [0, ARCADE - 0.4, 0]);
  b.addAt(cornice(FRONT_W + 2.4, 1.5, 1.2, 3), stoneTrim, [0, ATTIC, 0]);
  b.add(prism(rect(FRONT_W + 2.6, FRONT_D + 2.6), ATTIC, CORNICE, { cap: true }), stoneTrim);

  // Balustrade: a solid rail plus balusters, only at the front and sides.
  if (detail) {
    const balR = M.surface('marble', { color: 0xeae6db, roughness: 0.45 });
    for (const side of [1, -1]) {
      b.addAt(box(FRONT_W + 2.2, 0.3, 0.55), balR, [0, BALUST - 0.35, side * (FRONT_D / 2 + 0.9)]);
      b.addAt(box(FRONT_W + 2.2, 0.28, 0.6), balR, [0, CORNICE, side * (FRONT_D / 2 + 0.9)]);
      const n = Math.floor((FRONT_W + 2) / 0.85);
      for (let i = 0; i <= n; i++) {
        const x = -(FRONT_W + 2) / 2 + (i / n) * (FRONT_W + 2);
        b.addAt(
          revolve(
            [
              [0.16, 0],
              [0.12, 0.18],
              [0.2, 0.45],
              [0.11, 0.75],
              [0.15, 1.0],
            ],
            7,
          ),
          balR,
          [x, CORNICE + 0.28, side * (FRONT_D / 2 + 0.9)],
        );
      }
    }
  }

  /* ----------------------------------------------- ground-storey arcade */
  // Nine brick arches across the front, the Bulfinch signature at street level.
  const arches = 9;
  for (let i = 0; i < arches; i++) {
    const x = -FRONT_W / 2 + ((i + 0.5) / arches) * FRONT_W;
    addWindow(b, M.surface('granite', { color: 0xbab5aa, roughness: 0.72, tile: 2.0 }), glass,
      x, 0.9, FRONT_D / 2, 3.1, 2.9, 0, 1.55);
  }

  /* ----------------------------------------------- main + attic windows */
  const bays = 13;
  for (let i = 0; i < bays; i++) {
    const x = -FRONT_W / 2 + ((i + 0.5) / bays) * FRONT_W;
    if (Math.abs(x) < PORTICO_W / 2 - 0.4) continue; // portico bay handled below
    addWindow(b, brick, glass, x, ARCADE + 1.0, FRONT_D / 2, 1.85, 4.2, 0);
    addWindow(b, brick, glass, x, MAIN + 0.7, FRONT_D / 2, 1.7, 2.5, 0);
  }
  // Side elevations.
  for (const side of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const z = -FRONT_D / 2 + ((i + 0.5) / 4) * FRONT_D;
      addWindow(b, brick, glass, side * (FRONT_W / 2), ARCADE + 1.0, z, 1.85, 4.2, side * Math.PI / 2);
      addWindow(b, brick, glass, side * (FRONT_W / 2), MAIN + 0.7, z, 1.7, 2.5, side * Math.PI / 2);
    }
  }

  /* ------------------------------------------------------------- portico */
  const pz = FRONT_D / 2;
  b.add(prism(rect(PORTICO_W, PORTICO_PROJ * 2), 0, ARCADE, { cap: false }),
    M.surface('granite', { color: 0xbab5aa, roughness: 0.72, tile: 2.0 }));
  // Three arches under the portico.
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 5.6;
    addWindow(b, M.surface('granite', { color: 0xbab5aa, roughness: 0.72, tile: 2.0 }), glass,
      x, 0.9, pz + PORTICO_PROJ, 3.5, 3.0, 0, 1.75);
  }
  // Colonnade: six Corinthian columns, 37 ft shafts, spanning the main storey.
  const colH = 11.3;
  const colD = 1.22;
  for (let i = 0; i < 6; i++) {
    const x = -PORTICO_W / 2 + 2.4 + (i / 5) * (PORTICO_W - 4.8);
    b.addAt(column(colH, colD, 'corinthian', detail ? 14 : 8), stoneTrim, [x, ARCADE + 0.5, pz + PORTICO_PROJ - 1.2]);
    b.addAt(box(colD * 1.7, 0.5, colD * 1.7), stoneTrim, [x, ARCADE, pz + PORTICO_PROJ - 1.2]);
  }
  // Portico entablature + the low attic above it.
  b.addAt(cornice(PORTICO_W + 1.2, 2.6, 1.9, 3), stoneTrim, [0, ARCADE + 0.5 + colH, pz + PORTICO_PROJ - 1.6]);
  b.addAt(box(PORTICO_W + 0.6, ATTIC - (ARCADE + colH + 2.9), 2.2), stoneTrim, [
    0, ARCADE + 0.5 + colH + 2.4, pz + PORTICO_PROJ - 1.6,
  ]);
  b.addAt(cornice(PORTICO_W + 2.6, 2.6, 1.3, 3), stoneTrim, [0, ATTIC, pz + PORTICO_PROJ - 1.6]);
  // Wall behind the colonnade, with the tall main-storey windows.
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 4.35;
    addWindow(b, brick, glass, x, ARCADE + 0.9, pz, 1.9, 5.4, 0, 0.95);
  }

  /* --------------------------------------------------------- marble wings */
  const wingW = 31;
  const wingD = 20.5;
  const wingH = 19.0;
  for (const side of [1, -1]) {
    const cx = side * (FRONT_W / 2 + wingW / 2 - 0.5);
    b.addAt(prism(rect(wingW, wingD), 0, wingH, { cap: true }), marble, [cx, 0, -1.0]);
    b.addAt(cornice(wingW + 1.6, 1.8, 1.4, 3), stoneTrim, [cx, wingH - 1.4, -1.0]);
    b.addAt(prism(rect(wingW + 1.8, wingD + 1.8), wingH, wingH + 1.0, { cap: true }), stoneTrim, [cx, 0, -1.0]);
    // Engaged pilasters across the wing front.
    for (let i = 0; i < 7; i++) {
      const x = cx - wingW / 2 + 2.2 + (i / 6) * (wingW - 4.4);
      b.addAt(box(1.25, wingH - 6.2, 0.45), stoneTrim, [x, 5.0, -1.0 + wingD / 2]);
      b.addAt(box(1.7, 0.55, 0.7), stoneTrim, [x, wingH - 2.0, -1.0 + wingD / 2]);
    }
    for (let i = 0; i < 6; i++) {
      const x = cx - wingW / 2 + 3.2 + (i / 5) * (wingW - 6.4);
      addWindow(b, marble, glass, x, 5.6, -1.0 + wingD / 2, 1.7, 3.9, 0);
      addWindow(b, marble, glass, x, 11.0, -1.0 + wingD / 2, 1.6, 2.6, 0);
      addWindow(b, marble, glass, x, 1.0, -1.0 + wingD / 2, 1.7, 2.6, 0);
    }
    b.addAt(box(wingW + 1.8, 0.28, 0.6), stoneTrim, [cx, wingH + 1.0, -1.0 + wingD / 2 + 0.6]);
  }

  /* --------------------------------------- 1895 Brigham extension (rear) */
  b.addAt(prism(rect(64, 34), 0, 22.5, { cap: true }), yellowBrick, [0, 0, -FRONT_D / 2 - 17]);
  b.addAt(cornice(65.6, 1.6, 1.2, 3), stoneTrim, [0, 21.3, -FRONT_D / 2 - 17]);
  b.addAt(gableRoof(64, 34, 5.2, 12), slate, [0, 22.5, -FRONT_D / 2 - 17]);
  for (let i = 0; i < 12; i++) {
    const x = -30 + (i / 11) * 60;
    addWindow(b, yellowBrick, glass, x, 4.5, -FRONT_D / 2 - 17 + 17, 1.7, 3.6, 0);
    addWindow(b, yellowBrick, glass, x, 10.5, -FRONT_D / 2 - 17 + 17, 1.7, 3.6, 0);
    addWindow(b, yellowBrick, glass, x, 16.4, -FRONT_D / 2 - 17 + 17, 1.6, 2.8, 0);
  }

  /* ------------------------------------------------------------ THE DOME */
  // Square podium the drum sits on, with its own balustrade.
  b.add(prism(rect(22.5, 20.5), DOME_BASE, DOME_BASE + 2.4, { cap: true }), stoneTrim);
  b.add(prism(rect(20.0, 18.4), DOME_BASE + 2.4, DRUM_Y, { cap: true }), stoneTrim);

  // Circular drum: 16 pilasters with a window between each pair.
  const drumR = 8.9;
  const drumTop = SPRING;
  b.add(revolve([[drumR, DRUM_Y], [drumR, drumTop - 1.1]], detail ? 40 : 20), stoneTrim);
  if (detail) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = Math.cos(a) * drumR;
      const z = Math.sin(a) * drumR;
      b.addAt(box(0.85, drumTop - 1.1 - DRUM_Y, 0.42), stoneTrim, [x, DRUM_Y, z], Math.atan2(x, z));
    }
    for (let i = 0; i < 16; i++) {
      const a = ((i + 0.5) / 16) * Math.PI * 2;
      const x = Math.cos(a) * drumR;
      const z = Math.sin(a) * drumR;
      addWindow(b, stoneTrim, glass, x, DRUM_Y + 1.4, z, 1.25, 3.1, Math.atan2(x, z), 0.6);
    }
  }
  // Cornice ring at the springing.
  b.add(revolve(
    [
      [drumR, drumTop - 1.1],
      [drumR + 0.75, drumTop - 0.8],
      [drumR + 0.75, drumTop - 0.35],
      [drumR + 0.35, drumTop - 0.1],
      [DOME_R + 0.5, drumTop],
    ],
    detail ? 40 : 20,
  ), stoneTrim);

  // The gilded shell: a slightly stilted dome (rise 9.1 m on a 7.62 m radius),
  // built as a profile of revolution so the silhouette is a true curve.
  const shell: P2[] = [];
  const RISE = OCULUS - SPRING;
  const N = detail ? 22 : 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Stilted profile: circular near the springing, easing to a point on top.
    const a = t * Math.PI * 0.5;
    const r = DOME_R * Math.cos(a * 0.94) * (1 - 0.06 * t * t);
    const y = SPRING + RISE * Math.sin(a * 0.995);
    shell.push([Math.max(r, 0.9), y]);
  }
  shell.push([0.85, OCULUS + 0.35]);
  b.add(revolve(shell, detail ? 48 : 24), gold);

  // Gilded ribs — 12 of them, barely proud, but they catch the low sun and
  // stop the dome reading as a plastic ball.
  if (detail) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ribProfile: P2[] = shell.map(([r, y]) => [r + 0.055, y]);
      const g = revolve(ribProfile, 3, 0.075);
      g.rotateY(a);
      b.add(g, gold);
    }
  }

  /* ----------------------------------------------------------- lantern */
  const lanR = 2.05;
  b.add(revolve([[lanR + 0.5, OCULUS], [lanR + 0.5, OCULUS + 0.5], [lanR, OCULUS + 0.7]], detail ? 20 : 10), stoneTrim);
  const lanH = 3.1;
  if (detail) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.addAt(column(lanH, 0.42, 'corinthian', 8), stoneTrim, [Math.cos(a) * lanR, OCULUS + 0.7, Math.sin(a) * lanR]);
    }
  }
  b.add(revolve([[lanR * 0.72, OCULUS + 0.7], [lanR * 0.72, OCULUS + 0.7 + lanH]], detail ? 16 : 8), stoneTrim);
  b.add(revolve(
    [
      [lanR + 0.45, OCULUS + 0.7 + lanH],
      [lanR + 0.45, OCULUS + 1.15 + lanH],
      [lanR + 0.1, OCULUS + 1.35 + lanH],
    ],
    detail ? 20 : 10,
  ), stoneTrim);
  // Gilded lantern cap.
  const capY = OCULUS + 1.35 + lanH;
  b.add(revolve(
    [
      [lanR * 0.95, capY],
      [lanR * 0.8, capY + 0.7],
      [lanR * 0.45, capY + 1.25],
      [0.14, LANTERN_TOP],
    ],
    detail ? 20 : 10,
  ), gold);

  // Gilded pine cone finial — the emblem of Maine's timber trade, 1790s.
  const cone: P2[] = [
    [0.14, LANTERN_TOP],
    [0.3, LANTERN_TOP + 0.15],
    [0.2, LANTERN_TOP + 0.32],
    [0.52, LANTERN_TOP + 0.55],
    [0.6, LANTERN_TOP + 0.95],
    [0.5, LANTERN_TOP + 1.35],
    [0.3, LANTERN_TOP + 1.7],
    [0.09, FINIAL_TOP],
  ];
  b.add(revolve(cone, detail ? 16 : 8), gold);
  // Flagpoles either side of the dome podium.
  if (detail) {
    const pole = M.surface('metal', { color: 0xc8c4bc, roughness: 0.4 });
    for (const s of [-1, 1]) b.addAt(cyl(0.14, 0.09, 11, 6), pole, [s * 13.5, CORNICE, 6]);
  }

  return b.build('state-house');
}

function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0xa2513c, roughness: 0.92, tile: 2.2 });
  const marble = M.surface('marble', { color: 0xe6e2d7, roughness: 0.46, tile: 3.2 });
  const gold = M.gold();
  b.add(prism(rect(FRONT_W, FRONT_D), 0, CORNICE, { cap: true }), brick);
  b.addAt(prism(rect(31, 20.5), 0, 19, { cap: true }), marble, [FRONT_W / 2 + 15, 0, -1]);
  b.addAt(prism(rect(31, 20.5), 0, 19, { cap: true }), marble, [-FRONT_W / 2 - 15, 0, -1]);
  b.addAt(prism(rect(64, 34), 0, 24, { cap: true }), M.surface('brick', { color: 0xc2a56d }), [0, 0, -FRONT_D / 2 - 17]);
  b.add(prism(rect(20, 18.4), CORNICE, DRUM_Y, { cap: true }), marble);
  b.add(revolve([[8.9, DRUM_Y], [8.9, SPRING], [DOME_R, SPRING]], 16), marble);
  const shell: P2[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI * 0.5;
    shell.push([Math.max(DOME_R * Math.cos(a * 0.94), 0.5), SPRING + (OCULUS - SPRING) * Math.sin(a)]);
  }
  shell.push([0.3, FINIAL_TOP]);
  b.add(revolve(shell, 20), gold);
  return b.build('state-house-far');
}

export function buildStateHouse(ctx: Ctx): THREE.Object3D {
  return makeLOD('state-house', [
    { object: buildStateHouseMesh(ctx, true), distance: 0 },
    { object: buildStateHouseMesh(ctx, false), distance: 520 },
    { object: buildFar(ctx), distance: 1800 },
  ]);
}
