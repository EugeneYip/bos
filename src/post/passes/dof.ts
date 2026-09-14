import * as THREE from 'three';
import { Pass, u } from '../core/quad';
import { COMMON, DEPTH } from '../core/glsl';

/**
 * Bokeh depth of field with a real aperture.
 *
 * Circle of confusion is computed from the physical lens equation using the
 * focal length implied by the camera's vertical FOV on a 36x24 sensor, so the
 * f-stop control behaves the way a photographer expects: f/1.4 at 8 m gives a
 * shallow slice, f/11 over the city gives everything.
 *
 * Near and far fields are gathered separately. That separation is the whole
 * point: a blurred foreground has to spread *over* the sharp background
 * (unbounded coverage), while a blurred background must not bleed onto a sharp
 * foreground (bounded by the centre CoC). Doing both with one buffer produces
 * the halo-around-the-subject artefact that gives cheap DOF away.
 *
 * The aperture is an N-gon with adjustable corner rounding: 6 straight blades
 * for a modern lens, curvature 1.0 for a circular iris.
 */
const COC_FRAG = /* glsl */ `
${COMMON}
${DEPTH}
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uSrcTexel;
uniform float uFocusDistance;   // metres
uniform float uFocalLength;     // millimetres
uniform float uAperture;        // millimetres (focal / fStop)
uniform float uMaxCoC;          // pixels (at the half-res buffer)
uniform float uSensorHeight;    // millimetres
uniform float uImageHeight;     // pixels (half-res target height)

float cocPixels(float viewZ) {
  float S1 = max(uFocusDistance, uFocalLength * 0.0011) * 1000.0;  // mm
  float S2 = max(viewZ, 0.01) * 1000.0;
  float f = uFocalLength;
  float cocMm = uAperture * f * (S2 - S1) / max(S2 * (S1 - f), 1e-3);
  float px = cocMm / uSensorHeight * uImageHeight;
  return clamp(px, -uMaxCoC, uMaxCoC);
}

void main() {
  // Downsample 2x2, keeping the most-defocused CoC so the near field spreads.
  vec3 col = vec3(0.0);
  float coc = 0.0;
  float absMax = -1.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * uSrcTexel;
      vec3 c = max(texture2D(tColor, vUv + o).rgb, vec3(0.0));
      float d = texture2D(tDepth, vUv + o).r;
      float z = isSky(d) ? 1.0e6 : -viewPosFromDepth(vUv + o, d, uProjInv).z;
      float k = cocPixels(z);
      col += c;
      if (abs(k) > absMax) { absMax = abs(k); coc = k; }
    }
  }
  gl_FragColor = vec4(col * 0.25, coc / max(uMaxCoC, 1e-3));
}
`;

const GATHER_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
uniform sampler2D tSrc;      // rgb = colour, a = signed CoC in [-1,1]
uniform vec2 uTexel;
uniform float uMaxCoC;       // pixels
uniform float uBlades;
uniform float uCurvature;
uniform float uBokehBias;
uniform float uFrame;

#ifndef DOF_SAMPLES
#define DOF_SAMPLES 28
#endif
#ifndef DOF_NEAR
#define DOF_NEAR 0
#endif

// Straight-edged aperture: the radius of an N-gon at angle theta.
float apertureRadius(float theta) {
  float seg = TAU / uBlades;
  float r = cos(seg * 0.5) / max(cos(mod(theta, seg) - seg * 0.5), 1e-3);
  return mix(r, 1.0, uCurvature);
}

void main() {
  vec4 c0 = texture2D(tSrc, vUv);
  float coc0 = c0.a * uMaxCoC;

#if DOF_NEAR
  float radius = uMaxCoC;      // near field gathers from the whole aperture
#else
  float radius = max(coc0, 0.0);
  if (radius < 0.75) { gl_FragColor = vec4(c0.rgb, 1.0); return; }
#endif

  float rot = hash12(gl_FragCoord.xy + vec2(uFrame * 1.61, uFrame * 2.71)) * TAU;

  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  float coverage = 0.0;

  for (int i = 0; i < DOF_SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(DOF_SAMPLES);
    float a = float(i) * 2.39996323 + rot;
    float r = sqrt(t) * apertureRadius(a);
    vec2 off = vec2(cos(a), sin(a)) * r * radius;
    vec2 suv = vUv + off * uTexel;

    vec4 s = texture2D(tSrc, suv);
    float cocS = s.a * uMaxCoC;
    float dist = length(off);

#if DOF_NEAR
    // Near field: only foreground samples, and they spread without bound.
    float spread = max(-cocS, 0.0);
    float w = saturate1((spread - dist + 1.0) * 0.5);
#else
    // Far field: reject samples that are sharper than the receiver, otherwise
    // a crisp foreground smears into the defocused background behind it.
    float spread = max(cocS, 0.0);
    float w = saturate1((spread - dist + 1.0) * 0.5);
    w *= saturate1((cocS - coc0 * 0.4) * 4.0 + 1.0);
#endif

    // Bokeh bias: weight highlights up so out-of-focus point sources form the
    // bright-rimmed discs a real lens produces.
    float bias = 1.0 + uBokehBias * saturate1(lumaFast(s.rgb) - 1.0);
    sum += s.rgb * (w * bias);
    wsum += w * bias;
    coverage += w;
  }

#if DOF_NEAR
  float cov = saturate1(coverage / float(DOF_SAMPLES) * 2.6);
  gl_FragColor = vec4(wsum > 1e-4 ? sum / wsum : c0.rgb, cov);
#else
  gl_FragColor = vec4(wsum > 1e-4 ? sum / wsum : c0.rgb, 1.0);
#endif
}
`;

const DOF_COMPOSITE_FRAG = /* glsl */ `
${COMMON}
${DEPTH}
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tFar;
uniform sampler2D tNear;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform float uFocusDistance;
uniform float uFocalLength;
uniform float uAperture;
uniform float uMaxCoC;
uniform float uSensorHeight;
uniform float uImageHeight;

float cocPixels(float viewZ) {
  float S1 = max(uFocusDistance, uFocalLength * 0.0011) * 1000.0;
  float S2 = max(viewZ, 0.01) * 1000.0;
  float f = uFocalLength;
  float cocMm = uAperture * f * (S2 - S1) / max(S2 * (S1 - f), 1e-3);
  return clamp(cocMm / uSensorHeight * uImageHeight, -uMaxCoC, uMaxCoC);
}

void main() {
  vec3 sharp = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  float d = texture2D(tDepth, vUv).r;
  float z = isSky(d) ? 1.0e6 : -viewPosFromDepth(vUv, d, uProjInv).z;
  float coc = cocPixels(z);

  vec3 far = texture2D(tFar, vUv).rgb;
  vec4 near = texture2D(tNear, vUv);

  float farMix = smoothstep(0.4, 1.6, coc);
  vec3 c = mix(sharp, far, farMix);
  c = mix(c, near.rgb, saturate1(near.a));

  gl_FragColor = vec4(c, 1.0);
}
`;

export function createDofCocPass(): Pass {
  return new Pass('post/dof-coc', COC_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uSrcTexel: u(new THREE.Vector2()),
    uFocusDistance: u(40),
    uFocalLength: u(35),
    uAperture: u(8.75),
    uMaxCoC: u(11),
    uSensorHeight: u(24),
    uImageHeight: u(540),
  });
}

export function createDofGatherPass(near: boolean, samples: number): Pass {
  return new Pass(near ? 'post/dof-near' : 'post/dof-far', GATHER_FRAG, {
    tSrc: u<THREE.Texture | null>(null),
    uTexel: u(new THREE.Vector2()),
    uMaxCoC: u(11),
    uBlades: u(6),
    uCurvature: u(0.55),
    uBokehBias: u(1.35),
    uFrame: u(0),
  }, { DOF_SAMPLES: samples, DOF_NEAR: near ? 1 : 0 });
}

export function createDofCompositePass(): Pass {
  return new Pass('post/dof-composite', DOF_COMPOSITE_FRAG, {
    tColor: u<THREE.Texture | null>(null),
    tFar: u<THREE.Texture | null>(null),
    tNear: u<THREE.Texture | null>(null),
    tDepth: u<THREE.Texture | null>(null),
    uProjInv: u(new THREE.Matrix4()),
    uFocusDistance: u(40),
    uFocalLength: u(35),
    uAperture: u(8.75),
    uMaxCoC: u(22),
    uSensorHeight: u(24),
    uImageHeight: u(1080),
  });
}
