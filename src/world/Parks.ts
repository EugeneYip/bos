import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaKind, AreaRecord, PropSet } from '../core/types';
import { loadAreas, loadProps } from '../core/data';
import { applyAntiTiling } from '../materials/Materials';
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
 *
 * Three things make the difference between "a green polygon" and ground:
 *
 *  - **No tile lattice.** The library's hex-cell stochastic sampler is
 *    compiled in, because a lawn is the worst possible surface for a repeating
 *    tile: it is seen at a grazing angle, it fills half the frame, and the eye
 *    finds the grid instantly. With a 4.5 m repeat it read as corduroy.
 *  - **An albedo that means something.** The library's ground maps are
 *    authored dark and the tint used to be divided through by their mean,
 *    which multiplied the map's *peaks* to six times the colour asked for and
 *    clipped Boston Common to a sheet of fluorescent green. The map is now
 *    reduced to a luminance-preserving modulation around 1 and the vertex tint
 *    is the albedo, full stop.
 *  - **Wear.** Real parkland is not uniform. It is bare and compacted under
 *    the big trees and scuffed to earth wherever people cut a corner, and the
 *    bare ground has to land under the *actual* trees — so the same tree
 *    points the Vegetation module plants are splatted into a canopy raster and
 *    handed to the shader.
 */

/** Kinds worth drawing, with a base colour and how big the texture tiles. */
const GREEN: Partial<Record<AreaKind, { color: number; tile: number; surface: string }>> = {
  park:     { color: 0x5d7040, tile: 4.5, surface: 'grass' },
  grass:    { color: 0x64784a, tile: 4.5, surface: 'grass' },
  forest:   { color: 0x41522f, tile: 5.5, surface: 'grass' },
  cemetery: { color: 0x5b7042, tile: 4.5, surface: 'grass' },
  golf:     { color: 0x66803f, tile: 5.0, surface: 'grass' },
  pitch:    { color: 0x5a7440, tile: 4.0, surface: 'grass' },
  wetland:  { color: 0x5c6739, tile: 5.0, surface: 'grass' },
  beach:    { color: 0xbfae8c, tile: 4.0, surface: 'sand' },
  sand:     { color: 0xc1b08f, tile: 4.0, surface: 'sand' },
};

/**
 * Bare, compacted soil: what a lawn turns into under a closed crown.
 *
 * Dry trodden earth in dappled shade is around 0.09 linear, not 0.06 — and
 * because the post chain's screen-space occlusion multiplies the *whole*
 * shaded colour under a canopy rather than only its indirect part, anything
 * darker than this reads as a hole in the ground rather than as soil.
 */
const SOIL = new THREE.Vector3(0.088, 0.068, 0.047);

/**
 * Lift above the terrain, metres. The terrain uses continuous-LOD morphing,
 * so its rendered surface slides vertically by more than a few centimetres as
 * chunks blend between levels; anything laid flatter than that pops in and
 * out. 0.22 m clears the morph without reading as a step at eye level.
 */
/** Even-odd point-in-ring on a flat [x,z,...] outline. */
function pointInRing(r: readonly number[], px: number, pz: number): boolean {
  let hit = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Metres inside the waterline at which a lawn triangle is dropped. */
const WATER_TRIM = 1.0;

const LIFT = 0.22;
/**
 * Longest triangle edge before it gets split, metres. Ear-clipping a park
 * boundary gives a few enormous flat triangles; across the 6 m of relief on
 * Boston Common they simply dive under the ground. Splitting to this size and
 * re-sampling the terrain at every new vertex makes the surface follow it.
 *
 * Boston's parks are gentle, so 38 m is plenty: at 18 m the city's greenery
 * alone cost 444k triangles of dead-flat ground for no visible gain. Every
 * sub-38 m variation — patchiness, wear, bare ground under the canopy — is a
 * shader term instead, which is both cheaper and sharper.
 */
const MAX_EDGE = 38;
/**
 * Mean linear luminance of the library's ground albedo maps, measured off the
 * baked textures. The shader divides the sampled map through by it to get a
 * modulation whose mean is 1, so the vertex tint survives as the albedo.
 */
const MAP_MEAN = 0.075;
/** Ceiling on the subdivided triangle count, city-wide. */
const TRI_BUDGET = 220000;

/** Canopy raster cell, metres. A crown is 8-14 m across, so this resolves one. */
const CANOPY_CELL = 6;
/** Weight one tree deposits into the accumulator: 4 on its cell, 1 on each neighbour. */
const STAMP_W = 12;
/** 9 blur taps x STAMP_W, divided by (crown area / cell area) ~ 78/36. */
const COVER_DIV = (9 * STAMP_W) / (78 / (CANOPY_CELL * CANOPY_CELL));
/** Un-occluded skylight floor for park ground. See `surfaceMaterial`. */
const SKY_FLOOR = 0.55;

interface CanopyField {
  tex: THREE.DataTexture;
  /** World-space origin and 1/(size in metres), for the UV transform. */
  originX: number;
  originZ: number;
  invW: number;
  invH: number;
}

export class Parks implements WorldModule {
  readonly name = 'Parks';
  private root = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private triCount = 0;
  private canopy?: CanopyField;

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
    // Shared with Vegetation and already cached by the loader, so this is free.
    try {
      this.canopy = buildCanopy(await loadProps());
    } catch {
      /* no props: the lawn just comes out uniformly unshaded. */
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

    // Published by the Water module, which initialises before this one.
    const waterAt = ctx.waterDistAt;
    let overWater = 0;

    // Wharf decks are not lawns. OSM's 'Charlestown Navy Yard' park covers
    // Pier 1, which is paved, so once the pier was cut out of the harbour as a
    // hole -- making it land, and so exempt from the water test above -- the
    // grass came back on top of it. Cheap because the piers get one union
    // bounding box and there are only a couple of hundred of them.
    const piers = areas.filter((a) => a.kind === 'pier' && a.outline && a.outline.length >= 6);
    let pBox: [number, number, number, number] | null = null;
    for (const a of piers) {
      for (let i = 0; i < a.outline.length; i += 2) {
        const x = a.outline[i], z = a.outline[i + 1];
        if (!pBox) pBox = [x, x, z, z];
        else {
          if (x < pBox[0]) pBox[0] = x;
          if (x > pBox[1]) pBox[1] = x;
          if (z < pBox[2]) pBox[2] = z;
          if (z > pBox[3]) pBox[3] = z;
        }
      }
    }
    const onWharf = (x: number, z: number): boolean => {
      if (!pBox || x < pBox[0] || x > pBox[1] || z < pBox[2] || z > pBox[3]) return false;
      for (const a of piers) {
        if (!pointInRing(a.outline, x, z)) continue;
        if (a.holes?.some((h) => pointInRing(h, x, z))) continue;
        return true;
      }
      return false;
    };
    let onDeck = 0;

    for (const { rec } of green) {
      const spec = GREEN[rec.kind]!;
      const tri = this.triangulate(rec);
      if (!tri) continue;

      let b = buckets.get(spec.surface);
      if (!b) { b = { pos: [], uv: [], col: [], idx: [] }; buckets.set(spec.surface, b); }

      // Deterministic per-polygon shade so neighbouring lawns are not
      // identical. The vertex colour *is* the albedo now — the shader hands it
      // a mean-1 modulation rather than a dark map to fight with.
      const jitter = hash01(rec.id) * 0.22 - 0.11;
      // NOTE: this converts sRGB to linear *twice* — `new THREE.Color(hex)`
      // already does it under three's `ColorManagement`, which is on. That
      // makes this roughly six times darker than the hex asks for, and it is
      // left in place deliberately: `MAP_MEAN` below was measured off the baked
      // textures *with* this in the chain, so removing one without re-deriving
      // the other turns every lawn in Boston six times brighter. Fix the pair
      // together or not at all.
      const c = new THREE.Color(spec.color).convertSRGBToLinear();
      c.offsetHSL(jitter * 0.05, jitter * 0.14, jitter * 0.10);

      // Emit as independent, terrain-sampled triangles: vertices are not
      // shared, which costs a little memory but lets each triangle subdivide
      // without renumbering its neighbours.
      const budget = Math.max(0, TRI_BUDGET - this.triCount);
      if (budget <= 0) continue;
      const emit = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void => {
        // A land-use polygon is not clipped against the harbour, and OSM's
        // 'Charlestown Navy Yard' park covers the whole wharf, basin included.
        // So its lawn was laid straight across the water the USS Constitution
        // is berthed in, coincident with the water surface and winning the
        // depth fight at some angles: the frigate appeared to be moored on
        // grass. The land-cover pass order already knows water beats park --
        // water is pass 3, park is pass 1 -- but this geometry is built
        // independently of that and knew nothing about it.
        //
        // `subdivide` has already cut these triangles down, so the centroid is
        // a fair test. The threshold is a metre *inside* the waterline rather
        // than zero, so a lawn still runs to the water's edge instead of
        // pulling back from it.
        const mx = (ax + bx + cx) / 3;
        const mz = (az + bz + cz) / 3;
        if (waterAt && waterAt(mx, mz) > WATER_TRIM) { overWater++; return; }
        if (onWharf(mx, mz)) { onDeck++; return; }
        const base = b!.pos.length / 3;
        for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]] as const) {
          b!.pos.push(x, ctx.sampleHeight(x, z) + LIFT, z);
          // World-metre UVs, so texture scale is physical and seamless across
          // polygon boundaries.
          b!.uv.push(x / spec.tile, z / spec.tile);
          b!.col.push(c.r, c.g, c.b);
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

    ctx.stats.parksOverWater = overWater;
    ctx.stats.parksOnWharf = onDeck;

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

      const mat = this.surfaceMaterial(ctx, surface);
      this.materials.push(mat);

      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `parks:${surface}`;
      // Flat ground has nothing to cast onto, and casting is actively
      // harmful here: these polygons are DoubleSide (the ear-clipped rings
      // wind inconsistently), so their own front faces land in the shadow
      // map and the surface fails the depth comparison against itself. The
      // flag, not the field, is what the sky module's sweep reads.
      mesh.userData.noShadow = true;
      mesh.castShadow = false;
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

  // -------------------------------------------------------------------------

  /**
   * The ground surface for one land-use family.
   *
   * Borrows the shared library's baked maps so parks match the rest of the
   * ground, with the hex-cell stochastic sampler compiled in, the map's
   * contrast reduced to a modulation, and the canopy/wear field applied on
   * top. Falls back to a plain tinted material if the library has nothing.
   */
  private surfaceMaterial(ctx: Ctx, surface: string): THREE.MeshStandardMaterial {
    // Pull the map from the *material*: asking the library for a material
    // forces the family to bake, whereas its TextureSet may still be empty.
    const src = ctx.materials.get(surface) as THREE.MeshStandardMaterial | undefined;
    const set = ctx.materials.textures(surface);
    const map = src?.map ?? set?.map ?? null;

    if (!map) {
      // No map to modulate, so the tint is used directly.
      console.warn(`[Parks] no albedo map for '${surface}'; using flat tint`);
      return new THREE.MeshStandardMaterial({
        name: `park:${surface}`, roughness: 0.95, metalness: 0, vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      });
    }

    const mat = new THREE.MeshStandardMaterial({
      name: `park:${surface}`,
      map,
      normalMap: src?.normalMap ?? set?.normalMap ?? null,
      roughnessMap: src?.roughnessMap ?? set?.roughnessMap ?? null,
      roughness: 1, metalness: 0, vertexColors: true,
      // Ear-clipping in the XZ plane and then treating it as a Y-up surface
      // flips the handedness, so these come out back-facing and FrontSide
      // culls the lot — the same trap the water fell into.
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    });
    // Ground seen at a grazing angle over-reads slope enormously, and a lawn
    // has about 10 mm of relief. At the library's strength the near field
    // turned to corduroy the moment the sun got low.
    mat.normalScale = new THREE.Vector2(0.28, 0.28);

    // Small hex cells and a soft blend: a lawn has no structure to protect, so
    // the more aggressively the lattice is broken up the better. This also
    // installs `bosWorldPos` and `bosAtValue`, which the wear term uses.
    applyAntiTiling(mat, {
      hexScale: 0.3, hexContrast: 4, macroMeters: 52, macroStrength: 0.2,
    });

    const canopy = this.canopy;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      shader.uniforms.uSoil = { value: SOIL };
      shader.uniforms.uWear = { value: surface === 'sand' ? 0 : 1 };
      shader.uniforms.uSky = { value: SKY_FLOOR };
      shader.uniforms.uCanopyMap = { value: canopy?.tex ?? null };
      shader.uniforms.uCanopyXf = {
        value: canopy
          ? new THREE.Vector4(canopy.originX, canopy.originZ, canopy.invW, canopy.invH)
          : new THREE.Vector4(0, 0, 0, 0),
      };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          uniform vec3  uSoil;
          uniform float uWear;
          uniform float uSky;
          uniform vec4  uCanopyXf;
          #ifdef PARK_CANOPY
            uniform sampler2D uCanopyMap;
          #endif
          // Set in <color_fragment>, read in <lights_fragment_maps>. The
          // fragment shader runs the two in that order, so a plain global is
          // enough and no varying is needed.
          float parkShade = 0.0;
        `)
        .replace('#include <color_fragment>', /* glsl */ `
        {
          // The map arrives as an albedo authored around a mean of ${MAP_MEAN.toFixed(3)}
          // linear. Reduce it to a luminance-preserving modulation whose mean
          // is 1 and whose contrast is square-rooted, so the vertex colour
          // that follows lands on the albedo actually asked for instead of on
          // six times its peak.
          float parkLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
          vec3 parkHue = diffuseColor.rgb / parkLum;
          float parkK = clamp( sqrt( parkLum / ${MAP_MEAN.toFixed(4)} ), 0.42, 1.9 );
          diffuseColor.rgb = mix( vec3( 1.0 ), parkHue, 0.4 ) * parkK;
        }
        #include <color_fragment>
        {
          // Patchiness at wavelengths the texture repeat cannot reach: this is
          // the difference between a lawn and a billiard cloth.
          vec2 pw = bosWorldPos.xz;
          float parkPatch = bosAtValue( pw * 0.019 ) * 0.62 + bosAtValue( pw * 0.078 ) * 0.26
                      + bosAtValue( pw * 0.31 ) * 0.12;
          diffuseColor.rgb *= 0.74 + 0.52 * parkPatch;

          float shade = 0.0;
          #ifdef PARK_CANOPY
            vec2 cuv = ( pw - uCanopyXf.xy ) * uCanopyXf.zw;
            shade = texture2D( uCanopyMap, cuv ).r;
          #endif
          parkShade = shade;
          // Bare ground. Dense shade thins the turf; so does being walked on,
          // and a slow noise field stands in for the desire paths and worn
          // corners that every real lawn has.
          //
          // Both terms are deliberately restrained. Boston Common is a lawn
          // with worn patches, not a dust bowl, and it has to read green from
          // three thousand feet: at 0.72 of shade capped at 0.86, the whole of
          // the Common and the Public Garden came out olive-brown from the air
          // and khaki at eye level.
          float trample = smoothstep( 0.66, 0.97, bosAtValue( pw * 0.026 + 41.3 ) );
          float bare = clamp( shade * 0.46 + trample * 0.38, 0.0, 0.58 ) * uWear;
          diffuseColor.rgb = mix( diffuseColor.rgb, uSoil * ( 0.7 + 0.6 * parkPatch ), bare );
          // …and it is damper and more overhung, so it is darker too.
          diffuseColor.rgb *= 1.0 - 0.10 * shade * uWear;
        }
        `)
        // Skylight that the post chain's occlusion has no business removing.
        //
        // A lawn in the shade of a tree still sees most of the sky, so it sits
        // about three stops under the sunlit lawn beside it. Measured, Boston
        // Common's shaded turf was *five* stops down — 11 of 255, under the
        // grade pass's grain floor, so every bit of albedo, wear and blade
        // detail in this file and in `groundcover.ts` was being thrown away.
        // Screen-space occlusion multiplies the whole shaded colour rather
        // than its indirect part, and the canopy overhead drives it to almost
        // nothing. This floor is tinted green because light that has come
        // through a canopy is green, and it is strongest where the canopy is.
        .replace('#include <lights_fragment_maps>', /* glsl */ `
          #include <lights_fragment_maps>
          #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
            iblIrradiance += getIBLIrradiance( vec3( 0.0, 1.0, 0.0 ) )
              * vec3( 0.80, 1.0, 0.74 ) * uSky * ( 0.30 + 0.70 * parkShade );
          #endif
        `);
    };
    mat.defines = mat.defines ?? {};
    if (canopy) (mat.defines as Record<string, unknown>).PARK_CANOPY = '';
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => `park|${surface}|${canopy ? 1 : 0}|${prevKey.call(mat)}`;
    return mat;
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
    this.canopy?.tex.dispose();
    this.canopy = undefined;
    this.meshes.length = 0;
  }
}

/**
 * Splat the city's tree points into a coarse cover raster and upload it.
 *
 * Two passes: one to accumulate crowns, one 3x3 box blur, so the field is
 * smooth enough for a bilinear lookup not to show the cell grid. 6 m cells
 * over Boston is about 1.4 MB, which buys per-pixel bare ground under every
 * tree in the city for one texture fetch.
 */
function buildCanopy(sets: PropSet[]): CanopyField | undefined {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let n = 0;
  for (const s of sets) {
    if (s.kind !== 'tree') continue;
    const m = s.positions.length / 3;
    n += m;
    for (let i = 0; i < m; i++) {
      const x = s.positions[i * 3];
      const z = s.positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!n || !isFinite(minX)) return undefined;

  const pad = CANOPY_CELL * 4;
  const x0 = minX - pad;
  const z0 = minZ - pad;
  const nx = Math.ceil((maxX + pad - x0) / CANOPY_CELL) + 1;
  const nz = Math.ceil((maxZ + pad - z0) / CANOPY_CELL) + 1;
  const acc = new Uint16Array(nx * nz);

  // One crown covers roughly a 12 m disc, so stamp the cell and its
  // neighbours with a falling weight.
  for (const s of sets) {
    if (s.kind !== 'tree') continue;
    const m = s.positions.length / 3;
    for (let i = 0; i < m; i++) {
      const ci = Math.floor((s.positions[i * 3] - x0) / CANOPY_CELL);
      const cj = Math.floor((s.positions[i * 3 + 2] - z0) / CANOPY_CELL);
      for (let dj = -1; dj <= 1; dj++) {
        const jj = cj + dj;
        if (jj < 0 || jj >= nz) continue;
        const row = jj * nx;
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= nx) continue;
          acc[row + ii] += di === 0 && dj === 0 ? 4 : 1;
        }
      }
    }
  }

  const out = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= nz) continue;
        const row = jj * nx;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          sum += acc[row + ii];
        }
      }
      // Turn the weighted stamp count into a crown *coverage fraction*, which
      // is the only normalisation that does not have to be retuned when the
      // tree count changes.
      //
      // Each tree contributes STAMP_W to `acc` spread over its 3x3, and the
      // blur sums a further 3x3, so `sum / (9 * STAMP_W)` is the weighted
      // number of tree centres attributable to one cell. Multiplying by
      // (crown area / cell area) — about 78 m² over 36 m² — gives coverage.
      //
      // Measured against the shipped 88 229 tree points this puts the median
      // treed cell at 0.18 and the densest 1 % at 0.76, which is what a park
      // actually looks like. The 20 this replaced saturated at the 90th
      // percentile, so a tenth of every green surface in the city was pinned
      // at "fully closed canopy".
      out[j * nx + i] = Math.min(255, Math.round((sum / COVER_DIV) * 255));
    }
  }

  const tex = new THREE.DataTexture(out, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'parks:canopy';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return {
    tex,
    originX: x0,
    originZ: z0,
    invW: 1 / (nx * CANOPY_CELL),
    invH: 1 / (nz * CANOPY_CELL),
  };
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

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) & 0xffffff) / 0xffffff;
}
