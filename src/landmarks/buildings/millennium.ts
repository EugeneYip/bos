/**
 * Millennium Tower, 1 Franklin Street, Downtown Crossing.
 * Handel Architects, 2016.
 *
 * Real-world dimensions used
 * --------------------------
 *  roof height  684 ft = 208.5 m  (4th tallest in Boston)
 *  floors       60, residential floor-to-floor ~3.35 m
 *  plan         ~46 x 42 m with cut corners
 *  skin         a faceted curtain wall — each structural bay is folded into
 *               two panels a few degrees off the wall plane, so the tower
 *               catches sun in vertical glints rather than as one flat sheet
 *  crown        a run of angled setbacks through the top ~10 floors, finishing
 *               in a sloped faceted cap. Slicing the top is the whole identity
 *               of this building next to the flat-topped older towers.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, capGeometry } from '../lib/geom';
import { curtainWall } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, chamferedRect, type P2 } from '../lib/util';

const ROOF = ft(684); // 208.5 m
const FLOOR = 3.35;
const PODIUM_H = 27; // the retail/Burnham-side base, ~7 storeys
const W = 46;
const D = 42;
const CH = 7.5;

/**
 * Fold each edge of the base outline into a sawtooth of `fold` metres so the
 * curtain wall is faceted. Segments are ~3.1 m, one structural bay.
 */
function faceted(base: P2[], fold: number, bay = 3.1): P2[] {
  const out: P2[] = [];
  const n = base.length;
  for (let i = 0; i < n; i++) {
    const a = base[i];
    const c = base[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const steps = Math.max(1, Math.round(len / bay));
    const ux = (c[0] - a[0]) / len;
    const uz = (c[1] - a[1]) / len;
    const nx = uz;
    const nz = -ux;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const tm = (s + 0.5) / steps;
      out.push([a[0] + ux * len * t0, a[1] + uz * len * t0]);
      out.push([a[0] + ux * len * tm + nx * fold, a[1] + uz * len * tm + nz * fold]);
    }
  }
  return out;
}

/** Progressive corner cut-backs produce the sliced crown. */
function crownPlan(cut: number, shrink: number): P2[] {
  const p = chamferedRect(W - shrink, D - shrink, CH + cut);
  // Bias the cut toward +X/-Z so the crown slices asymmetrically, as built.
  return p.map(([x, z]) => [x - cut * 0.28, z + cut * 0.16] as P2);
}

function buildTower(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const base = chamferedRect(W, D, CH);
  const shaft = detail ? faceted(base, 0.85) : base;

  const glass = M.litGlass(
    2085,
    { color: 0x5d7f96, roughness: 0.06, metalness: 0.7, envMapIntensity: 1.4 },
    0.58,
  );
  glass.userData.nightPeak = 1.25;
  const frame = M.surface('darkmetal', { color: 0x30383f, roughness: 0.48, metalness: 0.65 });
  const stone = M.surface('granite', { color: 0x8e8a83, roughness: 0.74, tile: 2.8 });

  /* --------------------------------------------------------------- podium */
  const podium = chamferedRect(W + 16, D + 13, CH + 2);
  b.add(prism(podium, 0, PODIUM_H, { cap: true }), stone);
  {
    const pod = curtainWall(podium, 5.0, PODIUM_H - 1.6, {
      floorHeight: 3.9,
      paneWidth: 3.0,
      proud: -0.4,
      gap: 0.38,
      visionFraction: 0.68,
      seed: 2086,
    });
    b.add(pod.glass, M.litGlass(2086, { color: 0x44606f, roughness: 0.11, metalness: 0.55 }, 0.8));
    if (pod.spandrel) b.add(pod.spandrel, frame);
  }
  b.add(prism(chamferedRect(W + 17.5, D + 14.5, CH + 2), PODIUM_H - 1.6, PODIUM_H, { cap: true }), stone);

  /* ---------------------------------------------------------- main shaft */
  const SET0 = ROOF - 34;
  b.add(prism(shaft, PODIUM_H, SET0, { cap: false }), frame);
  const skin = curtainWall(shaft, PODIUM_H, SET0, {
    floorHeight: FLOOR,
    paneWidth: detail ? 1.7 : 4.2,
    proud: 0.04,
    gap: 0.1,
    visionFraction: 0.8,
    seed: 2085,
  });
  b.add(skin.glass, glass);
  if (skin.spandrel) b.add(skin.spandrel, frame);

  /* -------------------------------------------------------- sliced crown */
  const steps: { y0: number; y1: number; cut: number; shrink: number }[] = [
    { y0: SET0, y1: SET0 + 11, cut: 4.5, shrink: 1.5 },
    { y0: SET0 + 11, y1: SET0 + 21, cut: 10, shrink: 4 },
    { y0: SET0 + 21, y1: ROOF - 3.4, cut: 16, shrink: 8 },
  ];
  for (const s of steps) {
    const p = crownPlan(s.cut, s.shrink);
    const pf = detail ? faceted(p, 0.7) : p;
    b.add(prism(pf, s.y0, s.y1, { cap: false }), frame);
    const cw = curtainWall(pf, s.y0, s.y1, {
      floorHeight: FLOOR,
      paneWidth: detail ? 1.7 : 4.2,
      proud: 0.04,
      gap: 0.1,
      visionFraction: 0.8,
      seed: 2085 + s.cut,
    });
    b.add(cw.glass, glass);
    if (cw.spandrel) b.add(cw.spandrel, frame);
    // The horizontal terrace left by each set-back.
    b.add(capGeometry(p, s.y1, true), frame);
  }
  // Sloped faceted cap: the plan shrinks and shifts as it rises.
  const capBase = crownPlan(16, 8);
  b.add(prism(capBase, ROOF - 3.4, ROOF, { cap: true, topScale: 0.86 }), frame);
  b.addAt(box(16, 3.0, 12), frame, [-3, ROOF, 2]);
  b.addAt(cyl(1.1, 0.6, 5.5, 8), M.surface('metal', { color: 0xa7adb2, roughness: 0.4, metalness: 0.9 }), [-3, ROOF + 3, 2]);
  b.addAt(new THREE.SphereGeometry(0.5, 8, 6), M.emissive(0xff2a1a, 2.4), [-3, ROOF + 8.6, 2]);

  return b.build('millennium');
}

function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const glass = M.litGlass(
    2087,
    { color: 0x62839a, roughness: 0.1, metalness: 0.68, envMapIntensity: 1.35 },
    0.58,
  );
  glass.userData.nightPeak = 1.1;
  b.add(prism(chamferedRect(W + 16, D + 13, CH + 2), 0, PODIUM_H, { cap: true }), M.surface('granite', { color: 0x8e8a83 }));
  b.add(prism(chamferedRect(W, D, CH), PODIUM_H, ROOF - 34, { cap: false }), glass);
  b.add(prism(crownPlan(4.5, 1.5), ROOF - 34, ROOF - 23, { cap: true }), glass);
  b.add(prism(crownPlan(10, 4), ROOF - 23, ROOF - 13, { cap: true }), glass);
  b.add(prism(crownPlan(16, 8), ROOF - 13, ROOF, { cap: true, topScale: 0.86 }), glass);
  return b.build('millennium-far');
}

export function buildMillennium(ctx: Ctx): THREE.Object3D {
  return makeLOD('millennium', [
    { object: buildTower(ctx, true), distance: 0 },
    { object: buildTower(ctx, false), distance: 820 },
    { object: buildFar(ctx), distance: 3000 },
  ]);
}
