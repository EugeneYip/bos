import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';

/** Owns the procedural PBR texture library shared by every other module. */
export class Materials implements WorldModule {
  readonly name = 'Materials';
  async init(ctx: Ctx): Promise<void> {
    void ctx;
  }
}
