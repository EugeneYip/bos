import { WATER_WAVES_GLSL } from './common';

/**
 * Displaces the tessellated sheet by the Gerstner sum and hands the fragment
 * stage an analytic normal, the crest-fold term and the two baked per-vertex
 * scalars (shore distance, fetch).
 *
 * Wave amplitude is shoaled to zero over the last ~16 m before the waterline:
 * physically because waves lose height as the bed comes up, and practically
 * because it keeps crests from poking through the bank and makes the lattice /
 * clipped-cell boundary exactly coplanar.
 */
export const WATER_VERT = /* glsl */ `
precision highp float;

attribute vec2 aWave;   // x: signed shore distance (m, positive inside water)
                        // y: fetch 0..1

uniform float uTime;
uniform vec2  uWind;
uniform float uWaveAmp;
uniform int   uWaveCount;
uniform float uSeaLevel;

varying vec3  vWorld;
varying vec3  vGN;
varying float vFold;
varying float vShore;
varying float vFetch;
varying float vViewDist;

${WATER_WAVES_GLSL}

#include <fog_pars_vertex>

void main() {
  vec3 p = position;

  float shore = aWave.x;
  float fetch = aWave.y;

  // Shoaling: no swell survives the last few metres of a bank.
  float shoal = smoothstep(0.0, 16.0, shore);
  // Sheltered water carries a fraction of the open-harbour spectrum.
  float amp = uWaveAmp * shoal * (0.06 + 0.94 * fetch);

  WaveOut w = gerstner(p.xz, uWind, amp, uTime, uWaveCount);
  p += w.disp;

  vWorld = p;
  vGN = w.normal;
  vFold = w.fold * shoal;
  vShore = shore;
  vFetch = fetch;

  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  vViewDist = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;
