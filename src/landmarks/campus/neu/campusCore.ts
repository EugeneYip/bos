/**
 * Assembles the Northeastern quad core — Snell Library, Churchill Hall,
 * Richards Hall and Centennial Common between them — into the single Group
 * the registry places. Each building is authored in its own axis-aligned
 * local frame (see its file); this is the one place that rotates each onto
 * its real campus-grid bearing and drops it at its real offset from the
 * shared anchor (see `common.ts`).
 */
import * as THREE from 'three';
import type { Ctx } from '../../../core/Context';
import { makeLOD } from '../../lib/lod';
import { ROT_A, ROT_B, SNELL_LOCAL, CHURCHILL_LOCAL, RICHARDS_LOCAL } from './common';
import { buildChurchillHall } from './churchillHall';
import { buildRichardsHall } from './richardsHall';
import { buildSnellLibrary } from './snellLibrary';
import { buildCentennialCommon } from './quad';

function place(o: THREE.Object3D, local: [number, number], rotY: number): THREE.Object3D {
  o.position.set(local[0], 0, local[1]);
  o.rotation.y = rotY;
  return o;
}

function buildCore(ctx: Ctx, detail: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = 'neu-campus-core';
  g.add(buildCentennialCommon(ctx, detail));
  g.add(place(buildChurchillHall(ctx, detail), CHURCHILL_LOCAL, ROT_A));
  g.add(place(buildRichardsHall(ctx, detail), RICHARDS_LOCAL, ROT_B));
  g.add(place(buildSnellLibrary(ctx, detail), SNELL_LOCAL, ROT_B));
  return g;
}

export function buildNeuCampusCore(ctx: Ctx): THREE.Object3D {
  return makeLOD('neu-campus-core', [
    { object: buildCore(ctx, true), distance: 0 },
    { object: buildCore(ctx, false), distance: 900 },
  ]);
}
