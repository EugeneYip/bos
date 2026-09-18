/**
 * Junctions.
 *
 * Every approach ribbon has already been trimmed back to the junction
 * boundary by `network.ts`, so the intersection is a single filled polygon
 * rather than four overlapping ribbons fighting for the same depth values.
 * This file fills that polygon, wraps a rounded kerb return with a dropped
 * ramp around each corner, and lays the crossing markings — which belong to
 * the junction, never to the ribbon.
 */
import type { MeshBuilder, RGBA } from './builder';
import { rgba } from './builder';
import { emitPolygon, emitQuad } from './geom';
import { type V2, hash01 } from './math2';
import { type Approach, type Junction, junctionGeom } from './network';
import { emitArrow, wornPaint } from './paint';
import { surfaceTint } from './carriage';
import { type Row, emitStrip, frameFromEdge } from './ribbon';
import { PAINT, TUNE, crownDy } from './spec';

const LIFT = TUNE.surfaceLift + TUNE.junctionLift;

/* --------------------------------------------------------------- the fill */

/** The asphalt apron. One polygon, one material, no overlaps. */
export function emitJunctionFill(out: MeshBuilder, j: Junction, tile: number): void {
  const { ring, ringY, ringDy } = junctionGeom(j);
  const ys = new Array<number>(ring.length);
  for (let i = 0; i < ring.length; i++) ys[i] = (ringY[i] ?? 0) + (ringDy[i] ?? 0);
  // Junctions are the most worked-over asphalt in the city: patched, sealed
  // and polished by turning traffic.
  emitPolygon(out, ring, ys, tile, rgba(0xffffff, surfaceTint(j.seed, 0) * 0.95, 1), LIFT);
}

/* ------------------------------------------------------------ kerb returns */

/**
 * Rounded kerb and pavement around one corner, with a dropped kerb ramp at
 * its midpoint. The kerb line is the same Bezier the fill boundary used, so
 * the asphalt cannot peek out from behind the kerb.
 */
export function emitKerbReturns(
  kerbOut: MeshBuilder, walkOut: MeshBuilder, j: Junction,
  kerbTile: number, walkTile: number,
): void {
  const kh = TUNE.kerbHeight;
  const kw = TUNE.kerbWidth;
  const kerbC = rgba(0xffffff, 1, 1);
  const walkC = rgba(0xffffff, 1, 1);

  for (const corner of junctionGeom(j).corners) {
    if (!corner.kerbed || corner.pts.length < 2) continue;
    const rungs = frameFromEdge(corner.pts, corner.ys, corner.normals);
    if (rungs.length < 2) continue;
    const arcLen = rungs[rungs.length - 1].s;
    if (arcLen < 0.6) continue;

    // Dropped kerb across the middle of the return, as at every crossing.
    const mid = arcLen * 0.5;
    const half = Math.min(TUNE.rampWidth * 0.5, arcLen * 0.38);
    const ramp = (s: number): number => {
      const f = Math.max(0, 1 - Math.abs(s - mid) / Math.max(half, 0.01));
      return f * f * (3 - 2 * f);
    };
    const drop = kh - 0.018;
    const hasRamp = arcLen > 2.2 && corner.walk > 1.2;

    const faceRows: Row[] = [
      { a: 0, dy: kh, c: kerbC },
      { a: 0, dy: 0, c: rgba(0xffffff, 0.78, 1) },
    ];
    emitStrip(kerbOut, rungs, faceRows, {
      uv: 'local',
      tile: kerbTile,
      lift: LIFT,
      nrm: 'right',
      dyAt: hasRamp ? (r, row) => (row === 0 ? -ramp(r.s) * drop : 0) : undefined,
    });

    const walk = corner.walk;
    const topRows: Row[] = walk > 0.4
      ? [
        { a: kw + walk, dy: kh + walk * TUNE.walkSlope, c: walkC },
        { a: kw, dy: kh, c: walkC },
        { a: 0, dy: kh, c: kerbC },
      ]
      : [
        { a: kw, dy: kh, c: kerbC },
        { a: 0, dy: kh, c: kerbC },
      ];

    const dyRamp = hasRamp
      ? (r: { s: number }, row: number): number => {
        const f = ramp(r.s);
        // The kerb and its backing flag drop together; the back of the
        // pavement only dips part way, which is what forms the ramp.
        return -f * drop * (walk > 0.4 && row === 0 ? 0.42 : 1);
      }
      : undefined;

    if (walk > 0.4) {
      emitStrip(kerbOut, rungs, topRows.slice(1), {
        uv: 'local', tile: kerbTile, lift: LIFT, nrm: 'grade',
        dyAt: dyRamp ? (r, row) => dyRamp(r, row + 1) : undefined,
      });
      emitStrip(walkOut, rungs, topRows.slice(0, 2), {
        uv: 'world',
        tile: walkTile,
        lift: LIFT,
        nrm: 'grade',
        dyAt: dyRamp,
        // Kerb ramps are poured separately and read as a paler patch.
        tintAt: hasRamp ? (r) => 1 + ramp(r.s) * 0.22 : undefined,
      });
    } else {
      emitStrip(kerbOut, rungs, topRows, {
        uv: 'local', tile: kerbTile, lift: LIFT, nrm: 'grade', dyAt: dyRamp,
      });
    }
  }
}

/* ------------------------------------------------------------- crossings */

interface Frame {
  /** Unit direction out of the junction along the approach. */
  d: V2;
  /** Unit left normal of `d`. */
  n: V2;
  hw: number;
  y: number;
  kerbed: boolean;
}

const frameOf = (a: Approach): Frame => ({
  d: a.dir,
  n: { x: a.dir.z, z: -a.dir.x },
  hw: a.halfWidth,
  y: a.y,
  kerbed: a.road.spec.kerb,
});

/** World point `along` metres out from the node and `across` metres sideways. */
function at(j: Junction, f: Frame, along: number, across: number): V2 {
  return {
    x: j.p.x + f.d.x * along + f.n.x * across,
    z: j.p.z + f.d.z * along + f.n.z * across,
  };
}

const yAt = (f: Frame, across: number): number =>
  f.y + crownDy(across, f.hw, f.kerbed) + LIFT + TUNE.paintLift;

/**
 * Crossings, stop bars and lane-use arrows for every approach.
 *
 * Boston uses both continental (thick bars parallel to traffic) and ladder
 * crossings; which one a junction gets is stable per node.
 */
export function emitCrossings(out: MeshBuilder, j: Junction, tile: number): void {
  if (j.layer !== 0) return;
  const apps = j.approaches;
  if (apps.length < 3) return;

  const continental = hash01(j.seed) < 0.68;

  for (let i = 0; i < apps.length; i++) {
    const a = apps[i];
    const road = a.road;
    if (road.cls === 'motorway' || road.cls === 'trunk') continue;
    if (road.cls === 'footway' || road.cls === 'cycleway' || road.cls === 'service') continue;
    const f = frameOf(a);
    if (f.hw < 2.2) continue;

    const marked = road.spec.markings || road.cls === 'residential';
    if (!marked) continue;

    // --- crossing, just inside the junction boundary ---------------------
    const depth = Math.min(TUNE.crosswalkDepth, Math.max(1.6, a.trim - 1.1));
    if (a.trim >= 3.9 && depth >= 1.6) {
      const outer = a.trim - 0.35;
      const inner = outer - depth;
      const span = f.hw - 0.28;
      const seed = j.seed + i * 7717;
      if (continental) {
        const step = TUNE.zebraBar + TUNE.zebraGap;
        const n = Math.max(2, Math.floor((span * 2) / step));
        const start = -span + ((span * 2) - (n - 1) * step - TUNE.zebraBar) * 0.5;
        for (let k = 0; k < n; k++) {
          const t0 = start + k * step;
          const t1 = t0 + TUNE.zebraBar;
          const c = wornPaint(PAINT.white, seed, k * 3.1, 1.25);
          if (c[3] < 0.09) continue;
          emitQuad(
            out,
            at(j, f, inner, t1), at(j, f, outer, t1),
            at(j, f, outer, t0), at(j, f, inner, t0),
            yAt(f, t1), yAt(f, t1), yAt(f, t0), yAt(f, t0),
            c, tile,
          );
        }
      } else {
        // Ladder: two transverse rails plus rungs between them.
        for (const [e0, e1] of [[inner, inner + 0.17], [outer - 0.17, outer]]) {
          const c = wornPaint(PAINT.white, seed, e0 * 2.3, 1.1);
          emitQuad(
            out,
            at(j, f, e0, span), at(j, f, e1, span),
            at(j, f, e1, -span), at(j, f, e0, -span),
            yAt(f, span), yAt(f, span), yAt(f, -span), yAt(f, -span),
            c, tile,
          );
        }
        const step = 0.92;
        const n = Math.max(2, Math.floor((span * 2) / step));
        for (let k = 1; k < n; k++) {
          const t0 = -span + k * step - 0.07;
          const t1 = t0 + 0.14;
          const c = wornPaint(PAINT.white, seed + 31, k * 2.7, 1.3);
          if (c[3] < 0.09) continue;
          emitQuad(
            out,
            at(j, f, inner + 0.17, t1), at(j, f, outer - 0.17, t1),
            at(j, f, outer - 0.17, t0), at(j, f, inner + 0.17, t0),
            yAt(f, t1), yAt(f, t1), yAt(f, t0), yAt(f, t0),
            c, tile,
          );
        }
      }
    }

    // --- stop bar, just outside the boundary on the approaching side -----
    const oneway = road.oneway;
    const approaching = !oneway || a.end === 1;
    if (!approaching || a.trim < 2.4) continue;
    const barOuter = a.trim + 0.62;
    const barInner = barOuter - TUNE.stopBarDepth;
    const tLo = oneway ? -f.hw + 0.22 : 0.14;
    const tHi = f.hw - 0.22;
    if (tHi - tLo > 1.2) {
      const c = wornPaint(PAINT.white, j.seed + i * 131, 11, 1.35);
      if (c[3] > 0.09) {
        emitQuad(
          out,
          at(j, f, barInner, tHi), at(j, f, barOuter, tHi),
          at(j, f, barOuter, tLo), at(j, f, barInner, tLo),
          yAt(f, tHi), yAt(f, tHi), yAt(f, tLo), yAt(f, tLo),
          c, tile,
        );
      }
    }

    // --- lane-use arrows behind the stop bar -----------------------------
    if (!road.spec.markings) continue;
    const usable = road.length - road.trimStart - road.trimEnd;
    if (usable < 16 || f.hw < 3.2) continue;
    const nLanes = Math.max(1, oneway ? road.lanes : Math.ceil(road.lanes / 2));
    if (nLanes < 1) continue;
    const laneSpan = (tHi - tLo) / nLanes;
    if (laneSpan < 2.2) continue;

    const back = [barOuter + 4.6, barOuter + 14.5];
    for (let s = 0; s < back.length; s++) {
      if (back[s] - a.trim > usable - 3) break;
      for (let k = 0; k < nLanes; k++) {
        const t = tLo + (k + 0.5) * laneSpan;
        const kind = nLanes === 1
          ? 'through'
          : k === 0 ? 'left' : k === nLanes - 1 ? 'right' : 'through';
        const p = at(j, f, back[s], t);
        const c = wornPaint(PAINT.white, j.seed + i * 97 + k * 13, back[s], 1.5);
        if (c[3] < 0.1) continue;
        // Arrows point at the junction, i.e. against the approach direction.
        emitArrow(
          out, p.x, p.z, yAt(f, t), { x: -f.d.x, z: -f.d.z },
          kind as 'through' | 'left' | 'right', 1.18, c, tile,
        );
      }
    }
  }
}

/** Linear-space colour helper shared with the tile builder. */
export function fillColour(seed: number): RGBA {
  return rgba(0xffffff, surfaceTint(seed, 0), 1);
}
