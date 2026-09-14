import { App } from './core/App';
import type { QualityTier } from './core/config';
import { Materials } from './materials/Materials';
import { Sky } from './sky/Sky';
import { Terrain } from './world/Terrain';
import { Water } from './world/Water';
import { Roads } from './world/Roads';
import { Buildings } from './world/Buildings';
import { Landmarks } from './landmarks/Landmarks';
import { Vegetation } from './world/Vegetation';
import { Props } from './world/Props';
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

  // Registration order is initialisation order: materials and terrain publish
  // capabilities that later modules read, and Post must wrap a finished scene.
  app.add(
    new Materials(),
    new Sky(),
    new Terrain(),
    new Water(),
    new Roads(),
    new Buildings(),
    new Landmarks(),
    new Vegetation(),
    new Props(),
    new Physics(),
    new CameraRig(),
    new Post(),
    new Hud(),
  );

  await app.init(setProgress);
  app.start();

  boot.classList.add('done');
  setTimeout(() => boot.remove(), 1100);

  // Expose for debugging and for the automated visual-QA harness.
  (window as unknown as Record<string, unknown>).__boston = app;
  (window as unknown as Record<string, unknown>).__ready = true;
}

main().catch((err) => {
  console.error(err);
  status.textContent = `failed to start: ${err?.message ?? err}`;
  status.style.color = '#e0736b';
});
