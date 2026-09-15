import * as THREE from 'three';
import type { LampField } from '../../core/Context';
import type { RoadClass, RoadRecord } from '../../core/types';

/**
 * Boston's street lighting, baked into a field indexed by world XZ.
 *
 * Ten thousand lamps cannot each be a `PointLight` — three would need a
 * clustered or deferred path for that, and this renderer is neither. But street
 * lighting does not move and does not depend on the camera, so it can be
 * rasterised once and read by every material in the city with a single texture
 * fetch, exactly the way the cloud shadow already is. Until this existed the
 * lamps *glowed* but lit nothing, and the road surface after dark measured 0 to
 * 14 out of 255: a city with its lights on and its streets in total darkness.
 *
 * ## Why the street network and not the lamps
 *
 * The obvious source is `highway=street_lamp`, and the props module has 3,507
 * of them. That is about five per cent of what Boston actually has on the
 * ground, and the sample is not even: Boston Common has five lamps within 26 m
 * of the bandstand, while the Financial District — the densest, most brightly
 * lit part of the city — has none within a hundred and sixty-eight metres of
 * its central intersection. Splatting that sample gives bright islands
 * separated by kilometres of black tarmac, which is much further from Boston
 * at night than a continuous glow along every street is.
 *
 * So the field comes from the street network instead. Every adopted street in
 * the city is lit; that is the actual invariant, and the road records describe
 * it completely. The mapped lamps stay where they are as geometry that glows.
 */

/** Metres per texel. Coarser than one lamp's pool, and deliberately so. */
export const LAMP_TEXEL = 6;
/** Elevation span the field's ground channel covers, starting at -8 m. */
export const LAMP_GROUND_RANGE = 80;

/**
 * How brightly each class of street is lit, and how far the light reaches past
 * the kerb. Boston lights its arterials hard, its residential streets modestly,
 * its service alleys barely at all, and does not light a railway line.
 */
const CLASS_LIGHTING: Partial<Record<RoadClass, { weight: number; spill: number }>> = {
  motorway: { weight: 1.15, spill: 11 },
  trunk: { weight: 1.15, spill: 11 },
  primary: { weight: 1.10, spill: 10 },
  secondary: { weight: 1.00, spill: 10 },
  tertiary: { weight: 0.90, spill: 9 },
  residential: { weight: 0.72, spill: 8 },
  pedestrian: { weight: 0.80, spill: 7 },
  footway: { weight: 0.42, spill: 5 },
  cycleway: { weight: 0.42, spill: 5 },
  service: { weight: 0.34, spill: 5 },
};

/**
 * Splats every lit street into an irradiance field.
 *
 * @param records the street network, in world metres.
 * @param pad     metres of margin around the network's bounding box.
 */
export function bakeLampField(records: RoadRecord[], pad = 40): LampField | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let lit = 0;

  for (const r of records) {
    if (!CLASS_LIGHTING[r.class] || r.tunnel) continue;
    lit++;
    for (let i = 0; i < r.path.length; i += 2) {
      const x = r.path[i];
      const z = r.path[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!lit || !Number.isFinite(minX)) return null;

  minX -= pad;
  minZ -= pad;
  maxX += pad;
  maxZ += pad;

  const w = Math.max(2, Math.ceil((maxX - minX) / LAMP_TEXEL));
  const h = Math.max(2, Math.ceil((maxZ - minZ) / LAMP_TEXEL));

  // Accumulate in float and quantise at the end: a junction where six streets
  // meet would otherwise clip against the byte long before it should.
  const pool = new Float32Array(w * h);
  const ground = new Float32Array(w * h);
  const groundW = new Float32Array(w * h);

  /** One pool of light centred on a point, with a smooth compact kernel. */
  const splat = (x: number, z: number, y: number, reach: number, weight: number): void => {
    const gx = (x - minX) / LAMP_TEXEL;
    const gz = (z - minZ) / LAMP_TEXEL;
    const r = reach / LAMP_TEXEL;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(gx - r));
    const x1 = Math.min(w - 1, Math.ceil(gx + r));
    const z0 = Math.max(0, Math.floor(gz - r));
    const z1 = Math.min(h - 1, Math.ceil(gz + r));
    for (let zz = z0; zz <= z1; zz++) {
      const dz = zz + 0.5 - gz;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - gx;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        const f = 1 - d2 / r2;
        const wgt = f * f * weight;
        const k = zz * w + xx;
        pool[k] += wgt;
        ground[k] += y * wgt;
        groundW[k] += wgt;
      }
    }
  };

  for (const rec of records) {
    const spec = CLASS_LIGHTING[rec.class];
    if (!spec || rec.tunnel) continue;
    // A viaduct's lighting belongs to the deck, not to the ground underneath,
    // and the field has no way to say so. Dim it rather than paint the ground.
    const weight = spec.weight * (rec.bridge || rec.layer > 0 ? 0.35 : 1);
    const reach = Math.max(6, rec.width * 0.5 + spec.spill);

    const n = rec.path.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      const ax = rec.path[i * 2];
      const az = rec.path[i * 2 + 1];
      const bx = rec.path[i * 2 + 2];
      const bz = rec.path[i * 2 + 3];
      const ay = rec.elevation[i] ?? 0;
      const by = rec.elevation[i + 1] ?? ay;
      const len = Math.hypot(bx - ax, bz - az);
      // Step at a texel so the ribbon is continuous without oversplatting a
      // long straight; the kernel is wider than the step, so it stays smooth.
      const steps = Math.max(1, Math.ceil(len / LAMP_TEXEL));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        // The endpoint of one segment is the start of the next, so halve the
        // ends or every interior vertex gets lit twice.
        const edge = s === 0 || s === steps ? 0.5 : 1;
        splat(
          ax + (bx - ax) * t,
          az + (bz - az) * t,
          ay + (by - ay) * t,
          reach,
          (weight / steps) * len * 0.16 * edge,
        );
      }
    }
  }

  const data = new Uint8Array(w * h * 2);
  let covered = 0;
  for (let k = 0; k < w * h; k++) {
    const p = pool[k];
    if (p > 0) covered++;
    // Saturating rather than linear: a junction with six approaches is brighter
    // than a side street, but not six times brighter.
    data[k * 2] = Math.round(255 * (1 - Math.exp(-p * 1.6)));
    const gy = groundW[k] > 0 ? ground[k] / groundW[k] : 0;
    data[k * 2 + 1] = Math.round(
      255 * THREE.MathUtils.clamp((gy + 8) / LAMP_GROUND_RANGE, 0, 1),
    );
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.name = 'lampField';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  console.info(
    `[Roads] street-light field ${w}x${h} at ${LAMP_TEXEL} m ` +
    `(${(data.length / 1048576).toFixed(1)} MB) from ${lit} lit ways, ` +
    `${((100 * covered) / (w * h)).toFixed(1)}% of the city lit`,
  );

  return {
    texture: tex,
    origin: new THREE.Vector2(minX, minZ),
    size: new THREE.Vector2(w * LAMP_TEXEL, h * LAMP_TEXEL),
    groundRange: LAMP_GROUND_RANGE,
  };
}
