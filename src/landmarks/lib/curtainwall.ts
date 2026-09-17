/**
 * Curtain wall and window generation.
 *
 * Two treatments, because Boston has two kinds of landmark:
 *
 *  - `curtainWall()` — modern glass towers. Individual pane quads sitting a few
 *    centimetres proud of a dark mullion plane. Close up you see real glass
 *    depth and pane-to-pane reflection breakup; at 2 km the panes collapse into
 *    a coherent mirror.
 *  - `windowOpening()` — masonry buildings. A recessed reveal plus a glass pane,
 *    so brick facades get genuine shadow in the openings.
 *
 * Both tag their glass with a UV that points at exactly one texel of the window
 * light atlas (see `textures.windowLightAtlas`), which is bound as the
 * `emissiveMap`. That is what gives every window its own brightness and lets
 * ~45% of them be dark at night.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { P2 } from './util';
import { WINDOW_ATLAS_SIZE, hash01 } from './atlas';

export interface CurtainWallOpts {
  /** Floor-to-floor height, metres. */
  floorHeight: number;
  /** Nominal pane width, metres. Edges are divided into a whole number of panes. */
  paneWidth: number;
  /** How far the glass sits proud of the structural face. */
  proud?: number;
  /** Gap between panes (the mullion line), metres. */
  gap?: number;
  /** Vertical fraction of each floor that is vision glass (rest is spandrel). */
  visionFraction?: number;
  /** Seed for the per-pane atlas assignment. */
  seed?: number;
  /** Skip edges whose index is in this set (e.g. a notch treated separately). */
  skipEdges?: Set<number>;
  /** Uniformly scale the footprint at `y1` relative to `y0` (tapered towers). */
  topScale?: number;
}

export interface CurtainWallResult {
  /** Vision-glass panes; bind a `litGlass` material. */
  glass: THREE.BufferGeometry;
  /** Spandrel panels between floors; bind a dark opaque material. */
  spandrel: THREE.BufferGeometry | null;
  paneCount: number;
}

/**
 * Wrap a polygonal footprint in glass between y0 and y1.
 *
 * The mullion plane itself is *not* generated here — callers draw the tower
 * body with `prism()` in a dark material and this sits on top of it.
 */
export function curtainWall(
  footprint: P2[],
  y0: number,
  y1: number,
  opts: CurtainWallOpts,
): CurtainWallResult {
  const proud = opts.proud ?? 0.05;
  const gap = opts.gap ?? 0.06;
  const vision = opts.visionFraction ?? 1;
  const seed = opts.seed ?? 1;
  const fh = opts.floorHeight;
  const floors = Math.max(1, Math.round((y1 - y0) / fh));
  const step = (y1 - y0) / floors;
  const topScale = opts.topScale ?? 1;

  const glassPos: number[] = [];
  const glassNor: number[] = [];
  const glassUv: number[] = [];
  const glassIdx: number[] = [];
  const spanPos: number[] = [];
  const spanNor: number[] = [];
  const spanUv: number[] = [];
  const spanIdx: number[] = [];
  let pane = 0;

  const n = footprint.length;
  for (let e = 0; e < n; e++) {
    if (opts.skipEdges?.has(e)) continue;
    const a = footprint[e];
    const b = footprint[(e + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 0.4) continue;
    const ux = ex / len;
    const uz = ez / len;
    // Outward normal of a CCW ring in X/Z.
    const nx = uz;
    const nz = -ux;
    const cols = Math.max(1, Math.round(len / opts.paneWidth));
    const cw = len / cols;

    for (let f = 0; f < floors; f++) {
      const yB = y0 + f * step;
      const yT = yB + step;
      const s0 = 1 + (topScale - 1) * ((yB - y0) / (y1 - y0 || 1));
      const s1 = 1 + (topScale - 1) * ((yT - y0) / (y1 - y0 || 1));
      // Vision glass occupies the upper `vision` fraction of the floor.
      const vy0 = yB + step * (1 - vision) + gap * 0.5;
      const vy1 = yT - gap * 0.5;
      const sv0 = 1 + (topScale - 1) * ((vy0 - y0) / (y1 - y0 || 1));
      const sv1 = 1 + (topScale - 1) * ((vy1 - y0) / (y1 - y0 || 1));

      for (let c = 0; c < cols; c++) {
        const t0 = c * cw + gap * 0.5;
        const t1 = (c + 1) * cw - gap * 0.5;
        const x0 = a[0] + ux * t0;
        const z0 = a[1] + uz * t0;
        const x1 = a[0] + ux * t1;
        const z1 = a[1] + uz * t1;
        // Atlas texel for this pane.
        const h = hash01(pane * 2654435761 + seed * 40503);
        const ti = Math.floor(h * WINDOW_ATLAS_SIZE * WINDOW_ATLAS_SIZE);
        const au = ((ti % WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;
        const av = (Math.floor(ti / WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;

        const base = glassPos.length / 3;
        pushPane(glassPos, glassNor, glassUv, glassIdx, base,
          x0, z0, x1, z1, vy0, vy1, sv0, sv1, nx, nz, proud, au, av, false,
          hash01(pane * 374761393 + seed * 668265263));
        pane++;

        if (vision < 0.999) {
          const sb = spanPos.length / 3;
          const spanTop = vy0 - gap * 0.5;
          pushPane(spanPos, spanNor, spanUv, spanIdx, sb,
            x0, z0, x1, z1, yB, spanTop, s0, s1, nx, nz, proud * 0.55, 0, 0, true);
        }
      }
    }
  }

  const glass = toGeometry(glassPos, glassNor, glassUv, glassIdx);
  const spandrel = spanPos.length ? toGeometry(spanPos, spanNor, spanUv, spanIdx) : null;
  return { glass, spandrel, paneCount: pane };
}

/**
 * Peak deviation of a pane's normal from its wall plane, radians.
 *
 * A curtain-wall pane is a sheet of glass a few metres across held at its
 * edges, and it is never flat: it bows under its own weight, under the
 * pressure difference across it and under the temperature difference between
 * its faces, so each one reflects in a slightly different direction. That is
 * where a glass tower's quilted look comes from, and it is the only thing
 * that gives the Hancock a visible window rhythm at a kilometre and a half —
 * every pane shares one UV (the emissive atlas needs a single texel per pane)
 * and the Builder strips every attribute but position, normal and uv, so the
 * normal is the only channel a per-pane signal can travel down.
 *
 * 0.6 degrees. Real bowing is a few millimetres over a 1.5 m half-span, which
 * is about this; more than a degree and a facade reads as dented rather than
 * as glass.
 */
const PANE_BOW = 0.024;

function pushPane(
  pos: number[], nor: number[], uv: number[], idx: number[], base: number,
  x0: number, z0: number, x1: number, z1: number,
  yB: number, yT: number, sB: number, sT: number,
  nx: number, nz: number, proud: number,
  au: number, av: number, metricUv = false, bow = 0,
): void {
  const ox = nx * proud;
  const oz = nz * proud;
  pos.push(
    x0 * sB + ox, yB, z0 * sB + oz,
    x1 * sB + ox, yB, z1 * sB + oz,
    x1 * sT + ox, yT, z1 * sT + oz,
    x0 * sT + ox, yT, z0 * sT + oz,
  );
  // Yaw about the wall's own up axis, pitch about its tangent. Two decorrelated
  // angles out of one hash: the second is the fractional part after a prime
  // stretch, which is a cheap independent draw from the same number.
  const yaw = (bow - 0.5) * 2 * PANE_BOW;
  const pitch = ((bow * 61.0) % 1 - 0.5) * 2 * PANE_BOW;
  // Wall tangent is the normal turned a quarter turn in the XZ plane.
  let pnx = nx - nz * yaw;
  let pnz = nz + nx * yaw;
  const pny = pitch;
  const pl = Math.hypot(pnx, pny, pnz) || 1;
  pnx /= pl;
  pnz /= pl;
  for (let k = 0; k < 4; k++) nor.push(pnx, pny / pl, pnz);
  if (metricUv) {
    const w = Math.hypot(x1 - x0, z1 - z0);
    uv.push(0, yB, w, yB, w, yT, 0, yT);
  } else {
    uv.push(au, av, au, av, au, av, au, av);
  }
  // CCW front face for a quad wound bottom-left, bottom-right, top-right, top-left.
  idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

function toGeometry(pos: number[], nor: number[], uv: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export interface Bay {
  /** Position of the bay boundary on the footprint. */
  x: number;
  z: number;
  /** Outward unit normal of the edge this boundary sits on. */
  nx: number;
  nz: number;
  /** Rotation about +Y that aims a local +Z face along the outward normal. */
  rotY: number;
  /** Index of the edge. */
  edge: number;
  /** True for the first/last boundary of an edge (i.e. a building corner). */
  corner: boolean;
  /** Width of the bay starting here, metres (0 at the trailing corner). */
  width: number;
}

/**
 * Bay boundaries around a footprint, using exactly the same division
 * `curtainWall` uses. Lets pilasters, piers and mullions land on pane joints
 * instead of floating between them.
 */
export function edgeBays(footprint: P2[], paneWidth: number, skipEdges?: Set<number>): Bay[] {
  const out: Bay[] = [];
  const n = footprint.length;
  for (let e = 0; e < n; e++) {
    if (skipEdges?.has(e)) continue;
    const a = footprint[e];
    const b = footprint[(e + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.4) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    const nx = uz;
    const nz = -ux;
    const rotY = Math.atan2(nx, nz);
    const cols = Math.max(1, Math.round(len / paneWidth));
    const cw = len / cols;
    for (let c = 0; c <= cols; c++) {
      out.push({
        x: a[0] + ux * c * cw,
        z: a[1] + uz * c * cw,
        nx,
        nz,
        rotY,
        edge: e,
        corner: c === 0 || c === cols,
        width: c === cols ? 0 : cw,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------- masonry openings */

export interface OpeningResult {
  /** Jamb/head/sill reveal surfaces — bind the wall material. */
  reveal: THREE.BufferGeometry;
  /** The glazing plane — bind a lit-glass material. */
  glass: THREE.BufferGeometry;
}

/**
 * A punched masonry opening in a wall that faces +Z, centred on the origin,
 * wall face at z = 0, glass set back by `depth`.
 *
 * `arch` > 0 turns the head into a semicircular arch of that rise (Trinity
 * Church, the BPL's Renaissance arcade, Faneuil Hall).
 */
export function windowOpening(
  w: number,
  h: number,
  depth: number,
  paneIndex: number,
  arch = 0,
  archSeg = 7,
): OpeningResult {
  const hw = w / 2;
  const parts: THREE.BufferGeometry[] = [];

  // Head profile: flat, or a semicircle of `arch` rise.
  const head: P2[] = [];
  if (arch > 0) {
    for (let i = 0; i <= archSeg; i++) {
      const t = i / archSeg;
      const a = Math.PI * (1 - t);
      head.push([Math.cos(a) * hw, h + Math.sin(a) * arch]);
    }
  } else {
    head.push([-hw, h], [hw, h]);
  }

  // Reveal: a band of quads from the wall face back to the glass plane, run
  // around sill -> jamb -> head -> jamb.
  const ring: P2[] = [[-hw, 0], [hw, 0], ...head.slice().reverse()];
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-5) continue;
    // Normal pointing into the opening (the reveal faces the glass).
    const nX = -dy / len;
    const nY = dx / len;
    const b = pos.length / 3;
    pos.push(p[0], p[1], 0, q[0], q[1], 0, q[0], q[1], -depth, p[0], p[1], -depth);
    for (let k = 0; k < 4; k++) nor.push(nX, nY, 0);
    uv.push(u, 0, u + len, 0, u + len, depth, u, depth);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    u += len;
  }
  parts.push(toGeometry(pos, nor, uv, idx));
  const reveal = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;

  // Glass plane at the back of the reveal.
  const gpos: number[] = [];
  const gnor: number[] = [];
  const guv: number[] = [];
  const gidx: number[] = [];
  const ti = Math.floor(hash01(paneIndex * 2246822519 + 7717) * WINDOW_ATLAS_SIZE * WINDOW_ATLAS_SIZE);
  const au = ((ti % WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;
  const av = (Math.floor(ti / WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;
  const poly: P2[] = [[-hw, 0], [hw, 0], ...head.slice().reverse()];
  // Fan-triangulate about the first vertex; every opening shape here is convex.
  for (const p of poly) {
    gpos.push(p[0], p[1], -depth);
    gnor.push(0, 0, 1);
    guv.push(au, av);
  }
  for (let i = 1; i < poly.length - 1; i++) gidx.push(0, i, i + 1);
  const glass = toGeometry(gpos, gnor, guv, gidx);

  return { reveal, glass };
}

/**
 * Overwrite a geometry's UVs so the whole thing samples one atlas texel.
 * Used for bespoke glazing (the Prudential's Skywalk band, Fenway's press box).
 */
export function setAtlasUV(geo: THREE.BufferGeometry, index: number): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const ti = Math.floor(hash01(index * 1597334677 + 31) * WINDOW_ATLAS_SIZE * WINDOW_ATLAS_SIZE);
  const au = ((ti % WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;
  const av = (Math.floor(ti / WINDOW_ATLAS_SIZE) + 0.5) / WINDOW_ATLAS_SIZE;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uv[i * 2] = au;
    uv[i * 2 + 1] = av;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
