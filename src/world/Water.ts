import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord } from '../core/types';
import { loadAreas } from '../core/data';
import { BOUNDS, SEA_LEVEL } from '../core/config';
import { MOBILE } from '../core/gpu';

/**
 * Estimated screen fraction of water below which the planar reflection is not
 * drawn.
 *
 * Deliberately far above the fraction that would actually be invisible,
 * because {@link Water.surfaceCoverage} cannot see occlusion and so
 * over-reports by a wide and variable margin. Measured against the truth --
 * obtained by flooding the water shader magenta and counting pixels --
 * across ten viewpoints:
 *
 *   viewpoint          true    estimate
 *   water-detail      49.8%       71.6%
 *   harbor-water      44.3%       72.1%
 *   high-street       16.0%       65.9%
 *   copley             2.7%       62.9%
 *   charles-water      2.7%       71.6%
 *   zakim              0.5%       53.7%
 *   comm-ave           0.0%       52.1%   <- the Charles, behind Back Bay
 *   common-street      0.0%      100.0%   <- camera inside the Frog Pond's box
 *   statehouse-face    0.0%        6.8%
 *   downtown-traffic   0.0%        7.4%
 *
 * Nothing with water genuinely on screen estimates below 52%, so 15% never
 * skips a frame that needed the pass -- a 3.5x margin. What it does catch is
 * the case where the surface is geometrically out of frame, which is worth
 * 6.1 ms at `downtown-traffic` and 2.7 ms at `statehouse-face`.
 *
 * It cannot catch `comm-ave` or `common-street`, where the water is in the
 * frustum and hidden behind the city. Getting those needs a real pixel count:
 * a WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE` query around the water draws,
 * read back a frame late. That is the way to finish this.
 */
const REFLECT_MIN_COVER = 0.15;
import { lonLatToWorld } from '../core/geo';
import { buildBodies, type WaterBody } from './water/bodies';
import { WaterField } from './water/field';
import { buildSurfaces, buildOceanSkirt } from './water/surface';
import { buildWaterTextures, type WaterTextures } from './water/textures';
import { PlanarReflection } from './water/reflection';
import { SurfaceVisibility } from './water/visibility';
import { WATER_VERT } from './water/shaders/water.vert';
import { waterFrag } from './water/shaders/water.frag';
import { GpuTimer } from './water/timing';

/**
 * The Charles, Boston Harbor, Fort Point Channel and every pond between.
 *
 * All 105 water bodies share one shader and one set of chunked meshes. Rather
 * than give each body its own material, the per-body character — wave fetch,
 * turbidity, bed depth, shore distance — is rasterised into a pair of field
 * textures at load, and the shader looks them up by world position. The
 * harbour can be choppy and brown while the Charles is glassy and green
 * without costing a second draw call.
 */

/** Field resolution: ~6 m per texel over the city keeps shorelines crisp. */
const FIELD_TEXEL = 6;

/** Water is clipped a little past the data so the Mystic doesn't end mid-air. */
const FIELD_PAD = 1200;
const CHUNK = 700;

/**
 * Surface lattice spacing, metres.
 *
 * The field stays at 6 m everywhere -- it is a texture and it costs the same
 * either way -- but the *mesh* built from it is the module's largest CPU
 * allocation, and on a phone or a tablet that is the budget that decides
 * whether the page loads at all. `App.releaseStaticAttributes` frees these
 * arrays on mobile, but only per geometry and only once that geometry has
 * actually been uploaded, i.e. once it has been drawn; a visitor who looks
 * one way holds every chunk behind them at full size, and the worst case is
 * the whole sheet, at boot, which is exactly when an iPad tab is killed.
 *
 * Halving the resolution quarters the interior vertices and halves the
 * shoreline cells. What it costs is the geometric part of the wave spectrum:
 * `oceanWaves` gates displacement on `smoothstep(3.2 * cell, 5.4 * cell,
 * lambda)`, so at 12 m only the 88 m swell still displaces and the 49 m
 * component is down to a third. Normals are unaffected -- they come from the
 * fragment cascade and the analytic Gerstner slope, neither of which knows
 * about the lattice -- so the surface still has every ripple it had, it just
 * stops physically rising by the last few centimetres.
 */
const CELL_DESKTOP = 6;
const CELL_MOBILE = 12;
/**
 * QA instrumentation, compiled in only when the page is loaded with `?wdbg`.
 *
 * Auto-exposure moves under any change, so absolute luma is not comparable
 * between two builds; the only sound way to attribute the brightness of a
 * term is to switch it off and back on inside one page session. That needs a
 * per-term gain in the shader, and a production shader should not carry six
 * dead multiplies, so the whole thing sits behind a define.
 */
const WATER_DEBUG = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('wdbg');


export class Water implements WorldModule {
  readonly name = 'Water';

  private root = new THREE.Group();
  private field: WaterField | null = null;
  private textures: WaterTextures | null = null;
  private material: THREE.ShaderMaterial | null = null;
  /** Same shader, WATER_SKIRT variant, for the off-data ocean plane. */
  private skirtMaterial: THREE.ShaderMaterial | null = null;
  private envBound = false;
  private reflection: PlanarReflection | null = null;
  private meshes: THREE.Mesh[] = [];
  private bodies: WaterBody[] = [];
  private time = 0;
  private reflectEnabled = false;
  private vis: SurfaceVisibility | null = null;
  private probe: THREE.Mesh | null = null;
  /** Surface lattice spacing actually used; see {@link CELL_DESKTOP}. */
  private cell = CELL_DESKTOP;

  // Scratch — allocating per frame is how you get GC hitches.
  private static _v3 = new THREE.Vector3();
  private static _m4 = new THREE.Matrix4();
  private timer: GpuTimer | null = null;

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'water';
    this.root.renderOrder = 6; // after opaque, before transparent overlays
    ctx.scene.add(this.root);

    let areas: AreaRecord[];
    try {
      areas = await loadAreas();
    } catch (err) {
      console.warn('[Water] no area data; skipping', err);
      return;
    }

    const [minX, maxZ] = lonLatToWorld(BOUNDS.west, BOUNDS.south);
    const [maxX, minZ] = lonLatToWorld(BOUNDS.east, BOUNDS.north);
    const rect = { minX, minZ, maxX, maxZ };

    this.bodies = buildBodies(areas, rect);
    if (!this.bodies.length) {
      console.warn('[Water] no water bodies found');
      return;
    }

    // Rasterise shore distance, fetch, turbidity and bed depth into the field.
    const field = new WaterField(rect, FIELD_PAD, FIELD_TEXEL);
    field.rasterise(this.bodies);
    field.measureInradii(this.bodies);
    field.refreshFetch(this.bodies);
    field.bakeBed(ctx.sampleHeight);
    field.buildTextures();
    this.field = field;

    // 512² is worth it: the atlas is laid down at four different tile sizes and
    // the eye finds a repeat in a 256² map long before the fades hide it.
    this.textures = buildWaterTextures(
      ctx.quality.anisotropy, ctx.quality.anisotropy >= 8 ? 512 : 256,
    );

    this.cell = MOBILE ? CELL_MOBILE : CELL_DESKTOP;
    const surf = buildSurfaces(this.bodies, field, this.cell, CHUNK);
    const skirt = buildOceanSkirt(field, rect, SEA_LEVEL);

    // Everything the field kept only for the build. See 'WaterField.compact'.
    const freedMB = field.compact() / 1048576;

    this.reflectEnabled = ctx.quality.waterReflections;
    if (this.reflectEnabled) {
      this.reflection = new PlanarReflection(window.innerWidth, window.innerHeight, {
        scale: ctx.quality.shadowMapSize >= 4096 ? 0.5 : 0.35,
        interval: ctx.quality.shadowMapSize >= 4096 ? 1 : 2,
        far: 6000,
      });
    }

    this.material = this.createMaterial(ctx, field, false);
    // The skirt reuses the same uniform objects, so everything the update loop
    // writes reaches both variants without being applied twice.
    this.skirtMaterial = this.createMaterial(ctx, field, true, this.material.uniforms);

    const pieces: Array<[THREE.BufferGeometry, THREE.ShaderMaterial]> =
      surf.chunks.map((g) => [g, this.material!] as [THREE.BufferGeometry, THREE.ShaderMaterial]);
    pieces.push([skirt, this.skirtMaterial]);

    // Hand the shoreline field to anyone who needs to know where the water is.
    // Water initialises before Roads, which is what makes this usable there.
    ctx.waterDistAt = (x, z) => field.sampleDist(x, z);

    this.timer = new GpuTimer(ctx.renderer.getContext());
    this.vis = new SurfaceVisibility(ctx.renderer.getContext());

    for (const [g, mat] of pieces) {
      const mesh = new THREE.Mesh(g, mat);
      // The skirt is named apart from the chunks because `__debug.pick` is how
      // anything out here gets attributed, and one shared name made the open
      // ocean and a harbour chunk indistinguishable in its output.
      mesh.name = mat === this.skirtMaterial ? 'water:skirt' : 'water:chunk';
      mesh.userData.noShadow = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false; // shading is fully handled in the shader
      mesh.matrixAutoUpdate = false;
      // One render order for every chunk keeps the whole surface contiguous
      // in the opaque list: the city draws first and rejects most of the
      // water's pixels on depth, and the GPU timer spans a single run of
      // draws instead of the entire frame.
      mesh.renderOrder = 6;
      const timer = this.timer;
      const vis = this.vis;
      if (timer.supported || vis.supported) {
        mesh.onBeforeRender = () => { timer.begin(); vis.begin(); };
        mesh.onAfterRender = () => { timer.end(); };
      }
      this.root.add(mesh);
      this.meshes.push(mesh);
    }

    // The sentinel that closes the occlusion span. A single degenerate
    // triangle one renderOrder past the water, so it is drawn immediately
    // after the last chunk: zero area so it cannot contribute a sample,
    // nothing written so it cannot tint or occlude, never frustum-culled so
    // it is always in the render list to be asked. See `visibility.ts`.
    if (this.vis.supported) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      const sentinel = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        name: 'water:probe', colorWrite: false, depthWrite: false, depthTest: false,
      }));
      sentinel.name = 'water:probe';
      sentinel.renderOrder = 7;
      sentinel.frustumCulled = false;
      sentinel.matrixAutoUpdate = false;
      sentinel.userData.noShadow = true;
      sentinel.castShadow = false;
      sentinel.receiveShadow = false;
      const vis = this.vis;
      sentinel.onBeforeRender = () => vis.end();
      this.root.add(sentinel);
      this.probe = sentinel;
    }

    ctx.stats.waterBodies = this.bodies.length;
    ctx.stats.waterTris = surf.triangles;
    console.info(
      `[Water] ${this.bodies.length} bodies, ${surf.chunks.length} chunks, ` +
      `${(surf.triangles / 1000).toFixed(0)}k tris at ${this.cell} m, ` +
      `reflections ${this.reflectEnabled ? 'on' : 'off'}, ` +
      `field scratch freed ${freedMB.toFixed(1)} MB`,
    );

    this.material.uniforms.uDetail.value = ctx.quality.anisotropy >= 8 ? 1 : 0.55;

    if (WATER_DEBUG) {
      const u = this.material.uniforms;
      (window as unknown as Record<string, unknown>).__water = {
        /** `set('uDbg', [body, refl, spec, foam])`, or any water uniform. */
        set: (name: string, v: number | number[]): void => {
          const t = u[name]?.value as { set?: (...a: number[]) => void } | number | undefined;
          if (t === undefined) throw new Error(`no water uniform ${name}`);
          if (typeof v === 'number') u[name].value = v;
          else (t as { set: (...a: number[]) => void }).set(...v);
        },
        get: (name: string): unknown => u[name]?.value,
        list: (): string[] => Object.keys(u),
      };
    }

    ctx.on('quality-changed', () => {
      this.material!.uniforms.uDetail.value = ctx.quality.anisotropy >= 8 ? 1 : 0.55;
      const want = ctx.quality.waterReflections;
      if (want === this.reflectEnabled) return;
      this.reflectEnabled = want;
      this.forEachMaterial((mm) => {
        mm.uniforms.uReflStrength.value = want ? 1 : 0;
        mm.defines.WATER_PLANAR = want ? 1 : 0;
        mm.needsUpdate = true;
      });
    });
  }

  private createMaterial(
    ctx: Ctx,
    field: WaterField,
    skirt: boolean,
    share?: Record<string, THREE.IUniform>,
  ): THREE.ShaderMaterial {
    const tex = this.textures!;
    const m = new THREE.ShaderMaterial({
      name: skirt ? 'water:skirt' : 'water',
      vertexShader: WATER_VERT,
      fragmentShader: waterFrag(ctx.aerial?.glsl ?? ''),
      lights: false,
      fog: false,
      // The surface meshes are already cut to the water polygons, so there is
      // nothing to blend against: drawing opaque keeps water out of the
      // transparency sort entirely, which is both faster and more robust.
      transparent: false,
      depthWrite: true,
      // The surface chunks are triangulated from OSM rings whose winding is
      // not consistent, so single-sided rendering silently culls whole water
      // bodies. Double-sided also lets you see the underside from beneath a
      // bridge deck.
      side: THREE.DoubleSide,
      defines: {
        // Raised to 1 the first time the sky publishes an environment probe;
        // starting at 0 avoids binding a sampler that has nothing behind it.
        WATER_ENV: 0,
        // three.js's PMREM sampler needs these; real values are filled in when
        // the probe arrives, since they depend on its resolution. The chunk
        // itself is behind ENVMAP_TYPE_CUBE_UV, so that has to be on for
        // textureCubeUV to exist at all.
        ENVMAP_TYPE_CUBE_UV: '',
        CUBEUV_TEXEL_WIDTH: '0.0013020833',
        CUBEUV_TEXEL_HEIGHT: '0.0009765625',
        CUBEUV_MAX_MIP: '8.0',
        WATER_PLANAR: this.reflectEnabled ? 1 : 0,
        ...(WATER_DEBUG ? { WATER_DEBUG: '' } : {}),
        ...(skirt ? { WATER_SKIRT: '' } : {}),
        // Only the skirt reaches past the shoreline field, so only the skirt
        // has any use for the coarse bathymetry out there.
        ...(skirt && ctx.farBathymetry ? { WATER_FAR_BATHY: '' } : {}),
      },
      uniforms: share ?? {
        uTime: { value: 0 },
        uSeaLevel: { value: SEA_LEVEL },
        // Boston's prevailing breeze is WNW; the vector is the direction the
        // wind blows *toward*, so it runs out over the harbour to the ESE.
        uWind: { value: new THREE.Vector2(0.82, 0.57) },
        uWindSpeed: { value: 6.2 },
        uGustiness: { value: 0.62 },
        uWaveAmp: { value: 0.92 },
        uPeak: { value: 0.42 },
        uCellSize: { value: this.cell },
        // How hard the detail cascade pushes each octave back along the slope
        // of the one above it. This is the horizontal half of a Gerstner
        // displacement and it is what turns rounded bumps into chop.
        uChop: { value: 1.35 },
        uRippleGain: { value: 1 },
        uGlitter: { value: 1 },
        uFoamGain: { value: 1 },
        uDetail: { value: 1 },
        uNight: { value: 0 },

        uFieldDist: { value: field.distTex },
        uFieldAux: { value: field.auxTex },
        uFieldOrigin: { value: new THREE.Vector2(field.x0, field.z0) },
        uFieldInvSize: { value: new THREE.Vector2(1 / (field.w * field.ts), 1 / (field.h * field.ts)) },
        uFieldTexel: { value: field.ts },

        uFarBathy: { value: ctx.farBathymetry?.tex ?? null },
        uFarOrigin: { value: ctx.farBathymetry?.origin ?? new THREE.Vector2() },
        uFarInvSize: { value: ctx.farBathymetry?.invSize ?? new THREE.Vector2() },
        uFarMaxDepth: { value: ctx.farBathymetry?.maxDepth ?? 1 },

        uWaves: { value: tex.waves },
        uNoise: { value: tex.noise },

        uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.76) },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uSkyAmbient: { value: new THREE.Color(0.3, 0.42, 0.58) },
        uCityGlow: { value: new THREE.Color(0.9, 0.62, 0.32) },
        uEnvIntensity: { value: 1 },
        envMap: { value: null },

        // Boston Harbor is turbid and green-brown; the impounded Charles is
        // murkier still and tannin-stained. Neither is anywhere near blue.
        uAbsorbA: { value: new THREE.Vector3(0.62, 0.22, 0.48) },  // harbour
        uAbsorbB: { value: new THREE.Vector3(0.95, 0.44, 1.10) },  // river
        // Nothing here is Caribbean. The harbour's backscatter is an olive
        // green with a real red component from suspended silt — drop the red
        // and it immediately reads as a tropical lagoon.
        uScatterA: { value: new THREE.Color(0.052, 0.082, 0.062) },
        // The impounded Charles: still tannin-brown, but the blue was low
        // enough that from two kilometres up — where the body is the whole
        // pixel — the basin read as a field of olive grass rather than as
        // water. Half a per cent of blue is the difference.
        uScatterB: { value: new THREE.Color(0.060, 0.072, 0.048) },
        uBedA: { value: new THREE.Color(0.085, 0.088, 0.076) },
        uBedB: { value: new THREE.Color(0.072, 0.066, 0.041) },
        // The shallow margin: mud stirred by the tide in the harbour, peat
        // and tannin along the Charles. This band is most of what tells you
        // the channel is deep and the edge is not.
        uSiltA: { value: new THREE.Color(0.150, 0.138, 0.104) },
        uSiltB: { value: new THREE.Color(0.146, 0.116, 0.062) },
        uFoamColor: { value: new THREE.Color(0.88, 0.90, 0.90) },

        uReflMap: { value: this.reflection?.target.texture ?? null },
        uReflMatrix: { value: this.reflection?.textureMatrix ?? new THREE.Matrix4() },
        uReflStrength: { value: this.reflectEnabled ? 1 : 0 },
        uReflMaxLod: { value: 0 },
        uReflBlur: { value: 9 },
        uReflSmear: { value: 1 },
        uReflDistort: { value: new THREE.Vector2(0.030, 0.085) },

        // (body, reflection+sky, specular, foam) and
        // (city glow, aerial perspective, false-colour view, spare).
        uDbg: { value: new THREE.Vector4(1, 1, 1, 1) },
        uDbg2: { value: new THREE.Vector4(1, 1, 0, 1) },
      },
    });
    // Opt into the shared atmosphere. A ShaderMaterial gets none of three's
    // fog machinery, so the sky module's chunk rewrite never reaches here and
    // the uniform objects have to be merged by hand — the *same* objects, so
    // the water breathes exactly the air the rest of the city does.
    if (ctx.aerial) Object.assign(m.uniforms, ctx.aerial.uniforms);
    else console.warn('[Water] no atmosphere published; reflections will be black');

    // Tell the post chain this surface is worth tracing screen-space
    // reflections against; it cannot infer that from a ShaderMaterial.
    m.userData.ssr = !skirt;
    return m;
  }

  /** Both variants share one uniform object, so write once. */
  private forEachMaterial(fn: (m: THREE.ShaderMaterial) => void): void {
    if (this.material) fn(this.material);
    if (this.skirtMaterial) fn(this.skirtMaterial);
  }

  update(dt: number, ctx: Ctx): void {
    const m = this.material;
    if (!m) return;

    this.timer?.poll();
    this.timer?.beginFrame();
    // Drains the previous frames' occlusion answers and arms this frame's, so
    // it has to run before the render and after the camera has its final pose.
    this.vis?.beginFrame();

    this.time += dt;
    m.uniforms.uTime.value = this.time;

    // The breeze is not constant. Two slow, incommensurate cycles move the
    // wind through ~40 degrees and the gust fronts in and out over a couple
    // of minutes, which is what stops a long look at the river from feeling
    // like a looping texture.
    const swing = Math.sin(this.time * 0.021) * 0.30 + Math.sin(this.time * 0.0071) * 0.14;
    const base = Math.atan2(0.57, 0.82);
    m.uniforms.uWind.value.set(Math.cos(base + swing), Math.sin(base + swing));
    m.uniforms.uWindSpeed.value = 5.4 + 2.1 * (0.5 + 0.5 * Math.sin(this.time * 0.013));
    m.uniforms.uGustiness.value = 0.50 + 0.22 * (0.5 + 0.5 * Math.sin(this.time * 0.0093 + 1.1));

    // Track the sky so the water is lit by the same sun and the same
    // atmosphere the rest of the city sees.
    const sun = ctx.sun;
    m.uniforms.uSunDir.value.copy(sun.direction);
    m.uniforms.uSunColor.value.copy(sun.color).multiplyScalar(Math.max(sun.intensity, 0));

    // Drive the analytic sky the water reflects from the real sun, so dawn,
    // the golden hour and the blue hour all read on the surface even before
    // the environment probe has refreshed.
    const elev = sun.elevation;
    const day = THREE.MathUtils.clamp((elev + 0.1) / 0.5, 0, 1);

    // What the *reflection* sees is no longer set here at all: it comes from
    // the atmosphere's sky-view table through 'ctx.aerial'. All that is left is
    // the downwelling that lights the body from above, which is an irradiance
    // rather than a radiance and has no equivalent in that table.
    m.uniforms.uSkyAmbient.value
      .setRGB(0.020, 0.030, 0.055)
      .lerp(new THREE.Color(0.30, 0.40, 0.55), day);

    // The sky is physically dim at night, so the sky module winds exposure up
    // ~4x. Anything authored display-referred — the city's own glow here, lit
    // windows elsewhere — has to come down by the same factor or it clips the
    // frame to white the moment the sun sets.
    const expo = ctx.exposure || 2.5;
    const comp = 2.5 / Math.max(expo, 0.1);

    // The same number drives the body of the water, which is authored the same
    // way — but only once the sun is actually down. It used to be a hand-rolled
    // proxy for daylight, `0.05 + 0.95*day²`, which reads 0.46 at five in the
    // afternoon and so halved the river's own colour through the entire golden
    // hour, hours before the exposure it was meant to cancel had moved at all.
    // Metering alone is no better: the water is the darkest large surface in
    // the frame, so a dark river meters the exposure up, which darkens the
    // river. Hold it at 1 while the sun is up and let the measurement take
    // over across dusk, where it is the only thing that keeps the channel from
    // clipping to white.
    const daylight = THREE.MathUtils.smoothstep(elev, -0.06, 0.10);
    m.uniforms.uEnvIntensity.value =
      THREE.MathUtils.clamp(Math.max(comp, daylight), 0.04, 1.25);

    // At night the brightest thing the Charles can reflect is the city.
    const night = 1 - THREE.MathUtils.smoothstep(elev, -0.02, 0.12);
    m.uniforms.uNight.value = night;
    m.uniforms.uCityGlow.value
      .setRGB(0.95, 0.62, 0.30)
      .multiplyScalar((1 - day * 0.9) * comp);

    // A low sun rakes the surface, so the glitter path has to be long and the
    // reflected city has to smear vertically; overhead there is nothing to
    // smear. Dawn and the golden hour are the two moments the water earns
    // its keep, and both are grazing-angle events.
    const graze = 1 - THREE.MathUtils.clamp(Math.abs(elev) / 0.6, 0, 1);
    m.uniforms.uGlitter.value = 0.8 + 1.5 * graze * graze;
    m.uniforms.uReflSmear.value = 0.55 + 0.75 * night;
    // Crests sharpen as the wind gets up, and a low sun shows the asymmetry.
    m.uniforms.uPeak.value = 0.30 + 0.22 * graze;

    if (ctx.envMap && !this.envBound) {
      this.envBound = true;
      // Mirror three.js's own PMREM constants (WebGLProgram): the mip chain
      // and texel size are derived from the probe's height.
      const h = (ctx.envMap.image as { height?: number } | undefined)?.height ?? 256;
      const maxMip = Math.log2(h) - 2;
      const texelH = 1 / h;
      const texelW = 1 / (3 * Math.max(2 ** maxMip, 7 * 16));
      this.forEachMaterial((mm) => {
        mm.uniforms.envMap.value = ctx.envMap;
        mm.defines.WATER_ENV = 1;
        mm.defines.CUBEUV_MAX_MIP = `${maxMip.toFixed(1)}`;
        mm.defines.CUBEUV_TEXEL_WIDTH = `${texelW}`;
        mm.defines.CUBEUV_TEXEL_HEIGHT = `${texelH}`;
        mm.needsUpdate = true;
      });
    }

    if (this.reflection && this.reflectEnabled) {
      // A second pass over the city is the single most expensive thing in the
      // frame -- 6.3 ms of 24.7 at `high-street`, a quarter of it, 87% of that
      // being the building tiles. It was running unconditionally, so a street
      // between two towers in the Financial District paid 6.1 ms to mirror
      // water that is not on screen at all. Measured at every inland street
      // viewpoint in the project, it was costing 10-25% of the frame for
      // nothing.
      const cover = this.surfaceCoverage(ctx);
      ctx.stats['water.cover'] = Math.round(cover * 1000) / 10;
      // Two tests, because neither alone is enough. The coverage estimate
      // catches water that is too small on screen to be worth mirroring but
      // cannot see occlusion; the occlusion query is exact about occlusion but
      // answers yes for a single surviving pixel. Together they cover both the
      // harbour glimpsed down an alley and the Charles hidden behind Back Bay.
      const seen = !this.vis?.supported || this.vis.visible;
      ctx.stats['water.seen'] = seen ? 1 : 0;
      if (cover >= REFLECT_MIN_COVER && seen) {
        m.uniforms.uReflMaxLod.value = this.reflection.maxLod;
        this.timer?.begin();
        this.reflection.render(ctx.renderer, ctx.scene, ctx.camera, SEA_LEVEL, this.root);
        this.timer?.end();
        ctx.stats['water.reflect'] = 1;
      } else {
        // So the frame the surface comes back is not mirroring wherever the
        // camera was standing when it left.
        this.reflection.invalidate();
        ctx.stats['water.reflect'] = 0;
      }
    }

    if (this.timer?.supported) ctx.stats['water.ms'] = Number(this.timer.ms.toFixed(2));
    ctx.stats['water.occluded'] = this.vis?.hidden ?? 0;
  }

  resize(width: number, height: number): void {
    this.reflection?.resize(width, height);
  }

  /**
   * Roughly how much of the screen the water *surface* covers, 0..1.
   *
   * A bounding *sphere* is the wrong primitive here and the first version of
   * this used one: water is flat, so its sphere is as fat as the chunk is
   * wide, and a single chunk six hundred metres away came out at 6% of the
   * frame when the truth was zero. Projecting the box instead -- which for
   * water is a slab a metre or two thick -- gives a sliver near the horizon,
   * which is what it actually is.
   *
   * Still an over-estimate, because it ignores the city standing in front of
   * it, and over-estimating means drawing the reflection, which is the safe
   * direction. The skirt is excluded on purpose: it is one mesh reaching the
   * horizon and it would report water on screen from anywhere. Every view
   * that can see open sea can also see a harbour chunk, and the skirt is
   * always the last mesh built.
   */
  private surfaceCoverage(ctx: Ctx): number {
    const cam = ctx.camera;
    if (this.meshes.length < 2) return 1;
    cam.updateMatrixWorld();
    Water._m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    let area = 0;
    for (let i = 0; i < this.meshes.length - 1; i++) {
      const mesh = this.meshes[i];
      if (!mesh.visible) continue;
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) continue;

      // Clip space by hand, keeping w. `Vector3.applyMatrix4` divides through
      // by it, which silently mirrors every corner behind the eye into
      // plausible-looking coordinates -- the first version of this read 100%
      // at every viewpoint in the project for exactly that reason.
      let minX = 1, maxX = -1, minY = 1, maxY = -1, front = 0;
      const near = cam.near;
      for (let c = 0; c < 8; c++) {
        Water._v3.set(
          c & 1 ? bb.max.x : bb.min.x,
          c & 2 ? bb.max.y : bb.min.y,
          c & 4 ? bb.max.z : bb.min.z,
        ).applyMatrix4(mesh.matrixWorld);
        const e = Water._m4.elements;
        const px = e[0] * Water._v3.x + e[4] * Water._v3.y + e[8] * Water._v3.z + e[12];
        const py = e[1] * Water._v3.x + e[5] * Water._v3.y + e[9] * Water._v3.z + e[13];
        const pw = e[3] * Water._v3.x + e[7] * Water._v3.y + e[11] * Water._v3.z + e[15];
        if (pw > near) front++;
        // A corner at or behind the eye has no screen position. Projecting it
        // at the near plane throws it far outside the viewport, which the clip
        // below bounds to the screen -- so a chunk the camera is standing in
        // reads as most of the frame, which is correct.
        const iw = 1 / Math.max(pw, near);
        const x = px * iw, y = py * iw;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (front === 0) continue;          // wholly behind the camera

      const w = Math.min(maxX, 1) - Math.max(minX, -1);
      const h = Math.min(maxY, 1) - Math.max(minY, -1);
      if (w <= 0 || h <= 0) continue;
      area += (w * h) / 4;
      if (area >= 1) return 1;
    }
    return area;
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.vis?.dispose();
    this.probe?.geometry.dispose();
    (this.probe?.material as THREE.Material | undefined)?.dispose();
    this.probe = null;
    for (const m of this.meshes) m.geometry.dispose();
    this.material?.dispose();
    this.skirtMaterial?.dispose();
    this.textures?.dispose();
    this.field?.dispose();
    this.reflection?.dispose();
    this.timer?.dispose();
    this.meshes.length = 0;
  }
}
