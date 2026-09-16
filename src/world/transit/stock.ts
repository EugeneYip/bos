/**
 * Procedural rolling-stock geometry.
 *
 * Every car is one merged shell mesh plus one merged glass mesh, drawn as an
 * `InstancedMesh` per car type — the same split `traffic/vehicles.ts` uses
 * for road vehicles, for the same reason: glass needs different shading and
 * must not cast a shadow, and everything else can share one material by
 * baking colour into vertices.
 *
 * Head and marker lamps are *not* part of a car's shell. A train is several
 * independent car instances at fixed offsets behind a shared "head", and only
 * the very front of the lead car and the very back of the last car ever show
 * a light — the couplings in between show nothing, same as a real train. So
 * the lamps live in their own two tiny shared InstancedMeshes (one warm-white,
 * one red), sized to one pair per concurrent train rather than one pair per
 * car, and `Transit` places them directly at the head/tail sample point
 * instead of tying them to any one car's own transform.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type CarPart = 'shell' | 'glass';

export interface RailCarDef {
  key: string;
  /** Overall length, metres — used for consist spacing. */
  length: number;
  width: number;
  height: number;
  /** Height above the railhead at which this type's headlight/marker sits. */
  lampY: number;
  parts: Record<CarPart, THREE.BufferGeometry | null>;
}

/* ------------------------------------------------------------- utilities */

function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  // `THREE.Color`'s hex constructor already converts sRGB -> linear via
  // `ColorManagement` (enabled project-wide, never overridden) — an explicit
  // second `convertSRGBToLinear()` here compounds that conversion and crushes
  // anything saturated or dark most of the way to black, which is exactly
  // what a deep body green or a purple commuter-rail stripe is.
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}

const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  const o = g.index ? g.toNonIndexed() : g;
  if (o !== g) g.dispose();
  return o;
};
const merge = (gs: THREE.BufferGeometry[]): THREE.BufferGeometry | null =>
  gs.length ? mergeGeometries(gs.map(flat), false) : null;

/** Box with its centre at (x,y,z); y is measured from the railhead. */
function box(w: number, h: number, d: number, x: number, y: number, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * A body panel that pinches inward over the outer `pinch` fraction of its
 * length at each end — a flat box reads as a shipping container, and the
 * taper is what turns it into a railcar nose. Every band in a car is given
 * the same length, pinch and narrow amount, so the bands stay flush at their
 * shared seams.
 */
function panel(
  len: number, h: number, wid: number, x: number, y: number, pinch: number, narrow: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, h, wid, 4, 1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const half = len / 2;
  const pinchLen = Math.max(half * pinch, 1e-3);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const into = Math.max(0, Math.abs(px) - half * (1 - pinch));
    const t = Math.min(1, into / pinchLen);
    const k = 1 - t * narrow;
    pos.setZ(i, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(x, y, 0);
  return g;
}

/** One horizontal band of a car body, bottom to top. */
interface Band {
  h: number;
  /** sRGB hex, or 'glass' to route this band to the glazing mesh instead. */
  color: number | 'glass';
  /** Fraction narrower than the full body width. */
  inset?: number;
}

/** Stacks bands from the railhead upward into a tapered body. */
function stackBands(
  len: number, wid: number, bands: Band[], pinch: number, narrow: number,
): { shell: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; top: number } {
  let y = 0;
  const shell: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  for (const b of bands) {
    const w = wid * (1 - (b.inset ?? 0));
    const g = panel(len, b.h, w, 0, y + b.h / 2, pinch, narrow);
    if (b.color === 'glass') glass.push(g);
    else shell.push(tint(g, b.color));
    y += b.h;
  }
  return { shell, glass, top: y };
}

/**
 * A simple bogie hint: four wheel-discs standing a couple of centimetres
 * proud of the body sides, the same trick `traffic/vehicles.ts` uses for road
 * wheels — a disc tucked flush with the flank is invisible above the sill and
 * a train reads as floating on its skirt without it.
 */
function truck(x: number, wid: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const out = wid * 0.5 + 0.02;
  for (const z of [-out, out]) {
    for (const dx of [-0.68, 0.68]) {
      const c = new THREE.CircleGeometry(0.36, 10);
      if (z < 0) c.rotateY(Math.PI);
      c.translate(x + dx, 0.36, z);
      parts.push(c);
    }
  }
  return parts.map((g) => tint(g, 0x0a0b0d));
}

/* --------------------------------------------------------- light rail (Green Line) */

/**
 * A single Type 9/10-style low-floor car: green body, a white stripe band at
 * the base of the windows, and a roof-mounted pantograph — the current
 * Green Line fleet is the first to use one instead of a trolley pole.
 */
export function greenLineCar(): RailCarDef {
  const len = 20.9;
  const wid = 2.65;
  const pinch = 0.16;
  const narrow = 0.34;
  const GREEN = 0x0d6b3c;
  const STRIPE = 0xf1f1ec;
  const DARK = 0x14161a;

  const { shell, glass, top } = stackBands(len, wid, [
    { h: 0.62, color: DARK },        // skirt
    { h: 0.30, color: STRIPE },      // white stripe at the sill
    { h: 1.00, color: 'glass', inset: 0.045 },
    { h: 0.32, color: GREEN },
    { h: 0.22, color: GREEN },       // roof cap
  ], pinch, narrow);

  // Pantograph: a low pedestal and a shallow diamond frame, offset toward one
  // end so a two-car set reads as two distinct units rather than a mirror.
  const px = -len * 0.22;
  const pan: THREE.BufferGeometry[] = [
    box(0.5, 0.10, 0.5, px, top + 0.05),
    box(0.42, 0.06, 0.34, px, top + 0.16),
  ];
  for (const sx of [-1, 1]) {
    const bar = new THREE.BoxGeometry(0.92, 0.045, 0.045);
    bar.rotateZ(sx * 0.46);
    bar.translate(px + sx * 0.36, top + 0.34, 0);
    pan.push(bar);
  }
  pan.push(box(0.86, 0.035, 0.16, px, top + 0.58));

  const shellAll = [...shell, ...truck(-len * 0.29, wid), ...truck(len * 0.29, wid),
    ...pan.map((g) => tint(g, DARK))];

  return {
    key: 'green',
    length: len,
    width: wid,
    height: top + 0.7,
    lampY: 1.02,
    parts: { shell: merge(shellAll), glass: merge(glass) },
  };
}

/* --------------------------------------------------------- heavy rail */

/** Red/Orange/Blue: stainless body, a coloured stripe above the windows. */
export function heavyRailCar(key: string, length: number, width: number, stripe: number): RailCarDef {
  const pinch = 0.12;
  const narrow = 0.24;
  const SILVER = 0xc7cad0;
  const DARK = 0x151619;

  const { shell, glass, top } = stackBands(length, width, [
    { h: 0.70, color: DARK },
    { h: 0.58, color: SILVER },
    { h: 1.10, color: 'glass', inset: 0.04 },
    { h: 0.26, color: stripe },
    { h: 0.30, color: SILVER },
  ], pinch, narrow);

  const shellAll = [...shell, ...truck(-length * 0.30, width), ...truck(length * 0.30, width)];

  return {
    key,
    length,
    width,
    height: top + 0.05,
    lampY: 1.10,
    parts: { shell: merge(shellAll), glass: merge(glass) },
  };
}

/* --------------------------------------------------------- commuter rail */

/** Bilevel-profile coach: silver with a broad purple band across the windows. */
export function commuterCoach(): RailCarDef {
  const len = 25.9;
  const wid = 3.05;
  const pinch = 0.08;
  const narrow = 0.16;
  const SILVER = 0xd6d5d0;
  const PURPLE = 0x6a2c73;
  const DARK = 0x18181b;

  const { shell, glass, top } = stackBands(len, wid, [
    { h: 0.85, color: DARK },
    { h: 0.30, color: SILVER },
    { h: 0.95, color: PURPLE },
    { h: 1.05, color: 'glass', inset: 0.035 },
    { h: 0.55, color: SILVER },       // upper deck / roofline
  ], pinch, narrow);

  const shellAll = [...shell, ...truck(-len * 0.32, wid), ...truck(len * 0.32, wid)];

  return {
    key: 'commuter-coach',
    length: len,
    width: wid,
    height: top + 0.05,
    lampY: 1.25,
    parts: { shell: merge(shellAll), glass: merge(glass) },
  };
}

/** Diesel road locomotive: a full-height cab at one end, a lower hood behind it. */
export function commuterLoco(): RailCarDef {
  const len = 20.7;
  const wid = 3.05;
  const cabLen = 4.6;
  const hoodLen = len - cabLen;
  const cabH = 4.35;
  const hoodH = 3.15;
  const SILVER = 0xcfced0;
  const PURPLE = 0x6a2c73;
  const DARK = 0x151417;
  const cabX = len / 2 - cabLen / 2;
  const hoodX = cabX - cabLen / 2 - hoodLen / 2;

  const shell: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];

  // Cab block: dark skirt, purple band, a windscreen, a silver roof. Tapered
  // at both ends — the nose end for a rounded front, the hood end because a
  // real cab unit does stand slightly proud of the walkway behind it.
  let y = 0;
  const cabBands: Band[] = [
    { h: 0.85, color: DARK },
    { h: 1.00, color: PURPLE },
    { h: 0.62, color: 'glass', inset: 0.06 },
  ];
  for (const b of cabBands) {
    const g = panel(cabLen, b.h, wid * (1 - (b.inset ?? 0)), cabX, y + b.h / 2, 0.30, 0.30);
    if (b.color === 'glass') glass.push(g); else shell.push(tint(g, b.color));
    y += b.h;
  }
  shell.push(tint(panel(cabLen, cabH - y, wid, cabX, (y + cabH) / 2, 0.30, 0.26), SILVER));

  // Long hood: lower, mostly blank, with a thin purple stripe. A plain box —
  // real hoods run straight, and it is the cab's own taper that reads as the
  // step up from the walkway.
  shell.push(tint(box(hoodLen, 0.85, wid, hoodX, 0.43), DARK));
  shell.push(tint(box(hoodLen, 0.30, wid, hoodX, 0.85 + 0.15), PURPLE));
  shell.push(tint(box(hoodLen, hoodH - 1.15, wid * 0.92, hoodX, (1.15 + hoodH) / 2), SILVER));

  shell.push(...truck(-len * 0.30, wid), ...truck(len * 0.30, wid));

  return {
    key: 'commuter-loco',
    length: len,
    width: wid,
    height: cabH + 0.1,
    lampY: 1.30,
    parts: { shell: merge(shell), glass: merge(glass) },
  };
}

/** Every rolling-stock type the module draws, keyed for lookup by name. */
export function railStock(): RailCarDef[] {
  return [
    greenLineCar(),
    heavyRailCar('red', 21.8, 2.74, 0xd23c2f),
    heavyRailCar('orange', 21.9, 2.74, 0xe0812a),
    heavyRailCar('blue', 14.6, 2.60, 0x2f6fb0),
    commuterLoco(),
    commuterCoach(),
  ];
}

/* ------------------------------------------------------------------ lamps */

/** A small paired-lamp cluster; colour comes entirely from the material (see `Transit`). */
export function lampGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.07, 0.15, 0.17, 0, 0, -0.48),
    box(0.07, 0.15, 0.17, 0, 0, 0.48),
  ];
  return merge(parts)!;
}
