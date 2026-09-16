/**
 * Runway edge and threshold lights, approach lighting, and taxiway edge
 * lights. Steady-burning fixtures only (no strobe sequencing — the rabbit
 * lights on a real ALSF are a flourish this budget skips), so each colour is
 * one small `InstancedMesh` sharing one `MeshStandardMaterial` whose
 * `emissiveIntensity` is driven once a frame from `AirTraffic.step`, the same
 * night/exposure curve `aircraft.ts`'s own lamps and `Buildings`' window glow
 * use — no per-instance shader work needed since these fixtures don't blink.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import type { LoganLayout, RunwaySpec, TaxiwaySpec } from './layout';

const FIXTURE = new THREE.BoxGeometry(0.5, 0.5, 0.5);

interface Bucket { positions: [number, number, number][] }

export interface AirfieldLights {
  meshes: THREE.InstancedMesh[];
  materials: THREE.MeshStandardMaterial[];
  /** Call once a frame with the same night/exposure factor as the aircraft lamps. */
  setNightGain(gain: number): void;
  dispose(): void;
}

export function buildLights(ctx: Ctx, layout: LoganLayout): AirfieldLights {
  const white: Bucket = { positions: [] };
  const green: Bucket = { positions: [] };
  const red: Bucket = { positions: [] };
  const blue: Bucket = { positions: [] };

  for (const rw of layout.runways) emitRunwayLights(rw, white, green, red, ctx);
  for (const tw of layout.taxiways) emitTaxiwayLights(tw, blue, ctx);

  const materials: THREE.MeshStandardMaterial[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  const make = (b: Bucket, hex: number, name: string): void => {
    if (!b.positions.length) return;
    const mat = new THREE.MeshStandardMaterial({
      name, color: 0x141414, roughness: 0.5, metalness: 0,
      emissive: new THREE.Color(hex), emissiveIntensity: 0,
    });
    materials.push(mat);
    const mesh = new THREE.InstancedMesh(FIXTURE, mat, b.positions.length);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noShadow = true;
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < b.positions.length; i++) {
      const [x, y, z] = b.positions[i];
      m.makeTranslation(x, y, z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  };
  make(white, 0xfff6df, 'airport:light:white');
  make(green, 0x1aff5a, 'airport:light:green');
  make(red, 0xff2a1a, 'airport:light:red');
  make(blue, 0x2a6fff, 'airport:light:blue');

  return {
    meshes,
    materials,
    setNightGain(gain: number): void {
      for (const m of materials) m.emissiveIntensity = gain;
    },
    dispose(): void {
      FIXTURE.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

function emitRunwayLights(rw: RunwaySpec, white: Bucket, green: Bucket, red: Bucket, ctx: Ctx): void {
  const [ax, az] = rw.axis;
  const nx = -az, nz = ax;
  const hw = rw.width / 2 + 0.8;
  const half = rw.length / 2;
  const spacing = 60;

  // Edge lights, both sides, full length.
  for (let l = -half; l <= half; l += spacing) {
    for (const s of [-1, 1]) {
      const x = rw.center[0] + ax * l + nx * (s * hw);
      const z = rw.center[1] + az * l + nz * (s * hw);
      white.positions.push([x, ctx.sampleHeight(x, z) + 0.4, z]);
    }
  }

  // Threshold light bar at each end (green, the colour an arriving aircraft sees).
  for (const end of [rw.thresholdA, rw.thresholdB]) {
    for (let w = -hw; w <= hw; w += 3) {
      const x = end[0] + nx * w;
      const z = end[1] + nz * w;
      green.positions.push([x, ctx.sampleHeight(x, z) + 0.4, z]);
    }
  }

  // A short simplified approach lighting run off each end: a centreline row
  // extending outward (over Logan's real approach lighting piers, where the
  // extension runs out over the water) plus one crossbar at 300 m.
  for (const [end, dir] of [[rw.thresholdA, [-ax, -az]], [rw.thresholdB, [ax, az]]] as const) {
    for (let d = 30; d <= 450; d += 30) {
      const x = end[0] + dir[0] * d;
      const z = end[1] + dir[1] * d;
      white.positions.push([x, ctx.sampleHeight(x, z) + 0.4, z]);
    }
    const bar = end === rw.thresholdA ? -ax * 300 : ax * 300;
    const barZ = end === rw.thresholdA ? -az * 300 : az * 300;
    for (let w = -8; w <= 8; w += 4) {
      if (w === 0) continue;
      const x = end[0] + bar + nx * w;
      const z = end[1] + barZ + nz * w;
      white.positions.push([x, ctx.sampleHeight(x, z) + 0.4, z]);
    }
  }
}

function emitTaxiwayLights(tw: TaxiwaySpec, blue: Bucket, ctx: Ctx): void {
  if (tw.length < 40) return;
  const [ax, az] = tw.axis;
  const nx = -az, nz = ax;
  const hw = tw.width / 2 + 0.5;
  const half = tw.length / 2;
  const spacing = 55;
  for (let l = -half; l <= half; l += spacing) {
    for (const s of [-1, 1]) {
      const x = tw.center[0] + ax * l + nx * (s * hw);
      const z = tw.center[1] + az * l + nz * (s * hw);
      blue.positions.push([x, ctx.sampleHeight(x, z) + 0.3, z]);
    }
  }
}
