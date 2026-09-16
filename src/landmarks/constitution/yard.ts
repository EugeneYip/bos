/**
 * The Charlestown Navy Yard around her: Pier 1 and Dry Dock 1.
 *
 * Everything here is authored in the ship's own local frame (+X forward along
 * her keel, +Z to starboard, y = 0 at the waterline) because the two have to
 * agree to the centimetre — a berthed ship whose fenders do not touch the quay
 * reads as a toy in a bath.
 *
 * Pier 1
 *   Granite-faced wharf, deck 4.1 m above mean low water, which puts her spar
 *   deck about 1.9 m above the pier — the step you actually walk up at the brow.
 *
 * Dry Dock 1
 *   Loammi Baldwin, 1827-1833; 415 x 86 ft of hammered Quincy granite in
 *   stepped altars. Constitution was the first ship docked in it, on 24 June
 *   1833, and she has been back many times since. It sits 137 m off her
 *   starboard beam and is normally flooded, which is how it is modelled.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, box, capGeometry, cyl, prism, revolve } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { rect, type P2 } from '../lib/util';
import { V, gridGeometry, hullAt, hullNormal, rope, sheeredY } from './geom';

/** Quay face: 1.2 m outboard of her extreme beam. */
export const QUAY_Z = 8.0;
/**
 * Pier deck above mean water. The yard's grade behind the wharf comes out of the
 * terrain raster at about 2 m, so a 3.4 m deck leaves roughly the metre and a
 * half of granite you actually see standing on Chelsea Street, and puts her spar
 * deck 2.4 m above the pier — the climb you make up the brow.
 */
export const DECK = 3.4;
const PIER_X0 = -62;
const PIER_X1 = 46;
const PIER_Z1 = 40;

/** Wharf outline, wound so `prism` gives it outward normals. */
const PIER: P2[] = [
  [PIER_X0, QUAY_Z],
  [PIER_X1, QUAY_Z],
  [PIER_X1, PIER_Z1],
  [PIER_X0, PIER_Z1],
];

/* --------------------------------------------------------------- Dry Dock 1 */

const DD_C: [number, number] = [-50, 128];
const DD_AXIS: [number, number] = [0.914, 0.405];
const DD_LEN = 121;
const DD_HALF_W = 14.5;
/** Rotation about Y that lines a box up across the dock. */
const DD_ROT = Math.atan2(DD_AXIS[0], DD_AXIS[1]) - Math.PI / 2;

function ddPoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const nx = DD_AXIS[1];
  const nz = -DD_AXIS[0];
  return out.set(
    DD_C[0] + DD_AXIS[0] * u + nx * v,
    0,
    DD_C[1] + DD_AXIS[1] * u + nz * v,
  );
}

/**
 * Terrain height (world Y, which in this model's frame is also local Y) at a
 * point given in the ship's local frame. Supplied by the builder, which is the
 * only place that knows where the anchor is and which way she is heading.
 */
export type GroundAt = (lx: number, lz: number) => number;

export function buildYard(ctx: Ctx, detail: boolean, ground: GroundAt): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const granite = M.surface('granite', { color: 0x8e8b83, roughness: 0.84, tile: 2.6 });
  const graniteDark = M.surface('granite', { color: 0x6f6d67, roughness: 0.88, tile: 2.2 });
  const cope = M.surface('granite', { color: 0x9d9a91, roughness: 0.74, tile: 1.6 });
  const asphalt = M.surface('concrete', { color: 0x76736e, roughness: 0.9, tile: 3.4 });
  const iron = M.surface('darkmetal', { color: 0x24262a, roughness: 0.52, metalness: 0.72 });
  const wood = M.surface('paint', { color: 0x5d452c, roughness: 0.78 });
  const rigMat = M.surface('paint', { color: 0x9a9280, roughness: 0.92 });
  const white = M.surface('paint', { color: 0xdedacf, roughness: 0.6 });
  const brick = M.surface('brick', { color: 0x8c5240, roughness: 0.9, tile: 2.2 });
  const slate = M.surface('slate', { color: 0x4b5057, roughness: 0.7, tile: 1.8 });
  const lamp = M.emissive(0xffd9a0, 1.1, { night: true });
  const skirt = M.surface('paint', { color: 0x364943, roughness: 0.3, metalness: 0.1 });

  /* ------------------------------------------------------------- pier deck */

  // The wharf is a solid granite box, not a slab on legs: walls all round from
  // well below the harbour bed up to a coping course, then the paved deck. The
  // walls run down to -6.6 so that wherever the terrain raster puts grade, the
  // join is buried rather than left hanging over a gap.
  b.add(prism(PIER, -6.6, DECK - 0.45, { cap: false }), granite);
  b.add(prism(PIER, DECK - 0.45, DECK, { cap: false }), cope);
  b.add(capGeometry(PIER, DECK, true), asphalt);

  // Rubbing strake and fender piles down the berthing face.
  b.addAt(box(PIER_X1 - PIER_X0, 0.34, 0.3), wood, [(PIER_X0 + PIER_X1) / 2, DECK - 1.2, QUAY_Z - 0.18]);
  for (let i = 0; i < 22; i++) {
    const x = PIER_X0 + 2 + (i / 21) * (PIER_X1 - PIER_X0 - 4);
    b.addAt(cyl(0.22, 0.2, DECK + 4.6, 6), wood, [x, (DECK - 0.4 - 5.0) / 2, QUAY_Z - 0.22]);
  }

  /* ------------------------------------------------------------- furniture */

  const bollards = [-48, -34, -20, -6, 8, 22, 36];
  for (const x of bollards) {
    b.addAt(
      revolve([[0.34, 0], [0.34, 0.5], [0.26, 0.62], [0.36, 0.78], [0.3, 0.86], [0, 0.88]], 10),
      iron,
      [x, DECK, QUAY_Z + 2.1],
    );
  }
  // Mooring lines: head and stern lines, two breast lines and two springs.
  const lines: [number, number, number][] = [
    [0.955, 3.4, 36],
    [0.86, 3.2, 22],
    [0.3, 3.0, 8],
    [-0.3, 3.0, -20],
    [-0.86, 3.2, -34],
    [-0.955, 3.4, -48],
  ];
  for (const [t, y, bx] of lines) {
    const p = hullAt(t, sheeredY(t, y), 1);
    p.addScaledVector(hullNormal(t, sheeredY(t, y), 1), 0.2);
    const q = V(bx, DECK + 0.72, QUAY_Z + 2.1);
    const mid = p.clone().lerp(q, 0.5);
    mid.y -= 0.5;
    rope(b, rigMat, p, mid, 0.075);
    rope(b, rigMat, mid, q, 0.075);
  }

  // The brow: a covered gangway from the pier to a gap in her bulwark.
  {
    const gx = 4.0;
    const a = V(gx, DECK + 0.1, QUAY_Z + 0.4);
    const c = hullAt(0.06, 5.9, 1);
    c.z += 0.4;
    const ramp = gridGeometry(
      [
        [V(a.x - 1.1, a.y, a.z), V(c.x - 1.1, c.y, c.z)],
        [V(a.x + 1.1, a.y, a.z), V(c.x + 1.1, c.y, c.z)],
      ],
      false,
    );
    b.add(ramp, wood);
    for (const s of [-1, 1]) {
      const p0 = V(a.x + s * 1.1, a.y + 1.05, a.z);
      const p1 = V(c.x + s * 1.1, c.y + 1.05, c.z);
      rope(b, iron, p0, p1, 0.05);
      rope(b, iron, V(p0.x, a.y, a.z), p0, 0.05);
      rope(b, iron, V(p1.x, c.y, c.z), p1, 0.05);
    }
  }

  if (detail) {
    // Lamp standards along the quay.
    for (let i = 0; i < 7; i++) {
      const x = PIER_X0 + 6 + (i / 6) * (PIER_X1 - PIER_X0 - 12);
      const z = QUAY_Z + 5.4;
      b.addAt(cyl(0.16, 0.1, 4.6, 7), iron, [x, DECK, z]);
      b.addAt(revolve([[0, 0], [0.34, 0.16], [0.3, 0.5], [0.1, 0.62]], 8), lamp, [x, DECK + 4.6, z]);
    }
    // Granite blocks, a capstan and a couple of stacked timber piles: the yard
    // is a working waterfront, not a plaza.
    for (const [x, z, w, d, h] of [
      [-40, 22, 5.0, 2.2, 1.1],
      [-24, 26, 6.0, 2.0, 0.9],
      [18, 24, 4.4, 2.4, 1.2],
    ] as const) {
      b.addAt(box(w, h, d), graniteDark, [x, DECK, z]);
    }
    b.addAt(revolve([[1.0, 0], [0.8, 0.5], [0.7, 1.2], [0.95, 1.4], [0.85, 1.6], [0, 1.65]], 12), iron,
      [-14, DECK, QUAY_Z + 8.5]);

    // Visitor kiosk at the head of the pier: brick plinth, white boarding, a
    // slate hip and an awning on posts. Small on purpose — the yard's own
    // storehouses are in the OSM stock and are perfectly adequate there, so
    // nothing of that scale is duplicated here.
    b.addAt(prism(rect(11, 7), 0, 1.0, { cap: false }), brick, [30, DECK, 27]);
    b.addAt(prism(rect(10.4, 6.4), 0, 3.0, { cap: false }), white, [30, DECK + 1.0, 27]);
    b.addAt(box(11.6, 0.35, 7.6), slate, [30, DECK + 4.0, 27]);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.addAt(box(0.16, 3.0, 0.16), white, [30 + sx * 7.6, DECK, 27 + sz * 3.0]);
      }
    }
    b.addAt(box(4.4, 0.16, 6.6), white, [30 + 7.0, DECK + 3.0, 27]);

    // Flagstaff on the quay, with the yard's granite mounting block.
    b.addAt(box(1.8, 0.55, 1.8), cope, [-56, DECK, QUAY_Z + 6.0]);
    b.addAt(cyl(0.2, 0.08, 15.0, 7), white, [-56, DECK + 0.55, QUAY_Z + 6.0]);
  }

  /* ------------------------------------------------------------ hull skirt */

  hullApron(b, skirt, ground);

  /* ------------------------------------------------------------- dry dock */

  dryDock(b, granite, cope, graniteDark, iron, detail, ground);

  const g = b.build('charlestown-navy-yard');
  g.userData.triangles = b.triangles;
  return g;
}

/**
 * A terrain-draped skirt hugging her waterline all the way round, port side
 * and both ends, where there is no quay to paper over the raster.
 *
 * The granite wharf buries its own join with the terrain by running deep
 * (see the pier walls above); the water has no such thing. It is rasterised
 * from real shoreline polygons at a coarse texel, and that shoreline was
 * never going to agree with a hull hand-placed to the centimetre — so
 * without this, she sits with a rim of bare harbour bed showing between her
 * planking and the real water on the side away from the quay. Draped the
 * same way as the dry dock's altars, a hair above whatever the ground
 * actually does: always covers the gap, and reduces to nothing wherever the
 * real harbour is already below sea level, which is most of it.
 */
function hullApron(b: Builder, mat: THREE.Material, ground: GroundAt): void {
  const CLEAR = 0.28;
  const WIDTH = 35;
  const N = 40;

  // Walk her girth at the waterline: starboard stern to bow, then bow back
  // to stern along the port side. The half-breadth both stations use go to
  // zero at the stem, so the two sides already meet there with no seam; the
  // transom is nearly as narrow at this height, so closing straight back to
  // the start leaves at most a few centimetres unclosed.
  const stations: [number, number][] = [];
  for (let i = 0; i <= N; i++) stations.push([-1 + (2 * i) / N, 1]);
  for (let i = 0; i <= N; i++) stations.push([1 - (2 * i) / N, -1]);
  stations.push([-1, 1]);

  const inner: THREE.Vector3[] = [];
  const outer: THREE.Vector3[] = [];
  for (const [t, side] of stations) {
    const p = hullAt(t, 0, side);
    // Flattened to the horizontal: the hull normal at the waterline tilts
    // up and down the turn of the bilge, and this has to reach a fixed
    // distance out over the harbour regardless, not a fixed distance along
    // a surface that is partly pointing at the sky or the mud.
    const n = hullNormal(t, 0, side);
    n.y = 0;
    if (n.lengthSq() < 1e-8) n.set(side, 0, 0);
    n.normalize();
    const ip = p.clone().addScaledVector(n, 0.15);
    const op = p.clone().addScaledVector(n, WIDTH);
    ip.y = ground(ip.x, ip.z) + CLEAR;
    op.y = ground(op.x, op.z) + CLEAR;
    inner.push(ip);
    outer.push(op);
  }
  b.add(gridGeometry([inner, outer], true), mat);
}

const DD_TREAD = 1.6;
/** Courses of altar between the coping and the floor, and the drop per course. */
const DD_STEPS = 4;
const DD_RISE = 0.65;

/**
 * Plan outline of the dock at a given inset from the coping: a rectangle with
 * generously rounded ends, walked counter-clockwise in the dock's own
 * (along, across) axes at uniform arc length, which is what keeps the long
 * straight sides straight and the corners crisp. A superellipse sampled at
 * uniform *angle* gives neither — on a 121 x 29 m plan it comes out an octagon.
 * Negative `inset` walks outward onto the surrounding yard.
 *
 * `drape`, if given, lifts each vertex to clear the terrain by `DD_CLEAR`. The
 * terrain raster carries only a smeared hollow where the dock is, so a dock cut
 * to its true depth has the raster standing up through the granite — the dock
 * fills with grass. Draping trades depth for never showing that seam, and
 * recovers the depth automatically if the terrain is ever dredged properly.
 */
const DD_CLEAR = 0.28;

function ddRing(inset: number, y: number, nu: number, drape?: GroundAt): THREE.Vector3[] {
  const hw = Math.max(0.8, DD_HALF_W - inset);
  const hl = Math.max(hw + 2, DD_LEN / 2 - inset);
  const r = Math.min(hw * 0.62, 9);
  const cu = hl - r;
  const cv = hw - r;
  // Counter-clockwise: straight, corner, straight, corner, ...
  const segs: { len: number; at(t: number): [number, number] }[] = [
    { len: 2 * cv, at: (t) => [hl, -cv + t * 2 * cv] },
    { len: (Math.PI / 2) * r, at: (t) => [cu + r * Math.cos(t * Math.PI / 2), cv + r * Math.sin(t * Math.PI / 2)] },
    { len: 2 * cu, at: (t) => [cu - t * 2 * cu, hw] },
    { len: (Math.PI / 2) * r, at: (t) => [-cu + r * Math.cos(Math.PI / 2 + t * Math.PI / 2), cv + r * Math.sin(Math.PI / 2 + t * Math.PI / 2)] },
    { len: 2 * cv, at: (t) => [-hl, cv - t * 2 * cv] },
    { len: (Math.PI / 2) * r, at: (t) => [-cu + r * Math.cos(Math.PI + t * Math.PI / 2), -cv + r * Math.sin(Math.PI + t * Math.PI / 2)] },
    { len: 2 * cu, at: (t) => [-cu + t * 2 * cu, -hw] },
    { len: (Math.PI / 2) * r, at: (t) => [cu + r * Math.cos(1.5 * Math.PI + t * Math.PI / 2), -cv + r * Math.sin(1.5 * Math.PI + t * Math.PI / 2)] },
  ];
  const per = segs.reduce((a, s) => a + s.len, 0);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= nu; i++) {
    let s = (i / nu) * per;
    let k = 0;
    while (k < segs.length - 1 && s > segs[k].len) {
      s -= segs[k].len;
      k++;
    }
    const [u, v] = segs[k].at(Math.min(1, s / segs[k].len));
    const p = ddPoint(u, v);
    out.push(V(p.x, drape ? Math.max(y, drape(p.x, p.z) + DD_CLEAR) : y, p.z));
  }
  return out;
}

/**
 * Dry Dock 1: stepped granite altars narrowing course by course to the floor, a
 * coping walk at grade, and the caisson shut across the seaward end.
 *
 * Every ring here runs counter-clockwise in the dock's own (along, across)
 * frame, so by the rule in `geom.ts#gridGeometry`: a riser (upper ring then
 * lower ring) faces into the dock with `flip = true`, a tread (outer ring then
 * inner ring) faces up with `flip = true`, and a surface stepping *outward* —
 * the coping walk and its apron — wants `flip = false`.
 */
function dryDock(
  b: Builder,
  granite: THREE.Material,
  cope: THREE.Material,
  dark: THREE.Material,
  iron: THREE.Material,
  detail: boolean,
  ground: GroundAt,
): void {
  const NU = detail ? 40 : 18;

  // Coping level: just above the highest ground the rim crosses, so the walk
  // round the dock reads as a kerb at grade rather than a plinth on a lawn.
  //
  // Sampled along the long sides only, clear of the rounded ends: the yard's
  // built-up ground rises toward the landward end, and folding that single
  // high corner into a ring-wide max drags every course up with it — the
  // whole dock reads as a shallow slab instead of a stepped pit. The sides
  // are what she is actually docked between and carry almost all of the
  // rim's real length, so they are what should set its height.
  let rim = -Infinity;
  const trimU = DD_LEN / 2 - 20;
  for (let i = 0; i <= 12; i++) {
    const u = -trimU + (i / 12) * 2 * trimU;
    for (const v of [-(DD_HALF_W + 3), DD_HALF_W + 3]) {
      const p = ddPoint(u, v);
      rim = Math.max(rim, ground(p.x, p.z));
    }
  }
  const top = rim + 0.4;
  const floorY = top - DD_STEPS * DD_RISE;

  // Altars: hammered Quincy granite, each course set back a tread.
  for (let s = 0; s < DD_STEPS; s++) {
    const y1 = top - s * DD_RISE;
    const y0 = y1 - DD_RISE;
    const inset = s * DD_TREAD;
    b.add(
      gridGeometry([ddRing(inset, y1, NU, s ? ground : undefined), ddRing(inset, y0, NU, ground)], true),
      s === 0 ? cope : granite,
    );
    b.add(
      gridGeometry([ddRing(inset, y0, NU, ground), ddRing(inset + DD_TREAD, y0, NU, ground)], true),
      granite,
    );
  }

  // Dock floor, draped like the altars so the raster never breaks through.
  const inset = DD_STEPS * DD_TREAD;
  const hw = DD_HALF_W - inset;
  const hl = DD_LEN / 2 - inset;
  const NF = 5;
  const floor: THREE.Vector3[][] = [];
  for (let j = 0; j <= NF; j++) {
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const p = ddPoint(-hl + (i / 24) * hl * 2, -hw + (j / NF) * hw * 2);
      row.push(V(p.x, Math.max(floorY, ground(p.x, p.z) + DD_CLEAR), p.z));
    }
    floor.push(row);
  }
  b.add(gridGeometry(floor, true), dark);
  // Keel blocks down the centreline: what makes it read as a dock and not a pit.
  if (detail) {
    for (let i = 0; i < 20; i++) {
      const p = ddPoint(-hl * 0.9 + ((i + 0.5) / 20) * hl * 1.8, 0);
      const y = Math.max(floorY, ground(p.x, p.z) + DD_CLEAR);
      b.addAt(box(2.2, 1.0, 1.7), dark, [p.x, y + 0.5, p.z], DD_ROT);
    }
  }

  // Coping walk round the rim, and an apron under its outer edge so the join
  // with the terrain is buried rather than left hanging over a gap.
  b.add(gridGeometry([ddRing(0, top, NU), ddRing(-5.0, top - 0.25, NU)], false), cope);
  b.add(gridGeometry([ddRing(-5.0, top - 0.25, NU), ddRing(-5.0, top - 8.0, NU)], false), granite);

  if (!detail) return;

  // Caisson shut across the seaward (south-east) end.
  const ent = ddPoint(-DD_LEN / 2 + 1.2, 0);
  const g = box(2.4, top - floorY + 0.4, DD_HALF_W * 2 * 0.98);
  const mtx = new THREE.Matrix4().compose(
    new THREE.Vector3(ent.x, (top + floorY) / 2, ent.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), DD_ROT),
    new THREE.Vector3(1, 1, 1),
  );
  b.add(g.clone().applyMatrix4(mtx), iron);
  g.dispose();

  // Bollards round the rim.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const cu = Math.cos(a);
    const su = Math.sin(a);
    const k = 8;
    const f = Math.pow(Math.pow(Math.abs(cu), k) + Math.pow(Math.abs(su), k), -1 / k);
    const p = ddPoint(cu * f * (DD_LEN / 2 + 3.4), su * f * (DD_HALF_W + 3.4));
    b.addAt(cyl(0.3, 0.26, 0.85, 8), iron, [p.x, top - 0.2, p.z]);
  }
}
