/**
 * Boston Air Traffic Control Tower, Logan International Airport.
 * Kallmann & McKinnell (the Boston City Hall practice), completed 1973.
 *
 * Real-world dimensions used
 * --------------------------
 *  height      86.87 m (285 ft) to the tip, 27 levels  — OSM `w197731405`
 *  footprint   a 36.4 x 11.1 m stadium/capsule, long axis on bearing 31 deg,
 *              centroid at world (3878.67, -1150.01)  — same OSM way
 *  fabric      board-formed structural concrete, 1970s Boston brutalism
 *
 * Provenance: every number above was read out of the shipped
 * `public/data/buildings-04.json` record, not recalled. The capsule plan comes
 * from a PCA of that record's 33-vertex outline: length 36.36 m along a
 * 31 deg / 211 deg axis, constant 11.06 m width between two semicircular caps.
 *
 * Why this exists at all: `Buildings` extruded that whole capsule straight up
 * 86.87 m, which reads as an anonymous concrete slab. The tower's actual
 * silhouette is a low base, a long slender shaft, and a glazed cab that flares
 * out past the shaft at the top — so the shaft has to be *narrower* than the
 * footprint, which only a hand-authored mesh plus footprint suppression can do.
 *
 * The cab and mast were previously added on top of the extrusion by
 * `world/airport/gates.ts#buildControlTowerCab`, which could reach the top but
 * could not fix the shaft. This model owns the whole tower now; that additive
 * cab has been removed, or the cab would be drawn twice.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, loft, box, cyl } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ccw, lerp, regularPolygon, type P2 } from '../lib/util';

/* --------------------------------------------------------------- dimensions */

/** OSM footprint, from a capsule fit to the 33-vertex outline of w197731405. */
const PLAN_LEN = 36.36;
const PLAN_WID = 11.06;

const H = 86.87; // total, to the mast tip — the OSM height for the way

const BASE1_TOP = 8.6; // full-footprint base building
const BASE2_TOP = 11.6; // stepped-in second stage the shaft springs from
const SHAFT_TOP = 70.6;
const NECK_TOP = 75.0; // equipment floor under the cab
const GALLERY_TOP = 76.1; // cab floor slab + catwalk, the saucer's rim
const CAB_TOP = 82.3;
const ROOF_TOP = 83.6;

/** Cab glazing is canted outward as it rises, so the roof is the widest part. */
const CAB_R0 = 8.3;
const CAB_R1 = 9.5;
const ROOF_R = 9.9;
const GALLERY_R = 10.4;

const SHAFT_LEN0 = 16.4;
const SHAFT_WID0 = 10.0;
const SHAFT_LEN1 = 12.6;
const SHAFT_WID1 = 8.6;

/** Pour-lift belt courses up the shaft. */
const BELTS = [22, 34, 46, 58];

/**
 * A stadium (capsule) plan: two semicircular caps of radius `wid/2` joined by
 * straight flanks. `seg` segments per cap, wound CCW and free of duplicate
 * vertices so `loft` rings line up and `capGeometry` triangulates cleanly.
 */
function stadium(len: number, wid: number, seg = 8): P2[] {
  const r = wid / 2;
  const a = Math.max(0, len / 2 - r);
  const out: P2[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = -Math.PI / 2 + (i / seg) * Math.PI;
    out.push([a + Math.cos(t) * r, Math.sin(t) * r]);
  }
  for (let i = 0; i <= seg; i++) {
    const t = Math.PI / 2 + (i / seg) * Math.PI;
    out.push([-a + Math.cos(t) * r, Math.sin(t) * r]);
  }
  return ccw(out);
}

/** Shaft plan at height `y`, linearly battered between its two end sections. */
function shaftPlan(y: number, seg: number, grow = 0): P2[] {
  const t = (y - BASE2_TOP) / (SHAFT_TOP - BASE2_TOP);
  return stadium(
    lerp(SHAFT_LEN0, SHAFT_LEN1, t) + grow * 2,
    lerp(SHAFT_WID0, SHAFT_WID1, t) + grow * 2,
    seg,
  );
}

/* ------------------------------------------------------------------- model */

function buildTower(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const seg = detail ? 8 : 4;
  const cabSeg = 12;

  const concrete = M.surface('concrete', { color: 0xa8a49b, roughness: 0.88, tile: 2.8, normalScale: 1.0 });
  const concreteDark = M.surface('concrete', { color: 0x8e8a82, roughness: 0.9, tile: 2.4, normalScale: 1.1 });
  const apron = M.surface('concrete', { color: 0x9b9c9e, roughness: 0.94, tile: 5.0 });
  const trim = M.surface('paint', { color: 0xe7eaee, roughness: 0.42, metalness: 0.18 });
  const steel = M.surface('darkmetal', { color: 0x585e64, roughness: 0.48, metalness: 0.72 });
  const slotGlass = M.litGlass(1973, { color: 0x1b242b, roughness: 0.16, metalness: 0.3 }, 0.35);

  // The cab glazing is opaque from outside, so an interior light source would
  // never be seen. Instead the glass itself carries a dim, uniform warm glow
  // that fades up after dusk — which is also what a real cab looks like from
  // the ground, since controllers work in near-darkness and the only light is
  // console backwash. `registerNightLit` hands it to the same day/night drive
  // (and the same envMap refresh) as the library's own emissives.
  const cabGlass = new THREE.MeshStandardMaterial({
    name: 'landmark:atc-cab-glass',
    color: 0x18242d,
    roughness: 0.09,
    metalness: 0.55,
    envMapIntensity: 1.2,
    emissive: new THREE.Color(0xffc489),
    emissiveIntensity: 0,
  });
  // Kept very low on purpose: a uniform emissive over the whole glazing band
  // is far more surface than the window atlases the other landmarks use, and at
  // the peak the library's own windows run at it turns the cab into a
  // lighthouse lantern.
  cabGlass.userData.nightPeak = 0.035;
  M.registerNightLit(cabGlass);

  // Obstruction lights. Night-compensated rather than a constant emissive: the
  // sky lifts exposure roughly 4x after dark, so a level that reads as a
  // saturated red bead in daylight clips to white at night — which is the one
  // thing an obstruction light must never look like. `updateNight` cancels that
  // exposure lift, and the dark-red body keeps the lens reading as a red
  // fixture while the sun is up.
  const obstruction = new THREE.MeshStandardMaterial({
    name: 'landmark:atc-obstruction',
    color: 0x8e1c14,
    roughness: 0.38,
    metalness: 0,
    emissive: new THREE.Color(0xff2a1a),
    emissiveIntensity: 0,
  });
  obstruction.userData.nightPeak = 2.4;
  M.registerNightLit(obstruction);

  /* ---- apron slab and base building ------------------------------------ */

  // Deliberately a tight collar rather than a generous forecourt: the tower
  // stands among the terminal footprints, and a wide slab proud of grade would
  // push through their ground floors.
  b.add(prism(stadium(PLAN_LEN + 3.0, PLAN_WID + 3.0, seg), -0.9, 0.12, { cap: true }), apron);

  const base1 = stadium(PLAN_LEN, PLAN_WID, seg);
  b.add(prism(base1, 0, BASE1_TOP, { cap: true }), concrete);
  // Parapet, then the stepped-in second stage.
  b.add(prism(stadium(PLAN_LEN - 3.4, PLAN_WID - 3.4, seg), BASE1_TOP, BASE2_TOP, { cap: true }), concreteDark);

  /* ---- shaft ----------------------------------------------------------- */

  const rings: { pts: P2[]; y: number }[] = [];
  const steps = detail ? 5 : 2;
  for (let i = 0; i <= steps; i++) {
    const y = lerp(BASE2_TOP, SHAFT_TOP, i / steps);
    rings.push({ pts: shaftPlan(y, seg), y });
  }
  b.add(loft(rings, { cap: false }), concrete);

  if (detail) {
    // Board-formed concrete pours read as belt courses; they also break up
    // 59 m of otherwise blank wall with a real shadow line.
    for (const y of BELTS) {
      b.add(loft(
        [
          { pts: shaftPlan(y, seg, 0.34), y },
          { pts: shaftPlan(y + 0.52, seg, 0.34), y: y + 0.52 },
        ],
        { cap: true, floor: true },
      ), concreteDark);
    }

    // The lift/stair core, expressed as a glazed slot up both flanks.
    for (const side of [-1, 1] as const) {
      const wSlot = 1.5;
      const n = 9;
      for (let i = 0; i < n; i++) {
        const y0 = lerp(BASE2_TOP + 1.6, SHAFT_TOP - 2.2, i / n);
        const y1 = lerp(BASE2_TOP + 1.6, SHAFT_TOP - 2.2, (i + 0.72) / n);
        const y = (y0 + y1) / 2;
        const halfW = lerp(SHAFT_WID0, SHAFT_WID1, (y - BASE2_TOP) / (SHAFT_TOP - BASE2_TOP)) / 2;
        b.addAt(box(wSlot, y1 - y0, 0.22), slotGlass, [0, y0, side * (halfW + 0.02)]);
      }
    }

    // Slot windows round the base building, at both storeys.
    for (const y of [2.6, 5.8]) {
      for (let i = 0; i < 14; i++) {
        const t = i / 14;
        const a = t * Math.PI * 2;
        const x = Math.cos(a) * (PLAN_LEN / 2 - PLAN_WID / 2);
        const z = Math.sin(a) * (PLAN_WID / 2 + 0.02);
        b.addAt(box(1.7, 1.9, 0.2), slotGlass, [x, y, z]);
      }
    }
  }

  /* ---- neck, gallery, cab ---------------------------------------------- */

  // Equipment floor: wider than the shaft, still well inside the cab.
  b.add(prism(shaftPlan(SHAFT_TOP, seg, 0.9), SHAFT_TOP, NECK_TOP, { cap: false, floor: true }), concreteDark);

  const galleryRing = regularPolygon(cabSeg, GALLERY_R, Math.PI / cabSeg);
  b.add(prism(galleryRing, GALLERY_TOP - 0.62, GALLERY_TOP, { cap: true, floor: true }), concrete);
  // Chamfered soffit under the overhang, so the saucer's rim has thickness.
  b.add(loft(
    [
      { pts: regularPolygon(cabSeg, CAB_R0 - 0.6, Math.PI / cabSeg), y: NECK_TOP },
      { pts: galleryRing, y: GALLERY_TOP - 0.62 },
    ],
    { cap: false },
  ), concreteDark);

  // Glazing, canted outward as it rises.
  b.add(loft(
    [
      { pts: regularPolygon(cabSeg, CAB_R0, Math.PI / cabSeg), y: GALLERY_TOP },
      { pts: regularPolygon(cabSeg, CAB_R1, Math.PI / cabSeg), y: CAB_TOP },
    ],
    { cap: false },
  ), cabGlass);

  // Roof slab with a fascia that oversails the glass.
  b.add(prism(regularPolygon(cabSeg, ROOF_R, Math.PI / cabSeg), CAB_TOP, ROOF_TOP, { cap: true, floor: true }), trim);

  if (detail) {
    // Mullions between the panes, leaning with the glass.
    for (let i = 0; i < cabSeg; i++) {
      const a = (i / cabSeg) * Math.PI * 2;
      const dy = CAB_TOP - GALLERY_TOP;
      const dr = CAB_R1 - CAB_R0;
      const len = Math.hypot(dy, dr);
      const g = box(0.34, len, 0.3);
      // rotateX(t) sends local +Y to (0, cos t, sin t), so a *positive* angle
      // leans the mullion outward with the glass. Negated, it tips inward and
      // vanishes behind the pane it is supposed to cap.
      g.rotateX(Math.atan2(dr, dy));
      g.translate(0, GALLERY_TOP, CAB_R0 + 0.16);
      g.rotateY(a);
      b.add(g, trim);
    }
    // Catwalk railing round the gallery.
    b.add(loft(
      [
        { pts: regularPolygon(cabSeg, GALLERY_R - 0.12, Math.PI / cabSeg), y: GALLERY_TOP },
        { pts: regularPolygon(cabSeg, GALLERY_R - 0.12, Math.PI / cabSeg), y: GALLERY_TOP + 1.1 },
      ],
      { cap: false },
    ), steel);
  }

  /* ---- mast and obstruction lighting ----------------------------------- */

  b.addAt(cyl(0.62, 0.34, H - ROOF_TOP, detail ? 10 : 6), trim, [0, ROOF_TOP, 0]);
  if (detail) {
    // Two whip antennae and the radar-repeater stub on the roof. Kept under
    // `H`, so the mast tip stays the highest point and the model's silhouette
    // still tops out at the 86.87 m the OSM record states.
    b.addAt(cyl(0.1, 0.06, 2.8, 5), steel, [3.9, ROOF_TOP, 2.1]);
    b.addAt(cyl(0.1, 0.06, 2.2, 5), steel, [-4.3, ROOF_TOP, -1.6]);
    b.addAt(cyl(0.9, 0.7, 1.3, 8), steel, [0, ROOF_TOP, 5.6]);
  }

  // Steady-burning red obstruction lights: mast tip, roof rim and mid-shaft,
  // on the extremities of the long axis so at least one is always in
  // silhouette. Sized like the Zakim's tower beacons (~1 m lenses) rather than
  // to the real fixture, which would be sub-pixel from anywhere in the city.
  const lens = new THREE.SphereGeometry(0.5, 8, 6);
  b.addAt(lens.clone(), obstruction, [0, H - 0.4, 0]);
  const midY = 44;
  const midHalfLen = lerp(SHAFT_LEN0, SHAFT_LEN1, (midY - BASE2_TOP) / (SHAFT_TOP - BASE2_TOP)) / 2;
  for (const side of [-1, 1] as const) {
    b.addAt(lens.clone(), obstruction, [side * (ROOF_R - 0.5), ROOF_TOP + 0.3, 0]);
    b.addAt(lens.clone(), obstruction, [side * (midHalfLen + 0.15), midY, 0]);
  }
  lens.dispose();

  const g = b.build('boston-atc-tower');
  g.userData.triangles = b.triangles;
  return g;
}

export function buildAtcTower(ctx: Ctx): THREE.Object3D {
  return makeLOD('boston-atc-tower', [
    { object: buildTower(ctx, true), distance: 0 },
    { object: buildTower(ctx, false), distance: 1600 },
  ]);
}
