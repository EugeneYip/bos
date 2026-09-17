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

/** What the one shell material should do with a vertex; see {@link surf}. */
export const enum Kind {
  /** Sprayed bodywork: takes the per-instance colour, the clear coat, and
   *  the procedural shut lines. */
  paint = 0,
  /** Bumpers, sills, arch lips, underbody: matte and unlit by the coat. */
  trim = 1,
  /** Tyre carcass and tread. */
  tyre = 2,
  /** The outward face of a wheel, where the rim pattern is drawn. */
  rim = 3,
  /** Livery bands and roof bars: painted, but no panel gaps across them. */
  accent = 4,
}

/**
 * Per-vertex surface description: `(metalness, roughness, clearcoat, kind)`.
 *
 * One material draws the whole shell, so the difference between wet paint, a
 * rubber tyre and an alloy rim has to travel on the geometry. Metalness is the
 * important one and it used to be a single 0.35 for all of it: painted steel
 * is a *dielectric* under a clear coat, and giving it a third of a metal's
 * behaviour tints its specular with its own body colour. That is what made a
 * maroon car under warm street lighting come out with no green and no blue in
 * it at all — every path that could have put an achromatic highlight on it was
 * either off (there is no specular response to the street-lamp field) or
 * painted the same red as the paint.
 */
function surf(
  g: THREE.BufferGeometry, metal: number, rough: number, coat: number, kind: Kind,
): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = metal; a[i * 4 + 1] = rough; a[i * 4 + 2] = coat; a[i * 4 + 3] = kind;
  }
  g.setAttribute('aSurf', new THREE.Float32BufferAttribute(a, 4));
  return g;
}

/**
 * Where a body vertex sits inside the vehicle's own bounding box, as
 * (-1..1 along, 0..1 up, -1..1 across).
 *
 * It rides in `aWheelC`, which body vertices otherwise leave at zero, because
 * a fifth attribute stream on a mesh drawn a thousand times is not free and
 * this one is only ever read where the other is not written. It buys the shut
 * lines, the waist crease and the rocker shading in the fragment stage, at no
 * triangles and no texture — and panel gaps were the first thing named in the
 * list of what a vehicle here does not have.
 */
function markBody(
  g: THREE.BufferGeometry, halfLen: number, totalH: number, halfWid: number,
): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = p.count;
  const k = new Float32Array(n);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = p.getX(i) / halfLen;
    c[i * 3 + 1] = p.getY(i) / totalH;
    c[i * 3 + 2] = p.getZ(i) / halfWid;
  }
  g.setAttribute('aWheel', new THREE.Float32BufferAttribute(k, 1));
  g.setAttribute('aWheelC', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

/**
 * Give a lamp cluster its end tag (0 = headlamp, 1 = tail lamp) and which
 * side of the vehicle it sits on (-1 left, 0 on the centreline, +1 right, in
 * the same right-hand-side convention as the rest of this module). The side
 * is what lets one shared material blink an indicator on the correct corner
 * instead of both at once.
 */
function markLamp(g: THREE.BufferGeometry, tail: number, side = 0): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aTail', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tail), 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(new Float32Array(n).fill(side), 1));
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
function wheel(x: number, z: number, r: number, kind: number, tyre: number): THREE.BufferGeometry[] {
  const w = r * TYRE_W;
  const out = z > 0 ? 1 : -1;
  const outer = z + out * w * 0.5;
  const parts: THREE.BufferGeometry[] = [];

  // Sixteen sides, not twelve: a 0.32 m wheel ten metres away is fifty pixels
  // across and a dodecagon shows its flats along the top of the tyre.
  const t = new THREE.CylinderGeometry(r, r, w, 16, 1, true);
  t.rotateX(Math.PI / 2);
  t.translate(x, r, z);
  parts.push(markWheel(surf(tint(t, tyre), 0, 0.93, 0, Kind.tyre), kind, x, r, z));

  // Sidewall, facing outboard. The rim, its spokes and the hub used to be a
  // pale disc with two dark bars laid across it — the thing the review called
  // 'a black wheel with an X drawn in it'. They are drawn in the fragment
  // stage now, from wheel-fixed coordinates this disc carries, which costs no
  // triangles, turns with the tyre because the disc does, and can afford five
  // spokes and a rim lip instead of two bars.
  const side = new THREE.CircleGeometry(r, 16);
  if (out < 0) side.rotateY(Math.PI);
  side.translate(x, r, outer);
  parts.push(markWheel(surf(tint(side, 0x2a2c30), 0.55, 0.32, 0, Kind.rim), kind, x, r, z));

  return parts;
}

/** Four (or six) wheels: the front pair is marked steerable. */
function axles(axleF: number, axleR: number, track: number, r: number, steerFront = true): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const z of [-track / 2, track / 2]) {
    out.push(...wheel(axleF, z, r, steerFront ? 2 : 1, 0x121316));
    out.push(...wheel(axleR, z, r, 1, 0x121316));
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
  lightbar = false,
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
  const glassY = sill + bodyH + roofH * 0.20;
  const glassH = roofH * 0.50;
  const glass: THREE.BufferGeometry[] = [
    // Side glass, windscreen and backlight as one band standing 1 cm proud of
    // the cabin, between a painted belt line and a painted roof.
    taper(cabLen * 0.955, glassH, wid * 0.935, wid * 0.845, cabX - len * 0.005, glassY),
  ];
  const dark: THREE.BufferGeometry[] = [
    // Underbody, inboard of the tyres and low to the road.
    box(len * 0.90, sill - 0.13, skirtW(wid, wheelR), 0, (sill + 0.13) * 0.5),
    // Arch lips, level with the sill and barely proud of the flank.
    box(wheelR * 2.5, 0.055, wid * 1.012, len * 0.31, sill + 0.005),
    box(wheelR * 2.5, 0.055, wid * 1.012, -len * 0.31, sill + 0.005),
    box(0.15, 0.17, wid * 0.90, len * 0.475, sill + 0.06),   // bumpers
    box(0.15, 0.17, wid * 0.90, -len * 0.475, sill + 0.06),
    // Grille: a dark inset across the nose above the bumper. One box, and
    // without it the front of every car in the city was a blank painted wall.
    box(0.06, bodyH * 0.30, wid * 0.62, len * 0.5 + 0.03, sill + bodyH * 0.58),
  ];
  // A B-pillar through the glazing. The window band was one continuous slot
  // from windscreen to backlight, which is the single strongest reason a car
  // at 10 m read as a box with a stripe painted on it.
  const pillars: THREE.BufferGeometry[] = [
    box(0.055, glassH * 1.04, wid * 0.95, cabX - cabLen * 0.06, glassY + glassH * 0.5),
  ];
  // Door mirrors. Small, but they are the only part of a car that breaks its
  // own silhouette, and a shape with no bits sticking out of it does not read
  // as a machine.
  const mirrors: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    mirrors.push(box(0.055, 0.075, 0.13, cabX + cabLen * 0.44, glassY + glassH * 0.62, s * wid * 0.56));
    mirrors.push(box(0.03, 0.045, 0.075, cabX + cabLen * 0.44, glassY + glassH * 0.62, s * wid * 0.615));
  }
  // Number plates, at both ends, above the bumper.
  const plates: THREE.BufferGeometry[] = [
    box(0.035, 0.105, 0.44, len * 0.5 + 0.045, sill + 0.19),
    box(0.035, 0.105, 0.44, -len * 0.5 - 0.045, sill + 0.19),
  ];
  // Head and tail lamps carry both their end (0/1) and which side of the
  // vehicle they sit on, so a shared material can blink an indicator on just
  // the correct corner. The high-level brake lamp sits on the centreline —
  // side 0 — so it never reads as an indicator.
  const lamps: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.34, wid * 0.34]) {
    const side = Math.sign(z);
    lamps.push(markLamp(box(0.07, 0.15, wid * 0.22, len * 0.5, sill + 0.30, z), 0, side));
    lamps.push(markLamp(box(0.07, 0.13, wid * 0.20, -len * 0.5, sill + 0.34, z), 1, side));
  }
  // A high-level brake lamp, which is what you actually pick out of a queue.
  // On a pickup it sits on the back of the cab, not out over the load bay.
  lamps.push(markLamp(bed
    ? box(0.05, 0.05, wid * 0.28, cabX - cabLen * 0.5, sill + bodyH + roofH * 0.80)
    : box(0.05, 0.05, wid * 0.30, -len * 0.5 + 0.02, sill + bodyH + roofH * 0.55), 1, 0));

  const totalH = sill + bodyH + roofH + (lightbar ? 0.09 : 0);
  const bodyParts = [
    ...body.map((g) => surf(tint(g, 0xffffff), 0.02, 0.30, 1, Kind.paint)),
    ...pillars.map((g) => surf(tint(g, 0xffffff), 0.02, 0.32, 1, Kind.accent)),
    ...mirrors.map((g) => surf(tint(g, 0xffffff), 0.02, 0.34, 1, Kind.accent)),
    ...plates.map((g) => surf(tint(g, 0xdfe0dc), 0.0, 0.55, 0, Kind.accent)),
    ...dark.map((g) => surf(tint(g, 0x24262a), 0.05, 0.62, 0.15, Kind.trim)),
    // A roof light bar reads as a police car at any distance a badge would
    // not. Painted, not emissive — it shares the shell's one draw call
    // rather than costing the light material a special case.
    ...(lightbar ? [
      surf(tint(box(0.30, 0.065, wid * 0.62, cabX, sill + bodyH + roofH + 0.01), 0x17181b), 0.1, 0.5, 0.2, Kind.accent),
      surf(tint(box(0.26, 0.075, wid * 0.28, cabX, sill + bodyH + roofH + 0.045, -wid * 0.16), 0xb0242a), 0, 0.2, 0.6, Kind.accent),
      surf(tint(box(0.26, 0.075, wid * 0.28, cabX, sill + bodyH + roofH + 0.045, wid * 0.16), 0x1c3f8f), 0, 0.2, 0.6, Kind.accent),
    ] : []),
  ].map((g) => markBody(g, len * 0.5, totalH, wid * 0.5));

  // White bodywork takes the per-instance tint; everything else is baked dark
  // so the same instance colour leaves it essentially black.
  return {
    shell: merge([...bodyParts, ...axles(len * 0.31, -len * 0.31, track, wheelR)]),
    glass: merge(glass),
    light: merge(lamps),
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
  r = 0.46, tandem = true, transit = false,
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
  // MBTA livery: a painted waist band between the skirt and the glazing.
  // Cheap to add — one more vertex-tinted box merged into the shell that
  // already exists — and it is the one cue that reads as "that's a T bus"
  // rather than a generic white box at the distance buses are usually seen.
  const accent = transit ? [box(len * 0.90, h * 0.14, wid * 1.014, 0, sill + h * 0.34)] : [];
  const lamps: THREE.BufferGeometry[] = [];
  for (const z of [-wid * 0.36, wid * 0.36]) {
    const side = Math.sign(z);
    lamps.push(markLamp(box(0.07, 0.18, wid * 0.2, len * 0.5, sill + 0.34, z), 0, side));
    lamps.push(markLamp(box(0.07, 0.20, wid * 0.18, -len * 0.5, sill + 0.48, z), 1, side));
  }
  lamps.push(markLamp(box(0.05, 0.06, wid * 0.34, -len * 0.5 + 0.02, sill + h * 0.92), 1, 0));

  // Mirrors stand well out from a van or a bus, and a grille and a plate sit
  // under the windscreen. Same reasoning as on the cars: three small boxes
  // are what stop the front of a box vehicle being a blank painted wall.
  const fittings: THREE.BufferGeometry[] = [
    box(0.05, h * 0.18, wid * 0.58, len * 0.5 + 0.03, sill + h * 0.42),
  ];
  const mirrorArms: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    mirrorArms.push(box(0.05, 0.30, 0.10, len * 0.5 - 0.10, sill + h * 0.70, s * wid * 0.58));
  }
  const plates: THREE.BufferGeometry[] = [
    box(0.035, 0.11, 0.46, len * 0.5 + 0.05, sill + 0.24),
    box(0.035, 0.11, 0.46, -len * 0.5 - 0.035, sill + 0.30),
  ];
  const totalH = sill + h;
  const bodyParts = [
    ...body.map((g) => surf(tint(g, 0xffffff), 0.02, 0.36, 0.85, Kind.paint)),
    ...accent.map((g) => surf(tint(g, 0xffc72c), 0.02, 0.40, 0.7, Kind.accent)),
    ...mirrorArms.map((g) => surf(tint(g, 0x2c2e32), 0.05, 0.45, 0.5, Kind.accent)),
    ...plates.map((g) => surf(tint(g, 0xdfe0dc), 0.0, 0.55, 0, Kind.accent)),
    ...fittings.map((g) => surf(tint(g, 0x1e2024), 0.2, 0.5, 0.2, Kind.trim)),
    ...dark.map((g) => surf(tint(g, 0x24262a), 0.05, 0.62, 0.15, Kind.trim)),
  ].map((g) => markBody(g, len * 0.5, totalH, wid * 0.5));

  return {
    shell: merge([
      ...bodyParts,
      ...axles(len * 0.34, -len * (tandem ? 0.25 : 0.32), track, r),
      // Second rear axle on the heavy types; a panel van has four wheels.
      ...(tandem ? [
        ...wheel(-len * 0.37, -track * 0.5, r, 1, 0x121316),
        ...wheel(-len * 0.37, track * 0.5, r, 1, 0x121316),
      ] : []),
    ]),
    glass: merge(glass),
    light: merge(lamps),
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
    // distance you normally see one, the pale body and the band are what's
    // recognisable.
    { name: 'bus',      length: 12.2, width: 2.59, weight: 2, color: 0xf0eee8, wheelbase: 7.20, wheelR: 0.50,
      parts: boxVehicle(12.2, 2.59, 2.85, 2.4, 0.82, 0.50, true, true) },
    // A marked cruiser: same shell as the SUV, plus a roof light bar. Common
    // enough to notice, not so common it reads as a checkpoint.
    { name: 'police',   length: 5.1, width: 1.98, weight: 1.3, color: 0xf5f4f0, wheelbase: 3.16, wheelR: 0.37,
      parts: car(5.1, 1.98, 0.78, 0.60, true, false, true) },
    // Boston Duck Tours' amphibious DUKWs: boxy, high-sided, mostly open
    // rather than glazed, and a colour nothing else in the mix wears. Rare
    // by design — the real fleet is a couple of dozen vehicles on a handful
    // of routes, not a tenth of the traffic.
    { name: 'duckboat', length: 10.7, width: 2.44, weight: 0.5, color: 0x5c6b3f, wheelbase: 5.6, wheelR: 0.52,
      parts: boxVehicle(10.7, 2.44, 2.75, 2.1, 0.10, 0.52, true) },
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
attribute vec4 aSurf;
attribute float aRoll;
attribute float aSteer;
varying vec4 vBhSurf;
varying vec4 vBhLocal;
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
vBhSurf = aSurf;
if (aWheel > 0.5) {
  // Wheel-fixed coordinates, normalised by the rolling radius -- which is the
  // wheel centre's own height above the road, so no extra attribute is needed
  // to carry it. The rim pattern painted in these turns with the tyre because
  // the vertices carrying them do.
  vBhLocal = vec4((transformed - aWheelC) / max(aWheelC.y, 0.05), 0.0);
  transformed -= aWheelC;
  bhWheelSpin(transformed, aRoll, aSteer, true);
} else {
  // Body vertices: where they sit in the vehicle's own box, plus how
  // side-facing they are, which is what selects a flank for a shut line.
  vBhLocal = vec4(aWheelC, abs(objectNormal.z));
}
`;

export const WHEEL_VERT_NRM = /* glsl */ `
if (aWheel > 0.5) bhWheelSpin(objectNormal, aRoll, aSteer, false);
`;

/** Declarations the shell's fragment stage needs. */
export const SHELL_FRAG_PARS = /* glsl */ `
varying vec4 vBhSurf;
varying vec4 vBhLocal;
uniform float uCoatSky;
uniform float uCoatLamp;
`;

/** …and the glazing's. */
export const GLASS_FRAG_PARS = /* glsl */ `
uniform float uGlassSky;
uniform float uGlassLamp;
`;

/**
 * Roughness and metalness per vertex rather than per material.
 *
 * One `InstancedMesh` draws the paint, the bumpers, the alloys and the tyres,
 * so a single `metalness` on the material has to be wrong for three of them.
 * It was 0.35 for all of it: too metallic for paint, which is what tinted
 * every highlight with the body colour, and far too metallic for rubber.
 */
export const SHELL_FRAG_ROUGH = /* glsl */ `
roughnessFactor = vBhSurf.y;
`;
export const SHELL_FRAG_METAL = /* glsl */ `
metalnessFactor = vBhSurf.x;
`;

/**
 * Everything the shell's albedo gets that is finer than a vertex.
 *
 * Two patterns, both free of triangles and of texture memory, both driven by
 * coordinates the vertex stage already had to compute:
 *
 *   *The wheel face.* Five spokes, a rim lip and a hub, drawn in polar
 *   coordinates on the outboard sidewall disc. This replaces a pale disc with
 *   two dark bars laid over it — 34 triangles per wheel that read, accurately,
 *   as an X scrawled on a black circle.
 *
 *   *Panel gaps.* Two door shuts, a waist crease and a darker rocker down
 *   each flank. A car's flank is otherwise one flat quadrilateral of paint
 *   several metres long, and nothing else in this model says where the doors
 *   are.
 */
export const SHELL_FRAG_COLOR = /* glsl */ `
// Every test here is a closed interval on 'Kind', because 'Kind.accent' is 4
// and sits above both of the others: an open 'greater than 2.5' painted the
// alloy pattern over every B-pillar, mirror, number plate and livery band on
// the fleet, and an open 'greater than 1.5' then painted the survivors black
// rubber. A plate is off-white and a cruiser's light bar is red and blue;
// both were coming out the colour of a tyre.
if (vBhSurf.w > 2.5 && vBhSurf.w < 3.5) {
  float bhR = length(vBhLocal.xy);
  float bhA = atan(vBhLocal.y, vBhLocal.x);
  float bhLobe = abs(cos(bhA * 2.5));
  float bhDish = smoothstep(0.66, 0.60, bhR) * smoothstep(0.13, 0.17, bhR);
  float bhSpoke = smoothstep(0.42, 0.72, bhLobe) * bhDish;
  float bhLip = smoothstep(0.80, 0.72, bhR) - smoothstep(0.68, 0.60, bhR);
  float bhHub = smoothstep(0.20, 0.15, bhR);
  vec3 bhAlloy = vec3(0.335, 0.350, 0.372);
  vec3 bhFace = vec3(0.0105, 0.0112, 0.0125);
  bhFace = mix(bhFace, bhAlloy * 0.80, clamp(bhSpoke + bhHub, 0.0, 1.0));
  bhFace = mix(bhFace, bhAlloy, clamp(bhLip, 0.0, 1.0));
  bhFace = mix(bhFace, vec3(0.016, 0.017, 0.019), smoothstep(0.085, 0.050, bhR));
  diffuseColor.rgb = bhFace;
} else if (vBhSurf.w > 1.5 && vBhSurf.w < 2.5) {
  // Rubber, not a dark shade of the body colour: the tyre used to take the
  // per-instance tint like everything else, so a red car rolled on red tyres.
  diffuseColor.rgb = vec3(0.0135, 0.0140, 0.0152);
} else if (vBhSurf.w < 0.5) {
  float bhSide = smoothstep(0.52, 0.86, vBhLocal.w);
  float bhGap = 1.0 - smoothstep(0.004, 0.016,
    min(abs(vBhLocal.x - 0.10), abs(vBhLocal.x + 0.30)));
  float bhCrease = 1.0 - smoothstep(0.010, 0.032, abs(vBhLocal.y - 0.46));
  float bhRocker = 1.0 - smoothstep(0.26, 0.33, vBhLocal.y);
  diffuseColor.rgb *= 1.0 - bhSide * (0.70 * bhGap + 0.13 * bhCrease + 0.26 * bhRocker);
}
`;

/**
 * The clear coat, and the specular response to Boston's street lighting.
 *
 * Both are missing from the stock path and between them they are the whole of
 * defect #6. Painted steel is a dielectric under a transparent coat: its
 * highlight is the colour of the *light*, not of the paint. The material used
 * to ask for `metalness: 0.35`, which tints the highlight with the body
 * colour, and the only light after dark is `skyStreetLight`, which the sky
 * module adds to the diffuse gather and nothing else. So a maroon van at
 * night had a red diffuse term, a red specular term, and nothing achromatic
 * anywhere — and ACES maps a colour with no green or blue in it to a colour
 * with none out, which is how its paint measured (67, 1, 1).
 *
 * `skyApRadiance` is the same sky-view table the dome is drawn from, so what
 * a windscreen reflects at noon is the sky that is actually above it.
 */
export const SHELL_FRAG_LIGHT = /* glsl */ `
#if defined( SKY_AERIAL ) && defined( USE_FOG )
{
  float bhCoat = vBhSurf.z;
  if (bhCoat > 0.001) {
    vec3 bhNw = normalize(uApViewToWorld * geometryNormal);
    vec3 bhVw = normalize(uApViewToWorld * geometryViewDir);
    float bhFres = 0.04 + 0.96 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
    vec3 bhSky = skyApRadiance(reflect(-bhVw, bhNw), vBhSurf.y * 0.6);
    // 'skyStreetLight' answers an irradiance, because every other caller adds
    // it to the diffuse gather where three divides by pi on the way out. A
    // specular lobe fed the same number unconverted is pi times too bright,
    // which turned a pickup under a shop window into a white cut-out.
    vec3 bhLamp = skyStreetLight(cameraPosition + skyApOffset(vFogViewPos), bhNw)
                * RECIPROCAL_PI;
    reflectedLight.indirectSpecular +=
      bhCoat * bhFres * (bhSky * uCoatSky + bhLamp * uCoatLamp);
  }
}
#endif
`;

/**
 * Glass, lit the same way. A window is not a black rectangle: by day it
 * mirrors the sky, by night it picks up the lamps, and either way the Fresnel
 * ramp across a curved screen is most of what says 'glass' at 10 m.
 */
export const GLASS_FRAG_LIGHT = /* glsl */ `
#if defined( SKY_AERIAL ) && defined( USE_FOG )
{
  vec3 bhNw = normalize(uApViewToWorld * geometryNormal);
  vec3 bhVw = normalize(uApViewToWorld * geometryViewDir);
  float bhFres = 0.04 + 0.96 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
  vec3 bhSky = skyApRadiance(reflect(-bhVw, bhNw), 0.035);
  vec3 bhLamp = skyStreetLight(cameraPosition + skyApOffset(vFogViewPos), bhNw)
              * RECIPROCAL_PI;
  reflectedLight.indirectSpecular += bhFres * (bhSky * uGlassSky + bhLamp * uGlassLamp);
}
#endif
`;

/* --------------------------------------------------------------- people */

/**
 * A pedestrian, as twenty-one merged boxes the shader articulates, colours
 * and draws a face on.
 *
 * At the distance people are actually visible — a few tens of metres — the
 * silhouette and the walk cycle are the whole read, so the triangles go into
 * the things that carry a silhouette: a tapered torso with real shoulders, a
 * head on a neck, arms that hang beside the body rather than jutting from it,
 * thighs that meet at the hip, and shoes. The face is the exception and it is
 * not modelled: at eight metres a head is forty-five pixels and eyes are the
 * difference between a person and a mannequin, so they are drawn in the
 * fragment stage, where they cost no triangles and can fade themselves out
 * when the head is too small to carry them.
 *
 * `stride` drives the swing: 0 on the torso, +/-1 on the thighs, +/-1.05
 * below the knee so the shin and shoe fold back, and +/-0.62 on the arms so
 * they counter-swing. `aBob` is 1 on everything that rises and falls with the
 * gait. `aSkin` says what a vertex is wearing, and carries head-local
 * coordinates for the face; see {@link WALK_VERT_COLOR} and
 * {@link WALK_FRAG_COLOR}.
 */
export function pedestrianGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  /**
   * @param shade  Multiplier on whichever colour this part ends up wearing —
   *   white for the face and the body of a coat, less for a sleeve, a collar
   *   or a trouser leg. It is not the colour itself: clothing takes the
   *   per-instance tint and skin takes a per-instance skin tone, and both
   *   arrive after this.
   * @param mask   0 coat, 1 skin, 2 hair, 3 trousers. See
   *   {@link WALK_VERT_COLOR}.
   */
  const tag = (
    g: THREE.BufferGeometry, stride: number, shade: number, mask = 0, bob = 1,
  ): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    g.setAttribute('stride', new THREE.Float32BufferAttribute(new Float32Array(n).fill(stride), 1));
    g.setAttribute('aBob', new THREE.Float32BufferAttribute(new Float32Array(n).fill(bob), 1));
    const c = new THREE.Color(shade);
    const col = new Float32Array(n * 3);
    const skin = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      skin[i * 4] = mask;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aSkin', new THREE.Float32BufferAttribute(skin, 4));
    return g;
  };

  /**
   * Head-local coordinates in the unused three channels of `aSkin`, so the
   * fragment stage can put a face on the front plane of the head without a
   * texture, a UV set or a single extra triangle. Normalised to -1..1 over
   * the head box, and zero everywhere else, which is what keeps a hand or a
   * neck from growing eyes.
   */
  const faceCoords = (
    g: THREE.BufferGeometry, cx: number, cy: number, hx: number, hy: number, hz: number,
  ): THREE.BufferGeometry => {
    const p = g.getAttribute('position');
    const a = g.getAttribute('aSkin') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      a.setY(i, (p.getX(i) - cx) / hx);
      a.setZ(i, (p.getY(i) - cy) / hy);
      a.setW(i, p.getZ(i) / hz);
    }
    return g;
  };

  // Torso, in two blocks so the shoulders are wider than the waist. The coat
  // body is left at full strength and the skirt below the waist is knocked
  // back a little, because a coat that is one flat value from collar to hem
  // is the single largest area of this figure and it was reading as a poncho.
  parts.push(tag(taper(0.24, 0.30, 0.33, 0.42, 0, 1.14), 0, 0xffffff));       // chest
  parts.push(tag(taper(0.21, 0.24, 0.36, 0.31, 0, 0.90), 0, 0xe0e0e0));       // hips/waist
  // Collar: a darker band across the top of the chest. Three centimetres of
  // geometry, and it is what separates a head from a torso at fifty metres.
  parts.push(tag(box(0.255, 0.05, 0.345, 0, 1.418), 0, 0x9aa0a6));
  parts.push(tag(box(0.10, 0.085, 0.10, 0, 1.468), 0, 0xd8d8d8, 1));          // neck
  const head = tag(box(0.185, 0.205, 0.158, 0, 1.612), 0, 0xffffff, 1);
  parts.push(faceCoords(head, 0, 1.612, 0.0925, 0.1025, 0.079));
  // Hair: a cap over the crown and a slab down the back of the skull, left
  // as its own tone rather than the coat's. A bare skin-coloured cube is the
  // thing that made these read as dolls more than anything else about them.
  parts.push(tag(box(0.197, 0.068, 0.170, -0.006, 1.700), 0, 0xffffff, 2));
  parts.push(tag(box(0.055, 0.150, 0.170, -0.077, 1.638), 0, 0xd2d2d2, 2));
  // Arms hanging against the ribs, counter-swinging. Set a shade below the
  // chest and a centimetre further out: same cloth, but a sleeve that is
  // exactly the value of the chest behind it has no edge, and the arm and the
  // body merged into one slab with a crease drawn on it.
  for (const z of [-0.255, 0.255]) {
    const s = z > 0 ? -0.62 : 0.62;
    parts.push(tag(box(0.10, 0.50, 0.10, 0, 1.17, z), s, 0xd4d4d4));         // sleeve
    parts.push(tag(box(0.095, 0.055, 0.095, 0, 0.905, z), s, 0x8d9298));     // cuff
    parts.push(tag(box(0.08, 0.115, 0.085, 0.01, 0.815, z), s, 0xf2f2f2, 1)); // hand
  }
  // Legs, hinged at the hip. 1.0 above the knee, 1.05 below it, so the shin
  // and shoe can fold back through the swing. Trousers get their own tone
  // rather than a dark shade of the coat: nobody's trousers match their coat,
  // and a figure in one hue from collar to ankle is a doll however many
  // values it is broken into.
  for (const z of [-0.085, 0.085]) {
    const s = z > 0 ? 1 : -1;
    parts.push(tag(box(0.135, 0.42, 0.145, 0, 0.66, z), s, 0xffffff, 3));        // thigh
    parts.push(tag(box(0.115, 0.46, 0.125, 0, 0.25, z), s * 1.05, 0xeeeeee, 3)); // shin
    parts.push(tag(box(0.235, 0.062, 0.115, 0.045, 0.045, z), s * 1.05, 0x3c4046, 3)); // shoe
    parts.push(tag(box(0.245, 0.018, 0.122, 0.048, 0.010, z), s * 1.05, 0x8c9299, 3)); // sole
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
attribute vec4 aSkin;
attribute float aTone;
varying vec4 vPedSkin;

/**
 * Skin, from a per-instance 0..1. Three linear-sRGB control points through
 * the range a Boston street actually contains, not a hue rotation of one
 * colour, because the thing that reads wrong is the *value* relationship
 * between a face and a coat, and a ramp that only moves the hue keeps every
 * face at the same lightness.
 */
vec3 bhSkinTone(float t) {
  // These are diffuse albedos, and they used to start at 0.871 linear in the
  // red, which is brighter than white paint and about what fresh snow
  // returns. That is the 'paper doll' in the review, restated as a number: a
  // face and a pair of hands rendering as cut paper, 143 luma against a
  // pavement at 39 in the same lamp light, so the only parts of a figure with
  // any contrast in them were the ones floating clear of the coat. Measured
  // skin sits between 0.44 and 0.06 linear across the range, and reflectance
  // that high does not exist on a person.
  vec3 a = vec3(0.447, 0.316, 0.247);
  vec3 b = vec3(0.225, 0.132, 0.089);
  vec3 c = vec3(0.062, 0.036, 0.025);
  return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, (t - 0.5) * 2.0);
}

/**
 * Hair. Most of the range is black to dark brown, the top of it is grey
 * rather than blond, and the light-brown control point sits high up because
 * under a July sun at this latitude anything above it reads platinum.
 */
vec3 bhHairTone(float t) {
  vec3 a = vec3(0.0108, 0.0079, 0.0060);
  vec3 b = vec3(0.0426, 0.0231, 0.0125);
  vec3 c = vec3(0.148, 0.082, 0.032);
  vec3 d = vec3(0.324, 0.306, 0.281);
  if (t < 0.58) return mix(a, b, t / 0.58);
  if (t < 0.90) return mix(b, c, (t - 0.58) / 0.32);
  return mix(c, d, (t - 0.90) / 0.10);
}

/**
 * Trousers, skirts and boots: five dark neutrals plus a denim, picked rather
 * than blended, because a continuous ramp through them passes through colours
 * nobody wears on the way.
 */
vec3 bhLegTone(float t) {
  int i = int(floor(t * 6.0));
  if (i <= 0) return vec3(0.0152, 0.0170, 0.0206);   // black
  if (i == 1) return vec3(0.0331, 0.0372, 0.0447);   // charcoal
  if (i == 2) return vec3(0.0331, 0.0508, 0.0865);   // denim
  if (i == 3) return vec3(0.0865, 0.0908, 0.0995);   // mid grey
  if (i == 4) return vec3(0.1274, 0.1096, 0.0762);   // khaki
  return vec3(0.0422, 0.0561, 0.0410);               // olive
}
`;

/**
 * Where the per-instance clothing tint stops.
 *
 * `instanceColor` multiplies the whole figure, head included, so a walker in
 * a green coat had a green face and a walker in a charcoal one was a black
 * cut-out from hat to boot. That is also why the clothing palette had been
 * lifted into a range no one in Boston wears: it was the only way to keep the
 * faces from going black, and it is what left a pedestrian reading three
 * times brighter than the lawn behind them in the same light. Masking the
 * tint off skin and hair lets the coats go back down to real values.
 */
export const WALK_VERT_COLOR = /* glsl */ `
vPedSkin = aSkin;
if (aSkin.x > 0.5) {
  // One per-instance float feeds all three, decorrelated by different
  // multiples of it, so a crowd is not fifteen copies of one person with
  // fifteen coats on.
  vec3 bhTone = aSkin.x > 2.5 ? bhLegTone(fract(aTone * 3.41 + 0.68))
    : aSkin.x > 1.5 ? bhHairTone(fract(aTone * 7.13 + 0.37))
    : bhSkinTone(aTone);
  vColor.rgb = color.rgb * bhTone;
}
`;

/** Declarations the walker's fragment stage needs. */
export const WALK_FRAG_PARS = /* glsl */ `
varying vec4 vPedSkin;
uniform float uWalkSky;
uniform float uWalkLamp;
`;

/**
 * A sheen on cloth and skin, so a person has a contour after dark.
 *
 * The walkers were a plain standard material: roughness 0.78, metalness 0,
 * no environment map bound, and therefore no specular term of any kind at
 * night. The sun is the only direct light and it is below the horizon; the
 * one thing left is the street-lamp field, which the sky module adds to the
 * diffuse gather and nothing else. So a figure in a dark coat measured 11.3
 * luma with a standard deviation of 2.07 across the whole torso — a flat
 * black cut-out standing on a pavement at 39, with a face and two hands on
 * it as the only things carrying any contrast. That reads as a mask and a
 * pair of gloves floating in the dark, which is most of what made these
 * unusable at street level.
 *
 * Cloth is a dielectric, so its sheen is the colour of the light rather than
 * of the dye, and it is strongest at grazing incidence — on a person that is
 * the shoulders, the outside of the arms and the edge of a coat, which is
 * exactly the contour that has to separate a figure from what is behind it.
 * The roughness handed to the sky lookup is high because a wool coat is not
 * a windscreen: what it returns is the average of a wide cone of sky, not an
 * image of it.
 *
 * This is the same construction the car shell got for defect #6; see
 * {@link SHELL_FRAG_LIGHT}, including the reciprocal-pi correction on the
 * lamp field.
 */
export const WALK_FRAG_LIGHT = /* glsl */ `
#if defined( SKY_AERIAL ) && defined( USE_FOG )
{
  vec3 bhNw = normalize(uApViewToWorld * geometryNormal);
  vec3 bhVw = normalize(uApViewToWorld * geometryViewDir);
  float bhFres = 0.028 + 0.972 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
  vec3 bhSky = skyApRadiance(reflect(-bhVw, bhNw), 0.62);
  // 'skyStreetLight' answers an irradiance, because every other caller adds
  // it to the diffuse gather where three divides by pi on the way out. A
  // specular lobe fed the same number unconverted is pi times too bright.
  vec3 bhLamp = skyStreetLight(cameraPosition + skyApOffset(vFogViewPos), bhNw)
              * RECIPROCAL_PI;
  reflectedLight.indirectSpecular += bhFres * (bhSky * uWalkSky + bhLamp * uWalkLamp);
}
#endif
`;

/**
 * A face, on the front plane of the head, out of the head-local coordinates
 * the vertex stage already carries.
 *
 * At the eight metres the review measured, a head is about forty-five pixels
 * tall and an eye is seven of them — plenty to read, and the difference
 * between a person and a mannequin. It is drawn rather than modelled because
 * the triangles would be invisible: what registers at this range is two dark
 * marks, a brow and a mouth, and those are three smoothsteps.
 *
 * `fwidth` on the head-local vertical gives head-local units per pixel, which
 * is a direct measure of how large the head is on screen, so the face fades
 * out by itself at about twenty-five metres rather than boiling into
 * aliasing noise across a crowd.
 */
export const WALK_FRAG_COLOR = /* glsl */ `
if (vPedSkin.x > 0.5 && vPedSkin.x < 1.5 && vPedSkin.y > 0.5) {
  float bhNear = 1.0 - smoothstep(0.055, 0.155, fwidth(vPedSkin.z));
  if (bhNear > 0.01) {
    float bhFront = smoothstep(0.86, 0.97, vPedSkin.y);
    vec2 bhE = vec2(abs(vPedSkin.w) - 0.42, (vPedSkin.z - 0.20) * 1.35);
    float bhEye = 1.0 - smoothstep(0.09, 0.19, length(bhE));
    float bhBrow = (1.0 - smoothstep(0.04, 0.14, abs(vPedSkin.z - 0.40)))
                 * (1.0 - smoothstep(0.52, 0.72, abs(vPedSkin.w)));
    float bhMouth = (1.0 - smoothstep(0.03, 0.09, abs(vPedSkin.z + 0.42)))
                  * (1.0 - smoothstep(0.20, 0.33, abs(vPedSkin.w)));
    diffuseColor.rgb *= 1.0 - bhNear * bhFront
      * (0.74 * bhEye + 0.26 * bhBrow + 0.34 * bhMouth);
  }
}
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
 * Clothing colours: outerwear, as worn.
 *
 * These used to be lifted well above anything on a real street, because the
 * per-instance tint multiplied the whole figure including the face, so a
 * charcoal coat produced a charcoal person. It also made a walker measure
 * three times the brightness of the lawn behind them under the same sun,
 * which is an albedo a coat does not have. Skin and hair now sit outside the
 * tint (see `WALK_VERT_COLOR`), so the coats can be coats.
 */
export const CLOTHES: number[] = [
  0x353b43, 0x454b53, 0x2a2f37, 0x585e66, 0x757b84,
  0x8c5638, 0x9298a0, 0xb4b7bb, 0x2e4c62, 0x6d383d,
  0x3a5a43, 0xb9b3a4, 0x655b7a, 0x8a5733, 0x46617b,
];
