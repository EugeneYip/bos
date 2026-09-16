import * as THREE from 'three';
import { App } from './core/App';
import { installDebugApi } from './core/debugApi';
import type { QualityTier } from './core/config';
import { Materials } from './materials/Materials';
import { Sky } from './sky/Sky';
import { Terrain } from './world/Terrain';
import { FarTerrain } from './world/FarTerrain';
import { Water } from './world/Water';
import { Roads } from './world/Roads';
import { Parks } from './world/Parks';
import { Buildings } from './world/Buildings';
import { Landmarks } from './landmarks/Landmarks';
import { Vegetation } from './world/Vegetation';
import { Props } from './world/Props';
import { Traffic } from './world/Traffic';
import { Transit } from './world/Transit';
import { Physics } from './physics/Physics';
import { CameraRig } from './controls/CameraRig';
import { Post } from './post/Post';
import { Hud } from './ui/Hud';

const boot = document.getElementById('boot')!;
const bar = document.querySelector<HTMLElement>('#bar i')!;
const status = document.getElementById('status')!;

function setProgress(label: string, frac: number): void {
  bar.style.width = `${Math.round(frac * 100)}%`;
  status.textContent = label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement;

  const params = new URLSearchParams(location.search);
  const tierParam = params.get('q') as QualityTier | null;
  const tier = tierParam && ['low', 'medium', 'high', 'ultra'].includes(tierParam) ? tierParam : undefined;

  const app = new App(canvas, tier);
  app.ctx.resolution = app.ctx.renderer.getPixelRatio();

  // Post takes over presentation, so it needs the App itself. Ctx deliberately
  // does not expose it, so the hand-over is explicit rather than a global.
  const post = new Post();
  post.attach(app);

  // Registration order is initialisation order: materials and terrain publish
  // capabilities that later modules read, and Post must wrap a finished scene.
  app.add(
    new Materials(),
    new Sky(),
    new Terrain(),
    new FarTerrain(),
    new Water(),
    new Parks(),
    new Roads(),
    // Landmarks before Buildings: `Landmarks.init` publishes the suppression
    // list that `Buildings` reads once, up front, to skip the OSM footprints it
    // replaces. Registered the other way round the list is still empty when
    // Buildings reads it and every hand-authored landmark is drawn twice.
    new Landmarks(),
    new Buildings(),
    new Vegetation(),
    new Props(),
    new Traffic(),
    // After Roads, which owns the rail network, and after Traffic, whose
    // established pattern (graph + instanced meshes + distance culling) this
    // follows for the trains that run on it.
    new Transit(),
    new Physics(),
    new CameraRig(),
    post,
    new Hud(),
  );

  await app.init(setProgress);
  installDebugApi(app);
  app.start();

  boot.classList.add('done');
  setTimeout(() => boot.remove(), 1100);

  // Expose for debugging and for the automated visual-QA harness.
  (window as unknown as Record<string, unknown>).__boston = app;
  (window as unknown as Record<string, unknown>).__THREE = THREE;
  (window as unknown as Record<string, unknown>).__ready = true;
}

main().catch((err) => {
  console.error(err);
  status.textContent = `failed to start: ${err?.message ?? err}`;
  status.style.color = '#e0736b';
});
