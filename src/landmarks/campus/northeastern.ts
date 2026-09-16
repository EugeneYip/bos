/**
 * Northeastern University — Centennial Common core (Snell Library, Churchill
 * Hall, Richards Hall and the quad between them) plus Matthews Arena.
 *
 * This file is NOT wired into `registry.ts` yet (that file is owned by
 * another agent). It exports `NEU_LANDMARKS`, a self-contained array shaped
 * exactly like `Landmark[]`, ready to be spread into `LANDMARKS` there:
 *
 *   import { NEU_LANDMARKS } from './campus/northeastern';
 *   export const LANDMARKS: Landmark[] = [ ...existing, ...NEU_LANDMARKS ];
 *
 * See `neu/common.ts` for how the anchors and bearings were derived from the
 * real OSM footprints, and the top of this file's git history / the task
 * report for which OSM slugs need suppressing in `tools/lib/landmarks.mjs`.
 */
import type { Landmark } from '../registry';
import { NEU_ANCHOR_LON, NEU_ANCHOR_LAT, MATTHEWS_LON, MATTHEWS_LAT, ROT_MATTHEWS } from './neu/common';
import { buildNeuCampusCore } from './neu/campusCore';
import { buildMatthewsArena } from './neu/matthewsArena';

export const NEU_LANDMARKS: Landmark[] = [
  {
    slug: 'neu-snell-library',
    name: 'Snell Library, Churchill Hall & Richards Hall (Centennial Common)',
    lon: NEU_ANCHOR_LON,
    lat: NEU_ANCHOR_LAT,
    // Local space is already true-world-aligned; each sub-building carries
    // its own real bearing internally (see campusCore.ts).
    rotation: 0,
    height: 24,
    radius: 130,
    tier: 2,
    absorbs: ['neu-churchill-hall', 'neu-richards-hall'],
    build: buildNeuCampusCore,
  },
  {
    slug: 'neu-matthews-arena',
    name: 'Matthews Arena',
    lon: MATTHEWS_LON,
    lat: MATTHEWS_LAT,
    rotation: ROT_MATTHEWS,
    height: 20,
    radius: 65,
    tier: 2,
    build: buildMatthewsArena,
  },
];

// Re-exported in case the wiring agent prefers manual entries (as
// campus/harvard.ts and campus/mit.ts are wired) over spreading the array.
export { buildNeuCampusCore, buildMatthewsArena };
export { NEU_ANCHOR_LON, NEU_ANCHOR_LAT, MATTHEWS_LON, MATTHEWS_LAT, ROT_MATTHEWS };
export const NEU_QUAD_ROTATION = 0;
