import * as THREE from 'three';
import type { QualityTier } from './config';

/**
 * Picks a starting quality tier from the GPU string plus a few capability
 * probes. This is a heuristic; the runtime adaptive-quality watchdog and the
 * settings UI can both override it afterwards.
 */
/**
 * What the driver says it is, or an empty string when the browser masks it.
 *
 * Worth surfacing: every tier decision hangs off this one string, and when it
 * comes back masked the fallback is a texture-size probe that cannot tell a
 * laptop from a workstation. A user who thinks the quality control is broken is
 * usually looking at a machine the probe guessed low.
 */
export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
}

/**
 * A phone or a tablet, which here means a far tighter memory budget rather
 * than a slower GPU.
 *
 * Everything this flag controls is a reduction -- the lowest tier, no terrain
 * refinement, a 1.6 km streaming radius, and releasing the vertex arrays that
 * `__debug.pick` needs. A false positive therefore quietly hands a desktop a
 * stripped-down city and makes every improvement shipped for it invisible,
 * which is exactly what a MacBook user reported. So the test has to be one a
 * laptop cannot accidentally pass.
 *
 * iPadOS Safari reports a desktop user agent, so a touch-point count is the
 * only thing that catches an iPad -- but `maxTouchPoints` is not reliably 0
 * on every Mac, and on its own it is too weak a signal to strip a desktop on.
 * Pairing it with `pointer: coarse` is: a trackpad and a mouse are both fine
 * pointers, and no Mac reports a coarse primary pointer.
 */
const coarsePointer = typeof matchMedia === 'function'
  && matchMedia('(pointer: coarse)').matches;

export const MOBILE = /iphone|ipod|android/i.test(navigator.userAgent)
  || (coarsePointer && navigator.maxTouchPoints > 1);

export function detectTier(renderer: THREE.WebGLRenderer): QualityTier {
  const gl = renderer.getContext();
  const raw = gpuName(renderer);
  const name = raw.toLowerCase();

  // Always the lowest tier on a phone or tablet, whatever the GPU says.
  //
  // An M-series iPad is not short of arithmetic, it is short of address
  // space, and the tier controls far more than shading: `medium` doubles the
  // facade atlas to 1024, nearly doubles the tree budget, doubles the detail
  // distance, turns on volumetric clouds and adds TAA and SSAO render
  // targets. Measured on an iPad user agent, the page peaks at 776 MB of JS
  // heap before the collector catches up and settles at 481 -- and iOS kills
  // the tab on the peak, which is what the reload loop is.
  if (MOBILE) return 'low';

  // Discrete desktop parts.
  if (/rtx\s*(40|50)\d\d|rtx\s*30(80|90)|radeon rx\s*(7[89]|9)\d{2}/.test(name)) return 'ultra';
  if (/rtx\s*(20|30)\d\d|gtx\s*16\d\d|radeon rx\s*[56]\d{3}|apple m[2-9]\s*(pro|max|ultra)/.test(name)) return 'high';
  if (/apple m\d|gtx\s*10\d\d|radeon|iris xe|arc a\d/.test(name)) return 'high';
  if (/intel|uhd|hd graphics|llvmpipe|swiftshader/.test(name)) return 'low';

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  return maxTex >= 16384 ? 'high' : 'medium';
}
