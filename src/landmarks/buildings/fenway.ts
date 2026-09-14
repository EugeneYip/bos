/**
 * Fenway Park, 4 Jersey Street. Opened 20 April 1912; oldest ballpark in
 * Major League Baseball.
 *
 * Fenway is famous precisely because nothing about it is regular — the park
 * was squeezed into an existing street grid, so every outfield distance is
 * different. Modelling it as a symmetric bowl would miss the entire point.
 *
 * Real-world dimensions used (official posted distances)
 * ------------------------------------------------------
 *  left field line      310 ft = 94.5 m
 *  the Green Monster    37 ft 2 in = 11.33 m high, 231 ft = 70.4 m long
 *  centre field         390 ft = 118.9 m
 *  deepest (triangle)   420 ft = 128.0 m
 *  right-centre         380 ft = 115.8 m
 *  right field line     302 ft = 92.0 m  (Pesky's Pole)
 *  right field wall     3-5 ft, rising to 17 ft in the bullpen corner
 *  infield              90 ft = 27.43 m between bases
 *  light towers         six banks, ~30 m
 *
 * Model convention: home plate sits at the local origin and the +X axis points
 * at centre field (the registry rotates that onto the real 38 deg bearing).
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, type P2 } from '../lib/util';

const LF_LINE = ft(310);
const CF = ft(390);
const TRIANGLE = ft(420);
const RCF = ft(380);
const RF_LINE = ft(302);
const MONSTER_H = ft(37.17); // 11.33 m
const BASE_PATH = ft(90); // 27.43 m

/**
 * The outfield wall in plan, from the left-field foul pole round to the right.
 * Angles are measured from the +X (centre field) axis; the foul lines sit at
 * +/-45 deg. The kink at the triangle and the sharp cut to Pesky's Pole are
 * what make the outline recognisably Fenway.
 */
const WALL: { a: number; r: number; h: number }[] = [
  { a: -45, r: LF_LINE, h: MONSTER_H }, // LF foul pole
  { a: -30, r: ft(320), h: MONSTER_H }, // along the Monster
  { a: -14, r: ft(379), h: MONSTER_H }, // centre-field end of the Monster
  { a: -9, r: ft(379), h: ft(17) }, // step down past the scoreboard
  { a: -4, r: TRIANGLE, h: ft(17) }, // the Triangle, deepest point
  { a: 4, r: CF, h: ft(17) },
  { a: 14, r: RCF, h: ft(5) },
  { a: 28, r: ft(330), h: ft(5) },
  { a: 45, r: RF_LINE, h: ft(3) }, // Pesky's Pole
];

const pt = (a: number, r: number): P2 => [Math.cos((a * Math.PI) / 180) * r, Math.sin((a * Math.PI) / 180) * r];

function buildFW(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const monsterGreen = M.surface('paint', { color: 0x1b5c3a, roughness: 0.72, tile: 2.4 });
  const seatGreen = M.surface('paint', { color: 0x1d5e46, roughness: 0.68, tile: 1.2 });
  const grass = M.surface('paint', { color: 0x3f7a33, roughness: 0.95, tile: 6.0 });
  const dirt = M.surface('concrete', { color: 0x9a6c48, roughness: 0.97, tile: 4.0 });
  const concrete = M.surface('concrete', { color: 0x9c978f, roughness: 0.9, tile: 3.0 });
  const brick = M.surface('brick', { color: 0x8a5240, roughness: 0.92, tile: 2.2 });
  const steel = M.surface('darkmetal', { color: 0x41474d, roughness: 0.55, metalness: 0.78 });
  const white = M.surface('paint', { color: 0xf0ede6, roughness: 0.6, tile: 2.0 });
  const yellow = M.surface('paint', { color: 0xe8c53a, roughness: 0.6, tile: 2.0 });

  /* ------------------------------------------------------------- playing field */
  // Fair territory as a fan from home plate out to the wall, plus foul ground.
  const fieldPts: P2[] = [[0, 0]];
  for (let i = 0; i < WALL.length; i++) {
    const w = WALL[i];
    fieldPts.push(pt(w.a, w.r));
    const next = WALL[i + 1];
    if (next) {
      // Subdivide so the turf edge follows the wall rather than chording it.
      const steps = detail ? 4 : 2;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        fieldPts.push(pt(w.a + (next.a - w.a) * t, w.r + (next.r - w.r) * t));
      }
    }
  }
  b.add(prism(fieldPts, -0.15, 0.02, { cap: true }), grass);
  // Foul ground behind the plate.
  b.add(prism([[-26, -34], [-26, 34], [6, 40], [6, -40]], -0.15, 0.0, { cap: true }), dirt);

  // Infield dirt: the skinned area, plus the base paths.
  const inf: P2[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (-48 + (i / 24) * 96) * (Math.PI / 180);
    inf.push([Math.cos(a) * (BASE_PATH * 1.42), Math.sin(a) * (BASE_PATH * 1.42)]);
  }
  inf.push([-3, 0]);
  b.add(prism(inf, 0.0, 0.03, { cap: true }), dirt);
  // Pitcher's mound.
  b.addAt(cyl(2.74, 2.6, 0.25, detail ? 20 : 8), dirt, [ft(60.5), 0.03, 0]);

  /* ----------------------------------------------------- the outfield wall */
  for (let i = 0; i < WALL.length - 1; i++) {
    const w0 = WALL[i];
    const w1 = WALL[i + 1];
    const steps = detail ? 5 : 2;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const a0 = w0.a + (w1.a - w0.a) * t0;
      const a1 = w0.a + (w1.a - w0.a) * t1;
      const r0 = w0.r + (w1.r - w0.r) * t0;
      const r1 = w0.r + (w1.r - w0.r) * t1;
      const h = w0.h + (w1.h - w0.h) * ((t0 + t1) / 2);
      const p0 = pt(a0, r0);
      const p1 = pt(a1, r1);
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const len = Math.hypot(dx, dz);
      const mid: [number, number, number] = [(p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2];
      const rot = -Math.atan2(dz, dx);
      // The Monster and the left-field wall are the green; the rest is lower.
      b.addAt(box(len + 0.35, h, 0.55), monsterGreen, mid, rot);
      if (detail) b.addAt(box(len + 0.4, 0.18, 0.7), yellow, [mid[0], h, mid[2]], rot);
    }
  }

  /* -------------------------------- the Monster's manual scoreboard & net */
  if (detail) {
    const sbA = -24;
    const sbP = pt(sbA, ft(330));
    const sbRot = -Math.atan2(pt(-14, ft(379))[1] - pt(-30, ft(320))[1],
      pt(-14, ft(379))[0] - pt(-30, ft(320))[0]);
    const board = M.emissive(0x0d120f, 0.0, { night: true });
    board.userData.nightPeak = 0.8;
    b.addAt(box(18.0, 5.2, 0.2), board, [sbP[0], 0.6, sbP[1]], sbRot);
    // The white number slots.
    for (let i = 0; i < 12; i++) {
      b.addAt(box(1.05, 0.9, 0.1), white, [sbP[0] - Math.sin(sbRot) * 0, 1.2, sbP[1]], sbRot);
      void i;
    }
  }

  /* --------------------------------------------------------- the grandstand */
  // A raked bowl behind the plate and down both foul lines, following the
  // same fan but at a larger radius and stepping upward.
  const standInner = 34.0;
  const standOuter = 62.0;
  const standTop = 24.0;
  const arc: P2[] = [];
  const arcOut: P2[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = (-138 + (i / 40) * 276) * (Math.PI / 180);
    arc.push([Math.cos(a) * standInner, Math.sin(a) * standInner]);
    arcOut.push([Math.cos(a) * standOuter, Math.sin(a) * standOuter]);
  }
  const ring: P2[] = [...arcOut, ...arc.slice().reverse()];
  b.add(prism(ring, 0, standTop * 0.55, { cap: true }), concrete);
  // Upper deck + roof, set back.
  const upper: P2[] = [];
  const upperIn: P2[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = (-128 + (i / 40) * 256) * (Math.PI / 180);
    upperIn.push([Math.cos(a) * (standInner + 9), Math.sin(a) * (standInner + 9)]);
    upper.push([Math.cos(a) * standOuter, Math.sin(a) * standOuter]);
  }
  b.add(prism([...upper, ...upperIn.slice().reverse()], standTop * 0.55, standTop, { cap: true }), concrete);
  // The seating rake itself, as a tilted green band.
  if (detail) {
    for (let i = 0; i < 40; i++) {
      const a0 = (-138 + (i / 40) * 276) * (Math.PI / 180);
      const a1 = (-138 + ((i + 1) / 40) * 276) * (Math.PI / 180);
      const p0: P2 = [Math.cos(a0) * standInner, Math.sin(a0) * standInner];
      const p1: P2 = [Math.cos(a1) * standInner, Math.sin(a1) * standInner];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const rot = -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const g = box(len + 0.2, 13.0, 0.4);
      g.rotateX(-0.62);
      g.translate((p0[0] + p1[0]) / 2, 1.0, (p0[1] + p1[1]) / 2);
      g.rotateY(0);
      const m = new THREE.Matrix4().makeRotationY(rot);
      const g2 = box(len + 0.2, 0.9, 12.0);
      g2.applyMatrix4(m);
      void g2;
      b.addAt(box(len + 0.25, 11.0, 0.5), seatGreen,
        [(p0[0] + p1[0]) / 2 + Math.cos(a0) * 5.5, 1.0, (p0[1] + p1[1]) / 2 + Math.sin(a0) * 5.5], rot);
      g.dispose();
    }
  }
  // Roof over the upper deck.
  b.add(prism([...upper, ...upperIn.slice().reverse()], standTop, standTop + 1.2, { cap: true }), steel);

  /* ------------------------------------------- Jersey Street brick frontage */
  b.addAt(prism([[-64, -40], [-64, 40], [-48, 40], [-48, -40]], 0, 17.0, { cap: true }), brick, [0, 0, 0]);

  /* -------------------------------------------------------- light towers */
  const towers: [number, number][] = [
    [-40, standOuter - 2], [-12, standOuter - 2], [12, standOuter - 2], [40, standOuter - 2],
  ];
  for (const [a, r] of towers) {
    const p = pt(a, r);
    const y0 = standTop + 1.2;
    const y1 = 30.0;
    for (const [ox, oz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
      b.add(strut(new THREE.Vector3(p[0] + ox, y0, p[1] + oz),
        new THREE.Vector3(p[0] + ox * 0.5, y1, p[1] + oz * 0.5), 0.16, 5), steel);
    }
    // The light bank itself: a rack of individual fixtures that glow at night.
    const lamp = M.emissive(0xfff4d8, 0.6, { night: true });
    lamp.userData.nightPeak = 8.0;
    b.addAt(box(7.0, 0.5, 2.4), steel, [p[0], y1, p[1]]);
    for (let i = 0; i < 8; i++) {
      b.addAt(box(0.66, 0.66, 0.3), lamp, [p[0] - 3.0 + i * 0.86, y1 + 0.55, p[1] + 1.0]);
    }
    b.addAt(box(7.4, 0.4, 0.5), steel, [p[0], y1 + 1.3, p[1]]);
  }
  // The two Monster-top towers, which sit on the wall rather than the roof.
  for (const a of [-34, -18]) {
    const p = pt(a, ft(325));
    for (const [ox, oz] of [[-1.1, -1.1], [1.1, 1.1]] as const) {
      b.add(strut(new THREE.Vector3(p[0] + ox, MONSTER_H, p[1] + oz),
        new THREE.Vector3(p[0], MONSTER_H + 12.0, p[1]), 0.14, 5), steel);
    }
    const lamp = M.emissive(0xfff4d8, 0.6, { night: true });
    lamp.userData.nightPeak = 8.0;
    b.addAt(box(6.0, 0.45, 2.0), steel, [p[0], MONSTER_H + 12.0, p[1]]);
    for (let i = 0; i < 7; i++) {
      b.addAt(box(0.6, 0.6, 0.28), lamp, [p[0] - 2.5 + i * 0.83, MONSTER_H + 12.5, p[1] + 0.9]);
    }
  }

  /* ------------------------------------------------------------ foul poles */
  // Pesky's Pole in right, and the left-field pole atop the Monster.
  const lf = pt(-45, LF_LINE);
  const rf = pt(45, RF_LINE);
  b.addAt(cyl(0.22, 0.18, 12.0, 8), yellow, [lf[0], MONSTER_H, lf[1]]);
  b.addAt(cyl(0.22, 0.18, 11.4, 8), yellow, [rf[0], ft(3), rf[1]]);

  return b.build('fenway-park');
}

export function buildFenway(ctx: Ctx): THREE.Object3D {
  return makeLOD('fenway-park', [
    { object: buildFW(ctx, true), distance: 0 },
    { object: buildFW(ctx, false), distance: 900 },
  ]);
}
