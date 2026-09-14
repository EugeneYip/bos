/**
 * The fixed scaffolding around every family shader: a full-screen vertex pass,
 * the output-selecting `main()` wrapper, and the Sobel height→normal pass.
 */

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Appended after each family's `bosShade()`. One program renders three
 * different outputs so the albedo, the height field and the ORM pack all come
 * from exactly the same evaluation — no chance of them drifting apart.
 *
 *   uOutput 0 -> linear albedo (destination is an SRGB8_ALPHA8 target, so the
 *                hardware encodes on write and decodes on sample)
 *   uOutput 1 -> height in metres, R channel of an RGBA16F scratch target
 *   uOutput 2 -> R = AO, G = roughness, B = metalness
 *
 * `uSuper` supersamples 2x2 inside the destination texel, which matters for the
 * half-resolution ORM pass where the roughness detail is high frequency.
 */
export const OUTPUT_MAIN = /* glsl */ `
varying vec2 vUv;
uniform int uOutput;
uniform float uSuper;
uniform vec2 uTexel;

void bosShade(vec2 uv, inout BosSurface s);

vec4 bosEncode(vec2 uv) {
  BosSurface s = bosDefault();
  bosShade(fract(uv), s);
  if (uOutput == 0) return vec4(max(s.albedo, 0.0), 1.0);
  if (uOutput == 1) return vec4(s.height, 0.0, 0.0, 1.0);
  return vec4(clamp(s.ao, 0.0, 1.0), clamp(s.rough, 0.0, 1.0), clamp(s.metal, 0.0, 1.0), 1.0);
}

void main() {
  vec4 c = bosEncode(vUv);
  if (uSuper > 0.5) {
    vec2 o = uTexel * 0.25;
    c += bosEncode(vUv + vec2( o.x,  o.y));
    c += bosEncode(vUv + vec2(-o.x,  o.y));
    c += bosEncode(vUv + vec2( o.x, -o.y));
    c = (c + bosEncode(vUv + vec2(-o.x, -o.y))) * 0.2;
  }
  gl_FragColor = c;
}
`;

/**
 * Sobel gradient of the baked height field.
 *
 * The height field is authored in **metres**, and `uMetersPerTexel` carries the
 * physical texel footprint, so the resulting slope is the real slope of the real
 * surface. That is what makes a 10 mm mortar recess look like a 10 mm recess
 * instead of an arbitrary blue-purple smear.
 *
 * Output is OpenGL-convention tangent space (+G = +V) with a 1/255 triangular
 * dither so smooth fields (glass pane bow, oil-canned metal) do not band.
 */
export const SOBEL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform float uMetersPerTexel;
uniform float uStrength;

float bosIGN(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

float h(vec2 o) { return texture2D(uHeight, vUv + o * uTexel).r; }

void main() {
  float tl = h(vec2(-1.0,  1.0)), tc = h(vec2(0.0,  1.0)), tr = h(vec2(1.0,  1.0));
  float ml = h(vec2(-1.0,  0.0)),                          mr = h(vec2(1.0,  0.0));
  float bl = h(vec2(-1.0, -1.0)), bc = h(vec2(0.0, -1.0)), br = h(vec2(1.0, -1.0));

  // Sobel over a 2-texel baseline: G = 8 * (dh/dx) * texelMetres.
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tr + 2.0 * tc + tl) - (br + 2.0 * bc + bl);
  float inv = uStrength / (8.0 * max(uMetersPerTexel, 1e-7));

  vec3 n = normalize(vec3(-gx * inv, -gy * inv, 1.0));
  vec3 e = n * 0.5 + 0.5;

  float d = (bosIGN(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  gl_FragColor = vec4(clamp(e + d, 0.0, 1.0), 1.0);
}
`;
