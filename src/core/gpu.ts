import * as THREE from 'three';
import type { QualityTier } from './config';

/**
 * Picks a starting quality tier from the GPU string plus a few capability
 * probes. This is a heuristic; the runtime adaptive-quality watchdog and the
 * settings UI can both override it afterwards.
 */
export function detectTier(renderer: THREE.WebGLRenderer): QualityTier {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const name = raw.toLowerCase();

  const mobile = /iphone|ipad|android|mobile/i.test(navigator.userAgent);
  if (mobile) return /apple a1[7-9]|apple m\d/.test(name) ? 'medium' : 'low';

  // Discrete desktop parts.
  if (/rtx\s*(40|50)\d\d|rtx\s*30(80|90)|radeon rx\s*(7[89]|9)\d{2}/.test(name)) return 'ultra';
  if (/rtx\s*(20|30)\d\d|gtx\s*16\d\d|radeon rx\s*[56]\d{3}|apple m[2-9]\s*(pro|max|ultra)/.test(name)) return 'high';
  if (/apple m\d|gtx\s*10\d\d|radeon|iris xe|arc a\d/.test(name)) return 'high';
  if (/intel|uhd|hd graphics|llvmpipe|swiftshader/.test(name)) return 'low';

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  return maxTex >= 16384 ? 'high' : 'medium';
}
