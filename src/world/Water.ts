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
import { WATER_FRAG } from './water/shaders/water.frag';

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

    for (const [g, mat] of pieces) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'water:chunk';
      mesh.castShadow = false;
      mesh.receiveShadow = false; // shading is fully handled in the shader
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }

    ctx.stats.waterBodies = this.bodies.length;
    ctx.stats.waterTris = surf.triangles;
    console.info(
      `[Water] ${this.bodies.length} bodies, ${surf.chunks.length} chunks, ` +
      `${(surf.triangles / 1000).toFixed(0)}k tris, reflections ${this.reflectEnabled ? 'on' : 'off'}`,
    );

    ctx.on('quality-changed', () => {
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
      fragmentShader: WATER_FRAG,
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
        uWind: { value: new THREE.Vector2(0.72, -0.69) }, // prevailing WNW
        uWaveAmp: { value: 1 },
        uWaveCount: { value: ctx.quality.cloudSteps > 24 ? 6 : 4 },
        uRippleGain: { value: 1 },
        uGlitter: { value: 1 },
        uFoamGain: { value: 1 },

        uFieldDist: { value: field.distTex },
        uFieldAux: { value: field.auxTex },
        uFieldOrigin: { value: new THREE.Vector2(field.x0, field.z0) },
        uFieldInvSize: { value: new THREE.Vector2(1 / (field.w * field.ts), 1 / (field.h * field.ts)) },

        uWaves: { value: tex.waves },
        uNoise: { value: tex.noise },

        uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.76) },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uSkyZenith: { value: new THREE.Color(0.16, 0.32, 0.62) },
        uSkyHorizon: { value: new THREE.Color(0.62, 0.72, 0.84) },
        uSkyAmbient: { value: new THREE.Color(0.3, 0.42, 0.58) },
        uSkyGlow: { value: new THREE.Color(0.5, 0.58, 0.7) },
        uCityGlow: { value: new THREE.Color(0.9, 0.62, 0.32) },
        uEnvIntensity: { value: 1 },
        envMap: { value: null },

        // Boston Harbor is turbid and green-brown; the impounded Charles is
        // murkier still and tannin-stained. Neither is anywhere near blue.
        uAbsorbA: { value: new THREE.Vector3(0.62, 0.22, 0.48) },  // harbour
        uAbsorbB: { value: new THREE.Vector3(0.95, 0.44, 1.10) },  // river
        uScatterA: { value: new THREE.Color(0.055, 0.135, 0.115) },
        uScatterB: { value: new THREE.Color(0.070, 0.105, 0.062) },
        uBedA: { value: new THREE.Color(0.10, 0.10, 0.09) },
        uBedB: { value: new THREE.Color(0.13, 0.12, 0.08) },
        uFoamColor: { value: new THREE.Color(0.88, 0.90, 0.90) },

        uReflMap: { value: this.reflection?.target.texture ?? null },
        uReflMatrix: { value: this.reflection?.textureMatrix ?? new THREE.Matrix4() },
        uReflStrength: { value: this.reflectEnabled ? 1 : 0 },
        uReflMaxLod: { value: 0 },
        uReflDistort: { value: new THREE.Vector2(0.035, 0.11) },
        uHorizonFade: { value: new THREE.Vector2(4200, 17000) },
      },
    });
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

    this.time += dt;
    m.uniforms.uTime.value = this.time;

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

    m.uniforms.uSkyZenith.value
      .setRGB(0.030, 0.065, 0.18)
      .lerp(new THREE.Color(0.10, 0.26, 0.66), day);
    m.uniforms.uSkyHorizon.value
      .setRGB(0.035, 0.055, 0.11)
      .lerp(new THREE.Color(0.50, 0.64, 0.82), day)
      // Sunset spills warm light along the horizon, which is most of what a
      // low camera over the Charles actually sees reflected.
      // Sunset warms the horizon, but only briefly and never to orange paint.
      .lerp(new THREE.Color(0.85, 0.47, 0.26), dusk * 0.32);
    m.uniforms.uSkyAmbient.value
      .setRGB(0.020, 0.030, 0.055)
      .lerp(new THREE.Color(0.30, 0.40, 0.55), day);

    m.uniforms.uEnvIntensity.value = 0.18 + 0.82 * day;
    // At night the brightest thing the Charles can reflect is the city.
    m.uniforms.uCityGlow.value.setRGB(0.95, 0.62, 0.30).multiplyScalar(1 - day * 0.9);

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
      this.reflection.render(ctx.renderer, ctx.scene, ctx.camera, SEA_LEVEL, this.root);
    }
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
    this.meshes.length = 0;
  }
}
