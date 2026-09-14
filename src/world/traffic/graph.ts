/**
 * Directed lane graph built from the OSM road network.
 *
 * Vehicles need somewhere legal to be: a chain of directed edges with a
 * known width and lane count, joined at shared endpoints so a car leaving one
 * street can pick another. OSM ways already share node coordinates exactly at
 * junctions, so snapping endpoints to a fine grid recovers the topology
 * without needing the original node ids.
 */
import type { RoadClass, RoadRecord } from '../../core/types';

/** Endpoint snap, metres. OSM junction coordinates coincide exactly. */
const SNAP = 0.5;

/** Free-flow speed by road class, m/s. Boston traffic is not fast. */
const SPEED: Record<string, number> = {
  motorway: 26, trunk: 20, primary: 14, secondary: 12,
  tertiary: 11, residential: 8, service: 6,
};

/** Walking speed by class, m/s. A brisk pavement pace is about 1.4. */
const WALK_SPEED: Record<string, number> = {
  footway: 1.4, pedestrian: 1.3, cycleway: 1.5, service: 1.3, residential: 1.35,
};

/** Typical US lane width, metres. */
export const LANE_W = 3.35;

export interface Edge {
  /** Flat [x,y,z, ...] along the direction of travel. */
  pts: Float32Array;
  /** Cumulative distance at each point; last entry is the total length. */
  cum: Float32Array;
  length: number;
  lanes: number;
  cls: RoadClass;
  speed: number;
  /** Node index at the far end. */
  to: number;
  /** Structural layer, so a viaduct never hands off to the street below. */
  layer: number;
}

export interface LaneGraph {
  edges: Edge[];
  /** Outgoing edge indices per node. */
  out: Int32Array[];
  /** Node positions, [x,y,z,...]. */
  nodes: Float32Array;
  totalKm: number;
}

const key = (x: number, z: number): number =>
  (Math.round(x / SNAP) & 0x3fffff) * 4194304 + (Math.round(z / SNAP) & 0x3fffff);

/**
 * Splits every way into its constituent edges and indexes them by node.
 * Two-way streets produce an edge in each direction; a vehicle only ever
 * traverses an edge forwards, which keeps the simulation trivial.
 *
 * `mode` picks the class table: 'drive' gives the carriageway network,
 * 'walk' gives footways and shared surfaces, always two-way because nobody
 * obeys a oneway tag on foot.
 */
export function buildLaneGraph(roads: RoadRecord[], mode: 'drive' | 'walk' = 'drive'): LaneGraph {
  const table = mode === 'walk' ? WALK_SPEED : SPEED;
  const nodeIds = new Map<number, number>();
  const nodeXYZ: number[] = [];
  const edges: Edge[] = [];
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

  const addEdge = (
    pts: Float32Array, from: number, to: number,
    lanes: number, cls: RoadClass, layer: number,
  ): void => {
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
    if (len < 3) return; // too short to be worth traversing
    outLists[from].push(edges.length);
    edges.push({ pts, cum, length: len, lanes, cls, speed: table[cls] ?? 8, to, layer });
  };

  let totalKm = 0;

  for (const r of roads) {
    if (r.tunnel) continue; // nothing to see underground
    if (!table[r.class]) continue;
    const n = r.path.length / 2;
    if (n < 2) continue;

    // Interleave the polyline with its per-vertex elevation, lifted slightly
    // so wheels sit on the carriageway rather than in it.
    const fwd = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      fwd[i * 3] = r.path[i * 2];
      fwd[i * 3 + 1] = (r.elevation[i] ?? 0) + 0.06;
      fwd[i * 3 + 2] = r.path[i * 2 + 1];
    }

    const lanes = Math.max(1, r.oneway ? r.lanes || 1 : Math.floor((r.lanes || 2) / 2) || 1);
    const a = nodeAt(fwd[0], fwd[1], fwd[2]);
    const b = nodeAt(fwd[(n - 1) * 3], fwd[(n - 1) * 3 + 1], fwd[(n - 1) * 3 + 2]);
    if (a === b) continue; // a closed loop has no useful direction

    addEdge(fwd, a, b, lanes, r.class, r.layer);
    totalKm += 0;

    if (!r.oneway || mode === 'walk') {
      const rev = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rev[i * 3] = fwd[(n - 1 - i) * 3];
        rev[i * 3 + 1] = fwd[(n - 1 - i) * 3 + 1];
        rev[i * 3 + 2] = fwd[(n - 1 - i) * 3 + 2];
      }
      addEdge(rev, b, a, lanes, r.class, r.layer);
    }
  }

  for (const e of edges) totalKm += e.length;

  return {
    edges,
    out: outLists.map((l) => Int32Array.from(l)),
    nodes: Float32Array.from(nodeXYZ),
    totalKm: totalKm / 1000,
  };
}

/** Position and heading a distance `s` along an edge. */
export function sampleEdge(
  e: Edge, s: number, out: { x: number; y: number; z: number; hx: number; hz: number },
): void {
  const cum = e.cum;
  const n = cum.length;
  // Linear scan from a hint would be faster, but edges are short and this is
  // only called once per vehicle per frame.
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
  const dz = e.pts[b + 2] - e.pts[a + 2];
  const inv = 1 / Math.max(Math.hypot(dx, dz), 1e-4);
  out.hx = dx * inv;
  out.hz = dz * inv;
}
