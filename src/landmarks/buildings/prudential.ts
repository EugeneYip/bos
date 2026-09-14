/**
 * Prudential Tower ("the Pru"), 800 Boylston Street.
 * Charles Luckman & Associates, 1964.
 *
 * Real-world dimensions used
 * --------------------------
 *  roof height      749 ft = 228.3 m   (2nd tallest in Boston)
 *  tip of mast      907 ft = 276.5 m
 *  floors           52, ~4.1 m floor-to-floor
 *  floor plate      ~23,000 sq ft -> 58 x 38 m rectangle with cut corners
 *  podium           the Prudential Center deck, ~130 x 95 m, two storeys
 *
 * Reading order for the silhouette: a blunt rectangular slab, unbroken vertical
 * piers from plaza to parapet, a lightly stepped crown where the corners cut
 * back at the Skywalk/Top of the Hub levels, and the lattice mast. Next to the
 * Hancock's mirror it should read as *heavy* and *striped*.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, strut, cyl } from '../lib/geom';
import { curtainWall, edgeBays } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, chamferedRect, rect, type P2 } from '../lib/util';

const ROOF = ft(749); // 228.3 m
const MAST_TIP = ft(907); // 276.5 m
const FLOOR = 4.12;
const W = 58; // long face
const D = 38; // short face
const CHAMF = 6.2;
const BAY = 3.22; // pier spacing
const PODIUM_H = 9.6;
const FLARE_H = 17.5;
const CROWN0 = ROOF - 14.5; // Skywalk / Top of the Hub band

const shaftPlan = (s = 1): P2[] => chamferedRect(W * s, D * s, CHAMF * s);
const crownPlan = (): P2[] => chamferedRect(W - 1.2, D - 1.2, CHAMF + 8.5);

function buildPru(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  // The Pru's skin: light warm-grey precast piers, dark bronze-green glass.
  const pier = M.surface('stone', { color: 0xb9b3a6, roughness: 0.68, tile: 3.0 });
  const trim = M.surface('stone', { color: 0x9d978a, roughness: 0.7, tile: 3.0 });
  const glass = M.litGlass(
    2290,
    { color: 0x27333a, roughness: 0.13, metalness: 0.62, envMapIntensity: 1.05 },
    0.5,
  );
  const spandrel = M.surface('darkmetal', { color: 0x2b3136, roughness: 0.55, metalness: 0.5 });
  const concrete = M.surface('concrete', { color: 0xada79b, roughness: 0.85, tile: 3.4 });

  /* ---------------------------------------------------------- podium deck */
  b.add(prism(chamferedRect(132, 96, 14), 0, PODIUM_H - 1.1, { cap: false }), concrete);
  b.add(prism(chamferedRect(134, 98, 14), PODIUM_H - 1.1, PODIUM_H, { cap: true }), trim);
  if (detail) {
    // Two storeys of shopfront glazing wrapped round the deck.
    const pod = curtainWall(chamferedRect(132, 96, 14), 1.0, PODIUM_H - 1.6, {
      floorHeight: 4.2,
      paneWidth: 4.0,
      proud: -0.5,
      gap: 0.22,
      visionFraction: 0.78,
      seed: 2291,
    });
    b.add(pod.glass, M.litGlass(2291, { color: 0x243039, roughness: 0.15, metalness: 0.5 }, 0.8));
    if (pod.spandrel) b.add(pod.spandrel, spandrel);
  }

  /* --------------------------------------------------- flared tower base */
  b.add(prism(chamferedRect(70, 50, CHAMF + 2), 0, FLARE_H, { cap: true }), pier);
  {
    const baseGlass = curtainWall(chamferedRect(70, 50, CHAMF + 2), 4.2, FLARE_H - 1.4, {
      floorHeight: 4.4,
      paneWidth: BAY * 1.5,
      proud: -0.6,
      gap: 0.5,
      visionFraction: 0.68,
      seed: 2292,
    });
    b.add(baseGlass.glass, glass);
    if (baseGlass.spandrel) b.add(baseGlass.spandrel, spandrel);
  }

  /* ---------------------------------------------------------- main shaft */
  const plan = shaftPlan();
  // Structural backing plane, recessed behind the pier faces.
  b.add(prism(shaftPlan(0.975), FLARE_H, CROWN0, { cap: false }), spandrel);

  const skin = curtainWall(plan, FLARE_H, CROWN0, {
    floorHeight: FLOOR,
    paneWidth: BAY,
    proud: -0.62,
    gap: 0.62,
    visionFraction: 0.66,
    seed: 2290,
  });
  b.add(skin.glass, glass);
  if (skin.spandrel) b.add(skin.spandrel, spandrel);

  // Vertical piers on every bay joint, running the full height uninterrupted.
  // Cross-section: a shallow 5-sided prism so the pier catches a highlight on
  // its nose rather than reading as a flat strip.
  const bays = edgeBays(plan, BAY);
  const pw = detail ? 1.05 : 1.25;
  const pd = 0.72;
  const nose: P2[] = [
    [-pw / 2, 0],
    [pw / 2, 0],
    [pw / 2, pd * 0.62],
    [0, pd],
    [-pw / 2, pd * 0.62],
  ];
  for (const bay of bays) {
    if (bay.width === 0 && !bay.corner) continue;
    const g = prism(nose, FLARE_H, ROOF - 0.4, { cap: true, floor: false });
    b.addAt(g, pier, [bay.x, 0, bay.z], bay.rotY);
  }
  // A heavier pier at each corner, which is what gives the Pru its blunt edges.
  for (const bay of bays) {
    if (!bay.corner || bay.width === 0) continue;
    const g = prism(
      [
        [-1.5, 0],
        [1.5, 0],
        [1.5, 0.95],
        [-1.5, 0.95],
      ] as P2[],
      FLARE_H,
      ROOF - 0.4,
      { cap: true, floor: false },
    );
    b.addAt(g, pier, [bay.x, 0, bay.z], bay.rotY);
  }

  /* --------------------------------------------------------------- crown */
  // Corners cut back hard for the top three floors: the Skywalk band.
  b.add(prism(crownPlan(), CROWN0, ROOF - 2.4, { cap: false }), spandrel);
  {
    const sky = curtainWall(crownPlan(), CROWN0 + 0.6, ROOF - 3.2, {
      floorHeight: FLOOR,
      paneWidth: BAY,
      proud: 0.12,
      gap: 0.4,
      visionFraction: 0.82,
      seed: 2293,
    });
    // The observation floors are lit later and brighter than the office stack.
    const skyGlass = M.litGlass(2293, { color: 0x2c3b45, roughness: 0.1, metalness: 0.6 }, 0.9);
    skyGlass.userData.nightPeak = 1.6;
    b.add(sky.glass, skyGlass);
    if (sky.spandrel) b.add(sky.spandrel, spandrel);
  }
  b.add(prism(chamferedRect(W + 0.8, D + 0.8, CHAMF + 8.5), ROOF - 2.4, ROOF, { cap: true }), pier);
  b.add(prism(chamferedRect(W - 1.2, D - 1.2, CHAMF + 8.5), ROOF, ROOF + 1.5, { cap: true }), trim);

  /* ------------------------------------------------------ roof + antenna */
  b.add(prism(rect(30, 20), ROOF, ROOF + 6.5, { cap: true }), concrete);
  b.add(prism(rect(12, 9), ROOF + 6.5, ROOF + 9.2, { cap: true }), concrete);

  const steel = M.surface('metal', { color: 0xa7adb2, roughness: 0.42, metalness: 0.9 });
  const mastBase = ROOF + 9.2;
  const mastH = MAST_TIP - mastBase;
  if (detail) {
    // Square lattice mast: four tapering legs plus X-bracing every 4 m.
    const legs = 4;
    const seg = Math.round(mastH / 4);
    const r0 = 3.1;
    const r1 = 0.5;
    for (let s = 0; s < seg; s++) {
      const t0 = s / seg;
      const t1 = (s + 1) / seg;
      const y0 = mastBase + t0 * mastH;
      const y1 = mastBase + t1 * mastH;
      const rr0 = r0 + (r1 - r0) * t0;
      const rr1 = r0 + (r1 - r0) * t1;
      for (let l = 0; l < legs; l++) {
        const a0 = (l / legs) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((l + 1) / legs) * Math.PI * 2 + Math.PI / 4;
        const p0 = new THREE.Vector3(Math.cos(a0) * rr0, y0, Math.sin(a0) * rr0);
        const p1 = new THREE.Vector3(Math.cos(a0) * rr1, y1, Math.sin(a0) * rr1);
        b.add(strut(p0, p1, 0.16, 5), steel);
        const q0 = new THREE.Vector3(Math.cos(a1) * rr0, y0, Math.sin(a1) * rr0);
        const q1 = new THREE.Vector3(Math.cos(a1) * rr1, y1, Math.sin(a1) * rr1);
        b.add(strut(p0, q1, 0.075, 4), steel);
        b.add(strut(q0, p1, 0.075, 4), steel);
        b.add(strut(p1, q1, 0.09, 4), steel);
      }
    }
    b.addAt(cyl(0.45, 0.2, 9, 8), steel, [0, MAST_TIP - 9, 0]);
  } else {
    b.addAt(cyl(2.2, 0.4, mastH, 6), steel, [0, mastBase, 0]);
  }
  const beacon = M.emissive(0xff2a1a, 2.6);
  b.addAt(new THREE.SphereGeometry(0.7, 8, 6), beacon, [0, MAST_TIP, 0]);
  b.addAt(new THREE.SphereGeometry(0.6, 8, 6), beacon, [0, ROOF + 10.5, 0]);

  return b.build('prudential');
}

function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const body = M.litGlass(
    2294,
    { color: 0x6d6b62, roughness: 0.45, metalness: 0.32, envMapIntensity: 0.9 },
    0.45,
  );
  body.userData.nightPeak = 0.7;
  b.add(prism(chamferedRect(132, 96, 14), 0, PODIUM_H, { cap: true }), M.surface('concrete', { color: 0xada79b }));
  b.add(prism(chamferedRect(70, 50, CHAMF + 2), 0, FLARE_H, { cap: true }), body);
  b.add(prism(shaftPlan(), FLARE_H, CROWN0, { cap: false }), body);
  b.add(prism(crownPlan(), CROWN0, ROOF + 1.5, { cap: true }), body);
  const steel = M.surface('metal', { color: 0xa7adb2, roughness: 0.42, metalness: 0.9 });
  b.addAt(cyl(2.2, 0.4, MAST_TIP - ROOF, 5), steel, [0, ROOF, 0]);
  return b.build('prudential-far');
}

export function buildPrudential(ctx: Ctx): THREE.Object3D {
  return makeLOD('prudential', [
    { object: buildPru(ctx, true), distance: 0 },
    { object: buildPru(ctx, false), distance: 900 },
    { object: buildFar(ctx), distance: 3400 },
  ]);
}
