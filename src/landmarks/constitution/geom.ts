/**
 * Hull-lines mathematics and small geometry helpers for USS Constitution.
 *
 * A ship is the one landmark in this city that cannot be assembled out of
 * prisms: every surface is doubly curved and every dimension is quoted in feet
 * from a 1794 draught. So the hull is defined the way a shipwright defines one
 * — as a table of *levels* (waterlines, in effect) plus two longitudinal
 * curves, the rabbet/keel line and the sheer — and everything else (gun-port
 * recesses, channels, chain plates, the head rails) is placed by asking the
 * surface where it is at a given station and height.
 *
 * Local frame
 * -----------
 *   +X  forward (bow at +X), so the registry's `bearingX` aims the bow.
 *   +Y  up, with **y = 0 at the designed waterline**, not at the keel: she
 *       floats, so the model is authored about the water plane and the builder
 *       cancels the terrain lift the placer applies (see `constitution.ts`).
 *   +Z  starboard.
 *
 * `t` is the normalised station, -1 at the taffrail to +1 at the stem head.
 */
import * as THREE from 'three';
import { strut } from '../lib/geom';
import type { Builder } from '../lib/geom';

/* ------------------------------------------------------------- dimensions */

/** Length on deck: 204 ft. */
export const HULL_LEN = 62.2;
export const HALF_LEN = HULL_LEN / 2;
/** Extreme beam: 44 ft 6 in. */
export const BEAM = 13.6;
export const HALF_BEAM = BEAM / 2;
/** Bottom of the keel amidships; moulded draught is 22 ft 6 in. */
export const KEEL_Y = -6.9;
/** Top of the main rail amidships. */
export const RAIL_Y = 7.55;
/** Planksheer — where the spar deck meets the topsides. */
export const PLANKSHEER_Y = 6.0;
/** The white gun-port strake. */
export const STRAKE_LO = 3.42;
export const STRAKE_HI = 4.74;
/** Copper sheathing stops a little above the load line (the "boot top"). */
export const COPPER_Y = 0.55;

interface Level {
  /** Height above the waterline amidships. */
  y: number;
  /** Half-beam as a fraction of `HALF_BEAM` amidships. */
  r: number;
  /** Plan bluntness: larger keeps the level full further toward the ends. */
  e: number;
  /** Half-width at the transom as a fraction of this level's midship value. */
  tr: number;
}

/**
 * The midship section, bottom to rail. `r` peaks a touch above the waterline
 * and falls away again toward the rail: that is the tumblehome, and it is the
 * single most recognisable thing about a hull of this period.
 */
export const LEVELS: readonly Level[] = [
  { y: -6.90, r: 0.022, e: 4.20, tr: 0.00 },
  { y: -6.20, r: 0.085, e: 3.80, tr: 0.00 },
  { y: -5.30, r: 0.205, e: 3.40, tr: 0.00 },
  { y: -4.30, r: 0.385, e: 3.05, tr: 0.00 },
  { y: -3.20, r: 0.580, e: 2.80, tr: 0.00 },
  { y: -2.00, r: 0.760, e: 2.60, tr: 0.00 },
  { y: -0.90, r: 0.888, e: 2.46, tr: 0.00 },
  { y: 0.00, r: 0.956, e: 2.38, tr: 0.02 },
  { y: COPPER_Y, r: 0.980, e: 2.34, tr: 0.09 },
  { y: 1.40, r: 1.000, e: 2.30, tr: 0.20 },
  { y: 2.60, r: 0.996, e: 2.24, tr: 0.33 },
  { y: STRAKE_LO, r: 0.984, e: 2.20, tr: 0.41 },
  { y: STRAKE_HI, r: 0.950, e: 2.16, tr: 0.49 },
  { y: PLANKSHEER_Y, r: 0.910, e: 2.12, tr: 0.56 },
  { y: RAIL_Y, r: 0.866, e: 2.08, tr: 0.62 },
];

/** Index of the level at each named height, for band selection. */
export const L_COPPER = 8;
export const L_STRAKE_LO = 11;
export const L_STRAKE_HI = 12;
export const L_PLANKSHEER = 13;
export const L_RAIL = 14;

/** Rabbet line: the bottom of the hull at each station. */
const YBOT: readonly [number, number][] = [
  [-1.000, 2.75],
  [-0.955, 1.35],
  [-0.912, -0.55],
  [-0.872, -2.55],
  [-0.822, -4.55],
  [-0.760, -6.10],
  [-0.660, -6.86],
  [-0.300, -7.00],
  [0.100, -6.90],
  [0.500, -6.70],
  [0.680, -6.34],
  [0.800, -5.20],
  [0.880, -3.40],
  [0.940, -1.20],
  [0.975, 1.05],
  [1.000, 3.45],
];

/** Sheer: how far the rail rises above its midship height. */
const SHEER: readonly [number, number][] = [
  [-1.000, 2.30],
  [-0.850, 1.34],
  [-0.650, 0.62],
  [-0.400, 0.17],
  [-0.100, 0.00],
  [0.200, 0.06],
  [0.500, 0.44],
  [0.750, 1.12],
  [0.900, 1.96],
  [1.000, 3.05],
];

/** Smooth (C1) interpolation through a sorted keyed table. */
export function curve(table: readonly [number, number][], t: number): number {
  const n = table.length;
  if (t <= table[0][0]) return table[0][1];
  if (t >= table[n - 1][0]) return table[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= table[i][0]) {
      const t0 = table[i - 1][0];
      const t1 = table[i][0];
      const u = (t - t0) / (t1 - t0);
      return table[i - 1][1] + (table[i][1] - table[i - 1][1]) * (u * u * (3 - 2 * u));
    }
  }
  return table[n - 1][1];
}

export const sheerAt = (t: number): number => curve(SHEER, t);
export const keelAt = (t: number): number => curve(YBOT, t);

/** Height of a topside feature at a station, carried up by the sheer. */
export function sheeredY(t: number, y: number): number {
  return Math.max(keelAt(t), y + sheerAt(t) * Math.sqrt(Math.max(0, y) / RAIL_Y));
}

/**
 * Height of level `li` at station `t`. Underwater levels are squeezed between
 * the rabbet line and the waterline, so the load line stays dead flat while the
 * forefoot and the tuck sweep up. Topside levels ride the sheer, weighted by
 * height so the wale and the gun-port strake stay roughly parallel to the rail.
 */
export function levelY(t: number, li: number): number {
  const lv = LEVELS[li];
  const bot = keelAt(t);
  if (lv.y <= 0) {
    const depth = Math.max(0, -bot);
    return bot + ((lv.y - KEEL_Y) / -KEEL_Y) * depth;
  }
  return Math.max(bot, lv.y + sheerAt(t) * Math.sqrt(lv.y / RAIL_Y));
}

/** Half-breadth of level `li` at station `t`. */
export function levelHalf(t: number, li: number): number {
  const lv = LEVELS[li];
  const at = Math.min(1, Math.abs(t));
  const taper = Math.sqrt(Math.max(0, 1 - Math.pow(at, lv.e)));
  const plan = t >= 0 ? taper : lv.tr + (1 - lv.tr) * taper;
  return Math.max(0.014, lv.r * HALF_BEAM * plan);
}

/**
 * Longitudinal position. The stem rakes forward and the counter overhangs aft,
 * both of which are pure silhouette: without them the ends look like a barge.
 */
export function levelX(t: number, y: number): number {
  let x = t * HALF_LEN;
  if (t < -0.8) {
    const k = (-t - 0.8) / 0.2;
    x -= k * k * Math.max(0, y - 1.0) * 0.36;
  }
  if (t > 0.86) {
    const k = (t - 0.86) / 0.14;
    x += k * k * Math.max(0, y + 2.6) * 0.185;
  }
  return x;
}

/** Surface point at a station/level pair. `side` is +1 starboard, -1 port. */
export function hullPoint(t: number, li: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = levelY(t, li);
  return out.set(levelX(t, y), y, side * levelHalf(t, li));
}

/**
 * Surface point at an arbitrary height, by interpolating between the levels
 * that bracket it. This is how every fitting finds the plank it bolts to.
 */
export function hullAt(t: number, y: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
  let y0 = levelY(t, 0);
  const n = LEVELS.length;
  for (let j = 1; j < n; j++) {
    const y1 = levelY(t, j);
    if (y <= y1 || j === n - 1) {
      const u = y1 - y0 > 1e-5 ? THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1) : 0;
      const h = levelHalf(t, j - 1) * (1 - u) + levelHalf(t, j) * u;
      return out.set(levelX(t, y), y, side * h);
    }
    y0 = y1;
  }
  return out.set(levelX(t, y), y, side * levelHalf(t, n - 1));
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Outward unit normal of the topside at (t, y). */
export function hullNormal(t: number, y: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
  const dt = 0.006;
  const dy = 0.22;
  hullAt(t - dt, y, side, _a);
  hullAt(t + dt, y, side, _b);
  const tx = _b.clone().sub(_a);
  hullAt(t, y - dy, side, _a);
  hullAt(t, y + dy, side, _c);
  const ty = _c.clone().sub(_a);
  out.crossVectors(ty, tx).normalize();
  if (out.z * side < 0) out.negate();
  return out;
}

/* -------------------------------------------------------------- primitives */

/**
 * Quad grid from `rows[j][i]`. Normals are averaged, which is what a planked
 * hull wants.
 *
 * Which way the sheet faces is easy to get wrong and impossible to see in a
 * screenshot (a back-facing hull is simply not drawn, and you find yourself
 * looking at the far side's interior instead), so state the rule once: with
 * `ei` the direction of increasing `i` and `ej` the direction of increasing `j`,
 *
 *     flip === false  ->  outward normal is  -(ei x ej)
 *     flip === true   ->  outward normal is  +(ei x ej)
 *
 * So a deck laid out `i` = forward (+X), `j` = to starboard (+Z) faces up with
 * `flip = false`, and a topside laid out `i` = forward, `j` = up faces to
 * starboard with `flip = true`.
 */
export function gridGeometry(rows: THREE.Vector3[][], flip: boolean): THREE.BufferGeometry {
  const J = rows.length;
  const I = rows[0].length;
  const pos = new Float32Array(J * I * 3);
  const uv = new Float32Array(J * I * 2);
  let p = 0;
  let q = 0;
  for (let j = 0; j < J; j++) {
    for (let i = 0; i < I; i++) {
      const v = rows[j][i];
      pos[p++] = v.x;
      pos[p++] = v.y;
      pos[p++] = v.z;
      uv[q++] = v.x;
      uv[q++] = v.y;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < J - 1; j++) {
    for (let i = 0; i < I - 1; i++) {
      const a = j * I + i;
      const b = a + 1;
      const c = a + I;
      const d = c + 1;
      if (flip) idx.push(a, b, d, a, d, c);
      else idx.push(a, d, b, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Single quad from four corners, wound a->b->c->d. */
export function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z],
      3,
    ),
  );
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Flat polygon from a fan of coplanar-ish points. */
export function polyFan(pts: THREE.Vector3[], reverse = false): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const p of pts) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (reverse) idx.push(0, i + 1, i);
    else idx.push(0, i, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pts.length * 2), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A rope. Three radial segments is six triangles — the whole standing rig is
 * roughly four thousand of them, which is what lets every shroud and ratline be
 * real geometry instead of a texture.
 */
export function rope(
  b: Builder,
  mat: THREE.Material,
  a: THREE.Vector3,
  c: THREE.Vector3,
  r = 0.035,
): void {
  if (a.distanceToSquared(c) < 1e-6) return;
  b.add(strut(a, c, r, 3), mat);
}

/** A spar: tapered both ways from a quarter-length, as a real yard is. */
export function spar(len: number, rMid: number, rEnd: number, seg = 7): THREE.BufferGeometry {
  const prof: [number, number][] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const s = Math.abs(u * 2 - 1);
    prof.push([Math.max(0.01, rMid + (rEnd - rMid) * s * s), -len / 2 + u * len]);
  }
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** A mast section: a tapered pole from y0 to y1 stood up at the origin. */
export function pole(y0: number, y1: number, r0: number, r1: number, seg = 9): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, false);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

export const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
