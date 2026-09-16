/**
 * The landmark registry — the contract between this module and `Buildings`.
 *
 * `Buildings` suppresses its generic OSM extrusion for any footprint whose
 * `BuildingRecord.landmark` slug appears here, and lets `Landmarks` place the
 * hand-authored mesh instead. Keep `LANDMARKS` and `Landmark` stable.
 *
 * Anchors are real WGS84 lon/lat; project them with `lonLatToWorld` from
 * `core/geo.ts`. `rotation` is a rotation about +Y in radians, authored so that
 * each model's local +X axis lands on the building's real-world bearing (see
 * `lib/util.ts#bearingX`).
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import { bearingX } from './lib/util';

import { buildHancock } from './buildings/hancock';
import { buildPrudential } from './buildings/prudential';
import { buildOneDalton } from './buildings/oneDalton';
import { buildMillennium } from './buildings/millennium';
import { buildStateHouse } from './buildings/stateHouse';
import { buildZakim } from './buildings/zakim';
import { buildCustomHouse } from './buildings/customHouse';
import { buildBunkerHill } from './buildings/bunkerHill';
import { buildFenway } from './buildings/fenway';
import { buildFaneuil } from './buildings/faneuil';
import { buildTrinity } from './buildings/trinity';
import { buildBPL } from './buildings/bpl';
import { buildOldNorth } from './buildings/oldNorth';
import { buildOldStateHouse } from './buildings/oldStateHouse';
import { buildCityHall } from './buildings/cityHall';
import { buildMitDome } from './buildings/mitDome';
import { buildLongfellow } from './buildings/longfellow';
import { buildCitgo } from './buildings/citgo';
import {
  buildConstitution,
  CONSTITUTION_BEARING,
  CONSTITUTION_LAT,
  CONSTITUTION_LON,
} from './buildings/constitution';
import { buildWidener, buildMemorialChurch, buildSeverHall } from './campus/harvard';
import { buildKresge, buildStataCenter } from './campus/mit';
import { NEU_LANDMARKS } from './campus/northeastern';

export interface Landmark {
  /** Matches `BuildingRecord.landmark`. */
  slug: string;
  name: string;
  /** Real-world anchor; use `lonLatToWorld` to place. */
  lon: number;
  lat: number;
  /** Rotation about Y so the building faces the way it really does, radians. */
  rotation: number;
  /** Builds the mesh. Called lazily. Returns a Group centred at origin, base at y=0. */
  build(ctx: Ctx): THREE.Object3D;

  /* ---- advisory metadata (additive; safe to ignore) ---------------------- */

  /** Top of the built form above its own base, metres. For culling/labels. */
  height?: number;
  /** Radius in metres that the mesh occupies around the anchor. */
  radius?: number;
  /**
   * Extra OSM landmark slugs this model also replaces, for complexes that span
   * several footprints (Faneuil Hall + Quincy Market, Fenway's grandstand).
   */
  absorbs?: string[];
  /** 1 = skyline signature, 2 = strong local identity. */
  tier?: 1 | 2;
}

export const LANDMARKS: Landmark[] = [
  /* ------------------------------------------------------------- tier one */
  {
    slug: 'hancock-tower',
    name: '200 Clarendon Street (John Hancock Tower)',
    lon: -71.07500,
    lat: 42.34866,
    // Long axis parallel to Clarendon St / the Back Bay grid.
    rotation: bearingX(21.5),
    height: 240.8,
    radius: 55,
    tier: 1,
    absorbs: ['john-hancock-tower', '200-clarendon'],
    build: buildHancock,
  },
  {
    slug: 'prudential-tower',
    name: 'Prudential Tower',
    lon: -71.08206,
    lat: 42.34728,
    rotation: bearingX(111.5),
    height: 275.8, // 229 m roof + 47 m mast
    radius: 70,
    tier: 1,
    build: buildPrudential,
  },
  {
    slug: 'one-dalton',
    name: 'One Dalton Street (Four Seasons)',
    lon: -71.08610,
    lat: 42.34710,
    rotation: bearingX(111.5),
    height: 222,
    radius: 34,
    tier: 1,
    build: buildOneDalton,
  },
  {
    slug: 'millennium-tower',
    name: 'Millennium Tower',
    lon: -71.06028,
    lat: 42.35528,
    rotation: bearingX(62),
    height: 208.5,
    radius: 34,
    tier: 1,
    build: buildMillennium,
  },
  {
    slug: 'state-house',
    name: 'Massachusetts State House',
    lon: -71.06361,
    lat: 42.35833,
    // Bulfinch front faces SSE over Boston Common; the facade runs ENE-WSW.
    rotation: bearingX(75),
    height: 47,
    radius: 70,
    tier: 1,
    absorbs: ['massachusetts-state-house'],
    build: buildStateHouse,
  },
  {
    slug: 'zakim-bridge',
    name: 'Leonard P. Zakim Bunker Hill Memorial Bridge',
    lon: -71.06170,
    lat: 42.37000,
    rotation: bearingX(5),
    height: 110,
    radius: 330,
    tier: 1,
    build: buildZakim,
  },
  {
    slug: 'custom-house-tower',
    name: 'Custom House Tower',
    lon: -71.05306,
    lat: 42.35917,
    rotation: bearingX(78),
    height: 151,
    radius: 40,
    tier: 1,
    build: buildCustomHouse,
  },

  /* ------------------------------------------------------------- tier two */
  {
    slug: 'bunker-hill-monument',
    name: 'Bunker Hill Monument',
    lon: -71.06083,
    lat: 42.37639,
    rotation: bearingX(22),
    height: 67,
    radius: 12,
    tier: 2,
    build: buildBunkerHill,
  },
  {
    slug: 'fenway-park',
    name: 'Fenway Park',
    lon: -71.09759,
    lat: 42.34672,
    // Home plate -> centre field bears 38 deg; that axis is the model's +X.
    rotation: bearingX(38),
    height: 40,
    radius: 170,
    tier: 2,
    absorbs: ['green-monster'],
    build: buildFenway,
  },
  {
    slug: 'faneuil-hall',
    name: 'Faneuil Hall & Quincy Market',
    lon: -71.05500,
    lat: 42.36000,
    rotation: bearingX(80),
    height: 38,
    radius: 130,
    tier: 2,
    absorbs: ['quincy-market'],
    build: buildFaneuil,
  },
  {
    slug: 'trinity-church',
    name: 'Trinity Church, Copley Square',
    lon: -71.07472,
    lat: 42.34972,
    // Nave runs W->E; the twin west towers face Copley Square.
    rotation: bearingX(111.5),
    height: 65,
    radius: 50,
    tier: 2,
    build: buildTrinity,
  },
  {
    slug: 'boston-public-library',
    name: 'Boston Public Library, McKim Building',
    lon: -71.07806,
    lat: 42.34917,
    rotation: bearingX(21.5),
    height: 27,
    radius: 60,
    tier: 2,
    build: buildBPL,
  },
  {
    slug: 'old-north-church',
    name: 'Old North Church',
    lon: -71.05444,
    lat: 42.36639,
    rotation: bearingX(350),
    height: 53,
    radius: 22,
    tier: 2,
    build: buildOldNorth,
  },
  {
    slug: 'old-state-house',
    name: 'Old State House',
    lon: -71.05750,
    lat: 42.35861,
    rotation: bearingX(78),
    height: 27,
    radius: 20,
    tier: 2,
    build: buildOldStateHouse,
  },
  {
    slug: 'boston-city-hall',
    name: 'Boston City Hall',
    lon: -71.05778,
    lat: 42.36028,
    rotation: bearingX(60),
    height: 43,
    radius: 90,
    tier: 2,
    build: buildCityHall,
  },
  {
    slug: 'mit-great-dome',
    name: 'MIT Great Dome (Building 10)',
    lon: -71.09206,
    lat: 42.35983,
    rotation: bearingX(75),
    height: 45,
    radius: 100,
    tier: 2,
    build: buildMitDome,
  },
  {
    slug: 'longfellow-bridge',
    name: 'Longfellow Bridge',
    lon: -71.07445,
    lat: 42.36225,
    rotation: bearingX(295),
    height: 30,
    radius: 300,
    tier: 2,
    build: buildLongfellow,
  },
  {
    slug: 'citgo-sign',
    name: 'Citgo Sign, Kenmore Square',
    lon: -71.09556,
    lat: 42.34889,
    // The sign face looks SW toward Kenmore Square and Fenway Park.
    rotation: bearingX(125),
    height: 33,
    radius: 22,
    tier: 2,
    build: buildCitgo,
  },
  {
    slug: 'uss-constitution',
    name: 'USS Constitution & Charlestown Navy Yard',
    lon: CONSTITUTION_LON,
    lat: CONSTITUTION_LAT,
    // Her keel lies along the Pier 1 quay face; +X is the bow, heading NW.
    rotation: bearingX(CONSTITUTION_BEARING),
    height: 67,
    radius: 150,
    tier: 2,
    absorbs: ['charlestown-navy-yard', 'dry-dock-1'],
    build: buildConstitution,
  },

  /* ------------------------------------------------------- Harvard & MIT */
  {
    slug: 'harvard-widener',
    name: 'Widener Library, Harvard Yard',
    lon: -71.116471,
    lat: 42.373476,
    // The great steps and Corinthian colonnade face south across the Yard;
    // local +Z is that facade (see `campus/harvard.ts`).
    rotation: bearingX(103),
    height: 31.5,
    radius: 45,
    tier: 2,
    build: buildWidener,
  },
  {
    slug: 'harvard-memorial-church',
    name: 'Memorial Church, Harvard Yard',
    lon: -71.116060,
    lat: 42.374904,
    rotation: bearingX(103),
    height: 46.5,
    radius: 28,
    tier: 2,
    build: buildMemorialChurch,
  },
  {
    slug: 'harvard-sever-hall',
    name: 'Sever Hall, Harvard Yard',
    lon: -71.115446,
    lat: 42.374333,
    // The great recessed arch faces west, into the Yard.
    rotation: bearingX(193),
    height: 20,
    radius: 32,
    tier: 2,
    build: buildSeverHall,
  },
  {
    slug: 'mit-kresge',
    name: 'Kresge Auditorium, MIT',
    lon: -71.095050,
    lat: 42.358145,
    // Close to 3-fold symmetric; no facade calls for a specific bearing.
    rotation: 0,
    height: 19,
    radius: 26,
    tier: 2,
    build: buildKresge,
  },
  {
    slug: 'mit-stata-center',
    name: 'Ray and Maria Stata Center, MIT',
    lon: -71.090597,
    lat: 42.361671,
    rotation: bearingX(60),
    height: 46,
    radius: 70,
    tier: 2,
    build: buildStataCenter,
  },

  // Northeastern arrives as a prepared array rather than as entries written
  // out here: it was authored while another agent held this file, so it was
  // built to be spread in at one point instead of interleaved.
  ...NEU_LANDMARKS,
];

const BY_SLUG = new Map<string, Landmark>();
for (const l of LANDMARKS) {
  BY_SLUG.set(l.slug, l);
  for (const a of l.absorbs ?? []) BY_SLUG.set(a, l);
}

/** Lookup including the `absorbs` aliases. */
export function findLandmark(slug: string): Landmark | undefined {
  return BY_SLUG.get(slug);
}

/** Every slug that should suppress a generic OSM extrusion. */
export function landmarkSlugs(): string[] {
  return [...BY_SLUG.keys()];
}

const cache = new WeakMap<Ctx, Map<string, THREE.Object3D>>();

/**
 * Build (and memoise per `Ctx`) the mesh for a slug. Returns null for unknown
 * slugs and never throws: a landmark that fails to build must not take the city
 * down with it.
 */
export function buildLandmark(slug: string, ctx: Ctx): THREE.Object3D | null {
  const lm = findLandmark(slug);
  if (!lm) return null;
  let m = cache.get(ctx);
  if (!m) {
    m = new Map();
    cache.set(ctx, m);
  }
  const hit = m.get(lm.slug);
  if (hit) return hit;
  try {
    const obj = lm.build(ctx);
    obj.userData.landmark = lm.slug;
    m.set(lm.slug, obj);
    return obj;
  } catch (err) {
    console.error(`[Landmarks] failed to build "${lm.slug}"`, err);
    return null;
  }
}
