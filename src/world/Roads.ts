import type { Ctx, WorldModule } from '../core/Context';

/** Road ribbons, markings, sidewalks, bridges and rail. */
export class Roads implements WorldModule {
  readonly name = 'Roads';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
