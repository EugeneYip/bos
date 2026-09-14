/**
 * Boats, and the flags that fly over the city.
 *
 * The Charles is one of the busiest rowing rivers in the world — eights and
 * singles from the Harvard, MIT and BU boathouses are on it whenever it is
 * not frozen, along with the Community Boating fleet of small sailing dinghies
 * out of the Esplanade. The harbour is working water: MBTA ferries, harbour
 * cruise boats, tugs and the occasional container ship to Conley Terminal.
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

export type VesselPart = 'hull' | 'house' | 'glass' | 'sail' | 'dark';

export interface VesselDef {
  name: string;
  length: number;
  /** Cruise speed, m/s. */
  speed: number;
  /** Which water this belongs on. */
  water: 'river' | 'harbour' | 'both';
  weight: number;
  hullColor: number;
  parts: Partial<Record<VesselPart, THREE.BufferGeometry>>;
}

/**
 * A displacement hull: a box tapered to a point at the bow and narrowed at
 * the stern, sitting so the waterline is at y=0.
 */
function hull(len: number, beam: number, depth: number, freeboard: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, depth + freeboard, beam, 6, 1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const half = len / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = x / half;                      // -1 stern .. +1 bow
    // Bow taper is sharp, stern taper is gentle.
    const k = t > 0 ? 1 - Math.pow(t, 2.2) * 0.92 : 1 - Math.pow(-t, 3.0) * 0.45;
    pos.setZ(i, pos.getZ(i) * Math.max(k, 0.06));
    // Rocker: the keel rises toward the ends.
    if (pos.getY(i) < 0) pos.setY(i, pos.getY(i) * (1 - Math.pow(Math.abs(t), 2.5) * 0.7));
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

/** An eight: 17 m, impossibly narrow, with blades out both sides. */
function rowingShell(): VesselDef['parts'] {
  const h = hull(17.0, 0.58, 0.22, 0.16);
  const riggers: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const x = -6.2 + i * 1.6;
    const side = i % 2 === 0 ? 1 : -1;
    const oar = new THREE.BoxGeometry(0.06, 0.04, 3.4);
    oar.translate(x, 0.30, side * 1.75);
    riggers.push(oar);
    const blade = new THREE.BoxGeometry(0.48, 0.02, 0.22);
    blade.translate(x, 0.24, side * 3.4);
    riggers.push(blade);
    // Rowers, as simple torsos — at any real distance that is all you see.
    riggers.push(box(0.34, 0.62, 0.34, x, 0.16));
  }
  return { hull: h, dark: merge(riggers) };
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

export function vesselTypes(): VesselDef[] {
  return [
    { name: 'eight',   length: 17,  speed: 4.4, water: 'river',   weight: 26, hullColor: 0xf0efe9, parts: rowingShell() },
    { name: 'dinghy',  length: 4.3, speed: 2.6, water: 'river',   weight: 22, hullColor: 0xf4f4f0, parts: dinghy() },
    { name: 'launch',  length: 11,  speed: 5.5, water: 'both',    weight: 14, hullColor: 0xdad9d2, parts: ferry(11, 3.4) },
    { name: 'ferry',   length: 32,  speed: 7.2, water: 'harbour', weight: 16, hullColor: 0x24303c, parts: ferry(32, 9.0) },
    { name: 'cruise',  length: 46,  speed: 6.0, water: 'harbour', weight: 8,  hullColor: 0x1d2a38, parts: ferry(46, 11.5) },
    { name: 'tug',     length: 24,  speed: 5.0, water: 'harbour', weight: 8,  hullColor: 0x7a2420, parts: tug() },
    { name: 'ship',    length: 190, speed: 4.0, water: 'harbour', weight: 2,  hullColor: 0x2a4f6b, parts: containerShip() },
  ];
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
