/**
 * Rooftop clutter and dormers.
 *
 * Nineteen thousand flat roofs rendered as bare decks is the single most
 * damning tell of a cheap city model: from any aerial view Boston's downtown
 * roofscape is a dense mat of condensers, stair bulkheads, elevator overruns,
 * cooling towers, vent stacks, dishes, skylights and the occasional timber
 * water tank. All of it is scattered deterministically from the OSM id, so the
 * city is bit-identical on every reload.
 *
 * Clutter is *instanced*, not merged: four `InstancedMesh`es (box, wedge,
 * cylinder, dish) carry the whole city's rooftop plant in four draw calls, and
 * per-instance scale keeps the unit primitives reusable. Dormers are the
 * exception — they need per-face atlas layers so their fronts can carry a real
 * lit window, so they go into the merged tile geometry instead.
 */
import { LAYER, REF_BAY, BAYS } from './atlas';
import { KIND_DIRECT, KIND_TILED, ORIENT_ROOF, ORIENT_WALL, type MeshSink } from './mesh';
import { type Ring, distanceToRing, pointInRing, ringBounds, ringCentroid } from './poly';
import { type Rand, clamp } from './rng';

/** x, y, z, sx, sy, sz, rotY, r, g, b, layer */
export const CLUTTER_STRIDE = 11;

export const CK_BOX = 0;
export const CK_WEDGE = 1;
export const CK_CYL = 2;
export const CK_DISH = 3;
export const CLUTTER_KINDS = 4;

/** Growable per-kind instance store. */
export class ClutterSink {
  data: Float32Array[] = [];
  n: number[] = [];

  constructor() {
    for (let i = 0; i < CLUTTER_KINDS; i++) {
      this.data.push(new Float32Array(256 * CLUTTER_STRIDE));
      this.n.push(0);
    }
  }

  push(
    kind: number, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, rotY: number,
    r: number, g: number, b: number, layer: number,
  ): void {
    let buf = this.data[kind];
    const i = this.n[kind];
    if ((i + 1) * CLUTTER_STRIDE > buf.length) {
      const next = new Float32Array(Math.ceil(buf.length * 1.8) + CLUTTER_STRIDE * 64);
      next.set(buf);
      this.data[kind] = next;
      buf = next;
    }
    const o = i * CLUTTER_STRIDE;
    buf[o] = x;
    buf[o + 1] = y;
    buf[o + 2] = z;
    buf[o + 3] = sx;
    buf[o + 4] = sy;
    buf[o + 5] = sz;
    buf[o + 6] = rotY;
    buf[o + 7] = r;
    buf[o + 8] = g;
    buf[o + 9] = b;
    buf[o + 10] = layer;
    this.n[kind] = i + 1;
  }

  pack(): Float32Array[] {
    return this.data.map((d, i) => d.slice(0, this.n[i] * CLUTTER_STRIDE));
  }

  get total(): number {
    return this.n.reduce((a, b) => a + b, 0);
  }
}

// ---------------------------------------------------------------------------

interface Placed {
  x: number;
  z: number;
  r: number;
}

/** Grey-green painted plant, warm galvanised metal, and a little rust. */
const PLANT_COLOURS: Array<[number, number, number]> = [
  [0.72, 0.73, 0.72],
  [0.62, 0.64, 0.63],
  [0.80, 0.79, 0.75],
  [0.55, 0.58, 0.58],
  [0.68, 0.66, 0.60],
];

export interface ClutterJob {
  clutter: ClutterSink;
  deck: Ring;
  deckY: number;
  area: number;
  /** Height of the building top above local ground — drives how serviced it is. */
  height: number;
  rotY: number;
  rnd: Rand;
  family: number;
}

/**
 * Rejection-sample a spot on the deck that clears the parapet and everything
 * already standing there.
 */
function spot(
  deck: Ring, taken: Placed[], radius: number, rnd: Rand, bounds: ReturnType<typeof ringBounds>,
): [number, number] | null {
  for (let attempt = 0; attempt < 14; attempt++) {
    const x = rnd.range(bounds.minX, bounds.maxX);
    const z = rnd.range(bounds.minZ, bounds.maxZ);
    if (!pointInRing(deck, x, z)) continue;
    if (distanceToRing(deck, x, z) < radius + 0.25) continue;
    let clear = true;
    for (const t of taken) {
      const dx = t.x - x;
      const dz = t.z - z;
      if (dx * dx + dz * dz < (t.r + radius + 0.35) ** 2) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    taken.push({ x, z, r: radius });
    return [x, z];
  }
  return null;
}

/** Everything that stands on a flat deck. */
export function scatterRoof(job: ClutterJob): void {
  const { clutter, deck, deckY, area, rnd, height } = job;
  if (area < 26) return;

  const bounds = ringBounds(deck);
  const taken: Placed[] = [];
  const rot = job.rotY;
  const tall = height > 26;
  const big = area > 900;

  const paint = (): [number, number, number] => rnd.pick(PLANT_COLOURS);

  // --- mechanical penthouse: the dominant mass on any serviced building ----
  if ((tall || big) && area > 260) {
    const [cx, cz] = ringCentroid(deck);
    if (pointInRing(deck, cx, cz)) {
      const span = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      const w = clamp(span * rnd.range(0.26, 0.46), 3, 22);
      const d = clamp(span * rnd.range(0.22, 0.4), 2.6, 18);
      const h = clamp(rnd.range(2.8, 5.4) + (tall ? 1.2 : 0), 2.4, 7);
      const ox = rnd.bell() * span * 0.12;
      const oz = rnd.bell() * span * 0.12;
      const px = cx + ox * Math.cos(rot) - oz * Math.sin(rot);
      const pz = cz + ox * Math.sin(rot) + oz * Math.cos(rot);
      if (distanceToRing(deck, px, pz) > Math.max(w, d) * 0.5 + 0.3) {
        const c = paint();
        clutter.push(CK_BOX, px, deckY, pz, w, h, d, rot, c[0], c[1], c[2], LAYER.clutterMetal);
        taken.push({ x: px, z: pz, r: Math.max(w, d) * 0.5 });
        // cooling tower riding on the penthouse
        if (rnd.chance(tall ? 0.75 : 0.4)) {
          const cd = clamp(Math.min(w, d) * rnd.range(0.3, 0.5), 1.4, 4);
          clutter.push(
            CK_CYL, px + (rnd.bell() * w) / 5, deckY + h, pz + (rnd.bell() * d) / 5,
            cd, rnd.range(1.8, 3.2), cd, rot, 0.74, 0.75, 0.73, LAYER.clutterMetal,
          );
        }
      }
    }
  }

  // --- stair bulkhead: almost every flat roof has one ----------------------
  if (area > 55 && rnd.chance(0.92)) {
    const w = rnd.range(2.1, 3.6);
    const d = rnd.range(1.9, 3.1);
    const p = spot(deck, taken, Math.max(w, d) * 0.5, rnd, bounds);
    if (p) {
      const c = paint();
      clutter.push(
        CK_WEDGE, p[0], deckY, p[1], w, rnd.range(2.2, 3.1), d,
        rot + (rnd.chance(0.5) ? 0 : Math.PI / 2), c[0], c[1], c[2], LAYER.clutterPaint,
      );
    }
  }

  // --- elevator overrun ----------------------------------------------------
  if (height > 17 && rnd.chance(0.8)) {
    const w = rnd.range(2.4, 3.8);
    const d = rnd.range(2.2, 3.4);
    const p = spot(deck, taken, Math.max(w, d) * 0.5, rnd, bounds);
    if (p) {
      const c = paint();
      clutter.push(CK_BOX, p[0], deckY, p[1], w, rnd.range(3.4, 5.2), d, rot, c[0], c[1], c[2], LAYER.clutterPaint);
    }
  }

  // --- packaged HVAC / condenser units -------------------------------------
  const units = clamp(Math.round(area / 150), area > 80 ? 1 : 0, 9);
  for (let i = 0; i < units; i++) {
    const w = rnd.range(1.1, 2.6);
    const d = rnd.range(0.9, 1.9);
    const p = spot(deck, taken, Math.max(w, d) * 0.5, rnd, bounds);
    if (!p) continue;
    const h = rnd.range(0.7, 1.5);
    clutter.push(CK_BOX, p[0], deckY, p[1], w, h, d, rot, 0.76, 0.77, 0.76, LAYER.clutterMetal);
    // fan cowl on top
    if (rnd.chance(0.65)) {
      const fd = Math.min(w, d) * rnd.range(0.45, 0.7);
      clutter.push(CK_CYL, p[0], deckY + h, p[1], fd, rnd.range(0.18, 0.34), fd, rot, 0.6, 0.61, 0.6, LAYER.clutterMetal);
    }
  }

  // --- vent stacks and flues ----------------------------------------------
  const vents = clamp(Math.round(area / 210), 0, 7);
  for (let i = 0; i < vents; i++) {
    const r = rnd.range(0.14, 0.3);
    const p = spot(deck, taken, r, rnd, bounds);
    if (!p) continue;
    clutter.push(
      CK_CYL, p[0], deckY, p[1], r * 2, rnd.range(0.6, 1.9), r * 2, rot,
      0.66, 0.65, 0.62, LAYER.clutterMetal,
    );
  }

  // --- timber water tank: rare, but unmistakably a real roofscape ----------
  if (area > 180 && height > 12 && rnd.chance(0.1)) {
    const d = rnd.range(2.4, 3.4);
    const p = spot(deck, taken, d * 0.5 + 0.2, rnd, bounds);
    if (p) {
      const stand = rnd.range(1.0, 2.0);
      clutter.push(CK_BOX, p[0], deckY, p[1], d * 0.72, stand, d * 0.72, rot, 0.42, 0.36, 0.3, LAYER.clutterPaint);
      clutter.push(
        CK_CYL, p[0], deckY + stand, p[1], d, rnd.range(2.6, 3.6), d, rot,
        0.44, 0.33, 0.24, LAYER.clutterPaint,
      );
    }
  }

  // --- satellite and microwave dishes --------------------------------------
  const dishes = rnd.chance(height > 20 ? 0.55 : 0.22) ? rnd.int(1, 3) : 0;
  for (let i = 0; i < dishes; i++) {
    const d = rnd.range(0.7, height > 40 ? 2.2 : 1.4);
    const p = spot(deck, taken, d * 0.5, rnd, bounds);
    if (!p) continue;
    clutter.push(
      CK_DISH, p[0], deckY + rnd.range(0.25, 0.9), p[1], d, d, d, rnd.range(0, Math.PI * 2),
      0.84, 0.84, 0.82, LAYER.clutterPaint,
    );
  }

  // --- skylights on wide, low floorplates ----------------------------------
  if (area > 320 && height < 24) {
    const n = clamp(Math.round(area / 500), 1, 5);
    for (let i = 0; i < n; i++) {
      const w = rnd.range(1.4, 3.2);
      const d = rnd.range(1.1, 2.0);
      const p = spot(deck, taken, Math.max(w, d) * 0.5, rnd, bounds);
      if (!p) continue;
      clutter.push(CK_WEDGE, p[0], deckY, p[1], w, rnd.range(0.4, 0.7), d, rot, 0.7, 0.78, 0.86, LAYER.field[4]);
    }
  }

  // --- antenna masts on the tall stuff -------------------------------------
  if (height > 45 && rnd.chance(0.7)) {
    const n = rnd.int(1, 3);
    for (let i = 0; i < n; i++) {
      const p = spot(deck, taken, 0.4, rnd, bounds);
      if (!p) continue;
      clutter.push(
        CK_CYL, p[0], deckY, p[1], rnd.range(0.12, 0.24), rnd.range(3, 11), rnd.range(0.12, 0.24), rot,
        0.78, 0.78, 0.76, LAYER.clutterMetal,
      );
    }
  }
}

/**
 * Brick chimneys for pitched-roof housing stock — Boston's triple-deckers and
 * rowhouses all have them, and they break up an otherwise bald roofline.
 */
export function chimneys(
  clutter: ClutterSink, ring: Ring, ridgeY: number, eavesY: number, rnd: Rand, family: number, area: number,
): void {
  if (area < 40) return;
  const n = area > 220 ? rnd.int(1, 2) : rnd.chance(0.72) ? 1 : 0;
  const bounds = ringBounds(ring);
  const taken: Placed[] = [];
  const brick = family === 6 || family === 7;
  const layer = brick ? LAYER.field[0] : LAYER.field[0];
  for (let i = 0; i < n; i++) {
    const w = rnd.range(0.6, 1.1);
    const p = spot(ring, taken, w * 0.7, rnd, bounds);
    if (!p) continue;
    const top = ridgeY + rnd.range(0.5, 1.4);
    const base = eavesY - 0.3;
    clutter.push(
      CK_BOX, p[0], base, p[1], w, top - base, w * rnd.range(0.7, 1.0), 0,
      0.55, 0.34, 0.27, layer,
    );
  }
}

/**
 * Dormers on a mansard's steep slope. These go into the merged tile geometry
 * rather than the instanced clutter so the front face can use the building's
 * own facade layer — which means the dormer windows light up at night with
 * everything else.
 */
export function dormers(
  sink: MeshSink, ring: Ring, eavesY: number, topY: number, wallLayer: number, rnd: Rand, area: number,
): void {
  if (area < 70) return;
  const n = ring.length >> 1;
  const rise = topY - eavesY;
  if (rise < 1.4) return;

  const h = clamp(rise * 0.6, 0.9, 2.0);
  const w = rnd.range(0.95, 1.35);
  const depth = clamp(rise * 0.28, 0.35, 0.8);
  const y0 = eavesY + rise * 0.18;
  const tileM = REF_BAY[0] * BAYS;

  sink.section(1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2];
    const az = ring[i * 2 + 1];
    const bx = ring[j * 2];
    const bz = ring[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 4.2) continue;
    const count = Math.min(7, Math.floor(len / 3.1));
    if (count < 1) continue;
    const ex = (bx - ax) / len;
    const ez = (bz - az) / len;
    // outward normal of a canonically wound edge
    const ox = ez;
    const oz = -ex;

    for (let k = 0; k < count; k++) {
      const t = ((k + 0.5) / count) * len;
      const cx = ax + ex * t + ox * depth * 0.5;
      const cz = az + ez * t + oz * depth * 0.5;
      dormerBox(sink, cx, cz, y0, ex, ez, ox, oz, w, h, depth, wallLayer, tileM);
    }
  }
  sink.section(0);
}

/** One dormer: painted cheeks and roof, a glazed front taken from the atlas. */
function dormerBox(
  sink: MeshSink, cx: number, cz: number, y0: number,
  ex: number, ez: number, ox: number, oz: number,
  w: number, h: number, d: number, wallLayer: number, tileM: number,
): void {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const corner = (su: number, sv: number): [number, number] => [
    cx + ex * hw * su + ox * hd * sv,
    cz + ez * hw * su + oz * hd * sv,
  ];
  const [flx, flz] = corner(-1, 1);
  const [frx, frz] = corner(1, 1);
  const [blx, blz] = corner(-1, -1);
  const [brx, brz] = corner(1, -1);
  const y1 = y0 + h;

  // Front: the building's own facade layer, cropped to a single window.
  sink.surface(wallLayer, KIND_DIRECT, ORIENT_WALL);
  sink.params(0, 0, 0, 1);
  sink.quad(
    flx, y0, flz, 0.40, 0.12,
    frx, y0, frz, 0.60, 0.12,
    frx, y1, frz, 0.60, 0.86,
    flx, y1, flz, 0.40, 0.86,
    ox, 0, oz,
  );

  // Cheeks and roof in painted trim.
  sink.surface(LAYER.clutterPaint, KIND_TILED, ORIENT_WALL);
  sink.params(0, 0, 0, tileM);
  sink.wallQuad(blx, blz, flx, flz, y0, y1, 0, 0, h);
  sink.wallQuad(frx, frz, brx, brz, y0, y1, 0, 0, h);
  sink.surface(LAYER.clutterPaint, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, tileM);
  // Shed roof sloping back into the main slope.
  const yb = y1 + Math.min(0.45, d * 0.55);
  sink.quad(
    flx, y1, flz, flx, -flz,
    frx, y1, frz, frx, -frz,
    brx, yb, brz, brx, -brz,
    blx, yb, blz, blx, -blz,
    0, 1, 0,
  );
}
