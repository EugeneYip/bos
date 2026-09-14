/**
 * One Dalton Street — Four Seasons Hotel & Private Residences.
 * Henry N. Cobb / Pei Cobb Freed, 2019. Boston's third tallest.
 *
 * Real-world dimensions used
 * --------------------------
 *  roof height   742 ft = 226.2 m  (some sources round the architectural
 *                height to 220 m; the parapet figure is used here so the
 *                Hancock 240.8 > Pru 228.3 > One Dalton 226.2 ordering,
 *                which is what you actually see, comes out right)
 *  floors        61, residential floor-to-floor ~3.4 m
 *  plan          equilateral triangle, ~55 m per side, corners rounded to
 *                an 8.5 m radius — the same architect's answer to a tight
 *                triangular site as the Hancock's rhomboid was to Copley
 *  skin          pale warm-silver glass with a projecting spandrel band at
 *                every floor, which is what gives it the fine horizontal
 *                striping and the soft, almost fabric-like corners
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl } from '../lib/geom';
import { curtainWall } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, roundedTriangle, scalePolygon, type P2 } from '../lib/util';

const ROOF = ft(742); // 226.2 m
const FLOOR = 3.42;
const PODIUM_H = 22.5; // the hotel base, ~6 storeys
const SIDE = 55;
const RADIUS = 8.5;
const CROWN = ROOF - 11;

/** Local +X points at the midpoint of one flat face; a vertex faces -X. */
const plan = (seg = 7, s = 1): P2[] => scalePolygon(roundedTriangle(SIDE, RADIUS, seg), s);

function buildTower(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const seg = detail ? 7 : 4;
  const p = plan(seg);

  // Pale champagne/silver vision glass — much lighter than the Hancock's blue.
  const glass = M.litGlass(
    2260,
    { color: 0x9fb2bd, roughness: 0.08, metalness: 0.58, envMapIntensity: 1.35 },
    0.55,
  );
  glass.userData.nightPeak = 1.15;
  const band = M.surface('metal', { color: 0xcfcabd, roughness: 0.34, metalness: 0.72 });
  const frame = M.surface('darkmetal', { color: 0x3a4048, roughness: 0.5, metalness: 0.6 });
  const stone = M.surface('granite', { color: 0xb0aaa0, roughness: 0.7, tile: 2.6 });

  /* --------------------------------------------------------------- podium */
  const podPlan = scalePolygon(p, 1.11);
  b.add(prism(podPlan, 0, PODIUM_H, { cap: true }), stone);
  {
    const pod = curtainWall(podPlan, 4.6, PODIUM_H - 1.3, {
      floorHeight: 4.4,
      paneWidth: 3.1,
      proud: -0.42,
      gap: 0.4,
      visionFraction: 0.7,
      seed: 2261,
    });
    b.add(pod.glass, M.litGlass(2261, { color: 0x8fa4b2, roughness: 0.1, metalness: 0.5 }, 0.85));
    if (pod.spandrel) b.add(pod.spandrel, band);
  }
  // Two-storey glazed hotel entrance on the flat face pointing local +X.
  b.addAt(box(20, 7.4, 3.2), M.litGlass(2262, { color: 0x1e2a33, roughness: 0.1, metalness: 0.4 }, 1), [
    SIDE * 0.29 + 1.4, 0.2, 0,
  ], Math.PI / 2);
  b.add(prism(scalePolygon(p, 1.13), PODIUM_H, PODIUM_H + 1.1, { cap: true }), band);

  /* ---------------------------------------------------------- main shaft */
  b.add(prism(p, PODIUM_H, CROWN, { cap: false, topScale: 0.985 }), frame);
  const skin = curtainWall(p, PODIUM_H + 1.1, CROWN, {
    floorHeight: FLOOR,
    paneWidth: detail ? 2.6 : 5.2,
    proud: -0.12,
    gap: 0.1,
    visionFraction: 0.76,
    seed: 2260,
    topScale: 0.985,
  });
  b.add(skin.glass, glass);
  if (skin.spandrel) b.add(skin.spandrel, frame);

  // Projecting spandrel band at every floor line. This is the single detail
  // that makes One Dalton read as One Dalton from across the Charles.
  if (detail) {
    const floors = Math.round((CROWN - PODIUM_H - 1.1) / FLOOR);
    for (let f = 1; f <= floors; f++) {
      const y = PODIUM_H + 1.1 + f * FLOOR;
      const t = (y - PODIUM_H) / (CROWN - PODIUM_H);
      const s = 1 + (0.985 - 1) * t;
      b.add(prism(scalePolygon(p, s * 1.014), y - 0.62, y, { cap: true, floor: true }), band);
    }
  } else {
    for (let y = PODIUM_H + 6; y < CROWN; y += FLOOR * 4) {
      b.add(prism(scalePolygon(p, 1.012), y - 0.9, y, { cap: true, floor: true }), band);
    }
  }

  /* ---------------------------------------------------------------- crown */
  // Mechanical screen: vertical fins over a recessed louvre drum.
  b.add(prism(scalePolygon(p, 0.97), CROWN, ROOF - 1.6, { cap: true }), frame);
  if (detail) {
    const fins = plan(seg, 0.985);
    for (let i = 0; i < fins.length; i += 1) {
      const a = fins[i];
      const c = fins[(i + 1) % fins.length];
      const mx = (a[0] + c[0]) / 2;
      const mz = (a[1] + c[1]) / 2;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const steps = Math.max(1, Math.round(len / 1.8));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const x = a[0] + (c[0] - a[0]) * t;
        const z = a[1] + (c[1] - a[1]) * t;
        const rot = Math.atan2(x - 0, z - 0);
        b.addAt(box(0.3, ROOF - 1.6 - CROWN, 1.0), band, [x, CROWN, z], rot);
      }
      void mx;
      void mz;
    }
  }
  b.add(prism(scalePolygon(p, 0.995), ROOF - 1.6, ROOF, { cap: true }), band);

  // Roof plant and the aircraft warning light.
  b.addAt(cyl(4.5, 4.5, 3.2, 12), frame, [0, ROOF, 0]);
  b.addAt(new THREE.SphereGeometry(0.55, 8, 6), M.emissive(0xff2a1a, 2.4), [0, ROOF + 4.2, 0]);

  return b.build('one-dalton');
}

function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const glass = M.litGlass(
    2263,
    { color: 0xa4b4bf, roughness: 0.12, metalness: 0.55, envMapIntensity: 1.3 },
    0.55,
  );
  glass.userData.nightPeak = 1.0;
  b.add(prism(plan(3, 1.11), 0, PODIUM_H, { cap: true }), M.surface('granite', { color: 0xb0aaa0 }));
  b.add(prism(plan(3), PODIUM_H, ROOF, { cap: true, topScale: 0.985 }), glass);
  return b.build('one-dalton-far');
}

export function buildOneDalton(ctx: Ctx): THREE.Object3D {
  return makeLOD('one-dalton', [
    { object: buildTower(ctx, true), distance: 0 },
    { object: buildTower(ctx, false), distance: 850 },
    { object: buildFar(ctx), distance: 3200 },
  ]);
}
