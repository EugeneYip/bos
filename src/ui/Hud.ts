import type { Ctx, WorldModule } from '../core/Context';

/** On-screen controls, settings, time-of-day scrubber, landmark index. */
export class Hud implements WorldModule {
  readonly name = 'Hud';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
