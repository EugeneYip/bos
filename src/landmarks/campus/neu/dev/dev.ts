/**
 * Throwaway preview scene for the Northeastern landmarks — NOT part of the
 * landmark system, NOT imported by anything else. Exists only so this module
 * can be visually iterated before `registry.ts` (owned by another agent)
 * wires `NEU_LANDMARKS` in for real.
 *
 * Boots a minimal fake `Ctx` (same trick as `src/materials/qa/inspector.ts`),
 * builds the real NEU_LANDMARKS entries, places them at their true world
 * coordinates exactly like `Landmarks.ts` would, and frames a camera from a
 * `?view=` query param — `qa` reproduces `qa/viewpoints.json`'s "northeastern"
 * shot exactly so this is a faithful preview of the real capture.
 *
 *   /src/landmarks/campus/neu/dev/dev.html?view=qa
 *   ?view=snell | churchill | richards | quad | quad-high | matthews |
 *         matthews-wide | lod-far | wintest
 *
 * Driven by `shoot-neu.mjs` in this same directory (a throwaway puppeteer
 * driver, not a repo-wide qa/ script):
 *   node src/landmarks/campus/neu/dev/shoot-neu.mjs qa snell churchill ...
 */
import * as THREE from 'three';
import type { Ctx } from '../../../../core/Context';
import { QUALITY, RENDER } from '../../../../core/config';
import { lonLatToWorld } from '../../../../core/geo';
import { NEU_LANDMARKS } from '../../northeastern';
import { Builder, prism, countTriangles } from '../../../lib/geom';
import { windowOpening } from '../../../lib/curtainwall';
import { materialsFor } from '../../../lib/materials';
import { rect } from '../../../lib/util';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'qa';
console.log('[neu-dev] url=', location.href, 'view=', view);

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const W = window.innerWidth || 1600;
const H = window.innerHeight || 900;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = RENDER.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb6d9);
const camera = new THREE.PerspectiveCamera(RENDER.fov, W / H, 0.5, 20000);

/* --------------------------------------------------------------- sun/env */

const sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize();
const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
sun.position.copy(sunDir).multiplyScalar(600);
sun.target.position.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 900;
sun.shadow.camera.left = -220;
sun.shadow.camera.right = 220;
sun.shadow.camera.top = 220;
sun.shadow.camera.bottom = -220;
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbcd6ee, 0x3a3630, 0.9));

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
function bakeEnv(): THREE.Texture {
  const envScene = new THREE.Scene();
  const grad = new THREE.Mesh(
    new THREE.SphereGeometry(500, 24, 16),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  );
  const ctx2d = document.createElement('canvas');
  ctx2d.width = 2;
  ctx2d.height = 64;
  const g = ctx2d.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, '#bfe0ff');
  grd.addColorStop(0.55, '#7fa8d8');
  grd.addColorStop(1, '#54606c');
  g.fillStyle = grd;
  g.fillRect(0, 0, 2, 64);
  const tex = new THREE.CanvasTexture(ctx2d);
  (grad.material as THREE.MeshBasicMaterial).map = tex;
  envScene.add(grad);
  const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
  return rt.texture;
}

/* -------------------------------------------------------------- fake ctx */

const quality = QUALITY.high;
const listeners = new Map<string, Array<(p?: unknown) => void>>();
const envMap = bakeEnv();
const ctx = {
  scene,
  camera,
  renderer,
  clock: new THREE.Clock(),
  tier: 'high',
  quality,
  elapsed: 0,
  timeOfDay: 14.4,
  dayOfYear: 240,
  sun: {
    direction: sunDir.clone(),
    color: new THREE.Color(1, 0.95, 0.88),
    intensity: 1,
    elevation: Math.asin(sunDir.y),
    azimuth: 0,
  },
  sampleHeight: () => 0,
  envMap,
  aerial: null,
  exposure: RENDER.exposure,
  resolution: 1,
  lampField: null,
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
scene.environment = ctx.envMap;

/* ------------------------------------------------------------- ground --- */

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  new THREE.MeshStandardMaterial({ color: 0x6b6f63, roughness: 0.97 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------------------------------ place landmarks */

let triangles = 0;
const lods: THREE.LOD[] = [];
for (const lm of NEU_LANDMARKS) {
  const obj = lm.build(ctx);
  const [x, z] = lonLatToWorld(lm.lon, lm.lat);
  console.log(`[neu-dev] ${lm.slug} lon=${lm.lon} lat=${lm.lat} -> world (${x.toFixed(1)}, ${z.toFixed(1)})`);
  obj.position.set(x, 0, z);
  obj.rotation.y = lm.rotation;
  obj.updateMatrixWorld(true);
  scene.add(obj);
  triangles += (obj.userData.triangles as number) ?? 0;
  if (obj instanceof THREE.LOD) lods.push(obj);
}
console.log(`[neu-dev] placed ${NEU_LANDMARKS.length} landmarks, ~${(triangles / 1000).toFixed(1)}k tris @ LOD0`);

// Isolated sanity test: does windowOpening() actually show through a solid
// prism wall, or does the wall's own unbroken face occlude it? One wall,
// one window, nothing else.
if (view === 'wintest') {
  const M = materialsFor(ctx);
  const tb = new Builder();
  const brickT = M.surface('brick', { color: 0x8a3d2e, roughness: 0.9, tile: 2.1 });
  const glassT = M.litGlass(1, { color: 0x1c2530, roughness: 0.2, metalness: 0.2 }, 1);
  tb.add(prism(rect(10, 2), 0, 6, { cap: true }), brickT);
  const o = windowOpening(2.5, 3.5, 0.5, 1);
  tb.addAt(o.reveal, brickT, [0, 1.2, 1], 0);
  tb.addAt(o.glass, glassT, [0, 1.2, 1], 0);
  const testGroup = tb.build('wintest');
  testGroup.position.set(-2000, 0, 2000);
  scene.add(testGroup);
  camera.position.set(-2000, 2.5, 1990);
  camera.lookAt(-2000, 2.5, 2001);
  camera.fov = 45;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  renderer.render(scene, camera);
  (window as unknown as Record<string, unknown>).__ready = true;
  (window as unknown as Record<string, unknown>).__stats = { view, wintest: true };
} else {
  // One-time diagnostic: world position and triangle count of every named
  // top-level sub-group, so camera presets and the task report can use real
  // numbers instead of hand arithmetic.
  for (const lod of lods) {
    const lvl0 = (lod as unknown as { levels: { object: THREE.Object3D }[] }).levels[0]?.object;
    lvl0?.children.forEach((c) => {
      const wp = new THREE.Vector3();
      c.getWorldPosition(wp);
      console.log(
        `[neu-dev] "${lvl0.name}" > "${c.name}" world=${JSON.stringify(wp.toArray().map((n) => +n.toFixed(1)))} ` +
        `tris=${countTriangles(c)}`,
      );
    });
    console.log(`[neu-dev] "${lvl0?.name}" TOTAL tris=${countTriangles(lvl0!)}`);
  }

  /* ------------------------------------------------------------ camera -- */

  interface ViewDef { pos: [number, number, number]; look: [number, number, number]; fov?: number }

  // `qa` reproduces qa/viewpoints.json's "northeastern" entry exactly (world
  // metres, +X east/+Y up/+Z south — see lib/util.ts) for a direct comparison
  // with the real capture once this is wired into the registry.
  // World positions confirmed by the diagnostic dump above: Churchill Hall
  // (-1928,1847), Richards Hall (-1923,1725), Snell Library block (-1851,1886).
  const VIEWS: Record<string, ViewDef> = {
    qa: { pos: [-1790, 40, 1650], look: [-1953, 25, 1833] },
    quad: { pos: [-1970, 55, 1720], look: [-1880, 15, 1800], fov: 60 },
    'quad-high': { pos: [-1900, 140, 2000], look: [-1900, 0, 1780], fov: 55 },
    snell: { pos: [-1800, 12, 1860], look: [-1851, 10, 1886], fov: 55 },
    'snell-far': { pos: [-1770, 25, 1810], look: [-1851, 12, 1886], fov: 45 },
    churchill: { pos: [-1955, 10, 1810], look: [-1928, 8, 1847], fov: 55 },
    richards: { pos: [-1980, 16, 1690], look: [-1923, 8, 1725], fov: 55 },
    matthews: { pos: [-1600, 10, 1555], look: [-1560, 8, 1587], fov: 55 },
    'matthews-wide': { pos: [-1650, 45, 1450], look: [-1560, 8, 1587], fov: 60 },
    // Beyond the 900 m / 850 m LOD1 thresholds, to sanity-check the low-detail level.
    'lod-far': { pos: [-1200, 260, 2700], look: [-1854, 20, 1733], fov: 45 },
  };

  const v = VIEWS[view] ?? VIEWS.qa;
  camera.fov = v.fov ?? RENDER.fov;
  camera.position.set(...v.pos);
  camera.lookAt(...v.look);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  sun.target.position.set(v.look[0], 0, v.look[2]);
  sun.position.set(v.look[0] + sunDir.x * 600, sunDir.y * 600, v.look[2] + sunDir.z * 600);
  sun.target.updateMatrixWorld();

  // LOD level selection depends on distance-to-camera, so it can only happen
  // once the camera is actually where this view puts it.
  for (const lod of lods) lod.update(camera);

  console.log(
    `[neu-dev] view=${view} camera.pos=${JSON.stringify(camera.position.toArray())} ` +
    `fov=${camera.fov} quat=${JSON.stringify(camera.quaternion.toArray())} ` +
    `lookTarget=${JSON.stringify(v.look)} wantedPos=${JSON.stringify(v.pos)}`,
  );
  renderer.render(scene, camera);
  (window as unknown as Record<string, unknown>).__ready = true;
  (window as unknown as Record<string, unknown>).__stats = { triangles, view };
}
