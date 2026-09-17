/**
 * Geometry construction kit for the landmark meshes.
 *
 * Everything here produces plain `BufferGeometry` in local space so callers can
 * accumulate into a `Builder`, which merges per-material and emits a handful of
 * draw calls instead of hundreds.
 *
 * UV convention for walls: U runs along the perimeter in metres, V runs up in
 * metres. Materials set `texture.repeat` to 1/tileMeters, so a shared UV scale
 * means brick courses line up across every piece of a building.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { P2 } from './util';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ Builder */

interface Bucket {
  material: THREE.Material;
  geos: THREE.BufferGeometry[];
}

/**
 * Accumulates geometry keyed by material and merges it into one mesh per
 * material. Call sites stay readable ("add a cornice here") while the output
 * stays cheap.
 */
/**
 * `mergeGeometries` refuses to mix indexed and non-indexed inputs, and refuses
 * to mix differing attribute sets. Three.js primitives are indexed but
 * `ExtrudeGeometry` and `LatheGeometry`-derived shapes may not be, and some
 * carry extra attributes, so every geometry entering a bucket is normalised to
 * the same shape: indexed, with exactly position/normal/uv.
 */
function normaliseForMerge(g: THREE.BufferGeometry): void {
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.morphAttributes = {};
}

export class Builder {
  private buckets = new Map<THREE.Material, Bucket>();
  private _tris = 0;

  add(geo: THREE.BufferGeometry, material: THREE.Material, transform?: THREE.Matrix4): this {
    const g = transform ? geo.clone().applyMatrix4(transform) : geo;
    if (transform) geo.dispose();
    normaliseForMerge(g);
    let b = this.buckets.get(material);
    if (!b) {
      b = { material, geos: [] };
      this.buckets.set(material, b);
    }
    b.geos.push(g);
    const pos = g.getAttribute('position');
    this._tris += (g.index ? g.index.count : pos.count) / 3;
    return this;
  }

  /** Add with a position/rotation/scale rather than a matrix. */
  addAt(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    pos: [number, number, number],
    rotY = 0,
    scale: [number, number, number] | number = 1,
  ): this {
    const m = new THREE.Matrix4();
    const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
    m.compose(
      new THREE.Vector3(pos[0], pos[1], pos[2]),
      new THREE.Quaternion().setFromAxisAngle(_up, rotY),
      new THREE.Vector3(s[0], s[1], s[2]),
    );
    return this.add(geo, material, m);
  }

  get triangles(): number {
    return Math.round(this._tris);
  }

  /** Merge and return a Group of merged meshes (one per material). */
  build(name = 'landmark'): THREE.Group {
    const g = new THREE.Group();
    g.name = name;
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue;
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (!merged) continue;
      if (b.geos.length > 1) for (const x of b.geos) x.dispose();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `${name}:${b.material.name || b.material.type}`;
      // A material may ask to be drawn after the rest of its landmark. Glass
      // does: it is a skin hung centimetres in front of a solid body, and at a
      // kilometre the depth buffer cannot tell the two apart. See
      // `GLASS_RENDER_ORDER` in lib/materials.ts.
      const order = (b.material.userData as { renderOrder?: number }).renderOrder;
      if (order) mesh.renderOrder = order;
      g.add(mesh);
    }
    this.buckets.clear();
    return g;
  }
}

/* ------------------------------------------------------------------- prisms */

export interface PrismOpts {
  /** Draw the top face. */
  cap?: boolean;
  /** Draw the bottom face. */
  floor?: boolean;
  /** Extra UV scroll so adjacent volumes don't share an identical texture phase. */
  uOffset?: number;
  vOffset?: number;
  /** Scale the top ring about the origin (1 = straight prism). */
  topScale?: number;
  /** Flip normals (for interior shells). */
  inward?: boolean;
}

/**
 * Vertical extrusion of a closed polygon from y0 to y1 with perimeter-metre UVs.
 * Sides are flat-shaded per face by duplicating vertices, which keeps hard
 * architectural edges crisp instead of smearing a smooth normal across a corner.
 */
export function prism(footprint: P2[], y0: number, y1: number, opts: PrismOpts = {}): THREE.BufferGeometry {
  const n = footprint.length;
  const top = opts.topScale && opts.topScale !== 1 ? footprint.map(([x, z]) => [x * opts.topScale!, z * opts.topScale!] as P2) : footprint;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const uo = opts.uOffset ?? 0;
  const vo = opts.vOffset ?? 0;
  const flip = opts.inward ? -1 : 1;

  let u = uo;
  for (let i = 0; i < n; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % n];
    const at = top[i];
    const bt = top[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    // Outward normal of a CCW ring in X/Z.
    const nx0 = (b[1] - a[1]) / len;
    const nz0 = -(b[0] - a[0]) / len;
    let nx = nx0;
    let nz = nz0;
    // Tilt the normal for tapered sides. `dr` is how far the top ring moves
    // *against* the outward normal, so a narrowing prism gets a +Y component.
    if (opts.topScale && opts.topScale !== 1) {
      const dy = y1 - y0;
      const dr = -((at[0] - a[0]) * nx0 + (at[1] - a[1]) * nz0);
      const l2 = Math.hypot(dr, dy) || 1;
      const ny = dr / l2;
      const s = dy / l2;
      nx *= s;
      nz *= s;
      for (let k = 0; k < 4; k++) nor.push(nx * flip, ny * flip, nz * flip);
    } else {
      for (let k = 0; k < 4; k++) nor.push(nx * flip, 0, nz * flip);
    }
    const base = pos.length / 3;
    pos.push(a[0], y0, a[1], b[0], y0, b[1], bt[0], y1, bt[1], at[0], y1, at[1]);
    uv.push(u, vo + y0, u + len, vo + y0, u + len, vo + y1, u, vo + y1);
    // Front faces are CCW; with the quad wound a0,b0,b1,a1 the outward-facing
    // order is (0,2,1)/(0,3,2).
    if (opts.inward) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    u += len;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);

  const caps: THREE.BufferGeometry[] = [geo];
  if (opts.cap !== false) caps.push(capGeometry(top, y1, true));
  if (opts.floor) caps.push(capGeometry(footprint, y0, false));
  if (caps.length === 1) return geo;
  const merged = mergeGeometries(caps, false)!;
  for (const c of caps) c.dispose();
  return merged;
}

/** Horizontal cap polygon at height y. `up` picks the winding/normal. */
export function capGeometry(footprint: P2[], y: number, up: boolean): THREE.BufferGeometry {
  // Normalise to CCW so the triangulator's output winding is predictable.
  let area = 0;
  for (let i = 0, n = footprint.length; i < n; i++) {
    const p = footprint[i];
    const q = footprint[(i + 1) % n];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ring = area < 0 ? footprint.slice().reverse() : footprint;
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const p of contour) {
    pos.push(p.x, y, p.y);
    nor.push(0, up ? 1 : -1, 0);
    uv.push(p.x, p.y);
  }
  for (const f of faces) {
    if (up) idx.push(f[0], f[2], f[1]);
    else idx.push(f[0], f[1], f[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Loft through a stack of rings (all the same vertex count). Used for tapered
 * shafts: the Bunker Hill obelisk, the Zakim tower legs, One Dalton's batter.
 */
export function loft(rings: { pts: P2[]; y: number }[], opts: { cap?: boolean; floor?: boolean } = {}): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    parts.push(loftBand(rings[i], rings[i + 1]));
  }
  if (opts.cap !== false) parts.push(capGeometry(rings[rings.length - 1].pts, rings[rings.length - 1].y, true));
  if (opts.floor) parts.push(capGeometry(rings[0].pts, rings[0].y, false));
  const m = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return m;
}

function loftBand(a: { pts: P2[]; y: number }, b: { pts: P2[]; y: number }): THREE.BufferGeometry {
  const n = a.pts.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p0 = a.pts[i];
    const p1 = a.pts[(i + 1) % n];
    const q0 = b.pts[i];
    const q1 = b.pts[(i + 1) % n];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len < 1e-6) continue;
    const base = pos.length / 3;
    pos.push(p0[0], a.y, p0[1], p1[0], a.y, p1[1], q1[0], b.y, q1[1], q0[0], b.y, q0[1]);
    // Face normal from the quad's diagonals.
    _v.set(p1[0] - p0[0], 0, p1[1] - p0[1]);
    const e2 = new THREE.Vector3(q0[0] - p0[0], b.y - a.y, q0[1] - p0[1]);
    const nrm = new THREE.Vector3().crossVectors(e2, _v).normalize();
    for (let k = 0; k < 4; k++) nor.push(nrm.x, nrm.y, nrm.z);
    uv.push(u, a.y, u + len, a.y, u + len, b.y, u, b.y);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    u += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* --------------------------------------------------------------- primitives */

/** Axis-aligned box whose *base* sits at y=0 and which is centred in X/Z. */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

/** Cylinder with its base at y=0. */
export function cyl(rBottom: number, rTop: number, h: number, seg = 24, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  g.translate(0, h / 2, 0);
  return g;
}

/**
 * Surface of revolution from a profile of [radius, height] pairs. The workhorse
 * for domes, cupolas, finials, balusters and column shafts.
 */
export function revolve(profile: P2[], seg = 32, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  return new THREE.LatheGeometry(pts, seg, 0, phiLength);
}

/**
 * A capsule-free strut between two points — the primitive behind cable stays,
 * truss members, flagpoles and light-tower legs.
 */
export function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, seg = 6): THREE.BufferGeometry {
  const dir = _v.subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(radius, radius, len, seg, 1, true);
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(_up, dir.normalize());
  g.applyQuaternion(_q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Rectangular-section beam between two points, with a chosen "up" reference. */
export function beam(
  a: THREE.Vector3,
  b: THREE.Vector3,
  w: number,
  h: number,
  up: THREE.Vector3 = _up,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.BoxGeometry(w, len, h);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize());
  // Roll so the box's local +X stays perpendicular to `up`.
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  if (right.lengthSq() > 1e-6) {
    const localRight = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const angle = Math.atan2(
      new THREE.Vector3().crossVectors(localRight, right).dot(dir.clone().normalize()),
      localRight.dot(right),
    );
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle));
  }
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Extrude a 2D `Shape` along +Y by `depth`, base at y=0. Good for mouldings. */
export function extrudeY(shape: THREE.Shape, depth: number, bevel = 0): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    curveSegments: 8,
  });
  // ExtrudeGeometry builds in XY extruded along +Z; stand it up.
  g.rotateX(-Math.PI / 2);
  g.translate(0, depth, 0);
  return g;
}

/**
 * A classical column: tapered (entasis) shaft with flutes implied by a
 * many-sided profile, plus a simple base and capital. `order` picks the capital
 * proportions. Corinthian gets a flared bell so it reads from 100 m away.
 */
export function column(
  height: number,
  dia: number,
  order: 'doric' | 'ionic' | 'corinthian' = 'corinthian',
  seg = 12,
): THREE.BufferGeometry {
  const r = dia / 2;
  const parts: THREE.BufferGeometry[] = [];
  const capH = order === 'doric' ? height * 0.055 : order === 'ionic' ? height * 0.085 : height * 0.11;
  const baseH = order === 'doric' ? 0 : height * 0.05;
  const shaftH = height - capH - baseH;

  if (baseH > 0) {
    parts.push(
      revolve(
        [
          [r * 1.32, 0],
          [r * 1.32, baseH * 0.35],
          [r * 1.16, baseH * 0.55],
          [r * 1.26, baseH * 0.78],
          [r * 1.02, baseH],
        ],
        seg,
      ),
    );
  }
  // Shaft with entasis: swells to ~1.0 at a third height, tapers to 0.83 at the neck.
  const shaft: P2[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const swell = 1 - 0.17 * t * t - 0.02 * Math.sin(t * Math.PI);
    shaft.push([r * swell, baseH + t * shaftH]);
  }
  parts.push(revolve(shaft, seg));

  const neck = baseH + shaftH;
  if (order === 'doric') {
    parts.push(
      revolve(
        [
          [r * 0.83, neck],
          [r * 1.0, neck + capH * 0.45],
          [r * 1.05, neck + capH * 0.55],
          [r * 1.18, neck + capH * 0.58],
          [r * 1.18, neck + capH],
          [0, neck + capH],
        ],
        seg,
      ),
    );
  } else if (order === 'ionic') {
    parts.push(
      revolve(
        [
          [r * 0.83, neck],
          [r * 0.95, neck + capH * 0.3],
          [r * 1.35, neck + capH * 0.55],
          [r * 1.35, neck + capH * 0.8],
          [r * 1.2, neck + capH],
          [0, neck + capH],
        ],
        seg,
      ),
    );
  } else {
    // Corinthian: flared acanthus bell + abacus. Two leaf rings give it enough
    // silhouette to read against the sky without modelling actual foliage.
    parts.push(
      revolve(
        [
          [r * 0.83, neck],
          [r * 0.95, neck + capH * 0.14],
          [r * 0.86, neck + capH * 0.2],
          [r * 1.12, neck + capH * 0.42],
          [r * 0.98, neck + capH * 0.5],
          [r * 1.34, neck + capH * 0.8],
          [r * 1.2, neck + capH * 0.86],
          [r * 1.42, neck + capH * 0.93],
          [r * 1.42, neck + capH],
          [0, neck + capH],
        ],
        seg,
      ),
    );
  }
  const m = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return m;
}

/** Classical entablature/cornice band: a stepped moulding run along +X. */
export function cornice(length: number, depth: number, height: number, steps = 3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const d = depth * (0.72 + 0.4 * t);
    const h = height / steps;
    const g = new THREE.BoxGeometry(length, h, d);
    g.translate(0, h / 2 + i * h, 0);
    parts.push(g);
  }
  const m = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return m;
}

/** Gable/hip roof over a w x d rectangle, eaves at y=0, ridge at `rise`. */
export function gableRoof(w: number, d: number, rise: number, hip = 0): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number): number => {
    pos.push(x, y, z);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  // Ridge runs along X, shortened by `hip` at each end for a hipped roof.
  const r0 = push(-hw + hip, rise, 0, 0, rise);
  const r1 = push(hw - hip, rise, 0, w, rise);
  const a = push(-hw, 0, -hd, 0, 0);
  const b = push(hw, 0, -hd, w, 0);
  const c = push(hw, 0, hd, w, 0);
  const e = push(-hw, 0, hd, 0, 0);
  idx.push(a, b, r1, a, r1, r0); // north slope
  idx.push(c, e, r0, c, r0, r1); // south slope
  if (hip > 0) {
    idx.push(b, c, r1); // east hip
    idx.push(e, a, r0); // west hip
  } else {
    idx.push(a, r0, e); // west gable
    idx.push(b, c, r1); // east gable
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Square pyramid, base at y=0 centred on the origin. */
export function pyramid(w: number, d: number, h: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, h, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale(w, 1, d);
  g.translate(0, h / 2, 0);
  return g;
}

/** Merge a list, disposing the inputs. Returns null for an empty list. */
export function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  const m = mergeGeometries(geos, false);
  if (m) for (const g of geos) g.dispose();
  return m;
}

/** Triangle count of an Object3D subtree. */
export function countTriangles(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry as THREE.BufferGeometry;
    const count = g.index ? g.index.count : g.getAttribute('position')?.count ?? 0;
    const instances = (m as unknown as THREE.InstancedMesh).count ?? 1;
    n += (count / 3) * ((m as unknown as THREE.InstancedMesh).isInstancedMesh ? instances : 1);
  });
  return Math.round(n);
}
