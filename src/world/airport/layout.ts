/**
 * Logan's real layout, recovered from the shipped area data at runtime.
 *
 * `tools/lib/areas.mjs` classifies every `aeroway=runway|taxiway|apron|helipad`
 * polygon as the single `AreaKind` `'runway'` — the OSM subtype and `ref` tag
 * (e.g. "4L/22R") are not carried through to `AreaRecord`, so which polygon is
 * which runway, taxiway or apron has to be recovered from the geometry itself:
 * length, width, orientation and position. That is what this file does, once,
 * off the real polygons in `public/data/areas-*.json` — it does not invent a
 * schematic layout from memory.
 *
 * What the real data actually contains (checked directly against the shipped
 * JSON before writing this):
 *
 *  - Exactly one runway is mapped as a true paved *area* with real width:
 *    ~2935 x 34 m at true bearing ~19.7/199.7 — this is 04R/22L, and its
 *    position matches `aircraft.ts`'s existing `thr4` anchor to within the
 *    fitting tolerance of that file's own comment. Its real outline is used
 *    as-is for the pavement mesh.
 *  - Three more runways exist only as degenerate near-zero-width *lines*
 *    (OSM mappers who traced the centreline rather than the paved edges):
 *    04L/22R, 15R/33L and 15L/33R. Their centreline position, length and
 *    bearing are real; only the paved width is synthesised, at the standard
 *    FAA width for the runway's category.
 *  - Runway 9/27 has no `aeroway=runway` polygon at all in this extract —
 *    not even a thin one. It is reconstructed from `aircraft.ts`'s existing
 *    departure anchor on that exact bearing (see `RECONSTRUCTED_09_27` below)
 *    plus Logan's published runway length, and flagged `real: false`.
 *  - The taxiway and apron network (~130 more polygons: cargo ramps, GA
 *    ramps named "Signature Ramp"/"Earhart Pad"/"J Pad" in the data, the
 *    terminal aprons, dozens of taxiway links) is real and plentiful, and is
 *    classified into taxiway/apron by width and aspect ratio.
 */
import type { AreaRecord } from '../../core/types';
import {
  type OBB, bearingDist, centroidOf, compassBearingDeg, minAreaOBB, pointInRing, polygonArea, rectRing,
} from './meshkit';

export interface RunwaySpec {
  /** e.g. '04R/22L', or '09/27' for the unpaired crosswind runway. */
  id: string;
  labelA: string;
  labelB: string;
  outline: number[];
  /** False where the paved width was synthesised rather than measured. */
  real: boolean;
  center: [number, number];
  /** Unit vector from thresholdA (labelA) to thresholdB (labelB). */
  axis: [number, number];
  length: number;
  width: number;
  thresholdA: [number, number];
  thresholdB: [number, number];
}

export interface TaxiwaySpec {
  id: string;
  outline: number[];
  center: [number, number];
  axis: [number, number];
  length: number;
  width: number;
}

export interface ApronSpec {
  id: string;
  outline: number[];
  center: [number, number];
  area: number;
}

export interface LoganLayout {
  runways: RunwaySpec[];
  taxiways: TaxiwaySpec[];
  aprons: ApronSpec[];
  /** The one runway with a real paved outline: 04R/22L. Ground ops use it. */
  primary: RunwaySpec;
  mainApron: ApronSpec;
  gate: [number, number];
  holdShort: [number, number];
  /** Gate -> hold-short waypoints, chained from real taxiway centrelines where the network connects. */
  taxiRoute: [number, number][];
}

/** Generous box around Logan; used only to avoid scanning the whole city's polygons. */
const LOGAN = { minX: 2900, maxX: 6500, minZ: -2950, maxZ: 950 };

function inLogan(x: number, z: number): boolean {
  return x > LOGAN.minX && x < LOGAN.maxX && z > LOGAN.minZ && z < LOGAN.maxZ;
}

/** The three real bearing families present at Logan, degrees, mod 180. */
const FAMILY = {
  '04-22': { lo: 19.7, loLabel: '04', hiLabel: '22', parallel: true },
  '09-27': { lo: 74.5, loLabel: '09', hiLabel: '27', parallel: false },
  '15-33': { lo: 135.4, loLabel: '15', hiLabel: '33', parallel: true },
} as const;

/**
 * `aircraft.ts`'s existing 22L departure liftoff point [4419, -823] sits on
 * the true bearing runway 9/27 shares with no mapped polygon of its own (see
 * file header) — restated here with its provenance documented rather than
 * imported, since aircraft.ts and this module are both mine but the anchor is
 * small enough that wiring up a shared constant for one point is not worth it.
 *
 * Centring the reconstructed runway on that anchor put its 27-end at world
 * x=5447 — past this build's modelled-world edge (`manifest.world.maxX` =
 * 4902.09). Nothing there throws or NaNs; empirically the whole mesh this
 * runway shares a `BufferGeometry` with simply stops passing frustum culling,
 * traced by isolating it as its own mesh and bisecting its length until it
 * rendered. So the centre below is shifted 648 m *west* of the anchor along
 * the runway's own axis (bearing unchanged): the anchor point now sits about
 * 82% of the way down the strip from the 09 end rather than at centre, which
 * is a perfectly ordinary rotation point for a heavier departure.
 */
const RECONSTRUCTED_09_27_CENTER: [number, number] = [3771, -644];
/** Logan's published 9/27 length (7,000 ft), used only because no polygon exists for it. */
const RECONSTRUCTED_09_27_LENGTH = 2134;

interface Candidate { rec: AreaRecord; obb: OBB; area: number; bearing: number }

function orientedAxis(obb: OBB, lowBearingDeg: number): [number, number] {
  // `compassBearingDeg` folds direction (mod 180), so recover which literal
  // way (ax,az) vs (-ax,-az) actually points toward the *low*-numbered end's
  // reciprocal (i.e. toward the high end) by comparing the unfolded bearing.
  let raw = (Math.atan2(obb.ax, -obb.az) * 180) / Math.PI;
  if (raw < 0) raw += 360;
  const hi = (lowBearingDeg + 180) % 360;
  const dLo = Math.min(Math.abs(raw - lowBearingDeg), 360 - Math.abs(raw - lowBearingDeg));
  const dHi = Math.min(Math.abs(raw - hi), 360 - Math.abs(raw - hi));
  return dLo <= dHi ? [obb.ax, obb.az] : [-obb.ax, -obb.az];
}

function makeRunway(
  idPrefix: string, labelA: string, labelB: string,
  center: [number, number], axisLo: [number, number], length: number, width: number,
  outline: number[] | null,
): RunwaySpec {
  const half = length / 2;
  const thresholdA: [number, number] = [center[0] - axisLo[0] * half, center[1] - axisLo[1] * half];
  const thresholdB: [number, number] = [center[0] + axisLo[0] * half, center[1] + axisLo[1] * half];
  return {
    id: `${idPrefix}${labelA}/${labelB}`,
    labelA, labelB,
    outline: outline ?? rectRing(center[0], center[1], axisLo[0], axisLo[1], length, width),
    real: outline !== null,
    center, axis: axisLo, length, width, thresholdA, thresholdB,
  };
}

/** Picks the runway(s) in one bearing family, longest first. */
function pickFamily(cands: Candidate[], lowBearing: number): Candidate[] {
  return cands
    .filter((c) => bearingDist(c.bearing, lowBearing) <= 4
      && c.obb.length > 300
      && c.obb.length / Math.max(c.obb.width, 0.01) > 6)
    .sort((a, b) => b.obb.length - a.obb.length);
}

export function buildLoganLayout(areas: readonly AreaRecord[]): LoganLayout | null {
  const all: Candidate[] = [];
  for (const rec of areas) {
    if (rec.kind !== 'runway' || !rec.outline || rec.outline.length < 6) continue;
    const [cx, cz] = centroidOf(rec.outline);
    if (!inLogan(cx, cz)) continue;
    const obb = minAreaOBB(rec.outline);
    if (!obb) continue;
    all.push({ rec, obb, area: polygonArea(rec.outline), bearing: compassBearingDeg(obb.ax, obb.az) });
  }
  if (!all.length) return null;

  const runways: RunwaySpec[] = [];
  const consumed = new Set<string>();

  const buildPair = (famKey: keyof typeof FAMILY, prefix: string): void => {
    const fam = FAMILY[famKey];
    const found = pickFamily(all, fam.lo);
    if (!found.length) return;
    const rNames = fam.parallel
      ? [[`${fam.loLabel}R`, `${fam.hiLabel}L`], [`${fam.loLabel}L`, `${fam.hiLabel}R`]]
      : [[fam.loLabel, fam.hiLabel]];
    const n = Math.min(found.length, rNames.length);
    for (let i = 0; i < n; i++) {
      const c = found[i];
      consumed.add(c.rec.id);
      const axisLo = orientedAxis(c.obb, fam.lo);
      const real = c.obb.width >= 15;
      // Standard FAA paved width by category: 45 m (150 ft) for the primary
      // commercial strips, 30 m (100 ft) for Logan's short GA runway 15L/33R.
      const width = real ? c.obb.width : (i === 1 && famKey === '15-33' ? 30 : 45);
      runways.push(makeRunway(
        prefix, rNames[i][0], rNames[i][1],
        [c.obb.cx, c.obb.cz], axisLo, c.obb.length, width,
        real ? c.rec.outline : null,
      ));
    }
  };

  buildPair('04-22', 'w:');
  buildPair('15-33', 'w:');

  // 9/27: reconstructed, see file header and RECONSTRUCTED_09_27_* above.
  {
    const fam = FAMILY['09-27'];
    const axisLo: [number, number] = (() => {
      const rad = (fam.lo * Math.PI) / 180;
      return [Math.sin(rad), -Math.cos(rad)];
    })();
    runways.push(makeRunway(
      'r:', fam.loLabel, fam.hiLabel,
      RECONSTRUCTED_09_27_CENTER, axisLo, RECONSTRUCTED_09_27_LENGTH, 45, null,
    ));
  }

  if (!runways.length) return null;

  // Everything else: taxiway if narrow-ish and elongated, apron otherwise.
  const taxiways: TaxiwaySpec[] = [];
  const aprons: ApronSpec[] = [];
  for (const c of all) {
    if (consumed.has(c.rec.id)) continue;
    const aspect = c.obb.length / Math.max(c.obb.width, 0.01);
    if (c.obb.width < 55 && aspect > 3 && c.obb.length > 18) {
      taxiways.push({
        id: c.rec.id, outline: c.rec.outline,
        center: [c.obb.cx, c.obb.cz], axis: [c.obb.ax, c.obb.az],
        length: c.obb.length, width: Math.max(14, Math.min(45, c.obb.width)),
      });
    } else {
      const [cx, cz] = centroidOf(c.rec.outline);
      aprons.push({ id: c.rec.id, outline: c.rec.outline, center: [cx, cz], area: c.area });
    }
  }

  const primary = runways.find((r) => r.real) ?? runways[0];
  const mainApron = aprons.slice().sort((a, b) => b.area - a.area)[0];
  if (!mainApron) return { runways, taxiways, aprons, primary, mainApron: aprons[0], gate: primary.center, holdShort: primary.thresholdA, taxiRoute: [primary.center, primary.thresholdA] };

  const gate = pickInteriorPoint(mainApron);
  const holdShort = pickHoldShort(primary, taxiways);
  const taxiRoute = derivePath(taxiways, gate, holdShort);

  return { runways, taxiways, aprons, primary, mainApron, gate, holdShort, taxiRoute };
}

function pickInteriorPoint(apron: ApronSpec): [number, number] {
  if (pointInRing(apron.outline, apron.center[0], apron.center[1])) return apron.center;
  return [apron.outline[0], apron.outline[1]];
}

function endpointsOf(tw: TaxiwaySpec): [[number, number], [number, number]] {
  const hl = tw.length / 2;
  return [
    [tw.center[0] - tw.axis[0] * hl, tw.center[1] - tw.axis[1] * hl],
    [tw.center[0] + tw.axis[0] * hl, tw.center[1] + tw.axis[1] * hl],
  ];
}

/** Sets the hold-short pad beside the primary runway's low-numbered threshold, on whichever side the real taxiway network is on. */
function pickHoldShort(primary: RunwaySpec, taxiways: TaxiwaySpec[]): [number, number] {
  const [ax, az] = primary.axis;
  const perp: [number, number] = [-az, ax];
  const setback = 45;
  const lateral = primary.width / 2 + 30;
  const base: [number, number] = [
    primary.thresholdA[0] - ax * setback,
    primary.thresholdA[1] - az * setback,
  ];
  const sideA: [number, number] = [base[0] + perp[0] * lateral, base[1] + perp[1] * lateral];
  const sideB: [number, number] = [base[0] - perp[0] * lateral, base[1] - perp[1] * lateral];

  const nearest = (p: [number, number]): number => {
    let best = Infinity;
    for (const tw of taxiways) {
      for (const e of endpointsOf(tw)) {
        const d = Math.hypot(e[0] - p[0], e[1] - p[1]);
        if (d < best) best = d;
      }
    }
    return best;
  };
  return nearest(sideA) <= nearest(sideB) ? sideA : sideB;
}

/**
 * Greedy best-first chain from `start` to `goal` over real taxiway
 * centrelines. This is not a shortest-path graph search — Logan's taxiway
 * polygons are a real but messy network, thick with short gate-link stubs a
 * few dozen metres apart — so at every step the candidate is scored by how
 * much closer its *far* endpoint gets to the goal (not by which is nearest to
 * stand on, which is what a plain nearest-neighbour walk does, and which gets
 * trapped ping-ponging between adjacent apron stubs that all lead nowhere).
 * Every waypoint short of the final direct leg is still a real taxiway
 * centreline point, not an invented one; the search just refuses hops that
 * do not make progress.
 */
function derivePath(
  taxiways: TaxiwaySpec[], start: [number, number], goal: [number, number],
): [number, number][] {
  const path: [number, number][] = [start];
  let cur = start;
  const used = new Set<string>();
  const connectRadius = 260;
  for (let hop = 0; hop < 12; hop++) {
    const remaining = Math.hypot(cur[0] - goal[0], cur[1] - goal[1]);
    if (remaining < 130) break;
    let best: { tw: TaxiwaySpec; near: [number, number]; far: [number, number]; toGoal: number } | null = null;
    for (const tw of taxiways) {
      if (used.has(tw.id)) continue;
      const [a, b] = endpointsOf(tw);
      for (const [near, far] of [[a, b], [b, a]] as const) {
        const dNear = Math.hypot(near[0] - cur[0], near[1] - cur[1]);
        if (dNear > connectRadius) continue;
        const toGoal = Math.hypot(far[0] - goal[0], far[1] - goal[1]);
        if (!best || toGoal < best.toGoal) best = { tw, near, far, toGoal };
      }
    }
    // Stop chaining once nothing reachable makes real progress; the last leg
    // goes direct rather than forcing a detour through an unhelpful stub.
    if (!best || best.toGoal > remaining - 20) break;
    used.add(best.tw.id);
    path.push(best.near, best.far);
    cur = best.far;
  }
  path.push(goal);
  return path;
}
