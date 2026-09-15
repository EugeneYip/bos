/**
 * Turning 88 226 points into a city's canopy.
 *
 * The shipped `PropSet` already puts trees in the right *places* — along
 * residential streets, inside park polygons, never in a building or the
 * harbour. What it does not do is make them read like Boston: species are
 * assigned by a uniform random, every tree gets the same size distribution,
 * and park trees sit on a jittered grid rather than in the clumps and
 * clearings a real park has.
 *
 * This pass fixes all three, at load, using the land mask:
 *
 *  - **Species by context.** Weighted by habitat, and *spatially coherent* on
 *    streets — Boston plants a block at a time, so one block is honey locust
 *    and the next is linden, instead of six species shuffled per tree.
 *  - **Size by context.** A pruned street tree and a 120-year-old park oak are
 *    not the same object. Street stock tops out around 70 % of mature height;
 *    a big park grows the full thing, and the bigger the park the bigger.
 *  - **Clumping in parks.** A smooth displacement field pulls park trees into
 *    groves and opens up lawn between them, but only where the mask still says
 *    green-and-off-road, so nothing walks onto a path or into the water.
 *  - **Row infill on streets.** Where two street trees are 17-30 m apart the
 *    row has a hole in it; one tree goes in the middle if the mask says that
 *    point is not carriageway.
 */
import type { PropSet } from '../../core/types';
import { SPECIES, type HabitatKey } from './species';
import { CLASS_CEMETERY, CLASS_FOREST, CLASS_LAWN, CLASS_NONE, CLASS_PARK, FLAG_ROAD, LandMask } from './landmask';

export interface TreeField {
  count: number;
  /** World position. */
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  rot: Float32Array;
  /** Lean off vertical, radians, and the azimuth of the lean axis. */
  tilt: Float32Array;
  tiltAz: Float32Array;
  /** Total height, metres. */
  height: Float32Array;
  /** Crown width multiplier relative to the species default. */
  width: Float32Array;
  species: Uint8Array;
  /** Tree indices grouped by species, each sorted by nothing in particular. */
  bySpecies: Uint32Array[];
  stats: { street: number; park: number; forest: number; lawn: number; infill: number };
}

function hash2(x: number, z: number, salt: number): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(z | 0, 19349663) ^ Math.imul(salt, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth, seamless clumping field. Two octaves is enough to break a grid. */
function clumpField(x: number, z: number): [number, number] {
  const a = Math.sin(x * 0.0221 + 1.7) * Math.cos(z * 0.0187 - 0.6)
    + 0.55 * Math.sin(x * 0.0613 - 2.1) * Math.cos(z * 0.0557 + 1.2);
  const b = Math.cos(x * 0.0203 - 0.9) * Math.sin(z * 0.0235 + 2.4)
    + 0.55 * Math.cos(x * 0.0589 + 0.4) * Math.sin(z * 0.0641 - 1.8);
  return [a, b];
}

function habitatOf(cls: number): HabitatKey {
  switch (cls) {
    case CLASS_PARK: return 'park';
    case CLASS_FOREST: return 'forest';
    case CLASS_LAWN:
    case CLASS_CEMETERY: return 'lawn';
    default: return 'street';
  }
}

/** Weighted species pick from a uniform sample in [0,1). */
function pickSpecies(h: HabitatKey, u: number): number {
  let total = 0;
  for (const s of SPECIES) total += s.habitat[h];
  let acc = u * total;
  for (let i = 0; i < SPECIES.length; i++) {
    acc -= SPECIES[i].habitat[h];
    if (acc <= 0) return i;
  }
  return SPECIES.length - 1;
}

export interface PlacementOptions {
  mask: LandMask;
  sampleHeight: (x: number, z: number) => number;
  /** Fill holes in street rows. */
  infill: boolean;
  /** Displace park trees into groves. */
  clump: boolean;
}

export function buildTreeField(sets: PropSet[], o: PlacementOptions): TreeField {
  const trees = sets.filter((s) => s.kind === 'tree');
  let n = 0;
  for (const s of trees) n += s.positions.length / 3;

  // Room for the infill pass on top of the shipped points.
  const cap = o.infill ? Math.ceil(n * 1.28) : n;
  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const pz = new Float32Array(cap);
  const rot = new Float32Array(cap);
  const base = new Float32Array(cap); // 0..1 age/vigour from the source scale
  const cls = new Uint8Array(cap);

  const mask = o.mask;
  let w = 0;
  for (const s of trees) {
    const m = s.positions.length / 3;
    for (let i = 0; i < m; i++) {
      let x = s.positions[i * 3];
      let z = s.positions[i * 3 + 2];
      const raw = mask.at(x, z);
      let c = raw & 7;
      if (c > CLASS_CEMETERY) c = CLASS_NONE; // blocked cells: treat as street

      // Clump park and woodland trees into groves. Street rows stay put.
      if (o.clump && c >= CLASS_LAWN && c <= CLASS_CEMETERY && !(raw & FLAG_ROAD)) {
        const [dx, dz] = clumpField(x, z);
        const amp = c === CLASS_FOREST ? 5.5 : 6.5;
        const nx = x + dx * amp;
        const nz = z + dz * amp;
        const nraw = mask.at(nx, nz);
        const nc = nraw & 7;
        if (nc >= CLASS_LAWN && nc <= CLASS_CEMETERY && !(nraw & FLAG_ROAD)) {
          x = nx;
          z = nz;
        }
      }

      px[w] = x;
      pz[w] = z;
      const sc = s.scales[i] ?? 1;
      base[w] = Math.min(1, Math.max(0, (sc - 0.62) / 0.93));
      rot[w] = s.rotations[i] ?? 0;
      cls[w] = c;
      w++;
    }
  }
  let count = w;

  // --- row infill ----------------------------------------------------------
  let infilled = 0;
  if (o.infill && count > 1) {
    const CELL = 18;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (pz[i] < minZ) minZ = pz[i];
      if (pz[i] > maxZ) maxZ = pz[i];
    }
    const gx = Math.ceil((maxX - minX) / CELL) + 1;
    const gz = Math.ceil((maxZ - minZ) / CELL) + 1;
    const head = new Int32Array(gx * gz).fill(-1);
    const next = new Int32Array(count).fill(-1);
    const cellOf = (x: number, z: number): number => {
      const i = Math.min(gx - 1, Math.max(0, Math.floor((x - minX) / CELL)));
      const j = Math.min(gz - 1, Math.max(0, Math.floor((z - minZ) / CELL)));
      return j * gx + i;
    };
    for (let i = 0; i < count; i++) {
      const c = cellOf(px[i], pz[i]);
      next[i] = head[c];
      head[c] = i;
    }
    const occupied = (x: number, z: number, r: number, skipA: number, skipB: number): boolean => {
      const i0 = Math.max(0, Math.floor((x - r - minX) / CELL));
      const i1 = Math.min(gx - 1, Math.floor((x + r - minX) / CELL));
      const j0 = Math.max(0, Math.floor((z - r - minZ) / CELL));
      const j1 = Math.min(gz - 1, Math.floor((z + r - minZ) / CELL));
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          for (let k = head[j * gx + i]; k >= 0; k = next[k]) {
            if (k === skipA || k === skipB) continue;
            const dx = px[k] - x, dz = pz[k] - z;
            if (dx * dx + dz * dz < r2) return true;
          }
        }
      }
      return false;
    };

    for (let i = 0; i < count && w < cap; i++) {
      if (cls[i] !== CLASS_NONE) continue;
      const ci = Math.floor((px[i] - minX) / CELL);
      const cj = Math.floor((pz[i] - minZ) / CELL);
      for (let dj = 0; dj <= 1 && w < cap; dj++) {
        for (let di = -1; di <= 1 && w < cap; di++) {
          if (dj === 0 && di < 0) continue;
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= gx || jj >= gz) continue;
          for (let k = head[jj * gx + ii]; k >= 0; k = next[k]) {
            if (k <= i || cls[k] !== CLASS_NONE) continue;
            const dx = px[k] - px[i], dz = pz[k] - pz[i];
            const d2 = dx * dx + dz * dz;
            if (d2 < 17 * 17 || d2 > 30 * 30) continue;
            const mx = (px[i] + px[k]) * 0.5;
            const mz = (pz[i] + pz[k]) * 0.5;
            // Never onto a carriageway, never on top of an existing tree.
            if (mask.at(mx, mz) & FLAG_ROAD) continue;
            if (occupied(mx, mz, 6.5, i, k)) continue;
            px[w] = mx;
            pz[w] = mz;
            base[w] = Math.min(1, (base[i] + base[k]) * 0.5 + (hash2(mx, mz, 11) - 0.5) * 0.3);
            rot[w] = hash2(mx, mz, 3) * Math.PI * 2;
            cls[w] = CLASS_NONE;
            w++;
            infilled++;
            if (w >= cap) break;
          }
        }
      }
    }
    count = w;
  }

  // --- species, size, ground -----------------------------------------------
  const height = new Float32Array(count);
  const width = new Float32Array(count);
  const tilt = new Float32Array(count);
  const tiltAz = new Float32Array(count);
  const species = new Uint8Array(count);
  const stats = { street: 0, park: 0, forest: 0, lawn: 0, infill: infilled };
  const counts = new Array(SPECIES.length).fill(0);

  for (let i = 0; i < count; i++) {
    const x = px[i], z = pz[i];
    const c = cls[i];
    const h = habitatOf(c);
    stats[h]++;

    // Streets are planted a block at a time: share the draw across ~70 m.
    const u = h === 'street'
      ? hash2(Math.floor(x / 70), Math.floor(z / 70), 17) * 0.82 + hash2(x, z, 29) * 0.18
      : hash2(x, z, 41);
    const si = pickSpecies(h, u);
    species[i] = si;
    counts[si]++;

    const sp = SPECIES[si];
    const vigour = base[i];
    let mul: number;
    let wid: number;
    switch (h) {
      case 'street':
        // Pruned, root-restricted, replanted often.
        mul = 0.50 + 0.48 * vigour;
        wid = 0.78 + 0.32 * hash2(x, z, 53);
        break;
      case 'park': {
        // Room to grow, and the bigger the park the older the specimens.
        const room = Math.min(1, Math.max(0, (o.mask.extentAt(x, z) - 45) / 380));
        mul = 0.74 + 0.44 * vigour + 0.24 * room;
        wid = 0.94 + 0.38 * hash2(x, z, 59);
        break;
      }
      case 'forest':
        // Competition: tall and narrow.
        mul = 0.80 + 0.34 * vigour;
        wid = 0.64 + 0.26 * hash2(x, z, 61);
        break;
      default:
        mul = 0.68 + 0.46 * vigour;
        wid = 0.88 + 0.34 * hash2(x, z, 67);
    }
    height[i] = sp.height * mul;
    width[i] = wid;
    // Lean. Street trees are staked young and come out near-vertical; a park
    // specimen has spent eighty years reaching for the nearest gap in the
    // canopy, and a woodland tree more than that.
    const leanMax = h === 'street' ? 0.022 : h === 'forest' ? 0.075 : 0.05;
    tilt[i] = leanMax * (0.25 + 0.75 * hash2(x, z, 71));
    tiltAz[i] = hash2(x, z, 73) * Math.PI * 2;
    // Resample the ground: the shipped Y came from the raw DEM, the runtime
    // terrain is upsampled, and a 20 cm gap under a trunk is very visible.
    py[i] = o.sampleHeight(x, z) - Math.max(0.15, height[i] * 0.012);
  }

  const bySpecies = counts.map((c: number) => new Uint32Array(c));
  const cursor = new Array(SPECIES.length).fill(0);
  for (let i = 0; i < count; i++) {
    const s = species[i];
    bySpecies[s][cursor[s]++] = i;
  }

  return {
    count,
    px: px.subarray(0, count),
    py,
    pz: pz.subarray(0, count),
    rot: rot.subarray(0, count),
    tilt,
    tiltAz,
    height,
    width,
    species,
    bySpecies,
    stats,
  };
}
