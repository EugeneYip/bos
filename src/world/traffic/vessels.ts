/**
 * Boats, their wakes, and the flags that fly over the city.
 *
 * The Charles is one of the busiest rowing rivers in the world — eights, fours
 * and singles from the Harvard, MIT, BU and Community Rowing boathouses are on
 * it whenever it is not frozen, along with the Community Boating fleet of small
 * sailing dinghies out of the Esplanade. The harbour is working water: MBTA
 * ferries, harbour cruise boats, water taxis, tugs and the occasional container
 * ship to Conley Terminal.
 *
 * Two things here are shader-driven rather than simulated on the CPU: the
 * rowing stroke (oars sweep, blades feather out of the water, rowers slide on
 * their seats) and the wake, which is one instanced quad per vessel carrying a
 * procedural Kelvin-wake texture.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  const o = g.index ? g.toNonIndexed() : g;
  if (o !== g) g.dispose();
  return o;
};
const merge = (gs: THREE.BufferGeometry[]): THREE.BufferGeometry =>
  mergeGeometries(gs.map(flat), false)!;

/** `oar` carries the rowing rig and its crew; it is the only animated part. */
export type VesselPart = 'hull' | 'house' | 'glass' | 'sail' | 'dark' | 'oar';

export interface VesselDef {
  name: string;
  length: number;
  /** Cruise speed, m/s. */
  speed: number;
  /** Which water this belongs on. */
  water: 'river' | 'harbour' | 'both';
  weight: number;
  hullColor: number;
  /** Wake size: [length, half-width] as multiples of the hull length. */
  wake: [number, number];
  parts: Partial<Record<VesselPart, THREE.BufferGeometry>>;
}

/**
 * A displacement hull: a box tapered to a point at the bow and narrowed at
 * the stern, sitting so the waterline is at y=0.
 *
 * Plan-view taper alone leaves the midship cross-section a plain rectangle —
 * vertical topsides dropping straight to a flat bottom — which is what reads
 * as a shoebox the moment a vessel is seen bow-on or from slightly above,
 * every camera angle a harbour view actually uses. Two more deformations,
 * applied in the same per-vertex pass, are the difference between a slab and
 * a hull: the beam tucks in toward the keel (a shallow chine, not a slab
 * bottom) and eases back out just above the waterline (the flare a real
 * topside carries), and the deck sheer climbs toward the bow — sharply
 * there, a little at the stern — instead of running dead level end to end.
 */
function hull(len: number, beam: number, depth: number, freeboard: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, depth + freeboard, beam, 6, 1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const half = len / 2;
  const halfH = (depth + freeboard) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = x / half;                      // -1 stern .. +1 bow
    // Bow taper is sharp, stern taper is gentle.
    const kPlan = t > 0 ? 1 - Math.pow(t, 2.2) * 0.92 : 1 - Math.pow(-t, 3.0) * 0.45;

    let kSection = 1;
    if (y < 0) {
      // Chine: the bottom row of the box is the keel, tucked in to about
      // 60% beam rather than running out flat to the bilge corner.
      const below = Math.min(1, -y / halfH);
      kSection = 1 - 0.40 * Math.pow(below, 1.5);
    } else if (halfH > 1e-6) {
      // Flare: a little extra beam at mid-freeboard, easing off again by
      // the gunwale — the bulge a real topside has, not a straight wall.
      const above = Math.min(1, y / halfH);
      kSection = 1 + 0.40 * above * (1 - above);
    }
    pos.setZ(i, pos.getZ(i) * Math.max(kPlan, 0.06) * kSection);

    if (y < 0) {
      // Rocker: the keel rises toward the ends.
      pos.setY(i, y * (1 - Math.pow(Math.abs(t), 2.5) * 0.7));
    } else {
      // Sheer: the deck climbs toward the bow, and a little at the stern,
      // instead of sitting dead flat from transom to stem.
      pos.setY(i, y + halfH * (0.60 * Math.pow(Math.max(t, 0), 2.4)
                             + 0.18 * Math.pow(Math.max(-t, 0), 2.4)));
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, (freeboard - depth) / 2, 0);
  return g;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
};

/**
 * Tag rowing gear for the stroke shader. `kind` is 0 for fixed structure,
 * +/-1 for an oar on that side of the boat, and 2 for a rower's body; `p` is
 * the pivot — the gate for an oar, the seat for a rower.
 */
function rowTag(
  g: THREE.BufferGeometry, kind: number, px: number, py: number, pz: number,
): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aOar', new THREE.Float32BufferAttribute(new Float32Array(n).fill(kind), 1));
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz; }
  g.setAttribute('aOarP', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/**
 * One rowing seat: a rigger out to the gate, the oar through it, the blade,
 * and the rower. `side` is +1 starboard, -1 port; a sculler gets two.
 */
function seat(x: number, side: number, scull: boolean): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const gate = scull ? 0.72 : 0.88;
  const gateY = 0.30;
  const sides = scull ? [-1, 1] : [side];
  for (const s of sides) {
    // Rigger: gunwale out to the gate. Fixed structure.
    const rig = box(0.05, 0.035, gate, x, gateY - 0.02, (s * gate) / 2);
    out.push(rowTag(rig, 0, x, gateY, s * gate));
    // Shaft, from the handle inboard of the gate out past it.
    const shaft = new THREE.CylinderGeometry(0.022, 0.03, 3.55, 5);
    shaft.rotateX(Math.PI / 2);
    shaft.translate(x, gateY + 0.03, s * (gate + 1.12));
    out.push(rowTag(shaft, s, x, gateY, s * gate));
    // Blade. Boston club blades are painted; white reads at any distance.
    const blade = box(0.52, 0.022, 0.26, x, gateY + 0.01, s * (gate + 2.62));
    out.push(rowTag(blade, s, x, gateY, s * gate));
  }
  // Rower: torso plus head. Slides fore-and-aft and swings over the seat.
  out.push(rowTag(box(0.30, 0.52, 0.32, x, 0.12), 2, x, 0.12, 0));
  out.push(rowTag(box(0.16, 0.17, 0.16, x - 0.02, 0.66), 2, x, 0.12, 0));
  return out;
}

/** A sweep boat: an eight or a four, with blades out alternate sides. */
function sweepBoat(crew: number, len: number, cox: boolean): VesselDef['parts'] {
  const h = hull(len, 0.60, 0.22, 0.17);
  const gear: THREE.BufferGeometry[] = [];
  const pitch = 1.42;
  const x0 = -((crew - 1) * pitch) / 2 - 0.6;
  for (let i = 0; i < crew; i++) {
    gear.push(...seat(x0 + i * pitch, i % 2 === 0 ? 1 : -1, false));
  }
  if (cox) {
    // The coxswain sits in the stern and does not move.
    gear.push(rowTag(box(0.28, 0.36, 0.30, -len * 0.44, 0.06), 0, 0, 0, 0));
  }
  // A pale deck strip: the one thing that separates a shell from a stick.
  const deck = rowTag(box(len * 0.96, 0.03, 0.44, 0, 0.16), 0, 0, 0, 0);
  return { hull: h, oar: merge([...gear, deck]) };
}

/** A single sculler: 8.2 m, two blades, and nowhere to hide. */
function sculler(): VesselDef['parts'] {
  const h = hull(8.2, 0.44, 0.18, 0.14);
  const gear = seat(-0.3, 1, true);
  gear.push(rowTag(box(7.6, 0.025, 0.34, 0, 0.13), 0, 0, 0, 0));
  return { hull: h, oar: merge(gear) };
}

/** Community Boating dinghy: white hull, tall triangular sail. */
function dinghy(): VesselDef['parts'] {
  const h = hull(4.3, 1.65, 0.28, 0.42);
  const mast = new THREE.CylinderGeometry(0.045, 0.06, 6.2, 6);
  mast.translate(0.5, 3.1, 0);
  const sail = new THREE.Shape();
  sail.moveTo(0, 0); sail.lineTo(0, 5.9); sail.lineTo(-2.6, 0.25); sail.lineTo(0, 0);
  const sg = new THREE.ExtrudeGeometry(sail, { depth: 0.02, bevelEnabled: false });
  sg.rotateY(Math.PI / 2);
  sg.translate(0.5, 0.42, 0);
  return { hull: h, dark: mast, sail: sg };
}

/** A harbour keelboat: bigger, with a jib as well as a main. */
function sloop(): VesselDef['parts'] {
  const h = hull(10.5, 3.1, 0.75, 0.85);
  const mast = new THREE.CylinderGeometry(0.06, 0.09, 13.5, 6);
  mast.translate(0.4, 6.8, 0);
  const boom = box(4.6, 0.09, 0.09, -1.9, 1.5);
  const main = new THREE.Shape();
  main.moveTo(0, 0); main.lineTo(0, 12.4); main.lineTo(-4.4, 0.4); main.lineTo(0, 0);
  const mg = new THREE.ExtrudeGeometry(main, { depth: 0.03, bevelEnabled: false });
  mg.rotateY(Math.PI / 2);
  mg.translate(0.4, 1.0, 0);
  const jib = new THREE.Shape();
  jib.moveTo(0, 0); jib.lineTo(0, 10.2); jib.lineTo(3.9, 0.3); jib.lineTo(0, 0);
  const jg = new THREE.ExtrudeGeometry(jib, { depth: 0.03, bevelEnabled: false });
  jg.rotateY(Math.PI / 2);
  jg.translate(0.5, 1.1, 0.25);
  return { hull: h, dark: merge([mast, boom]), sail: merge([mg, jg]) };
}

/** MBTA / cruise ferry: long white superstructure over a dark hull. */
function ferry(len: number, beam: number): VesselDef['parts'] {
  const h = hull(len, beam, 1.6, 1.5);
  const house: THREE.BufferGeometry[] = [
    box(len * 0.72, 2.3, beam * 0.86, -len * 0.04, 1.5),
    box(len * 0.42, 2.0, beam * 0.72, -len * 0.02, 3.8),
    box(len * 0.14, 1.4, beam * 0.46, len * 0.18, 5.8),   // wheelhouse
  ];
  const glass: THREE.BufferGeometry[] = [];
  for (const y of [2.3, 4.6]) {
    glass.push(box(len * 0.66, 0.85, beam * 0.88, -len * 0.04, y));
  }
  glass.push(box(len * 0.13, 0.8, beam * 0.48, len * 0.18, 6.3));
  const dark: THREE.BufferGeometry[] = [
    box(0.3, 3.2, 0.3, -len * 0.30, 7.2),                  // mast
    box(len * 0.76, 0.18, beam * 0.9, -len * 0.04, 6.0),   // upper deck edge
  ];
  return { hull: h, house: merge(house), glass: merge(glass), dark: merge(dark) };
}

/** Harbour tug: short, high-bowed, with a big deckhouse and a fat fender. */
function tug(): VesselDef['parts'] {
  const h = hull(24, 8.4, 2.6, 2.4);
  const house = merge([
    box(9.5, 3.2, 6.6, -2.0, 2.4),
    box(5.0, 2.4, 4.6, -1.0, 5.6),
  ]);
  const glass = merge([box(4.8, 1.2, 4.7, -1.0, 6.3)]);
  const dark = merge([
    box(2.0, 4.0, 2.0, -7.0, 8.0),      // funnel
    box(24, 0.5, 8.8, 0, 2.2),          // fender belt
  ]);
  return { hull: h, house, glass, dark };
}

/** Container ship inbound to Conley — big, slow, and unmistakable. */
function containerShip(): VesselDef['parts'] {
  const h = hull(190, 30, 9, 11);
  const house = merge([
    box(26, 22, 26, -66, 11),
    box(20, 4, 20, -66, 33),
  ]);
  const glass = merge([box(21, 1.6, 26.4, -66, 30)]);
  const stacks: THREE.BufferGeometry[] = [];
  // Container blocks along the deck, in a couple of tiers.
  for (let i = 0; i < 9; i++) {
    const x = -38 + i * 14;
    const tiers = 2 + ((i * 7) % 3);
    for (let t = 0; t < tiers; t++) {
      stacks.push(box(12.2, 2.6, 26, x, 11 + t * 2.7));
    }
  }
  const dark = merge([box(9, 14, 9, -66, 33), ...stacks]);
  return { hull: h, house, glass, dark };
}

/**
 * Lobster boat: a Downeast workboat, wheelhouse set well forward and a long,
 * low, open cockpit aft for hauling traps over the rail. That balance — cabin
 * toward the bow rather than amidships or aft — is what separates it from
 * every other harbour silhouette here, tug included.
 */
function lobsterBoat(): VesselDef['parts'] {
  const len = 12.0, beam = 4.0;
  const h = hull(len, beam, 1.1, 1.35);
  const house = box(len * 0.30, 1.55, beam * 0.62, len * 0.16, 1.30);
  const glass = box(len * 0.27, 0.50, beam * 0.58, len * 0.16, 1.55);
  const mast = new THREE.CylinderGeometry(0.028, 0.04, 2.6, 5);
  mast.translate(len * 0.12, 1.30 + 1.55 + 1.3, 0);
  return { hull: h, house, glass, dark: mast };
}

export function vesselTypes(): VesselDef[] {
  return [
    { name: 'eight',   length: 17,  speed: 4.6, water: 'river',   weight: 22, hullColor: 0xf0efe9,
      wake: [1.4, 0.34], parts: sweepBoat(8, 17.4, true) },
    { name: 'four',    length: 13,  speed: 4.2, water: 'river',   weight: 10, hullColor: 0xe9e6dc,
      wake: [1.4, 0.34], parts: sweepBoat(4, 13.0, false) },
    { name: 'single',  length: 8.2, speed: 3.6, water: 'river',   weight: 10, hullColor: 0xf2f0e8,
      wake: [1.5, 0.40], parts: sculler() },
    { name: 'dinghy',  length: 4.3, speed: 2.6, water: 'river',   weight: 16, hullColor: 0xf4f4f0,
      wake: [2.2, 0.78], parts: dinghy() },
    { name: 'sloop',   length: 10.5, speed: 3.4, water: 'harbour', weight: 7, hullColor: 0xf2f2ee,
      wake: [2.4, 0.85], parts: sloop() },
    { name: 'launch',  length: 11,  speed: 6.4, water: 'both',    weight: 12, hullColor: 0xdad9d2,
      wake: [4.5, 1.60], parts: ferry(11, 3.4) },
    { name: 'ferry',   length: 32,  speed: 7.2, water: 'harbour', weight: 12, hullColor: 0x24303c,
      wake: [3.4, 1.15], parts: ferry(32, 9.0) },
    { name: 'cruise',  length: 46,  speed: 6.0, water: 'harbour', weight: 6,  hullColor: 0x1d2a38,
      wake: [3.0, 1.00], parts: ferry(46, 11.5) },
    { name: 'tug',     length: 24,  speed: 5.0, water: 'harbour', weight: 7,  hullColor: 0x7a2420,
      wake: [3.6, 1.20], parts: tug() },
    { name: 'ship',    length: 190, speed: 4.0, water: 'harbour', weight: 2,  hullColor: 0x2a4f6b,
      wake: [1.6, 0.50], parts: containerShip() },
    { name: 'lobsterboat', length: 12, speed: 4.6, water: 'harbour', weight: 9, hullColor: 0xe8e2d0,
      wake: [2.0, 0.65], parts: lobsterBoat() },
  ];
}

/* ------------------------------------------------------------- rowing */

/**
 * The stroke, in the vertex stage. `aStroke` is the per-instance phase: 0 at
 * the catch, pi at the finish. Oars sweep about their gate, feather up out of
 * the water on the recovery, and the crew slides toward the stern as the legs
 * go down — get that direction wrong and rowers read as if they are rowing
 * backwards, which anyone who has been near the Charles will notice.
 */
export const ROW_VERT_PARS = /* glsl */ `
attribute float aOar;
attribute vec3 aOarP;
attribute float aStroke;
`;

export const ROW_VERT_POS = /* glsl */ `
if (abs(aOar) > 0.5) {
  vec3 rel = transformed - aOarP;
  if (aOar > 1.5) {
    // Rower: slide aft through the drive, swinging over the seat.
    float lean = 0.34 * cos(aStroke);
    float c = cos(lean), s = sin(lean);
    rel.xy = vec2(rel.x * c + rel.y * s, -rel.x * s + rel.y * c);
    rel.x -= 0.13 * (1.0 - cos(aStroke));
  } else {
    float th = 0.60 * cos(aStroke) * aOar;
    float c = cos(th), s = sin(th);
    rel.xz = vec2(rel.x * c + rel.z * s, -rel.x * s + rel.z * c);
    // Feather: blade out of the water on the recovery, handle down.
    rel.y += max(0.0, -sin(aStroke)) * 0.135 * (rel.z * aOar);
  }
  transformed = aOarP + rel;
}
`;

/* --------------------------------------------------------------- wakes */

/**
 * The Kelvin wake, as a texture. A displacement hull throws two diverging
 * crests at about 19.5 degrees either side of its track, a short bright
 * crescent at the bow, and a band of broken water directly astern that decays
 * over a few hull lengths. Drawing that into an alpha map and stretching one
 * quad over it costs one draw call for the entire fleet.
 *
 * `u` runs bow (0) to aft (1); `v` is across the track.
 */
export function wakeTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const d = img.data;

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H - 0.5;            // -0.5 .. 0.5 across
    const av = Math.abs(v) * 2;               // 0 on the track, 1 at the edge
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      let a = 0;

      // Bow crescent: a tight bright arc right at the stem.
      const bow = Math.exp(-Math.pow((u - 0.035) / 0.030, 2)) * Math.exp(-Math.pow(av / 0.16, 2));
      a += bow * 0.85;

      // Diverging crests. They leave the bow and open out linearly at the
      // Kelvin half-angle; the arm gets broader and softer with distance
      // while the crest itself fades. Kept narrow relative to the gap it
      // opens up — a wide, bright band here is what a real wake never has,
      // and is why a first pass at this read as a solid wedge of white
      // rather than two lines with clear water between and behind them; at
      // the distance most of the fleet is actually seen from, a wide band
      // also survives texture minification as a filled triangle, because
      // there is no gap left for the minified sample to average against.
      const arm = u * 0.94;                    // where the crest sits at this u
      const wdt = 0.026 + u * 0.075;
      const crest = Math.exp(-Math.pow((av - arm) / wdt, 2));
      const decay = Math.exp(-u * 1.55) * (1 - Math.exp(-u * 26));
      a += crest * decay * 1.1;

      // Broken water astern: strongest just behind the transom, decaying.
      const stern = Math.exp(-Math.pow((u - 0.22) / 0.30, 2)) * Math.exp(-Math.pow(av / 0.26, 2));
      // A little streaky structure so it does not read as an airbrushed blob.
      const grain = 0.72 + 0.28 * Math.sin(u * 61 + v * 17) * Math.sin(u * 23 - v * 41);
      a += stern * grain * 0.72;

      a *= 1 - Math.pow(Math.min(av, 1), 6);   // hard stop at the quad edge
      a *= Math.min(1, (1 - u) * 6);           // and fade out at the far end

      const i = (y * W + x) * 4;
      const k = Math.max(0, Math.min(1, a));
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * Math.min(1, k * 0.90));
    }
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * The quad the wake is drawn on: unit length aft along -X from a little ahead
 * of the stem, unit width across. The instance matrix scales it to the hull.
 */
export function wakeGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 10, 1);
  g.rotateX(-Math.PI / 2);   // into the XZ plane, +U along +X
  g.rotateY(Math.PI);        // so U runs aft along -X
  g.translate(-0.5, 0, 0);
  return g;
}

/* ------------------------------------------------------------------ flags */

/**
 * The Stars and Stripes, drawn into a canvas at the official 1:1.9 hoist-to-fly
 * ratio with the union covering seven stripes and two fifths of the fly.
 */
export function flagTexture(): THREE.CanvasTexture {
  const H = 152;
  const W = Math.round(H * 1.9);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;

  const stripe = H / 13;
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#b22234';
  for (let i = 0; i < 13; i += 2) g.fillRect(0, i * stripe, W, stripe);

  const uw = W * 0.40;
  const uh = stripe * 7;
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, uw, uh);

  // 50 stars: nine alternating rows of six and five.
  g.fillStyle = '#ffffff';
  const star = (cx: number, cy: number, r: number): void => {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.42;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.closePath(); g.fill();
  };
  const r = uh / 22;
  for (let row = 0; row < 9; row++) {
    const six = row % 2 === 0;
    const n = six ? 6 : 5;
    const y = (uh / 10) * (row + 1);
    for (let i = 0; i < n; i++) {
      const x = (uw / 12) * (six ? 1 + i * 2 : 2 + i * 2);
      star(x, y, r);
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * A flag panel subdivided along its length so the wave shader has vertices to
 * work with. Hoist edge at x=0, flying out along +X, top edge at y=0.
 */
export function flagGeometry(hoist: number): THREE.BufferGeometry {
  const fly = hoist * 1.9;
  const g = new THREE.PlaneGeometry(fly, hoist, 16, 4);
  g.translate(fly / 2, -hoist / 2, 0);
  return g;
}
