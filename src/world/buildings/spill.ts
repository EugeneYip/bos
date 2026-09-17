/**
 * Light spilling out of ground-floor windows onto the pavement.
 *
 * A night street with lit shopfronts and a black pavement outside them is the
 * single loudest tell that a render is not a photograph: the windows read as
 * stickers rather than as openings. Measured on the `street-night` pose, the
 * carriageway outside a continuous wall of lit glazing came back at 38.0 /
 * 38.6 / 41.8 / 41.5 luma stepping away from it — no gradient at all, which
 * is to say no light source at all.
 *
 * Doing it properly would mean a light per shopfront, and there are tens of
 * thousands of them. Three alternatives were considered and rejected:
 *
 *  - Real `PointLight`s tracking the nearest frontages. Physically correct and
 *    every material picks them up for free, but the light count is global
 *    state: it changes the compiled program for every lit material in the
 *    scene, including modules this file has no business touching.
 *  - Lighting the road from the road's own shader. The road is not ours, and
 *    the spill would then have to be duplicated into the terrain, the props
 *    and the vehicles to be consistent.
 *  - Baking it into the facade atlas. The atlas is vertical; the light lands
 *    on the ground.
 *
 * What this does instead is emit one horizontal quad per glazed ground-floor
 * wall edge, lying on the pavement and reaching a few metres out, drawn
 * additively after the opaque pass. It is a decal, not a light — it cannot
 * shadow and it cannot light a passing van's flank — but it puts the pool of
 * light where the pool of light belongs, it costs one draw call for the whole
 * city, and it is driven by the same `uNight` curve as the windows above it,
 * so the street comes on when they do.
 *
 * This module is deliberately free of three.js so it can run in the geometry
 * worker; the material and the instanced mesh live in `material.ts` and
 * `Buildings.ts`.
 */
import { hash2 } from './rng';
import type { Ring } from './poly';

/** Floats per pool: x, y, z, rotY, length, reach, warmth, gain. */
export const SPILL_STRIDE = 8;

/**
 * Families whose ground floor the atlas paints as a shopfront rather than as
 * a stoop and parlour windows. Mirrors the `commercial` test in
 * `atlas.paintGround`, which is what actually decides whether there is a wall
 * of glass down there to spill out of.
 */
const COMMERCIAL = new Set([0, 2, 3, 4, 5]);

/** Metres the pool reaches out from the wall, shopfront and residential. */
const REACH_SHOP = 13.0;
const REACH_HOME = 7.0;

/** Below this an edge is a chamfer or a bay window, not a frontage. */
const MIN_EDGE = 4.5;
/** Below this a footprint is a shed, a porch or a garage. */
const MIN_AREA = 45;
/** A frontage longer than this is split, so the end taper stays local. */
const MAX_SEG = 26;
/** No building contributes more than this many pools. */
const MAX_PER_BUILDING = 10;

export class SpillSink {
  private buf = new Float32Array(2048 * SPILL_STRIDE);
  private n = 0;

  push(
    x: number, y: number, z: number, rotY: number,
    len: number, reach: number, warm: number, gain: number,
  ): void {
    if ((this.n + 1) * SPILL_STRIDE > this.buf.length) {
      const next = new Float32Array(Math.ceil(this.buf.length * 1.8) + SPILL_STRIDE * 256);
      next.set(this.buf);
      this.buf = next;
    }
    const o = this.n * SPILL_STRIDE;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = z;
    this.buf[o + 3] = rotY;
    this.buf[o + 4] = len;
    this.buf[o + 5] = reach;
    this.buf[o + 6] = warm;
    this.buf[o + 7] = gain;
    this.n++;
  }

  pack(): Float32Array {
    return this.buf.slice(0, this.n * SPILL_STRIDE);
  }
}

/**
 * One pool per street-facing ground-floor edge of a footprint.
 *
 * Randomness is hashed from the building seed and the edge index rather than
 * drawn from the caller's generator: `buildOne` threads one `rand(seed)`
 * through the roof, the trim and the rooftop plant, and taking numbers out of
 * that stream would re-roll every one of them.
 */
export function emitSpill(
  sink: SpillSink, ring: Ring, ground: number, family: number, area: number, seed: number,
): void {
  if (area < MIN_AREA) return;
  const shop = COMMERCIAL.has(family);
  // A parlour window behind a stoop throws a fraction of what a shopfront
  // does, but a terrace of brownstones with nothing on the pavement is just
  // as wrong as a high street with nothing on it.
  const base = shop ? 1.0 : 0.3;
  const reach = shop ? REACH_SHOP : REACH_HOME;
  // Sodium and tungsten downstairs, a colder shop lighting in some of them.
  const warmBias = hash2(seed, 0x5be11);

  const n = ring.length >> 1;
  let emitted = 0;
  for (let i = 0; i < n && emitted < MAX_PER_BUILDING; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2];
    const z0 = ring[i * 2 + 1];
    const dx = ring[j * 2] - x0;
    const dz = ring[j * 2 + 1] - z0;
    const len = Math.hypot(dx, dz);
    if (len < MIN_EDGE) continue;

    // Some frontages are dark: a closed unit, a blank service elevation, a
    // party wall that OSM has drawn as an outside edge.
    const h = hash2(seed, i * 2654435761);
    if (h < (shop ? 0.18 : 0.42)) continue;

    const ux = dx / len;
    const uz = dz / len;
    // Outward normal of a canonically wound ring edge, matching
    // `MeshSink.wallQuad`. Local +Z of the pool points along it, which means
    // the quad's v runs 0 at the wall to 1 at the far edge.
    const nx = uz;
    const nz = -ux;
    const rotY = Math.atan2(uz, -ux);

    // A 40 m frontage is several shops with several different lights on.
    const segs = Math.max(1, Math.ceil(len / MAX_SEG));
    const segLen = len / segs;
    for (let k = 0; k < segs && emitted < MAX_PER_BUILDING; k++, emitted++) {
      const g = hash2(seed ^ 0x9e37, i * 131 + k);
      const t = (k + 0.5) / segs;
      const mx = x0 + dx * t + nx * reach * 0.5;
      const mz = z0 + dz * t + nz * reach * 0.5;
      sink.push(
        mx, ground + 0.08, mz, rotY,
        // Overlap adjacent segments slightly so the end tapers meet.
        segLen * 1.06, reach,
        warmBias * 0.55 + g * 0.45,
        base * (0.6 + 0.4 * g),
      );
    }
  }
}
