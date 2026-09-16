/**
 * Shared placement data for the Northeastern University campus core — Snell
 * Library, Churchill Hall, Richards Hall and the Centennial Common quad
 * between them — plus Matthews Arena, built as a second, separate landmark
 * far to the north-east on Saint Botolph Street.
 *
 * The quad trio shares one anchor and is built into a single `Group` (see
 * `campusCore.ts`), so the registry places it once with `rotation: 0` and
 * every local coordinate below is already a true-world-aligned metre offset
 * (+X east, +Z south — see `lib/util.ts`). Matthews Arena is far enough away
 * (~950 m) that it gets its own anchor and rotation instead.
 *
 * Numbers are derived from the real OSM footprints baked into
 * `public/data/buildings-01.json` (ids noted per constant below), reduced to
 * a minimum-area oriented bounding box so the hand-built volumes land on the
 * real buildings' position, size and orientation rather than a guess.
 */
import * as THREE from 'three';
import { bearingX } from '../../lib/util';
import { mergeAll } from '../../lib/geom';
import { setAtlasUV } from '../../lib/curtainwall';

/**
 * Quad anchor: centre of Centennial Common, world (-1854, 1733) per the
 * brief — confirmed to sit in the real gap between Snell Library (south) and
 * Richards Hall (north) once the actual footprints were pulled from OSM.
 */
export const NEU_ANCHOR_LON = -71.088003;
export const NEU_ANCHOR_LAT = 42.339799;

/**
 * Campus-grid bearing family read directly off the real footprints: Churchill
 * Hall (w29618540, 48.1 x 19.4 m), Snell Engineering Center (w88147650) and
 * the Cabot PE Center (w29572600) all share a long axis at 60.4/240.4 deg.
 * Richards Hall (w29942264, 60.8 x 37.0 m) runs the cross way, 330.4/150.4.
 * Snell Library's own footprint (w29566437) is a rounded, near-square blob;
 * it borrows the same family for visual harmony with its neighbours.
 */
export const GRID_A = 60.4;
export const GRID_B = 330.4;
export const ROT_A = bearingX(GRID_A);
export const ROT_B = bearingX(GRID_B);

/** Local centres, metres from `NEU_ANCHOR_*` (+X east, +Z south). */
export const SNELL_LOCAL: [number, number] = [3, 153];
export const CHURCHILL_LOCAL: [number, number] = [-74, 114];
export const RICHARDS_LOCAL: [number, number] = [-69, -8];

/** Matthews Arena, 238 St. Botolph Street — its own landmark, own anchor. */
export const MATTHEWS_LON = -71.08444;
export const MATTHEWS_LAT = 42.34111;
/** Saint Botolph Street's own run, read off its centreline in roads-01.json. */
export const MATTHEWS_BEARING = 42;
export const ROT_MATTHEWS = bearingX(MATTHEWS_BEARING);

/**
 * `windowOpening()` (curtainwall.ts) builds a recessed reveal, which is the
 * architecturally correct look for a masonry punched opening — but every
 * wall in this file (like every wall in the existing `buildings/*.ts` that
 * use the same helper, e.g. `stateHouse.ts`, `customHouse.ts`) is a single
 * solid, unbroken `prism()` face with no actual hole cut in it. A recess set
 * behind an unbroken opaque wall is invisible from outside: verified by
 * rendering `stateHouse.ts` in isolation, whose brick mass shows no windows
 * at all up close (see the task report). Campus buildings are seen from a
 * few tens of metres, where that reads as a bug, not a stylistic choice.
 *
 * `simpleWindow` is an applied-window unit instead: a projecting trim ring
 * (four thin strips, so there is genuinely no material over the opening)
 * plus a glass pane sitting proud of the wall face. Nothing occludes it.
 * Same positional signature as `windowOpening` (w, h, proud, paneIndex) so
 * call sites read the same; `arch` is accepted but unused (no fanlight).
 */
export interface SimpleWindowResult {
  /** Projecting trim ring — bind the trim/stone material. */
  reveal: THREE.BufferGeometry;
  /** Glass pane — bind a `litGlass` material. */
  glass: THREE.BufferGeometry;
}

export function simpleWindow(
  w: number,
  h: number,
  proud: number,
  paneIndex: number,
  _arch = 0,
  trim = 0.16,
): SimpleWindowResult {
  // `proud` inherits call sites written for windowOpening's recess `depth`
  // (up to ~0.6 m), which reads as a slab floating off the wall once it
  // means "projects outward" instead. Clamp to a real trim/sill projection.
  const frameProud = Math.max(0.03, Math.min(proud, 0.14));
  const glassProud = Math.max(0.015, Math.min(proud * 0.3, 0.05));

  const t = 0.1;
  const parts: THREE.BufferGeometry[] = [];
  const strip = (bw: number, bh: number, bx: number, by: number): void => {
    const g = new THREE.BoxGeometry(bw, bh, t);
    g.translate(bx, by, frameProud + t / 2);
    parts.push(g);
  };
  strip(w + trim * 2, trim, 0, (h + trim) / 2);
  strip(w + trim * 2, trim, 0, -(h + trim) / 2);
  strip(trim, h, (w + trim) / 2, 0);
  strip(trim, h, -(w + trim) / 2, 0);
  const reveal = mergeAll(parts)!;
  // Both boxes above are built centred on the opening's own centre; shift
  // by h/2 so the caller's y is the SILL (matching windowOpening's y:[0,h]
  // convention) rather than the vertical centre.
  reveal.translate(0, h / 2, 0);

  const glass = new THREE.BoxGeometry(w, h, 0.05);
  glass.translate(0, h / 2, glassProud);
  setAtlasUV(glass, paneIndex);

  return { reveal, glass };
}
