import type { Ctx, WorldModule } from '../core/Context';

/** Extruded, LOD-ed, facade-textured OSM building stock. */
export class Buildings implements WorldModule {
  readonly name = 'Buildings';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
