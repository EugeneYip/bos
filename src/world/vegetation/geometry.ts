/**
 * Procedural tree geometry.
 *
 * Every tree is authored with the trunk base at y = 0 and a nominal height of
 * 1.0, so one per-instance scale places a 9 m cherry or a 24 m white pine.
 *
 * A crown is two things, and getting either wrong is what makes CG trees read
 * as broccoli:
 *
 *  1. **A branch armature.** A tapered trunk splitting into primary limbs and
 *     those into secondaries, following the species' branching habit. You see
 *     it through the leaves, and it is most of why a bare winter silhouette and
 *     a summer one are recognisably the same tree.
 *  2. **A leaf mass of alpha-tested foliage cards** pinned to the branch tips
 *     and scattered over the crown envelope, hollow in the middle so daylight
 *     comes through. Card vertices carry *spherical* normals — bent outward
 *     from the crown centre and sideways across the card — so a flat quad
 *     shades like a puff of leaves rather than like a flat quad.
 *
 * Vertex attributes beyond the usual:
 *   `foliage`  1 on leaf cards, 0 on bark. Splits material and wind response.
 *   `lever`    0 at the roots, 1 at the branch tips. Wind amplitude.
 *   `phase`    per-branch / per-card random, so nothing moves in unison.
 */
import * as THREE from 'three';
import { crownRadius, type Species } from './species';

export interface TreeGeometry {
  geometry: THREE.BufferGeometry;
  /** True when group 0 holds bark triangles and group 1 holds foliage. */
  twoGroups: boolean;
  triangles: number;
}

export interface TreeLods {
  near: TreeGeometry;
  mid: TreeGeometry;
  far: TreeGeometry;
}

// ---------------------------------------------------------------------------

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  fol: number[] = [];
  lev: number[] = [];
  pha: number[] = [];
  /** Impostor only: 0 on the crossed vertical cards, 1 on the horizontal one. */
  crd: number[] = [];

  get vertices(): number {
    return this.pos.length / 3;
  }

  vert(
    p: THREE.Vector3, n: THREE.Vector3, u: number, v: number,
    f: number, lever: number, phase: number, card = 0,
  ): void {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.fol.push(f);
    this.lev.push(lever);
    this.pha.push(phase);
    this.crd.push(card);
  }
}

function rand(seed: number): () => number {
  let s = (seed >>> 0) || 7;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Wind lever: nothing at the roots, everything at the tips. */
function leverAt(y: number, crownBase: number, boost = 1): number {
  const s = Math.max(0.05, crownBase * 0.5);
  return Math.min(1, Math.pow(Math.max(0, (y - s) / Math.max(0.15, 1 - s)), 1.4) * boost);
}

/**
 * A tapered tube through `pts`. Parallel-transported frames keep it from
 * twisting where the path bends hard.
 */
function tube(
  b: Builder,
  pts: THREE.Vector3[],
  radii: number[],
  radial: number,
  crownBase: number,
  phase: number,
  leverBoost: number,
  vTile: number,
): void {
  const n = pts.length;
  if (n < 2) return;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(c, a).normalize());
  }

  // Seed a frame perpendicular to the first tangent, then transport it.
  let up = Math.abs(tangents[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let prevN = new THREE.Vector3().crossVectors(up, tangents[0]).normalize();
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    // Project the previous normal onto the plane perpendicular to t.
    const nrm = prevN.clone().addScaledVector(t, -prevN.dot(t));
    if (nrm.lengthSq() < 1e-8) {
      up = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      nrm.crossVectors(up, t);
    }
    nrm.normalize();
    normals.push(nrm);
    binormals.push(new THREE.Vector3().crossVectors(t, nrm).normalize());
    prevN = nrm;
  }

  // Ring vertices.
  const ring: THREE.Vector3[][] = [];
  const ringN: THREE.Vector3[][] = [];
  let run = 0;
  const vs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) run += pts[i].distanceTo(pts[i - 1]);
    vs.push(run * vTile);
    const r = radii[i];
    const rp: THREE.Vector3[] = [];
    const rn: THREE.Vector3[] = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      _n.copy(normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(binormals[i], Math.sin(a));
      rn.push(_n.clone());
      rp.push(_n.clone().multiplyScalar(r).add(pts[i]));
    }
    ring.push(rp);
    ringN.push(rn);
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const k = (j + 1) % radial;
      const p00 = ring[i][j], p01 = ring[i][k], p10 = ring[i + 1][j], p11 = ring[i + 1][k];
      const n00 = ringN[i][j], n01 = ringN[i][k], n10 = ringN[i + 1][j], n11 = ringN[i + 1][k];
      const u0 = j / radial, u1 = (j + 1) / radial;
      const v0 = vs[i], v1 = vs[i + 1];
      const l0 = leverAt(pts[i].y, crownBase, leverBoost);
      const l1 = leverAt(pts[i + 1].y, crownBase, leverBoost);
      b.vert(p00, n00, u0, v0, 0, l0, phase);
      b.vert(p10, n10, u0, v1, 0, l1, phase);
      b.vert(p11, n11, u1, v1, 0, l1, phase);
      b.vert(p00, n00, u0, v0, 0, l0, phase);
      b.vert(p11, n11, u1, v1, 0, l1, phase);
      b.vert(p01, n01, u1, v0, 0, l0, phase);
    }
  }
}

/**
 * One foliage card: a quad standing on `origin`, growing along `dir`, with
 * normals bent outward from `centre` and rolled across the card's width.
 */
function card(
  b: Builder,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  roll: number,
  w: number,
  h: number,
  centre: THREE.Vector3,
  crownBase: number,
  phase: number,
  bend: number,
): void {
  const f = _a.copy(dir).normalize();
  // A stable side vector, then roll the card about its own axis.
  let ref = Math.abs(f.y) > 0.92 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
  const s = new THREE.Vector3().crossVectors(f, ref).normalize();
  const t = new THREE.Vector3().crossVectors(s, f).normalize();
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const side = s.clone().multiplyScalar(cr).addScaledVector(t, sr);
  const face = new THREE.Vector3().crossVectors(side, f).normalize();

  const up = f.clone().multiplyScalar(h);
  const half = side.clone().multiplyScalar(w * 0.5);

  const corners = [
    new THREE.Vector3().copy(origin).sub(half),
    new THREE.Vector3().copy(origin).add(half),
    new THREE.Vector3().copy(origin).add(half).add(up),
    new THREE.Vector3().copy(origin).sub(half).add(up),
  ];
  const uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const sideSign = [-1, 1, 1, -1];

  const normals = corners.map((p, i) => {
    // Outward from the crown centre, bent sideways so the card shades like a
    // cylinder rather than a sheet of paper.
    const radial = _c.copy(p).sub(centre);
    if (radial.lengthSq() < 1e-6) radial.copy(face);
    radial.normalize();
    return radial
      .multiplyScalar(1 - bend * 0.5)
      .addScaledVector(face, bend * 0.35)
      .addScaledVector(side, sideSign[i] * bend * 0.55)
      .normalize()
      .clone();
  });

  const lev = Math.max(leverAt(origin.y, crownBase, 1.15), 0.35);
  const idx = [0, 1, 2, 0, 2, 3];
  for (const i of idx) {
    b.vert(corners[i], normals[i], uvs[i][0], uvs[i][1], 1, lev, phase);
  }
}

// ---------------------------------------------------------------------------

interface Anchor {
  p: THREE.Vector3;
  d: THREE.Vector3;
  /** 0 primary tip, 1 secondary tip. */
  order: number;
}

interface Detail {
  /** Radial segments for the trunk / primaries / secondaries. */
  radial: [number, number, number];
  /** Path samples per limb. */
  segs: [number, number, number];
  secondaries: number;
  cards: number;
  /** Card size multiplier. */
  cardSize: number;
}

function buildTree(sp: Species, d: Detail, seed: number): TreeGeometry {
  const bark = new Builder();
  const leaf = new Builder();
  const r = rand(seed);

  const cb = sp.crownBase;
  const crownH = 1 - cb;
  const crownR = sp.spread * 0.5;
  const high = sp.shape === 'vase' || sp.shape === 'goblet';
  const centre = new THREE.Vector3(0, cb + crownH * (high ? 0.62 : 0.45), 0);
  const anchors: Anchor[] = [];

  // --- trunk ---------------------------------------------------------------
  // A goblet elm carries a single clean bole to the crotch and then stops; a
  // pine's leader runs almost to the tip; everything else forks low.
  const trunkTop = cb + crownH * (sp.conifer ? 0.9 : sp.shape === 'goblet' ? 0.05 : 0.16);
  const tPts: THREE.Vector3[] = [];
  const tRad: number[] = [];
  const lean = (r() - 0.5) * 0.035;
  const nT = d.segs[0];
  for (let i = 0; i <= nT; i++) {
    const u = i / nT;
    tPts.push(new THREE.Vector3(lean * u * u, trunkTop * u, lean * 0.6 * u * u));
    // Strong flare at the base reads as a rooted tree rather than a post, and
    // the taper above it follows a power law rather than a straight line —
    // a cylinder with a cone on the end is the classic CG trunk tell.
    tRad.push(sp.trunkRadius * (1.7 * Math.pow(1 - u, 2.6) + Math.pow(1 - u * 0.86, 1.35)));
  }
  tube(bark, tPts, tRad, d.radial[0], cb, r(), 0.35, 3.0);

  // --- primary limbs -------------------------------------------------------
  const whorled = sp.shape === 'conical' || sp.shape === 'pyramidal';
  // Whorled species get tiers of three; everything else a single crotch. The
  // total is capped because limb tubes are the most expensive thing here.
  const limbCount = whorled ? Math.min(12, sp.limbs * 2) : sp.limbs;
  const tiers = whorled ? Math.ceil(limbCount / 3) : 1;
  const perTier = whorled ? 3 : limbCount;
  const secondaries = whorled ? Math.max(1, d.secondaries - 2) : d.secondaries;
  const golden = 2.399963;
  let az = r() * Math.PI * 2;

  for (let tier = 0; tier < tiers; tier++) {
    for (let k = 0; k < perTier; k++) {
      const li = tier * perTier + k;
      if (!whorled && li >= limbCount) break;

      // Where the limb leaves the trunk, and where its tip lands on the shell.
      const startT = whorled
        ? 0.02 + 0.9 * (tier / tiers) + r() * 0.05
        : sp.shape === 'goblet'
          // All the limbs leave within a metre of each other: that single
          // crotch low in the crown is the elm's whole silhouette.
          ? 0.0 + 0.05 * (li / Math.max(1, limbCount - 1)) + r() * 0.03
          : 0.0 + 0.22 * (li / Math.max(1, limbCount - 1)) + r() * 0.06;
      const tipT = whorled
        ? Math.min(0.99, startT + 0.1 + r() * 0.08)
        : Math.min(0.99, 0.42 + 0.55 * (li / Math.max(1, limbCount - 1)) + r() * 0.2);

      az += whorled ? (Math.PI * 2) / perTier + (r() - 0.5) * 0.5 : golden + (r() - 0.5) * 0.4;
      const ca = Math.cos(az), sa = Math.sin(az);

      const y0 = cb * 0.92 + crownH * startT * (sp.conifer ? 1 : 0.35);
      const start = new THREE.Vector3(lean * 0.4, y0, lean * 0.24);
      const tipR = crownRadius(sp.shape, tipT) * crownR * (0.82 + r() * 0.3);
      const tipY = cb + crownH * tipT;
      const tip = new THREE.Vector3(ca * tipR, tipY, sa * tipR);

      // Bow the limb: spreading oaks sag then lift, vases sweep up and out,
      // and the elm's limbs arch harder than anything else in the city.
      const sag = sp.shape === 'spreading' || sp.shape === 'umbrella' ? -0.09
        : sp.shape === 'goblet' ? 0.19
          : sp.shape === 'vase' ? 0.11 : whorled ? -0.03 : 0.04;
      const pts: THREE.Vector3[] = [];
      const rad: number[] = [];
      const nS = d.segs[1];
      const r0 = sp.trunkRadius * (whorled ? 0.34 : 0.62);
      for (let i = 0; i <= nS; i++) {
        const u = i / nS;
        const p = new THREE.Vector3().lerpVectors(start, tip, u);
        p.y += Math.sin(Math.PI * u) * crownH * sag;
        p.x += Math.sin(Math.PI * u) * ca * crownR * 0.06;
        p.z += Math.sin(Math.PI * u) * sa * crownR * 0.06;
        pts.push(p);
        rad.push(r0 * (1 - 0.82 * u) + sp.trunkRadius * 0.06);
      }
      const phase = r();
      tube(bark, pts, rad, d.radial[1], cb, phase, 0.9, 6.0);

      const tipDir = new THREE.Vector3().subVectors(pts[nS], pts[nS - 1]).normalize();
      anchors.push({ p: tip.clone(), d: tipDir.clone(), order: 0 });

      // --- secondaries ----------------------------------------------------
      for (let s = 0; s < secondaries; s++) {
        const u = 0.42 + 0.5 * (s / Math.max(1, secondaries - 1)) + r() * 0.1;
        const from = new THREE.Vector3().lerpVectors(start, tip, Math.min(0.96, u));
        from.y += Math.sin(Math.PI * u) * crownH * sag;
        const branchAz = az + (r() < 0.5 ? -1 : 1) * (0.55 + r() * 0.7);
        const bt = Math.min(0.995, tipT + (r() - 0.35) * 0.3);
        const br = crownRadius(sp.shape, bt) * crownR * (0.86 + r() * 0.26);
        const to = new THREE.Vector3(Math.cos(branchAz) * br, cb + crownH * bt, Math.sin(branchAz) * br);
        // Keep the secondary a genuine offshoot, not a second primary.
        to.lerp(from, 0.28);

        const nB = d.segs[2];
        const bp: THREE.Vector3[] = [];
        const brad: number[] = [];
        for (let i = 0; i <= nB; i++) {
          const v = i / nB;
          const p = new THREE.Vector3().lerpVectors(from, to, v);
          p.y += Math.sin(Math.PI * v) * crownH * (sag * 0.5 + 0.03);
          bp.push(p);
          brad.push(r0 * 0.42 * (1 - 0.8 * v) + sp.trunkRadius * 0.035);
        }
        if (d.radial[2] >= 3) tube(bark, bp, brad, d.radial[2], cb, r(), 1.25, 8.0);
        anchors.push({
          p: to.clone(),
          d: new THREE.Vector3().subVectors(bp[nB], bp[nB - 1]).normalize(),
          order: 1,
        });
      }
    }
  }

  // --- leaf mass -----------------------------------------------------------
  const cardH = sp.cardScale * crownR * d.cardSize;
  const cardW = cardH * (sp.conifer ? 0.8 : 1.08);
  const total = Math.max(4, Math.round(d.cards * sp.density));
  const bend = 0.85;

  /**
   * Which way a spray of leaves points depends on where it sits in the crown:
   * at the top they reach for the light, around the flanks they stand out
   * sideways, and along the underside they hang. Biasing everything upward —
   * which is the easy thing to do — is why so many CG canopies look like a
   * bowl of parsley from underneath, and the underside is exactly what you see
   * standing on Boston Common.
   */
  const yBias = (y: number): number => {
    const t = THREE.MathUtils.clamp((y - cb) / Math.max(0.1, crownH), 0, 1);
    return -0.34 + 0.86 * t * t;
  };

  // Two thirds hang off real branch tips; the rest fill the envelope so the
  // silhouette closes up without the interior turning solid.
  const fromAnchors = Math.min(anchors.length, Math.round(total * 0.62));
  for (let i = 0; i < fromAnchors; i++) {
    const a = anchors[Math.floor(r() * anchors.length)];
    const dir = a.d.clone();
    dir.x += (r() - 0.5) * 0.8;
    dir.y += (r() - 0.5) * 0.45 + yBias(a.p.y);
    dir.z += (r() - 0.5) * 0.8;
    dir.normalize();
    const jitter = new THREE.Vector3(
      (r() - 0.5) * crownR * 0.22,
      (r() - 0.5) * crownH * 0.12,
      (r() - 0.5) * crownR * 0.22,
    );
    const scale = 0.78 + r() * 0.5;
    card(leaf, a.p.clone().add(jitter), dir, r() * Math.PI * 2,
      cardW * scale, cardH * scale, centre, cb, r(), bend);
  }

  for (let i = fromAnchors; i < total; i++) {
    const t = Math.pow(r(), high ? 1.5 : 0.85);
    const az2 = r() * Math.PI * 2;
    const shell = crownRadius(sp.shape, t);
    // Hollow: keep the cards on the outer 55 % of the radius so light gets in.
    const q = shell * (0.55 + 0.45 * Math.sqrt(r()));
    const p = new THREE.Vector3(
      Math.cos(az2) * q * crownR,
      cb + crownH * t,
      Math.sin(az2) * q * crownR,
    );
    const dir = new THREE.Vector3().subVectors(p, centre).normalize();
    dir.y += yBias(p.y);
    dir.normalize();
    // Pull the origin inward so the card straddles the shell.
    p.addScaledVector(dir, -cardH * 0.45);
    const scale = 0.7 + r() * 0.6;
    card(leaf, p, dir, r() * Math.PI * 2, cardW * scale, cardH * scale, centre, cb, r(), bend);
  }

  return assemble(bark, leaf);
}

function assemble(bark: Builder, leaf: Builder): TreeGeometry {
  const nBark = bark.vertices;
  const nLeaf = leaf.vertices;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(bark.pos.length + leaf.pos.length);
  pos.set(bark.pos, 0);
  pos.set(leaf.pos, bark.pos.length);
  const nor = new Float32Array(bark.nor.length + leaf.nor.length);
  nor.set(bark.nor, 0);
  nor.set(leaf.nor, bark.nor.length);
  const uv = new Float32Array(bark.uv.length + leaf.uv.length);
  uv.set(bark.uv, 0);
  uv.set(leaf.uv, bark.uv.length);
  const fol = new Float32Array(nBark + nLeaf);
  fol.set(bark.fol, 0);
  fol.set(leaf.fol, nBark);
  const lev = new Float32Array(nBark + nLeaf);
  lev.set(bark.lev, 0);
  lev.set(leaf.lev, nBark);
  const pha = new Float32Array(nBark + nLeaf);
  pha.set(bark.pha, 0);
  pha.set(leaf.pha, nBark);
  const crd = new Float32Array(nBark + nLeaf);
  crd.set(bark.crd, 0);
  crd.set(leaf.crd, nBark);

  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('foliage', new THREE.BufferAttribute(fol, 1));
  g.setAttribute('lever', new THREE.BufferAttribute(lev, 1));
  g.setAttribute('phase', new THREE.BufferAttribute(pha, 1));
  g.setAttribute('cardKind', new THREE.BufferAttribute(crd, 1));
  g.computeBoundingSphere();

  const twoGroups = nBark > 0 && nLeaf > 0;
  if (twoGroups) {
    g.addGroup(0, nBark, 0);
    g.addGroup(nBark, nLeaf, 1);
  }
  return { geometry: g, twoGroups, triangles: (nBark + nLeaf) / 3 };
}

/**
 * The distance impostor: two crossed vertical cards carrying the species
 * silhouette plus one horizontal card carrying the crown seen from above.
 * Without the horizontal card a vertical billboard is edge-on from an aerial
 * camera and the city's whole canopy disappears at altitude — but with *both*
 * always drawn, a tree seen from a low oblique reads as a ball with a plate
 * through it. So each card is tagged (`cardKind` 0 / 1) and the shader
 * cross-fades them on the view's elevation angle.
 */
function buildImpostor(sp: Species): TreeGeometry {
  const leaf = new Builder();
  const w = Math.max(sp.spread, 0.42);
  const cb = sp.crownBase;

  const push = (
    p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, lever: number, kind: number,
  ): void => leaf.vert(p, n, u, v, 1, lever, 0.5, kind);

  // Crossed vertical cards, UV into the left (side) tile.
  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI * 0.5;
    const dx = Math.cos(a) * w * 0.5;
    const dz = Math.sin(a) * w * 0.5;
    const corners: [THREE.Vector3, number, number, number][] = [
      [new THREE.Vector3(-dx, 0, -dz), 0.0, 0.0, 0.0],
      [new THREE.Vector3(dx, 0, dz), 0.5, 0.0, 0.0],
      [new THREE.Vector3(dx, 1, dz), 0.5, 1.0, 1.0],
      [new THREE.Vector3(-dx, 1, -dz), 0.0, 1.0, 1.0],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [p, u, v, lv] = corners[i];
      // Dome-ish normals: mostly up, leaning out. Yawed with the billboard.
      const n = new THREE.Vector3(p.x, 0.55 * w, p.z).normalize();
      push(p, n, u, v, lv * 0.85, 0);
    }
  }

  // Horizontal canopy card, UV into the right (top) tile.
  const y = cb + (1 - cb) * 0.66;
  const h = w * 0.5;
  const top: [THREE.Vector3, number, number][] = [
    [new THREE.Vector3(-h, y, -h), 0.5, 0.0],
    [new THREE.Vector3(h, y, -h), 1.0, 0.0],
    [new THREE.Vector3(h, y, h), 1.0, 1.0],
    [new THREE.Vector3(-h, y, h), 0.5, 1.0],
  ];
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const [p, u, v] = top[i];
    push(p, new THREE.Vector3(p.x * 0.35, w, p.z * 0.35).normalize(), u, v, 0.8, 1);
  }

  return assemble(new Builder(), leaf);
}

/**
 * Card counts are tied to card *size*: halving the linear size of a foliage
 * card quarters what it covers, so the count has to go up by the same factor
 * or the crown opens up into a scaffold. The near card is authored at about
 * 1.5 m (see `textures.cardMeters`) and the mid card at 2.8x that.
 */
const NEAR: Detail = { radial: [6, 4, 3], segs: [3, 3, 2], secondaries: 3, cards: 155, cardSize: 1.0 };
/**
 * The mid card used to be 2.8x the near card and there used to be 34 of them,
 * which is 2133 m² of card over a 24 m elm against the near tier's 1241 — a
 * *denser* crown built from a quarter as many pieces. At the 115-300 m the
 * tier covers, a card that size is 30 to 50 px across, and a crown made of
 * eight or ten of them does not read as foliage: from the State House
 * viewpoint the whole of the Public Garden and the Common came out as a heap
 * of overlapping ovals the size of a small building, which is the "identical
 * blobs" the canopy has always been accused of. 1.9x and 68 keeps the same
 * total card area (to within 8 %) while quadrupling the number of separate
 * silhouettes in a crown, for 68 more triangles on a tier that draws a
 * couple of thousand instances.
 */
const MID: Detail = { radial: [5, 3, 3], segs: [2, 2, 1], secondaries: 2, cards: 68, cardSize: 1.9 };

/** Physical size in metres of the mid tier's clump card for a species. */
export function midCardMeters(sp: Species): number {
  return sp.cardScale * sp.spread * 0.5 * sp.height * 0.8 * MID.cardSize;
}

export function buildTreeLods(sp: Species, seed: number): TreeLods {
  return {
    near: buildTree(sp, NEAR, seed),
    mid: buildTree(sp, MID, seed + 7919),
    far: buildImpostor(sp),
  };
}

// ---------------------------------------------------------------------------
// Ground cover
// ---------------------------------------------------------------------------

/** A tuft of grass: three crossed cards, pivot at the ground, height 1.0. */
export function grassTuft(cards = 3): THREE.BufferGeometry {
  const b = new Builder();
  for (let q = 0; q < cards; q++) {
    const a = (q / cards) * Math.PI;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const corners: [THREE.Vector3, number, number, number][] = [
      [new THREE.Vector3(-dx, 0, -dz), 0, 0, 0],
      [new THREE.Vector3(dx, 0, dz), 1, 0, 0],
      [new THREE.Vector3(dx, 1, dz), 1, 1, 1],
      [new THREE.Vector3(-dx, 1, -dz), 0, 1, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [p, u, v, lv] = corners[i];
      // Grass reads best lit from above: normals lean up hard.
      const n = new THREE.Vector3(p.x * 0.5, 1.0, p.z * 0.5).normalize();
      b.vert(p, n, u, v, 1, lv, q * 0.31);
    }
  }
  return assemble(new Builder(), b).geometry;
}

/** A shrub / hedge unit: a squat dome of foliage cards, height 1.0. */
export function shrubClump(cards: number, wide: number, seed: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rand(seed);
  const centre = new THREE.Vector3(0, 0.45, 0);
  for (let i = 0; i < cards; i++) {
    const a = r() * Math.PI * 2;
    const t = Math.pow(r(), 0.7);
    const rad = Math.sqrt(1 - t * t * 0.85) * 0.5 * wide;
    const p = new THREE.Vector3(Math.cos(a) * rad * 0.55, 0.08 + t * 0.62, Math.sin(a) * rad * 0.55);
    const dir = new THREE.Vector3().subVectors(p, centre);
    dir.y += 0.45;
    dir.normalize();
    card(b, p, dir, r() * Math.PI * 2, 0.62 * wide, 0.58, centre, 0.0, r(), 0.9);
  }
  return assemble(new Builder(), b).geometry;
}
