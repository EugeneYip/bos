import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { PropSet } from '../core/types';
import { loadProps } from '../core/data';
import { buildKind, type Part, type Role } from './props/kinds';

/**
 * Boston's street furniture: 10,853 lamps, benches, signals, bollards,
 * statues, fountains, flagpoles, masts, chimneys and tower cranes.
 *
 * One `InstancedMesh` per (kind, variant, material role). At these counts that
 * is a few dozen draw calls total, so there is no need for the tiered LOD the
 * 88k trees require — just distance culling on the small stuff.
 */

/** Beyond this, an object of the given size is under a pixel; stop drawing it. */
const CULL: Record<string, number> = {
  bollard: 260,
  bench: 340,
  streetlamp: 620,
  traffic_signal: 620,
  statue: 700,
  fountain: 800,
  flagpole: 1400,
  chimney: 3000,
  mast: 3500,
  crane: 6000,
};

interface Bucket {
  mesh: THREE.InstancedMesh;
  kind: string;
  cull: number;
  /** World positions of each instance, for the distance pass. */
  px: Float32Array;
  pz: Float32Array;
  /** Prebuilt matrices so culling is a copy, not a recompose. */
  matrices: Float32Array;
}

export class Props implements WorldModule {
  readonly name = 'Props';
  private root = new THREE.Group();
  private buckets: Bucket[] = [];
  private materials = new Map<Role, THREE.Material>();
  private nightLit: THREE.MeshStandardMaterial[] = [];
  private lastCull = new THREE.Vector3(1e9, 1e9, 1e9);

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'props';
    ctx.scene.add(this.root);

    let sets: PropSet[] = [];
    try {
      sets = await loadProps();
    } catch (err) {
      console.warn('[Props] no prop data; skipping', err);
      return;
    }

    let total = 0;
    for (const set of sets) {
      if (set.kind === 'tree') continue; // owned by the Vegetation module
      const n = set.positions.length / 3;
      if (!n) continue;

      // Split by variant so each gets its own geometry.
      const variants = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const v = set.variants?.[i] ?? 0;
        const arr = variants.get(v) ?? [];
        arr.push(i);
        variants.set(v, arr);
      }

      for (const [variant, idx] of variants) {
        let parts: Part[] = [];
        try {
          parts = buildKind(set.kind, variant);
        } catch (err) {
          console.warn(`[Props] ${set.kind} v${variant} failed to build`, err);
        }
        if (!parts.length) continue;

        for (const part of parts) {
          const mesh = new THREE.InstancedMesh(part.geo, this.material(ctx, part.role), idx.length);
          mesh.name = `prop:${set.kind}:${variant}:${part.role}`;
          mesh.castShadow = part.role !== 'lamp' && part.role !== 'signal';
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;

          const px = new Float32Array(idx.length);
          const pz = new Float32Array(idx.length);
          const matrices = new Float32Array(idx.length * 16);
          const m = new THREE.Matrix4();
          const q = new THREE.Quaternion();
          const up = new THREE.Vector3(0, 1, 0);
          const p = new THREE.Vector3();
          const s = new THREE.Vector3();

          for (let k = 0; k < idx.length; k++) {
            const i = idx[k];
            p.set(set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]);
            q.setFromAxisAngle(up, set.rotations[i] ?? 0);
            s.setScalar(set.scales[i] ?? 1);
            m.compose(p, q, s);
            m.toArray(matrices, k * 16);
            px[k] = p.x;
            pz[k] = p.z;
          }
          mesh.instanceMatrix.array.set(matrices);
          mesh.count = idx.length;
          mesh.instanceMatrix.needsUpdate = true;

          this.root.add(mesh);
          this.buckets.push({ mesh, kind: set.kind, cull: CULL[set.kind] ?? 900, px, pz, matrices });
        }
        total += idx.length;
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    ctx.stats.props = total;
    console.info(`[Props] ${total} props in ${this.buckets.length} instanced meshes`);
  }

  /** Shared materials keyed by role, so buckets batch where they can. */
  private material(ctx: Ctx, role: Role): THREE.Material {
    const hit = this.materials.get(role);
    if (hit) return hit;

    let m: THREE.Material;
    switch (role) {
      case 'lamp': {
        const s = new THREE.MeshStandardMaterial({
          name: 'prop:lamp', color: 0x2a2622, roughness: 0.35, metalness: 0,
          emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
        });
        s.userData.nightPeak = 4.5;
        this.nightLit.push(s);
        m = s;
        break;
      }
      case 'signal': {
        const s = new THREE.MeshStandardMaterial({
          name: 'prop:signal', color: 0x241f1c, roughness: 0.4, metalness: 0,
          emissive: new THREE.Color(0xff6a2a), emissiveIntensity: 0.35,
        });
        s.userData.nightPeak = 2.6;
        this.nightLit.push(s);
        m = s;
        break;
      }
      case 'glass':
        m = new THREE.MeshStandardMaterial({
          name: 'prop:water', color: 0x2c4a4a, roughness: 0.08, metalness: 0.1,
          transparent: true, opacity: 0.8,
        });
        break;
      default: {
        // Prefer the shared city library so props match the buildings.
        const lib = ctx.materials.get(
          role === 'darkmetal' ? 'metal' : role === 'wood' ? 'wood' : role === 'stone' ? 'stone' : 'metal',
        );
        const base = (lib as THREE.MeshStandardMaterial).clone?.() ?? new THREE.MeshStandardMaterial();
        const std = base as THREE.MeshStandardMaterial;
        std.name = `prop:${role}`;
        if (role === 'darkmetal') { std.color = new THREE.Color(0x2e3237); std.roughness = 0.48; std.metalness = 0.72; }
        if (role === 'metal') { std.color = new THREE.Color(0x8d8f92); std.roughness = 0.42; std.metalness = 0.85; }
        if (role === 'wood') { std.color = new THREE.Color(0x6b4f36); std.roughness = 0.8; std.metalness = 0; }
        if (role === 'stone') { std.color = new THREE.Color(0x9a968e); std.roughness = 0.85; std.metalness = 0; }
        m = std;
      }
    }
    this.materials.set(role, m);
    return m;
  }

  update(_dt: number, ctx: Ctx): void {
    if (!this.buckets.length) return;

    // Lamps and signals come up after civil twilight, matching the landmarks'
    // night driver so the whole city lights together.
    const e = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.14 - e) / 0.21, 0, 1);
    const k = t * t * (3 - 2 * t);
    for (const m of this.nightLit) m.emissiveIntensity = k * ((m.userData.nightPeak as number) ?? 1);

    // Distance culling, throttled on camera movement.
    if (ctx.camera.position.distanceTo(this.lastCull) < 30) return;
    this.lastCull.copy(ctx.camera.position);
    const cx = ctx.camera.position.x;
    const cz = ctx.camera.position.z;

    for (const b of this.buckets) {
      const cull = b.cull * b.cull;
      const arr = b.mesh.instanceMatrix.array as Float32Array;
      let n = 0;
      for (let i = 0; i < b.px.length; i++) {
        const dx = b.px[i] - cx;
        const dz = b.pz[i] - cz;
        if (dx * dx + dz * dz > cull) continue;
        if (n !== i) arr.set(b.matrices.subarray(i * 16, i * 16 + 16), n * 16);
        else arr.set(b.matrices.subarray(i * 16, i * 16 + 16), i * 16);
        n++;
      }
      b.mesh.count = n;
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    for (const b of this.buckets) b.mesh.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.buckets.length = 0;
    this.materials.clear();
  }
}
