/**
 * Road markings.
 *
 * Everything is emitted into a single `paint` bucket: an alpha-blended,
 * unlit-albedo material that takes its colour entirely from the vertex stream
 * and its surface detail from the asphalt normal underneath. That is how real
 * thermoplastic behaves — it is a skin a couple of millimetres thick that
 * telegraphs the aggregate below and wears off in the wheel paths.
 *
 * Nothing here is pristine. Every line is modulated along its length by a
 * wear field: faded, patched, and in places scrubbed away entirely.
 */
import type { MeshBuilder, RGBA } from './builder';
import { srgbLinear } from './builder';
import { emitMark, emitQuad } from './geom';
import { type V2, hash01 } from './math2';
import { type Ribbon, wave } from './carriage';
import { type Row, emitStrip, sampleAt } from './ribbon';
import { PAINT, TUNE, crownDy, hasBusLane } from './spec';

/* ------------------------------------------------------------------- wear */

/**
 * Worn paint: alpha falls where traffic has polished it off, and what is left
 * greys out. `heavy` is how much of the line sits in a wheel path.
 */
export function wornPaint(hex: number, seed: number, s: number, heavy = 1): RGBA {
  const slow = wave(seed, s * 0.045);
  const fast = wave(seed + 4013, s * 0.55);
  let a = 0.94 - heavy * (0.34 * (1 - slow) + 0.2 * (1 - fast));
  // Occasional stretch scrubbed right back to the asphalt.
  if (slow < 0.17) a *= 0.12 + slow * 2.4;
  a = Math.max(0.06, Math.min(1, a));

  const lin = srgbLinear(hex);
  const grey = (lin[0] + lin[1] + lin[2]) / 3;
  const fade = 1 - a * 0.55;
  const dim = 0.62 + a * 0.42;
  return [
    (lin[0] + (grey - lin[0]) * fade) * dim,
    (lin[1] + (grey - lin[1]) * fade) * dim,
    (lin[2] + (grey - lin[2]) * fade) * dim,
    a,
  ];
}

/* ------------------------------------------------------------- primitives */

/** A continuous painted line following the ribbon at across-offset `a`. */
function solidLine(
  out: MeshBuilder, rib: Ribbon, a: number, width: number,
  hex: number, tile: number, seedOff: number, heavy = 1,
): void {
  const h = width * 0.5;
  const dy = (off: number): number => crownDy(off, rib.hw, rib.kerbed) + TUNE.paintLift;
  const rows: Row[] = [
    { a: a + h, dy: dy(a + h), c: [1, 1, 1, 1] },
    { a: a - h, dy: dy(a - h), c: [1, 1, 1, 1] },
  ];
  const seed = rib.seed + seedOff;
  emitStrip(out, rib.rungs, rows, {
    uv: 'local',
    tile,
    lift: TUNE.surfaceLift,
    nrm: 'up',
    // The strip carries its wear in its own vertex colours.
    colourAt: (r) => wornPaint(hex, seed, r.s, heavy),
  });
}

/** A broken line: 3.05 m on, 9.15 m off, the US urban standard. */
function brokenLine(
  out: MeshBuilder, rib: Ribbon, a: number, width: number,
  hex: number, tile: number, seedOff: number,
): void {
  const cycle = TUNE.dashOn + TUNE.dashGap;
  const seed = rib.seed + seedOff;
  // Phase the dashes off the road's own seed so neighbouring streets do not
  // march in lockstep.
  const phase = hash01(seed) * cycle;
  for (let s = -phase; s < rib.len; s += cycle) {
    const s0 = Math.max(0, s);
    const s1 = Math.min(rib.len, s + TUNE.dashOn);
    if (s1 - s0 < 0.35) continue;
    // A dash here and there has been scrubbed off completely.
    if (hash01(seed + Math.round(s * 13)) < 0.07) continue;
    dashQuad(out, rib, s0, s1, a, width, wornPaint(hex, seed, s0, 0.7), tile);
  }
}

/** One straight painted rectangle between two arc lengths. */
function dashQuad(
  out: MeshBuilder, rib: Ribbon, s0: number, s1: number,
  a: number, width: number, c: RGBA, tile: number,
): void {
  const h = width * 0.5;
  const m0 = sampleAt(rib.rungs, s0);
  const m1 = sampleAt(rib.rungs, s1);
  const n0: V2 = { x: m0.t.z, z: -m0.t.x };
  const n1: V2 = { x: m1.t.z, z: -m1.t.x };
  const y0 = m0.y + crownDy(a, rib.hw, rib.kerbed) + TUNE.surfaceLift + TUNE.paintLift;
  const y1 = m1.y + crownDy(a, rib.hw, rib.kerbed) + TUNE.surfaceLift + TUNE.paintLift;
  const p0: V2 = { x: m0.p.x + n0.x * (a + h), z: m0.p.z + n0.z * (a + h) };
  const p1: V2 = { x: m1.p.x + n1.x * (a + h), z: m1.p.z + n1.z * (a + h) };
  const p2: V2 = { x: m1.p.x + n1.x * (a - h), z: m1.p.z + n1.z * (a - h) };
  const p3: V2 = { x: m0.p.x + n0.x * (a - h), z: m0.p.z + n0.z * (a - h) };
  emitQuad(out, p0, p1, p2, p3, y0, y1, y1, y0, c, tile);
}

/* ---------------------------------------------------------------- layouts */

/**
 * Full marking layout for a ribbon: wheel polish, edge lines, lane dividers
 * and the centre line, honouring `oneway` and `lanes`.
 */
export function emitMarkings(
  out: MeshBuilder,
  rib: Ribbon,
  tile: number,
  conflictAt?: ConflictProbe,
): void {
  const road = rib.road;
  const hw = rib.hw;
  const lanes = road.lanes;
  const oneway = road.oneway;
  const cls = road.cls;

  if (cls === 'cycleway') {
    emitBikeLane(out, rib, tile, conflictAt);
    return;
  }
  if (!road.spec.markings || hw < 2.2) return;

  // --- wheel polish: emitted first so paint blends on top of it -----------
  emitWheelPolish(out, rib, tile);

  const usable = hw - 0.28;
  const edgeHex = PAINT.white;

  if (oneway) {
    // One-way: lane lines spaced evenly, white edges both sides. On a
    // motorway the left-hand edge is yellow, as on every US divided road.
    const leftHex = cls === 'motorway' || cls === 'trunk' ? PAINT.yellow : PAINT.white;
    solidLine(out, rib, usable, TUNE.edgeLineWidth, leftHex, tile, 3, 0.35);
    solidLine(out, rib, -usable, TUNE.edgeLineWidth, edgeHex, tile, 5, 0.35);
    const step = (usable * 2) / lanes;
    for (let k = 1; k < lanes; k++) {
      brokenLine(out, rib, usable - k * step, TUNE.laneLineWidth, PAINT.white, tile, 11 + k * 7);
    }
  } else {
    // Two-way: a centre line plus per-direction lane lines.
    const nLeft = Math.max(1, Math.ceil(lanes / 2));
    const nRight = Math.max(1, lanes - nLeft);
    const doubled = cls === 'primary' || cls === 'secondary' || cls === 'trunk' ||
      cls === 'motorway' || lanes >= 4;

    if (doubled) {
      solidLine(out, rib, 0.09, TUNE.laneLineWidth, PAINT.yellow, tile, 2, 0.5);
      solidLine(out, rib, -0.09, TUNE.laneLineWidth, PAINT.yellow, tile, 4, 0.5);
    } else {
      brokenLine(out, rib, 0, 0.11, PAINT.yellow, tile, 6);
    }

    if (hw > 4.2) {
      solidLine(out, rib, usable, TUNE.edgeLineWidth, edgeHex, tile, 8, 0.3);
      solidLine(out, rib, -usable, TUNE.edgeLineWidth, edgeHex, tile, 9, 0.3);
    }
    const stepL = (usable - 0.2) / nLeft;
    for (let k = 1; k < nLeft; k++) {
      brokenLine(out, rib, 0.2 + k * stepL, TUNE.laneLineWidth, PAINT.white, tile, 21 + k * 13);
    }
    const stepR = (usable - 0.2) / nRight;
    for (let k = 1; k < nRight; k++) {
      brokenLine(out, rib, -(0.2 + k * stepR), TUNE.laneLineWidth, PAINT.white, tile, 41 + k * 13);
    }
  }

  if (hasBusLane(road.name, cls) && hw > 4.5) {
    emitBusLane(out, rib, tile, -1);
    if (!oneway) emitBusLane(out, rib, tile, 1);
  }
}

/**
 * Polished wheel paths. Two darker bands per lane where tyres have burnished
 * the aggregate — the strongest single cue that a road has been driven on.
 */
function emitWheelPolish(out: MeshBuilder, rib: Ribbon, tile: number): void {
  const hw = rib.hw;
  const lanes = Math.max(1, rib.road.lanes);
  const laneW = Math.min(4.3, Math.max(2.6, (hw * 2) / lanes));
  const c: RGBA = (() => {
    const l = srgbLinear(PAINT.wheel);
    return [l[0], l[1], l[2], 0.3];
  })();
  for (let k = 0; k < lanes; k++) {
    const centre = hw - (k + 0.5) * laneW;
    if (Math.abs(centre) > hw - 0.6) continue;
    for (const off of [-0.82, 0.82]) {
      const a = centre + off;
      if (Math.abs(a) > hw - 0.45) continue;
      const h = 0.42;
      const dy = (o: number): number => crownDy(o, hw, rib.kerbed) + TUNE.paintLift * 0.4;
      emitStrip(out, rib.rungs, [
        { a: a + h, dy: dy(a + h), c: [c[0], c[1], c[2], 0] },
        { a: a + h * 0.45, dy: dy(a + h * 0.45), c },
        { a: a - h * 0.45, dy: dy(a - h * 0.45), c },
        { a: a - h, dy: dy(a - h), c: [c[0], c[1], c[2], 0] },
      ], { uv: 'local', tile, lift: TUNE.surfaceLift, nrm: 'up' });
    }
  }
}

/**
 * How strongly a world point sits in a traffic conflict: 1 in the middle of a
 * junction, easing to 0 a few metres clear of it.
 */
export type ConflictProbe = (x: number, z: number) => number;

/**
 * A cycle track: white edge lines along its length, green paint only where it
 * needs it.
 *
 * Boston does not paint its cycle lanes green end to end. The green marks a
 * *conflict zone* — where the lane crosses a junction and a driver turning
 * across it has to look for a bike. Painting the whole length put a continuous
 * emerald ribbon down the Esplanade, bright enough to pick out from the air,
 * which is not a thing the Esplanade has.
 *
 * The obvious signal for this is the way's own `trimStart`/`trimEnd`, which say
 * that an end was cut back for a junction fill. It does not work: the network
 * builder excludes cycleways from the junction graph entirely, so a cycle
 * track's trims are always zero and keying the paint off them removes it from
 * the whole city. The junction *positions* are the real signal, and they have
 * to be handed in from the module that owns them.
 *
 * With no probe supplied, an unpainted track is the safer failure: a bike lane
 * with white edge lines and no green is a normal Boston bike lane, and a green
 * one where the paint does not belong is the thing being fixed.
 */
function emitBikeLane(
  out: MeshBuilder,
  rib: Ribbon,
  tile: number,
  conflictAt?: ConflictProbe,
): void {
  const hw = rib.hw;

  if (conflictAt) {
    const l = srgbLinear(PAINT.green);
    const seed = rib.seed + 77;
    const any = rib.rungs.some((g) => conflictAt(g.p.x, g.p.z) > 0.004);

    if (any) {
      emitStrip(out, rib.rungs, [
        { a: hw - 0.1, dy: crownDy(hw - 0.1, hw, rib.kerbed) + TUNE.paintLift, c: [1, 1, 1, 1] },
        { a: -(hw - 0.1), dy: crownDy(hw - 0.1, hw, rib.kerbed) + TUNE.paintLift, c: [1, 1, 1, 1] },
      ], {
        uv: 'local',
        tile,
        lift: TUNE.surfaceLift,
        nrm: 'up',
        colourAt: (r) => {
          // Green paint weathers hard and patchily, and fastest exactly where it
          // matters, under the traffic turning across it.
          const g = conflictAt(r.p.x, r.p.z);
          if (g <= 0.004) return [0, 0, 0, 0];
          const w = g * (0.52 + wave(seed, r.s * 0.09) * 0.40);
          return [l[0] * (0.7 + w * 0.5), l[1] * (0.7 + w * 0.5), l[2] * (0.7 + w * 0.5), w];
        },
      });
    }
  }

  if (hw > 0.9) {
    solidLine(out, rib, hw - 0.06, 0.1, PAINT.white, tile, 3, 0.2);
    solidLine(out, rib, -(hw - 0.06), 0.1, PAINT.white, tile, 4, 0.2);
  }
}

/** Red bus lane along the kerbside running lane. */
function emitBusLane(out: MeshBuilder, rib: Ribbon, tile: number, side: 1 | -1): void {
  const hw = rib.hw;
  const laneW = Math.min(3.9, hw * 0.42);
  const l = srgbLinear(PAINT.red);
  const seed = rib.seed + 913 + side * 37;
  // Kerbside running lane: hard against the channel on the given side.
  const outer = side * (hw - 0.22);
  const inner = outer - side * laneW;
  const hi = Math.max(inner, outer);
  const lo = Math.min(inner, outer);
  const rows: Row[] = [
    { a: hi, dy: crownDy(hi, hw, rib.kerbed) + TUNE.paintLift * 0.8, c: [1, 1, 1, 1] },
    { a: lo, dy: crownDy(lo, hw, rib.kerbed) + TUNE.paintLift * 0.8, c: [1, 1, 1, 1] },
  ];
  emitStrip(out, rib.rungs, rows, {
    uv: 'local',
    tile,
    lift: TUNE.surfaceLift,
    nrm: 'up',
    colourAt: (r) => {
      const w = 0.3 + wave(seed, r.s * 0.07) * 0.42;
      return [l[0] * (0.75 + w * 0.4), l[1] * (0.75 + w * 0.4), l[2] * (0.75 + w * 0.4), w];
    },
  });
}

/* ------------------------------------------------------- junction markings */

/** Direction of a lane arrow. */
export type ArrowKind = 'through' | 'left' | 'right';

/**
 * A MUTCD lane-use arrow, drawn in (along, across) local metres and
 * transformed onto the carriageway. `dir` points in the direction of travel.
 */
export function emitArrow(
  out: MeshBuilder, cx: number, cz: number, y: number, dir: V2,
  kind: ArrowKind, scale: number, colour: RGBA, tile: number,
): void {
  const d = dir;
  const n: V2 = { x: d.z, z: -d.x };
  const inv = 1 / Math.max(tile, 0.001);

  /** Emits one convex sub-polygon, fixing its winding so it faces up. */
  const put = (poly: Array<[number, number]>): void => {
    if (poly.length < 3) return;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    // Our up-facing convention is clockwise in (along, across).
    const ordered = area > 0 ? poly.slice().reverse() : poly;
    const idx: number[] = [];
    for (const [l, a] of ordered) {
      const x = cx + d.x * l * scale + n.x * a * scale;
      const z = cz + d.z * l * scale + n.z * a * scale;
      idx.push(out.vertN(x, y, z, 0, 1, 0, x * inv, z * inv, colour));
    }
    for (let i = 1; i < idx.length - 1; i++) out.tri(idx[0], idx[i], idx[i + 1]);
  };

  // Shaft is common to every arrow; turn arrows stop short of the head.
  const stem = kind === 'through' ? 0.35 : 0.15;
  put([[-1.9, 0.17], [stem, 0.17], [stem, -0.17], [-1.9, -0.17]]);

  if (kind === 'through') {
    put([[0.35, 0.62], [1.55, 0], [0.35, -0.62]]);
    return;
  }

  const g = kind === 'left' ? 1 : -1;
  put([[-0.02, 0.95 * g], [0.32, 0.95 * g], [0.32, 0.17 * g], [-0.02, 0.17 * g]]);
  put([[0.15, 1.74 * g], [0.7, 0.9 * g], [-0.4, 0.9 * g]]);
}

/** Colour for a junction mark, worn by the junction's own seed. */
export function junctionPaint(hex: number, seed: number, k: number): RGBA {
  return wornPaint(hex, seed, k * 6.3, 1.15);
}

export { emitMark };
