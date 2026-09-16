/**
 * Per-class road specification plus the tunables the whole module reads from.
 * Dimensions follow MassDOT / MUTCD practice: 3.35 m urban lanes, 150 mm kerb
 * reveal, 100 mm lane lines, 3.0 m / 9.1 m broken-line cycle.
 */
import type { RoadClass, RoadRecord } from '../../core/types';

export interface ClassSpec {
  /** Fallback half-width when the record carries no usable width, metres. */
  defaultWidth: number;
  defaultLanes: number;
  /** Sidewalk width per side, metres. 0 means no sidewalk. */
  sidewalk: number;
  /** Draw order priority at junctions; the bigger road owns the surface. */
  priority: number;
  /** Painted lane markings at all? */
  markings: boolean;
  /** Does this class get kerbs? Motorways get barriers instead, not kerbs. */
  kerb: boolean;
  /** Street-lighting-scale detail (manholes, gutter, tree pits). */
  streetDetail: boolean;
}

export const CLASS: Record<RoadClass, ClassSpec> = {
  motorway: { defaultWidth: 14.6, defaultLanes: 4, sidewalk: 0, priority: 100, markings: true, kerb: false, streetDetail: false },
  trunk: { defaultWidth: 13.0, defaultLanes: 4, sidewalk: 0, priority: 90, markings: true, kerb: false, streetDetail: false },
  primary: { defaultWidth: 12.4, defaultLanes: 4, sidewalk: 3.4, priority: 80, markings: true, kerb: true, streetDetail: true },
  secondary: { defaultWidth: 10.4, defaultLanes: 3, sidewalk: 3.0, priority: 70, markings: true, kerb: true, streetDetail: true },
  tertiary: { defaultWidth: 9.0, defaultLanes: 2, sidewalk: 2.7, priority: 60, markings: true, kerb: true, streetDetail: true },
  residential: { defaultWidth: 7.4, defaultLanes: 2, sidewalk: 2.2, priority: 50, markings: false, kerb: true, streetDetail: true },
  service: { defaultWidth: 4.6, defaultLanes: 1, sidewalk: 0, priority: 30, markings: false, kerb: false, streetDetail: false },
  pedestrian: { defaultWidth: 6.2, defaultLanes: 1, sidewalk: 0, priority: 25, markings: false, kerb: false, streetDetail: true },
  footway: { defaultWidth: 2.1, defaultLanes: 1, sidewalk: 0, priority: 10, markings: false, kerb: false, streetDetail: false },
  cycleway: { defaultWidth: 2.4, defaultLanes: 1, sidewalk: 0, priority: 15, markings: false, kerb: false, streetDetail: false },
  rail: { defaultWidth: 4.4, defaultLanes: 1, sidewalk: 0, priority: 5, markings: false, kerb: false, streetDetail: false },
};

export const TUNE = {
  /** Kerb reveal (top of kerb above gutter), metres. */
  kerbHeight: 0.15,
  /** Width of the kerb stone itself, metres. */
  kerbWidth: 0.16,
  /** Gutter pan width sloped toward the kerb. */
  gutterWidth: 0.42,
  /** Cross-slope of the carriageway crown, rise/run. */
  crownSlope: 0.02,
  /** Sidewalk cross-fall toward the kerb. */
  walkSlope: 0.02,
  /** Lift above the sampled ground, metres. Small: polygon offset does the work. */
  surfaceLift: 0.055,
  /** Extra lift for the junction fill so it always wins against ribbon ends. */
  junctionLift: 0.006,
  /** Paint decal lift above the surface it sits on. */
  paintLift: 0.014,
  /** Longest straight segment before resampling splits it, metres. */
  maxSegment: 26,
  /** Target segment length through curves, metres. */
  curveSegment: 5.5,
  /** Douglas-Peucker tolerance when simplifying source polylines, metres. */
  simplifyEps: 0.12,
  /** Mitre length limit as a multiple of half-width before a joint is rounded. */
  miterLimit: 2.1,
  /** Junction fill can never grow beyond this radius, metres. */
  maxJunctionRadius: 26,
  /** Tile size for near-field detail (markings, kerbs), metres. */
  detailTile: 340,
  /** Tile size for the always-on carriageway, metres. */
  baseTile: 1360,
  /** Camera distance inside which markings + sidewalks are built and drawn. */
  detailRange: 760,
  /** Camera distance inside which fine street furniture is drawn. */
  microRange: 230,
  /** Standard US broken lane line: 3.05 m painted, 9.15 m gap. */
  dashOn: 3.05,
  dashGap: 9.15,
  laneLineWidth: 0.1,
  edgeLineWidth: 0.12,
  /** Bridge deck structural depth below the running surface. */
  deckThickness: 1.05,
  parapetHeight: 1.12,
  pierSpacing: 34,
  /** Crosswalk depth along the direction of travel, metres. */
  crosswalkDepth: 2.9,
  /** Continental crosswalk bar width and gap, metres. */
  zebraBar: 0.58,
  zebraGap: 0.52,
  /** Stop bar width along travel, metres. */
  stopBarDepth: 0.55,
  /** Kerb-return radius at a junction corner, metres. */
  kerbReturn: 5.2,
  /** Kerb ramp (dropped kerb) width across the walk, metres. */
  rampWidth: 1.55,
} as const;

/** sRGB paint colours. Boston's yellow is a warm, slightly orange traffic yellow. */
export const PAINT = {
  white: 0xd7d7d2,
  yellow: 0xd8b12c,
  green: 0x2e7d5b,
  red: 0x8e3b31,
  /** Wheel-path polish: a dark, slightly blue sheen decal. */
  wheel: 0x2b2c2e,
} as const;

export interface Zone {
  name: string;
  /** Centre in world metres. */
  x: number;
  z: number;
  /** Radius, metres. */
  r: number;
  /** Sidewalk paving in this zone. */
  paving: 'brick' | 'concrete';
  /** Historic districts where small streets keep their granite setts. */
  cobbleChance: number;
}

/**
 * Neighbourhood zones used to infer paving where the source data is silent.
 * Coordinates are world metres from the Boston Common origin (see core/geo).
 */
export const ZONES: Zone[] = [
  { name: 'Beacon Hill', x: -300, z: -300, r: 420, paving: 'brick', cobbleChance: 0.42 },
  { name: 'Back Bay', x: -1210, z: 470, r: 950, paving: 'brick', cobbleChance: 0.02 },
  { name: 'Faneuil / Quincy Market', x: 865, z: -511, r: 260, paving: 'brick', cobbleChance: 0.55 },
  { name: 'North End', x: 931, z: -1033, r: 430, paving: 'brick', cobbleChance: 0.3 },
  { name: 'Charlestown', x: 437, z: -2200, r: 620, paving: 'brick', cobbleChance: 0.18 },
  { name: 'South End', x: -700, z: 1150, r: 780, paving: 'brick', cobbleChance: 0.05 },
];

export function zoneAt(x: number, z: number): Zone | null {
  let best: Zone | null = null;
  let bestD = Infinity;
  for (const zn of ZONES) {
    const d = Math.hypot(x - zn.x, z - zn.z);
    if (d < zn.r && d < bestD) {
      bestD = d;
      best = zn;
    }
  }
  return best;
}

/** Paving material for the sidewalk beside a road at this position. */
export function sidewalkPaving(x: number, z: number): 'brick_paver' | 'concrete_sidewalk' {
  const zn = zoneAt(x, z);
  return zn && zn.paving === 'brick' ? 'brick_paver' : 'concrete_sidewalk';
}

export type SurfaceKey = 'asphalt' | 'concrete' | 'cobblestone' | 'brick' | 'gravel';

/**
 * Resolves the carriageway surface. OSM's `surface` tag is patchy in Boston, so
 * historic districts get their setts inferred from position + street width.
 */
export function surfaceOf(r: RoadRecord, midX: number, midZ: number): SurfaceKey {
  switch (r.surface) {
    case 'cobblestone': return 'cobblestone';
    case 'brick': return 'brick';
    case 'gravel': return 'gravel';
    case 'concrete': return 'concrete';
    case 'ground': return 'gravel';
    default: break;
  }
  if (r.class === 'rail') return 'gravel';
  const zn = zoneAt(midX, midZ);

  // A pavement is not a road surface. This fell through to asphalt, and
  // `footway` is the largest class in the extract by a wide margin -- 35,232 of
  // 56,655 ways -- so every surviving path in the city was being paved in
  // blacktop. On Boston Common that made the paths vanish into the lawn
  // entirely: at street level the only thing distinguishing them was the
  // grass texture's own slab pattern showing through.
  //
  // The sidewalk footways that run alongside a carriageway are already thrown
  // away by `markSidewalkDuplicates`, because we rebuild those attached to the
  // kerb ourselves. What survives is park paths, plaza links and footbridges,
  // which are concrete in this city -- and brick where Boston is brick. The
  // clay-paver texture in `textures.ts` was authored for exactly this and
  // carries the comment 'Beacon Hill and Back Bay footways'.
  if (r.class === 'footway' || r.class === 'pedestrian') {
    return zn && zn.cobbleChance > 0 ? 'brick' : 'concrete';
  }

  // `pedestrian` is handled above, so it is deliberately absent here.
  if (zn && zn.cobbleChance > 0 && (r.class === 'residential' || r.class === 'service')) {
    // Stable per-way decision, so the same street is always cobbled.
    let h = 2166136261;
    for (let i = 0; i < r.id.length; i++) {
      h ^= r.id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    if ((h >>> 8) / 16777216 < zn.cobbleChance) return 'cobblestone';
  }
  return 'asphalt';
}

/** Standard urban lane, metres (MassDOT / MUTCD). */
export const LANE_WIDTH = 3.35;

/**
 * Carriageway width for one record, in metres.
 *
 * OSM's `width` is not consistently the carriageway: for most Boston streets
 * it is the whole right-of-way, kerb to kerb to building line. Taken at face
 * value and then given sidewalks *outside* it, a residential street came out
 * ~16 m of continuous pavement against a real ~11-12 m, which is why the
 * ground read as a sea of asphalt. So: if the quoted width is wide enough to
 * contain the footways as well as the lanes, take the footways back out, then
 * hold the result to something the lane count can actually justify.
 */
export function widthOf(r: RoadRecord): number {
  const spec = CLASS[r.class] ?? CLASS.residential;
  const lanes = lanesOf(r);
  // What the traffic lanes plus their gutters genuinely need.
  const laneNeed = lanes * LANE_WIDTH + (spec.kerb ? 0.6 : 0.9);

  const quoted = Number.isFinite(r.width) && r.width > 1.2 ? r.width : spec.defaultWidth;
  let w = quoted;
  if (spec.sidewalk > 0 && quoted > laneNeed + spec.sidewalk * 1.2) {
    // Most of the surplus is footway; leave a little for on-street parking,
    // which Boston has almost everywhere.
    w = quoted - spec.sidewalk * 1.5;
  }
  w = Math.max(laneNeed, Math.min(w, spec.defaultWidth * 1.45));
  return Math.min(46, Math.max(1.4, w));
}

export function lanesOf(r: RoadRecord): number {
  const spec = CLASS[r.class] ?? CLASS.residential;
  const l = Number.isFinite(r.lanes) && r.lanes >= 1 ? Math.round(r.lanes) : spec.defaultLanes;
  return Math.min(8, Math.max(1, l));
}

/**
 * Carriageway cross-fall at an across-offset `a`, relative to the crown.
 *
 * Streets are crowned so water runs to the gutter; kerbed streets add a
 * steeper gutter pan in the last `gutterWidth`. Both the ribbon and the
 * junction fill call this, which is what keeps their shared edge watertight.
 */
export function crownDy(a: number, halfWidth: number, kerbed: boolean): number {
  const d = Math.min(Math.abs(a), halfWidth);
  const g = kerbed ? Math.min(TUNE.gutterWidth, halfWidth * 0.35) : 0;
  const flat = halfWidth - g;
  if (d <= flat) return -TUNE.crownSlope * d;
  // Gutter pan: roughly three times the crown fall over its short run.
  return -TUNE.crownSlope * flat - (d - flat) * TUNE.crownSlope * 3.2;
}

/** True when this class is built with kerbs, gutters and a sidewalk. */
export function isKerbed(cls: RoadClass): boolean {
  return CLASS[cls]?.kerb === true;
}

/**
 * Boston's painted bus lanes. OSM does not carry them reliably, so the few
 * corridors that really have red paint are named explicitly.
 */
const BUS_LANE_STREETS = [
  'washington street', 'columbus avenue', 'brighton avenue',
  'north washington street', 'american legion highway', 'blue hill avenue',
];

export function hasBusLane(name: string | undefined, cls: RoadClass): boolean {
  if (!name) return false;
  if (cls !== 'primary' && cls !== 'secondary' && cls !== 'trunk') return false;
  const n = name.toLowerCase();
  return BUS_LANE_STREETS.some((s) => n === s);
}
