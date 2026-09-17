import * as THREE from 'three';
import type { Ctx, FarBathymetry, WorldModule } from '../core/Context';
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
 *
 * ## The sea is a hole too
 *
 * 42% of that grid is below sea level -- it is real bathymetry, down to
 * -289 m (`seaFraction` in the header). It used to be flattened to y=0 and
 * painted a flat matte grey-blue, which put a dead, unlit plate over the
 * whole of Massachusetts Bay: no waves, no sun glitter, no sky in it. And
 * `Water`'s ocean skirt is already the real surface out there, reaching 45 km
 * against this mesh's 23 km, sitting at exactly the same y=0. Two meshes
 * wanted that plane and this one won, because it is `transparent` and so
 * draws after the water's `renderOrder` 6.
 *
 * So the wet part is simply not drawn. A raycast at the high aerial viewpoint
 * used to name `far-terrain` in front of `water:chunk` on every sample over
 * open sea; with the plate gone the same pixels go from [86,103,100] to
 * [101,128,142], which is the difference between a wash and water.
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
/**
 * Grid stride: every Nth post.
 *
 * This was 2, which threw away half of a grid that is already only 407 m --
 * so the Blue Hills and the Fells were drawn as 814 m facets and the whole
 * surround read as a flat painted plate around the city rather than land.
 * The saving was not real: the entire far field at stride 2 is 3,918
 * triangles, against 12 million in the frame.
 */
const STRIDE = 1;
/**
 * At or under this elevation a post is sea, and the quads made only of sea
 * posts are not drawn. Not exactly zero: the grid holds a few thousand posts
 * sitting on 0.0 along the tide line, and they belong to the water.
 */
const SEA_EPS = 0.01;
/**
 * How far the built-up ring reaches past the modelled box, metres.
 *
 * The far field shades itself from elevation and slope alone, which makes
 * every dry post outside the box woodland -- so the detailed city ended at a
 * straight line and flat green began, and from altitude the whole model read
 * as a plate sitting on a lawn. That is the 'drafty' edge.
 *
 * Boston does not do that. Somerville, Everett, Chelsea, Malden, Revere,
 * Watertown and Quincy are continuous dense fabric for miles past the box,
 * and only then does it break up into the wooded suburbs the green is right
 * for. This is an approximation of that ring, not mapped data: there is no
 * land-cover raster in the extract, so the blend is driven by distance from
 * the box and damped on slope, since the hills inside the ring -- the Fells,
 * the Arlington drumlins -- did stay wooded.
 */
const URBAN_REACH = 9000;
/** Strength of that blend at the box edge; it falls to zero at the reach. */
const URBAN_AT_EDGE = 0.72;

/** Where a surviving sea post sits, metres. Under the skirt, not on it. */
const SHELF = -1.4;
/**
 * Full scale of the depth texture handed to the water, metres. The grid goes
 * to -289 m, but the water only uses depth to pick a colour and it has
 * saturated to open-ocean long before 100 m, so the byte is spent on the
 * shelf where the gradient is actually visible.
 */
const MAX_DEPTH = 100;

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
    ctx.farBathymetry = publishBathymetry(el, hdr);

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

    /** Elevation as the USGS grid has it, clamped to the grid. Negative is sea. */
    const raw = (i: number, j: number): number => {
      const ii = Math.min(Math.max(i, 0), hdr.width - 1);
      const jj = Math.min(Math.max(j, 0), hdr.height - 1);
      return el[jj * hdr.width + ii];
    };

    const isSea = (i: number, j: number): boolean => raw(i, j) <= SEA_EPS;

    /**
     * Elevation for shading and slope, with the seabed flattened. The depth
     * itself is no use to this mesh: where it is wet there is nothing drawn,
     * and a 407 m post spacing would turn the harbour floor into facets
     * anyway.
     */
    const sample = (i: number, j: number): number => Math.max(raw(i, j), 0);

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

      // Built-up ring: pull the colour toward city fabric near the box, so
      // the detailed model's edge is a change of resolution rather than a
      // change of continent. Steep ground keeps its trees.
      if (h > 0.01) {
        const dxb = Math.max(hx0 - x, 0, x - hx1);
        const dzb = Math.max(hz0 - z, 0, z - hz1);
        const out = Math.hypot(dxb, dzb);
        const t = URBAN_AT_EDGE * (1 - Math.min(out / URBAN_REACH, 1)) * (1 - slope * 0.8);
        if (t > 0.001) {
          const n2 = hash01(i * 19349663 ^ j * 83492791);
          const g = 0.255 + 0.115 * n2;
          c.lerp(new THREE.Color(g * 1.03, g * 1.0, g * 0.95), Math.max(t, 0));
        }
      }

      const id = pos.length / 3;
      // A sea post only survives as a corner of a quad that has some land in
      // it. Leaving it at exactly y=0 would make that coastal quad coplanar
      // with the skirt and z-fight it along every shoreline, so it sinks just
      // under the surface -- which is also what a beach does.
      pos.push(x, isSea(i, j) ? SHELF : h, z);
      col.push(c.r, c.g, c.b);
      index.set(key, id);
      return id;
    };

    let quads = 0;
    let wet = 0;
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
        // Open water: leave it to the water module, which shades it properly.
        if (isSea(i, j) && isSea(i + STRIDE, j)
          && isSea(i, j + STRIDE) && isSea(i + STRIDE, j + STRIDE)) { wet++; continue; }

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
      `${(idx.length / 3 / 1000).toFixed(0)}k tris, elevation 0..${hdr.max.toFixed(0)} m, ` +
      `${wet} all-sea quads left to the water`,
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

/**
 * Pack the wet half of the grid into a texture the water shader can read.
 *
 * Land is 0 so a single comparison rejects it, and the remaining 254 codes
 * carry depth. Linear filtering is deliberate: it softens the 407 m posts into
 * a shelving coast rather than a staircase, and the only place the blend is
 * wrong -- the texel straddling the waterline -- is under the far terrain's
 * own coastal quads, which are opaque and drawn above the water anyway.
 */
function publishBathymetry(el: Float32Array, hdr: FarHeader): FarBathymetry {
  const data = new Uint8Array(hdr.width * hdr.height);
  for (let k = 0; k < data.length; k++) {
    const e = el[k];
    if (!(e <= SEA_EPS)) continue; // land, and NaN-safe
    const d = Math.min(-e, MAX_DEPTH) / MAX_DEPTH;
    data[k] = 1 + Math.round(d * 254);
  }
  const tex = new THREE.DataTexture(data, hdr.width, hdr.height, THREE.RedFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return {
    tex,
    origin: new THREE.Vector2(hdr.originX, hdr.originZ),
    invSize: new THREE.Vector2(1 / hdr.sizeX, 1 / hdr.sizeZ),
    maxDepth: MAX_DEPTH,
  };
}

function hash01(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 8) / 16777216;
}
