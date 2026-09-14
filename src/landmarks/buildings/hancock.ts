/**
 * 200 Clarendon Street — the John Hancock Tower.
 * I. M. Pei & Partners, Henry N. Cobb, 1976.
 *
 * Real-world dimensions used
 * --------------------------
 *  roof height        790 ft  = 240.8 m   (tallest building in New England)
 *  floors             60
 *  floor-to-floor     ~12 ft  = 3.66 m    (matches the 11'6" pane height)
 *  plan               rhomboid, long sides 290 ft = 88.4 m,
 *                     short sides 100 ft = 30.5 m across,
 *                     ends raked ~30 deg off perpendicular
 *  glass              10,344 panes at 4'6" x 11'6" = 1.372 x 3.505 m
 *  long-axis bearing  ~21.5 deg (parallel to Clarendon St / the Back Bay grid)
 *
 * The three things that make this building recognisable, in order:
 *   1. the *rhomboid* plan — the ends are raked, so from the Charles the tower
 *      is a parallelogram, not a box, and the corners are razor sharp;
 *   2. the deep vertical V-notch cut into each narrow end, which splits each
 *      end into two thin blades and is the strongest shadow line on the tower;
 *   3. a completely flush minimalist skin — no spandrels, no projecting
 *      mullions, no crown. Just 60 storeys of blue mirror.
 *
 * Everything else about it is deliberately nothing, so getting 1-3 right is the
 * whole job.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, strut, cyl } from '../lib/geom';
import { curtainWall } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, type P2 } from '../lib/util';

const HEIGHT = ft(790); // 240.8 m to the roof slab
const BASE_H = 6.4; // recessed lobby storey
const PARAPET = 1.3;
const LONG = ft(290); // 88.4 m
const WIDTH = ft(100); // 30.5 m across the narrow ends
const SKEW = 8.85; // half the end-rake offset -> ends raked 30 deg off perpendicular
const NOTCH_HALF = 5.6; // the notch mouth is 11.2 m wide
const NOTCH_DEPTH = 7.4; // cut 7.4 m into a 30.5 m end
const FLOOR = 3.66; // 12 ft
const PANE_W = 1.372; // 4 ft 6 in

/**
 * The rhomboid plan, counter-clockwise, centred on the origin with the long
 * axis on local +X. Ten vertices: four parallelogram corners plus a three-point
 * V at the midpoint of each raked end.
 */
export function hancockPlan(inset = 0): P2[] {
  const L = LONG - inset * 2;
  const W = WIDTH - inset * 2;
  const P0: P2 = [-L / 2 + SKEW, -W / 2];
  const P1: P2 = [L / 2 + SKEW, -W / 2];
  const P2_: P2 = [L / 2 - SKEW, W / 2];
  const P3: P2 = [-L / 2 - SKEW, W / 2];

  const end = (a: P2, b: P2): P2[] => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    // Outward normal of a CCW ring.
    const nx = uz;
    const nz = -ux;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    const d = NOTCH_DEPTH - inset * 0.4;
    return [
      [mx - ux * NOTCH_HALF, mz - uz * NOTCH_HALF],
      [mx - nx * d, mz - nz * d],
      [mx + ux * NOTCH_HALF, mz + uz * NOTCH_HALF],
    ];
  };

  return [P0, P1, ...end(P1, P2_), P2_, P3, ...end(P3, P0)];
}

interface Level {
  paneW: number;
  floor: number;
  detail: boolean;
}

function buildTower(ctx: Ctx, lvl: Level): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();

  const plan = hancockPlan();
  const lobbyPlan = hancockPlan(1.1);

  // Mirror glass. Coated reflective glass is ~25-30% reflective at normal
  // incidence, so a partial metalness rather than full chrome; the blue is the
  // coating tint, not the body of the glass.
  const glass = M.litGlass(
    900,
    { color: 0x3f6285, roughness: 0.045, metalness: 0.74, envMapIntensity: 1.45 },
    0.42,
  );
  glass.userData.nightPeak = 0.75;
  // The mullion plane behind the glass: near-black anodised aluminium.
  const frame = M.surface('darkmetal', { color: 0x1a2430, roughness: 0.5, metalness: 0.7 });
  const granite = M.surface('granite', { color: 0x6e6b67, roughness: 0.8, tile: 2.4 });

  // --- structural plane -----------------------------------------------------
  b.add(prism(plan, BASE_H, HEIGHT, { cap: true }), frame);

  // --- recessed lobby -------------------------------------------------------
  b.add(prism(lobbyPlan, 0.45, BASE_H, { cap: false }), frame);
  b.add(prism(plan, 0, 0.45, { cap: true }), granite);
  {
    // Dark lobby glazing, set back behind the tower's own face.
    const lobby = curtainWall(lobbyPlan, 1.0, BASE_H - 0.5, {
      floorHeight: BASE_H - 1.5,
      paneWidth: 2.4,
      proud: 0.05,
      gap: 0.09,
      seed: 901,
    });
    b.add(lobby.glass, M.litGlass(901, { color: 0x1b2b3a, roughness: 0.12, metalness: 0.5 }, 0.8));
  }

  // --- the skin -------------------------------------------------------------
  const cw = curtainWall(plan, BASE_H, HEIGHT - 1.2, {
    floorHeight: lvl.floor,
    paneWidth: lvl.paneW,
    proud: 0.055,
    gap: lvl.detail ? 0.05 : 0.02,
    seed: 900,
  });
  b.add(cw.glass, glass);

  // --- roof -----------------------------------------------------------------
  b.add(prism(hancockPlan(0.0), HEIGHT - 1.2, HEIGHT, { cap: true }), frame);
  b.add(prism(hancockPlan(0.9), HEIGHT, HEIGHT + PARAPET, { cap: true }), frame);
  if (lvl.detail) {
    // Mechanical penthouse + the window-washing track rail, both well inboard
    // so the razor roofline stays clean.
    b.addAt(box(26, 3.4, 12), frame, [4, HEIGHT + 0.2, 0]);
    b.addAt(box(9, 1.9, 7), frame, [-22, HEIGHT + 0.2, 1]);
    const rail = M.surface('metal', { color: 0x9aa2a8, roughness: 0.45 });
    for (const sx of [-1, 1]) {
      b.add(
        strut(
          new THREE.Vector3(sx * 30, HEIGHT + PARAPET + 0.5, -4.5),
          new THREE.Vector3(sx * 30, HEIGHT + PARAPET + 0.5, 4.5),
          0.12,
          6,
        ),
        rail,
      );
    }
    // Aviation masts.
    for (const sx of [-1, 1]) {
      b.addAt(cyl(0.22, 0.1, 7.5, 8), rail, [sx * 34, HEIGHT + PARAPET, 0]);
    }
  }
  // Red aviation beacons — tiny, but they read at night.
  const beacon = M.emissive(0xff2a1a, 2.4);
  for (const sx of [-1, 1]) {
    b.addAt(new THREE.SphereGeometry(0.5, 8, 6), beacon, [sx * 34, HEIGHT + PARAPET + 7.8, 0]);
  }

  return b.build('hancock');
}

/** Far LOD: the silhouette and one flat mirror, nothing else. */
function buildFar(ctx: Ctx): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const plan = hancockPlan();
  const glass = M.litGlass(
    902,
    { color: 0x40638a, roughness: 0.07, metalness: 0.76, envMapIntensity: 1.4 },
    0.42,
  );
  glass.userData.nightPeak = 0.6;
  b.add(prism(plan, 0, HEIGHT, { cap: true, floor: false }), glass);
  b.add(prism(hancockPlan(0.9), HEIGHT, HEIGHT + PARAPET, { cap: true }), M.surface('darkmetal', { color: 0x1a2430, roughness: 0.5, metalness: 0.7 }));
  return b.build('hancock-far');
}

export function buildHancock(ctx: Ctx): THREE.Object3D {
  return makeLOD('hancock', [
    { object: buildTower(ctx, { paneW: PANE_W, floor: FLOOR, detail: true }), distance: 0 },
    { object: buildTower(ctx, { paneW: PANE_W * 3, floor: FLOOR * 2, detail: false }), distance: 820 },
    { object: buildFar(ctx), distance: 3200 },
  ]);
}

export const HANCOCK_HEIGHT = HEIGHT;
