/**
 * Trinity Church, Copley Square. Henry Hobson Richardson, 1877.
 *
 * The building that gave "Richardsonian Romanesque" its name, and still voted
 * one of the finest buildings in America. It sits low and massive in the
 * square, dwarfed but not diminished by the Hancock Tower's glass wall right
 * behind it — the juxtaposition is one of Boston's best views.
 *
 * Real-world dimensions used
 * --------------------------
 *  plan          Greek cross, ~160 ft = 48.8 m across the transepts
 *  central tower 211 ft = 64.3 m, a massive square lantern modelled on the
 *                crossing tower of Salamanca's old cathedral
 *  west front    twin towers flanking a deeply recessed triple portal
 *  fabric        rock-faced Dedham granite with brownstone trim — the
 *                polychromy (grey field, warm brown banding) is essential
 *  roof          red clay tile, steeply pitched
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, cyl, revolve, gableRoof, pyramid, column } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const NAVE_L = ft(180); // 54.9 m west->east, model +X points east
const NAVE_W = ft(62); // 18.9 m
const TRANSEPT = ft(160); // 48.8 m north->south
const TRANSEPT_W = ft(58); // 17.7 m
const WALL = 17.0;
const ROOF_RISE = 9.5;
const TOWER = ft(62); // 18.9 m square crossing tower
const TOWER_TOP = 47.0;
const SPIRE_TIP = ft(211); // 64.31 m

function buildTC(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const granite = M.surface('granite', { color: 0x8e8a83, roughness: 0.93, tile: 1.6, normalScale: 1.2 });
  const brown = M.surface('sandstone', { color: 0x9a6446, roughness: 0.88, tile: 1.4 });
  const brownDark = M.surface('sandstone', { color: 0x845338, roughness: 0.9, tile: 1.2 });
  const tileRoof = M.surface('slate', { color: 0x93503c, roughness: 0.82, tile: 1.3 });
  const glass = M.litGlass(1877, { color: 0x1b2530, roughness: 0.25, metalness: 0.1 }, 0.6);
  const copper = M.surface('copper', { color: 0x5e9c86, roughness: 0.6, tile: 1.8 });

  /** Rock-faced granite with a brownstone banding course, the Richardson look. */
  const bandedWall = (w: number, d: number, x: number, z: number, top: number): void => {
    b.addAt(prism(rect(w, d), 0, 3.2, { cap: false }), brownDark, [x, 0, z]);
    b.addAt(prism(rect(w + 0.25, d + 0.25), 3.2, 3.9, { cap: false }), brown, [x, 0, z]);
    b.addAt(prism(rect(w, d), 3.9, top - 1.2, { cap: false }), granite, [x, 0, z]);
    b.addAt(prism(rect(w + 0.3, d + 0.3), top - 1.2, top, { cap: false }), brown, [x, 0, z]);
  };

  /* -------------------------------------------------------- the Greek cross */
  bandedWall(NAVE_L, NAVE_W, 0, 0, WALL);
  bandedWall(TRANSEPT_W, TRANSEPT, 0, 0, WALL);

  b.addAt(gableRoof(NAVE_L, NAVE_W, ROOF_RISE), tileRoof, [0, WALL, 0]);
  // Transept roof runs the other way.
  const tr = gableRoof(TRANSEPT, TRANSEPT_W, ROOF_RISE);
  tr.rotateY(Math.PI / 2);
  tr.translate(0, WALL, 0);
  b.add(tr, tileRoof);

  // Semicircular apse at the east end.
  b.addAt(cyl(NAVE_W / 2, NAVE_W / 2, WALL, detail ? 20 : 9), granite, [NAVE_L / 2, 0, 0]);
  b.addAt(revolve([[NAVE_W / 2, 0], [NAVE_W / 2 - 1.6, 3.2], [NAVE_W / 2 - 4.4, 6.0], [0, 7.6]], detail ? 20 : 9),
    tileRoof, [NAVE_L / 2, WALL, 0]);

  /* ----------------------------------------------------- the crossing tower */
  bandedWall(TOWER, TOWER, 0, 0, TOWER_TOP);
  // Corner turrets, which are what stop the tower reading as a plain box.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const px = (sx * TOWER) / 2;
    const pz = (sz * TOWER) / 2;
    b.addAt(cyl(2.5, 2.4, TOWER_TOP + 3.6, detail ? 14 : 7), granite, [px, 0, pz]);
    b.addAt(revolve([[2.9, 0], [2.6, 1.4], [1.5, 3.6], [0, 5.0]], detail ? 14 : 7), copper,
      [px, TOWER_TOP + 3.6, pz]);
  }
  // The great arcaded lantern stage.
  if (detail) {
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      for (let i = 0; i < 3; i++) {
        const t = (i - 1) * (TOWER * 0.26);
        const px = Math.cos(a) * t + Math.sin(a) * (TOWER / 2 + 0.08);
        const pz = -Math.sin(a) * t + Math.cos(a) * (TOWER / 2 + 0.08);
        b.addAt(box(TOWER * 0.2, 8.4, 0.22), glass, [px, TOWER_TOP - 13.0, pz], a);
        const arch = revolve([[0, 0], [TOWER * 0.1, 0], [TOWER * 0.1, 0.22], [0, 0.22]], 12, Math.PI);
        arch.rotateX(-Math.PI / 2);
        arch.rotateY(a);
        arch.translate(px, TOWER_TOP - 4.6, pz);
        b.add(arch, glass);
        // Colonnettes between the lights.
        b.addAt(column(8.4, 0.75, 'corinthian', detail ? 10 : 6), brown,
          [px + Math.cos(a) * TOWER * 0.11, TOWER_TOP - 13.0, pz - Math.sin(a) * TOWER * 0.11], a);
      }
    }
  }
  // Low pyramidal roof — Trinity's tower is emphatically not a spire.
  b.addAt(box(TOWER + 2.2, 1.3, TOWER + 2.2), brown, [0, TOWER_TOP, 0]);
  b.addAt(pyramid(TOWER + 1.0, TOWER + 1.0, SPIRE_TIP - TOWER_TOP - 1.3), tileRoof, [0, TOWER_TOP + 1.3, 0]);

  /* ------------------------------------------------- west front & portico */
  const wx = -NAVE_L / 2;
  for (const sz of [-1, 1]) {
    const pz = sz * (NAVE_W / 2 + 2.0);
    b.addAt(prism(rect(9.0, 9.0), 0, 34.0, { cap: false }), granite, [wx - 2.0, 0, pz]);
    b.addAt(pyramid(10.0, 10.0, 9.0), tileRoof, [wx - 2.0, 34.0, pz]);
  }
  // The deeply recessed triple portal (added 1897 after Richardson's death).
  b.addAt(prism(rect(8.0, NAVE_W + 2.0), 0, 13.5, { cap: true }), brown, [wx - 5.0, 0, 0]);
  if (detail) {
    for (const dz of [-6.2, 0, 6.2]) {
      b.addAt(box(0.6, 7.4, 4.4), glass, [wx - 9.0, 0.6, dz]);
      const arch = revolve([[0, 0], [2.2, 0], [2.2, 0.6], [0, 0.6]], 14, Math.PI);
      arch.rotateX(-Math.PI / 2);
      arch.rotateY(Math.PI / 2);
      arch.translate(wx - 9.0, 8.0, dz);
      b.add(arch, brownDark);
      for (const s of [-1, 1]) {
        b.addAt(column(7.4, 0.62, 'corinthian', 10), brown, [wx - 9.2, 0.6, dz + s * 2.5]);
      }
    }
  }

  // The great west rose window.
  if (detail) {
    const rose = cyl(5.2, 5.2, 0.4, 24);
    rose.rotateZ(Math.PI / 2);
    rose.translate(wx - 0.2, 24.0, 0);
    b.add(rose, glass);
    const ring = cyl(5.9, 5.9, 0.5, 24);
    ring.rotateZ(Math.PI / 2);
    ring.translate(wx - 0.1, 24.0, 0);
    b.add(ring, brown);
  }

  return b.build('trinity-church');
}

export function buildTrinity(ctx: Ctx): THREE.Object3D {
  return makeLOD('trinity-church', [
    { object: buildTC(ctx, true), distance: 0 },
    { object: buildTC(ctx, false), distance: 750 },
  ]);
}
