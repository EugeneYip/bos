/**
 * Water surface vertex stage.
 *
 * Displacement is a small sum of Gerstner waves driven by the wind vector,
 * with amplitude scaled by the per-vertex fetch (how much open water is
 * upwind) and damped to nothing at the shoreline, so the Charles stays glassy
 * while the outer harbour has real swell and nothing ever pokes through a
 * quay wall.
 */
export const WATER_VERT = /* glsl */ `
precision highp float;

attribute vec2 aWave;   // x: signed shore distance (m, positive inside water)
                        // y: fetch 0..1

uniform float uTime;
uniform vec2  uWind;
uniform float uWaveAmp;
uniform int   uWaveCount;

varying vec3  vWorld;
varying vec3  vGN;
varying float vShore;
varying float vFetch;
varying float vViewDist;
varying float vCrest;

struct WaveOut { vec3 offset; vec3 normal; float crest; };

/**
 * Gerstner sum. Each octave halves the wavelength and steepness, and rotates
 * slightly off the wind so crests interfere instead of marching in lockstep.
 */
WaveOut gerstner(vec2 p, vec2 wind, float amp, float t, int count) {
  WaveOut o;
  o.offset = vec3(0.0);
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;

  float len = 62.0;
  float a = amp;
  float total = 0.0;

  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    float fi = float(i);
    float ang = (fi - 1.5) * 0.42;
    float c = cos(ang), s = sin(ang);
    vec2 d = normalize(mat2(c, -s, s, c) * wind + vec2(1e-5));

    float k = 6.2831853 / len;
    float speed = sqrt(9.81 / k);          // deep-water dispersion
    float phase = k * dot(d, p) - speed * k * t;
    float ca = cos(phase);
    float sa = sin(phase);
    // Steepness capped so crests never loop over themselves.
    float q = min(0.72 / (k * a * float(count)), 1.0);

    o.offset.xz += q * a * d * ca;
    o.offset.y  += a * sa;
    crest += sa * a;
    total += a;

    float wa = k * a;
    tangent  += vec3(-q * d.x * d.x * wa * sa, d.x * wa * ca, -q * d.x * d.y * wa * sa);
    binormal += vec3(-q * d.x * d.y * wa * sa, d.y * wa * ca, -q * d.y * d.y * wa * sa);

    len *= 0.53;
    a *= 0.56;
  }

  o.normal = normalize(cross(binormal, tangent));
  o.crest = total > 0.0001 ? crest / total : 0.0;
  return o;
}

void main() {
  vec3 p = position;
  float shore = aWave.x;
  float fetch = aWave.y;

  // Waves die in the last few metres so nothing displaces through a sea wall.
  float shoreFade = smoothstep(0.0, 26.0, shore);
  float amp = uWaveAmp * mix(0.035, 0.42, fetch) * shoreFade;

  WaveOut w = gerstner(p.xz, normalize(uWind + vec2(1e-5)), amp, uTime, uWaveCount);
  p += w.offset;

  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vGN = w.normal;
  vCrest = w.crest;
  vShore = shore;
  vFetch = fetch;

  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
