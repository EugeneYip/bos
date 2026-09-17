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

  // A lost GPU context is silent: no throw, no stopped animation frame, just
  // draw calls that quietly stop drawing. Say what happened instead of leaving
  // a dead canvas, and point at the two things that actually help.
  //
  // This builds its own panel rather than reusing the boot overlay, which is
  // removed from the DOM once loading finishes.
  app.onContextLost = (restorable) => {
    if (document.getElementById('lostctx')) return;
    const panel = document.createElement('div');
    panel.id = 'lostctx';
    panel.setAttribute('role', 'alert');
    panel.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:200', 'display:flex',
      'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:1.1rem', 'padding:2rem', 'text-align:center',
      'font:400 .82rem/1.7 ui-sans-serif,system-ui,sans-serif',
      'letter-spacing:.06em', 'color:#e8eef6',
      'background:radial-gradient(120% 90% at 50% 8%,#16283c 0%,#0a121c 45%,#05080c 100%)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'font-size:1.05rem;letter-spacing:.2em;text-transform:uppercase;color:#e0736b';
    head.textContent = restorable ? 'graphics context lost' : 'graphics context restored';

    const body = document.createElement('div');
    body.style.cssText = 'max-width:34rem;color:#9db3c9';
    body.textContent = restorable
      ? 'The browser took the GPU context away, which usually means it ran short of memory. '
        + 'Reloading will start again; the Low quality preset asks for a great deal less.'
      : 'The context came back, but the scene has to be rebuilt from scratch. Please reload.';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:.7rem;flex-wrap:wrap;justify-content:center';
    const button = (label: string, href: string): HTMLAnchorElement => {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      a.style.cssText = 'padding:.55rem 1.15rem;border:1px solid #2c4258;border-radius:999px;'
        + 'color:#cfe0f2;text-decoration:none;letter-spacing:.14em;text-transform:uppercase;font-size:.7rem';
      return a;
    };
    row.append(button('Reload', location.href));
    if (restorable) row.append(button('Reload on Low', `${location.pathname}?q=low`));

    panel.append(head, body, row);
    document.body.append(panel);
  };
  app.ctx.resolution = app.ctx.renderer.getPixelRatio();

  // Post takes over presentation, so it needs the App itself. Ctx deliberately
  // does not expose it, so the hand-over is explicit rather than a global.
  const post = new Post();
  post.attach(app);

  // Registration order is initialisation order: materials and terrain publish
  // capabilities that later modules read, and Post must wrap a finished scene.
  // What a degraded boot gives up, in the order it gives it up.
  //
  // Level 1 drops the things a visitor is least likely to miss on a phone and
  // that cost the most to build: rigid-body physics over 61,000 footprints,
  // and the rail network with its trains. Level 2 additionally drops street
  // furniture, the tree layer and all moving traffic, which leaves terrain,
  // water, roads, buildings and sky -- the city, and nothing that animates.
  const lvl = app.ctx.safeLevel;
  const keepHeavy = lvl < 1;
  const keepLively = lvl < 2;

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
    ...(keepLively ? [new Vegetation(), new Props()] : []),
    ...(keepLively ? [new Traffic()] : []),
    // After Roads, which owns the rail network, and after Traffic, whose
    // established pattern (graph + instanced meshes + distance culling) this
    // follows for the trains that run on it.
    ...(keepHeavy ? [new Transit(), new Physics()] : []),
    new CameraRig(),
    post,
    new Hud(),
  );

  await app.init(setProgress);
  installDebugApi(app);
  app.start();

  // Surviving this long is what marks the boot successful; see core/safeMode.
  app.ctx.safeMode.armStable();
  if (app.ctx.safeLevel > 0) {
    console.warn(`[safe] running at level ${app.ctx.safeLevel}`);
    status.textContent = `reduced detail after a failed load — reload with ?safe=0 to try the full model`;
  }

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
