/**
 * The terrain surface library.
 *
 * Seven ground materials are baked into two `sampler2DArray`s so the splat
 * shader can blend any of them through a single sampler with a dynamic layer
 * index — no combinatorial shader permutations, no seven-sampler uniform block.
 *
 *   layer 0 albedo array : RGB = sRGB-encoded albedo, A = linear roughness
 *   layer 1 normal array : RG  = tangent-space slope, B = AO, A = height
 *
 * The Materials module owns the city's shared PBR library, but it is being
 * written concurrently and `ctx.materials.textures()` legitimately returns
 * `undefined` while it boots. So every layer has a procedural fallback that is
 * good enough to ship on its own, and adoption of a real texture set is a
 * per-layer, fully-guarded upgrade rather than a dependency.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '../../core/Context';
import { NOISE_GLSL } from './glsl/noise';

export const LAYER_NAMES = [
  'grass', 'dirt', 'gravel', 'sand', 'asphalt', 'concrete_sidewalk', 'mulch',
] as const;
export const LAYER_COUNT = LAYER_NAMES.length;

/** Default world metres covered by one texture repeat, per layer. */
const DEFAULT_TILE = [3.1, 3.7, 2.3, 2.7, 4.3, 3.5, 2.9];

const VERT = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;

uniform float uLayer;
uniform float uOutput;      // 0 = albedo+roughness, 1 = normal+ao+height
uniform float uAdopt;       // 1 = sample the supplied maps instead of generating
uniform float uUvScale;
uniform sampler2D uSrcMap;
uniform sampler2D uSrcNormal;
uniform sampler2D uSrcRough;
uniform sampler2D uSrcAo;
uniform float uHasNormal;
uniform float uHasRough;
uniform float uHasAo;

${NOISE_GLSL}

struct Surf { vec3 albedo; float rough; float height; float ao; };

// ---------------------------------------------------------------- grass ----
Surf sGrass(vec2 uv) {
  float clump = bosFbm(uv * 7.0, 7.0, 4, 0.5);
  float blade = bosFbm(uv * 74.0, 74.0, 3, 0.55);
  float fine  = bosValue(uv * 190.0, 190.0);
  float dry   = smoothstep(0.44, 0.78, bosFbm(uv * 3.0 + 11.0, 3.0, 3, 0.5));
  float bare  = smoothstep(0.72, 0.93, bosFbm(uv * 5.0 + 31.0, 5.0, 3, 0.5));

  vec3 deep = vec3(0.208, 0.302, 0.129);
  vec3 lit  = vec3(0.400, 0.506, 0.220);
  vec3 dryC = vec3(0.545, 0.522, 0.318);
  vec3 soil = vec3(0.318, 0.259, 0.176);

  vec3 c = mix(deep, lit, blade * 0.75 + clump * 0.35);
  c = mix(c, dryC, dry * 0.55);
  c = mix(c, soil, bare * 0.7);
  c *= 0.88 + 0.24 * fine;

  Surf s;
  s.albedo = c;
  s.rough = 0.90 - 0.06 * dry;
  s.height = clump * 0.55 + blade * 0.4 + fine * 0.08;
  s.ao = 0.62 + 0.38 * (clump * 0.4 + blade * 0.6);
  return s;
}

// ----------------------------------------------------------------- dirt ----
Surf sDirt(vec2 uv) {
  float lump = bosFbm(uv * 9.0, 9.0, 4, 0.55);
  float grain = bosFbm(uv * 120.0, 120.0, 2, 0.5);
  vec3 peb = bosVoronoi(uv * 30.0, 30.0);
  float pebble = smoothstep(0.30, 0.10, peb.x) * step(0.55, peb.z);
  float crack = smoothstep(0.06, 0.0, bosVoronoi(uv * 14.0, 14.0).y);

  vec3 dark = vec3(0.239, 0.180, 0.122);
  vec3 mid  = vec3(0.400, 0.302, 0.196);
  vec3 pale = vec3(0.545, 0.435, 0.306);

  vec3 c = mix(dark, mid, lump);
  c = mix(c, pale, smoothstep(0.55, 0.95, lump) * 0.6);
  c = mix(c, vec3(0.45, 0.43, 0.40), pebble * 0.7);
  c *= 1.0 - crack * 0.35;
  c *= 0.9 + 0.2 * grain;

  Surf s;
  s.albedo = c;
  s.rough = 0.95 - pebble * 0.12;
  s.height = lump * 0.6 + pebble * 0.35 + grain * 0.08 - crack * 0.25;
  s.ao = 0.55 + 0.45 * lump - crack * 0.3;
  return s;
}

// --------------------------------------------------------------- gravel ----
Surf sGravel(vec2 uv) {
  vec3 v = bosVoronoi(uv * 26.0, 26.0);
  vec3 v2 = bosVoronoi(uv * 55.0, 55.0);
  float stone = smoothstep(0.44, 0.06, v.x);
  float chip = smoothstep(0.30, 0.05, v2.x) * 0.5;
  float dust = bosFbm(uv * 90.0, 90.0, 2, 0.5);

  float tone = 0.42 + 0.46 * v.z;
  vec3 c = vec3(tone * 0.98, tone * 0.96, tone * 0.92);
  c = mix(vec3(0.298, 0.286, 0.267), c, stone);
  c = mix(c, vec3(0.62, 0.60, 0.57), chip * 0.5);
  c *= 0.88 + 0.22 * dust;

  Surf s;
  s.albedo = c;
  s.rough = 0.84 - stone * 0.08;
  s.height = stone * 0.7 + chip * 0.3 + dust * 0.1;
  s.ao = 0.45 + 0.55 * (stone * 0.8 + chip * 0.2);
  return s;
}

// ----------------------------------------------------------------- sand ----
Surf sSand(vec2 uv) {
  float ripple = 0.5 + 0.5 * sin((uv.x * 34.0 + bosFbm(uv * 4.0, 4.0, 3, 0.5) * 9.0) * 6.2831853);
  float dune = bosFbm(uv * 5.0, 5.0, 4, 0.5);
  float grain = bosValue(uv * 260.0, 260.0);
  float shell = smoothstep(0.90, 0.98, bosValue(uv * 70.0, 70.0));

  vec3 pale = vec3(0.784, 0.706, 0.549);
  vec3 warm = vec3(0.655, 0.565, 0.404);
  vec3 c = mix(warm, pale, dune * 0.6 + ripple * 0.35);
  c = mix(c, vec3(0.87, 0.85, 0.80), shell * 0.6);
  c *= 0.93 + 0.14 * grain;

  Surf s;
  s.albedo = c;
  s.rough = 0.74;
  s.height = ripple * 0.22 + dune * 0.6 + grain * 0.05;
  s.ao = 0.78 + 0.22 * ripple;
  return s;
}

// -------------------------------------------------------------- asphalt ----
Surf sAsphalt(vec2 uv) {
  vec3 agg = bosVoronoi(uv * 62.0, 62.0);
  float stone = smoothstep(0.34, 0.10, agg.x);
  float wear = bosFbm(uv * 3.5, 3.5, 4, 0.55);
  float scar = smoothstep(0.58, 0.80, bosFbm(uv * 2.2 + 7.0, 2.2, 3, 0.5));
  float grit = bosFbm(uv * 150.0, 150.0, 2, 0.5);

  vec3 tar = vec3(0.137, 0.137, 0.145);
  vec3 worn = vec3(0.302, 0.298, 0.294);
  vec3 c = mix(tar, worn, wear * 0.8);
  c = mix(c, vec3(0.40 + 0.16 * agg.z, 0.39 + 0.15 * agg.z, 0.37 + 0.14 * agg.z), stone * 0.55);
  c = mix(c, tar * 1.1, scar * 0.5);
  c *= 0.92 + 0.16 * grit;

  Surf s;
  s.albedo = c;
  s.rough = 0.78 - wear * 0.14 + scar * 0.06;
  s.height = stone * 0.45 + grit * 0.15 + wear * 0.2;
  s.ao = 0.72 + 0.28 * stone;
  return s;
}

// ------------------------------------------------------------- concrete ----
Surf sConcrete(vec2 uv) {
  float mottle = bosFbm(uv * 4.0, 4.0, 5, 0.55);
  float stain = smoothstep(0.52, 0.85, bosFbm(uv * 1.8 + 19.0, 1.8, 3, 0.5));
  float pit = smoothstep(0.86, 0.99, bosValue(uv * 110.0, 110.0));
  float grain = bosFbm(uv * 220.0, 220.0, 2, 0.5);
  float crack = smoothstep(0.035, 0.0, bosVoronoi(uv * 6.0, 6.0).y) * 0.6;

  vec3 pale = vec3(0.667, 0.659, 0.635);
  vec3 grey = vec3(0.482, 0.478, 0.467);
  vec3 c = mix(grey, pale, mottle);
  c = mix(c, grey * 0.82, stain * 0.5);
  c *= 1.0 - crack * 0.4;
  c *= 0.94 + 0.12 * grain;
  c = mix(c, c * 0.6, pit * 0.7);

  Surf s;
  s.albedo = c;
  s.rough = 0.70 + stain * 0.12 + pit * 0.1;
  s.height = mottle * 0.25 + grain * 0.06 - pit * 0.5 - crack * 0.4;
  s.ao = 0.85 - pit * 0.4 - crack * 0.3;
  return s;
}

// ---------------------------------------------------------------- mulch ----
Surf sMulch(vec2 uv) {
  vec3 leaf = bosVoronoi(uv * 22.0, 22.0);
  vec3 leaf2 = bosVoronoi(uv * 40.0 + 5.0, 40.0);
  float flake = smoothstep(0.42, 0.05, leaf.x);
  float flake2 = smoothstep(0.32, 0.04, leaf2.x);
  float litter = bosFbm(uv * 70.0, 70.0, 3, 0.5);
  float damp = bosFbm(uv * 3.0, 3.0, 3, 0.5);

  vec3 dark = vec3(0.149, 0.110, 0.075);
  vec3 brown = vec3(0.318, 0.220, 0.133);
  vec3 rust = vec3(0.451, 0.259, 0.125);
  vec3 c = mix(dark, brown, flake);
  c = mix(c, rust, flake2 * step(0.62, leaf2.z) * 0.8);
  c = mix(c, dark * 0.8, damp * 0.4);
  c *= 0.88 + 0.24 * litter;

  Surf s;
  s.albedo = c;
  s.rough = 0.93;
  s.height = flake * 0.6 + flake2 * 0.3 + litter * 0.12;
  s.ao = 0.42 + 0.58 * (flake * 0.7 + flake2 * 0.3);
  return s;
}

Surf surfaceAt(vec2 uv) {
  int l = int(uLayer + 0.5);
  if (l == 0) return sGrass(uv);
  if (l == 1) return sDirt(uv);
  if (l == 2) return sGravel(uv);
  if (l == 3) return sSand(uv);
  if (l == 4) return sAsphalt(uv);
  if (l == 5) return sConcrete(uv);
  return sMulch(uv);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  if (uAdopt > 0.5) {
    vec2 suv = uv * uUvScale;
    if (uOutput < 0.5) {
      vec3 alb = texture(uSrcMap, suv).rgb;
      float r = uHasRough > 0.5 ? texture(uSrcRough, suv).g : 0.85;
      fragColor = vec4(alb, r);
    } else {
      vec2 n = uHasNormal > 0.5 ? texture(uSrcNormal, suv).xy : vec2(0.5);
      float ao = uHasAo > 0.5 ? texture(uSrcAo, suv).r : 1.0;
      fragColor = vec4(n, ao, 0.5);
    }
    return;
  }

  if (uOutput < 0.5) {
    Surf s = surfaceAt(uv);
    // Albedo is authored in linear and stored sRGB-encoded; the terrain shader
    // decodes once after blending, which is both cheaper and more faithful than
    // blending in linear.
    fragColor = vec4(linearToSrgb(s.albedo), clamp(s.rough, 0.03, 1.0));
  } else {
    float e = 1.0 / 512.0;
    Surf c = surfaceAt(uv);
    float hx = surfaceAt(uv + vec2(e, 0.0)).height;
    float hy = surfaceAt(uv + vec2(0.0, e)).height;
    // Slope in tile space; the terrain shader rescales by the tile size.
    vec2 slope = vec2(c.height - hx, c.height - hy) * 9.0;
    fragColor = vec4(clamp(slope * 0.5 + 0.5, 0.0, 1.0), clamp(c.ao, 0.0, 1.0), clamp(c.height, 0.0, 1.0));
  }
}
`;

export interface SurfaceLibrary {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** World metres per repeat, one per layer. */
  tiles: Float32Array;
  adopted: string[];
  bytes: number;
  dispose(): void;
}

export function bakeSurfaces(
  renderer: THREE.WebGLRenderer,
  materials: MaterialLibrary | undefined,
  res: number,
  anisotropy: number,
): SurfaceLibrary {
  const opts: THREE.RenderTargetOptions = {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  };
  const albedoRT = new THREE.WebGLArrayRenderTarget(res, res, LAYER_COUNT, opts);
  const normalRT = new THREE.WebGLArrayRenderTarget(res, res, LAYER_COUNT, opts);
  for (const rt of [albedoRT, normalRT]) {
    rt.texture.wrapS = THREE.RepeatWrapping;
    rt.texture.wrapT = THREE.RepeatWrapping;
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    rt.texture.anisotropy = anisotropy;
    rt.texture.generateMipmaps = false;
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uLayer: { value: 0 },
    uOutput: { value: 0 },
    uAdopt: { value: 0 },
    uUvScale: { value: 1 },
    uSrcMap: { value: null },
    uSrcNormal: { value: null },
    uSrcRough: { value: null },
    uSrcAo: { value: null },
    uHasNormal: { value: 0 },
    uHasRough: { value: 0 },
    uHasAo: { value: 0 },
  };
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const tiles = new Float32Array(DEFAULT_TILE);
  const adopted: string[] = [];
  const prevTarget = renderer.getRenderTarget();

  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const name = LAYER_NAMES[layer];
    // `textures()` hands back the family's TextureSet, but its maps are not
    // guaranteed to have been baked yet — sampling them here yields black,
    // which is why the whole city rendered as bare concrete. Asking for the
    // *material* forces the bake and gives maps that definitely have pixels;
    // the set is still the source of truth for the physical tile size.
    //
    // Note what this means for everything above: when a layer's name matches
    // a family in the shared library -- and all seven of them do -- the
    // terrain *adopts* that family's texture and the procedural `sGrass`,
    // `sAsphalt`, `sConcrete` and friends are never sampled. They are the
    // fallback for a library that failed to bake, not the surfaces you see.
    //
    // This cost two sessions. Logan's infield reads as a pale sheet against
    // near-black runways, and the hunt for it tinted the procedural gravel,
    // then asphalt, then concrete, then all seven layers at once in debug
    // colours -- and the airfield did not change by a pixel in any of them,
    // which read as proof that the surface was not the terrain at all. It
    // was: it just gets its albedo from `materials/Materials.ts`. Change the
    // family there, not the function here.
    let set: ReturnType<MaterialLibrary['textures']>;
    let mat: THREE.MeshStandardMaterial | undefined;
    try {
      mat = materials?.get(name) as THREE.MeshStandardMaterial | undefined;
      set = materials?.textures(name);
    } catch {
      set = undefined;
      mat = undefined;
    }
    const map = mat?.map ?? set?.map ?? null;
    const usable = !!map && Number.isFinite(set?.tileMeters) && (set!.tileMeters ?? 0) > 0.05;

    uniforms.uLayer.value = layer;
    if (usable) {
      const s = set!;
      adopted.push(name);
      tiles[layer] = s.tileMeters;
      uniforms.uAdopt.value = 1;
      uniforms.uUvScale.value = 1;
      uniforms.uSrcMap.value = map;
      uniforms.uSrcNormal.value = mat?.normalMap ?? s.normalMap ?? null;
      uniforms.uSrcRough.value = mat?.roughnessMap ?? s.roughnessMap ?? null;
      uniforms.uSrcAo.value = mat?.aoMap ?? s.aoMap ?? null;
      uniforms.uHasNormal.value = (mat?.normalMap ?? s.normalMap) ? 1 : 0;
      uniforms.uHasRough.value = (mat?.roughnessMap ?? s.roughnessMap) ? 1 : 0;
      uniforms.uHasAo.value = (mat?.aoMap ?? s.aoMap) ? 1 : 0;
    } else {
      uniforms.uAdopt.value = 0;
      uniforms.uSrcMap.value = null;
      uniforms.uSrcNormal.value = null;
      uniforms.uSrcRough.value = null;
      uniforms.uSrcAo.value = null;
    }

    uniforms.uOutput.value = 0;
    renderer.setRenderTarget(albedoRT, layer);
    renderer.render(scene, cam);
    uniforms.uOutput.value = 1;
    renderer.setRenderTarget(normalRT, layer);
    renderer.render(scene, cam);
  }

  renderer.setRenderTarget(prevTarget);
  generateArrayMipmaps(renderer, albedoRT.texture);
  generateArrayMipmaps(renderer, normalRT.texture);

  quad.geometry.dispose();
  mat.dispose();

  const bytes = Math.round(res * res * 4 * LAYER_COUNT * 2 * 1.34);
  return {
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    tiles,
    adopted,
    bytes,
    dispose(): void {
      albedoRT.dispose();
      normalRT.dispose();
    },
  };
}

/**
 * three's `updateRenderTargetMipmap` hard-codes TEXTURE_2D, so a layered render
 * target never gets a mip chain through the normal path. Without mips the
 * ground shimmers violently at distance, so we build them by hand and hand the
 * state cache back to the renderer afterwards.
 */
function generateArrayMipmaps(renderer: THREE.WebGLRenderer, texture: THREE.Texture): void {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const props = (renderer.properties as unknown as {
    get(o: unknown): { __webglTexture?: WebGLTexture };
  }).get(texture);
  const handle = props?.__webglTexture;
  if (!handle) return;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  renderer.resetState();
}
