/**
 * Runway and taxiway paint: threshold bars, touchdown-zone bars, the aiming
 * point, runway designator numerals, centreline dashes, edge lines, taxiway
 * centrelines and hold-short bars.
 *
 * Dimensions follow the standard FAA runway/taxiway marking scheme
 * (AC 150/5340-1) at approximate real proportions — this is published
 * specification, not invented layout, the same way the pavement geometry
 * itself comes from the measured runway data in `layout.ts`.
 *
 * Paint is flat geometry lying almost coincident with the pavement beneath
 * it, which is exactly the depth trap this codebase has hit before: it must
 * not write depth or cast a shadow, or it z-fights and self-shadows the
 * surface it is painted on (see `Parks.ts`, and `src/world/roads/materials.ts`'s
 * `paint` recipe, mirrored here — `transparent: true` forces it into the
 * render queue *after* every opaque surface including the pavement below,
 * `depthWrite: false` stops it fighting anything drawn after it, and a small
 * additional lift over the pavement is belt-and-braces).
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import type { LoganLayout, RunwaySpec, TaxiwaySpec } from './layout';
import { MeshBuilder, hexRGB, type RGB } from './meshkit';
import { PAVEMENT_LIFT } from './pavement';

const MARK_LIFT = PAVEMENT_LIFT + 0.035;
// Runway pavement itself sits a further 0.06 m above `PAVEMENT_LIFT` (see
// `pavement.ts`, so a reconstructed runway without a mapped polygon always
// wins a depth tie against an overlapping real apron); runway paint has to
// clear *that*, not the base lift, or it sinks below its own pavement and
// fails the depth test against the opaque surface it should be sitting on.
const MARK_LIFT_RUNWAY = PAVEMENT_LIFT + 0.1;
const WHITE: RGB = hexRGB(0xf1efe4);
const YELLOW: RGB = hexRGB(0xf0b91f);
const TILE = 3.4;

export interface MarkingsResult {
  meshes: THREE.Mesh[];
  materials: THREE.Material[];
}

export function buildMarkings(ctx: Ctx, layout: LoganLayout): MarkingsResult {
  const yAt = (x: number, z: number): number => ctx.sampleHeight(x, z) + MARK_LIFT;
  const yAtRunway = (x: number, z: number): number => ctx.sampleHeight(x, z) + MARK_LIFT_RUNWAY;
  const white = new MeshBuilder();
  const yellow = new MeshBuilder();

  for (const rw of layout.runways) emitRunwayMarkings(white, rw, yAtRunway);
  for (const tw of layout.taxiways) emitTaxiwayCentreline(yellow, tw, yAt);
  emitHoldShort(yellow, layout, yAt);

  const materials: THREE.Material[] = [];
  const meshes: THREE.Mesh[] = [];
  const whiteGeo = white.build();
  if (whiteGeo) meshes.push(finishPaint(whiteGeo, paintMaterial(ctx, materials), 'airport:paint:white'));
  const yellowGeo = yellow.build();
  if (yellowGeo) meshes.push(finishPaint(yellowGeo, paintMaterial(ctx, materials), 'airport:paint:yellow'));
  return { meshes, materials };
}

/* --------------------------------------------------------------- runway */

function emitRunwayMarkings(mb: MeshBuilder, rw: RunwaySpec, yAt: (x: number, z: number) => number): void {
  const [ax, az] = rw.axis;
  const nx = -az, nz = ax;
  const hw = rw.width / 2;
  const pt = (l: number, w: number): [number, number] => [rw.center[0] + ax * l + nx * w, rw.center[1] + az * l + nz * w];
  const half = rw.length / 2;

  // Edge lines, full length, both sides.
  emitOriented(mb, rw.center[0] - nx * (hw - 0.6), rw.center[1] - nz * (hw - 0.6), ax, az, rw.length, 0.5, yAt, WHITE);
  emitOriented(mb, rw.center[0] + nx * (hw - 0.6), rw.center[1] + nz * (hw - 0.6), ax, az, rw.length, 0.5, yAt, WHITE);

  // Centreline dashes, full length (the threshold/numeral zones paint over
  // the first ~90 m from each end, which is authentic — the dashes start
  // past the piano keys in reality too).
  const dashLen = 12, gap = 8;
  for (let l = -half + dashLen / 2; l < half; l += dashLen + gap) {
    const [cx, cz] = pt(l, 0);
    emitOriented(mb, cx, cz, ax, az, dashLen, 0.9, yAt, WHITE);
  }

  emitThresholdEnd(mb, rw, 1, yAt);
  emitThresholdEnd(mb, rw, -1, yAt);
}

/** `dir` +1 = thresholdA end (marks point inward along `+axis`), -1 = thresholdB end. */
function emitThresholdEnd(mb: MeshBuilder, rw: RunwaySpec, dir: 1 | -1, yAt: (x: number, z: number) => number): void {
  const [ax0, az0] = rw.axis;
  const ax = ax0 * dir, az = az0 * dir; // "inward" unit vector from this end
  const nx = -az0, nz = ax0;            // fixed across-axis so left/right stay consistent from both ends
  const base = dir > 0 ? rw.thresholdA : rw.thresholdB;
  const half = rw.length / 2;
  const stripes = rw.width >= 40 ? 8 : 6;
  const stripeW = (rw.width * 0.72) / stripes / 1.5;
  const stripeGap = stripeW * 0.65;
  const barLen = Math.min(30, rw.length * 0.06);

  // Threshold bars ("piano keys"): a row of longitudinal stripes just inside the edge.
  for (let i = 0; i < stripes; i++) {
    const side = i < stripes / 2 ? -1 : 1;
    const rank = i < stripes / 2 ? i : i - stripes / 2;
    const off = (rw.width * 0.5 - 3) - rank * (stripeW + stripeGap);
    const w = side * off;
    const cx = base[0] + ax * (barLen / 2 + 1) + nx * w;
    const cz = base[1] + az * (barLen / 2 + 1) + nz * w;
    emitOriented(mb, cx, cz, ax, az, barLen, stripeW, yAt, WHITE);
  }

  // Designator numerals, ~85 m in, reading correctly to traffic moving `+axis*dir`.
  const label = dir > 0 ? rw.labelA : rw.labelB;
  const charH = Math.min(12, rw.width * 0.34);
  const charW = charH * 0.5;
  const glyphGap = charW * 0.35;
  const totalW = label.length * charW + (label.length - 1) * glyphGap;
  const numeralL = Math.min(half - barLen - 4, 85);
  let w0 = -totalW / 2;
  for (const ch of label) {
    const originX = base[0] + ax * numeralL + nx * w0;
    const originZ = base[1] + az * numeralL + nz * w0;
    emitChar(mb, originX, originZ, nx * dir, nz * dir, ax, az, charW, charH, ch, yAt, WHITE);
    w0 += charW + glyphGap;
  }

  // Touchdown zone bars, including a wide aiming-point pair at ~300 m.
  const tdz = [[150, 1.0, 18], [300, 2.6, 30], [450, 1.0, 18], [600, 1.0, 18]] as const;
  for (const [dist, thick, len] of tdz) {
    if (dist + len / 2 > half - 10) continue;
    for (const side of [-1, 1]) {
      const w = side * (rw.width * 0.22);
      const cx = base[0] + ax * dist + nx * w;
      const cz = base[1] + az * dist + nz * w;
      emitOriented(mb, cx, cz, ax, az, len, thick, yAt, WHITE);
    }
  }
}

/* -------------------------------------------------------------- taxiway */

function emitTaxiwayCentreline(mb: MeshBuilder, tw: TaxiwaySpec, yAt: (x: number, z: number) => number): void {
  emitOriented(mb, tw.center[0], tw.center[1], tw.axis[0], tw.axis[1], tw.length * 0.98, 0.4, yAt, YELLOW);
}

/** Double solid + double dashed bar across the taxiway, standard hold-short style. */
function emitHoldShort(mb: MeshBuilder, layout: LoganLayout, yAt: (x: number, z: number) => number): void {
  const rw = layout.primary;
  const [ax, az] = rw.axis; // runway axis; the hold bar is perpendicular to it
  const nx = -az, nz = ax;
  const [hx, hz] = layout.holdShort;
  const span = 24; // nominal taxiway width covered by the bars
  const solidOffsets = [0, 1.1];
  const dashOffset = 2.6;

  for (const o of solidOffsets) {
    const cx = hx + ax * o, cz = hz + az * o;
    emitOriented(mb, cx, cz, nx, nz, span, 0.5, yAt, YELLOW);
  }
  const dashLen = 3, gap = 2;
  for (let s = -span / 2; s < span / 2; s += dashLen + gap) {
    const cx0 = hx + ax * dashOffset + nx * (s + dashLen / 2);
    const cz0 = hz + az * dashOffset + nz * (s + dashLen / 2);
    emitOriented(mb, cx0, cz0, nx, nz, dashLen, 0.5, yAt, YELLOW);
  }
}

/* ---------------------------------------------------------------- glyphs */

/** Stroke segments as [u0,v0,u1,v1] rectangles in a unit 0..1 character box. */
const T: [number, number, number, number] = [0.14, 0.86, 0.86, 1.0];
const TL: [number, number, number, number] = [0.0, 0.5, 0.16, 1.0];
const TR: [number, number, number, number] = [0.84, 0.5, 1.0, 1.0];
const MID: [number, number, number, number] = [0.14, 0.44, 0.86, 0.58];
const BL: [number, number, number, number] = [0.0, 0.0, 0.16, 0.5];
const BR: [number, number, number, number] = [0.84, 0.0, 1.0, 0.5];
const BOT: [number, number, number, number] = [0.14, 0.0, 0.86, 0.14];

const CHAR_SEGMENTS: Record<string, Array<[number, number, number, number]>> = {
  '0': [T, TL, TR, BL, BR, BOT],
  '1': [TR, BR],
  '2': [T, TR, MID, BL, BOT],
  '3': [T, TR, MID, BR, BOT],
  '4': [TL, TR, MID, BR],
  '5': [T, TL, MID, BR, BOT],
  '6': [T, TL, MID, BL, BR, BOT],
  '7': [T, TR, BR],
  '8': [T, TL, TR, MID, BL, BR, BOT],
  '9': [T, TL, TR, MID, BR, BOT],
  L: [TL, BL, BOT],
  // Approximated with the same seven-segment stroke set as the digits (no
  // diagonal leg available) — legible as "R" at the distance these are seen
  // from, which is the bar this glyph set needs to clear.
  R: [T, TL, TR, MID, BL, BR],
  C: [T, TL, BL, BOT],
};

/**
 * One glyph, `charW` x `charH` metres, in a local frame: `right` is the
 * character's own left-to-right axis, `up` the baseline-to-top axis (which
 * for a runway numeral is the direction of travel, so it reads upright to
 * traffic moving that way). `originX/Z` is the glyph's bottom-left corner.
 */
function emitChar(
  mb: MeshBuilder, originX: number, originZ: number,
  rightX: number, rightZ: number, upX: number, upZ: number,
  charW: number, charH: number, ch: string,
  yAt: (x: number, z: number) => number, colour: RGB,
): void {
  const segs = CHAR_SEGMENTS[ch.toUpperCase()];
  if (!segs) return;
  const inv = 1 / TILE;
  const corner = (u: number, v: number): [number, number] => [
    originX + rightX * (u * charW) + upX * (v * charH),
    originZ + rightZ * (u * charW) + upZ * (v * charH),
  ];
  for (const [u0, v0, u1, v1] of segs) {
    const p0 = corner(u0, v0), p1 = corner(u1, v0), p2 = corner(u1, v1), p3 = corner(u0, v1);
    const i0 = mb.vert(p0[0], yAt(p0[0], p0[1]), p0[1], 0, 1, 0, p0[0] * inv, p0[1] * inv, colour);
    const i1 = mb.vert(p1[0], yAt(p1[0], p1[1]), p1[1], 0, 1, 0, p1[0] * inv, p1[1] * inv, colour);
    const i2 = mb.vert(p2[0], yAt(p2[0], p2[1]), p2[1], 0, 1, 0, p2[0] * inv, p2[1] * inv, colour);
    const i3 = mb.vert(p3[0], yAt(p3[0], p3[1]), p3[1], 0, 1, 0, p3[0] * inv, p3[1] * inv, colour);
    mb.tri(i0, i1, i2);
    mb.tri(i0, i2, i3);
  }
}

/** An oriented flat rectangle, `along`/`across` metres, centred at cx,cz. */
function emitOriented(
  mb: MeshBuilder, cx: number, cz: number, ax: number, az: number,
  along: number, across: number, yAt: (x: number, z: number) => number, colour: RGB,
): void {
  mb.orientedRect(cx, cz, ax, az, along, across, yAt, TILE, colour);
}

/* --------------------------------------------------------------- material */

function paintMaterial(ctx: Ctx, bag: THREE.Material[]): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'airport:paint',
    vertexColors: true,
    roughness: 0.7,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  if (ctx.envMap) mat.envMap = ctx.envMap;
  mat.envMapIntensity = 0.5;
  bag.push(mat);
  return mat;
}

function finishPaint(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.noShadow = true;
  mesh.matrixAutoUpdate = false;
  // Paint renders after every opaque surface (see file header), so it always
  // wins the depth test against the pavement without needing to write depth
  // itself; this only nudges it ahead of *other* transparent geometry.
  mesh.renderOrder = 5;
  return mesh;
}
