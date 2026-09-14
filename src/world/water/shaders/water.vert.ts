import { WATER_CONST_GLSL, WATER_WAVE_GLSL, WATER_WIND_GLSL } from './common';

/**
 * Water surface vertex stage.
 *
 * The displacement is a fetch-limited Gerstner sum whose energy is modulated
 * by the same wind field the fragment stage uses for roughness, so the
 * geometry actually rises where a gust is crossing and lies down in the
 * slicks between. Amplitude is shoaled to nothing at the shoreline (nothing
 * may displace through a sea wall) and each component is faded out both when
 * the 6 m lattice can no longer carry it and when it falls below a few pixels
 * on screen — whatever is faded is handed to the fragment stage as slope
 * variance so the surface gets rougher rather than flatter with distance.
 *
 * The off-data ocean skirt has kilometre-wide quads, so it takes normals only
 * (`uCellSize` arrives as 0 there and every geometric term drops out).
 */
export const WATER_VERT = /* glsl */ `
precision highp float;

attribute vec2 aWave;   // x: signed shore distance (m, positive inside water)
                        // y: fetch 0..1

uniform float uTime;
uniform float uWaveAmp;
uniform float uPeak;      // crest sharpening
uniform float uCellSize;  // lattice spacing in metres; 0 disables displacement

#define WATER_NOISE_FETCH(uv) textureLod(uNoise, uv, 0.0)

${WATER_CONST_GLSL}
${WATER_WIND_GLSL}
${WATER_WAVE_GLSL}

varying vec3  vWorld;
varying vec3  vGN;
varying float vShore;
varying float vFetch;
varying float vViewDist;
varying float vCrest;
varying float vFold;
varying float vLostVar;

void main() {
  vec3 p = position;
  float shore = aWave.x;
  float fetch = aWave.y;

  vec4 flat0 = modelMatrix * vec4(p, 1.0);
  float dist = distance(cameraPosition, flat0.xyz);

  // Gusts carry more energy than the slicks between them; the very large
  // swell octave of the wind field keeps whole reaches of the harbour livelier
  // than others, which is what gives open water its sense of scale.
  vec3 wf = windField(flat0.xz, uTime);
  float energy = mix(0.40, 1.35, wf.x) * mix(0.8, 1.2, wf.z);

  // Waves die in the last few metres so nothing displaces through a quay.
  float shoreFade = smoothstep(0.0, 22.0, shore);
  // ...but they steepen just before they do: shoaling piles the crest up.
  float shoal = 1.0 + 0.55 * exp(-max(shore, 0.0) / 34.0) * smoothstep(2.0, 30.0, shore);

  // The off-data skirt is a ring mesh with quads hundreds of metres across;
  // displacing it would fold it inside out, so it takes normals only.
  float cell = uCellSize;
#ifdef WATER_SKIRT
  cell = 0.0;
#endif

  WaveOut w = oceanWaves(
    flat0.xz, normalize(uWind + vec2(1e-5)), uTime, fetch,
    energy * shoreFade * shoal, uWaveAmp, dist, cell, uPeak
  );

  vec4 world = flat0 + vec4(w.disp, 0.0);
  vWorld = world.xyz;
  vGN = w.normal;
  vCrest = w.crest;
  vFold = w.fold;
  vLostVar = w.lostVar;
  vShore = shore;
  vFetch = fetch;

  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
