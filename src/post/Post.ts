import type { Ctx, WorldModule } from '../core/Context';

/** TAA, SSAO, SSR, bloom, DOF, motion blur, grade and tonemap. */
export class Post implements WorldModule {
  readonly name = 'Post';
  async init(ctx: Ctx): Promise<void> { void ctx; }
}
