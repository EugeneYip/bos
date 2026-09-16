/**
 * Directed track graph for one MBTA system, built the same way `Traffic`
 * builds its lane graph: split every way into one edge per direction of
 * travel and weld shared endpoints into nodes.
 *
 * Rail differs from the street network in the one way that matters here: a
 * train can never leave the physical alignment it is riding, so there is no
 * lane offset and no random lane change — a train's position *is* the
 * sampled centreline. Every way becomes an edge in both directions (whether
 * or not it is double-tracked in reality), which makes a tunnel portal or the
 * buffer at the end of a branch a natural terminus: the node there has
 * exactly one outgoing edge, the reverse of the one the train arrived on, so
 * a train bounces back down the line it came from instead of needing a
 * special case.
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

  let totalKm = 0;
  for (const r of records) {
    if (r.tunnel) continue; // underground — nothing to see and nowhere a train should be drawn
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

    addEdge(fwd, a, b);
    const rev = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rev[i * 3] = fwd[(n - 1 - i) * 3];
      rev[i * 3 + 1] = fwd[(n - 1 - i) * 3 + 1];
      rev[i * 3 + 2] = fwd[(n - 1 - i) * 3 + 2];
    }
    addEdge(rev, b, a);
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
