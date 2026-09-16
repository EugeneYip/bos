/**
 * MIT hero buildings beyond the Great Dome: Kresge Auditorium and the Stata
 * Center. (Killian Court's flanking limestone wings are already modelled as
 * part of `buildings/mitDome.ts`'s "Building 10" — not duplicated here.)
 *
 * Real-world anchors (OpenStreetMap ways, surveyed footprints)
 * --------------------------------------------------------------
 *  Kresge Auditorium (W16)  way 24494029  -71.095050, 42.358145
 *  Stata Center (32)         way 27078002  -71.090597, 42.361671
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl } from '../lib/geom';
import { curtainWall } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { rect, type P2 } from '../lib/util';

/* ==========================================================================
 * Kresge Auditorium — Eero Saarinen, 1955.
 * ==========================================================================
 * A thin concrete shell, one-eighth of a sphere, resting on just three
 * points; the free rim between the supports lifts off the ground in a
 * shallow curve, and full-height glass fills the gap. No revolve/lathe
 * primitive can make a 3-fold (rather than fully round) rim, so the shell is
 * built as a bespoke radial grid: constant in radius per ring, but with the
 * rim height modulated by angle so it touches down at exactly three points
 * and arches up between them.
 */
const KR_RADIUS = 23; // shell rim radius
const KR_PIER_H = 3.4; // height of the three ground supports
const KR_RIM_RISE = 8.5; // how far the free rim lifts between supports
// Crown height (pier + dome rise) is pushed a couple of metres above the
// real ~15 m so it still reads as a distinct shell above the generic OSM
// extrusion at this footprint (16.1 m, flat roof) until that footprint is
// suppressed — see the landmark suppression notes in the project report.
const KR_DOME_RISE = 15.6; // additional rise from rim datum to the crown
const KR_SUPPORTS = 3;
// Rotate the whole 3-fold pattern so a support doesn't land on a cardinal
// direction — purely so the glass notches read as deliberate, not aligned.
const KR_PHASE = Math.PI / 6;

function rimWave(theta: number): number {
  return KR_RIM_RISE * 0.5 * (1 - Math.cos(KR_SUPPORTS * (theta - KR_PHASE)));
}

/** The shell itself: a grid of quads, radius constant per ring, height wavy. */
function kresgeShell(segs: number, rings: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = segs + 1;
  const apexStop = (Math.PI / 2) * 0.985;

  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const a = t * apexStop;
    const r0 = KR_RADIUS * Math.cos(a);
    const h0 = KR_DOME_RISE * (Math.sin(a) / Math.sin(apexStop));
    const fade = (1 - t) * (1 - t);
    for (let i = 0; i <= segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const y = KR_PIER_H + h0 + rimWave(theta) * fade;
      const x = Math.sin(theta) * r0;
      const z = Math.cos(theta) * r0;
      pos.push(x, y, z);
      uv.push((i / segs) * 6, t * 3);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a0 = j * cols + i;
      const b0 = j * cols + i + 1;
      const a1 = (j + 1) * cols + i;
      const b1 = (j + 1) * cols + i + 1;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** The glass collar under the free rim, its top edge tracing `rimWave`. */
function kresgeGlassWall(segs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI * 2;
    const t1 = ((i + 1) / segs) * Math.PI * 2;
    const y0 = KR_PIER_H + rimWave(t0);
    const y1 = KR_PIER_H + rimWave(t1);
    const x0 = Math.sin(t0) * KR_RADIUS;
    const z0 = Math.cos(t0) * KR_RADIUS;
    const x1 = Math.sin(t1) * KR_RADIUS;
    const z1 = Math.cos(t1) * KR_RADIUS;
    const base = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z1, x1, y1, z1, x0, y0, z0);
    const nx = Math.sin((t0 + t1) / 2);
    const nz = Math.cos((t0 + t1) / 2);
    for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
    const w = Math.hypot(x1 - x0, z1 - z0);
    uv.push(0, 0, w, 0, w, Math.max(y0, y1), 0, Math.max(y0, y1));
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function buildKresgeMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const concrete = M.surface('concrete', { color: 0xbdb8ac, roughness: 0.72, tile: 4.5 });
  const concreteDark = M.surface('concrete', { color: 0x928d80, roughness: 0.8, tile: 3.0 });
  const glass = M.litGlass(1955, { color: 0x232c30, roughness: 0.15, metalness: 0.2 }, 0.4);

  const segs = detail ? 48 : 20;
  const rings = detail ? 16 : 6;
  b.add(kresgeShell(segs, rings), concrete);
  b.add(kresgeGlassWall(detail ? 48 : 20), glass);

  // Three solid concrete support piers, the only places the shell meets grade.
  for (let s = 0; s < KR_SUPPORTS; s++) {
    const theta = KR_PHASE + (s / KR_SUPPORTS) * Math.PI * 2;
    const x = Math.sin(theta) * KR_RADIUS;
    const z = Math.cos(theta) * KR_RADIUS;
    b.addAt(prism(rect(3.2, 2.4), 0, KR_PIER_H + 0.4, { cap: true }), concreteDark, [x, 0, z], theta);
  }

  // A modest attached lobby wing (glazed, the "little theater" side of the
  // real complex) so the composition isn't a single isolated shell.
  const lobbyW = 20;
  const lobbyD = 12;
  const lobbyH = 6.5;
  const lobbyCx = 0;
  const lobbyCz = KR_RADIUS + lobbyD / 2 - 2;
  b.addAt(prism(rect(lobbyW, lobbyD), 0, 0.6, { cap: false }), concreteDark, [lobbyCx, 0, lobbyCz]);
  if (detail) {
    const cw = curtainWall(rect(lobbyW, lobbyD).map(([x, z]) => [x + lobbyCx, z + lobbyCz] as P2), 0.6, lobbyH, {
      floorHeight: lobbyH - 0.6,
      paneWidth: 2.2,
      seed: 1956,
    });
    b.add(cw.glass, glass);
  } else {
    b.addAt(box(lobbyW, lobbyH - 0.6, lobbyD), glass, [lobbyCx, 0.6, lobbyCz]);
  }
  b.addAt(box(lobbyW + 0.6, 0.4, lobbyD + 0.6), concreteDark, [lobbyCx, lobbyH, lobbyCz]);

  return b.build('mit-kresge');
}

export function buildKresge(ctx: Ctx): THREE.Object3D {
  return makeLOD('mit-kresge', [
    { object: buildKresgeMesh(ctx, true), distance: 0 },
    { object: buildKresgeMesh(ctx, false), distance: 650 },
  ]);
}

/* ==========================================================================
 * Stata Center (Ray and Maria Stata Center, Building 32) — Frank Gehry, 2004.
 * ==========================================================================
 * Deconstructivist: a jumble of tilting, mismatched volumes in brick and
 * brushed metal that look almost accidental. Per the brief, this does not
 * attempt to reproduce every fold — it composes a handful of simple leaning
 * masses (rectangular prisms, a drum-with-cone) in contrasting cladding, and
 * leans them at real angles, which is where the recognisable silhouette
 * actually lives.
 */
interface LeanVol {
  /** Footprint, centred on its own local origin. */
  footprint: P2;
  height: number;
  /** World-ish placement before the whole assembly's own registry rotation. */
  pos: [number, number];
  /** Lean about the horizontal axes, radians (small angles — this is a lean, not a fall). */
  tiltX: number;
  tiltZ: number;
  rotY: number;
  material: 'brick' | 'brickDark' | 'metal' | 'metalWarm';
  topScale?: number; // taper, 1 = none
}

function buildStataMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const mats = {
    brick: M.surface('brick', { color: 0xa8482c, roughness: 0.88, tile: 2.1 }),
    brickDark: M.surface('brick', { color: 0x7d3b26, roughness: 0.9, tile: 1.8 }),
    metal: M.surface('metal', { color: 0xc2c6c8, roughness: 0.4, metalness: 0.75, tile: 2.4 }),
    metalWarm: M.surface('metal', { color: 0xa8967a, roughness: 0.45, metalness: 0.6, tile: 2.2 }),
  } as const;
  const glass = M.litGlass(2004, { color: 0x1c2226, roughness: 0.18, metalness: 0.3 }, 0.5);

  const vols: LeanVol[] = [
    // Tall canted brick tower — the tallest single mass, leans east. Given a
    // few extra metres over the real ~40 m so it still clears the generic OSM
    // extrusion at this footprint (43.1 m, uniform height) until suppressed —
    // see the landmark suppression notes in the project report.
    { footprint: [13, 12], height: 46, pos: [-30, 6], tiltX: 0, tiltZ: -0.09, rotY: 0.12, material: 'brick' },
    // Metal mid-rise, leaning the other way, canted top via topScale.
    { footprint: [15, 11], height: 28, pos: [7, -20], tiltX: 0.07, tiltZ: 0.02, rotY: -0.2, material: 'metal', topScale: 0.82 },
    // Wide low brick mass along the street frontage, holding the ground plane.
    { footprint: [36, 15], height: 13, pos: [-4, 30], tiltX: 0.015, tiltZ: -0.01, rotY: 0.05, material: 'brickDark' },
    // Prow-like wedge jutting from the cluster, tapered and leaning hard.
    { footprint: [17, 9], height: 30, pos: [-10, -32], tiltX: -0.1, tiltZ: 0.05, rotY: 0.35, material: 'metalWarm', topScale: 0.6 },
    // Small bright accent box tucked between the larger volumes.
    { footprint: [9, 9], height: 17, pos: [-11, -6], tiltX: 0.05, tiltZ: 0.08, rotY: -0.4, material: 'metal' },
    // Second brick volume knitting the tower to the street block.
    { footprint: [14, 10], height: 20, pos: [-18, 14], tiltX: -0.03, tiltZ: 0.02, rotY: -0.15, material: 'brick' },
  ];

  for (const v of vols) {
    const footprint = rect(v.footprint[0], v.footprint[1]);
    const geo = prism(footprint, 0, v.height, { cap: true, topScale: v.topScale ?? 1 });
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.tiltX, v.rotY, v.tiltZ, 'XYZ'));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(v.pos[0], 0, v.pos[1]), q, new THREE.Vector3(1, 1, 1));
    b.add(geo, mats[v.material], m);

    if (detail) {
      // A band of curtain glass part-way up each volume — Gehry's brick
      // masses are cut through with strip windows, not punched openings.
      const bandY0 = v.height * 0.32;
      const bandY1 = v.height * 0.62;
      const cw = curtainWall(footprint, bandY0, bandY1, { floorHeight: (bandY1 - bandY0) / 2, paneWidth: 2.0, seed: 700 + vols.indexOf(v) });
      b.add(cw.glass, glass, m);
    }
  }

  // Cylindrical drum with a tilted conical cap — evocative of the building's
  // rounded, cone-topped corner volume.
  const drumR = 7.6;
  const drumH = 21;
  const drumPos = new THREE.Vector3(26, 0, -4);
  const drumQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.02, 0.3, -0.06, 'XYZ'));
  const drumM = new THREE.Matrix4().compose(drumPos, drumQ, new THREE.Vector3(1, 1, 1));
  b.add(cyl(drumR, drumR, drumH, detail ? 24 : 12), mats.brick, drumM);
  const coneGeo = new THREE.ConeGeometry(drumR + 0.6, 8.5, detail ? 24 : 12);
  coneGeo.translate(0, drumH + 4.25, 0);
  const coneM = new THREE.Matrix4().compose(drumPos, drumQ, new THREE.Vector3(1, 1, 1));
  b.add(coneGeo, mats.metal, coneM);

  return b.build('mit-stata-center');
}

export function buildStataCenter(ctx: Ctx): THREE.Object3D {
  return makeLOD('mit-stata-center', [
    { object: buildStataMesh(ctx, true), distance: 0 },
    { object: buildStataMesh(ctx, false), distance: 750 },
  ]);
}
