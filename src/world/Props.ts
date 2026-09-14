import type { Ctx, WorldModule } from '../core/Context';

/** Street furniture: lamps, signals, benches, hydrants, boats, aircraft. */
export class Props implements WorldModule {
  readonly name = 'Props';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
