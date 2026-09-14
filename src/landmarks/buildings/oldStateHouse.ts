/**
 * Old State House, 206 Washington St at State St. 1713.
 *
 * The oldest surviving public building in Boston, and now almost comically
 * dwarfed by the Financial District towers around it — that contrast is the
 * point of modelling it.
 *
 * Real-world dimensions used
 * --------------------------
 *  body        110 x 38 ft = 33.5 x 11.6 m, three storeys of brick
 *  eaves       ~11 m; gambrel roof above
 *  tower       east end, square stage -> octagonal lantern -> gilt weathervane,
 *              ~30 m to the tip
 *  east gable  the gilded lion and unicorn (replicas; the 1776 originals were
 *              burned in the street)
 *  balcony     the Declaration of Independence was first read to Bostonians
 *              from it on 18 July 1776
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const W = ft(110); // 33.53 m, long axis east-west
const D = ft(38); // 11.58 m
const EAVE = 11.0;
const GAMBREL_LOW = 2.3;
const GAMBREL_HIGH = 3.6;
const TIP = 30.0;

/** Gambrel: two slopes per side, the lower steep, the upper shallow. */
function gambrel(w: number, d: number, lowRise: number, highRise: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const kneeZ = hd * 0.46;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = (x: number, y: number, z: number, u: number, v: number): number => {
    pos.push(x, y, z); uv.push(u, v); return pos.length / 3 - 1;
  };
  const ridge0 = p(-hw, lowRise + highRise, 0, 0, 2);
  const ridge1 = p(hw, lowRise + highRise, 0, w, 2);
  for (const sz of [-1, 1]) {
    const eave0 = p(-hw, 0, sz * hd, 0, 0);
    const eave1 = p(hw, 0, sz * hd, w, 0);
    const knee0 = p(-hw, lowRise, sz * kneeZ, 0, 1);
    const knee1 = p(hw, lowRise, sz * kneeZ, w, 1);
    if (sz < 0) {
      idx.push(eave0, eave1, knee1, eave0, knee1, knee0);
      idx.push(knee0, knee1, ridge1, knee0, ridge1, ridge0);
    } else {
      idx.push(eave1, eave0, knee0, eave1, knee0, knee1);
      idx.push(knee1, knee0, ridge0, knee1, ridge0, ridge1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildOSH(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0x8e5744, roughness: 0.92, tile: 2.0 });
  const white = M.surface('paint', { color: 0xefece3, roughness: 0.55, tile: 2.2 });
  const slate = M.surface('slate', { color: 0x4c5158, roughness: 0.72, tile: 1.6 });
  const gold = M.gold({ roughness: 0.3 });
  const glass = M.litGlass(1713, { color: 0x232e37, roughness: 0.22, metalness: 0.1 }, 0.55);

  b.add(prism(rect(W, D), 0, EAVE, { cap: false }), brick);
  b.addAt(gambrel(W + 0.7, D + 0.7, GAMBREL_LOW, GAMBREL_HIGH), slate, [0, EAVE, 0]);
  b.addAt(box(W + 1.0, 0.45, D + 1.0), white, [0, EAVE - 0.2, 0]);

  if (detail) {
    // Three storeys of 12-over-12 sash on both long faces.
    const cols = 9;
    for (let i = 0; i < cols; i++) {
      const x = -W / 2 + ((i + 0.5) / cols) * W;
      for (const z of [-D / 2 - 0.06, D / 2 + 0.06]) {
        for (const y of [1.5, 4.9, 8.0]) {
          b.addAt(box(1.15, 1.85, 0.1), glass, [x, y, z]);
          b.addAt(box(1.45, 0.16, 0.2), white, [x, y + 1.9, z]);
          b.addAt(box(1.45, 0.14, 0.26), white, [x, y - 0.12, z]);
        }
      }
    }
    // Dormers in the gambrel.
    for (let i = 0; i < 5; i++) {
      const x = -W / 2 + ((i + 0.5) / 5) * W;
      for (const sz of [-1, 1]) {
        b.addAt(box(1.5, 1.6, 1.5), white, [x, EAVE + GAMBREL_LOW - 0.4, sz * D * 0.24]);
      }
    }
    // The balcony over the State Street front.
    b.addAt(box(5.2, 0.25, 1.2), white, [W / 2 - 4.0, 5.2, D / 2 + 0.5]);
    for (let i = 0; i < 9; i++) {
      b.addAt(cyl(0.05, 0.05, 0.85, 6), white,
        [W / 2 - 6.4 + i * 0.6, 5.45, D / 2 + 1.0]);
    }
  }

  /* ------------------------------------------------- east tower & lantern */
  const tx = W / 2 - 3.4;
  const t1 = 5.0; // square stage side
  b.addAt(prism(rect(t1, t1), EAVE + GAMBREL_LOW + GAMBREL_HIGH - 1.2, 18.4, { cap: false }), white, [tx, 0, 0]);
  b.addAt(box(t1 + 0.9, 0.5, t1 + 0.9), white, [tx, 18.4, 0]);
  // Octagonal clock/lantern stage.
  b.addAt(cyl(2.15, 2.0, 4.2, 8), white, [tx, 18.9, 0], Math.PI / 8);
  b.addAt(cyl(2.5, 2.5, 0.5, 8), white, [tx, 23.1, 0], Math.PI / 8);
  // Ogee cap and the gilded vane.
  b.addAt(revolve([[2.2, 0], [2.1, 0.9], [1.4, 2.0], [0.5, 2.9], [0, 3.2]], 12), white, [tx, 23.6, 0]);
  b.addAt(revolve([[0, 0], [0.3, 0.3], [0, 0.6]], 10), gold, [tx, 26.8, 0]);
  b.add(strut(new THREE.Vector3(tx, 27.4, 0), new THREE.Vector3(tx, TIP, 0), 0.05, 6), gold);

  if (detail) {
    // Lion (north) and unicorn (south) on the east gable, gilded.
    for (const sz of [-1, 1]) {
      const bx = W / 2 - 0.9;
      b.addAt(box(0.9, 0.55, 0.9), white, [bx, EAVE + 0.3, sz * 2.6]);
      b.addAt(box(1.25, 0.62, 0.5), gold, [bx, EAVE + 0.85, sz * 2.6]);
      b.addAt(box(0.42, 0.72, 0.4), gold, [bx + 0.45, EAVE + 1.25, sz * 2.6]);
    }
    // Clock faces on the tower's east and west sides. `cyl` is Y-axis aligned,
    // so each dial has to be tipped onto its side to face outward.
    const face = M.emissive(0xf4ecd6, 0.3, { night: true });
    for (const sx of [-1, 1]) {
      const dial = cyl(1.05, 1.05, 0.12, 16);
      dial.translate(0, -0.06, 0);
      dial.rotateZ(Math.PI / 2);
      dial.translate(tx + sx * (t1 / 2 + 0.06), 20.6, 0);
      b.add(dial, face);
    }
  }

  return b.build('old-state-house');
}

export function buildOldStateHouse(ctx: Ctx): THREE.Object3D {
  return makeLOD('old-state-house', [
    { object: buildOSH(ctx, true), distance: 0 },
    { object: buildOSH(ctx, false), distance: 450 },
  ]);
}
