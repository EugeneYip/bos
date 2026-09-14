/**
 * Longfellow Bridge, Charles River — Boston (Charles Circle) to Cambridge
 * (Kendall). Edmund M. Wheelwright, 1906. Known universally as the
 * "salt-and-pepper-shaker bridge" for its four central towers.
 *
 * Real-world dimensions used
 * --------------------------
 *  length        1768 ft = 538.9 m
 *  width         105 ft = 32.0 m (roadway + two Red Line tracks + walkways)
 *  spans         11 steel arch spans on granite piers
 *  main span     188 ft = 57.3 m, over the navigation channel
 *  towers        four granite towers at the two central piers, ~24 m above
 *                the deck, shaped like pepper pots
 *  deck          ~9 m above the Charles
 *
 * The Red Line runs down the middle in the open air, which is a big part of
 * how the bridge reads — trains crossing it are visible from both banks.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const LEN = ft(1768); // 538.9 m, model +X runs Boston -> Cambridge
const WIDTH = ft(105); // 32.0 m
const DECK_Y = 9.2;
const DECK_T = 1.5;
const SPANS = 11;
const MAIN_SPAN_INDEX = 5;

function buildLB(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const granite = M.surface('granite', { color: 0x97948c, roughness: 0.82, tile: 3.0 });
  const graniteDark = M.surface('granite', { color: 0x84817a, roughness: 0.85, tile: 3.4 });
  const steel = M.surface('darkmetal', { color: 0x4a5158, roughness: 0.58, metalness: 0.75 });
  const asphalt = M.surface('concrete', { color: 0x3c3e40, roughness: 0.95, tile: 6.0 });
  const ballast = M.surface('granite', { color: 0x6a6863, roughness: 0.95, tile: 1.2 });

  const spanLen = LEN / SPANS;

  /* -------------------------------------------------------- piers & arches */
  for (let i = 0; i <= SPANS; i++) {
    const x = -LEN / 2 + i * spanLen;
    const isCentral = i === MAIN_SPAN_INDEX || i === MAIN_SPAN_INDEX + 1;
    const pierW = isCentral ? 13.0 : 8.5;
    b.addAt(prism(rect(pierW, WIDTH + 2.0), -6.0, DECK_Y - DECK_T, { cap: false }),
      isCentral ? granite : graniteDark, [x, 0, 0]);
  }

  // Steel arch ribs between the piers, three ribs across the width.
  for (let s = 0; s < SPANS; s++) {
    const x0 = -LEN / 2 + s * spanLen;
    const rise = s === MAIN_SPAN_INDEX ? 7.0 : 5.2;
    const segs = detail ? 14 : 6;
    for (const z of [-WIDTH / 2 + 2.5, 0, WIDTH / 2 - 2.5]) {
      let prev = new THREE.Vector3(x0, DECK_Y - DECK_T - 0.4, z);
      for (let k = 1; k <= segs; k++) {
        const t = k / segs;
        const y = DECK_Y - DECK_T - 0.4 + Math.sin(t * Math.PI) * rise;
        const cur = new THREE.Vector3(x0 + t * spanLen, y, z);
        b.add(strut(prev, cur, 0.42, detail ? 6 : 4), steel);
        prev = cur;
      }
    }
  }

  /* ------------------------------------------------------------------ deck */
  b.add(prism(rect(LEN, WIDTH), DECK_Y - DECK_T, DECK_Y, { cap: false }), steel);
  // Two carriageways flanking the central rail reservation.
  const railW = 9.4;
  for (const sz of [-1, 1]) {
    const roadW = (WIDTH - railW) / 2 - 3.2;
    b.addAt(box(LEN, 0.12, roadW), asphalt, [0, DECK_Y, sz * (railW / 2 + roadW / 2)]);
  }
  b.addAt(box(LEN, 0.35, railW), ballast, [0, DECK_Y, 0]);
  if (detail) {
    // Red Line rails.
    for (const z of [-3.2, -1.76, 1.76, 3.2]) {
      b.addAt(box(LEN, 0.16, 0.09), steel, [0, DECK_Y + 0.35, z]);
    }
  }

  // Parapets and the outer walkways.
  for (const sz of [-1, 1]) {
    b.addAt(box(LEN, 1.15, 0.55), granite, [0, DECK_Y, sz * (WIDTH / 2 - 0.3)]);
    if (detail) {
      const n = Math.round(LEN / 2.6);
      for (let i = 0; i < n; i++) {
        b.addAt(cyl(0.07, 0.07, 1.0, 6), steel,
          [-LEN / 2 + (i + 0.5) * (LEN / n), DECK_Y + 1.15, sz * (WIDTH / 2 - 0.3)]);
      }
    }
  }

  /* ------------------------------------------- the salt-and-pepper towers */
  const towerH = 24.0;
  for (const i of [MAIN_SPAN_INDEX, MAIN_SPAN_INDEX + 1]) {
    const x = -LEN / 2 + i * spanLen;
    for (const sz of [-1, 1]) {
      const z = sz * (WIDTH / 2 - 3.4);
      // Squat cylindrical drum on a square plinth, then a conical cap: the
      // profile that earned the nickname.
      b.addAt(prism(rect(7.2, 7.2), DECK_Y, DECK_Y + 3.4, { cap: false }), granite, [x, 0, z]);
      b.addAt(cyl(3.1, 2.85, towerH * 0.52, detail ? 20 : 10), granite, [x, DECK_Y + 3.4, z]);
      b.addAt(cyl(3.35, 3.35, 0.8, detail ? 20 : 10), granite, [x, DECK_Y + 3.4 + towerH * 0.52, z]);
      // Conical roof + finial.
      b.addAt(revolve([[3.3, 0], [3.0, 1.2], [1.9, 3.4], [0.7, 5.0], [0, 5.6]], detail ? 20 : 10),
        graniteDark, [x, DECK_Y + 4.2 + towerH * 0.52, z]);
      if (detail) {
        // Narrow slit openings around the drum.
        const dark = M.emissive(0x12161a, 0, { night: true });
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          b.addAt(box(0.55, 2.1, 0.3), dark,
            [x + Math.sin(a) * 3.0, DECK_Y + 6.0, z + Math.cos(a) * 3.0], a);
        }
      }
    }
  }

  return b.build('longfellow-bridge');
}

export function buildLongfellow(ctx: Ctx): THREE.Object3D {
  return makeLOD('longfellow-bridge', [
    { object: buildLB(ctx, true), distance: 0 },
    { object: buildLB(ctx, false), distance: 1100 },
  ]);
}
