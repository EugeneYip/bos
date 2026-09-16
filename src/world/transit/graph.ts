/**
 * Directed track graph for one MBTA system, built the same way `Traffic`
 * builds its lane graph: split every way into one edge per direction of
 * travel and weld shared endpoints into nodes.
 *
 * Rail differs from the street network in the one way that matters here: a
 * train can never leave the physical alignment it is riding, so there is no
 * random lane change. There is *usually* no synthetic lateral offset either,
 * because Boston's surface trackage is almost always digitised as two
 * separate ways, one per physical rail, a few metres apart — real double
 * track, already exactly where it belongs. `pairDoubleTrack` finds those
 * pairs and keeps each way's own single digitised direction rather than also
 * inventing a reverse edge that would send a train back down the *other*
 * direction's rail: that synthetic reverse is what used to let an inbound
 * and an outbound car occupy the same physical way at once and pass through
 * each other, since nothing distinguished "this rail's own direction" from
 * "the direction the twin rail already covers, a few metres over."
 *
 * A minority of ways have no such twin — short stubs, crossovers, genuine
 * single-track runs. Those still carry both directions on one polyline, as
 * they always have, but now with a small lateral offset (`SOLO_HALF_SEP`) so
 * two opposing cars pass beside each other instead of through.
 *
 * Either way, every way still becomes at least one edge, which makes a
 * tunnel portal or the buffer at the end of a branch a natural terminus:
 * once there is no further edge to take, a train simply picks a fresh one
 * elsewhere instead of needing a special "end of line" case.
 */
import type { RoadRecord } from '../../core/types';
import { classifyRail, type SystemId } from './lines';

/** Endpoint snap, metres. A little looser than the road graph's 0.5 m: rail
 *  endpoints come from the same OSM nodes but the two rails of a real double
 *  track are separate ways tens of metres apart, and snapping must not
 *  bridge that gap — only weld ways that share an actual node. */
const SNAP = 1.0;

/** Height of the top of the running rail above the stored ground elevation.
 *  `structures.ts` lifts the rail head by `surfaceLift` (5.5 cm) less a
 *  hair for the head profile; trains ride a touch above that. */
export const RAIL_LIFT = 0.09;

export interface RailEdge {
  /** Flat [x,y,z, ...] along the direction of travel, world metres. */
  pts: Float32Array;
  /** Cumulative distance at each point; last entry is the total length. */
  cum: Float32Array;
  length: number;
  /** Node index at the far end. */
  to: number;
  /** Unit heading at the very start and end, for junction continuity scoring. */
  sx: number; sz: number;
  ex: number; ez: number;
}

export interface RailGraph {
  system: SystemId;
  edges: RailEdge[];
  /** Outgoing edge indices per node. */
  out: number[][];
  /** Node positions, [x,y,z,...]. */
  nodes: Float32Array;
  totalKm: number;
}

const key = (x: number, z: number): number =>
  (Math.round(x / SNAP) & 0x3fffff) * 4194304 + (Math.round(z / SNAP) & 0x3fffff);

/** One way's forward polyline (world metres, y already lifted to rail-head
 *  height), kept around only long enough to look for a double-track twin
 *  before edges are built from it. */
interface Way { fwd: Float32Array; n: number }

/** Total endpoint-to-endpoint metres (both ends combined) beyond which two
 *  ways are not considered a double-track pair. Real double-track centres
 *  run 3.8-4.0 m apart; every genuine pair found while building this fix
 *  matched well inside 15 m even accounting for the extraction's own
 *  simplification noise, while unrelated nearby ways (a crossing branch, a
 *  yard lead) were tens to thousands of metres off. */
const PAIR_MAX_DIST = 15;

/**
 * Finds, for each way, whether another way in the same system is its
 * double-track twin: a separately-digitised parallel rail carrying the
 * opposite direction a few metres over. OSM maps Boston's surface trackage
 * this way far more often than not, and does so with the two ways' start
 * and end points swapped — the two rails of a double track are drawn in
 * roughly opposite senses, not the same sense — so a genuine pair is
 * unambiguous: comparable length, chords pointing roughly opposite ways, and
 * small average perpendicular distance from one way's own vertices to the
 * other's polyline. Requiring the match to be mutual (each picks the other
 * as its own closest candidate) keeps a short stub near a busy junction from
 * being claimed as the "twin" of more than one nearby way.
 */
function pairDoubleTrack(ways: Way[]): boolean[] {
  const count = ways.length;
  const hasTwin: boolean[] = new Array(count).fill(false);
  if (count < 2) return hasTwin;

  const chordX = new Float64Array(count);
  const chordZ = new Float64Array(count);
  const chordLen = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const { fwd, n } = ways[i];
    const dx = fwd[(n - 1) * 3] - fwd[0];
    const dz = fwd[(n - 1) * 3 + 2] - fwd[2];
    chordX[i] = dx; chordZ[i] = dz;
    chordLen[i] = Math.max(Math.hypot(dx, dz), 1e-3);
  }

  const bestPartner = new Int32Array(count).fill(-1);
  const bestDist = new Float64Array(count).fill(Infinity);

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      const lj = chordLen[j];
      if (lj < chordLen[i] * 0.5 || lj > chordLen[i] * 2 + 20) continue; // comparable length only
      const dot = (chordX[i] * chordX[j] + chordZ[i] * chordZ[j]) / (chordLen[i] * lj);
      if (dot >= 0) continue; // twins are digitised in roughly opposite senses
      const d = avgOffsetTo(ways[i], ways[j]);
      if (d < bestDist[i]) { bestDist[i] = d; bestPartner[i] = j; }
    }
  }

  for (let i = 0; i < count; i++) {
    const j = bestPartner[i];
    if (j < 0 || bestDist[i] > PAIR_MAX_DIST) continue;
    if (bestPartner[j] === i) hasTwin[i] = true;
  }
  return hasTwin;
}

/** Average distance from a sample of `w`'s own vertices to `other`'s polyline. */
function avgOffsetTo(w: Way, other: Way): number {
  const SAMPLES = 8;
  const step = Math.max(1, Math.floor(w.n / SAMPLES));
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < w.n; i += step) {
    sum += distToPolyline(w.fwd[i * 3], w.fwd[i * 3 + 2], other.fwd, other.n);
    cnt++;
  }
  return cnt ? sum / cnt : Infinity;
}

/** Shortest distance from a point to a polyline (XZ only). */
function distToPolyline(px: number, pz: number, poly: Float32Array, n: number): number {
  let best = Infinity;
  for (let i = 1; i < n; i++) {
    const ax = poly[(i - 1) * 3];
    const az = poly[(i - 1) * 3 + 2];
    const bx = poly[i * 3];
    const bz = poly[i * 3 + 2];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < best) best = d;
  }
  return best;
}

/** Half the synthetic separation applied when a way has no double-track twin
 *  and must therefore carry both directions on one digitised centreline.
 *  Deliberately less than a real double track's own 1.9-2.0 m
 *  half-separation: `Roads.ts` draws every rail way's ballast bed at 4.6 m
 *  wide (2.3 m each side of centre) regardless of whether it turns out to
 *  have a twin, and that width was only ever meant to hold the one track
 *  this way represents. A full double-track offset would hang the widest
 *  stock (the 3.05 m commuter equipment, 1.525 m half-width) off the edge of
 *  its own ballast and onto whatever sits beside it — 0.75 m keeps even that
 *  car's outer edge (2.275 m from centre) inside the 2.3 m bed, while still
 *  breaking the exact centreline coincidence that reads as one car ghosting
 *  through another. */
const SOLO_HALF_SEP = 0.75;

/** Metres over which a solo way's offset ramps up from zero at each end, so
 *  the edge still lands exactly on the shared node at a junction instead of
 *  jumping sideways the instant it meets a neighbouring, unoffset way. */
const SOLO_TAPER = 6;

/**
 * Copy of `pts` offset to the right of its own direction of travel — the
 * same `(-hz, hx)` convention `Traffic` uses for its lane offset — tapering
 * to zero at both ends so the welded node position is unchanged. Used only
 * for a way with no double-track twin; a paired way rides its own digitised
 * centreline untouched.
 */
function offsetSoloToRight(pts: Float32Array, n: number): Float32Array {
  const cum = new Float32Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 3] - pts[(i - 1) * 3];
    const dz = pts[i * 3 + 2] - pts[(i - 1) * 3 + 2];
    total += Math.hypot(dx, dz);
    cum[i] = total;
  }
  const taper = Math.min(SOLO_TAPER, total / 2.2);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let tx = 0;
    let tz = 0;
    if (i > 0) { tx += pts[i * 3] - pts[(i - 1) * 3]; tz += pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]; }
    if (i < n - 1) { tx += pts[(i + 1) * 3] - pts[i * 3]; tz += pts[(i + 1) * 3 + 2] - pts[i * 3 + 2]; }
    const inv = 1 / Math.max(Math.hypot(tx, tz), 1e-4);
    tx *= inv; tz *= inv;
    const distFromEnd = Math.min(cum[i], total - cum[i]);
    const t = taper > 1e-3 ? Math.min(1, distFromEnd / taper) : 1;
    const ease = t * t * (3 - 2 * t); // smoothstep
    out[i * 3] = pts[i * 3] + (-tz) * SOLO_HALF_SEP * ease;
    out[i * 3 + 1] = pts[i * 3 + 1];
    out[i * 3 + 2] = pts[i * 3 + 2] + tx * SOLO_HALF_SEP * ease;
  }
  return out;
}

/** Builds the graph for one system from every non-tunnel way classified into it. */
export function buildRailGraph(records: RoadRecord[], system: SystemId): RailGraph {
  const nodeIds = new Map<number, number>();
  const nodeXYZ: number[] = [];
  const edges: RailEdge[] = [];
  const outLists: number[][] = [];

  const nodeAt = (x: number, y: number, z: number): number => {
    const k = key(x, z);
    const hit = nodeIds.get(k);
    if (hit !== undefined) return hit;
    const id = outLists.length;
    nodeIds.set(k, id);
    nodeXYZ.push(x, y, z);
    outLists.push([]);
    return id;
  };

  const addEdge = (pts: Float32Array, from: number, to: number): void => {
    const n = pts.length / 3;
    if (n < 2) return;
    const cum = new Float32Array(n);
    let len = 0;
    for (let i = 1; i < n; i++) {
      const dx = pts[i * 3] - pts[(i - 1) * 3];
      const dy = pts[i * 3 + 1] - pts[(i - 1) * 3 + 1];
      const dz = pts[i * 3 + 2] - pts[(i - 1) * 3 + 2];
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cum[i] = len;
    }
    if (len < 2) return; // too short to be worth riding
    const sx = pts[3] - pts[0];
    const sz = pts[5] - pts[2];
    const si = 1 / Math.max(Math.hypot(sx, sz), 1e-4);
    const m = n - 1;
    const ex = pts[m * 3] - pts[(m - 1) * 3];
    const ez = pts[m * 3 + 2] - pts[(m - 1) * 3 + 2];
    const ei = 1 / Math.max(Math.hypot(ex, ez), 1e-4);
    outLists[from].push(edges.length);
    edges.push({ pts, cum, length: len, to, sx: sx * si, sz: sz * si, ex: ex * ei, ez: ez * ei });
  };

  // First pass: gather this system's ways (skipping tunnels — underground,
  // nothing to see and nowhere a train should be drawn) and weld their
  // endpoints into nodes, before deciding which ones need a synthetic
  // reverse edge at all.
  const ways: Way[] = [];
  const nodeA: number[] = [];
  const nodeB: number[] = [];
  for (const r of records) {
    if (r.tunnel) continue;
    if (classifyRail(r.name) !== system) continue;
    const n = r.path.length / 2;
    if (n < 2) continue;

    const fwd = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      fwd[i * 3] = r.path[i * 2];
      fwd[i * 3 + 1] = (r.elevation[i] ?? 0) + RAIL_LIFT;
      fwd[i * 3 + 2] = r.path[i * 2 + 1];
    }
    const a = nodeAt(fwd[0], fwd[1], fwd[2]);
    const b = nodeAt(fwd[(n - 1) * 3], fwd[(n - 1) * 3 + 1], fwd[(n - 1) * 3 + 2]);
    if (a === b) continue; // closed loop, no useful direction

    ways.push({ fwd, n });
    nodeA.push(a);
    nodeB.push(b);
  }

  const hasTwin = pairDoubleTrack(ways);

  let totalKm = 0;
  for (let wi = 0; wi < ways.length; wi++) {
    const { fwd, n } = ways[wi];
    const a = nodeA[wi];
    const b = nodeB[wi];

    if (hasTwin[wi]) {
      // The opposite direction already exists as the twin way's own forward
      // edge, on its own physically separate rail a few metres over — a
      // synthetic reverse here would instead ride back down *this* rail,
      // which is exactly how two opposite-direction cars used to end up on
      // the same centreline.
      addEdge(fwd, a, b);
      continue;
    }

    // No twin: this one polyline has to carry both directions, so offset
    // each direction to its own right, same as `Traffic`'s lane offset.
    addEdge(offsetSoloToRight(fwd, n), a, b);
    const rev = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rev[i * 3] = fwd[(n - 1 - i) * 3];
      rev[i * 3 + 1] = fwd[(n - 1 - i) * 3 + 1];
      rev[i * 3 + 2] = fwd[(n - 1 - i) * 3 + 2];
    }
    addEdge(offsetSoloToRight(rev, n), b, a);
  }

  for (const e of edges) totalKm += e.length;
  return {
    system,
    edges,
    out: outLists,
    nodes: Float32Array.from(nodeXYZ),
    totalKm: totalKm / 1000,
  };
}

export interface EdgeSample {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
}

/** Position and heading a distance `s` along an edge; see `traffic/graph.ts`'s twin. */
export function sampleEdge(e: RailEdge, s: number, out: EdgeSample): void {
  const cum = e.cum;
  const n = cum.length;
  let i = 1;
  while (i < n - 1 && cum[i] < s) i++;
  const s0 = cum[i - 1];
  const seg = Math.max(cum[i] - s0, 1e-4);
  const t = Math.min(Math.max((s - s0) / seg, 0), 1);
  const a = (i - 1) * 3;
  const b = i * 3;
  out.x = e.pts[a] + (e.pts[b] - e.pts[a]) * t;
  out.y = e.pts[a + 1] + (e.pts[b + 1] - e.pts[a + 1]) * t;
  out.z = e.pts[a + 2] + (e.pts[b + 2] - e.pts[a + 2]) * t;
  const dx = e.pts[b] - e.pts[a];
  const dy = e.pts[b + 1] - e.pts[a + 1];
  const dz = e.pts[b + 2] - e.pts[a + 2];
  const inv = 1 / Math.max(Math.hypot(dx, dz), 1e-4);
  out.hx = dx * inv;
  out.hz = dz * inv;
  out.hy = dy * inv;
}

/**
 * Which way out of a junction: prefer continuing straight, with a little
 * randomness so a real fork (a crossover, or a branch point still connected
 * at grade) is not always taken the same way. A dead end — one outgoing edge,
 * the reverse of whichever edge led here — returns immediately, which is
 * what makes a train bounce back down a branch instead of needing a special
 * "terminus" case.
 */
export function pickNext(g: RailGraph, edge: number): number {
  const e = g.edges[edge];
  const outs = g.out[e.to];
  if (!outs || !outs.length) return -1;
  if (outs.length === 1) return outs[0];
  let best = outs[0];
  let bestScore = -Infinity;
  for (const o of outs) {
    const oe = g.edges[o];
    const dot = e.ex * oe.sx + e.ez * oe.sz;
    let score = dot * 1.4 + Math.random() * 0.4;
    if (dot < -0.72) score -= 4; // a U-turn back the way we came
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
}
