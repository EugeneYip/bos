import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { PropSet } from '../core/types';
import { loadProps } from '../core/data';
import { SPECIES, autumnFactor } from './vegetation/species';
import { buildTreeLods } from './vegetation/geometry';

/**
 * Boston's 88,226 trees.
 *
 * Strategy: every tree is always present in a per-species impostor
 * `InstancedMesh` built once and never touched again. The nearest
 * `quality.treeBudget` trees are *additionally* drawn with real geometry, and
 * the two cross-fade against each other in the shader by camera distance, so
 * there is no popping and no per-frame buffer churn for the 88k far set.
 *
 * The near set is rebuilt only when the camera has moved far enough to matter,
 * which keeps the cost off the frame budget.
 */

const REBUILD_DISTANCE = 40; // metres of camera travel before re-bucketing

interface Tier {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
}

export class Vegetation implements WorldModule {
  readonly name = 'Vegetation';
  private root = new THREE.Group();
  private far: Tier[] = [];
  private near: Tier[] = [];
  private mid: Tier[] = [];
  /** Per species: indices into the flat tree arrays. */
  private bySpecies: Uint32Array[] = [];
  private pos = new Float32Array(0);
  private scale = new Float32Array(0);
  private rot = new Float32Array(0);
  private count = 0;
  private lastRebuild = new THREE.Vector3(1e9, 1e9, 1e9);
  private uniforms: { value: number }[] = [];
  private windTime = { value: 0 };
  private season = { value: 0 };

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'vegetation';
    ctx.scene.add(this.root);

    let sets: PropSet[] = [];
    try {
      sets = await loadProps();
    } catch (err) {
      console.warn('[Vegetation] no prop data; skipping', err);
      return;
    }
    const trees = sets.filter((s) => s.kind === 'tree');
    if (!trees.length) return;

    // Flatten every tree shard into one columnar buffer.
    this.count = trees.reduce((n, s) => n + s.positions.length / 3, 0);
    this.pos = new Float32Array(this.count * 3);
    this.scale = new Float32Array(this.count);
    this.rot = new Float32Array(this.count);
    const variant = new Uint8Array(this.count);

    let w = 0;
    for (const s of trees) {
      const n = s.positions.length / 3;
      for (let i = 0; i < n; i++, w++) {
        this.pos[w * 3] = s.positions[i * 3];
        this.pos[w * 3 + 1] = s.positions[i * 3 + 1];
        this.pos[w * 3 + 2] = s.positions[i * 3 + 2];
        this.scale[w] = s.scales[i] ?? 1;
        this.rot[w] = s.rotations[i] ?? 0;
        variant[w] = (s.variants?.[i] ?? 0) % SPECIES.length;
      }
    }

    // Bucket indices by species so each gets its own instanced mesh.
    const counts = new Array(SPECIES.length).fill(0);
    for (let i = 0; i < this.count; i++) counts[variant[i]]++;
    this.bySpecies = counts.map((c) => new Uint32Array(c));
    const cursor = new Array(SPECIES.length).fill(0);
    for (let i = 0; i < this.count; i++) {
      const v = variant[i];
      this.bySpecies[v][cursor[v]++] = i;
    }

    this.season.value = autumnFactor(ctx.dayOfYear);

    const budget = ctx.quality.treeBudget;
    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      const lods = buildTreeLods(sp);
      const total = this.bySpecies[s].length;

      // Far impostors: all of them, filled once.
      const farTier = this.makeTier(ctx, sp, lods.far, total, 'far');
      this.fillAll(farTier.mesh, this.bySpecies[s]);
      this.far.push(farTier);

      // Near + mid: capped, refilled on camera movement.
      const cap = Math.min(total, Math.max(64, Math.round((budget * total) / this.count)));
      this.near.push(this.makeTier(ctx, sp, lods.near, cap, 'near'));
      this.mid.push(this.makeTier(ctx, sp, lods.mid, Math.min(total, cap * 3), 'mid'));

      await new Promise((r) => setTimeout(r, 0));
    }

    this.rebuild(ctx);
    ctx.stats.trees = this.count;
    console.info(`[Vegetation] ${this.count} trees, ${SPECIES.length} species, budget ${budget}`);

    ctx.on('quality-changed', () => { this.lastRebuild.set(1e9, 1e9, 1e9); });
  }

  /** One instanced mesh for a (species, lod) pair, with the shared tree shader. */
  private makeTier(
    ctx: Ctx,
    sp: (typeof SPECIES)[number],
    geo: THREE.BufferGeometry,
    capacity: number,
    lod: 'near' | 'mid' | 'far',
  ): Tier {
    const material = new THREE.MeshStandardMaterial({
      name: `tree:${sp.name}:${lod}`,
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      // Impostors are flat cards; flat shading would make them read as cards.
      flatShading: false,
    });

    // Cross-fade window, in metres. The near tier owns 0..fadeNear, mid owns
    // the middle, and the impostors take over beyond fadeFar.
    const fadeIn = { value: lod === 'near' ? -1 : lod === 'mid' ? 70 : 300 };
    const fadeOut = { value: lod === 'near' ? 110 : lod === 'mid' ? 380 : 1e9 };
    this.uniforms.push(fadeIn, fadeOut);

    const summer = new THREE.Color(sp.summer).convertSRGBToLinear();
    const autumn = new THREE.Color(sp.autumn).convertSRGBToLinear();
    const bark = new THREE.Color(sp.bark).convertSRGBToLinear();

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = this.windTime;
      shader.uniforms.uSeason = this.season;
      shader.uniforms.uFadeIn = fadeIn;
      shader.uniforms.uFadeOut = fadeOut;
      shader.uniforms.uSummer = { value: summer };
      shader.uniforms.uAutumn = { value: autumn };
      shader.uniforms.uBark = { value: bark };
      shader.uniforms.uSway = { value: sp.sway };
      shader.uniforms.uBillboard = { value: lod === 'far' ? 1 : 0 };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute float foliage;
          uniform float uWindTime;
          uniform float uSway;
          uniform float uBillboard;
          varying float vFoliage;
          varying float vFade;
          uniform float uFadeIn;
          uniform float uFadeOut;
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          vFoliage = foliage;

          // Instance origin in world space, used for the wind phase and for
          // the distance fade. instanceMatrix's translation is that origin.
          vec3 iOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

          // Wind: two frequencies, phase-shifted per tree by its position so
          // the canopy doesn't pulse in unison across the city.
          float phase = iOrigin.x * 0.07 + iOrigin.z * 0.053;
          float gust = sin(uWindTime * 0.55 + phase) * 0.62
                     + sin(uWindTime * 1.53 + phase * 2.3) * 0.28;
          // Only the crown moves, and more the higher up it sits.
          float lever = foliage * smoothstep(0.0, 1.0, transformed.y);
          transformed.x += gust * lever * 0.085 * uSway;
          transformed.z += gust * lever * 0.055 * uSway;

          if (uBillboard > 0.5) {
            // Yaw the impostor toward the camera, keeping it upright.
            vec3 toCam = cameraPosition - iOrigin;
            float a = atan(toCam.x, toCam.z);
            float c = cos(a), s = sin(a);
            transformed.xz = mat2(c, -s, s, c) * transformed.xz;
          }

          float dist = distance(cameraPosition, iOrigin);
          vFade = smoothstep(uFadeIn, uFadeIn + 45.0, dist)
                * (1.0 - smoothstep(uFadeOut - 45.0, uFadeOut, dist));
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          varying float vFoliage;
          varying float vFade;
          uniform float uSeason;
          uniform vec3 uSummer;
          uniform vec3 uAutumn;
          uniform vec3 uBark;
        `)
        .replace('#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          // Autumn turn varies tree to tree, so the canopy is never uniform.
          float turn = clamp(uSeason * (0.55 + 0.9 * vInstanceJitter), 0.0, 1.0);
          vec3 leaf = mix(uSummer, uAutumn, turn);
          diffuseColor.rgb *= mix(uBark, leaf, vFoliage) * (0.82 + 0.36 * vInstanceJitter);
        `)
        .replace('#include <dithering_fragment>', /* glsl */ `
          #include <dithering_fragment>
          // Fade between LOD tiers with a screen-door dither: alpha blending
          // 88k instances would cost far more and sort badly.
          float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          if (vFade < d) discard;
        `);

      // Per-instance variation, threaded from an instanced attribute.
      shader.vertexShader = shader.vertexShader
        .replace('attribute float foliage;', 'attribute float foliage;\nattribute float instanceJitter;\nvarying float vInstanceJitter;')
        .replace('vFoliage = foliage;', 'vFoliage = foliage;\n          vInstanceJitter = instanceJitter;');
      shader.fragmentShader = shader.fragmentShader
        .replace('varying float vFoliage;', 'varying float vFoliage;\nvarying float vInstanceJitter;');
    };
    material.customProgramCacheKey = () => `tree-${sp.name}-${lod}`;

    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.name = `trees:${sp.name}:${lod}`;
    mesh.castShadow = lod !== 'far';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // we cull by tier/budget instead
    mesh.count = 0;

    const jitter = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) jitter[i] = Math.random();
    geo.setAttribute('instanceJitter', new THREE.InstancedBufferAttribute(jitter, 1));

    this.root.add(mesh);
    return { mesh, material };
  }

  private static _m = new THREE.Matrix4();
  private static _q = new THREE.Quaternion();
  private static _up = new THREE.Vector3(0, 1, 0);
  private static _p = new THREE.Vector3();
  private static _s = new THREE.Vector3();

  private write(mesh: THREE.InstancedMesh, slot: number, tree: number): void {
    const sp = SPECIES[0];
    void sp;
    const h = this.scale[tree];
    Vegetation._p.set(this.pos[tree * 3], this.pos[tree * 3 + 1], this.pos[tree * 3 + 2]);
    Vegetation._q.setFromAxisAngle(Vegetation._up, this.rot[tree]);
    Vegetation._s.setScalar(h);
    Vegetation._m.compose(Vegetation._p, Vegetation._q, Vegetation._s);
    mesh.setMatrixAt(slot, Vegetation._m);
  }

  private fillAll(mesh: THREE.InstancedMesh, idx: Uint32Array): void {
    const n = Math.min(idx.length, mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) this.write(mesh, i, idx[i]);
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Refill the near/mid tiers with the trees closest to the camera. */
  private rebuild(ctx: Ctx): void {
    const cam = ctx.camera.position;
    for (let s = 0; s < SPECIES.length; s++) {
      const idx = this.bySpecies[s];
      const nearMesh = this.near[s].mesh;
      const midMesh = this.mid[s].mesh;
      const nearCap = nearMesh.instanceMatrix.count;
      const midCap = midMesh.instanceMatrix.count;
      let nn = 0;
      let nm = 0;
      // One linear pass with distance thresholds rather than a full sort:
      // the fade windows make exact ordering unnecessary.
      for (let i = 0; i < idx.length; i++) {
        const t = idx[i];
        const dx = this.pos[t * 3] - cam.x;
        const dz = this.pos[t * 3 + 2] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 115 * 115 && nn < nearCap) this.write(nearMesh, nn++, t);
        else if (d2 < 385 * 385 && nm < midCap) this.write(midMesh, nm++, t);
      }
      nearMesh.count = nn;
      midMesh.count = nm;
      nearMesh.instanceMatrix.needsUpdate = true;
      midMesh.instanceMatrix.needsUpdate = true;
    }
    this.lastRebuild.copy(cam);
  }

  update(dt: number, ctx: Ctx): void {
    this.windTime.value += dt;
    this.season.value = autumnFactor(ctx.dayOfYear);
    if (!this.near.length) return;
    if (ctx.camera.position.distanceTo(this.lastRebuild) > REBUILD_DISTANCE) {
      this.rebuild(ctx);
    }
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    for (const t of [...this.near, ...this.mid, ...this.far]) {
      t.mesh.geometry.dispose();
      t.material.dispose();
    }
    this.near.length = this.mid.length = this.far.length = 0;
  }
}
