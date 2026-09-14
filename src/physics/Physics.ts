import type { Ctx, WorldModule } from '../core/Context';

/** Rapier rigid-body world for collision, vehicles and the walk mode. */
export class Physics implements WorldModule {
  readonly name = 'Physics';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
