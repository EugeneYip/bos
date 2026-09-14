import type { Ctx, WorldModule } from '../core/Context';

/** Hand-authored hero geometry for Boston's recognisable landmarks. */
export class Landmarks implements WorldModule {
  readonly name = 'Landmarks';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
