import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { loadBinary, loadJson } from '../core/data';
import { BOUNDS } from '../core/config';
import { lonLatToWorld } from '../core/geo';

/**
 * The land beyond the modelled city.
 *
 * The detailed model stops at a 10.4 x 8.7 km box, and the world used to stop
 * with it — from anywhere high up, Boston sat on a dark rectangular plate with
 * nothing past the edge. But the city is in a bowl: the Blue Hills rise south
 * of Mattapan, the Middlesex Fells sit north of Medford, the Arlington and
 * Belmont drumlins are west, and Nahant and the harbour islands are east. All
 * of it is visible from the Hancock, and all of it was missing.
 *
 * This drapes a coarse heightfield (407 m posts, from the same USGS source)
 * around the city, with a hole cut for the detailed terrain, shaded by
 * elevation and slope and dissolved into the sky by distance.
 */

interface FarHeader {
  width: number; height: number;
  sizeX: number; sizeZ: number;
  originX: number; originZ: number;
  spacingX: number; spacingZ: number;
  bin: string; min: number; max: number;
}

/**
 * Radius drawn, metres. The camera's far plane is 26 km, and pushing it out
 * far enough for Wachusett would cost more depth precision than a hill 60 km
 * away is worth. 23 km still reaches the Blue Hills, the Fells, Nahant and
 * the whole harbour rim, which is everything you can actually pick out.
 */
const RADIUS = 23000;
/** Grid stride: every Nth post. Distant hills need shape, not detail. */
const STRIDE = 2;

export class FarTerrain implements WorldModule {
  readonly name = 'FarTerrain';
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private uniforms = {
    uCamY: { value: 0 },
    /** Where the outer rim starts and finishes dissolving, metres. */
    uRim: { value: new THREE.Vector2(RADIUS * 0.72, RADIUS * 0.985) },
  };

  async init(ctx: Ctx): Promise<void> {
    let hdr: FarHeader;
    let buf: ArrayBuffer;
    try {
      hdr = await loadJson<FarHeader>('far-terrain.json');
      buf = await loadBinary(hdr.bin);
    } catch (err) {
      console.warn('[FarTerrain] no far-field data; skipping', err);
      return;
    }
    const el = new Float32Array(buf);

    // The hole: the detailed terrain's own footprint, shrunk slightly so the
    // two overlap by a post rather than leaving a visible seam of sky.
    const [hx0, hz1] = lonLatToWorld(BOUNDS.west, BOUNDS.south);
    const [hx1, hz0] = lonLatToWorld(BOUNDS.east, BOUNDS.north);
    const inset = hdr.spacingX * 0.75;
    const hole = { x0: hx0 + inset, x1: hx1 - inset, z0: hz0 + inset, z1: hz1 - inset };

    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const index = new Map<number, number>();
    const c = new THREE.Color();

    const sample = (i: number, j: number): number => {
      const ii = Math.min(Math.max(i, 0), hdr.width - 1);
      const jj = Math.min(Math.max(j, 0), hdr.height - 1);
      // Below sea level is ocean: flatten it so the seabed never shows where
      // the water module's surface does not reach.
      return Math.max(el[jj * hdr.width + ii], 0);
    };

    const vertexAt = (i: number, j: number): number => {
      const key = j * hdr.width + i;
      const hit = index.get(key);
      if (hit !== undefined) return hit;

      const x = hdr.originX + i * hdr.spacingX;
      const z = hdr.originZ + j * hdr.spacingZ;
      const h = sample(i, j);

      // Slope from the neighbours, for shading and for where trees stop.
      const dx = (sample(i + STRIDE, j) - sample(i - STRIDE, j)) / (2 * STRIDE * hdr.spacingX);
      const dz = (sample(i, j + STRIDE) - sample(i, j - STRIDE)) / (2 * STRIDE * hdr.spacingZ);
      const slope = Math.min(Math.hypot(dx, dz), 1);

      // New England beyond the city is overwhelmingly deciduous woodland:
      // dark green in the valleys, greyer and barer on the ridges, with a
      // sandy fringe at the shoreline and flat blue-grey where it is sea.
      if (h <= 0.01) {
        c.setRGB(0.055, 0.085, 0.105);
      } else {
        const alt = Math.min(h / 220, 1);
        const wood = 0.78 - slope * 0.35;
        c.setRGB(
          0.085 + alt * 0.10 + slope * 0.13,
          0.135 + alt * 0.055 + slope * 0.05,
          0.062 + alt * 0.075 + slope * 0.08,
        );
        // A little deterministic patchiness so the canopy is not a flat wash.
        const n = hash01(i * 73856093 ^ j * 19349663);
        c.multiplyScalar(0.82 + 0.30 * n * wood);
        if (h < 6) c.lerp(new THREE.Color(0.30, 0.27, 0.20), 0.45 * (1 - h / 6));
      }

      const id = pos.length / 3;
      pos.push(x, h, z);
      col.push(c.r, c.g, c.b);
      index.set(key, id);
      return id;
    };

    let quads = 0;
    for (let j = 0; j + STRIDE < hdr.height; j += STRIDE) {
      for (let i = 0; i + STRIDE < hdr.width; i += STRIDE) {
        const x = hdr.originX + i * hdr.spacingX;
        const z = hdr.originZ + j * hdr.spacingZ;
        const x1 = x + STRIDE * hdr.spacingX;
        const z1 = z + STRIDE * hdr.spacingZ;

        // Outside the drawn radius, or inside the detailed city's hole.
        const cx = (x + x1) / 2;
        const cz = (z + z1) / 2;
        if (Math.hypot(cx, cz) > RADIUS) continue;
        if (x1 > hole.x0 && x < hole.x1 && z1 > hole.z0 && z < hole.z1) continue;

        const a = vertexAt(i, j);
        const b = vertexAt(i + STRIDE, j);
        const d = vertexAt(i, j + STRIDE);
        const e = vertexAt(i + STRIDE, j + STRIDE);
        idx.push(a, d, b, b, d, e);
        quads++;
      }
    }

    if (!quads) { console.warn('[FarTerrain] nothing to draw'); return; }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(idx, 1)
      : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      name: 'far-terrain',
      vertexColors: true,
      roughness: 0.97,
      metalness: 0,
      // Ear-clipped in XZ like the parks; double-sided costs nothing here and
      // removes any question of winding.
      side: THREE.DoubleSide,
      dithering: true,
      transparent: true,
      depthWrite: true,
    });

    // Distance haze is *not* this module's job. The sky module rewrites the fog
    // chunk to do physical aerial perspective — the sky's own in-scattered
    // radiance in the direction of the fragment — and enrols every material
    // whose `fog` is not false, this one included. A second, hand-authored wash
    // on top of that used to run here, and because `dithering_fragment` comes
    // *after* `tonemapping_fragment` it was mixing a display-referred near-white
    // straight into the output: the hard white band across the horizon in every
    // distant view was these hills, not the sea.
    //
    // All that is left is the dissolve, which is a question of where the mesh
    // ends rather than of what the air does to it.
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRim = this.uniforms.uRim;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vFarDist;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vFarDist = length((modelMatrix * vec4(transformed, 1.0)).xz - cameraPosition.xz);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying float vFarDist;\nuniform vec2 uRim;')
        .replace('#include <dithering_fragment>', /* glsl */ `
          #include <dithering_fragment>
          // The mesh has to stop somewhere, and a hard rim against the sky is
          // worse than no far field at all. The last few kilometres dissolve.
          gl_FragColor.a *= 1.0 - smoothstep(uRim.x, uRim.y, vFarDist);
        `);
    };
    mat.customProgramCacheKey = () => 'far-terrain';
    this.material = mat;

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'far-terrain';
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;   // no shadow cascade reaches this far anyway
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1;        // behind the detailed city
    ctx.scene.add(mesh);
    this.mesh = mesh;

    ctx.stats.farTris = idx.length / 3;
    console.info(
      `[FarTerrain] ${(RADIUS / 1000).toFixed(0)} km radius, ${quads} quads, ` +
      `${(idx.length / 3 / 1000).toFixed(0)}k tris, elevation 0..${hdr.max.toFixed(0)} m`,
    );
  }

  update(_dt: number, ctx: Ctx): void {
    if (!this.material) return;
    // Dissolve earlier when low down, where the rim would otherwise sit right
    // on the horizon line and read as a wall.
    const y = Math.max(ctx.camera.position.y, 0);
    const rimStart = THREE.MathUtils.clamp(RADIUS * (0.52 + y / 9000), RADIUS * 0.5, RADIUS * 0.86);
    this.uniforms.uRim.value.set(rimStart, RADIUS * 0.99);
  }

  dispose(ctx: Ctx): void {
    if (this.mesh) { ctx.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.material?.dispose();
  }
}

function hash01(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 8) / 16777216;
}
