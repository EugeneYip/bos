import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord } from '../core/types';
import { loadAreas } from '../core/data';
import { BOUNDS, SEA_LEVEL } from '../core/config';
import { lonLatToWorld } from '../core/geo';
import { buildBodies, type WaterBody } from './water/bodies';
import { WaterField } from './water/field';
import { buildSurfaces, buildOceanSkirt } from './water/surface';
import { buildWaterTextures, type WaterTextures } from './water/textures';
import { PlanarReflection } from './water/reflection';
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

    this.textures = buildWaterTextures(ctx.quality.anisotropy, 256);

    const surf = buildSurfaces(this.bodies, field, FIELD_TEXEL, CHUNK);
    const skirt = buildOceanSkirt(field, rect, SEA_LEVEL);

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

    this.timer = new GpuTimer(ctx.renderer.getContext());

    for (const [g, mat] of pieces) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'water:chunk';
      mesh.userData.noShadow = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false; // shading is fully handled in the shader
      mesh.matrixAutoUpdate = false;
      // One render order for every chunk keeps the whole surface contiguous
      // in the opaque list: the city draws first and rejects most of the
      // water's pixels on depth, and the GPU timer spans a single run of
      // draws instead of the entire frame.
      mesh.renderOrder = 6;
      if (this.timer.supported) {
        mesh.onBeforeRender = () => this.timer?.begin();
        mesh.onAfterRender = () => this.timer?.end();
      }
      this.root.add(mesh);
      this.meshes.push(mesh);
    }

    ctx.stats.waterBodies = this.bodies.length;
    ctx.stats.waterTris = surf.triangles;
    console.info(
      `[Water] ${this.bodies.length} bodies, ${surf.chunks.length} chunks, ` +
      `${(surf.triangles / 1000).toFixed(0)}k tris, reflections ${this.reflectEnabled ? 'on' : 'off'}`,
    );

    this.material.uniforms.uDetail.value = ctx.quality.anisotropy >= 8 ? 1 : 0.55;

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
        ...(skirt ? { WATER_SKIRT: '' } : {}),
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
        uCellSize: { value: FIELD_TEXEL },
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
        uScatterA: { value: new THREE.Color(0.052, 0.082, 0.058) },
        uScatterB: { value: new THREE.Color(0.064, 0.072, 0.034) },
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
    const dusk = THREE.MathUtils.clamp(1 - Math.abs(elev) / 0.16, 0, 1);

    // What the *reflection* sees is no longer set here at all: it comes from
    // the atmosphere's sky-view table through 'ctx.aerial'. All that is left is
    // the downwelling that lights the body from above, which is an irradiance
    // rather than a radiance and has no equivalent in that table.
    m.uniforms.uSkyAmbient.value
      .setRGB(0.020, 0.030, 0.055)
      .lerp(new THREE.Color(0.30, 0.40, 0.55), day);

    m.uniforms.uEnvIntensity.value = 0.05 + 0.95 * day * day;

    // The sky is physically dim at night, so the sky module winds exposure up
    // ~4x. Anything authored display-referred — the city's own glow here, lit
    // windows elsewhere — has to come down by the same factor or it clips the
    // frame to white the moment the sun sets.
    const expo = ctx.exposure || 2.5;
    const comp = 2.5 / Math.max(expo, 0.1);

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
      m.uniforms.uReflMaxLod.value = this.reflection.maxLod;
      this.timer?.begin();
      this.reflection.render(ctx.renderer, ctx.scene, ctx.camera, SEA_LEVEL, this.root);
      this.timer?.end();
    }

    if (this.timer?.supported) ctx.stats['water.ms'] = Number(this.timer.ms.toFixed(2));
  }

  resize(width: number, height: number): void {
    this.reflection?.resize(width, height);
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
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
