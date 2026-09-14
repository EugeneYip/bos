/**
 * Shared constants for the night-window emissive atlas.
 *
 * Kept in its own module so the geometry generators (`curtainwall.ts`) don't
 * have to pull in the canvas-authoring code in `textures.ts`.
 */
export { hash01 } from './util';

/** Side length, in texels, of the square window-light atlas. One texel = one window. */
export const WINDOW_ATLAS_SIZE = 64;
