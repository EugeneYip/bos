/**
 * The terrain material: a `MeshStandardMaterial` with the CDLOD vertex stage
 * and the land-cover splat stage patched in.
 *
 * Building on MeshStandardMaterial rather than a bespoke ShaderMaterial means
 * the ground participates in the city's real lighting — cascaded shadows, the
 * Sky module's IBL, fog, tone mapping — instead of re-implementing half of it
 * badly. The cost is `onBeforeCompile` string surgery, which is kept to five
 * well-known injection points.
 *
 * Anti-tiling is not optional at city scale: a 3 m grass tile repeated across
 * the Common is instantly readable as a grid. Every detail layer is sampled
 * through a stochastic hex-lattice blend (3 taps, random per-cell offset and
 * rotation about the cell centre), then modulated by two octaves of large-scale
 * macro variation so the eye never finds a period.
 */
import * as THREE from 'three';
import { GRID_N } from './cdlod';
import { LAYER_COUNT } from './surfaces';
import { SHORE_RANGE } from './fieldTextures';

export interface TerrainUniforms {
  [k: string]: THREE.IUniform;
}

const SHARED_GLSL = /* glsl */`
uniform sampler2D tHeight;
uniform sampler2D tField;
uniform sampler2D tCover;
uniform vec2 uFieldA;
uniform vec2 uFieldB;
uniform vec2 uHfOrigin;
uniform vec2 uHfInvSpacing;
uniform vec2 uHfTexels;
uniform vec2 uHeightEnc;
uniform float uDebug;

float bosDecodeH(vec2 rg) {
  return uHeightEnc.x + (rg.r * 65280.0 + rg.g * 255.0) * (1.0 / 65535.0) * uHeightEnc.y;
}

/** Bilinear heightfield lookup matching ctx.sampleHeight to ~2 mm. */
float bosHeightAt(vec2 wp, out vec2 grad) {
  vec2 f = (wp - uHfOrigin) * uHfInvSpacing;
  f = clamp(f, vec2(0.0), uHfTexels - vec2(1.0001));
  vec2 i0 = floor(f);
  vec2 t = f - i0;
  ivec2 p = ivec2(i0);
  float h00 = bosDecodeH(texelFetch(tHeight, p, 0).rg);
  float h10 = bosDecodeH(texelFetch(tHeight, p + ivec2(1, 0), 0).rg);
  float h01 = bosDecodeH(texelFetch(tHeight, p + ivec2(0, 1), 0).rg);
  float h11 = bosDecodeH(texelFetch(tHeight, p + ivec2(1, 1), 0).rg);
  grad = vec2(
    mix(h10 - h00, h11 - h01, t.y) * uHfInvSpacing.x,
    mix(h01 - h00, h11 - h10, t.x) * uHfInvSpacing.y
  );
  return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
}

vec2 bosFieldUv(vec2 wp) { return wp * uFieldA + uFieldB; }
`;

const VERTEX_HEAD = /* glsl */`
attribute vec2 aGrid;
attribute vec4 iChunk;   // originX, originZ, size, parent-takeover distance
attribute float iMeta;   // edge mask + 16 * level
varying vec3 vTerrainWorld;
varying float vTerrainLevel;
varying float vTerrainMorph;
varying float vTerrainDist;
${SHARED_GLSL}
`;

const VERTEX_BODY = /* glsl */`
  float lvl = floor(iMeta * 0.0625);
  float mask = iMeta - lvl * 16.0;
  float cells = ${GRID_N}.0;
  float cellStep = iChunk.z / cells;

  vec2 g = aGrid;
  vec2 wp0 = iChunk.xy + g * cellStep;
  vec2 gradIgnored;
  float h0 = bosHeightAt(wp0, gradIgnored);
  float dist = distance(cameraPosition, vec3(wp0.x, h0, wp0.y));

  // Geomorph: by the time the parent node takes over at iChunk.w this node has
  // already become its parent, so the switch is a no-op on screen.
  float mEnd = iChunk.w;
  float mStart = mEnd * 0.62;
  float morph = clamp((dist - mStart) / max(mEnd - mStart, 0.001), 0.0, 1.0);

  vec2 mv = vec2(morph);
  float bN = mod(floor(mask), 2.0);
  float bE = mod(floor(mask * 0.5), 2.0);
  float bS = mod(floor(mask * 0.25), 2.0);
  float bW = mod(floor(mask * 0.125), 2.0);
  // Hard-snap boundary vertices onto a coarser neighbour's edge. This is what
  // makes T-junction cracks structurally impossible rather than merely rare.
  if (g.y < 0.5 && bN > 0.5) mv.x = 1.0;
  if (g.x > cells - 0.5 && bE > 0.5) mv.y = 1.0;
  if (g.y > cells - 0.5 && bS > 0.5) mv.x = 1.0;
  if (g.x < 0.5 && bW > 0.5) mv.y = 1.0;

  vec2 gm = mix(g, floor(g * 0.5 + 0.0001) * 2.0, mv);
  vec2 wp = iChunk.xy + gm * cellStep;
  vec2 grad;
  float hh = bosHeightAt(wp, grad);

  vec3 transformed = vec3(wp.x, hh, wp.y);
  vTerrainWorld = transformed;
  vTerrainLevel = lvl;
  vTerrainMorph = morph;
  vTerrainDist = dist;
`;

// The fragment stage takes its normal from the heightfield normal texture, so
// the vertex normal only feeds three's normal-offset shadow bias. Up is both
// correct enough for that and four texture fetches cheaper per vertex.
const NORMAL_BODY = 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);';

const FRAGMENT_HEAD = /* glsl */`
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tDetail;
uniform float uTiles[${LAYER_COUNT}];
uniform float uDetailScale;
uniform float uHexNear;
uniform float uHexFar;
uniform float uNormalFar;
uniform float uMacro;
uniform float uWetDarken;
varying vec3 vTerrainWorld;
varying float vTerrainLevel;
varying float vTerrainMorph;
varying float vTerrainDist;
${SHARED_GLSL}

float bosSrgbToLinear1(float c) {
  return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}
vec3 bosSrgbToLinear(vec3 c) {
  return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}

float bosH1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 bosH2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float bosN2(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bosH1(i), bosH1(i + vec2(1.0, 0.0)), u.x),
             mix(bosH1(i + vec2(0.0, 1.0)), bosH1(i + vec2(1.0, 1.0)), u.x), u.y);
}
float bosFbm2(vec2 x) {
  return 0.53 * bosN2(x) + 0.27 * bosN2(x * 2.07 + 5.1) + 0.14 * bosN2(x * 4.13 + 11.7);
}

/** Nearest three hex-lattice cells and their barycentric weights. */
void bosTriGrid(vec2 uv, out vec3 w, out vec2 c1, out vec2 c2, out vec2 c3) {
  uv *= 3.4641016;
  vec2 sk = vec2(uv.x - uv.y * 0.57735027, uv.y * 1.15470054);
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(t.z, 0.0);
  float s2 = 2.0 * s - 1.0;
  w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  c1 = base + vec2(s, s);
  c2 = base + vec2(s, 1.0 - s);
  c3 = base + vec2(1.0 - s, s);
}
vec2 bosCellCentre(vec2 c) {
  return vec2(c.x + c.y * 0.5, c.y * 0.8660254) * (1.0 / 3.4641016);
}
vec4 bosHexTap(sampler2DArray tex, float layer, vec2 uv, vec2 cell, vec2 ddx, vec2 ddy) {
  vec2 h = bosH2(cell);
  float a = h.x * 6.2831853;
  float ca = cos(a);
  float sa = sin(a);
  mat2 R = mat2(ca, -sa, sa, ca);
  vec2 ctr = bosCellCentre(cell);
  vec2 suv = R * (uv - ctr) + ctr + h * 7.31;
  return textureGrad(tex, vec3(suv, layer), R * ddx, R * ddy);
}
/**
 * Stochastic hex sampling. Weights are sharpened before normalising so three
 * overlapping taps do not wash the surface into mush; past the blend distance the mip
 * chain has already destroyed the detail, so a single tap is indistinguishable
 * and three times cheaper.
 */
vec4 bosHex(sampler2DArray tex, float layer, vec2 uv, vec2 ddx, vec2 ddy, float blend) {
  if (blend < 0.02) return textureGrad(tex, vec3(uv, layer), ddx, ddy);
  vec3 w;
  vec2 c1, c2, c3;
  bosTriGrid(uv * 0.105, w, c1, c2, c3);
  w = pow(max(w, vec3(0.0)), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-5);
  vec4 a = bosHexTap(tex, layer, uv, c1, ddx, ddy);
  vec4 b = bosHexTap(tex, layer, uv, c2, ddx, ddy);
  vec4 c = bosHexTap(tex, layer, uv, c3, ddx, ddy);
  vec4 hexed = a * w.x + b * w.y + c * w.z;
  return mix(textureGrad(tex, vec3(uv, layer), ddx, ddy), hexed, blend);
}

vec3 gTerrainNormalW;
float gTerrainRough;
float gTerrainAO;
vec3 gDebugColor;
`;

const FRAGMENT_BODY = /* glsl */`
  vec2 P = vTerrainWorld.xz;
  float dist = vTerrainDist;

  // --- fields -------------------------------------------------------------
  vec4 fld = texture(tField, bosFieldUv(P));
  vec3 baseN = normalize(fld.xyz * 2.0 - 1.0);
  float shore = (fld.w * 2.0 - 1.0) * ${SHORE_RANGE.toFixed(1)};

  // Warp the land-cover lookup so 4.5 m raster boundaries read as organic
  // edges rather than as pixel stairs, without bending kerbs into noodles.
  vec2 warp = vec2(bosN2(P * 0.73), bosN2(P * 0.73 + 41.7)) - 0.5;
  warp += (vec2(bosN2(P * 0.21 + 7.3), bosN2(P * 0.21 + 91.1)) - 0.5) * 2.4;
  vec4 cov = texture(tCover, bosFieldUv(P + warp * 1.9));

  float slope = 1.0 - baseN.y;
  float steep = smoothstep(0.055, 0.20, slope);

  // --- weights ------------------------------------------------------------
  float green = cov.r;
  float litter = cov.g;
  float sandC = cov.b;
  float hard = cov.a;
  float bare = clamp(1.0 - green - litter - sandC, 0.0, 1.0);

  float wConc = 1.0 - smoothstep(0.04, 0.42, hard);
  float wAsph = smoothstep(0.46, 0.88, hard);
  float wGrav = clamp(1.0 - wConc - wAsph, 0.0, 1.0);

  float w[${LAYER_COUNT}];
  w[0] = green;
  w[1] = 0.0;
  w[2] = bare * wGrav;
  w[3] = sandC;
  w[4] = bare * wAsph;
  w[5] = bare * wConc;
  w[6] = litter;

  // Steep ground sheds its vegetation and its loose paving; what is left is
  // subsoil. Boston's drumlins are gentle, so this mostly shows on cut banks.
  float bald = steep * (0.55 + 0.45 * bosFbm2(P * 0.06));
  float shed = (w[0] + w[6]) * bald;
  w[0] -= shed * 0.85;
  w[6] -= shed * 0.85;
  w[1] += shed * 0.85 + (w[2] + w[5]) * bald * 0.5;
  w[2] *= 1.0 - bald * 0.5;
  w[5] *= 1.0 - bald * 0.5;

  // Worn dirt at the edges of green space, where a city actually wears out.
  float wear = smoothstep(0.62, 0.95, bosFbm2(P * 0.09 + 13.0)) * w[0];
  w[0] -= wear * 0.5;
  w[1] += wear * 0.5;

  // Natural shores turn sandy; paved quays stay paved.
  float natural = clamp(w[0] + w[6] + w[3] * 2.0, 0.0, 1.0);
  float beachy = (1.0 - smoothstep(1.5, 13.0, shore)) * step(0.0, shore) * natural;
  float toSand = (w[0] + w[6] + w[1]) * beachy * 0.8;
  w[0] *= 1.0 - beachy * 0.8;
  w[6] *= 1.0 - beachy * 0.8;
  w[1] *= 1.0 - beachy * 0.8;
  w[3] += toSand;

  float total = 0.0;
  for (int i = 0; i < ${LAYER_COUNT}; i++) total += max(w[i], 0.0);
  float invTotal = 1.0 / max(total, 1e-4);

  // --- blended detail -----------------------------------------------------
  float hexBlend = 1.0 - smoothstep(uHexNear, uHexFar, dist);
  float detailAmt = 1.0 - smoothstep(uNormalFar * 0.45, uNormalFar, dist);
  vec2 wdx = dFdx(P);
  vec2 wdy = dFdy(P);

  vec3 albedo = vec3(0.0);
  float rough = 0.0;
  float ao = 0.0;
  vec2 dslope = vec2(0.0);

  for (int i = 0; i < ${LAYER_COUNT}; i++) {
    float wi = max(w[i], 0.0) * invTotal;
    if (wi < 0.008) continue;
    float inv = 1.0 / uTiles[i];
    vec2 uv = P * inv;
    vec4 a = bosHex(tAlbedo, float(i), uv, wdx * inv, wdy * inv, hexBlend);
    albedo += a.rgb * wi;
    rough += a.a * wi;
    if (detailAmt > 0.01) {
      vec4 d = bosHex(tDetail, float(i), uv, wdx * inv, wdy * inv, hexBlend);
      dslope += (d.xy * 2.0 - 1.0) * wi;
      ao += d.z * wi;
    } else {
      ao += wi;
    }
  }

  albedo = bosSrgbToLinear(clamp(albedo, 0.0, 1.0));

  // --- macro variation ----------------------------------------------------
  // Without this the ground reads as one flat swatch from the air no matter how
  // good the close-up detail is.
  float m1 = bosFbm2(P * 0.0042);
  float m2 = bosFbm2(P * 0.0165 + 23.0);
  float m3 = bosN2(P * 0.052 + 61.0);
  float macro = (m1 - 0.5) * 1.15 + (m2 - 0.5) * 0.7 + (m3 - 0.5) * 0.35;
  albedo *= 1.0 + macro * uMacro;
  albedo *= mix(vec3(1.0), vec3(1.035, 1.0, 0.94), (m1 - 0.5) * uMacro * 2.2);
  albedo *= mix(vec3(1.0), vec3(0.95, 1.02, 0.96), (m2 - 0.5) * uMacro * 2.0);

  // --- water line ---------------------------------------------------------
  float y = vTerrainWorld.y;
  // Boston's tide swings about three metres; the band it leaves behind is the
  // single strongest cue that the shoreline is real.
  float tidal = (1.0 - smoothstep(0.15, 1.55, y)) * (1.0 - smoothstep(6.0, 26.0, max(shore, 0.0)));
  float splash = 1.0 - smoothstep(-0.5, 0.9, y);
  float wet = clamp(max(tidal * 0.8, splash), 0.0, 1.0) * uWetDarken;
  float algae = wet * smoothstep(0.25, 0.75, bosFbm2(P * 0.35));
  albedo = mix(albedo, albedo * vec3(0.42, 0.44, 0.43), wet);
  albedo = mix(albedo, albedo * vec3(0.55, 0.78, 0.55), algae * 0.45);
  rough = mix(rough, 0.16, wet * 0.85);

  float under = clamp(-y * 0.18, 0.0, 1.0);
  albedo = mix(albedo, albedo * vec3(0.30, 0.40, 0.38), under * 0.8);
  rough = mix(rough, 0.35, under * 0.5);

  ao = mix(1.0, clamp(ao, 0.0, 1.0), 0.75 * detailAmt + 0.25);
  albedo *= mix(1.0, ao, 0.6);

  // --- normal -------------------------------------------------------------
  vec3 nW = baseN;
  if (detailAmt > 0.01) {
    vec2 ds = dslope * uDetailScale * detailAmt;
    nW = normalize(vec3(baseN.x + ds.x, baseN.y, baseN.z + ds.y));
  }
  gTerrainNormalW = nW;
  gTerrainRough = clamp(rough, 0.05, 1.0);
  gTerrainAO = ao;

  diffuseColor.rgb *= albedo;

  if (uDebug > 0.5) {
    int dm = int(uDebug + 0.5);
    if (dm == 1) {
      vec3 pal[7];
      pal[0] = vec3(0.9, 0.2, 0.2); pal[1] = vec3(0.95, 0.6, 0.15);
      pal[2] = vec3(0.9, 0.9, 0.2); pal[3] = vec3(0.25, 0.85, 0.3);
      pal[4] = vec3(0.2, 0.7, 0.95); pal[5] = vec3(0.35, 0.35, 0.95);
      pal[6] = vec3(0.8, 0.3, 0.9);
      gDebugColor = pal[int(clamp(vTerrainLevel, 0.0, 6.0))] * (0.55 + 0.45 * vTerrainMorph);
    } else if (dm == 2) {
      gDebugColor = vec3(w[0] + w[6] * 0.6, (w[4] + w[5] + w[2]) * invTotal, (w[3] + w[1] * 0.4) * invTotal);
    } else if (dm == 3) {
      gDebugColor = vec3(clamp(shore / 24.0, 0.0, 1.0), clamp(-shore / 24.0, 0.0, 1.0), wet);
    } else if (dm == 4) {
      // Raw land-cover map: red = grass weight, green = litter, blue = sand,
      // and the alpha channel (hard-surface class) as brightness.
      gDebugColor = vec3(cov.r, cov.g, cov.b);
    } else if (dm == 5) {
      gDebugColor = vec3(cov.a, cov.a, cov.a);
    } else {
      gDebugColor = vec3(vTerrainMorph, 1.0 - vTerrainMorph, 0.0);
    }
  }
`;

export interface TerrainMaterialParts {
  material: THREE.MeshStandardMaterial;
  uniforms: TerrainUniforms;
}

export function createTerrainMaterial(opts: {
  height: THREE.Texture;
  field: THREE.Texture;
  cover: THREE.Texture;
  albedoArray: THREE.Texture;
  detailArray: THREE.Texture;
  tiles: Float32Array;
  heightBase: number;
  heightRange: number;
  hfOriginX: number;
  hfOriginZ: number;
  hfSpacingX: number;
  hfSpacingZ: number;
  hfWidth: number;
  hfHeight: number;
}): TerrainMaterialParts {
  const invSX = 1 / opts.hfSpacingX;
  const invSZ = 1 / opts.hfSpacingZ;
  const fieldAx = invSX / opts.hfWidth;
  const fieldAz = invSZ / opts.hfHeight;

  const uniforms: TerrainUniforms = {
    tHeight: { value: opts.height },
    tField: { value: opts.field },
    tCover: { value: opts.cover },
    tAlbedo: { value: opts.albedoArray },
    tDetail: { value: opts.detailArray },
    uTiles: { value: Array.from(opts.tiles) },
    uFieldA: { value: new THREE.Vector2(fieldAx, fieldAz) },
    uFieldB: {
      value: new THREE.Vector2(
        0.5 / opts.hfWidth - opts.hfOriginX * fieldAx,
        0.5 / opts.hfHeight - opts.hfOriginZ * fieldAz,
      ),
    },
    uHfOrigin: { value: new THREE.Vector2(opts.hfOriginX, opts.hfOriginZ) },
    uHfInvSpacing: { value: new THREE.Vector2(invSX, invSZ) },
    uHfTexels: { value: new THREE.Vector2(opts.hfWidth, opts.hfHeight) },
    uHeightEnc: { value: new THREE.Vector2(opts.heightBase, opts.heightRange) },
    uDetailScale: { value: 1.35 },
    uHexNear: { value: 42 },
    uHexFar: { value: 190 },
    uNormalFar: { value: 420 },
    uMacro: { value: 0.30 },
    uWetDarken: { value: 1.0 },
    uDebug: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    dithering: true,
    fog: true,
  });
  // Nudge the ground away from the eye so roads, plazas and area decals drawn
  // at terrain height by other modules win the depth test cleanly.
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1.0;
  material.polygonOffsetUnits = 2.0;

  material.customProgramCacheKey = () => 'bos-terrain-v1';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <beginnormal_vertex>', NORMAL_BODY)
      .replace('#include <begin_vertex>', VERTEX_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <map_fragment>', FRAGMENT_BODY)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gTerrainRough;')
      .replace(
        '#include <normal_fragment_begin>',
        `vec3 normal = normalize((viewMatrix * vec4(gTerrainNormalW, 0.0)).xyz);
         vec3 nonPerturbedNormal = normal;
         float faceDirection = 1.0;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         if (uDebug > 0.5) gl_FragColor = vec4(gDebugColor, 1.0);`,
      );
  };

  return { material, uniforms };
}

/**
 * Matching depth material. Without it any depth-only pass (shadow casting, a
 * depth prepass) would draw the terrain as the undisplaced dummy grid sitting
 * at the origin.
 */
export function createTerrainDepthMaterial(uniforms: TerrainUniforms): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.customProgramCacheKey = () => 'bos-terrain-depth-v1';
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', VERTEX_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainWorld;
        varying float vTerrainLevel;
        varying float vTerrainMorph;
        varying float vTerrainDist;`);
  };
  return depth;
}
