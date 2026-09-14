/**
 * Material inspector.
 *
 * A six-panel contact sheet for one surface family, rendered through exactly
 * the renderer configuration the app uses (ACES Filmic, exposure 0.78, sRGB
 * output) under a physically-plausible sky IBL. Driven by `qa/shoot-mat.mjs`:
 *
 *   /src/materials/qa/inspector.html?m=brick
 *   /src/materials/qa/inspector.html?grid=1        contact sheet, every family
 *
 * The panels answer the six questions the critic asks of every surface:
 *
 *   1  close sphere      — does the microsurface read at 2 m?
 *   2  frontal panel     — texel density, mortar/joint scale, colour
 *   3  grazing + raking  — is the relief real, or a painted-on normal map?
 *   4  80 m field        — does the UV tile show as a lattice?
 *   5  80 m anti-tiled   — does the anti-tiling helper fix it?
 *   6  IBL only          — specular response with no key light (glass, gold)
 *
 * UVs are generated in world metres divided by the family's `tileMeters`,
 * which is exactly how the real modules must do it.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { QUALITY, RENDER, type QualityTier } from '../../core/config';
import { Materials, MATERIAL_NAMES, antiTilingPreset } from '../Materials';

const W = 1680;
const H = 960;
const COLS = 3;
const ROWS = 2;
const PW = W / COLS;
const PH = H / ROWS;

const params = new URLSearchParams(location.search);
const tier = (params.get('q') as QualityTier) ?? 'ultra';
const wanted = params.get('m') ?? 'brick';
const gridMode = params.get('grid') === '1';

// ------------------------------------------------------------- renderer ----

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = RENDER.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, PW / PH, 0.05, 4000);

// ------------------------------------------------------------------ sky ----

/**
 * A cheap analytic sky: Rayleigh-ish zenith-to-horizon gradient, a warm
 * horizon band, a sun disc with limb falloff, and a dim ground bounce. Good
 * enough that a reflective curtain wall has something real to reflect.
 */
const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSun;
uniform float uTurb;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  vec3 zenith = vec3(0.075, 0.145, 0.30);
  vec3 horizon = vec3(0.52, 0.60, 0.70);
  vec3 ground = vec3(0.085, 0.082, 0.072);
  float t = pow(clamp(up, 0.0, 1.0), 0.42);
  vec3 sky = mix(horizon, zenith, t);
  float mu = max(dot(d, normalize(uSun)), 0.0);
  // Mie forward scattering halo around the sun.
  sky += vec3(0.95, 0.78, 0.52) * pow(mu, 7.0) * 0.65 * uTurb;
  sky += vec3(1.0, 0.92, 0.80) * pow(mu, 900.0) * 60.0;      // the disc itself
  sky = mix(ground, sky, smoothstep(-0.06, 0.035, up));
  gl_FragColor = vec4(sky, 1.0);
}`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const sunDir = new THREE.Vector3(0.45, 0.58, 0.68).normalize();
const skyMat = new THREE.ShaderMaterial({
  vertexShader: SKY_VERT,
  fragmentShader: SKY_FRAG,
  uniforms: { uSun: { value: sunDir }, uTurb: { value: 1.0 } },
  side: THREE.BackSide,
  depthWrite: false,
  toneMapped: false,
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 32), skyMat);
skyMesh.frustumCulled = false;
scene.add(skyMesh);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

function bakeEnv(): THREE.Texture {
  const envScene = new THREE.Scene();
  const probe = new THREE.Mesh(skyMesh.geometry, skyMat);
  probe.frustumCulled = false;
  envScene.add(probe);
  const rt = pmrem.fromScene(envScene, 0, 0.5, 2000);
  return rt.texture;
}

const sun = new THREE.DirectionalLight(0xfff2e0, 3.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 400;
sun.shadow.camera.left = -60;
sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;
sun.shadow.camera.bottom = -60;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// -------------------------------------------------------------- fake ctx ----

const quality = QUALITY[tier] ?? QUALITY.ultra;
const listeners = new Map<string, Array<(p?: unknown) => void>>();
const ctx = {
  scene,
  camera,
  renderer,
  clock: new THREE.Clock(),
  tier,
  quality,
  elapsed: 0,
  timeOfDay: 15,
  dayOfYear: 180,
  sun: {
    direction: sunDir.clone(),
    color: new THREE.Color(1, 0.95, 0.88),
    intensity: 1,
    elevation: Math.asin(sunDir.y),
    azimuth: 0,
  },
  sampleHeight: () => 0,
  envMap: null as THREE.Texture | null,
  materials: {
    textures: () => undefined,
    get: () => new THREE.MeshStandardMaterial(),
    register: () => {},
  },
  stats: {} as Record<string, number | string>,
  on: (evt: string, fn: (p?: unknown) => void) => {
    const a = listeners.get(evt) ?? [];
    a.push(fn);
    listeners.set(evt, a);
  },
  emit: (evt: string, p?: unknown) => {
    for (const fn of listeners.get(evt) ?? []) fn(p);
  },
} satisfies Ctx;

const mats = new Materials();
mats.init(ctx);
ctx.envMap = bakeEnv();
scene.environment = ctx.envMap;

// ------------------------------------------------------------ geometry ----

/** Scale a geometry's UVs so one texture tile spans `tileMeters` of world. */
function scaleUv(geo: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

function plane(w: number, h: number, tile: number, seg = 1): THREE.BufferGeometry {
  return scaleUv(new THREE.PlaneGeometry(w, h, seg, seg), w / tile, h / tile);
}

function sphere(r: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 128, 96);
  return scaleUv(g, (2 * Math.PI * r) / tile, (Math.PI * r) / tile);
}

function tangents(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // Non-indexed tangents are required for a stable TBN on the grazing plane.
  try {
    g.computeTangents();
  } catch {
    /* PlaneGeometry sometimes lacks the index three wants; three falls back */
  }
  return g;
}

// --------------------------------------------------------------- panels ----

interface Panel {
  label: string;
  build(mat: THREE.Material, tile: number, sunElev: number): THREE.Object3D;
  camera(): { pos: THREE.Vector3; look: THREE.Vector3; fov: number };
  sunElevation: number;
  /** Sun azimuth relative to the view, radians. */
  sunAzimuth: number;
  keyLight: boolean;
}

const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshStandardMaterial({ color: 0x4a5158, roughness: 0.96 }),
);
backdrop.rotation.x = -Math.PI / 2;
backdrop.receiveShadow = true;

const PANELS: Panel[] = [
  {
    label: '1 · sphere r=1 m @ 2.6 m · sun 38°',
    sunElevation: 0.66,
    sunAzimuth: -0.9,
    keyLight: true,
    build: (mat, tile) => {
      const m = new THREE.Mesh(tangents(sphere(1, tile)), mat);
      m.castShadow = true;
      const g = new THREE.Group();
      const floor = new THREE.Mesh(plane(24, 24, 4), new THREE.MeshStandardMaterial({ color: 0x3d434a, roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.02;
      floor.receiveShadow = true;
      g.add(m, floor);
      return g;
    },
    camera: () => ({ pos: new THREE.Vector3(0.15, 0.45, 2.85), look: new THREE.Vector3(0, 0, 0), fov: 38 }),
  },
  {
    label: '2 · flat 3×3 m @ 3.4 m · frontal',
    sunElevation: 0.72,
    sunAzimuth: -0.55,
    keyLight: true,
    build: (mat, tile) => new THREE.Mesh(tangents(plane(3, 3, tile)), mat),
    camera: () => ({ pos: new THREE.Vector3(0, 0, 3.45), look: new THREE.Vector3(0, 0, 0), fov: 46 }),
  },
  {
    label: '3 · grazing 4×26 m · raking sun 7°',
    sunElevation: 0.122,
    sunAzimuth: -1.35,
    keyLight: true,
    build: (mat, tile) => {
      const m = new THREE.Mesh(tangents(plane(4, 26, tile, 2)), mat);
      m.rotation.x = -Math.PI / 2;
      m.receiveShadow = true;
      return m;
    },
    camera: () => ({ pos: new THREE.Vector3(0, 1.15, 12.2), look: new THREE.Vector3(0, 0.0, -2.0), fov: 42 }),
  },
  {
    label: '4 · 50×300 m receding, 4 m → 250 m · RAW (tile lattice)',
    sunElevation: 0.60,
    sunAzimuth: -0.8,
    keyLight: true,
    build: (mat, tile) => {
      const m = new THREE.Mesh(plane(50, 300, tile, 16), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.z = -146;
      m.receiveShadow = true;
      return m;
    },
    camera: () => ({ pos: new THREE.Vector3(0, 4.0, 6.0), look: new THREE.Vector3(0, 0.9, -60), fov: 52 }),
  },
  {
    label: '5 · same · applyAntiTiling()',
    sunElevation: 0.60,
    sunAzimuth: -0.8,
    keyLight: true,
    build: (mat, tile) => {
      const m = new THREE.Mesh(plane(50, 300, tile, 16), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.z = -146;
      m.receiveShadow = true;
      return m;
    },
    camera: () => ({ pos: new THREE.Vector3(0, 4.0, 6.0), look: new THREE.Vector3(0, 0.9, -60), fov: 52 }),
  },
  {
    label: '6 · IBL only, no key light · specular response',
    sunElevation: 0.66,
    sunAzimuth: -0.9,
    keyLight: false,
    build: (mat, tile) => {
      const g = new THREE.Group();
      const s = new THREE.Mesh(tangents(sphere(1, tile)), mat);
      const p = new THREE.Mesh(tangents(plane(2.2, 2.2, tile)), mat);
      p.position.set(2.0, 0, -0.6);
      p.rotation.y = -0.55;
      g.add(s, p);
      return g;
    },
    camera: () => ({ pos: new THREE.Vector3(0.9, 0.5, 3.4), look: new THREE.Vector3(0.55, 0, 0), fov: 44 }),
  },
];

// ----------------------------------------------------------------- draw ----

const panelRoot = new THREE.Group();
scene.add(panelRoot);

function placeSun(elev: number, azim: number): void {
  const d = new THREE.Vector3(Math.cos(elev) * Math.sin(azim), Math.sin(elev), Math.cos(elev) * Math.cos(azim));
  sunDir.copy(d).normalize();
  sun.position.copy(sunDir).multiplyScalar(180);
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  (skyMat.uniforms.uSun.value as THREE.Vector3).copy(sunDir);
  // Warmer and dimmer at low elevation, the way real sunlight behaves.
  const alt = Math.max(Math.sin(elev), 0.02);
  sun.intensity = (keyOn ? 3.2 : 0) * Math.pow(alt, 0.35);
  sun.color.setRGB(1, 0.93 - (1 - alt) * 0.16, 0.84 - (1 - alt) * 0.34);
}

let keyOn = true;

function renderPanel(p: Panel, mat: THREE.Material, tile: number, col: number, row: number): void {
  panelRoot.clear();
  const obj = p.build(mat, tile, p.sunElevation);
  panelRoot.add(obj);

  keyOn = p.keyLight;
  placeSun(p.sunElevation, p.sunAzimuth);

  const c = p.camera();
  camera.fov = c.fov;
  camera.aspect = PW / PH;
  camera.position.copy(c.pos);
  camera.lookAt(c.look);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const x = col * PW;
  const y = H - (row + 1) * PH;
  renderer.setViewport(x, y, PW, PH);
  renderer.setScissor(x, y, PW, PH);
  renderer.setScissorTest(true);
  renderer.render(scene, camera);
}

function labelPanels(labels: string[]): void {
  const wrap = document.getElementById('wrap')!;
  for (const el of [...wrap.querySelectorAll('.tag')]) el.remove();
  labels.forEach((text, i) => {
    const d = document.createElement('div');
    d.className = 'tag';
    d.textContent = text;
    d.style.left = `${(i % COLS) * PW + 8}px`;
    d.style.top = `${Math.floor(i / COLS) * PH + 8}px`;
    wrap.appendChild(d);
  });
}

// ----------------------------------------------------------------- main ----

interface Shot { name: string }

function familyInfo(name: string): { tile: number; res: number } {
  const set = mats.textures(name);
  const img = set?.map.image as { width?: number } | undefined;
  return { tile: set?.tileMeters ?? 1, res: img?.width ?? 0 };
}

function drawOne(name: string): void {
  const mat = mats.get(name);
  const { tile, res } = familyInfo(name);
  const tiled = mats.tiled(name);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();

  PANELS.forEach((p, i) => {
    renderPanel(p, i === 4 ? tiled : mat, tile, i % COLS, Math.floor(i / COLS));
  });
  renderer.setScissorTest(false);

  labelPanels(PANELS.map((p) => p.label));
  const preset = antiTilingPreset(name);
  const bar = document.getElementById('title')!;
  bar.innerHTML =
    `<b>${name}</b>` +
    `<span>tile <em>${tile.toFixed(3)} m</em></span>` +
    `<span>bake <em>${res}²</em></span>` +
    `<span>texel <em>${((tile / Math.max(res, 1)) * 1000).toFixed(2)} mm</em></span>` +
    `<span>aniso <em>${quality.anisotropy}×</em></span>` +
    `<span>vram <em>${ctx.stats['mat.vram'] ?? '—'}</em></span>` +
    `<span>anti-tile <em>${preset.hex ? 'hex+macro' : 'macro only'}</em></span>` +
    `<span>tier <em>${tier}</em></span>`;
}

/** Contact sheet: one lit sphere per family, 7 columns. */
function drawGrid(): void {
  const names = MATERIAL_NAMES.filter((n) => !n.includes('_') || true);
  const uniq = [...new Set(names.map((n) => n))];
  const cols = 8;
  const cell = W / cols;
  const rows = Math.ceil(uniq.length / cols);
  const ch = Math.min(cell, H / rows);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();

  keyOn = true;
  placeSun(0.66, -0.9);

  const wrap = document.getElementById('wrap')!;
  for (const el of [...wrap.querySelectorAll('.tag')]) el.remove();

  uniq.forEach((name, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const set = mats.textures(name);
    const tile = set?.tileMeters ?? 1;
    panelRoot.clear();
    const m = new THREE.Mesh(tangents(sphere(1, tile)), mats.get(name));
    panelRoot.add(m);

    camera.fov = 36;
    camera.aspect = 1;
    camera.position.set(0.1, 0.35, 2.95);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const x = col * cell;
    const y = H - (row + 1) * ch;
    renderer.setViewport(x, y, cell, ch);
    renderer.setScissor(x, y, cell, ch);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);

    const d = document.createElement('div');
    d.className = 'tag';
    d.textContent = name;
    d.style.left = `${x + 4}px`;
    d.style.top = `${row * ch + 4}px`;
    d.style.fontSize = '9px';
    wrap.appendChild(d);
  });
  renderer.setScissorTest(false);
  document.getElementById('title')!.innerHTML =
    `<b>all families</b><span>tier <em>${tier}</em></span><span>vram <em>${ctx.stats['mat.vram'] ?? '—'}</em></span>` +
    `<span>bake <em>${mats.bakeMs.toFixed(0)} ms</em></span><span>init <em>${mats.bootMs.toFixed(2)} ms</em></span>`;
}

const api = {
  names: () => [...MATERIAL_NAMES],
  show(name: string): Record<string, unknown> {
    drawOne(name);
    const { tile, res } = familyInfo(name);
    return { name, tile, res, vram: ctx.stats['mat.vram'], bakeMs: mats.bakeMs, bootMs: mats.bootMs };
  },
  grid(): Record<string, unknown> {
    drawGrid();
    return { vram: ctx.stats['mat.vram'], bakeMs: mats.bakeMs, bootMs: mats.bootMs };
  },
  stats: () => ({ ...ctx.stats, bakeMs: mats.bakeMs, bootMs: mats.bootMs, bytes: mats.bytes }),
  /** Filtering / colour-space sanity for a family, read straight off the GPU objects. */
  probe(name: string): Record<string, unknown> {
    const s = mats.textures(name);
    if (!s) return { name, missing: true };
    const t = s.map;
    const n = s.normalMap;
    return {
      name,
      maxAniso: renderer.capabilities.getMaxAnisotropy(),
      mapColorSpace: t.colorSpace,
      mapAniso: t.anisotropy,
      mapMinFilter: t.minFilter,
      mapGenerateMipmaps: t.generateMipmaps,
      mapWrap: [t.wrapS, t.wrapT],
      mapSize: (t.image as { width?: number })?.width,
      normalColorSpace: n?.colorSpace,
      normalAniso: n?.anisotropy,
      ormColorSpace: s.roughnessMap?.colorSpace,
      tileMeters: s.tileMeters,
    };
  },
};
(window as unknown as Record<string, unknown>).__mat = api;

if (gridMode) api.grid();
else api.show(wanted);
(window as unknown as Record<string, unknown>).__ready = true;

// Keep the canvas alive for interactive poking without burning the GPU.
let last = '';
setInterval(() => {
  const q = new URLSearchParams(location.search).get('m') ?? wanted;
  if (q !== last && !gridMode) {
    last = q;
  }
}, 1000);

export type { Shot };
