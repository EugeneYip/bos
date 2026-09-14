import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { ATMOSPHERE, ORIGIN, type QualityTier } from '../core/config';
import { lonLatToWorld } from '../core/geo';

import {
  greenwichMeanSiderealTime,
  julianDate,
  moonPosition,
  sunPosition,
  type LunarSample,
  type SolarSample,
} from './astro';
import { AtmosphereLuts, PLANET_RADIUS_MM, SUN_ANGULAR_RADIUS, sunTransmittanceCPU } from './AtmosphereLuts';
import { CascadedShadows } from './CascadedShadows';
import { CloudLayer, type CloudSettings } from './CloudLayer';
import { EnvProbe } from './EnvProbe';
import { patchGlobalChunks, SceneShading } from './SceneShading';
import { Starfield } from './Starfield';
import { SKY_DOME_FRAG, SKY_DOME_VERT } from './shaders/skyDome';
import { clamp, damp, GpuTimer, lerp, smoothstep } from './util';
import { lerpWeather, weatherPreset, WEATHER_NAMES, type WeatherPreset, type WeatherState } from './weather';

/**
 * # Sky
 *
 * Atmosphere, sun, moon, stars, clouds, and every light in the city.
 *
 * ## Radiometric convention
 *
 * One unit of irradiance is the solar constant at the top of the atmosphere
 * (~128 klx). Everything downstream is consistent with that: the sky-view LUT
 * returns radiance per steradian in those units (clear zenith lands around
 * 0.02, matching ~3000 cd/m^2); the key light's `intensity` is the transmitted
 * fraction of the beam, so a white Lambertian roof at noon renders at about
 * `0.85 / PI`; the IBL is the same sky, prefiltered. Nothing anywhere
 * multiplies by a magic brightness constant.
 *
 * The whole dynamic range — 1e9:1 between the solar disc and the night sky —
 * is then compressed by exposure alone, published on `ctx.emit('exposure')`
 * and keyed to solar elevation. That is the one deliberate departure from
 * physics: a truly physical night exposure would render the moon as a
 * blinding disc over an invisible city, so night is lifted to roughly the
 * brightness a dark-adapted eye reports rather than the one a photometer does.
 *
 * ## What this module publishes
 *
 * | Output | Where |
 * |---|---|
 * | sun direction / colour / intensity / elevation / azimuth | `ctx.sun` |
 * | prefiltered environment | `ctx.envMap`, `scene.environment` |
 * | exposure | `ctx.emit('exposure', v)` and `renderer.toneMappingExposure` |
 * | aerial perspective + cloud shadows | injected into every material |
 * | cascaded shadows | four `DirectionalLight`s it owns exclusively |
 *
 * and it listens for `'weather'` (a {@link WeatherPreset} name), plus
 * `'time-changed'` and `'quality-changed'`.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Radiance of the solar disc, in units where TOA solar irradiance is 1. */
const SUN_DISC_RADIANCE = 1 / (Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS * 0.82);

/**
 * Key-light irradiance under a full moon. Physically this is 2e-6; night is
 * compressed, so it is lifted to something a dark-adapted eye would report.
 */
const MOON_KEY_IRRADIANCE = 0.013;

/** Disc radiance of a full moon in the same units (~2500 cd/m^2). */
const MOON_DISC_RADIANCE = 0.052;

/** Drawn larger than the real 0.26 degrees so it reads at 1080p. */
const MOON_SIZE_BOOST = 1.6;

/** Vertical aerosol optical depth of a clean day; scales the solar aureole. */
const AEROSOL_TAU = 0.092;

/**
 * Exposure against apparent solar elevation in degrees. Interpolated with
 * smoothstep so there is no kink anywhere in the day.
 */
const EXPOSURE_CURVE: ReadonlyArray<readonly [number, number]> = [
  [60, 2.40],
  [30, 2.50],
  [15, 2.75],
  [6, 3.45],
  [1.5, 5.0],
  [0, 6.4],
  [-3, 11.5],
  [-6, 20.0],
  [-9, 31.0],
  [-12, 39.0],
  [-18, 46.0],
  [-90, 48.0],
];

function exposureFor(elevationDeg: number): number {
  const c = EXPOSURE_CURVE;
  if (elevationDeg >= c[0][0]) return c[0][1];
  for (let i = 0; i < c.length - 1; i++) {
    const [hiE, hiV] = c[i];
    const [loE, loV] = c[i + 1];
    if (elevationDeg <= hiE && elevationDeg >= loE) {
      return lerp(loV, hiV, smoothstep(loE, hiE, elevationDeg));
    }
  }
  return c[c.length - 1][1];
}

/** Per-tier cloud buffer resolution, as a fraction of the framebuffer. */
const CLOUD_SCALE: Record<QualityTier, number> = {
  low: 0.4,
  medium: 0.42,
  high: 0.5,
  ultra: 0.6,
};

export class Sky implements WorldModule {
  readonly name = 'Sky';

  private ctx!: Ctx;
  private group = new THREE.Group();

  private luts!: AtmosphereLuts;
  private dome!: THREE.Mesh;
  private domeMaterial!: THREE.ShaderMaterial;
  private stars!: Starfield;
  private clouds!: CloudLayer;
  private csm!: CascadedShadows;
  private shading = new SceneShading();
  private env!: EnvProbe;
  private timer!: GpuTimer;

  /** Observer, from the projection origin in `core/config`. */
  private readonly latitude = ORIGIN.lat;
  private readonly longitude = ORIGIN.lon;
  private readonly utcOffset = ATMOSPHERE.utcOffsetHours;
  private readonly downtown = new THREE.Vector2();

  private weather: WeatherState = weatherPreset('clear');
  private weatherFrom: WeatherState = weatherPreset('clear');
  private weatherTo: WeatherState = weatherPreset('clear');
  private weatherT = 1;
  private weatherName: WeatherPreset = 'clear';

  private sun!: SolarSample;
  private moon!: LunarSample;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private moonDir = new THREE.Vector3(0, -1, 0);
  private keyDir = new THREE.Vector3(0, 1, 0);
  private keyColor = new THREE.Color(1, 1, 1);
  private keyIntensity = 0;
  private sunTint = new THREE.Color(1, 1, 1);
  private nightFactor = 0;

  private exposure = 2.5;
  private lastEmittedExposure = -1;
  private snapNext = true;
  private width = 1;
  private height = 1;
  private frame = 0;
  private domeMs = 0;
  private profileTarget: THREE.WebGLRenderTarget | null = null;
  private profileFramesLeft = 0;

  /* ---------------------------------------------------------------- init */

  init(ctx: Ctx): void {
    this.ctx = ctx;
    const { renderer, scene } = ctx;

    // Must happen before any other module's material compiles. Registration
    // order in main.ts puts Sky second, right after Materials.
    patchGlobalChunks();

    scene.background = null;
    // Only a fallback for materials the sweep has not reached yet; the real
    // distance haze is the injected aerial-perspective chunk.
    scene.fog = new THREE.FogExp2(0x9fb6cc, 7e-5);

    const [dx, dz] = lonLatToWorld(-71.0560, 42.3560); // Financial District
    this.downtown.set(dx, dz);

    this.luts = new AtmosphereLuts(renderer, 256, 144);
    this.timer = new GpuTimer(renderer);

    this.domeMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
      uniforms: {
        ...this.sharedAtmosphereUniforms(),
        uSkyViewLut: { value: this.luts.skyViewTexture },
        uCloudBuffer: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uFrame: { value: 0 },
        uInverseViewProjection: { value: new THREE.Matrix4() },

        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunDiscRadiance: { value: new THREE.Color(0, 0, 0) },
        uSunAngularRadius: { value: SUN_ANGULAR_RADIUS },
        uAureole: { value: AEROSOL_TAU / SUN_DISC_RADIANCE },

        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
        uMoonUp: { value: new THREE.Vector3(0, 1, 0) },
        uMoonAngularRadius: { value: 0.0045 * MOON_SIZE_BOOST },
        uMoonPhaseAngle: { value: 0.6 },
        uMoonIllum: { value: 0.8 },
        uMoonRadiance: { value: new THREE.Color(0, 0, 0) },

        uViewHeight: { value: PLANET_RADIUS_MM },
        uNightFactor: { value: 0 },

        uSkyglowColor: { value: new THREE.Color().setRGB(1.0, 0.58, 0.3, THREE.LinearSRGBColorSpace) },
        uSkyglowStrength: { value: 0 },
        uCityDir: { value: new THREE.Vector2(0, 1) },
        uCityDistance: { value: 0 },

        uExposureHint: { value: 1 },
        uCloudsEnabled: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.dome = new THREE.Mesh(geo, this.domeMaterial);
    this.dome.name = 'sky-dome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10000;
    this.dome.matrixAutoUpdate = false;

    this.stars = new Starfield(9000);
    this.clouds = new CloudLayer(renderer, this.luts.uniforms);
    this.csm = new CascadedShadows({
      cascades: ctx.quality.cascadeCount,
      mapSize: ctx.quality.shadowMapSize,
      distance: ctx.quality.shadowDistance,
    });
    this.env = new EnvProbe(renderer, this.domeMaterial.uniforms, { width: 512 });

    this.group.name = 'sky';
    this.group.add(this.dome, this.stars.points, this.csm.group);
    scene.add(this.group);
    this.shading.ignore(this.group);

    ctx.on('weather', (payload) => this.setWeather(payload as WeatherPreset));
    ctx.on('time-changed', () => {
      this.snapNext = true;
      this.env.invalidate(true);
    });
    ctx.on('quality-changed', () => this.applyQuality());

    this.width = renderer.domElement.width;
    this.height = renderer.domElement.height;
    this.applyQuality();

    // Prime everything so frame zero is already correct.
    this.sample(ctx);
    this.luts.setHaze(renderer, this.weather.haze);
    this.luts.updateSkyView(renderer, this.sunDir, Math.max(2, ctx.camera.position.y), 32);
    this.env.update(1, this.keyDir, this.weather.haze);
    this.publishEnv();
  }

  private sharedAtmosphereUniforms(): Record<string, THREE.IUniform> {
    const u = this.luts.uniforms;
    return {
      uRayleighScatter: u.uRayleighScatter,
      uMieScatter: u.uMieScatter,
      uMieAbsorb: u.uMieAbsorb,
      uOzoneAbsorb: u.uOzoneAbsorb,
      uGroundAlbedo: u.uGroundAlbedo,
      uMieG: { value: 0.78 },
      uTransmittanceLut: u.uTransmittanceLut,
      uMultiScatterLut: u.uMultiScatterLut,
    };
  }

  /* ------------------------------------------------------------- quality */

  private cloudSettings(): CloudSettings {
    const q = this.ctx.quality;
    return {
      steps: q.cloudSteps > 0 ? q.cloudSteps : q.volumetricClouds ? 24 : 1,
      volumetric: q.volumetricClouds && q.cloudSteps > 0,
      scale: CLOUD_SCALE[this.ctx.tier] ?? 0.5,
      shadows: q.volumetricClouds,
    };
  }

  private applyQuality(): void {
    const q = this.ctx.quality;
    this.csm.configure(q.cascadeCount, q.shadowMapSize, q.shadowDistance);
    this.clouds.configure(this.cloudSettings(), this.width, this.height);
    this.stars.uniforms.uSizeScale.value = this.ctx.tier === 'low' ? 1.25 : 1;
    this.shading.sweep(this.ctx.scene, true);
    this.env.invalidate(true);
    this.startProfile();
  }

  /* ------------------------------------------------------------- weather */

  setWeather(name: WeatherPreset): void {
    if (!WEATHER_NAMES.includes(name) || name === this.weatherName) return;
    this.weatherName = name;
    this.weatherFrom = { ...this.weather };
    this.weatherTo = weatherPreset(name);
    this.weatherT = 0;
  }

  private advanceWeather(dt: number): void {
    if (this.weatherT >= 1) return;
    this.weatherT = Math.min(1, this.weatherT + dt / 8);
    // Smoothstep the parameter so the transition eases in and out.
    const k = this.weatherT * this.weatherT * (3 - 2 * this.weatherT);
    lerpWeather(this.weatherFrom, this.weatherTo, k, this.weather);
  }

  /* ---------------------------------------------------------- ephemeris */

  /** Recomputes the sun, the moon and everything derived from them. */
  private sample(ctx: Ctx): void {
    const day = ctx.dayOfYear;
    const hour = ctx.timeOfDay;

    this.sun = sunPosition(day, hour, this.latitude, this.longitude, this.utcOffset);
    this.moon = moonPosition(day, hour, this.latitude, this.longitude, this.utcOffset, this.sun);

    this.sunDir.set(this.sun.direction.x, this.sun.direction.y, this.sun.direction.z).normalize();
    this.moonDir.set(this.moon.direction.x, this.moon.direction.y, this.moon.direction.z).normalize();

    const altitude = Math.max(0, ctx.camera.position.y);
    const elevDeg = this.sun.apparentElevation * RAD;

    // Direct beam colour: the CPU mirror of the transmittance LUT.
    const t = sunTransmittanceCPU(altitude, this.sun.elevation, this.weather.haze);
    const lum = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
    if (lum > 1e-5) this.sunTint.setRGB(t.r / lum, t.g / lum, t.b / lum, THREE.LinearSRGBColorSpace);

    const cloudDim = 1 - this.weather.sunOcclusion;
    const sunIrradiance = lum * cloudDim;

    // Moonlight: same colour treatment, scaled by the illuminated fraction.
    const moonT = sunTransmittanceCPU(altitude, this.moon.elevation, this.weather.haze);
    const moonLum = 0.2126 * moonT.r + 0.7152 * moonT.g + 0.0722 * moonT.b;
    const moonIrradiance =
      MOON_KEY_IRRADIANCE * this.moon.illumination * moonLum * cloudDim * smoothstep(-0.02, 0.06, this.moonDir.y);

    // One key light. Whichever body is brighter wins, and the crossover is a
    // difference rather than a switch so dusk does not flick.
    if (sunIrradiance >= moonIrradiance) {
      this.keyDir.copy(this.sunDir);
      this.keyColor.copy(this.sunTint);
      this.keyIntensity = sunIrradiance - moonIrradiance;
    } else {
      this.keyDir.copy(this.moonDir);
      // Moonlight is sunlight; the blue cast is Purkinje, not physics, and a
      // little of it is what sells night.
      this.keyColor
        .setRGB(moonT.r, moonT.g, moonT.b, THREE.LinearSRGBColorSpace)
        .multiplyScalar(moonLum > 1e-5 ? 1 / moonLum : 1)
        .lerp(new THREE.Color().setRGB(0.62, 0.74, 1.0, THREE.LinearSRGBColorSpace), 0.55);
      this.keyIntensity = moonIrradiance - sunIrradiance;
    }

    this.nightFactor = smoothstep(8, -6, elevDeg);

    // ctx.sun is the *sun*, always, whatever is keying the scene. Water,
    // windows and post all key their own behaviour off it.
    ctx.sun.direction.copy(this.sunDir);
    ctx.sun.color.copy(this.sunTint);
    ctx.sun.intensity = sunIrradiance;
    ctx.sun.elevation = this.sun.apparentElevation;
    ctx.sun.azimuth = this.sun.azimuth;
  }

  /* ---------------------------------------------------------------- loop */

  update(dt: number, ctx: Ctx): void {
    const { renderer, camera, scene } = ctx;
    this.frame++;
    this.timer.poll();

    this.advanceWeather(dt);
    this.sample(ctx);

    const altitude = Math.max(2, camera.position.y);
    const viewHeightMm = PLANET_RADIUS_MM + altitude * 1e-6;

    this.timer.begin('sky');

    // ---- atmosphere LUTs ------------------------------------------------
    this.luts.setHaze(renderer, this.weather.haze);
    this.luts.updateSkyView(renderer, this.sunDir, altitude, ctx.tier === 'low' ? 20 : 32);

    // ---- dome uniforms --------------------------------------------------
    const u = this.domeMaterial.uniforms;
    (u.uInverseViewProjection.value as THREE.Matrix4)
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (u.uSunDiscRadiance.value as THREE.Color).setScalar(SUN_DISC_RADIANCE);
    u.uAureole.value = (AEROSOL_TAU * this.weather.haze) / SUN_DISC_RADIANCE;
    u.uViewHeight.value = viewHeightMm;
    u.uNightFactor.value = this.nightFactor;
    u.uFrame.value = this.frame;
    (u.uResolution.value as THREE.Vector2).set(this.width, this.height);

    // Moon frame: the bright limb points at the sun on the sky, so the
    // terminator is correct for the date without any extra bookkeeping.
    const right = u.uMoonRight.value as THREE.Vector3;
    right.copy(this.sunDir).addScaledVector(this.moonDir, -this.sunDir.dot(this.moonDir));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    (u.uMoonUp.value as THREE.Vector3).crossVectors(this.moonDir, right).normalize();
    (u.uMoonDir.value as THREE.Vector3).copy(this.moonDir);
    u.uMoonAngularRadius.value = this.moon.angularRadius * MOON_SIZE_BOOST;
    u.uMoonPhaseAngle.value = Math.abs(this.moon.phase);
    u.uMoonIllum.value = this.moon.illumination;
    (u.uMoonRadiance.value as THREE.Color).setScalar(
      MOON_DISC_RADIANCE * (1 - 0.55 * this.weather.sunOcclusion),
    );

    // Urban skyglow, aimed at downtown and fading as you leave it.
    const toCity = new THREE.Vector2(this.downtown.x - camera.position.x, this.downtown.y - camera.position.z);
    const cityDist = toCity.length();
    (u.uCityDir.value as THREE.Vector2).copy(cityDist > 1 ? toCity.divideScalar(cityDist) : new THREE.Vector2(0, 1));
    u.uCityDistance.value = cityDist;
    u.uSkyglowStrength.value = 0.0062 * this.nightFactor * (1 + 0.9 * this.weather.coverage);

    // ---- stars ----------------------------------------------------------
    const jd = julianDate(ctx.dayOfYear, ctx.timeOfDay, this.utcOffset);
    const lst = greenwichMeanSiderealTime(jd) + this.longitude * DEG;
    this.stars.setOrientation(lst, this.latitude * DEG);
    const su = this.stars.uniforms;
    const elevDeg = this.sun.apparentElevation * RAD;
    su.uLimitMag.value = lerp(-3, 6.5, smoothstep(-2, -17, elevDeg)) - 1.6 - 2.2 * this.weather.coverage;
    su.uPixelScale.value = renderer.getPixelRatio();
    su.uTime.value = ctx.elapsed;
    su.uIntensity.value = 0.035;
    (su.uResolution.value as THREE.Vector2).set(this.width, this.height);

    // ---- clouds ---------------------------------------------------------
    this.clouds.shadowExtent = Math.max(6000, ctx.quality.shadowDistance * 3);
    this.clouds.update(
      dt,
      camera,
      this.weather,
      this.sunDir,
      this.sunTint,
      Math.max(ctx.sun.intensity, 0.0),
      this.luts.skyViewTexture,
      viewHeightMm,
      this.nightFactor,
    );
    const cloudTex = this.clouds.scatterTexture;
    u.uCloudBuffer.value = cloudTex;
    u.uCloudsEnabled.value = cloudTex ? 1 : 0;
    su.uCloudBuffer.value = cloudTex;
    su.uCloudsEnabled.value = cloudTex ? 1 : 0;

    this.timer.end();

    // ---- shadows --------------------------------------------------------
    // Aerial views sit far above the ground, so the cascade set has to reach
    // at least as far as the terrain under the camera or nothing is shadowed.
    const reach = clamp(ctx.quality.shadowDistance, 400, 12000);
    const need = clamp(camera.position.y * 1.7 + 500, reach, 9000);
    this.csm.configure(ctx.quality.cascadeCount, ctx.quality.shadowMapSize, Math.max(reach, need));
    this.csm.setDirection(this.keyDir);
    this.csm.setLight(this.keyColor, this.keyIntensity);
    this.csm.update(camera);

    // ---- aerial perspective --------------------------------------------
    this.updateAerial(camera, viewHeightMm);

    // ---- material enrolment --------------------------------------------
    this.shading.sweep(scene);

    // ---- IBL ------------------------------------------------------------
    this.env.update(dt, this.sunDir, this.weather.haze);
    this.publishEnv();

    // ---- exposure -------------------------------------------------------
    const target = exposureFor(elevDeg) * (1 + 0.3 * this.weather.sunOcclusion);
    this.exposure = this.snapNext ? target : damp(this.exposure, target, 7, dt);
    if (Math.abs(this.exposure - this.lastEmittedExposure) > this.exposure * 0.004) {
      this.lastEmittedExposure = this.exposure;
      ctx.emit('exposure', this.exposure);
    }
    // Post consumes the event and will overwrite this; until it exists the
    // sky owns presentation, and a scene with no exposure control is useless.
    renderer.toneMappingExposure = this.exposure;
    this.snapNext = false;

    this.profile(renderer);
    this.report(ctx);
  }

  private updateAerial(camera: THREE.PerspectiveCamera, viewHeightMm: number): void {
    const a = this.shading.uniforms;
    a.uApSkyView.value = this.luts.skyViewTexture;
    a.uApSunDir.value.copy(this.sunDir);
    a.uApViewHeight.value = viewHeightMm;
    // Meteorological visual range: sigma = 3.912 / V. A clear day over the
    // harbour is ~50 km; a storm closes it to under 20.
    const sigma = 8.0e-5 * this.weather.haze;
    a.uApBetaM.value.setScalar(sigma);
    a.uApStrength.value = 1;
    a.uApInscatterGain.value = 1;
    // The in-scattered light that reaches the eye from the key light itself.
    a.uApSunColor.value.copy(this.keyColor).multiplyScalar(this.keyIntensity);
    a.uApViewToWorld.value.setFromMatrix4(camera.matrixWorld);

    const shadowTex = this.clouds.shadowTexture;
    a.uApCloudShadow.value = shadowTex;
    a.uApCloudShadowOn.value = shadowTex && this.keyIntensity > 0.02 ? 1 : 0;
    a.uApCloudShadowParams.value.set(
      this.clouds.shadowCentre.x,
      this.clouds.shadowCentre.y,
      this.clouds.shadowExtent,
    );
  }

  private publishEnv(): void {
    const tex = this.env.texture;
    if (!tex || this.ctx.envMap === tex) return;
    this.ctx.envMap = tex;
    this.ctx.scene.environment = tex;
  }

  /* -------------------------------------------------------------- timing */

  /**
   * The dome is drawn inside the main render, which this module does not own,
   * so its cost cannot be bracketed in place. Instead it is rendered a handful
   * of extra times into a scratch target right after a resize or quality
   * change, timed, and the target thrown away.
   */
  private startProfile(): void {
    this.profileFramesLeft = 6;
  }

  private profile(renderer: THREE.WebGLRenderer): void {
    if (this.profileFramesLeft <= 0) {
      if (this.profileTarget) {
        this.profileTarget.dispose();
        this.profileTarget = null;
      }
      return;
    }
    this.profileFramesLeft--;
    if (!this.profileTarget) {
      this.profileTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    }
    const prev = renderer.getRenderTarget();
    this.timer.begin('dome');
    renderer.setRenderTarget(this.profileTarget);
    renderer.render(this.dome, this.ctx.camera);
    this.timer.end();
    renderer.setRenderTarget(prev);
    this.domeMs = this.timer.ms.dome ?? this.domeMs;
  }

  private report(ctx: Ctx): void {
    const s = ctx.stats;
    s['sky.elev'] = +(this.sun.apparentElevation * RAD).toFixed(2);
    s['sky.azim'] = +(this.sun.azimuth * RAD).toFixed(1);
    s['sky.exposure'] = +this.exposure.toFixed(2);
    s['sky.weather'] = this.weatherName;
    s['sky.clouds'] = this.clouds.technique;
    s['sky.moon'] = +this.moon.illumination.toFixed(2);
    s['sky.cascades'] = this.csm.cascadeCount;
    if (this.timer.available) {
      s['sky.ms'] = +(this.timer.ms.sky ?? 0).toFixed(2);
      s['sky.domeMs'] = +(this.domeMs || 0).toFixed(2);
      s['sky.totalMs'] = +((this.timer.ms.sky ?? 0) + (this.domeMs || 0)).toFixed(2);
    }
    s['sky.envBuilds'] = this.env.stats.builds;
  }

  /* -------------------------------------------------------------- resize */

  resize(width: number, height: number, ctx: Ctx): void {
    const dpr = ctx.renderer.getPixelRatio();
    this.width = Math.round(width * dpr);
    this.height = Math.round(height * dpr);
    this.clouds.resize(this.width, this.height, this.cloudSettings());
    this.startProfile();
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.group);
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    this.stars.dispose();
    this.clouds.dispose();
    this.csm.dispose();
    this.env.dispose();
    this.luts.dispose();
    this.profileTarget?.dispose();
    if (ctx.scene.environment === this.ctx.envMap) ctx.scene.environment = null;
    ctx.envMap = null;
  }
}
