/**
 * Old North Church (Christ Church in the City of Boston), 193 Salem St.
 * William Price, 1723 — the oldest surviving church building in Boston.
 *
 * Real-world dimensions used
 * --------------------------
 *  nave        70 x 51 ft = 21.3 x 15.5 m, brick, two storeys of arched windows
 *  steeple     175 ft = 53.3 m to the tip of the weathervane
 *  tower       ~24 ft = 7.3 m square brick base rising to the belfry
 *  spire       white-painted wood, three diminishing octagonal stages
 *
 * "One if by land, two if by sea" — the two lanterns were hung in this steeple
 * on 18 April 1775. The steeple is the whole silhouette; the nave is incidental.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, gableRoof, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect, regularPolygon, type P2 } from '../lib/util';

const NAVE_W = ft(70); // 21.34 m along the ridge (west->east)
const NAVE_D = ft(51); // 15.54 m
const EAVE = 9.2;
const RIDGE = 5.4;
const TOWER = ft(24); // 7.32 m square
const TOWER_TOP = 21.0; // brick stops, white timber begins
const SPIRE_TIP = 53.3;

function buildON(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0x8a5340, roughness: 0.92, tile: 2.2 });
  const white = M.surface('paint', { color: 0xf1eee6, roughness: 0.55, tile: 2.4 });
  const slate = M.surface('slate', { color: 0x50555c, roughness: 0.7, tile: 1.8 });
  const gold = M.gold({ roughness: 0.32 });
  const glass = M.litGlass(1723, { color: 0x24303a, roughness: 0.2, metalness: 0.1 }, 0.5);

  /* ------------------------------------------------------------------ nave */
  // Tower occupies the west end, so the nave body starts east of it.
  const naveX = TOWER / 2;
  b.addAt(prism(rect(NAVE_W - TOWER, NAVE_D), 0, EAVE, { cap: false }), brick, [naveX, 0, 0]);
  b.addAt(gableRoof(NAVE_W - TOWER, NAVE_D, RIDGE), slate, [naveX, EAVE, 0]);

  if (detail) {
    // Two storeys of round-arched windows down both flanks.
    const cols = 6;
    for (let i = 0; i < cols; i++) {
      const x = naveX - (NAVE_W - TOWER) / 2 + ((i + 0.5) / cols) * (NAVE_W - TOWER);
      for (const z of [-NAVE_D / 2 - 0.05, NAVE_D / 2 + 0.05]) {
        for (const [y, h] of [[1.8, 2.4], [5.0, 3.0]] as const) {
          b.addAt(box(1.35, h, 0.14), glass, [x, y, z]);
          // Arched head.
          b.addAt(revolve([[0, 0], [0.68, 0], [0.68, 0.1], [0, 0.1]], 10, Math.PI), white,
            [x, y + h, z], z > 0 ? 0 : Math.PI);
        }
      }
    }
  }

  /* ----------------------------------------------------------- brick tower */
  b.add(prism(rect(TOWER, TOWER), 0, TOWER_TOP, { cap: false }), brick);
  // Quoined corners read even at distance.
  if (detail) {
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      b.addAt(box(1.0, TOWER_TOP, 1.0), white,
        [(sx * TOWER) / 2 - sx * 0.35, 0, (sz * TOWER) / 2 - sz * 0.35]);
    }
  }
  // Pedimented west door.
  b.addAt(box(2.2, 3.4, 0.5), white, [-TOWER / 2 - 0.1, 0, 0]);

  /* ------------------------------------------------- white timber steeple */
  // Stage 1: the belfry — open arcade where the lanterns were hung.
  const S1 = 19.0;
  const s1w = TOWER * 0.86;
  b.add(prism(rect(s1w, s1w), TOWER_TOP, TOWER_TOP + 1.0, { cap: false }), white);
  const belfryY = TOWER_TOP + 1.0;
  const belfryH = 6.4;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const r = s1w / 2;
    // Corner piers plus an open arch between them.
    b.addAt(box(1.0, belfryH, 1.0), white, [Math.sin(a) * r, belfryY, Math.cos(a) * r], a);
  }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    b.addAt(box(1.05, belfryH, 1.05), white, [(sx * s1w) / 2, belfryY, (sz * s1w) / 2]);
  }
  b.add(prism(rect(s1w + 1.4, s1w + 1.4), belfryY + belfryH, belfryY + belfryH + 0.9, { cap: true }), white);
  void S1;

  // Stage 2: octagonal lantern with urns at the corners.
  const oct2Y = belfryY + belfryH + 0.9;
  const oct2H = 6.0;
  b.addAt(cyl(s1w * 0.44, s1w * 0.40, oct2H, 8), white, [0, oct2Y, 0], Math.PI / 8);
  b.addAt(cyl(s1w * 0.50, s1w * 0.50, 0.7, 8), white, [0, oct2Y + oct2H, 0], Math.PI / 8);
  if (detail) {
    for (const [r, y] of [[s1w * 0.46, oct2Y + oct2H + 0.7]] as const) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        b.addAt(revolve([[0, 0], [0.22, 0.1], [0.3, 0.5], [0.16, 0.9], [0, 1.0]], 8), white,
          [Math.sin(a) * r, y, Math.cos(a) * r]);
      }
    }
  }

  // Stage 3: the tapering spire.
  const spireY = oct2Y + oct2H + 1.4;
  const spireH = SPIRE_TIP - spireY - 2.6;
  b.addAt(cyl(s1w * 0.40, 0.16, spireH, 8), white, [0, spireY, 0], Math.PI / 8);

  // Ball, rod and weathervane.
  const tipY = spireY + spireH;
  b.addAt(revolve([[0, 0], [0.34, 0.34], [0, 0.68]], 12), gold, [0, tipY, 0]);
  b.add(strut(new THREE.Vector3(0, tipY + 0.68, 0), new THREE.Vector3(0, tipY + 2.3, 0), 0.06, 6), gold);
  if (detail) {
    const vane = new THREE.Shape();
    vane.moveTo(0, -0.32); vane.lineTo(1.35, -0.1); vane.lineTo(1.35, 0.12); vane.lineTo(0, 0.46);
    const vg = new THREE.ExtrudeGeometry(vane, { depth: 0.03, bevelEnabled: false });
    vg.rotateY(Math.PI / 2);
    vg.translate(0, tipY + 2.0, 0);
    b.add(vg, gold);
  }
  void regularPolygon;
  const _unused: P2[] = [];
  void _unused;

  return b.build('old-north-church');
}

export function buildOldNorth(ctx: Ctx): THREE.Object3D {
  return makeLOD('old-north-church', [
    { object: buildON(ctx, true), distance: 0 },
    { object: buildON(ctx, false), distance: 700 },
  ]);
}
