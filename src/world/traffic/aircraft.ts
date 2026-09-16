/**
 * Air traffic over Logan.
 *
 * Boston's runways sit on made land east of downtown, so almost every arrival
 * and departure crosses water in full view of the city — which makes aircraft
 * the cheapest life you can add to an aerial shot. Six tracks, ten aircraft,
 * about nine draw calls.
 *
 * The tracks are the real ones, taken from the runway centrelines in the area
 * data and flown at real gradients: a 3-degree glideslope inbound, roughly 8%
 * on climb-out, 72 m/s over the threshold. Runway 4R's approach comes up the
 * harbour from the south-south-west; 22L's departure goes back out the same
 * way; 27's climbs west across the inner harbour and straight over downtown,
 * which is why it shows up in nearly every waterside view.
 *
 * Everything that moves on the airframes — gear retraction, rotors, strobes —
 * is a vertex or fragment attribute, so the CPU does nothing per frame but
 * write one matrix per aircraft.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Context';
import { loadAreas } from '../../core/data';
import { buildLoganLayout, type LoganLayout } from '../airport/layout';
import { buildPavement } from '../airport/pavement';
import { buildMarkings } from '../airport/markings';
import { buildLights, type AirfieldLights } from '../airport/lights';
import { buildJetBridges, computeGateStands, type GateStand } from '../airport/gates';
import { GroundFleet } from '../airport/groundTraffic';

export type AirPart = 'body' | 'glass' | 'light';

/** Static parked aircraft at Logan's gates, all narrowbody for simplicity. */
const PARKED_COUNT = 10;
/** The featured ground-cycle fleet: [narrowbody, widebody]. */
const GROUND_COUNTS: readonly [number, number] = [2, 1];

export interface AirDef {
  name: string;
  /** Wingspan, metres — only used for the report. */
  span: number;
  /** True for the helicopter, which flies its own kind of track. */
  rotary: boolean;
  parts: Record<AirPart, THREE.BufferGeometry | null>;
}

const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  const o = g.index ? g.toNonIndexed() : g;
  if (o !== g) g.dispose();
  return o;
};
const merge = (gs: THREE.BufferGeometry[]): THREE.BufferGeometry | null =>
  gs.length ? mergeGeometries(gs.map(flat), false) : null;

function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  // Converted once: `new THREE.Color(hex)` already does it. See
  // `traffic/vehicles.ts#tint` for what doing it twice costs.
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}

/**
 * Tag a group for the animation shader. `kind`: 0 fixed, 1 undercarriage
 * (folds into the belly), 2 main rotor, 3 tail rotor. `p` is the pivot.
 */
function rig(
  g: THREE.BufferGeometry, kind: number, px = 0, py = 0, pz = 0,
): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aRig', new THREE.Float32BufferAttribute(new Float32Array(n).fill(kind), 1));
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz; }
  g.setAttribute('aRigP', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

function lamp(g: THREE.BufferGeometry, kind: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aLamp', new THREE.Float32BufferAttribute(new Float32Array(n).fill(kind), 1));
  return g;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

/** Signed area of a quad, for detecting a mirrored corner list. */
function shoelace(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const q = p[(i + 1) % 4];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a;
}

/**
 * A solid from four planform corners in (x,z) plus a thickness in y: wings and
 * tailplanes, at eight positioned corners rather than an extruded outline.
 */
function planform(pts: [number, number][], thick: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, thick, 1);
  // The box's own corners wind one way; a mirrored panel handed in the same
  // order winds the other, and its normals come out inside-out.
  if (shoelace(pts) < 0) pts = [pts[3], pts[2], pts[1], pts[0]];
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i) > 0;
    const sz = pos.getZ(i) > 0;
    const c = sx ? (sz ? pts[1] : pts[0]) : (sz ? pts[2] : pts[3]);
    pos.setX(i, c[0]);
    pos.setZ(i, c[1]);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, y, 0);
  return g;
}

/** The same, upright: four corners in (x,y) with the thickness across. */
function fin(pts: [number, number][], thick: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, thick);
  if (shoelace(pts) < 0) pts = [pts[3], pts[2], pts[1], pts[0]];
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i) > 0;
    const sy = pos.getY(i) > 0;
    const c = sx ? (sy ? pts[1] : pts[0]) : (sy ? pts[2] : pts[3]);
    pos.setX(i, c[0]);
    pos.setY(i, c[1]);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Fuselage: a tube along +X with a rounded nose and a lifted tail cone. */
function fuselage(len: number, r: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 10, 7, true);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + len / 2) / len;                 // 0 tail .. 1 nose
    let k = 1;
    if (t > 0.86) k = Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.86) / 0.14, 2)));
    else if (t < 0.16) k = 0.04 + 0.96 * (t / 0.16);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
    // The tail cone sweeps upward, which is most of an airliner's rear read.
    // Pre-rotation +X becomes -Y, so this subtracts to lift it.
    if (t < 0.16) pos.setX(i, pos.getX(i) - (1 - t / 0.16) * r * 0.95);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.rotateZ(-Math.PI / 2);                          // axis +Y -> +X
  return g;
}

/**
 * An airliner. `scale` is roughly the type's size relative to an A320, and
 * `tail` its tailfin colour, which is all the livery you can read at 4 km.
 */
function airliner(scale: number, tail: number, wide: boolean): AirDef['parts'] {
  const len = 38 * scale;
  const r = (wide ? 2.95 : 1.98) * scale;
  const span = (wide ? 30 : 17.4) * scale;
  const cr = 6.2 * scale;                           // root chord
  const ct = 1.9 * scale;                           // tip chord
  const sweep = 0.46;                               // radians aft
  const dihedral = 0.09;

  const body: THREE.BufferGeometry[] = [paint(fuselage(len, r), 0xf2f3f5)];

  // Wings, one side at a time so each can carry its own dihedral.
  for (const s of [1, -1]) {
    const w = planform([
      [cr * 0.52, s * r * 0.55],
      [cr * 0.52 - span * Math.tan(sweep), s * span],
      [cr * 0.52 - span * Math.tan(sweep) - ct, s * span],
      [-cr * 0.48, s * r * 0.55],
    ], r * 0.20, -r * 0.30);
    w.rotateX(-s * dihedral);
    body.push(paint(w, 0xe4e6ea));

    // Engine, slung just forward of and below the leading edge at a third span.
    const ez = s * span * 0.34;
    const le = cr * 0.52 - span * 0.34 * Math.tan(sweep);
    const ey = -r * 0.30 + span * 0.34 * Math.sin(dihedral);
    const nac = new THREE.CylinderGeometry(r * 0.44, r * 0.40, cr * 0.72, 8, 1, true);
    nac.rotateZ(-Math.PI / 2);
    nac.translate(le + cr * 0.10, ey - r * 0.80, ez);
    body.push(paint(nac, 0xd2d5da));
    body.push(paint(box(cr * 0.26, r * 0.62, r * 0.16, le - cr * 0.12, ey - r * 0.40, ez), 0xdcdee2));

    // Tailplane.
    const tp = planform([
      [-len * 0.40, s * r * 0.4],
      [-len * 0.455, s * span * 0.35],
      [-len * 0.49, s * span * 0.35],
      [-len * 0.47, s * r * 0.4],
    ], r * 0.13, r * 0.62);
    body.push(paint(tp, 0xe4e6ea));

    // Main gear: a leg and a bogie, folded into the belly when retracted.
    const legX = cr * 0.10;
    const legZ = s * r * 0.92;
    const leg = box(r * 0.16, r * 0.62, r * 0.16, legX, -r * 0.92, legZ);
    body.push(rig(paint(leg, 0x6d7278), 1, legX, -r * 0.30, legZ));
    const bog = box(r * 0.42, r * 0.28, r * 0.20, legX, -r * 1.20, legZ);
    body.push(rig(paint(bog, 0x1a1b1e), 1, legX, -r * 0.30, legZ));
  }

  // Vertical fin plus a dorsal fillet.
  const vf = fin([
    [-len * 0.36, r * 0.55],
    [-len * 0.435, r * 0.55 + span * 0.30],
    [-len * 0.495, r * 0.55 + span * 0.30],
    [-len * 0.50, r * 0.55],
  ], r * 0.17);
  body.push(paint(vf, tail));

  // Nose gear.
  body.push(rig(paint(box(r * 0.13, r * 0.60, r * 0.13, len * 0.33, -r * 0.90, 0), 0x6d7278),
    1, len * 0.33, -r * 0.30, 0));
  body.push(rig(paint(box(r * 0.26, r * 0.24, r * 0.17, len * 0.33, -r * 1.16, 0), 0x1a1b1e),
    1, len * 0.33, -r * 0.30, 0));

  // Glass: windscreen, and a cabin window stripe that reads as a fuselage line.
  const glass: THREE.BufferGeometry[] = [
    box(r * 0.55, r * 0.30, r * 1.05, len * 0.40, r * 0.42, 0),
  ];
  for (const s of [1, -1]) {
    glass.push(box(len * 0.60, r * 0.13, 0.05, -len * 0.02, r * 0.30, s * r * 0.985));
  }

  // Lights: red to port, green to starboard, white strobes at the tips and
  // tail, red beacons above and below, landing lights in the wing roots.
  const lights: THREE.BufferGeometry[] = [];
  const tipX = cr * 0.52 - span * Math.tan(sweep) - ct * 0.5;
  const tipY = -r * 0.30 + span * Math.sin(dihedral);
  const b = r * 0.30;
  lights.push(lamp(box(b, b, b, tipX, tipY, -span * 0.99), 1));    // port red
  lights.push(lamp(box(b, b, b, tipX, tipY, span * 0.99), 2));     // starboard green
  lights.push(lamp(box(b, b, b, tipX, tipY, -span * 0.96), 3));    // strobes
  lights.push(lamp(box(b, b, b, tipX, tipY, span * 0.96), 3));
  lights.push(lamp(box(b, b, b, -len * 0.495, r * 0.5, 0), 3));
  lights.push(lamp(box(b * 0.8, b * 0.8, b * 0.8, -len * 0.05, r * 1.05, 0), 5));
  lights.push(lamp(box(b * 0.8, b * 0.8, b * 0.8, -len * 0.05, -r * 1.05, 0), 5));
  for (const s of [1, -1]) {
    lights.push(lamp(box(b * 1.1, b * 1.1, b * 1.4, cr * 0.42, -r * 0.34, s * r * 1.15), 4));
  }

  return {
    body: merge(body.map((g) => g.getAttribute('aRig') ? g : rig(g, 0))),
    glass: merge(glass),
    light: merge(lights),
  };
}

/** A helicopter: pod, boom, skids, and two rotors the shader spins. */
function helicopter(): AirDef['parts'] {
  const body: THREE.BufferGeometry[] = [];
  const pod = new THREE.SphereGeometry(1.35, 10, 7);
  pod.scale(1.9, 1.0, 1.0);
  pod.translate(0.5, 1.9, 0);
  body.push(paint(pod, 0x2a3f5c));
  body.push(paint(box(5.4, 0.55, 0.5, -3.4, 2.15, 0), 0x2a3f5c));           // tail boom
  body.push(paint(fin([[-6.6, 1.9], [-6.9, 4.1], [-7.4, 4.1], [-7.1, 1.9]], 0.16), 0x2a3f5c));
  body.push(paint(box(0.9, 0.18, 0.16, -6.3, 2.15, 0.34), 0x1d2a3d));
  for (const s of [1, -1]) {
    body.push(paint(box(3.6, 0.10, 0.10, 0.4, 0.28, s * 1.0), 0x3a3f46));   // skid
    body.push(paint(box(0.10, 0.62, 0.10, 1.3, 0.6, s * 1.0), 0x3a3f46));
    body.push(paint(box(0.10, 0.62, 0.10, -0.8, 0.6, s * 1.0), 0x3a3f46));
  }
  body.push(paint(box(0.34, 0.5, 0.34, 0.3, 3.1, 0), 0x3a3f46));            // mast
  // Main rotor: four blades about the hub.
  for (let i = 0; i < 4; i++) {
    const bl = box(10.4, 0.07, 0.42, 0, 3.42, 0);
    bl.rotateY((i * Math.PI) / 2);
    bl.translate(0.3, 0, 0);
    body.push(rig(paint(bl, 0x2e3237), 2, 0.3, 3.42, 0));
  }
  // Tail rotor, spinning in the vertical plane.
  for (let i = 0; i < 2; i++) {
    const bl = box(0.16, 2.1, 0.22, 0, 0, 0);
    bl.rotateZ((i * Math.PI) / 2);
    bl.translate(-6.8, 2.15, 0.44);
    body.push(rig(paint(bl, 0x2e3237), 3, -6.8, 2.15, 0.44));
  }

  const glass = [
    (() => { const g = new THREE.SphereGeometry(1.30, 10, 6, 0, Math.PI, 0, Math.PI * 0.62);
      g.scale(1.55, 1.0, 1.0); g.rotateY(-Math.PI / 2); g.translate(1.5, 1.95, 0); return g; })(),
  ];

  const lights: THREE.BufferGeometry[] = [
    lamp(box(0.3, 0.3, 0.3, -0.2, 2.1, -1.3), 1),
    lamp(box(0.3, 0.3, 0.3, -0.2, 2.1, 1.3), 2),
    lamp(box(0.3, 0.3, 0.3, -7.2, 2.2, 0), 3),
    lamp(box(0.28, 0.28, 0.28, 0.4, 3.0, 0), 5),
    lamp(box(0.34, 0.3, 0.34, 1.9, 0.9, 0), 4),
  ];

  return {
    body: merge(body.map((g) => g.getAttribute('aRig') ? g : rig(g, 0))),
    glass: merge(glass.map((g) => rig(g, 0))),
    light: merge(lights),
  };
}

export function airTypes(): AirDef[] {
  return [
    { name: 'narrowbody', span: 35, rotary: false, parts: airliner(1.0, 0x1c3f7a, false) },
    { name: 'widebody',   span: 60, rotary: false, parts: airliner(1.55, 0x8e2230, true) },
    { name: 'helicopter', span: 21, rotary: true,  parts: helicopter() },
  ];
}

/* ---------------------------------------------------------------- tracks */

interface Track {
  /** Start and end of the flown leg, world metres with y = altitude AMSL. */
  a: [number, number, number];
  b: [number, number, number];
  /** Ground speed, m/s. */
  speed: number;
  /** 1 while the gear is down and the landing lights are on. */
  gear: number;
  /** Bank angle, radians; non-zero only on the turning legs. */
  bank: number;
  /** Which airframe flies it: index into `airTypes()`. */
  type: number;
  /** Aircraft on this track, spaced evenly along it. */
  count: number;
  /** Orbit radius, metres; set instead of `b` for the helicopter. */
  orbit?: number;
}

/**
 * Runway centrelines as fitted from the area data, then flown out along their
 * own bearings. 4R's threshold is at (4181, 300) on a true heading of 19.7
 * degrees; 27's rollout ends near (3415, -544) heading 254.5; 22L departs from
 * (5171, -2462) on 199.7.
 */
function tracks(): Track[] {
  // Runway 4R, landing to the north-north-east.
  const u4 = [Math.sin(0.344), -Math.cos(0.344)] as const;   // 19.7 deg
  const thr4: [number, number] = [4181, 300];
  const app = (d: number, alt: number): [number, number, number] =>
    [thr4[0] - u4[0] * d, alt, thr4[1] - u4[1] * d];

  // Runway 27 departure, climbing west across the inner harbour.
  const u27 = [Math.sin(4.442), -Math.cos(4.442)] as const;  // 254.5 deg
  const lift: [number, number] = [4419, -823];
  const out27 = (d: number, alt: number): [number, number, number] =>
    [lift[0] + u27[0] * d, alt, lift[1] + u27[1] * d];

  // Runway 22L departure, climbing back down the harbour.
  const u22 = [Math.sin(3.484), -Math.cos(3.484)] as const;  // 199.7 deg
  const lift22: [number, number] = [4665, -1050];
  const out22 = (d: number, alt: number): [number, number, number] =>
    [lift22[0] + u22[0] * d, alt, lift22[1] + u22[1] * d];

  // Runway 15R, landing to the south-east over Chelsea and the inner harbour.
  const u15 = [Math.sin(2.363), -Math.cos(2.363)] as const;  // 135.4 deg
  const thr15: [number, number] = [4113, -1905];
  const app15 = (d: number, alt: number): [number, number, number] =>
    [thr15[0] - u15[0] * d, alt, thr15[1] - u15[1] * d];

  return [
    // Final to 4R: 3 degrees, 5.2 km out to the threshold.
    { a: app(5200, 6 + 5200 * 0.0524), b: app(-350, 6), speed: 72, gear: 1, bank: 0, type: 0, count: 2 },
    // A widebody further out on the same approach.
    { a: app(9800, 6 + 9800 * 0.0524), b: app(4600, 6 + 4600 * 0.0524), speed: 78, gear: 1, bank: 0, type: 1, count: 1 },
    // Climb-out off 27, straight over downtown at about 8%.
    { a: out27(140, 24), b: out27(9600, 24 + 9600 * 0.079), speed: 86, gear: 0, bank: 0, type: 0, count: 2 },
    // Climb-out off 22L, down the harbour.
    { a: out22(140, 24), b: out22(7400, 24 + 7400 * 0.075), speed: 84, gear: 0, bank: 0.10, type: 1, count: 1 },
    // Final to 15R, in over the Mystic.
    { a: app15(6200, 6 + 6200 * 0.0524), b: app15(-300, 6), speed: 70, gear: 1, bank: 0, type: 0, count: 1 },
    // A helicopter working the waterfront: a slow orbit over the inner harbour.
    { a: [780, 330, -260], b: [780, 330, -260], speed: 34, gear: 0, bank: 0.24, type: 2, count: 1, orbit: 1150 },
  ];
}

interface Plane {
  track: number;
  /** Distance flown along the leg, metres. */
  s: number;
  /** Strobe phase so no two aircraft flash together. */
  blink: number;
}

/* ------------------------------------------------------------- materials */

export const AIR_VERT_PARS = /* glsl */ `
attribute float aRig;
attribute vec3 aRigP;
attribute float aGear;
uniform float uRotor;
`;

export const AIR_VERT_POS = /* glsl */ `
if (aRig > 0.5) {
  vec3 rel = transformed - aRigP;
  if (aRig < 1.5) {
    // Undercarriage: folds into the belly, and is simply gone when up.
    transformed = aRigP + rel * aGear;
  } else {
    float a = uRotor * (aRig > 2.5 ? 5.2 : 1.0);
    float c = cos(a), s = sin(a);
    if (aRig > 2.5) rel.xy = vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c);
    else            rel.xz = vec2(rel.x * c - rel.z * s, rel.x * s + rel.z * c);
    transformed = aRigP + rel;
  }
}
`;

/**
 * Position lights. Navigation lights burn steadily, the anticollision strobes
 * double-flash about every 1.2 s, the red beacons pulse slower, and the
 * landing lights come on with the gear. Everything divides by the presented
 * exposure, or the strobes clip to white blocks after sunset.
 */
const LAMP_FRAG = /* glsl */ `
vec3 bhCol; float bhGain;
float bhF = fract(uAirTime * 0.84 + vBlink);
float bhStrobe = (bhF < 0.035 || (bhF > 0.085 && bhF < 0.120)) ? 1.0 : 0.0;
float bhBeacon = 0.35 + 0.65 * pow(max(0.0, sin((uAirTime * 1.6 + vBlink) * 3.1416)), 8.0);
if (vLamp < 1.5)      { bhCol = vec3(1.0, 0.05, 0.02); bhGain = 1.0; }
else if (vLamp < 2.5) { bhCol = vec3(0.05, 1.0, 0.18); bhGain = 1.0; }
else if (vLamp < 3.5) { bhCol = vec3(1.0, 1.0, 1.0);   bhGain = bhStrobe * 9.0; }
else if (vLamp < 4.5) { bhCol = vec3(1.0, 0.95, 0.86); bhGain = vGear * 5.5; }
else                  { bhCol = vec3(1.0, 0.10, 0.03); bhGain = bhBeacon * 1.6; }
totalEmissiveRadiance = bhCol * bhGain * uAirLamp;
`;

/**
 * The airborne fleet. Self-contained: it owns its meshes, materials and state,
 * and `Traffic` only has to build it and step it.
 */
export class AirTraffic {
  private defs: AirDef[] = [];
  private planes: Plane[] = [];
  private tracks: Track[] = [];
  private meshes: { mesh: THREE.InstancedMesh; part: AirPart }[][] = [];
  private gearAttr: (THREE.InstancedBufferAttribute | null)[][] = [];
  private blinkAttr: (THREE.InstancedBufferAttribute | null)[][] = [];
  private materials: THREE.Material[] = [];
  private uniforms = {
    uRotor: { value: 0 },
    uAirTime: { value: 0 },
    /** Lamp gain, exposure-compensated and lifted after dark. */
    uAirLamp: { value: 1 },
  };
  private time = 0;

  /** Logan's real runway/taxiway/apron layout, resolved once the area data loads. */
  private loganLayout: LoganLayout | null = null;
  private airportMeshes: THREE.Mesh[] = [];
  private airportMaterials: THREE.Material[] = [];
  private airfieldLights: AirfieldLights | null = null;
  private gateStands: GateStand[] = [];
  private parkedAircraft: { type: number; matrix: THREE.Matrix4 }[] = [];
  private groundFleet: GroundFleet | null = null;
  private rootRef: THREE.Object3D | null = null;

  get count(): number { return this.planes.length; }

  build(ctx: Ctx, root: THREE.Object3D): void {
    this.rootRef = root;
    this.defs = airTypes();
    this.tracks = tracks();

    const cap = new Array(this.defs.length).fill(0);
    for (const t of this.tracks) cap[t.type] += t.count;
    // Reserved for Logan's ground layer: static parked aircraft at gates
    // (type 0 only, to keep this simple) plus the small featured fleet that
    // pushes back, taxis, takes off, loops around and lands (2 narrowbody +
    // 1 widebody). Reserved unconditionally so pool sizing stays synchronous
    // even though the layout itself resolves later, asynchronously.
    cap[0] += PARKED_COUNT + GROUND_COUNTS[0];
    cap[1] += GROUND_COUNTS[1];

    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const buckets: { mesh: THREE.InstancedMesh; part: AirPart }[] = [];
      const gears: (THREE.InstancedBufferAttribute | null)[] = [];
      const blinks: (THREE.InstancedBufferAttribute | null)[] = [];
      const n = Math.max(1, cap[i]);
      for (const [part, geo] of Object.entries(d.parts) as [AirPart, THREE.BufferGeometry | null][]) {
        if (!geo) continue;
        const gear = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
        const blink = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
        geo.setAttribute('aGear', gear);
        geo.setAttribute('aBlink', blink);
        const mesh = new THREE.InstancedMesh(geo, this.material(part), n);
        mesh.name = `air:${d.name}:${part}`;
        mesh.frustumCulled = false;
        // An airliner's shadow would land a kilometre from the aircraft, well
        // outside any cascade, for four extra draws.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.noShadow = true;
        mesh.count = 0;
        root.add(mesh);
        buckets.push({ mesh, part });
        gears.push(gear);
        blinks.push(blink);
      }
      this.meshes.push(buckets);
      this.gearAttr.push(gears);
      this.blinkAttr.push(blinks);
    }

    let slot = 0;
    for (let t = 0; t < this.tracks.length; t++) {
      const tr = this.tracks[t];
      const len = this.legLength(tr);
      for (let i = 0; i < tr.count; i++) {
        this.planes.push({ track: t, s: (len * (i + 0.35)) / tr.count, blink: (slot * 0.37) % 1 });
        slot++;
      }
    }

    this.buildAirport(ctx, root);
  }

  /**
   * Logan's ground infrastructure: real runway/taxiway/apron pavement,
   * markings, lights and gates. Kicked off here (fire-and-forget) rather than
   * making `build` itself `async`: `Traffic.init` calls `this.air.build(ctx,
   * this.root)` without awaiting it and reads `this.air.count` immediately
   * after for a stat, so `build` has to stay synchronous for the flight
   * tracks. `loadAreas()` is already in flight from `Traffic.init`'s own
   * `Promise.all`, and the shared loader in `core/data.ts` caches by URL, so
   * this resolves for free rather than triggering a second fetch.
   */
  private buildAirport(ctx: Ctx, root: THREE.Object3D): void {
    loadAreas()
      .then((areas) => {
        const layout = buildLoganLayout(areas);
        if (!layout) {
          console.warn('[AirTraffic] no Logan-area runway polygons in the area data; skipping ground infrastructure');
          return;
        }
        this.loganLayout = layout;

        const pavement = buildPavement(ctx, layout);
        for (const m of pavement.meshes) root.add(m);
        this.airportMeshes.push(...pavement.meshes);
        this.airportMaterials.push(...pavement.materials);

        const markings = buildMarkings(ctx, layout);
        for (const m of markings.meshes) root.add(m);
        this.airportMeshes.push(...markings.meshes);
        this.airportMaterials.push(...markings.materials);

        this.airfieldLights = buildLights(ctx, layout);
        for (const m of this.airfieldLights.meshes) root.add(m);

        this.gateStands = computeGateStands(layout, PARKED_COUNT + 2);
        this.placeParkedAircraft(ctx);

        const bridges = buildJetBridges(ctx, this.gateStands);
        if (bridges.mesh) {
          root.add(bridges.mesh);
          this.airportMeshes.push(bridges.mesh);
          if (bridges.material) this.airportMaterials.push(bridges.material);
        }

        // The control tower is a hand-authored landmark now; see
        // `landmarks/buildings/atcTower.ts`. Nothing to add for it here.

        this.groundFleet = new GroundFleet(layout, this.gateStands, GROUND_COUNTS);

        console.info(
          `[AirTraffic] Logan: ${layout.runways.length} runways ` +
          `(${layout.runways.map((r) => r.id).join(', ')}), ` +
          `${layout.taxiways.length} taxiways, ${layout.aprons.length} aprons, ` +
          `${this.gateStands.length} gate stands, ground fleet ${GROUND_COUNTS[0]}+${GROUND_COUNTS[1]}`,
        );
      })
      .catch((err) => console.warn('[AirTraffic] failed to build Logan ground infrastructure', err));
  }

  /** Static instances reusing the flying fleet's own narrowbody geometry — no new draw calls. */
  private placeParkedAircraft(ctx: Ctx): void {
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const n = Math.min(PARKED_COUNT, this.gateStands.length);
    for (let i = 0; i < n; i++) {
      const stand = this.gateStands[i];
      const heading = Math.atan2(stand.heading[0], -stand.heading[1]);
      pos.set(stand.position[0], ctx.sampleHeight(stand.position[0], stand.position[1]) + 0.05, stand.position[1]);
      e.set(0, heading, 0, 'YXZ');
      q.setFromEuler(e);
      const mat = new THREE.Matrix4().compose(pos, q, one);
      this.parkedAircraft.push({ type: 0, matrix: mat });
    }
  }

  private legLength(t: Track): number {
    if (t.orbit) return 2 * Math.PI * t.orbit;
    return Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]);
  }

  private material(part: AirPart): THREE.Material {
    const push = <T extends THREE.Material>(m: T): T => { this.materials.push(m); return m; };
    if (part === 'glass') {
      return push(new THREE.MeshStandardMaterial({
        name: 'air:glass', color: 0x121a24, roughness: 0.10, metalness: 0.5, envMapIntensity: 1.5,
      }));
    }
    if (part === 'light') {
      const m = push(new THREE.MeshStandardMaterial({
        name: 'air:light', color: 0x1a1a1c, roughness: 0.3, metalness: 0.1,
        emissive: new THREE.Color(0xffffff), emissiveIntensity: 1,
      }));
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uAirTime = this.uniforms.uAirTime;
        sh.uniforms.uAirLamp = this.uniforms.uAirLamp;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>',
            '#include <common>\nattribute float aLamp;\nattribute float aBlink;\nattribute float aGear;\nvarying float vLamp;\nvarying float vBlink;\nvarying float vGear;')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\nvLamp = aLamp; vBlink = aBlink; vGear = aGear;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>',
            '#include <common>\nuniform float uAirTime;\nuniform float uAirLamp;\nvarying float vLamp;\nvarying float vBlink;\nvarying float vGear;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${LAMP_FRAG}`);
      };
      m.customProgramCacheKey = () => 'air-lamp';
      return m;
    }
    const m = push(new THREE.MeshStandardMaterial({
      name: 'air:body', color: 0xffffff, roughness: 0.34, metalness: 0.42,
      envMapIntensity: 1.4, vertexColors: true,
    }));
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRotor = this.uniforms.uRotor;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${AIR_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${AIR_VERT_POS}`);
    };
    m.customProgramCacheKey = () => 'air-body';
    return m;
  }

  step(dt: number, ctx: Ctx): void {
    this.time += dt;
    this.uniforms.uRotor.value = (this.uniforms.uRotor.value + dt * 26) % (Math.PI * 2);
    this.uniforms.uAirTime.value = this.time;

    // Lamps are authored display-referred, so they divide by the exposure the
    // frame is actually presented at, and lift after sunset like the city.
    const elev = ctx.sun?.elevation ?? 0.5;
    const night = THREE.MathUtils.clamp((0.20 - elev) / 0.26, 0, 1);
    const comp = 2.5 / Math.max(ctx.exposure || 2.5, 0.1);
    this.uniforms.uAirLamp.value = (0.55 + 2.1 * night * night * (3 - 2 * night)) * comp;
    // Ground and approach lights share the same night curve but stay fully
    // off by day rather than merely dim, the way the aircraft's own nav
    // lights do — a lit runway at noon reads as a bug, not a light.
    this.airfieldLights?.setNightGain(night * night * (3 - 2 * night) * comp * 1.4);

    this.groundFleet?.step(dt, ctx);

    const cursor = new Array(this.defs.length).fill(0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);

    for (const p of this.planes) {
      const tr = this.tracks[p.track];
      const len = this.legLength(tr);
      p.s += tr.speed * dt;
      if (p.s > len) p.s -= len;

      let heading: number;
      if (tr.orbit) {
        const a = (p.s / tr.orbit);
        pos.set(tr.a[0] + Math.sin(a) * tr.orbit, tr.a[1], tr.a[2] + Math.cos(a) * tr.orbit);
        // The tangent of a circle traced by (sin, cos) is (cos, -sin), whose
        // yaw under atan2(-dz, dx) is simply the parameter itself.
        heading = a;
      } else {
        const k = p.s / len;
        pos.set(
          tr.a[0] + (tr.b[0] - tr.a[0]) * k,
          tr.a[1] + (tr.b[1] - tr.a[1]) * k,
          tr.a[2] + (tr.b[2] - tr.a[2]) * k,
        );
        heading = Math.atan2(-(tr.b[2] - tr.a[2]), tr.b[0] - tr.a[0]);
      }

      const t = tr.type;
      const buckets = this.meshes[t];
      if (!buckets || !buckets.length) continue;
      const slot = cursor[t];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[t] = slot + 1;

      // Pitch follows the flight path: nose down on the glideslope only a
      // little, because an airliner flies the approach nose-up.
      const rise = tr.orbit ? 0 : (tr.b[1] - tr.a[1]) / Math.max(len, 1);
      const pitch = tr.gear > 0.5 ? 0.045 : Math.asin(THREE.MathUtils.clamp(rise, -1, 1)) * 0.85;
      e.set(0, heading, 0, 'YXZ');
      q.setFromEuler(e);
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(tr.bank, 0, pitch, 'XYZ'));
      q.multiply(tilt);
      m.compose(pos, q, one);

      for (let bi = 0; bi < buckets.length; bi++) {
        buckets[bi].mesh.setMatrixAt(slot, m);
        const g = this.gearAttr[t][bi];
        const bl = this.blinkAttr[t][bi];
        if (g) g.setX(slot, tr.gear);
        if (bl) bl.setX(slot, p.blink);
      }
    }

    // Parked aircraft at Logan's gates: static, but written every frame into
    // whatever slot the cursor is at (cheap — there are at most a dozen),
    // rather than trying to freeze part of an InstancedMesh's live range.
    for (const parked of this.parkedAircraft) {
      const buckets = this.meshes[parked.type];
      if (!buckets?.length) continue;
      const slot = cursor[parked.type];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[parked.type] = slot + 1;
      for (let bi = 0; bi < buckets.length; bi++) {
        buckets[bi].mesh.setMatrixAt(slot, parked.matrix);
        this.gearAttr[parked.type][bi]?.setX(slot, 1);
        this.blinkAttr[parked.type][bi]?.setX(slot, 0);
      }
    }

    // The featured ground-cycle fleet: gate -> pushback -> taxi -> hold short
    // -> line up -> takeoff roll -> airborne loop -> flare -> rollout -> taxi
    // in -> gate. See `airport/groundTraffic.ts`.
    if (this.groundFleet) {
      for (const a of this.groundFleet.list) {
        const buckets = this.meshes[a.type];
        if (!buckets?.length) continue;
        const slot = cursor[a.type];
        if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
        cursor[a.type] = slot + 1;
        const p2 = a.pose;
        pos.set(p2.x, p2.y, p2.z);
        e.set(0, p2.heading, 0, 'YXZ');
        q.setFromEuler(e);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(p2.bank, 0, p2.pitch, 'XYZ'));
        q.multiply(tilt);
        m.compose(pos, q, one);
        for (let bi = 0; bi < buckets.length; bi++) {
          buckets[bi].mesh.setMatrixAt(slot, m);
          this.gearAttr[a.type][bi]?.setX(slot, p2.gear);
          this.blinkAttr[a.type][bi]?.setX(slot, 0.15);
        }
      }
    }

    for (let t = 0; t < this.meshes.length; t++) {
      for (let bi = 0; bi < this.meshes[t].length; bi++) {
        const b = this.meshes[t][bi];
        b.mesh.count = cursor[t];
        b.mesh.instanceMatrix.needsUpdate = true;
        const g = this.gearAttr[t][bi];
        const bl = this.blinkAttr[t][bi];
        if (g) g.needsUpdate = true;
        if (bl) bl.needsUpdate = true;
      }
    }
    ctx.stats.aircraftDrawn = cursor.reduce((a, b) => a + b, 0);
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const m of this.airportMeshes) m.geometry.dispose();
    this.airportMeshes.length = 0;
    for (const m of this.airportMaterials) m.dispose();
    this.airportMaterials.length = 0;
    this.airfieldLights?.dispose();
    this.airfieldLights = null;
    this.parkedAircraft.length = 0;
    this.groundFleet = null;
  }
}
