/**
 * Procedural vehicle geometry.
 *
 * Each type is one merged mesh drawn as an InstancedMesh, authored at true
 * scale with its origin between the rear wheels at road level and +X forward.
 * Windows, lights and tyres are separate merged groups so they can take
 * different materials — the lights need to be emissive after dark, and glass
 * needs to be dark and reflective, or a car at 30 m reads as a coloured brick.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Draw-call budget, not fidelity, sets the part list. Every instanced mesh
 * costs one call per shadow cascade as well as one in the main pass, so a
 * six-part car in nine flavours was ~270 calls on its own. Bodywork, trim and
 * tyres merge into one vertex-coloured shell; only glass and lights, which
 * genuinely need different shading, stay separate.
 */
export type Part = 'shell' | 'glass' | 'light';

export interface VehicleDef {
  name: string;
  /** Overall length, metres — used for spacing in the traffic stream. */
  length: number;
  width: number;
  /** Relative frequency in the mix. */
  weight: number;
  /** Fixed colour, or undefined to tint per instance. */
  color?: number;
  parts: Record<Part, THREE.BufferGeometry | null>;
}

/** Tag a geometry with a flat vertex colour so it can merge into the shell. */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex).convertSRGBToLinear();
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

/** Box with its centre at (x,y,z); y is measured from the road surface. */
function box(w: number, h: number, d: number, x: number, y: number, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Tapered box: a body that narrows toward the roof reads far better than a slab. */
function taper(
  len: number, h: number, wLo: number, wHi: number, x: number, y: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, h, wLo);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const k = wHi / wLo;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) pos.setZ(i, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(x, y + h / 2, 0);
  return g;
}

function wheels(axleF: number, axleR: number, track: number, r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [axleF, axleR]) {
    for (const z of [-track / 2, track / 2]) {
      const w = new THREE.CylinderGeometry(r, r, r * 0.52, 9);
      w.rotateX(Math.PI / 2);
      w.translate(x, r, z);
      parts.push(w);
    }
  }
  return merge(parts)!;
}

/** Saloon / hatchback / SUV share a silhouette; the proportions differ. */
function car(len: number, wid: number, roofH: number, cabFrac: number, suv: boolean): VehicleDef['parts'] {
  const wheelR = suv ? 0.37 : 0.32;
  const sill = wheelR * (suv ? 1.5 : 1.15);
  const bodyH = (suv ? 0.82 : 0.62);
  const cabLen = len * cabFrac;

  const body: THREE.BufferGeometry[] = [
    taper(len, bodyH, wid, wid * 0.96, 0, sill),
    // Cabin, set back and narrower — this is what makes it read as a car.
    taper(cabLen, roofH, wid * 0.93, wid * 0.80, -len * 0.04, sill + bodyH),
  ];
  const glass: THREE.BufferGeometry[] = [
    // Windscreen, backlight and side glass as a single slightly inset shell.
    taper(cabLen * 0.97, roofH * 0.62, wid * 0.945, wid * 0.815, -len * 0.04, sill + bodyH + roofH * 0.16),
  ];
  const trim: THREE.BufferGeometry[] = [
    box(len * 0.99, 0.10, wid * 1.01, 0, sill - 0.03),  // rocker
    box(0.16, 0.16, wid * 0.86, len * 0.49, sill + 0.20), // front bumper
    box(0.16, 0.16, wid * 0.86, -len * 0.49, sill + 0.20),
  ];
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.34, wid * 0.34]) {
    head.push(box(0.07, 0.15, wid * 0.22, len * 0.5, sill + 0.34, z));
    tail.push(box(0.07, 0.13, wid * 0.20, -len * 0.5, sill + 0.38, z));
  }

  // White bodywork takes the per-instance tint; everything else is baked dark
  // so the same instance colour leaves it essentially black.
  return {
    shell: merge([
      ...body.map((g) => tint(g, 0xffffff)),
      ...trim.map((g) => tint(g, 0x2b2d31)),
      tint(wheels(len * 0.31, -len * 0.31, wid * 0.86, wheelR), 0x141518),
    ]),
    glass: merge(glass),
    light: merge([...head, ...tail]),
  };
}

/** A high box on six wheels: box truck, and the MBTA bus. */
function boxVehicle(len: number, wid: number, h: number, cabLen: number): VehicleDef['parts'] {
  const r = 0.46;
  const sill = r * 1.35;
  const body = [
    taper(len, h, wid, wid * 0.98, 0, sill),
  ];
  const glass: THREE.BufferGeometry[] = [
    box(0.08, h * 0.30, wid * 0.88, len * 0.5, sill + h * 0.72),           // windscreen
    box(cabLen * 0.02 + len * 0.86, h * 0.26, 0.06, -len * 0.03, sill + h * 0.70, wid * 0.5),
    box(cabLen * 0.02 + len * 0.86, h * 0.26, 0.06, -len * 0.03, sill + h * 0.70, -wid * 0.5),
  ];
  const trim = [
    box(len, 0.13, wid * 1.02, 0, sill - 0.05),
    box(0.18, 0.22, wid * 0.9, len * 0.5, sill + 0.22),
  ];
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.36, wid * 0.36]) {
    head.push(box(0.07, 0.18, wid * 0.2, len * 0.5, sill + 0.40, z));
    tail.push(box(0.07, 0.20, wid * 0.18, -len * 0.5, sill + 0.55, z));
  }
  return {
    shell: merge([
      ...body.map((g) => tint(g, 0xffffff)),
      ...trim.map((g) => tint(g, 0x2b2d31)),
      tint(wheels(len * 0.34, -len * 0.26, wid * 0.86, r), 0x141518),
      tint(wheels(-len * 0.38, -len * 0.38, wid * 0.86, r), 0x141518),
    ]),
    glass: merge(glass),
    light: merge([...head, ...tail]),
  };
}

/**
 * The mix on a Boston street. Weights are rough observation: mostly saloons
 * and crossovers, a fair number of pickups and vans, the occasional MBTA bus
 * and box truck, and enough yellow cabs to notice downtown.
 */
export function vehicleTypes(): VehicleDef[] {
  return [
    { name: 'sedan',    length: 4.6, width: 1.82, weight: 30, parts: car(4.6, 1.82, 0.56, 0.52, false) },
    { name: 'hatch',    length: 4.1, width: 1.76, weight: 16, parts: car(4.1, 1.76, 0.58, 0.56, false) },
    { name: 'crossover',length: 4.7, width: 1.88, weight: 24, parts: car(4.7, 1.88, 0.70, 0.56, true) },
    { name: 'suv',      length: 5.1, width: 1.98, weight: 10, parts: car(5.1, 1.98, 0.78, 0.60, true) },
    { name: 'pickup',   length: 5.6, width: 2.02, weight: 7,  parts: car(5.6, 2.02, 0.66, 0.38, true) },
    { name: 'taxi',     length: 4.7, width: 1.86, weight: 4,  color: 0xe8b528,
      parts: car(4.7, 1.86, 0.60, 0.54, false) },
    { name: 'van',      length: 5.4, width: 2.00, weight: 5,  color: 0xe8e8e6,
      parts: boxVehicle(5.4, 2.00, 1.55, 1.6) },
    { name: 'truck',    length: 8.2, width: 2.44, weight: 2,  color: 0xd8d6d0,
      parts: boxVehicle(8.2, 2.44, 2.5, 2.0) },
    // MBTA buses are white above a yellow band with a black skirt; at the
    // distance you normally see one, the pale body is the recognisable part.
    { name: 'bus',      length: 12.2, width: 2.59, weight: 2, color: 0xf0eee8,
      parts: boxVehicle(12.2, 2.59, 2.75, 2.4) },
  ];
}

/** Plausible car colours: mostly greys and whites, a little real colour. */
export const CAR_COLORS: number[] = [
  0xe9e9ea, 0xe9e9ea, 0xf2f2f2, 0x2f3134, 0x2f3134, 0x1b1c1e,
  0x8c9095, 0x8c9095, 0xa8adb2, 0x5a6066, 0x6d7276,
  0x8d2f31, 0x27406b, 0x1f4f38, 0x7a5a2c, 0x35566e,
];

/* --------------------------------------------------------------- people */

/**
 * A pedestrian, as three merged boxes plus legs that the shader swings.
 *
 * At the distance people are actually visible — a few tens of metres — the
 * silhouette and the walk cycle are the whole read. Modelling faces would be
 * triangles spent where no pixel lands. The legs carry a `stride` attribute
 * the shader uses to swing them; everything above the hips stays rigid.
 */
export function pedestrianGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, stride: number, hue: number): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n);
    a.fill(stride);
    g.setAttribute('stride', new THREE.Float32BufferAttribute(a, 1));
    const c = new THREE.Color(hue).convertSRGBToLinear();
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  };

  // Torso and head are white so the per-instance tint becomes the clothing.
  parts.push(tag(box(0.34, 0.52, 0.22, 0, 1.18), 0, 0xffffff));
  parts.push(tag(box(0.19, 0.20, 0.19, 0, 1.54), 0, 0xf4d8bd));   // head
  // Arms swing opposite the legs, so they get a negative stride.
  for (const z of [-0.22, 0.22]) {
    const arm = box(0.11, 0.44, 0.11, 0, 1.18, z);
    parts.push(tag(arm, z > 0 ? -0.7 : 0.7, 0xffffff));
  }
  // Legs, hinged at the hip: stride +1 / -1 so they alternate.
  for (const z of [-0.09, 0.09]) {
    const leg = box(0.13, 0.62, 0.14, 0, 0.56, z);
    parts.push(tag(leg, z > 0 ? 1 : -1, 0x6b7078));
  }
  return merge(parts)!;
}

/**
 * Clothing colours. Boston does dress in dark neutrals, but the per-instance
 * tint multiplies the whole figure including the head, so a palette of true
 * charcoals rendered everyone as a black cut-out. These are the same hues
 * lifted into a range that still reads as a coat once the sun and the
 * tonemapper have had their way with it.
 */
export const CLOTHES: number[] = [
  0x4a5058, 0x5a6169, 0x3e444c, 0x6f757d, 0x8a9098,
  0x9a5f46, 0xa8adb4, 0xc6c9cd, 0x466f8c, 0x7d4247,
  0x4e7257, 0xd6d1c4, 0x8f84a2, 0xb5754a, 0x5f7f9c,
];
