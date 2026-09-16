/**
 * USS Constitution at Pier 1, Charlestown Navy Yard.
 *
 * Registry entry point. Two things here are unlike every other landmark in the
 * module and are deliberate:
 *
 *  1. **The model is authored about the waterline, not its own base.** Every
 *     other landmark returns a group whose base sits at y = 0 and lets
 *     `Landmarks` lift it to `sampleHeight` at the anchor. A ship floats: her
 *     load line has to land on the water plane (`SEA_LEVEL`, y = 0 world) no
 *     matter what the harbour bed underneath is carved to. So this builder
 *     samples the terrain at its own anchor and cancels that lift by the same
 *     amount, one level *inside* the group `Landmarks` actually places — it
 *     sets that outer group's position with `.set()`, not `+=`, so the offset
 *     has to live on a child to survive. The net result is a model positioned
 *     in absolute world Y, with y = 0 local = mean water.
 *
 *  2. **The yard comes with her.** Pier 1's quay face and her fenders have to
 *     agree to a few centimetres, so the wharf and Dry Dock 1 are authored in
 *     the ship's local frame and shipped in the same group rather than left to
 *     the terrain's wharf raster, which at 4.5 m posts cannot resolve a berth.
 *
 * Anchor and heading are taken from the OSM `historic=ship` way for her
 * (w166151194) and from the south-west edge of the Pier 1 wharf polygon, offset
 * so her extreme beam clears the quay by 1.2 m of fender.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { lonLatToWorld } from '../../core/geo';
import { countTriangles } from '../lib/geom';
import { makeLOD } from '../lib/lod';
import { buildShip } from '../constitution/ship';
import { buildYard, type GroundAt } from '../constitution/yard';

/** Registry anchor, repeated here so the terrain probes use the same point. */
export const CONSTITUTION_LON = -71.056569;
export const CONSTITUTION_LAT = 42.372373;
/** Bow bearing: parallel to the Pier 1 quay face. */
export const CONSTITUTION_BEARING = 296.5;

function level(ctx: Ctx, detail: boolean, ground: GroundAt): THREE.Group {
  const g = new THREE.Group();
  g.add(buildShip(ctx, detail));
  g.add(buildYard(ctx, detail, ground));
  return g;
}

/**
 * Terrain sampler in the ship's local frame.
 *
 * `Landmarks` applies `rotY(bearingX(bearing))` then translates to the anchor,
 * and that rotation sends local +X to the compass bearing and local +Z ninety
 * degrees to starboard of it. Invert that here so the yard can ask "how high is
 * the ground 130 m off her starboard beam" without knowing any of it.
 *
 * Returns raw `sampleHeight`, i.e. absolute world Y — which is exactly what the
 * yard wants, *because* of how the cancellation below actually lands (see
 * `buildConstitution`): local Y ends up equal to world Y, so a course built to
 * `ground(x, z) + clearance` is `clearance` above the terrain there, full stop.
 */
function groundSampler(ctx: Ctx, ax: number, az: number): GroundAt {
  const br = (CONSTITUTION_BEARING * Math.PI) / 180;
  const fx = Math.sin(br);
  const fz = -Math.cos(br);
  return (lx, lz) => {
    let h = 0;
    try {
      h = ctx.sampleHeight?.(ax + lx * fx - lz * fz, az + lx * fz + lz * fx) ?? 0;
    } catch {
      h = 0;
    }
    return Number.isFinite(h) ? h : 0;
  };
}

export function buildConstitution(ctx: Ctx): THREE.Object3D {
  const [ax, az] = lonLatToWorld(CONSTITUTION_LON, CONSTITUTION_LAT);
  const ground = groundSampler(ctx, ax, az);
  const anchorY = ground(0, 0);

  const lod = makeLOD('uss-constitution', [
    { object: level(ctx, true, ground), distance: 0 },
    { object: level(ctx, false, ground), distance: 1100 },
  ]);
  // Cancel the terrain lift here, on the LOD node rather than on `root` below.
  // `Landmarks` does `obj.position.set(x, sampleHeight(anchor), z)` on whatever
  // this function returns — an overwrite, not an addition — so a compensating
  // offset on `root` itself is silently discarded the moment it is placed. One
  // extra level of nesting keeps it out of `obj`'s own transform and lets it
  // survive: local y = 0 ends up at world y = 0 (mean water), as intended.
  lod.position.y = -anchorY;

  const root = new THREE.Group();
  root.name = 'uss-constitution:afloat';
  root.add(lod);
  root.userData.triangles = countTriangles(lod.children[0] ?? lod);
  root.userData.waterlineOffset = -anchorY;
  return root;
}
