/**
 * Procedural tree geometry at three levels of detail.
 *
 * Everything is authored with the trunk base at y=0 and a nominal height of
 * 1.0, so a single per-instance scale places a tree of any size. Canopies are
 * deliberately irregular — a perfect sphere of leaves reads as a lollipop, and
 * that single mistake is what makes most city models' vegetation look fake.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Species } from './species';

/**
 * `mergeGeometries` refuses to mix indexed and non-indexed inputs. Three.js
 * primitives disagree — Cylinder/Cone/Plane are indexed, Icosahedron is not —
 * so everything is flattened to non-indexed before merging. These geometries
 * are tiny and instanced thousands of times, so the duplicated vertices cost
 * nothing next to the instance count.
 */
function flatten(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  return out;
}

/** Deterministic hash so a species' crown is identical across rebuilds. */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Marks which vertices belong to foliage (1) rather than trunk (0), and how
 * far up the crown they sit. The wind shader reads both so trunks stay rigid
 * while crowns sway, and the leaf/bark split drives the two-tone material.
 */
function tagGeometry(g: THREE.BufferGeometry, foliage: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const tag = new Float32Array(n);
  tag.fill(foliage);
  g.setAttribute('foliage', new THREE.Float32BufferAttribute(tag, 1));
  return g;
}

function trunk(sp: Species, radial: number, taperSegs: number): THREE.BufferGeometry {
  const r = 0.028 + sp.height * 0.0016;
  const h = sp.crownBase + 0.10;
  const g = new THREE.CylinderGeometry(r * 0.62, r, h, radial, taperSegs);
  g.translate(0, h / 2, 0);
  return tagGeometry(g, 0);
}

/** Broadleaf crown: several overlapping, squashed, displaced blobs. */
function broadleafCrown(sp: Species, lobes: number, detail: number): THREE.BufferGeometry {
  const rnd = rand(Math.round(sp.height * 977 + sp.spread * 3301));
  const parts: THREE.BufferGeometry[] = [];
  const top = 1.0;
  const base = sp.crownBase;
  const rMax = sp.spread * 0.5;

  for (let i = 0; i < lobes; i++) {
    const t = lobes === 1 ? 0.45 : i / (lobes - 1);
    // Lobes ride up the crown and out from the axis.
    const y = base + (top - base) * (0.22 + 0.68 * t);
    const ring = Math.sin(Math.PI * (0.25 + 0.7 * t));
    const a = rnd() * Math.PI * 2;
    const off = rMax * 0.34 * ring * (0.4 + rnd() * 0.6);
    const r = rMax * (0.45 + 0.42 * ring) * (0.82 + rnd() * 0.36);

    const blob = new THREE.IcosahedronGeometry(r, detail);
    // Squash vertically and displace vertices so no lobe is a clean sphere.
    const pos = blob.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const yy = pos.getY(v) * 0.74;
      const z = pos.getZ(v);
      const k = 1 + (rnd() - 0.5) * 0.34;
      pos.setXYZ(v, x * k, yy * k, z * k);
    }
    pos.needsUpdate = true;
    blob.computeVertexNormals();
    blob.translate(Math.cos(a) * off, y, Math.sin(a) * off);
    parts.push(blob);
  }
  const merged = mergeGeometries(parts.map(flatten), false)!;
  return tagGeometry(merged, 1);
}

/** Conifer crown: stacked, drooping cones. */
function coniferCrown(sp: Species, tiers: number, radial: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = sp.crownBase;
  const rMax = sp.spread * 0.5;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const y = base + (1 - base) * t;
    const h = (1 - base) / tiers * 2.0;
    const r = rMax * (1 - t * 0.82);
    const c = new THREE.ConeGeometry(r, h, radial, 1, true);
    c.translate(0, y + h * 0.32, 0);
    parts.push(c);
  }
  const merged = mergeGeometries(parts.map(flatten), false)!;
  return tagGeometry(merged, 1);
}

export interface TreeLods {
  /** Full crown + tapered trunk. */
  near: THREE.BufferGeometry;
  /** Coarse crown + simple trunk. */
  mid: THREE.BufferGeometry;
  /** Two crossed quads — the distance impostor. */
  far: THREE.BufferGeometry;
}

export function buildTreeLods(sp: Species): TreeLods {
  const nearCrown = sp.conifer ? coniferCrown(sp, 6, 9) : broadleafCrown(sp, 5, 1);
  const midCrown = sp.conifer ? coniferCrown(sp, 3, 6) : broadleafCrown(sp, 2, 0);

  const near = mergeGeometries([flatten(trunk(sp, 7, 2)), flatten(nearCrown)], false)!;
  const mid = mergeGeometries([flatten(trunk(sp, 4, 1)), flatten(midCrown)], false)!;

  // Impostor: two crossed, vertical quads spanning the whole tree. Cheap, and
  // at >350 m a tree is a handful of pixels so the silhouette is all that reads.
  const quads: THREE.BufferGeometry[] = [];
  for (const rot of [0, Math.PI / 2]) {
    const q = new THREE.PlaneGeometry(sp.spread, 1.0);
    q.translate(0, 0.5, 0);
    q.rotateY(rot);
    quads.push(q);
  }
  const far = tagGeometry(mergeGeometries(quads.map(flatten), false)!, 1);

  return { near, mid, far };
}
