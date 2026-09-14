import type { Ctx, WorldModule } from '../core/Context';

/** Instanced trees, grass and park planting with wind animation. */
export class Vegetation implements WorldModule {
  readonly name = 'Vegetation';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
