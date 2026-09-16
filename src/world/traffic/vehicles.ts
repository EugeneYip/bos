/**
 * Procedural vehicle geometry.
 *
 * Each type is one merged mesh drawn as an InstancedMesh, authored at true
 * scale with its origin between the rear wheels at road level and +X forward.
 * Windows, lights and tyres are separate merged groups so they can take
 * different materials — the lights need to be emissive after dark, and glass
 * needs to be dark and reflective, or a car at 30 m reads as a coloured brick.
 *
 * Two families of vertex attribute carry animation the CPU never touches:
 *
 *   `aWheel` / `aWheelC`  on the shell — which vertices belong to a wheel and
 *       where its centre is, so the shader can roll all four and steer the
 *       front pair. A plain cylinder looks identical however far you roll it,
 *       so each wheel gets a pale hub face and a pair of spokes; those are
 *       what actually reads as rotation.
 *   `aTail`               on the lamps — 0 on the headlamps, 1 on the tail
 *       lamps, so one mesh and one material can light the two ends
 *       differently and flare the reds under braking.
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
  /** Wheelbase, metres; the steering geometry needs it. */
  wheelbase: number;
  /** Rolling radius, metres; the wheel-spin shader needs it. */
  wheelR: number;
  parts: Record<Part, THREE.BufferGeometry | null>;
}

/** Tag a geometry with a flat vertex colour so it can merge into the shell. */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
// `new THREE.Color(hex)` and `setHex(hex)` already convert sRGB to the working
// linear space: three's `ColorManagement` is enabled by default in r169 and this
// project never turns it off. A second `convertSRGBToLinear()` applies the
// transform twice, which takes a mid-saturation colour about six times darker
// and a dark one thirteen times — which is why this vehicle's trim and wheel
// rims read as pure black rather than as dark grey.
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}

/**
 * Mark every vertex as belonging to a wheel (1 driven/trailing, 2 steered) and
 * record that wheel's centre so the shader has a pivot. Body vertices get 0.
 */
function markWheel(g: THREE.BufferGeometry, kind: number, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const k = new Float32Array(n).fill(kind);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = cx; c[i * 3 + 1] = cy; c[i * 3 + 2] = cz; }
  g.setAttribute('aWheel', new THREE.Float32BufferAttribute(k, 1));
  g.setAttribute('aWheelC', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

/** Give a lamp cluster its end tag: 0 = headlamp, 1 = tail lamp. */
function markLamp(g: THREE.BufferGeometry, tail: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aTail', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tail), 1));
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

/** Tyre width as a fraction of the rolling radius. */
const TYRE_W = 0.52;

/**
 * Where a wheel centre sits across the vehicle, so the outer tyre wall stands
 * 8 mm proud of the bodyside.
 *
 * This number is the difference between a car and a box on stumps. The bodies
 * here are solid boxes, so a wheel tucked inside the track is simply invisible
 * above the sill and is occluded by the flank at any oblique angle — which is
 * how every vehicle in the city came to read as a slab standing on two dark
 * pegs. Standing the tyre a few millimetres outboard of the panel, and keeping
 * the underbody inboard of the tyres (see `SKIRT_GAP`), puts the whole lower
 * half of the wheel into the silhouette from every direction.
 */
const trackZ = (wid: number, r: number): number => wid * 0.5 - r * TYRE_W * 0.5 + 0.008;
/** Clearance between the inner tyre wall and the underbody, metres. */
const SKIRT_GAP = 0.025;
/** Width of the dark underbody that runs between the wheels. */
const skirtW = (wid: number, r: number): number =>
  2 * (trackZ(wid, r) - r * TYRE_W - SKIRT_GAP);

/**
 * One road wheel, built around its own centre and then marked so the shader
 * can roll it.
 *
 * The axle runs across the vehicle, along Z, so everything that belongs to the
 * wheel has to lie in the XY plane — the plane the roll shader rotates in. The
 * hub face and spokes were each turned a further 90 degrees about Y, which
 * stood them across the wheel instead of in it: from the side they were
 * edge-on and contributed no pixels, and the open-ended tyre tube is edge-on
 * from there too, so a wheel showed up as a pair of thin black crescents. That
 * is the whole reason every vehicle in the city read as a body on stumps.
 *
 * The outer sidewall is a full-radius disc, because it is the only face of a
 * wheel you ever see: the inner one is inside the bodywork.
 */
function wheel(x: number, z: number, r: number, kind: number, tyre: number, hub: number): THREE.BufferGeometry[] {
  const w = r * TYRE_W;
  const out = z > 0 ? 1 : -1;
  const outer = z + out * w * 0.5;
  const parts: THREE.BufferGeometry[] = [];

  const t = new THREE.CylinderGeometry(r, r, w, 12, 1, true);
  t.rotateX(Math.PI / 2);
  t.translate(x, r, z);
  parts.push(markWheel(tint(t, tyre), kind, x, r, z));

  // Sidewall, facing outboard.
  const side = new THREE.CircleGeometry(r, 12);
  if (out < 0) side.rotateY(Math.PI);
  side.translate(x, r, outer);
  parts.push(markWheel(tint(side, tyre), kind, x, r, z));

  // Hub face, a little proud of the sidewall.
  const h = new THREE.CircleGeometry(r * 0.52, 10);
  if (out < 0) h.rotateY(Math.PI);
  h.translate(x, r, outer + out * 0.006);
  parts.push(markWheel(tint(h, hub), kind, x, r, z));

  // Two spokes across the hub: the rotation cue at any distance where the
  // wheel is more than a couple of pixels across.
  for (const a of [0, Math.PI / 2]) {
    const s = new THREE.BoxGeometry(r * 0.94, r * 0.16, 0.014);
    s.rotateZ(a);
    s.translate(x, r, outer + out * 0.013);
    parts.push(markWheel(tint(s, 0x15171a), kind, x, r, z));
  }
  return parts;
}

/** Four (or six) wheels: the front pair is marked steerable. */
function axles(axleF: number, axleR: number, track: number, r: number, steerFront = true): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const z of [-track / 2, track / 2]) {
    out.push(...wheel(axleF, z, r, steerFront ? 2 : 1, 0x121316, 0x8f949a));
    out.push(...wheel(axleR, z, r, 1, 0x121316, 0x8f949a));
  }
  return out;
}

/**
 * Saloon / hatchback / SUV share a silhouette; the proportions differ.
 *
 * Three heights do the work. `sill` is the wheel-arch line, just above the
 * axle, where the painted flank begins; below it a narrow dark underbody runs
 * between the wheels, so the tyres stand clear in the silhouette instead of
 * being swallowed by a full-width box. The cabin sits on the belt line, and
 * the glass is a slightly proud band inside it with painted metal above and
 * below — a window that reaches the roof reads as a separate block balanced on
 * the boot.
 */
function car(
  len: number, wid: number, roofH: number, cabFrac: number, suv: boolean, bed = false,
): VehicleDef['parts'] {
  const wheelR = suv ? 0.37 : 0.32;
  const sill = wheelR * 1.16;
  const bodyH = (suv ? 0.78 : 0.62);
  const cabLen = len * cabFrac;
  const cabX = bed ? len * 0.17 : -len * 0.04;
  const track = trackZ(wid, wheelR) * 2;

  const body: THREE.BufferGeometry[] = [
    taper(len, bodyH, wid, wid * 0.955, 0, sill),
    // Cabin, set back and narrower — this is what makes it read as a car.
    taper(cabLen, roofH, wid * 0.915, wid * 0.79, cabX, sill + bodyH),
  ];
  if (bed) {
    // A pickup without bed walls is a saloon with the roof sawn off. Three
    // thin panels are enough: the load bay reads from the shadow inside it.
    const bedLen = len * 0.42;
    const bedX = -len * 0.5 + bedLen * 0.5 + 0.05;
    const bedH = roofH * 0.62;
    for (const s of [-1, 1]) {
      body.push(taper(bedLen, bedH, 0.075, 0.07, bedX, sill + bodyH).translate(0, 0, s * wid * 0.455));
    }
    body.push(taper(0.09, bedH, wid * 0.91, wid * 0.90, -len * 0.5 + 0.06, sill + bodyH));
  }
  const glass: THREE.BufferGeometry[] = [
    // Side glass, windscreen and backlight as one band standing 1 cm proud of
    // the cabin, between a painted belt line and a painted roof.
    taper(cabLen * 0.955, roofH * 0.50, wid * 0.935, wid * 0.845, cabX - len * 0.005, sill + bodyH + roofH * 0.20),
  ];
  const dark: THREE.BufferGeometry[] = [
    // Underbody, inboard of the tyres and low to the road.
    box(len * 0.90, sill - 0.13, skirtW(wid, wheelR), 0, (sill + 0.13) * 0.5),
    // Arch lips, level with the sill and barely proud of the flank.
    box(wheelR * 2.5, 0.055, wid * 1.012, len * 0.31, sill + 0.005),
    box(wheelR * 2.5, 0.055, wid * 1.012, -len * 0.31, sill + 0.005),
    box(0.15, 0.17, wid * 0.90, len * 0.475, sill + 0.06),   // bumpers
    box(0.15, 0.17, wid * 0.90, -len * 0.475, sill + 0.06),
  ];
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.34, wid * 0.34]) {
    head.push(box(0.07, 0.15, wid * 0.22, len * 0.5, sill + 0.30, z));
    tail.push(box(0.07, 0.13, wid * 0.20, -len * 0.5, sill + 0.34, z));
  }
  // A high-level brake lamp, which is what you actually pick out of a queue.
  // On a pickup it sits on the back of the cab, not out over the load bay.
  tail.push(bed
    ? box(0.05, 0.05, wid * 0.28, cabX - cabLen * 0.5, sill + bodyH + roofH * 0.80)
    : box(0.05, 0.05, wid * 0.30, -len * 0.5 + 0.02, sill + bodyH + roofH * 0.55));

  const bodyParts = [
    ...body.map((g) => tint(g, 0xffffff)),
    ...dark.map((g) => tint(g, 0x24262a)),
  ].map((g) => markWheel(g, 0, 0, 0, 0));

  // White bodywork takes the per-instance tint; everything else is baked dark
  // so the same instance colour leaves it essentially black.
  return {
    shell: merge([...bodyParts, ...axles(len * 0.31, -len * 0.31, track, wheelR)]),
    glass: merge(glass),
    light: merge([
      ...head.map((g) => markLamp(g, 0)),
      ...tail.map((g) => markLamp(g, 1)),
    ]),
  };
}

/**
 * A high box on six wheels: box truck, van, and the MBTA bus.
 *
 * Same trick as the cars — the skirt between the wheels is inboard of the
 * tyres, so what you see under a bus is a wheel rather than an unexplained
 * black void.
 */
function boxVehicle(
  len: number, wid: number, h: number, cabLen: number, glazed = 0.86,
  r = 0.46, tandem = true,
): VehicleDef['parts'] {
  const sill = r * 1.12;
  const track = trackZ(wid, r) * 2;
  const body = [
    taper(len, h, wid, wid * 0.98, 0, sill),
  ];
  // Side glass runs the length of a bus and stops at the cab on a van or a
  // box truck — glazing all three the same way is what made them read as one
  // white box in three sizes.
  const gLen = len * glazed;
  const gMid = len * 0.5 - cabLen * 0.1 - gLen * 0.5;
  const glass: THREE.BufferGeometry[] = [
    box(0.08, h * 0.30, wid * 0.88, len * 0.5, sill + h * 0.72),           // windscreen
    box(gLen, h * 0.26, 0.06, gMid, sill + h * 0.70, wid * 0.5),
    box(gLen, h * 0.26, 0.06, gMid, sill + h * 0.70, -wid * 0.5),
  ];
  const dark = [
    box(len * 0.94, sill - 0.16, skirtW(wid, r), 0, (sill + 0.16) * 0.5),  // skirt
    box(len, 0.10, wid * 1.012, 0, sill + 0.01),                           // arch line
    box(0.18, 0.24, wid * 0.9, len * 0.5, sill + 0.10),                    // bumper
  ];
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.36, wid * 0.36]) {
    head.push(box(0.07, 0.18, wid * 0.2, len * 0.5, sill + 0.34, z));
    tail.push(box(0.07, 0.20, wid * 0.18, -len * 0.5, sill + 0.48, z));
  }
  tail.push(box(0.05, 0.06, wid * 0.34, -len * 0.5 + 0.02, sill + h * 0.92));

  const bodyParts = [
    ...body.map((g) => tint(g, 0xffffff)),
    ...dark.map((g) => tint(g, 0x24262a)),
  ].map((g) => markWheel(g, 0, 0, 0, 0));

  return {
    shell: merge([
      ...bodyParts,
      ...axles(len * 0.34, -len * (tandem ? 0.25 : 0.32), track, r),
      // Second rear axle on the heavy types; a panel van has four wheels.
      ...(tandem ? [
        ...wheel(-len * 0.37, -track * 0.5, r, 1, 0x121316, 0x8f949a),
        ...wheel(-len * 0.37, track * 0.5, r, 1, 0x121316, 0x8f949a),
      ] : []),
    ]),
    glass: merge(glass),
    light: merge([
      ...head.map((g) => markLamp(g, 0)),
      ...tail.map((g) => markLamp(g, 1)),
    ]),
  };
}

/**
 * The mix on a Boston street. Weights are rough observation: mostly saloons
 * and crossovers, a fair number of pickups and vans, the occasional MBTA bus
 * and box truck, and enough yellow cabs to notice downtown.
 */
export function vehicleTypes(): VehicleDef[] {
  return [
    { name: 'sedan',    length: 4.6, width: 1.82, weight: 30, wheelbase: 2.85, wheelR: 0.32, parts: car(4.6, 1.82, 0.56, 0.52, false) },
    { name: 'hatch',    length: 4.1, width: 1.76, weight: 16, wheelbase: 2.54, wheelR: 0.32, parts: car(4.1, 1.76, 0.58, 0.56, false) },
    { name: 'crossover',length: 4.7, width: 1.88, weight: 24, wheelbase: 2.91, wheelR: 0.37, parts: car(4.7, 1.88, 0.70, 0.56, true) },
    { name: 'suv',      length: 5.1, width: 1.98, weight: 10, wheelbase: 3.16, wheelR: 0.37, parts: car(5.1, 1.98, 0.78, 0.60, true) },
    { name: 'pickup',   length: 5.6, width: 2.02, weight: 7,  wheelbase: 3.47, wheelR: 0.37, parts: car(5.6, 2.02, 0.72, 0.34, true, true) },
    { name: 'taxi',     length: 4.7, width: 1.86, weight: 4,  color: 0xe8b528, wheelbase: 2.91, wheelR: 0.32,
      parts: car(4.7, 1.86, 0.60, 0.54, false) },
    { name: 'van',      length: 5.4, width: 2.00, weight: 5,  color: 0xe8e8e6, wheelbase: 3.56, wheelR: 0.36,
      parts: boxVehicle(5.4, 2.00, 1.95, 1.6, 0.26, 0.36, false) },
    { name: 'truck',    length: 8.2, width: 2.44, weight: 2,  color: 0xd8d6d0, wheelbase: 4.84, wheelR: 0.46,
      parts: boxVehicle(8.2, 2.44, 2.5, 2.0, 0.17, 0.46) },
    // MBTA buses are white above a yellow band with a black skirt; at the
    // distance you normally see one, the pale body is the recognisable part.
    { name: 'bus',      length: 12.2, width: 2.59, weight: 2, color: 0xf0eee8, wheelbase: 7.20, wheelR: 0.50,
      parts: boxVehicle(12.2, 2.59, 2.85, 2.4, 0.82, 0.50) },
  ];
}

/** Plausible car colours: mostly greys and whites, a little real colour. */
export const CAR_COLORS: number[] = [
  0xe9e9ea, 0xe9e9ea, 0xf2f2f2, 0x2f3134, 0x2f3134, 0x1b1c1e,
  0x8c9095, 0x8c9095, 0xa8adb2, 0x5a6066, 0x6d7276,
  0x8d2f31, 0x27406b, 0x1f4f38, 0x7a5a2c, 0x35566e,
];

/**
 * Vertex-stage animation for the shell: roll every wheel by `aRoll` radians
 * and yaw the steered pair by `aSteer`. Rotating the normal as well as the
 * position matters here — a wheel whose hub face keeps a fixed shading while
 * its spokes turn looks like a decal, not a wheel.
 */
export const WHEEL_VERT_PARS = /* glsl */ `
attribute float aWheel;
attribute vec3 aWheelC;
attribute float aRoll;
attribute float aSteer;
void bhWheelSpin(inout vec3 v, float roll, float steer, bool translate) {
  float c = cos(roll), s = sin(roll);
  v.xy = vec2(v.x * c + v.y * s, -v.x * s + v.y * c);
  if (aWheel > 1.5) {
    float cs = cos(steer), ss = sin(steer);
    v.xz = vec2(v.x * cs - v.z * ss, v.x * ss + v.z * cs);
  }
  if (translate) v += aWheelC;
}
`;

export const WHEEL_VERT_POS = /* glsl */ `
if (aWheel > 0.5) {
  transformed -= aWheelC;
  bhWheelSpin(transformed, aRoll, aSteer, true);
}
`;

export const WHEEL_VERT_NRM = /* glsl */ `
if (aWheel > 0.5) bhWheelSpin(objectNormal, aRoll, aSteer, false);
`;

/* --------------------------------------------------------------- people */

/**
 * A pedestrian, as a dozen merged boxes the shader articulates.
 *
 * At the distance people are actually visible — a few tens of metres — the
 * silhouette and the walk cycle are the whole read, so the triangles go into
 * the things that carry a silhouette: a tapered torso with real shoulders, a
 * head on a neck, arms that hang beside the body rather than jutting from it,
 * thighs that meet at the hip, and shoes. Modelling a face would be triangles
 * spent where no pixel lands.
 *
 * `stride` drives the swing: 0 on the torso, +/-1 on the legs, +/-0.62 on the
 * arms so they counter-swing, and +/-1.6 on the feet so they trail the shin.
 * `aBob` is 1 on everything that rises and falls with the gait.
 */
export function pedestrianGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (
    g: THREE.BufferGeometry, stride: number, hue: number, bob = 1,
  ): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n);
    a.fill(stride);
    g.setAttribute('stride', new THREE.Float32BufferAttribute(a, 1));
    g.setAttribute('aBob', new THREE.Float32BufferAttribute(new Float32Array(n).fill(bob), 1));
    // Converted once, not twice; see `tint` above.
    const c = new THREE.Color(hue);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  };

  // Torso, in two blocks so the shoulders are wider than the waist. White so
  // the per-instance tint becomes the clothing.
  parts.push(tag(taper(0.24, 0.30, 0.33, 0.42, 0, 1.14), 0, 0xffffff));       // chest
  parts.push(tag(taper(0.21, 0.24, 0.36, 0.31, 0, 0.90), 0, 0xffffff));       // hips/waist
  parts.push(tag(box(0.10, 0.08, 0.10, 0, 1.47), 0, 0xd9bda1));               // neck
  parts.push(tag(box(0.185, 0.215, 0.175, 0, 1.615), 0, 0xf0d2b4));           // head
  // Arms hanging against the ribs, counter-swinging.
  for (const z of [-0.245, 0.245]) {
    const s = z > 0 ? -0.62 : 0.62;
    parts.push(tag(box(0.10, 0.56, 0.10, 0, 1.14, z), s, 0xffffff));
    parts.push(tag(box(0.08, 0.11, 0.085, 0.01, 0.80, z), s, 0xe8c9ab));      // hand
  }
  // Legs, hinged at the hip. 1.0 above the knee, 1.05 below it, so the shin
  // and shoe can fold back through the swing.
  for (const z of [-0.085, 0.085]) {
    const s = z > 0 ? 1 : -1;
    parts.push(tag(box(0.135, 0.42, 0.145, 0, 0.66, z), s, 0x565c66));        // thigh
    parts.push(tag(box(0.115, 0.46, 0.125, 0, 0.25, z), s * 1.05, 0x4b515a)); // shin
    parts.push(tag(box(0.235, 0.075, 0.115, 0.045, 0.038, z), s * 1.05, 0x24262b)); // shoe
  }
  return merge(parts)!;
}

/**
 * The walk cycle. Limbs swing about the hip or the shoulder, the whole body
 * lifts twice per stride, and the swing amplitude comes in per instance so a
 * hurrying commuter and someone stood at a kerb can share one mesh.
 */
export const WALK_VERT_PARS = /* glsl */ `
attribute float stride;
attribute float aBob;
attribute float aPhase;
attribute float aSwing;
`;

export const WALK_VERT_POS = /* glsl */ `
float bhAmp = abs(stride);
if (bhAmp > 0.01) {
  float bhSgn = sign(stride);
  bool bhLeg = bhAmp > 0.9;
  // Below the knee, fold back through mid-swing. A leg that swings as one
  // rigid pendulum is the thing that makes cheap crowds read as puppets.
  if (bhAmp > 1.02) {
    float knee = max(0.0, -cos(aPhase) * bhSgn) * 0.80 * aSwing;
    float dyk = transformed.y - 0.50;
    transformed.x += dyk * sin(knee);
    transformed.y = 0.50 + dyk * cos(knee);
  }
  float a = sin(aPhase) * 0.60 * aSwing * bhSgn * (bhLeg ? 1.0 : 0.72);
  float pivot = bhLeg ? 0.88 : 1.40;
  float dy = transformed.y - pivot;
  float c = cos(a), sn = sin(a);
  transformed.x += dy * sn;
  transformed.y = pivot + dy * c;
}
// Two lifts per stride, and a little sway so a standing figure is not frozen.
transformed.y += aBob * (0.022 * aSwing * (0.5 - 0.5 * cos(aPhase * 2.0))
                       + 0.005 * sin(aPhase * 0.37));
`;

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
