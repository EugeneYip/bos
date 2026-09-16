import * as THREE from 'three';
import { FullScreenPass, PASS_VERT } from './util';
import { SKY_EQUIRECT_FRAG } from './shaders/skyDome';

/**
 * The image-based lighting probe.
 *
 * The sky is rendered to a 512x256 equirectangular buffer with the same
 * radiance function the dome uses, then run through three's `PMREMGenerator`
 * to get the roughness-prefiltered cube-UV atlas that every PBR material
 * samples. Because it is the *same* shader, the reflection in a window and the
 * sky above it can never disagree.
 *
 * Two refinements matter:
 *
 *   - **The solar disc is widened.** At a 128-pixel cube face the real
 *     0.27-degree disc is a fraction of a texel, so it strobes as the sun
 *     drifts. It is drawn four times wider with its radiance scaled by the
 *     inverse square of the widening, which preserves total irradiance.
 *   - **Refreshes cross-fade.** A rebuild is only triggered once the sun has
 *     moved a fraction of a degree, but even that is visible on a mirrored
 *     facade, so the published atlas is a running `mix()` between the last
 *     published state and the freshly generated one, ramped over ~0.4 s. The
 *     PMREM result is an ordinary 2D texture, so the cross-fade is one cheap
 *     full-screen blit, not a second prefilter.
 */

const BLEND_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;
void main() {
  gl_FragColor = mix( texture2D( uA, vUv ), texture2D( uB, vUv ), uMix );
}
`;

export interface EnvProbeOptions {
  /** Equirect source width; the PMREM cube side is a quarter of this. */
  width?: number;
  /** Radians of sun movement that triggers a rebuild. */
  angleThreshold?: number;
  /** Seconds the cross-fade takes. */
  fadeSeconds?: number;
  /** Minimum frames between rebuilds. */
  minInterval?: number;
}

export class EnvProbe {
  private pmrem: THREE.PMREMGenerator;
  private equirect: THREE.WebGLRenderTarget;
  private equirectPass: FullScreenPass;

  /** Freshly prefiltered atlas (the fade destination). */
  private next: THREE.WebGLRenderTarget | null = null;
  /** Snapshot of what was published when the fade started. */
  private prev: THREE.WebGLRenderTarget | null = null;
  /** What the scene actually samples. */
  private out: THREE.WebGLRenderTarget | null = null;
  private blendPass: FullScreenPass;

  private lastDir = new THREE.Vector3(0, -1, 0);
  private lastHaze = -1;
  private sinceBuild = 1e9;
  private fade = 1;
  private builds = 0;
  private rebuildMs = 0;

  private angleThreshold: number;
  private discSpread: number;
  private probeDisc: THREE.Color;
  private domeDisc: THREE.Color;
  private probeRadius: THREE.IUniform;
  private domeRadius: THREE.IUniform;
  private fadeSeconds: number;
  private minInterval: number;

  constructor(
    private renderer: THREE.WebGLRenderer,
    domeUniforms: Record<string, THREE.IUniform>,
    opts: EnvProbeOptions = {},
  ) {
    const width = opts.width ?? 512;
    this.angleThreshold = opts.angleThreshold ?? 0.006; // ~0.35 degrees
    this.fadeSeconds = opts.fadeSeconds ?? 0.4;
    this.minInterval = opts.minInterval ?? 4;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.equirect = new THREE.WebGLRenderTarget(width, width / 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.equirect.texture.colorSpace = THREE.NoColorSpace;
    this.equirect.texture.mapping = THREE.EquirectangularReflectionMapping;

    // Share every uniform with the dome except the widened sun and the
    // things that only make sense on screen.
    const spread = 4.2;
    const shared: Record<string, THREE.IUniform> = { ...domeUniforms };
    const discRadiance = (domeUniforms.uSunDiscRadiance.value as THREE.Color).clone();
    shared.uSunDiscRadiance = { value: discRadiance };
    shared.uSunAngularRadius = {
      value: (domeUniforms.uSunAngularRadius.value as number) * spread,
    };
    shared.uCloudsEnabled = { value: 0 };
    // The probe lights the city from every direction, and from below that is
    // ground, not the horizon haze the dome holds there.
    shared.uHorizonHold = { value: 0 };
    shared.uCloudBuffer = { value: null };
    this.discSpread = spread;
    this.probeDisc = discRadiance;
    this.domeDisc = domeUniforms.uSunDiscRadiance.value as THREE.Color;
    this.probeRadius = shared.uSunAngularRadius;
    this.domeRadius = domeUniforms.uSunAngularRadius;

    this.equirectPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: SKY_EQUIRECT_FRAG,
        uniforms: shared,
        toneMapped: false,
      }),
    );

    this.blendPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: BLEND_FRAG,
        uniforms: { uA: { value: null }, uB: { value: null }, uMix: { value: 0 } },
        toneMapped: false,
      }),
    );
  }

  get texture(): THREE.Texture | null {
    return this.out?.texture ?? null;
  }

  get stats(): { builds: number; ms: number; fade: number } {
    return { builds: this.builds, ms: this.rebuildMs, fade: this.fade };
  }

  /** Forces a rebuild on the next update (time jump, weather cut, resize). */
  invalidate(snap = false): void {
    this.lastDir.set(0, -1, 0);
    this.lastHaze = -1;
    if (snap) this.fade = 1;
  }

  /**
   * @param sunDir current key direction, used only to decide when to rebuild.
   * @param haze weather haze multiplier, same purpose.
   */
  update(dt: number, sunDir: THREE.Vector3, haze: number): void {
    this.sinceBuild++;

    if (this.fade < 1 && this.out && this.prev && this.next) {
      this.fade = Math.min(1, this.fade + dt / this.fadeSeconds);
      this.blend(this.fade);
    }

    const moved = this.lastDir.angleTo(sunDir);
    const hazed = Math.abs(haze - this.lastHaze);
    const stale = moved > this.angleThreshold || hazed > 0.02;
    if (!stale || this.sinceBuild < this.minInterval) return;
    if (this.fade < 1 && moved < 0.08) return; // let the current fade land

    this.rebuild(sunDir, haze, moved > 0.09);
  }

  private rebuild(sunDir: THREE.Vector3, haze: number, jump: boolean): void {
    const t0 = performance.now();
    this.lastDir.copy(sunDir);
    this.lastHaze = haze;
    this.sinceBuild = 0;
    this.builds++;

    // Keep total solar irradiance constant while the disc is widened.
    this.probeDisc.copy(this.domeDisc).multiplyScalar(1 / (this.discSpread * this.discSpread));
    this.probeRadius.value = (this.domeRadius.value as number) * this.discSpread;

    this.equirectPass.render(this.renderer, this.equirect);
    this.next = this.pmrem.fromEquirectangular(this.equirect.texture, this.next ?? undefined);

    if (!this.out) {
      this.out = this.cloneTarget(this.next);
      this.prev = this.cloneTarget(this.next);
      this.fade = 1;
      this.blend(1);
    } else if (jump) {
      this.fade = 1;
      this.blend(1);
    } else {
      // Snapshot what is on screen right now as the fade source.
      this.copy(this.out, this.prev!);
      this.fade = 0;
      this.blend(0);
    }
    this.rebuildMs = this.rebuildMs * 0.7 + (performance.now() - t0) * 0.3;
  }

  private cloneTarget(src: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(src.width, src.height, {
      type: src.texture.type,
      format: src.texture.format,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    // The cube-UV atlas is an ordinary 2D texture wearing a special mapping;
    // copying it byte-for-byte keeps it valid.
    rt.texture.mapping = THREE.CubeUVReflectionMapping;
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.name = 'sky-env';
    return rt;
  }

  private copy(from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget): void {
    const u = this.blendPass.material.uniforms;
    u.uA.value = from.texture;
    u.uB.value = from.texture;
    u.uMix.value = 0;
    this.blendPass.render(this.renderer, to);
  }

  private blend(t: number): void {
    if (!this.out || !this.next) return;
    const u = this.blendPass.material.uniforms;
    u.uA.value = (this.prev ?? this.next).texture;
    u.uB.value = this.next.texture;
    u.uMix.value = t;
    this.blendPass.render(this.renderer, this.out);
  }

  dispose(): void {
    this.equirect.dispose();
    this.equirectPass.dispose();
    this.blendPass.dispose();
    this.next?.dispose();
    this.prev?.dispose();
    this.out?.dispose();
    this.pmrem.dispose();
  }
}
