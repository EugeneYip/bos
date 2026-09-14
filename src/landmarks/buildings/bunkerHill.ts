/**
 * Bunker Hill Monument, Charlestown. Solomon Willard, 1827-1843.
 *
 * Real-world dimensions used
 * --------------------------
 *  height      221 ft = 67.4 m to the tip
 *  base        30 ft = 9.14 m square at grade
 *  apex        15 ft = 4.57 m square below the pyramidion
 *  pyramidion  the top ~10 ft, a shallow four-sided cap
 *  fabric      Quincy granite ashlar, hauled on the first commercial
 *              railway in the United States
 *
 * A plain, severe obelisk — the whole design is the taper, so the profile has
 * to be right. Deliberately echoed by the Zakim Bridge's towers 1.5 km south.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect, type P2 } from '../lib/util';

const H = ft(221); // 67.36 m
const BASE = ft(30); // 9.14 m
const APEX = ft(15); // 4.57 m
const PYRAMIDION = ft(10.5);
const SHAFT_TOP = H - PYRAMIDION;

/** Stacked frusta, because a single prism can't taper. */
function obelisk(steps: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const y0 = t0 * SHAFT_TOP;
    const y1 = t1 * SHAFT_TOP;
    const w0 = BASE + (APEX - BASE) * t0;
    const w1 = BASE + (APEX - BASE) * t1;
    const g = prism(rect(w0, w0), y0, y1, { uOffset: i * 0.37 });
    // Taper the top ring of this segment to meet the next one.
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const s = w1 / w0;
    for (let v = 0; v < pos.count; v++) {
      if (Math.abs(pos.getY(v) - y1) < 1e-4) {
        pos.setX(v, pos.getX(v) * s);
        pos.setZ(v, pos.getZ(v) * s);
      }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    out.push(g);
  }
  return out;
}

function buildBH(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const granite = M.surface('granite', { color: 0x9a968d, roughness: 0.8, tile: 2.4 });
  const graniteDark = M.surface('granite', { color: 0x88857e, roughness: 0.84, tile: 3.0 });

  // Plinth and the two-step stylobate the obelisk stands on.
  b.add(prism(rect(BASE + 7.5, BASE + 7.5), -1.0, 0.9, { cap: true }), graniteDark);
  b.add(prism(rect(BASE + 4.0, BASE + 4.0), 0.9, 1.9, { cap: true }), granite);

  for (const g of obelisk(detail ? 22 : 5)) b.add(g, granite);

  // Pyramidion: a four-sided cap, not a cone.
  const capTop: P2[] = rect(APEX, APEX);
  const cap = prism(capTop, SHAFT_TOP, H, { cap: false });
  const pos = cap.getAttribute('position') as THREE.BufferAttribute;
  for (let v = 0; v < pos.count; v++) {
    if (Math.abs(pos.getY(v) - H) < 1e-4) {
      pos.setX(v, 0);
      pos.setZ(v, 0);
    }
  }
  pos.needsUpdate = true;
  cap.computeVertexNormals();
  b.add(cap, granite);

  if (detail) {
    // The four small observation windows just below the pyramidion.
    const dark = M.emissive(0x16181a, 0.0, { night: true });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const r = APEX / 2 + 0.06;
      b.addAt(box(0.9, 1.5, 0.12), dark, [Math.sin(a) * r, SHAFT_TOP - 3.4, Math.cos(a) * r], a);
    }
  }

  return b.build('bunker-hill-monument');
}

export function buildBunkerHill(ctx: Ctx): THREE.Object3D {
  return makeLOD('bunker-hill-monument', [
    { object: buildBH(ctx, true), distance: 0 },
    { object: buildBH(ctx, false), distance: 900 },
  ]);
}
