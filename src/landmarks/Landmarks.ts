import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { lonLatToWorld } from '../core/geo';
import { LANDMARKS, buildLandmark, landmarkSlugs } from './registry';
import { materialsFor } from './lib/materials';

/**
 * Places Boston's hand-authored hero geometry.
 *
 * Division of labour with the Buildings module: **Landmarks owns placement,
 * Buildings owns suppression.** Buildings must skip its generic extrusion for
 * any footprint whose `BuildingRecord.landmark` slug is in `claimedSlugs()`,
 * and must not instantiate the registry mesh itself — otherwise the model is
 * drawn twice, z-fighting against itself.
 */
export class Landmarks implements WorldModule {
  readonly name = 'Landmarks';
  private root = new THREE.Group();
  private lods: THREE.LOD[] = [];
  private placed: string[] = [];
  private envApplied = false;

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'landmarks';
    ctx.scene.add(this.root);

    // Publish the suppression list. `Buildings` reads it *once*, at the top of
    // its own init, to tell its workers which footprints to skip — so this
    // module has to be registered before it. It was not, the list `Buildings`
    // read was empty, and every hand-authored landmark was drawn on top of the
    // OSM extrusion it exists to replace: the Prudential Tower's fluted shaft
    // and tapered crown were inside a plain cream box with a window grid on it.
    // The comment that used to sit here claimed this worked regardless of
    // ordering. It does not, and nothing enforces it but `main.ts`.
    const claimed = new Set(landmarkSlugs());
    (ctx as unknown as Record<string, unknown>).landmarkSlugs = claimed;
    ctx.emit('landmark-slugs', claimed);

    let triangles = 0;
    for (const lm of LANDMARKS) {
      const obj = buildLandmark(lm.slug, ctx);
      if (!obj) continue;

      const [x, z] = lonLatToWorld(lm.lon, lm.lat);
      // Landmarks are authored with their base at y=0, so they only need the
      // terrain height at the anchor. Sampling the footprint corners would be
      // more correct on a slope, but every one of these sits on ground that is
      // flat at the scale of its own plan.
      const y = ctx.sampleHeight(x, z);
      obj.position.set(x, y, z);
      obj.rotation.y = lm.rotation;
      obj.updateMatrixWorld(true);

      this.root.add(obj);
      this.placed.push(lm.slug);
      triangles += (obj.userData.triangles as number) ?? 0;

      if (obj instanceof THREE.LOD) this.lods.push(obj);
      else obj.traverse((c) => { if (c instanceof THREE.LOD) this.lods.push(c); });

      // Yield so the loading screen keeps painting through the heavy ones.
      await new Promise((r) => setTimeout(r, 0));
    }

    ctx.stats.landmarks = this.placed.length;
    ctx.stats.landmarkTris = triangles;
    console.info(
      `[Landmarks] placed ${this.placed.length}/${LANDMARKS.length}, ~${(triangles / 1000).toFixed(0)}k tris at LOD0`,
    );

    ctx.on('quality-changed', () => { this.envApplied = false; });
  }

  update(_dt: number, ctx: Ctx): void {
    // THREE.LOD only switches level when explicitly updated against a camera.
    for (const l of this.lods) l.update(ctx.camera);

    const M = materialsFor(ctx);
    M.updateNight(ctx);

    // The sky publishes its IBL probe asynchronously and refreshes it as the
    // sun moves; adopt it once it exists and whenever quality changes.
    if (!this.envApplied && ctx.envMap) {
      M.refreshEnvironment();
      this.envApplied = true;
    }
  }

  /** Slugs whose geometry this module draws; Buildings must suppress these. */
  claimedSlugs(): string[] {
    return landmarkSlugs();
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.root.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    materialsFor(ctx).dispose();
    this.lods.length = 0;
  }
}
