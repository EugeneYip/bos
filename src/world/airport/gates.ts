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

/*
 * The control tower is no longer built here.
 *
 * This module used to add a white cab and mast on top of the plain OSM
 * extrusion of `w197731405` ("Boston Air Traffic Control Tower"), because
 * reaching the top was all it could do from here: fixing the shaft itself
 * meant suppressing that footprint, which is `Landmarks`' and `Buildings`'
 * business, not the airport's.
 *
 * That suppression now exists, so the whole tower — base, slender battered
 * shaft, flared cab, mast and obstruction lights — is one hand-authored mesh
 * in `src/landmarks/buildings/atcTower.ts`, placed by `Landmarks` and skipped
 * by `Buildings`. Adding a cab from here as well would draw it twice.
 */
