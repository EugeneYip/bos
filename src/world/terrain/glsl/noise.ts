/**
 * Tileable GLSL noise used to bake the terrain surface library.
 *
 * Every generator takes an explicit lattice period so the baked 512px tiles
 * wrap seamlessly; a surface that seams is worse than one that repeats.
 */
export const NOISE_GLSL = /* glsl */`
float bosHash21(vec2 p, float period) {
  p = mod(p, vec2(period));
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p.x + p.y * 1.61803) * 43758.5453123);
}

vec2 bosHash22(vec2 p, float period) {
  p = mod(p, vec2(period));
  vec2 q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(q) * 43758.5453123);
}

float bosValue(vec2 x, float period) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = bosHash21(i, period);
  float b = bosHash21(i + vec2(1.0, 0.0), period);
  float c = bosHash21(i + vec2(0.0, 1.0), period);
  float d = bosHash21(i + vec2(1.0, 1.0), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float bosFbm(vec2 x, float period, int octaves, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  float per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * bosValue(x, per);
    norm += amp;
    x *= 2.0;
    per *= 2.0;
    amp *= gain;
  }
  return sum / max(norm, 1e-4);
}

/** Ridged variant — good for cracked mud and aggregate. */
float bosRidge(vec2 x, float period, int octaves) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  float per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * (1.0 - abs(bosValue(x, per) * 2.0 - 1.0));
    norm += amp;
    x *= 2.0;
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/** Returns x = F1 distance, y = F2 - F1 (edge mask), z = cell id hash. */
vec3 bosVoronoi(vec2 x, float period) {
  vec2 n = floor(x);
  vec2 f = x - n;
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = bosHash22(n + g, period);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = bosHash21(n + g + 17.3, period);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2) - sqrt(f1), id);
}
`;
