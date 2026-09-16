/**
 * Overhead contact wire for the Green Line's surface running. Only the
 * light-rail stock carries a pantograph (`stock.ts`'s `greenLineCar`) —
 * Red, Orange and Blue are third-rail in reality and carry no such thing
 * here either, and commuter rail is diesel — so this draws once, for the
 * green system's own non-tunnel trackage, and nowhere else.
 *
 * Built straight from the same `RoadRecord`s `graph.ts` reads, one static
 * merged mesh for the whole network rather than one per way: the wire never
 * moves, so it costs a single draw call regardless of how many kilometres
 * of route it follows. It deliberately does not go through `RailGraph` —
 * that structure duplicates a way into two directional edges for routing,
 * which would draw a double-tracked pair's wire correctly (one wire per
 * physical rail, which is real) but a single-tracked way's twice (one wire
 * per direction of travel, which is not).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoadRecord } from '../../core/types';
import { classifyRail } from './lines';
import { RAIL_LIFT } from './graph';

/**
 * Height above the railhead the wire sits at. Matched to where `stock.ts`'s
 * pantograph contact strip actually is — the car body top (~2.46 m) plus
 * the diamond frame (~0.62 m) — rather than a full-scale trolley wire's real
 * 4.6-5.5 m, so the pantograph visibly reaches it instead of reaching into
 * empty air below a textbook-height wire.
 */
export const WIRE_HEIGHT = 3.08;

const WIRE_HALF = 0.014; // ~28 mm contact wire, generous for visibility at speed
const POLE_SPACING = 34; // metres, a plausible span between trolley poles
const POLE_HALF = 0.085;

/** One thin box standing in for a short straight run of wire between two
 *  polyline vertices — cheaper than a round tube, and at contact-wire
 *  thickness the facets are not visible at any distance this city is seen
 *  from anyway. */
function wireSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number): THREE.BufferGeometry | null {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return null;
  const g = new THREE.BoxGeometry(len, WIRE_HALF * 2, WIRE_HALF * 2);
  const yaw = Math.atan2(-dz, dx);
  const horiz = Math.hypot(dx, dz);
  const pitch = Math.atan2(dy, horiz);
  g.rotateZ(pitch);
  g.rotateY(yaw);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** A single mast from the ground up to the wire, standing directly under it.
 *  Real trolley poles stand beside the track with a bracket arm reaching
 *  over it; a centre mast under the wire is a simplification, but it is the
 *  right amount of infrastructure for how closely this city is ever seen. */
function pole(x: number, groundY: number, z: number): THREE.BufferGeometry {
  // Span from the ground up to a touch above the wire itself -- a constant
  // height regardless of terrain elevation, since the wire's own height
  // above *ground* (not sea level) is constant. Subtracting `groundY` here
  // was the bug: it turned "how tall is the pole" into "how tall is the
  // pole once you also subtract the hill it's standing on", which collapsed
  // every pole on higher ground to the 0.2 m floor below.
  const h = RAIL_LIFT + WIRE_HEIGHT + 0.1;
  const g = new THREE.CylinderGeometry(POLE_HALF * 0.7, POLE_HALF, h, 6);
  g.translate(x, groundY + h / 2, z);
  return g;
}

export interface Catenary {
  wire: THREE.BufferGeometry | null;
  poles: THREE.BufferGeometry | null;
}

/** Builds the whole Green Line catenary from every non-tunnel way classified
 *  as `'green'`, the same filter `buildRailGraph` applies. */
export function buildCatenary(records: RoadRecord[]): Catenary {
  const wireParts: THREE.BufferGeometry[] = [];
  const poleParts: THREE.BufferGeometry[] = [];

  for (const r of records) {
    if (r.tunnel) continue;
    if (classifyRail(r.name) !== 'green') continue;
    const n = r.path.length / 2;
    if (n < 2) continue;

    let sinceLastPole = 0;
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    for (let i = 0; i < n; i++) {
      const x = r.path[i * 2];
      const z = r.path[i * 2 + 1];
      const groundY = r.elevation[i] ?? 0;
      const y = groundY + RAIL_LIFT + WIRE_HEIGHT;
      if (i > 0) {
        const seg = wireSegment(prevX, prevY, prevZ, x, y, z);
        if (seg) wireParts.push(seg);
        sinceLastPole += Math.hypot(x - prevX, z - prevZ);
        if (sinceLastPole >= POLE_SPACING) {
          poleParts.push(pole(x, groundY, z));
          sinceLastPole = 0;
        }
      } else {
        poleParts.push(pole(x, groundY, z));
      }
      prevX = x; prevY = y; prevZ = z;
    }
  }

  return {
    wire: wireParts.length ? mergeGeometries(wireParts, false) : null,
    poles: poleParts.length ? mergeGeometries(poleParts, false) : null,
  };
}
