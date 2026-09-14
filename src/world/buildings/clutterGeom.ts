/**
 * Unit primitives for the instanced rooftop plant.
 *
 * Each sits on y = 0 and spans 0..1 in every axis so the instance matrix's
 * scale is literally the object's size in metres — which is what lets the
 * shader recover world-scale UVs and drive a screen-space-error LOD without
 * any extra per-instance data. Built by hand rather than from three's
 * generators so the vertex counts stay minimal (a box is 24 vertices, a vent
 * cylinder 38) and no UV attribute is uploaded at all.
 */
import * as THREE from 'three';

interface Raw {
  pos: number[];
  nrm: number[];
  idx: number[];
}

function quad(
  r: Raw,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = dx - ax;
  const vy = dy - ay;
  const vz = dz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  const i = r.pos.length / 3;
  r.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  for (let k = 0; k < 4; k++) r.nrm.push(nx, ny, nz);
  r.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
}

function finish(r: Raw): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(r.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(r.nrm, 3));
  g.setIndex(r.idx);
  g.computeBoundingSphere();
  return g;
}

/** Axis-aligned box, 0..1 in y. */
function box(topFront = 1, topBack = 1): THREE.BufferGeometry {
  const r: Raw = { pos: [], nrm: [], idx: [] };
  const h = 0.5;
  // Sloped-top variant: the +z edge rises to `topFront`, -z to `topBack`.
  const yf = topFront;
  const yb = topBack;
  // front (+z)
  quad(r, -h, 0, h, h, 0, h, h, yf, h, -h, yf, h);
  // back (-z)
  quad(r, h, 0, -h, -h, 0, -h, -h, yb, -h, h, yb, -h);
  // right (+x)
  quad(r, h, 0, h, h, 0, -h, h, yb, -h, h, yf, h);
  // left (-x)
  quad(r, -h, 0, -h, -h, 0, h, -h, yf, h, -h, yb, -h);
  // top
  quad(r, -h, yf, h, h, yf, h, h, yb, -h, -h, yb, -h);
  // bottom
  quad(r, -h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h);
  return finish(r);
}

function cylinder(segments = 12): THREE.BufferGeometry {
  const r: Raw = { pos: [], nrm: [], idx: [] };
  const rad = 0.5;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.cos(a0) * rad;
    const z0 = Math.sin(a0) * rad;
    const x1 = Math.cos(a1) * rad;
    const z1 = Math.sin(a1) * rad;
    quad(r, x0, 0, z0, x1, 0, z1, x1, 1, z1, x0, 1, z0);
  }
  // top cap as a fan
  const c = r.pos.length / 3;
  r.pos.push(0, 1, 0);
  r.nrm.push(0, 1, 0);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    r.pos.push(Math.cos(a) * rad, 1, Math.sin(a) * rad);
    r.nrm.push(0, 1, 0);
  }
  for (let i = 0; i < segments; i++) {
    r.idx.push(c, c + 1 + ((i + 1) % segments), c + 1 + i);
  }
  return finish(r);
}

/** Tilted parabolic dish on a short post. */
function dish(): THREE.BufferGeometry {
  const r: Raw = { pos: [], nrm: [], idx: [] };
  const post = 0.06;
  // post
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    quad(
      r,
      Math.cos(a0) * post, 0, Math.sin(a0) * post,
      Math.cos(a1) * post, 0, Math.sin(a1) * post,
      Math.cos(a1) * post, 0.45, Math.sin(a1) * post,
      Math.cos(a0) * post, 0.45, Math.sin(a0) * post,
    );
  }

  // bowl: a paraboloid sampled in polar coordinates, then tilted about +X
  const rings = 4;
  const segs = 14;
  const tilt = -0.72;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const put = (rr: number, th: number): [number, number, number, number, number, number] => {
    const lx = Math.cos(th) * rr;
    const lz = Math.sin(th) * rr;
    const ly = rr * rr * 1.6; // paraboloid depth
    // inward-facing normal of the paraboloid
    let nx = -3.2 * lx;
    let nz = -3.2 * lz;
    let ny = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    // rotate about X, then lift onto the post
    const y = ly * ct - lz * st + 0.5;
    const z = ly * st + lz * ct;
    const ny2 = ny * ct - nz * st;
    const nz2 = ny * st + nz * ct;
    return [lx, y, z, nx, ny2, nz2];
  };

  const base = r.pos.length / 3;
  for (let i = 0; i <= rings; i++) {
    const rr = (i / rings) * 0.5;
    for (let s = 0; s < segs; s++) {
      const [x, y, z, nx, ny, nz] = put(rr, (s / segs) * Math.PI * 2);
      r.pos.push(x, y, z);
      r.nrm.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < segs; s++) {
      const t = (s + 1) % segs;
      const a = base + i * segs + s;
      const b = base + i * segs + t;
      const c = base + (i + 1) * segs + t;
      const d = base + (i + 1) * segs + s;
      r.idx.push(a, b, c, a, c, d);
    }
  }
  return finish(r);
}

/** Index order matches `CK_BOX`, `CK_WEDGE`, `CK_CYL`, `CK_DISH`. */
export function clutterGeometries(): THREE.BufferGeometry[] {
  return [box(1, 1), box(1, 0.72), cylinder(12), dish()];
}
