/**
 * Gate stands on the main apron, jet bridges, and a control-tower cab.
 *
 * Parked aircraft themselves are not built here: they reuse the exact
 * airliner geometry and `InstancedMesh` pools `aircraft.ts` already builds
 * for the flying fleet (see `airTypes()`), just as static instances in
 * reserved extra slots — free of any new draw call. This module only works
 * out *where* those stands are and builds the small amount of genuinely new
 * geometry (bridges, tower cab).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Context';
import type { LoganLayout } from './layout';
import { minAreaOBB, pointInRing } from './meshkit';

export interface GateStand {
  position: [number, number];
  /** Unit vector the parked aircraft's nose points along (toward the notional terminal). */
  heading: [number, number];
}

/**
 * Stands along both long edges of the main apron, inset from the true edge
 * and rejected if they fall outside the (possibly concave) real polygon.
 * There is no terminal-building footprint consulted here — loading the full
 * 61,000-building dataset just to find a wall to point a nose at was not
 * worth it — so "toward the terminal" is approximated as "outward from the
 * apron's own long axis", which is what every real apron looks like anyway.
 */
export function computeGateStands(layout: LoganLayout, maxCount = 12): GateStand[] {
  const apron = layout.mainApron;
  if (!apron?.outline?.length) return [];
  const obb = minAreaOBB(apron.outline);
  if (!obb) return [];

  const spacing = 55;
  const inset = 24;
  const out: GateStand[] = [];
  const nx = -obb.az, nz = obb.ax;
  for (const side of [-1, 1] as const) {
    for (let l = -obb.length / 2 + spacing / 2; l < obb.length / 2 && out.length < maxCount; l += spacing) {
      const w = side * (obb.width / 2 - inset);
      const x = obb.cx + obb.ax * l + nx * w;
      const z = obb.cz + obb.az * l + nz * w;
      if (!pointInRing(apron.outline, x, z)) continue;
      out.push({ position: [x, z], heading: [side * nx, side * nz] });
    }
  }
  return out;
}

/** A short angled box from each stand toward the notional terminal wall. */
export function buildJetBridges(ctx: Ctx, stands: GateStand[]): { mesh: THREE.Mesh | null; material: THREE.Material | null } {
  if (!stands.length) return { mesh: null, material: null };
  const parts: THREE.BufferGeometry[] = [];
  for (const s of stands) {
    const [hx, hz] = s.heading;
    const groundY = ctx.sampleHeight(s.position[0], s.position[1]);
    const len = 16;
    const cx = s.position[0] + hx * (len / 2 + 3);
    const cz = s.position[1] + hz * (len / 2 + 3);
    const cy = groundY + 3.2;
    const g = new THREE.BoxGeometry(3.2, 2.6, len);
    const angle = Math.atan2(hx, hz);
    g.rotateY(angle);
    g.translate(cx, cy, cz);
    parts.push(g);
    // A simple rotunda where the bridge meets the (notional) terminal.
    const r = new THREE.CylinderGeometry(2.6, 2.6, 4.2, 10);
    r.translate(cx + hx * (len / 2), cy, cz + hz * (len / 2));
    parts.push(r);
  }
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  for (const p of parts) p.dispose();
  if (!merged) return { mesh: null, material: null };
  merged.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ name: 'airport:bridge', color: 0xcfd3d8, roughness: 0.55, metalness: 0.35 });
  if (ctx.envMap) mat.envMap = ctx.envMap;
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'airport:bridges';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return { mesh, material: mat };
}

/**
 * The real control tower (`w197731405`, "Boston Air Traffic Control Tower",
 * 86.87 m, footprint centred (3878, -1151)) is already an OSM building and
 * already extruded by `Buildings` as a plain 24x33 m concrete shaft — reading
 * the actual shipped `buildings-*.json` is what gives the position and height
 * here, not memory. Loading the 61,000-building dataset at runtime just to
 * re-derive that one point was not worth it, so it is restated as a small,
 * clearly-provenanced constant instead.
 *
 * This only *adds* a cab and mast on top of that existing shaft — it must
 * never duplicate or replace it, or the tower gets drawn twice (the exact
 * "Landmarks drawn twice" class of bug this codebase has hit before), and
 * suppressing the OSM footprint properly would mean editing `Buildings.ts`
 * and the landmark registry, which are outside this module's files.
 */
const TOWER_XZ: [number, number] = [3878, -1151];
const TOWER_SHAFT_TOP = 86.87;

export function buildControlTowerCab(ctx: Ctx): { mesh: THREE.Mesh; material: THREE.Material } {
  const [x, z] = TOWER_XZ;
  const groundY = ctx.sampleHeight(x, z);
  const cabY = groundY + TOWER_SHAFT_TOP + 2.6;
  const parts: THREE.BufferGeometry[] = [];

  const cab = new THREE.CylinderGeometry(9.5, 8.2, 5.2, 12);
  cab.translate(x, cabY, z);
  parts.push(cab);
  const roof = new THREE.ConeGeometry(9.8, 1.6, 12);
  roof.translate(x, cabY + 3.4, z);
  parts.push(roof);
  const mast = new THREE.CylinderGeometry(0.35, 0.5, 6.5, 8);
  mast.translate(x, cabY + 3.4 + 0.8 + 3.25, z);
  parts.push(mast);

  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  for (const p of parts) p.dispose();
  merged!.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ name: 'airport:tower-cab', color: 0xe7eaee, roughness: 0.35, metalness: 0.2 });
  if (ctx.envMap) mat.envMap = ctx.envMap;
  const mesh = new THREE.Mesh(merged!, mat);
  mesh.name = 'airport:tower-cab';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return { mesh, material: mat };
}
