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
 * refinement, a 1.6 km streaming radius, and releasing the vertex arrays
 * `__debug.pick` needs. A false positive therefore quietly hands a desktop a
 * stripped-down city and makes every improvement shipped for it invisible,
 * which is exactly what a MacBook user reported. So each clause has to be one
 * a laptop cannot accidentally pass.
 *
 * The awkward case is the iPad: Safari there reports a Macintosh user agent
 * on purpose, so there is no string to match. The tell is the touch-point
 * count. A Mac reports 0 -- including a Mac driving a touchscreen, because
 * Safari exposes no touch there -- and an iPad reports 5. Requiring five,
 * rather than the two an earlier version asked for, is what keeps a laptop
 * out; and it is a property a test harness can set, which `pointer: coarse`
 * turned out not to be under Chrome's device emulation.
 *
 * A Windows or Android tablet with a keyboard is deliberately treated as a
 * desktop: it has the memory, and the cost of being wrong in that direction
 * is a slow page rather than a stripped one.
 */
const ua = navigator.userAgent;
/** iPadOS Safari reports a Mac UA; five touch points and no mouse is the tell. */
const isIPadOS = /macintosh/i.test(ua) && navigator.maxTouchPoints >= 5;

export const MOBILE = /iphone|ipod/i.test(ua)
  || (/ipad/i.test(ua))
  || isIPadOS
  || (/android/i.test(ua) && /mobile/i.test(ua));

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
