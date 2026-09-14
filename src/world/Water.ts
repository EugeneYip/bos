import type { Ctx, WorldModule } from '../core/Context';

/** The Charles, the harbour, Fort Point Channel — reflective animated water. */
export class Water implements WorldModule {
  readonly name = 'Water';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
