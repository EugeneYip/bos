/**
 * Harvard Yard hero buildings: Widener Library, Memorial Church, Sever Hall.
 *
 * Real-world anchors (OpenStreetMap ways, surveyed footprints)
 * --------------------------------------------------------------
 *  Widener Library        way 29725638  -71.116471, 42.373476
 *  Memorial Church        way 29789985  -71.116060, 42.374904
 *  Sever Hall              way 29530656  -71.115446, 42.374333
 *
 * Harvard Yard's paths and Tercentenary Theatre are rotated about 13 deg east
 * of true north (measured off the surveyed footprints above, cross-checked
 * three ways), which is why none of these buildings sit "square" to the
 * compass. Each is authored here in its own local frame with its principal
 * public facade facing local +Z; `registry.ts` supplies the real-world
 * bearing for that axis via `bearingX`.
 *
 * Each `build*` export is a `THREE.LOD` (see `lib/lod.ts`): full ornament up
 * close, a simplified mass at distance.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, column, cornice, gableRoof } from '../lib/geom';
import { windowOpening } from '../lib/curtainwall';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { rect } from '../lib/util';

/* ==========================================================================
 * Widener Library — Horace Trumbauer (design partner Julian Abele), 1915.
 * ==========================================================================
 * The building most people mean when they say "Harvard Yard": a wide flight
 * of granite steps rising to a giant Corinthian colonnade, Indiana limestone,
 * a plain balustraded attic (no pediment — the roofline is flat). A taller,
 * plainer stack tower stands behind the entrance block.
 */
const WID_W = 74; // facade width, local X
const WID_D = 58; // depth of the main block, local Z
const WID_BASE_H = 6.6; // rusticated ground storey / colonnade podium
const WID_MAIN_H = 19.0; // top of the main storey
const WID_CORNICE_H = 22.4; // parapet/balustrade top
const WID_PORT_W = 34; // portico width
const WID_PORT_PROJ = 8.5; // how far the portico steps forward of the face
const WID_COL_H = 12.8;
const WID_COL_DIA = 1.55;
const WID_STEPS = 15;
const WID_TOWER_W = 28;
const WID_TOWER_D = 19;
const WID_TOWER_H = 31.5;

function buildWidenerMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const limestone = M.surface('stone', { color: 0xc7bfa7, roughness: 0.76, tile: 3.2 });
  const limeLight = M.surface('stone', { color: 0xd6cfb8, roughness: 0.7, tile: 2.6 });
  const rusticated = M.surface('granite', { color: 0xb7ae95, roughness: 0.82, tile: 1.9 });
  const glass = M.litGlass(1915, { color: 0x232a2f, roughness: 0.2, metalness: 0.12 }, 0.45);
  const bronze = M.surface('copper', { color: 0x6b5f43, roughness: 0.55, metalness: 0.55 });
  const step = M.surface('granite', { color: 0xa39a83, roughness: 0.75, tile: 1.4 });

  const halfW = WID_W / 2;
  const halfD = WID_D / 2;

  /* --------------------------------------------------------- the main mass */
  b.add(prism(rect(WID_W, WID_D), 0, WID_BASE_H, { cap: false }), rusticated);
  b.add(prism(rect(WID_W, WID_D), WID_BASE_H, WID_MAIN_H, { cap: false }), limestone);
  b.addAt(cornice(WID_W + 1.6, 1.2, 1.0, 2), limeLight, [0, WID_MAIN_H - 0.4, 0]);
  b.add(prism(rect(WID_W, WID_D), WID_MAIN_H, WID_CORNICE_H, { cap: true }), limestone);
  b.addAt(cornice(WID_W + 2.2, 1.8, 1.6, 3), limeLight, [0, WID_CORNICE_H - 1.6, 0]);

  // Balustraded parapet along the front and sides.
  if (detail) {
    for (const side of [1, -1]) {
      b.addAt(box(WID_W + 1.4, 0.28, 0.5), limeLight, [0, WID_CORNICE_H + 0.5, side * (halfD + 0.5)]);
      const n = 22;
      for (let i = 0; i <= n; i++) {
        const x = -halfW - 0.5 + (i / n) * (WID_W + 1);
        if (Math.abs(x) < WID_PORT_W / 2 + 1) continue; // gap over the portico attic
        b.addAt(
          revolve([[0.18, 0], [0.13, 0.2], [0.22, 0.5], [0.12, 0.82], [0.16, 1.05]], 7),
          limeLight,
          [x, WID_CORNICE_H + 0.14, side * (halfD + 0.5)],
        );
      }
    }
  } else {
    b.addAt(box(WID_W + 1.4, 0.9, 0.5), limeLight, [0, WID_CORNICE_H + 0.45, halfD + 0.5]);
  }

  /* --------------------------------------------------- rear stack tower */
  // Set back from the entrance front, rising well above the main cornice —
  // the massing real readers of the building recognise from off-axis views.
  b.addAt(
    prism(rect(WID_TOWER_W, WID_TOWER_D), WID_CORNICE_H, WID_TOWER_H, { cap: true }),
    limestone,
    [0, 0, -(halfD - WID_TOWER_D / 2 - 3)],
  );
  b.addAt(cornice(WID_TOWER_W + 1.2, 1.2, 1.1, 2), limeLight, [0, WID_TOWER_H - 1.1, -(halfD - WID_TOWER_D / 2 - 3)]);

  /* ------------------------------------------------------- the great steps */
  // A broad flight rising the full height of the rusticated podium, planted
  // in front of the portico projection.
  const stepRise = WID_BASE_H / WID_STEPS;
  const stepRun = 1.05;
  for (let s = 0; s < WID_STEPS; s++) {
    const w = WID_PORT_W + 10 - s * 0.25;
    b.addAt(box(w, stepRise, stepRun), step, [
      0,
      s * stepRise,
      halfD + WID_PORT_PROJ + WID_STEPS * stepRun * 0.5 - s * stepRun,
    ]);
  }

  /* ------------------------------------------------------------- portico */
  const pz = halfD; // plane of the main face
  // Solid podium the columns stand on, projecting forward of the face.
  b.addAt(prism(rect(WID_PORT_W, WID_PORT_PROJ * 2), 0, WID_BASE_H, { cap: true }), rusticated, [0, 0, WID_PORT_PROJ]);
  const colZ = pz + WID_PORT_PROJ - 1.4;
  const cols = 12;
  for (let i = 0; i < cols; i++) {
    const x = -WID_PORT_W / 2 + 2.2 + (i / (cols - 1)) * (WID_PORT_W - 4.4);
    b.addAt(column(WID_COL_H, WID_COL_DIA, 'corinthian', detail ? 14 : 7), limeLight, [x, WID_BASE_H, colZ]);
  }
  const entabY = WID_BASE_H + WID_COL_H;
  b.addAt(cornice(WID_PORT_W + 2.2, 2.4, 1.7, 3), limeLight, [0, entabY, colZ - 1.1]);
  // Plain projecting attic above the entablature, flush with the parapet.
  b.addAt(
    prism(rect(WID_PORT_W + 1.2, WID_PORT_PROJ * 2 - 1.6), entabY + 1.7, WID_CORNICE_H, { cap: true }),
    limestone,
    [0, 0, WID_PORT_PROJ - 0.2],
  );
  // Shallow dedication panel beneath the attic.
  b.addAt(box(WID_PORT_W * 0.55, 1.3, 0.18), limeLight, [0, entabY + 3.1, colZ + 1.35]);

  // Recessed wall behind the colonnade: three bronze doors and tall windows.
  if (detail) {
    for (const dx of [-4.6, 0, 4.6]) {
      b.addAt(box(2.6, 4.6, 0.3), bronze, [dx, 0.4, pz - 0.15]);
    }
    b.addAt(box(WID_PORT_W - 3, 0.8, 0.9), limeLight, [0, 4.85, pz - 0.1]);
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 4.6;
      if (Math.abs(x) < 2.4) continue;
      addWindow(b, limestone, glass, x, 6.0, pz, 1.7, 6.4, 0, 0.9);
    }
  }

  /* --------------------------------------------------------- wing windows */
  const wingSpan = (WID_W - WID_PORT_W) / 2 - 3;
  for (const sx of [-1, 1]) {
    const cx = sx * (WID_PORT_W / 2 + 3 + wingSpan / 2);
    const bays = 6;
    for (let i = 0; i < bays; i++) {
      const x = cx - wingSpan / 2 + ((i + 0.5) / bays) * wingSpan;
      addWindow(b, rusticated, glass, x, 2.7, pz, 2.1, 3.5, 0, 1.05);
      if (detail) {
        addWindow(b, limestone, glass, x, WID_BASE_H + 2.4, pz, 1.7, 6.0, 0);
        addWindow(b, limestone, glass, x, WID_MAIN_H + 1.7, pz, 1.5, 2.1, 0);
      }
    }
  }
  // Side elevations, a handful of bays so oblique views read as a building.
  if (detail) {
    for (const side of [1, -1]) {
      for (let i = 0; i < 5; i++) {
        const z = -halfD + ((i + 0.5) / 5) * WID_D;
        addWindow(b, limestone, glass, side * halfW, WID_BASE_H + 2.4, z, 1.7, 5.6, (side * Math.PI) / 2);
        addWindow(b, limestone, glass, side * halfW, WID_MAIN_H + 1.7, z, 1.5, 2.1, (side * Math.PI) / 2);
      }
    }
  }

  return b.build('harvard-widener');
}

export function buildWidener(ctx: Ctx): THREE.Object3D {
  return makeLOD('harvard-widener', [
    { object: buildWidenerMesh(ctx, true), distance: 0 },
    { object: buildWidenerMesh(ctx, false), distance: 550 },
  ]);
}

/* ==========================================================================
 * Memorial Church — Coolidge Shepley Bulfinch & Abbott, 1932.
 * ==========================================================================
 * Modelled in the Christopher Wren / James Gibbs tradition (kin to Old North
 * and Park Street Church): red brick nave, white-painted wooden steeple in
 * diminishing stages over a south-facing portico. The spire is the point —
 * it has to clear Widener's roofline by a wide margin.
 */
const MC_NAVE_W = 44; // local X
const MC_TOWER = 8.2; // square tower footprint, at the +Z (south) end
const MC_NAVE_LEN = 15; // nave depth north of the tower, local Z
const MC_EAVE = 11.5;
const MC_RIDGE_RISE = 5.6;
const MC_TOWER_TOP = 20.5; // brick/stone stops, white timber begins
const MC_SPIRE_TIP = 46.5;

function buildMemorialChurchMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0x9a4d38, roughness: 0.9, tile: 2.2 });
  const white = M.surface('paint', { color: 0xf3f0e6, roughness: 0.5, tile: 2.4 });
  const slate = M.surface('slate', { color: 0x4c4f56, roughness: 0.7, tile: 1.7 });
  const gold = M.gold({ roughness: 0.3 });
  const glass = M.litGlass(1932, { color: 0x222a30, roughness: 0.22, metalness: 0.1 }, 0.5);

  // The tower sits at the south (+Z, portico-facing) end, spanning z=[0,TOWER];
  // the nave is the main body, butted directly against its north face.
  const naveCz = -MC_NAVE_LEN / 2;

  /* --------------------------------------------------------------- nave */
  b.addAt(prism(rect(MC_NAVE_W, MC_NAVE_LEN), 0, MC_EAVE, { cap: false }), brick, [0, 0, naveCz]);
  b.addAt(gableRoof(MC_NAVE_W, MC_NAVE_LEN, MC_RIDGE_RISE), slate, [0, MC_EAVE, naveCz]);

  if (detail) {
    const bays = 4;
    for (let i = 0; i < bays; i++) {
      const z = -MC_NAVE_LEN + ((i + 0.5) / bays) * MC_NAVE_LEN;
      for (const side of [-1, 1]) {
        addWindow(b, brick, glass, side * (MC_NAVE_W / 2), 5.2, z, 1.7, 5.2, (side * Math.PI) / 2, 0.85);
      }
    }
    // North gable end, facing away from the theatre.
    addWindow(b, brick, glass, 0, 5.6, -MC_NAVE_LEN, 2.4, 6.6, Math.PI, 1.1);
  }

  /* --------------------------------------------------- tower + portico */
  b.addAt(prism(rect(MC_TOWER, MC_TOWER), 0, MC_TOWER_TOP, { cap: false }), brick, [0, 0, MC_TOWER / 2]);
  // Corner pilasters in white stone, the Georgian give-away.
  if (detail) {
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      b.addAt(box(0.9, MC_TOWER_TOP, 0.9), white, [
        sx * (MC_TOWER / 2 - 0.3),
        0,
        MC_TOWER / 2 + sz * (MC_TOWER / 2 - 0.3),
      ]);
    }
  }
  // Pedimented portico at the south face.
  const portZ = MC_TOWER + 2.6;
  const portH = 9.2;
  for (const dx of [-3.6, -1.3, 1.3, 3.6]) {
    b.addAt(column(portH, 0.72, 'doric', detail ? 10 : 6), white, [dx, 0, portZ]);
  }
  b.addAt(box(9.6, 0.9, 3.2), white, [0, portH, portZ - 1.2]);
  // Low pediment.
  const pedGeo = gableRoof(3.4, 9.8, 1.5);
  b.addAt(pedGeo, white, [0, portH + 0.9, portZ - 1.2]);
  if (detail) {
    b.addAt(box(2.6, 5.2, 0.3), glass, [0, 1.2, MC_TOWER + 0.1]);
    const archGeo = revolve([[0, 0], [1.4, 0], [1.4, 0.2], [0, 0.2]], 12, Math.PI);
    archGeo.rotateX(-Math.PI / 2);
    archGeo.rotateY(Math.PI);
    archGeo.translate(0, 3.8, MC_TOWER + 0.1);
    b.add(archGeo, white);
  }

  /* --------------------------------------------------- white timber steeple */
  // Stage 1: clock stage.
  const s1w = MC_TOWER * 0.82;
  const s1Y = MC_TOWER_TOP;
  const s1H = 6.2;
  b.addAt(prism(rect(s1w, s1w), 0, s1H, { cap: false }), white, [0, s1Y, MC_TOWER / 2]);
  if (detail) {
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      b.addAt(cyl(0.85, 0.85, 0.12, 16), white, [
        sx * (s1w / 2 + 0.06),
        s1Y + s1H / 2,
        MC_TOWER / 2 + sz * (s1w / 2 + 0.06),
      ], Math.PI / 2);
    }
  }
  b.addAt(cornice(s1w + 1.2, 1.2, 0.7, 2), white, [0, s1Y + s1H, MC_TOWER / 2]);

  // Stage 2: an open colonnaded lantern — the grander move Memorial Church
  // makes that Old North's plain belfry doesn't.
  const s2Y = s1Y + s1H + 0.7;
  const s2R = s1w * 0.56;
  const s2H = 5.6;
  b.addAt(cyl(s2R + 0.3, s2R + 0.3, 0.5, detail ? 16 : 8), white, [0, s2Y, MC_TOWER / 2]);
  if (detail) {
    const ringCols = 8;
    for (let i = 0; i < ringCols; i++) {
      const a = (i / ringCols) * Math.PI * 2;
      b.addAt(column(s2H, 0.42, 'ionic', 8), white, [
        Math.sin(a) * s2R,
        s2Y + 0.5,
        MC_TOWER / 2 + Math.cos(a) * s2R,
      ]);
    }
  } else {
    b.addAt(cyl(s2R * 0.7, s2R * 0.7, s2H, 10), white, [0, s2Y + 0.5, MC_TOWER / 2]);
  }
  b.addAt(cyl(s2R + 0.35, s2R + 0.1, 0.6, detail ? 16 : 8), white, [0, s2Y + 0.5 + s2H, MC_TOWER / 2]);

  // Stage 3: octagonal drum, then the tapering spire.
  const s3Y = s2Y + 0.5 + s2H + 0.6;
  const s3H = 3.4;
  b.addAt(cyl(s2R * 0.62, s2R * 0.5, s3H, 8), white, [0, s3Y, MC_TOWER / 2], Math.PI / 8);
  const spireY = s3Y + s3H;
  const spireH = MC_SPIRE_TIP - spireY - 1.1;
  b.addAt(cyl(s2R * 0.5, 0.14, spireH, 8), white, [0, spireY, MC_TOWER / 2], Math.PI / 8);

  // Ball finial.
  const tipY = spireY + spireH;
  b.addAt(revolve([[0, 0], [0.3, 0.3], [0, 0.6]], 12), gold, [0, tipY, MC_TOWER / 2]);
  b.addAt(cyl(0.05, 0.02, 1.0, 6), gold, [0, tipY + 0.6, MC_TOWER / 2]);

  return b.build('harvard-memorial-church');
}

export function buildMemorialChurch(ctx: Ctx): THREE.Object3D {
  return makeLOD('harvard-memorial-church', [
    { object: buildMemorialChurchMesh(ctx, true), distance: 0 },
    { object: buildMemorialChurchMesh(ctx, false), distance: 700 },
  ]);
}

/* ==========================================================================
 * Sever Hall — Henry Hobson Richardson, 1880.
 * ==========================================================================
 * All brick, no stone trim at all — Richardson's point. The building is a
 * long, plain Georgian-scaled mass whose only real event is a single
 * enormous, deeply recessed brick archway at the centre of the west
 * (theatre-facing) elevation, plus a corbelled brick cornice and a couple of
 * boldly corbelled chimney stacks.
 */
const SV_LEN = 58; // local X, long axis
const SV_DEP = 24; // local Z
const SV_EAVE = 13.2;
const SV_RIDGE = 6.4;
const SV_ARCH_W = 7.6;
const SV_ARCH_H = 8.6;
const SV_ARCH_DEPTH = 3.4;

function buildSeverMesh(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0xa4502f, roughness: 0.92, tile: 2.0 });
  const brickDark = M.surface('brick', { color: 0x853f28, roughness: 0.94, tile: 1.6 });
  const slate = M.surface('slate', { color: 0x453f45, roughness: 0.72, tile: 1.8 });
  const glass = M.litGlass(1880, { color: 0x252220, roughness: 0.25, metalness: 0.08 }, 0.5);

  const halfL = SV_LEN / 2;
  const halfD = SV_DEP / 2;

  /* --------------------------------------------------------------- mass */
  b.add(prism(rect(SV_LEN, SV_DEP), 0, SV_EAVE, { cap: false }), brick);
  // Corbelled brick cornice — three stepped courses reading as one band.
  b.addAt(cornice(SV_LEN + 1.0, 1.0, 1.1, 4), brickDark, [0, SV_EAVE - 1.1, 0]);
  b.addAt(gableRoof(SV_LEN, SV_DEP, SV_RIDGE, SV_DEP * 0.28), slate, [0, SV_EAVE, 0]);

  // A corbel-table frieze of small blind arches just under the eave — the
  // single most Richardsonian detail available on this budget.
  if (detail) {
    const n = 30;
    for (let i = 0; i < n; i++) {
      const x = -halfL + ((i + 0.5) / n) * SV_LEN;
      for (const side of [1, -1]) {
        const arch = revolve([[0, 0], [0.55, 0], [0.55, 0.12], [0, 0.12]], 6, Math.PI);
        arch.rotateX(-Math.PI / 2);
        arch.rotateY(side > 0 ? 0 : Math.PI);
        arch.translate(x, SV_EAVE - 1.7, side * (halfD + 0.02));
        b.add(arch, brickDark);
      }
    }
  }

  /* -------------------------------------------------- chimneys / turrets */
  for (const dx of [-halfL + 6, halfL - 6]) {
    b.addAt(prism(rect(2.6, 1.8), SV_EAVE - 0.5, SV_EAVE + 5.5, { cap: true }), brickDark, [dx, 0, halfD - 3]);
    b.addAt(cornice(3.0, 0.9, 0.6, 2), brickDark, [dx, SV_EAVE + 5.0, halfD - 3]);
  }

  /* ------------------------------------------------- the great archway */
  // Deeply recessed round arch, centred on the west (theatre-facing) wall:
  // an extruded arch-shaped frame around the opening (a true hole, not a
  // solid box), deep enough to read as a real Richardsonian tunnel-arch, with
  // an arch-shaped glazed door at the back of the tunnel.
  const archFaceZ = halfD; // build on +Z, matching this file's "front is +Z" convention
  const archSeg = detail ? 20 : 10;
  if (detail) {
    const glassShape = new THREE.Shape();
    glassShape.moveTo(-SV_ARCH_W / 2, 0);
    glassShape.lineTo(SV_ARCH_W / 2, 0);
    for (let i = 0; i <= archSeg; i++) {
      const t = i / archSeg;
      const a = Math.PI * t;
      glassShape.lineTo(Math.cos(a) * (SV_ARCH_W / 2), SV_ARCH_H + Math.sin(a) * (SV_ARCH_W / 2));
    }
    glassShape.closePath();
    const glassGeo = new THREE.ExtrudeGeometry(glassShape, { depth: 0.1, bevelEnabled: false, curveSegments: archSeg });
    glassGeo.translate(0, 0, archFaceZ - SV_ARCH_DEPTH);
    b.add(glassGeo, glass);
  }
  // Wound counter-clockwise (outer boundary right-to-up-to-left, inner
  // boundary left-to-up-to-right) so the extrusion's outward faces end up
  // facing +Z — a clockwise path here produced a frame that only rendered
  // when viewed from inside the building.
  const archShape = new THREE.Shape();
  archShape.moveTo(SV_ARCH_W / 2 + 0.4, 0);
  archShape.lineTo(SV_ARCH_W / 2 + 0.4, SV_ARCH_H);
  for (let i = 0; i <= archSeg; i++) {
    const t = i / archSeg;
    const a = Math.PI * t;
    archShape.lineTo(Math.cos(a) * (SV_ARCH_W / 2 + 0.4), SV_ARCH_H + Math.sin(a) * (SV_ARCH_W / 2 + 0.4));
  }
  archShape.lineTo(-SV_ARCH_W / 2 - 0.4, 0);
  archShape.lineTo(-SV_ARCH_W / 2, 0);
  for (let i = archSeg; i >= 0; i--) {
    const t = i / archSeg;
    const a = Math.PI * t;
    archShape.lineTo(Math.cos(a) * (SV_ARCH_W / 2), SV_ARCH_H + Math.sin(a) * (SV_ARCH_W / 2));
  }
  archShape.lineTo(SV_ARCH_W / 2, 0);
  archShape.closePath();
  const archFrame = new THREE.ExtrudeGeometry(archShape, { depth: SV_ARCH_DEPTH, bevelEnabled: false, curveSegments: detail ? 16 : 8 });
  archFrame.translate(0, 0, archFaceZ - SV_ARCH_DEPTH);
  b.add(archFrame, brickDark);

  /* --------------------------------------------------------------- windows */
  if (detail) {
    const bays = 9;
    for (let i = 0; i < bays; i++) {
      const x = -halfL + ((i + 0.5) / bays) * SV_LEN;
      if (Math.abs(x) < SV_ARCH_W / 2 + 2.2) continue;
      addWindow(b, brick, glass, x, 2.6, halfD, 1.6, 3.0, 0, 0.35);
      addWindow(b, brick, glass, x, 6.6, halfD, 1.5, 2.7, 0, 0.35);
      addWindow(b, brick, glass, x, 10.3, halfD, 1.4, 2.3, 0, 0.3);
    }
    // Rear (east) elevation, plainer.
    for (let i = 0; i < bays; i++) {
      const x = -halfL + ((i + 0.5) / bays) * SV_LEN;
      addWindow(b, brick, glass, x, 2.6, -halfD, 1.6, 3.0, Math.PI, 0.35);
      addWindow(b, brick, glass, x, 6.6, -halfD, 1.5, 2.7, Math.PI, 0.35);
    }
  }

  return b.build('harvard-sever-hall');
}

export function buildSeverHall(ctx: Ctx): THREE.Object3D {
  return makeLOD('harvard-sever-hall', [
    { object: buildSeverMesh(ctx, true), distance: 0 },
    { object: buildSeverMesh(ctx, false), distance: 550 },
  ]);
}

/* ---------------------------------------------------------------- shared */

let paneIdx = 40000; // disjoint from other buildings' window-atlas indices

/** Place a punched window on a wall facing +Z (before the `rotY` yaw). */
function addWindow(
  b: Builder,
  wall: THREE.Material,
  glass: THREE.Material,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  rotY: number,
  arch = 0,
): void {
  const o = windowOpening(w, h, 0.4, paneIdx++, arch);
  b.addAt(o.reveal, wall, [x, y, z], rotY);
  b.addAt(o.glass, glass, [x, y, z], rotY);
}
