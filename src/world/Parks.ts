import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaKind, AreaRecord } from '../core/types';
import { loadAreas } from '../core/data';
import { earcut } from './buildings/earcut';

/**
 * Green land, drawn as an explicit surface draped over the terrain.
 *
 * The terrain's land-cover splat carries the right data — Boston Common comes
 * through as 92% grass — but somewhere between the cover texture and the
 * shaded pixel the weight is lost and the city's parks render as pavement.
 * Rather than leave the Common looking like a car park, the green land-use
 * polygons are triangulated and laid directly on the ground as their own
 * surface. It is a decal layer, which is a normal way to do land use anyway:
 * the polygon edges come out crisp instead of filtered through a 4.5 m
 * raster, and each kind gets its own colour and texture scale.
 */

/** Kinds worth drawing, with a base colour and how big the texture tiles. */
const GREEN: Partial<Record<AreaKind, { color: number; tile: number; surface: string }>> = {
  park:     { color: 0x4f7a3c, tile: 5.5, surface: 'grass' },
  grass:    { color: 0x55823f, tile: 5.5, surface: 'grass' },
  forest:   { color: 0x33542c, tile: 6.5, surface: 'grass' },
  cemetery: { color: 0x4c7540, tile: 5.5, surface: 'grass' },
  golf:     { color: 0x5b8a41, tile: 6.0, surface: 'grass' },
  pitch:    { color: 0x4a7a46, tile: 4.5, surface: 'grass' },
  wetland:  { color: 0x556b3a, tile: 6.0, surface: 'grass' },
  beach:    { color: 0xc2ae86, tile: 4.0, surface: 'sand' },
  sand:     { color: 0xc4b089, tile: 4.0, surface: 'sand' },
};

/**
 * Lift above the terrain, metres. The terrain uses continuous-LOD morphing,
 * so its rendered surface slides vertically by more than a few centimetres as
 * chunks blend between levels; anything laid flatter than that pops in and
 * out. 0.22 m clears the morph without reading as a step at eye level.
 */
const LIFT = 0.22;
/**
 * Longest triangle edge before it gets split, metres. Ear-clipping a park
 * boundary gives a few enormous flat triangles; across the 6 m of relief on
 * Boston Common they simply dive under the ground. Splitting to this size and
 * re-sampling the terrain at every new vertex makes the surface follow it.
 *
 * Boston's parks are gentle, so 38 m is plenty: at 18 m the city's greenery
 * alone cost 444k triangles of dead-flat ground for no visible gain.
 */
const MAX_EDGE = 38;
/**
 * Mean linear luminance of the library's ground albedo maps, measured off the
 * baked textures. Vertex tints are divided by it so the product lands on the
 * colour actually asked for rather than on its square.
 */
const MAP_MEAN = 0.075;
/** Ceiling on the subdivided triangle count, city-wide. */
const TRI_BUDGET = 220000;

export class Parks implements WorldModule {
  readonly name = 'Parks';
  private root = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private triCount = 0;

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'parks';
    ctx.scene.add(this.root);

    let areas: AreaRecord[];
    try {
      areas = await loadAreas();
    } catch (err) {
      console.warn('[Parks] no area data; skipping', err);
      return;
    }

    // One bucket per surface so the whole city's greenery is a couple of draws.
    const buckets = new Map<string, { pos: number[]; uv: number[]; col: number[]; idx: number[] }>();
    let drawn = 0;
    let area = 0;

    // Largest first: the budget must reach Boston Common and the Esplanade
    // before it is spent on a thousand traffic islands.
    const green = areas
      .filter((r) => GREEN[r.kind] && r.outline && r.outline.length >= 8)
      .map((r) => ({ rec: r, extent: extentOf(r.outline) }))
      .sort((a, b) => b.extent - a.extent);

    for (const { rec } of green) {
      const spec = GREEN[rec.kind]!;
      const tri = this.triangulate(rec);
      if (!tri) continue;

      let b = buckets.get(spec.surface);
      if (!b) { b = { pos: [], uv: [], col: [], idx: [] }; buckets.set(spec.surface, b); }

      // Deterministic per-polygon shade so neighbouring lawns are not
      // identical. The vertex colour multiplies the map, and the library's
      // ground maps are authored dark (grass averages ~0.06 linear), so the
      // tint is divided through by that mean — otherwise two dark values
      // multiply together and the lawn comes out black.
      const jitter = hash01(rec.id) * 0.22 - 0.11;
      const c = new THREE.Color(spec.color).convertSRGBToLinear();
      c.offsetHSL(jitter * 0.04, jitter * 0.12, jitter * 0.10);
      c.multiplyScalar(1 / MAP_MEAN);

      // Emit as independent, terrain-sampled triangles: vertices are not
      // shared, which costs a little memory but lets each triangle subdivide
      // without renumbering its neighbours.
      const budget = Math.max(0, TRI_BUDGET - this.triCount);
      if (budget <= 0) continue;
      const emit = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void => {
        const base = b!.pos.length / 3;
        for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]] as const) {
          b!.pos.push(x, ctx.sampleHeight(x, z) + LIFT, z);
          // World-metre UVs, so texture scale is physical and seamless across
          // polygon boundaries.
          b!.uv.push(x / spec.tile, z / spec.tile);
          // Low-frequency patchiness at a scale the texture repeat cannot
          // match, which is what stops the lawn reading as a tiled grid.
          const n = valueNoise(x * 0.021, z * 0.021) * 0.30
                  + valueNoise(x * 0.085, z * 0.085) * 0.14;
          const k = 0.80 + n;
          b!.col.push(c.r * k, c.g * k, c.b * k);
        }
        b!.idx.push(base, base + 1, base + 2);
        this.triCount++;
      };
      for (let i = 0; i < tri.indices.length; i += 3) {
        const p0 = tri.indices[i] * 2, p1 = tri.indices[i + 1] * 2, p2 = tri.indices[i + 2] * 2;
        subdivide(
          tri.verts[p0], tri.verts[p0 + 1],
          tri.verts[p1], tri.verts[p1 + 1],
          tri.verts[p2], tri.verts[p2 + 1],
          emit, 0,
        );
      }
      drawn++;
      area += tri.area;
    }

    const anyLib = ctx.materials;
    for (const [surface, b] of buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setIndex(b.idx.length > 65535
        ? new THREE.Uint32BufferAttribute(b.idx, 1)
        : new THREE.Uint16BufferAttribute(b.idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();

      // Borrow the shared library's surface so parks match the rest of the
      // ground, falling back to a plain tinted material if it is unavailable.
      // Pull the map from the *material*: asking the library for a material
      // forces the family to bake, whereas its TextureSet may still be empty.
      let mat: THREE.MeshStandardMaterial;
      const src = anyLib.get(surface) as THREE.MeshStandardMaterial | undefined;
      const set = anyLib.textures(surface);
      const map = src?.map ?? set?.map ?? null;
      if (map) {
        mat = new THREE.MeshStandardMaterial({
          name: `park:${surface}`,
          map, normalMap: src?.normalMap ?? set?.normalMap ?? null,
          roughnessMap: src?.roughnessMap ?? set?.roughnessMap ?? null,
          roughness: 1, metalness: 0, vertexColors: true,
          // Ear-clipping in the XZ plane and then treating it as a Y-up
          // surface flips the handedness, so these come out back-facing and
          // FrontSide culls the lot — the same trap the water fell into.
          side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          name: `park:${surface}`, roughness: 0.95, metalness: 0, vertexColors: true,
          side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
        });
      }
      this.materials.push(mat);

      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `parks:${surface}`;
      mesh.castShadow = false;      // flat ground has nothing to cast onto
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }

    ctx.stats.parkPolys = drawn;
    ctx.stats.parkHa = Math.round(area / 10000);
    ctx.stats.parkTris = this.triCount;
    console.info(
      `[Parks] ${drawn} polygons, ${Math.round(area / 10000)} ha, ` +
      `${this.triCount} tris, ${this.meshes.length} draws`,
    );
  }

  /** Ear-clip a land-use polygon, holes included, into a draped surface. */
  private triangulate(rec: AreaRecord): { verts: number[]; indices: number[]; area: number } | null {
    const outer = rec.outline;
    if (!outer || outer.length < 8) return null;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      if (outer[i] < minX) minX = outer[i];
      if (outer[i] > maxX) maxX = outer[i];
      if (outer[i + 1] < minZ) minZ = outer[i + 1];
      if (outer[i + 1] > maxZ) maxZ = outer[i + 1];
    }
    const w = maxX - minX;
    const h = maxZ - minZ;
    if (w < 3 || h < 3) return null;

    const data: number[] = [...outer];
    const holeIdx: number[] = [];
    for (const hole of rec.holes ?? []) {
      if (hole.length < 8) continue;
      holeIdx.push(data.length / 2);
      data.push(...hole);
    }

    // No interior subdivision: earcut has no Steiner-point input, and faking
    // one by declaring each interior point as its own degenerate hole ring
    // produced ~79,000 spurious rings and a catastrophic triangulation.
    // Boston's parks are flat enough that the boundary alone follows the
    // ground acceptably, and the lift absorbs the rest.
    let indices: number[];
    try {
      indices = earcut(data, holeIdx.length ? holeIdx : null);
    } catch {
      return null;
    }
    if (!indices.length) return null;

    let a = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const p = indices[i] * 2, q = indices[i + 1] * 2, r = indices[i + 2] * 2;
      a += Math.abs((data[q] - data[p]) * (data[r + 1] - data[p + 1])
                  - (data[r] - data[p]) * (data[q + 1] - data[p + 1])) / 2;
    }
    return { verts: data, indices, area: a };
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.meshes.length = 0;
  }
}

/**
 * Split a triangle until no edge is longer than MAX_EDGE, calling `emit` for
 * each piece. Recursion depth is capped so a pathological sliver cannot run
 * away.
 */
function subdivide(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
  emit: (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => void,
  depth: number,
): void {
  const ab = Math.hypot(bx - ax, bz - az);
  const bc = Math.hypot(cx - bx, cz - bz);
  const ca = Math.hypot(ax - cx, az - cz);
  const longest = Math.max(ab, bc, ca);
  if (longest <= MAX_EDGE || depth >= 7) { emit(ax, az, bx, bz, cx, cz); return; }
  // Split the longest edge only: it keeps triangles better shaped than a
  // uniform four-way split and converges just as fast.
  if (ab === longest) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    subdivide(ax, az, mx, mz, cx, cz, emit, depth + 1);
    subdivide(mx, mz, bx, bz, cx, cz, emit, depth + 1);
  } else if (bc === longest) {
    const mx = (bx + cx) / 2, mz = (bz + cz) / 2;
    subdivide(ax, az, bx, bz, mx, mz, emit, depth + 1);
    subdivide(ax, az, mx, mz, cx, cz, emit, depth + 1);
  } else {
    const mx = (cx + ax) / 2, mz = (cz + az) / 2;
    subdivide(ax, az, bx, bz, mx, mz, emit, depth + 1);
    subdivide(mx, mz, bx, bz, cx, cz, emit, depth + 1);
  }
}

/** Bounding-box area, used only to order the work. */
/** Cheap smooth value noise in [0,1), for ground patchiness. */
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const h = (a: number, b: number): number => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 8) / 16777216;
  };
  const sx = xf * xf * (3 - 2 * xf);
  const sz = zf * zf * (3 - 2 * zf);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

function extentOf(r: number[]): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < minX) minX = r[i];
    if (r[i] > maxX) maxX = r[i];
    if (r[i + 1] < minZ) minZ = r[i + 1];
    if (r[i + 1] > maxZ) maxZ = r[i + 1];
  }
  return (maxX - minX) * (maxZ - minZ);
}

function pointInRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) & 0xffffff) / 0xffffff;
}
