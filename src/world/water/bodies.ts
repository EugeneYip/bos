/**
 * Turns the `AreaRecord`s tagged `water` / `river` into the descriptors the
 * rest of the module works from.
 *
 * Two per-body numbers do most of the art direction:
 *
 * - **fetch** — how far wind can run before it reaches this water. It sets the
 *   wave spectrum: the outer harbour gets a long, low swell; the impounded
 *   Charles basin gets nothing but fine ripples; Fort Point Channel and the
 *   marinas are dead flat. It is seeded from the body's name/kind and then
 *   refined with the largest inscribed distance measured off the SDF, so a
 *   1 km-wide basin is never as rough as a 12 km² harbour.
 * - **murk** — position on the single turbidity axis the shader lerps along,
 *   0 = tidal harbour (turbid green-brown), 1 = the Charles and the ponds
 *   (brown-olive, almost opaque by 1.5 m). Nothing in Boston is blue.
 */
import type { AreaRecord } from '../../core/types';
import { cleanRing, ringArea2, ringBounds, type Ring } from './poly';

export interface WaterBody {
  id: string;
  name: string;
  /** Outer ring plus holes; the outer ring is always first. */
  rings: Ring[];
  outer: Ring;
  holes: Ring[];
  /** Still-water surface height in metres. The Charles basin sits at +0.6. */
  elevation: number;
  /** Plan area, m². */
  area: number;
  /** [minX, minZ, maxX, maxZ] */
  bounds: number[];
  /** 0..1 wave energy scale. Refined once the SDF exists. */
  fetch: number;
  /** Upper bound on fetch from the body's character (a marina stays calm). */
  fetchCap: number;
  /** 0 = harbour, 1 = Charles / pond. */
  murk: number;
  /** Largest distance from any interior point to the shore, metres. */
  inradius: number;
  /**
   * Set when a larger body already covers this one — the marinas and dry docks
   * are cut *into* the harbour polygon, so drawing them again would double the
   * alpha. They still paint their fetch and turbidity into the aux map, which
   * is the only reason they matter visually.
   */
  skipGeometry: boolean;
}

const RE_POND = /pond|lagoon|pool|lake|reservoir/i;
const RE_DOCK = /marina|dock|wharf|yacht|boathouse|shipyard|sailing|canal|slip/i;
const RE_CHARLES = /charles/i;
const RE_CHANNEL = /channel|creek|canal/i;

/**
 * The world rectangle that the rest of the city covers. Water is clipped to a
 * little beyond it: the Mystic and the Neponset run several kilometres off the
 * edge of the dataset and there is no terrain out there to meet them.
 */
export function clipRingToRect(r: Ring, minX: number, minZ: number, maxX: number, maxZ: number): Ring | null {
  let src: number[] = Array.from(r);
  const dst: number[] = [];
  const planes: Array<[0 | 1, number, boolean]> = [
    [0, minX, true], [0, maxX, false], [1, minZ, true], [1, maxZ, false],
  ];
  for (const [axis, value, keepGreater] of planes) {
    let w = 0;
    const n = src.length;
    if (n < 6) return null;
    let px = src[n - 2], pz = src[n - 1];
    let pv = axis === 0 ? px : pz;
    let pin = keepGreater ? pv >= value : pv <= value;
    dst.length = 0;
    for (let i = 0; i < n; i += 2) {
      const cx = src[i], cz = src[i + 1];
      const cv = axis === 0 ? cx : cz;
      const cin = keepGreater ? cv >= value : cv <= value;
      if (cin !== pin) {
        const t = (value - pv) / (cv - pv);
        dst[w++] = px + (cx - px) * t;
        dst[w++] = pz + (cz - pz) * t;
      }
      if (cin) { dst[w++] = cx; dst[w++] = cz; }
      px = cx; pz = cz; pv = cv; pin = cin;
    }
    dst.length = w;
    src = dst.slice();
  }
  return src.length >= 6 ? Float64Array.from(src) : null;
}

function classify(rec: AreaRecord, area: number): { murk: number; fetchCap: number } {
  const name = rec.name ?? '';
  // Impounded fresh water above the dam: the Charles basin and its slips.
  if (rec.elevation > 0.3 || RE_CHARLES.test(name)) {
    return { murk: 0.95, fetchCap: area > 3e5 ? 0.34 : 0.16 };
  }
  if (RE_POND.test(name)) return { murk: 1.0, fetchCap: 0.1 };
  if (RE_DOCK.test(name)) return { murk: 0.34, fetchCap: 0.16 };
  if (RE_CHANNEL.test(name)) return { murk: 0.6, fetchCap: 0.2 };
  if (rec.kind === 'river') {
    // The Mystic, Chelsea Creek and the Neponset: brackish, silty, sheltered.
    return { murk: 0.62, fetchCap: area > 4e5 ? 0.5 : 0.3 };
  }
  // Open tidal water — the harbour itself and everything the coastline
  // assembler merged into it.
  return { murk: 0.12, fetchCap: 1.0 };
}

export function buildBodies(
  records: AreaRecord[],
  rect: { minX: number; minZ: number; maxX: number; maxZ: number },
): WaterBody[] {
  const out: WaterBody[] = [];
  for (const rec of records) {
    if (rec.kind !== 'water' && rec.kind !== 'river') continue;
    if (!rec.outline || rec.outline.length < 8) continue;

    let outer = cleanRing(rec.outline);
    if (outer.length < 8) continue;

    // Only clip when the ring actually leaves the modelled rectangle — the
    // clipper would otherwise re-emit every polygon with float drift.
    const b: number[] = [0, 0, 0, 0];
    ringBounds(outer, b);
    if (b[0] < rect.minX || b[1] < rect.minZ || b[2] > rect.maxX || b[3] > rect.maxZ) {
      const c = clipRingToRect(outer, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
      if (!c) continue;
      outer = c;
      ringBounds(outer, b);
    }

    const area = Math.abs(ringArea2(outer)) * 0.5;
    if (area < 24) continue;

    const holes: Ring[] = [];
    for (const h of rec.holes ?? []) {
      const hr = cleanRing(h);
      if (hr.length < 8) continue;
      if (Math.abs(ringArea2(hr)) * 0.5 < 12) continue;
      holes.push(hr);
    }

    const { murk, fetchCap } = classify(rec, area);
    out.push({
      id: rec.id,
      name: rec.name ?? '',
      rings: [outer, ...holes],
      outer,
      holes,
      elevation: rec.elevation,
      area,
      bounds: b.slice(),
      fetch: fetchCap,
      fetchCap,
      murk,
      inradius: 0,
      skipGeometry: false,
    });
  }
  // Big bodies first: the SDF and the aux map are painted in this order so a
  // marina cut into the harbour wins over the harbour underneath it.
  out.sort((a, c) => c.area - a.area);
  return out;
}
