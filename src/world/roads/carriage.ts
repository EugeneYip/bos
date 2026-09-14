/**
 * Carriageway, gutter, kerb and sidewalk for one chunk of one road.
 *
 * Everything here samples the *same* rung frame, so the asphalt edge, the
 * gutter invert, the kerb face and the back of the pavement are guaranteed to
 * stay welded together through every bend Boston can throw at them.
 */
import type { MeshBuilder, RGBA } from './builder';
import { rgba, srgbLinear } from './builder';
import type { Chunk } from './geom';
import { emitDisc, emitMark } from './geom';
import { type V2, hash01, resample } from './math2';
import type { PreparedRoad } from './network';
import { type Row, type Rung, buildFrame, offsetAt, emitStrip, sampleAt } from './ribbon';
import { TUNE, crownDy, sidewalkPaving } from './spec';

export interface Ribbon {
  road: PreparedRoad;
  rungs: Rung[];
  hw: number;
  kerbed: boolean;
  /** Sidewalk width per side, metres. 0 = none. */
  walk: number;
  len: number;
  seed: number;
  /** Elevation of the gutter invert relative to the crown. */
  gutterDy: number;
  /** Top of the kerb relative to the crown. */
  kerbDy: number;
}

/* ------------------------------------------------------------------- wear */

/** Smooth 1-D value noise in [0,1] — drives patching, grime and paint wear. */
export function wave(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash01(seed + i * 2654435761);
  const b = hash01(seed + (i + 1) * 2654435761);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/**
 * Longitudinal wear along a carriageway: slow patch blotches where the street
 * has been dug up and resurfaced, plus a faster grain. Multiplies albedo.
 */
export function surfaceTint(seed: number, s: number): number {
  const patch = wave(seed, s * 0.055);
  const grain = wave(seed + 811, s * 0.34);
  // Resurfaced patches are noticeably darker and fresher than the old wearing
  // course around them; the rest drifts slowly lighter as it oxidises.
  const resurf = patch > 0.7 ? (patch - 0.7) * 2.1 : 0;
  return (0.9 + patch * 0.26 + (grain - 0.5) * 0.07) * (1 - resurf * 0.22);
}

/* -------------------------------------------------------------- the frame */

export function makeRibbon(chunk: Chunk, road: PreparedRoad, detail: boolean): Ribbon | null {
  const hw = road.halfWidth;
  const kerbed = road.spec.kerb && !road.bridge;
  const walk = kerbed ? road.spec.sidewalk : 0;
  const maxOffset = hw + (kerbed ? TUNE.kerbWidth + walk : 0) + 0.4;

  const rs = resample(
    chunk.pts, chunk.ys,
    detail ? TUNE.maxSegment : TUNE.maxSegment * 1.6,
    detail ? TUNE.curveSegment : TUNE.curveSegment * 1.7,
  );
  const rungs = buildFrame(rs.pts, rs.ys, maxOffset);
  if (rungs.length < 2) return null;

  return {
    road,
    rungs,
    hw,
    kerbed,
    walk,
    len: rungs[rungs.length - 1].s,
    seed: road.seed,
    gutterDy: crownDy(hw, hw, kerbed),
    kerbDy: crownDy(hw, hw, kerbed) + TUNE.kerbHeight,
  };
}

/* -------------------------------------------------------------- surfacing */

/**
 * The running surface. Kerbed streets get the extra gutter break, everything
 * else is a plain crowned three-row ribbon.
 */
export function emitCarriage(out: MeshBuilder, rib: Ribbon, tile: number): void {
  const { hw, kerbed, seed } = rib;
  const base = rgba(0xffffff, 1, 1);
  const edge = rgba(0xffffff, 0.9, 1); // grime collects at the channel
  const rows: Row[] = [];
  const g = Math.min(TUNE.gutterWidth, hw * 0.35);

  rows.push({ a: hw, dy: crownDy(hw, hw, kerbed), c: edge });
  if (kerbed) rows.push({ a: hw - g, dy: crownDy(hw - g, hw, kerbed), c: rgba(0xffffff, 0.95, 1) });
  rows.push({ a: 0, dy: 0, c: base });
  if (kerbed) rows.push({ a: -(hw - g), dy: crownDy(hw - g, hw, kerbed), c: rgba(0xffffff, 0.95, 1) });
  rows.push({ a: -hw, dy: crownDy(hw, hw, kerbed), c: edge });

  emitStrip(out, rib.rungs, rows, {
    uv: 'world',
    tile,
    lift: TUNE.surfaceLift,
    nrm: 'grade',
    tintAt: (r) => surfaceTint(seed, r.s),
  });
}

/**
 * Kerb face, kerb top and the pavement behind it, both sides.
 *
 * The kerb face carries an explicit across-facing normal so it reads as a
 * real 150 mm upstand rather than a shading smear, which is the single thing
 * that makes a street look like a street at eye height.
 */
export function emitKerbWalk(
  kerbOut: MeshBuilder, walkOut: MeshBuilder, rib: Ribbon,
  kerbTile: number, walkTile: number,
): void {
  const { hw, walk, seed } = rib;
  if (!rib.kerbed || walk <= 0) return;
  const kw = TUNE.kerbWidth;
  const gY = rib.gutterDy;
  const kY = rib.kerbDy;
  const walkY = kY + walk * TUNE.walkSlope;
  const kerbC = rgba(0xffffff, 1, 1);
  const walkC = rgba(0xffffff, 1, 1);
  const skirtC = rgba(0xffffff, 0.72, 1);
  const tint = (r: Rung): number => 0.93 + wave(seed + 17, r.s * 0.12) * 0.16;

  for (const side of [1, -1] as const) {
    const s = side;
    // Kerb face. Row order is chosen so the winding faces the carriageway.
    const face: Row[] = s === 1
      ? [{ a: hw * s, dy: kY, c: kerbC }, { a: hw * s, dy: gY, c: rgba(0xffffff, 0.8, 1) }]
      : [{ a: hw * s, dy: gY, c: rgba(0xffffff, 0.8, 1) }, { a: hw * s, dy: kY, c: kerbC }];
    emitStrip(kerbOut, rib.rungs, face, {
      uv: 'local',
      tile: kerbTile,
      lift: TUNE.surfaceLift,
      nrm: s === 1 ? 'right' : 'left',
      tintAt: tint,
    });

    // Kerb top + pavement, ordered descending in `a` so it faces up.
    const top: Row[] = s === 1
      ? [
        { a: (hw + kw + walk) * s, dy: walkY, c: walkC },
        { a: (hw + kw) * s, dy: kY, c: walkC },
        { a: hw * s, dy: kY, c: kerbC },
      ]
      : [
        { a: hw * s, dy: kY, c: kerbC },
        { a: (hw + kw) * s, dy: kY, c: walkC },
        { a: (hw + kw + walk) * s, dy: walkY, c: walkC },
      ];
    // The kerb stone itself belongs to the granite bucket, the flags to the
    // paving bucket, so emit the two spans separately but off one frame.
    emitStrip(kerbOut, rib.rungs, s === 1 ? top.slice(1) : top.slice(0, 2), {
      uv: 'local', tile: kerbTile, lift: TUNE.surfaceLift, nrm: 'grade', tintAt: tint,
    });
    emitStrip(walkOut, rib.rungs, s === 1 ? top.slice(0, 2) : top.slice(1), {
      uv: 'world', tile: walkTile, lift: TUNE.surfaceLift, nrm: 'grade', tintAt: tint,
    });

    // Back-of-walk skirt so the pavement is a slab, not a decal on the grass.
    const skirt: Row[] = s === 1
      ? [
        { a: (hw + kw + walk) * s, dy: walkY - 0.26, c: skirtC },
        { a: (hw + kw + walk) * s, dy: walkY, c: walkC },
      ]
      : [
        { a: (hw + kw + walk) * s, dy: walkY, c: walkC },
        { a: (hw + kw + walk) * s, dy: walkY - 0.26, c: skirtC },
      ];
    emitStrip(walkOut, rib.rungs, skirt, {
      uv: 'local', tile: walkTile, lift: TUNE.surfaceLift, nrm: s === 1 ? 'left' : 'right',
    });
  }
}

/** Which pavement material this chunk of street uses. */
export function walkMaterial(x: number, z: number): 'walk_brick' | 'walk_concrete' {
  return sidewalkPaving(x, z) === 'brick_paver' ? 'walk_brick' : 'walk_concrete';
}

/* ------------------------------------------------------------ micro detail */

/**
 * Street furniture flush with the ground: manhole covers in the wheel path,
 * gully grates in the channel, and tree pits cut into the pavement. Only ever
 * built for the handful of tiles nearest the camera.
 */
export function emitMicroDetail(
  steel: MeshBuilder, soil: MeshBuilder, rib: Ribbon,
  steelTile: number, soilTile: number,
): void {
  const { rungs, hw, seed, len } = rib;
  if (len < 14) return;
  const ironC = rgba(0x3a3733, 1, 1);
  const rimC = rgba(0x2b2926, 1, 1);
  const soilC = rgba(0x2a2118, 1, 1);

  // Manholes and valve covers roughly every 40 m, jittered off the crown.
  const spacing = 38;
  for (let k = 0; ; k++) {
    const s = (0.35 + k) * spacing + hash01(seed + k * 7919) * 16;
    if (s > len - 2) break;
    const h = hash01(seed + k * 104729);
    const sm = sampleAt(rungs, s);
    const across = (h - 0.5) * hw * 1.1;
    const nx = sm.t.z;
    const nz = -sm.t.x;
    const x = sm.p.x + nx * across;
    const z = sm.p.z + nz * across;
    const y = sm.y + crownDy(across, hw, rib.kerbed) + TUNE.surfaceLift + 0.004;
    const r = h > 0.62 ? 0.33 : 0.62; // small valve cover vs full manhole
    emitDisc(steel, x, y, z, r, r > 0.5 ? 16 : 10, ironC, steelTile, h * 3);
    emitDisc(steel, x, y - 0.002, z, r + 0.06, r > 0.5 ? 16 : 10, rimC, steelTile, h * 3);
  }

  if (!rib.kerbed) return;

  // Gully grates sit in the channel, hard against the kerb face.
  for (let k = 0; ; k++) {
    const s = (0.6 + k) * 52 + hash01(seed + k * 15485863) * 20;
    if (s > len - 3) break;
    const side = hash01(seed + k * 31) > 0.5 ? 1 : -1;
    const sm = sampleAt(rungs, s);
    const nx = sm.t.z * side;
    const nz = -sm.t.x * side;
    const off = hw - 0.32;
    const x = sm.p.x + nx * off;
    const z = sm.p.z + nz * off;
    const y = sm.y + crownDy(off, hw, true) + TUNE.surfaceLift + 0.004;
    emitMark(steel, x, z, sm.t, 0.78, 0.44, () => y, ironC, steelTile);
  }

  // Tree pits: a soil square let into the pavement, for Vegetation to fill.
  if (rib.walk < 1.8) return;
  for (let k = 0; ; k++) {
    const s = (0.5 + k) * 17 + hash01(seed + k * 6700417) * 7;
    if (s > len - 2) break;
    if (hash01(seed + k * 2654435761) > 0.55) continue;
    const side = hash01(seed + k * 97) > 0.5 ? 1 : -1;
    const sm = sampleAt(rungs, s);
    const nx = sm.t.z * side;
    const nz = -sm.t.x * side;
    const off = hw + TUNE.kerbWidth + Math.min(rib.walk * 0.45, 0.95);
    const x = sm.p.x + nx * off;
    const z = sm.p.z + nz * off;
    const y = sm.y + rib.kerbDy + TUNE.surfaceLift - 0.03;
    emitMark(soil, x, z, sm.t, 1.25, 1.25, () => y, soilC, soilTile);
  }
}

/* ------------------------------------------------------------------ misc */

/** World position of an across-offset at arc length `s` on this ribbon. */
export function pointOn(rib: Ribbon, s: number, a: number): { p: V2; y: number; t: V2 } {
  const sm = sampleAt(rib.rungs, s);
  const nx = sm.t.z;
  const nz = -sm.t.x;
  return {
    p: { x: sm.p.x + nx * a, z: sm.p.z + nz * a },
    y: sm.y + crownDy(a, rib.hw, rib.kerbed),
    t: sm.t,
  };
}

/** Linear-space grey used for pavement and asphalt vertex tints. */
export function greyRGBA(hex: number, mul: number, alpha: number): RGBA {
  const l = srgbLinear(hex);
  return [l[0] * mul, l[1] * mul, l[2] * mul, alpha];
}

export { offsetAt };
