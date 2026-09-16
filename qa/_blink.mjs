#!/usr/bin/env node
/**
 * Chases "the whole scene keeps blinking during ultra resolution".
 *
 * Measures frame-to-frame mean-luma swing both with the camera parked and
 * with it moving continuously (every real rendered frame, not a teleport +
 * settle), by wrapping `app.renderOverride` in-page so the sample taken is
 * exactly the frame that was just presented, with zero ambiguity about
 * ordering relative to the app's own rAF loop.
 *
 * Expects a QA build already served — this script does not spawn the server:
 *
 *   VITE_BASE=/ npx vite build --outDir dist-qa
 *   VITE_BASE=/ npx vite preview --port 4551 --strictPort --outDir dist-qa &
 *   node qa/_blink.mjs fly:commave --frames=90 --tier=ultra
 *   node qa/_blink.mjs static:commave --frames=40 --tier=ultra
 *   node qa/_blink.mjs fly:commave --frames=90 --post=taa,ao,bloom   # exposure off
 *   node qa/_blink.mjs fly:commave --frames=90 --post=ao,bloom,exposure  # taa off
 *
 * Path kinds (all eye/near-street level, chosen to stress tile + vegetation
 * streaming): commave (Commonwealth Ave mall, tree rows), common (Boston
 * Common path under canopy), downtown (Financial District, glass + SSR).
 * `static:<kind>` parks the camera at that path's start instead of moving it.
 *
 * Prints mean / stdev / peak-to-peak swing (as a % of mean) over the sampled
 * frames, in the same units as the harness numbers already on file, plus the
 * biggest single-frame jumps with a diff of every ctx.stats counter that
 * moved on that frame, so a luma jump can be attributed to a specific
 * subsystem rather than guessed at.
 */
import puppeteer from 'puppeteer';

const PORT = Number(process.env.QA_PORT || 4551);

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const p = argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : d;
};
const pathArg = argv.find((a) => !a.startsWith('--')) || 'fly:commave';
const [mode, kind] = pathArg.split(':');
const FRAMES = Number(flag('frames', 90));
const SETTLE = Number(flag('settle', 90));
const TIER = flag('tier', 'ultra');
const POST = flag('post', '');
// Fraction of the path's full length to cover over FRAMES frames. 1 = the
// full ~900m span in FRAMES frames (a deliberate stress test, matching
// qa/hitch-check.mjs's own speed); smaller values simulate an ordinary,
// unboosted flight speed over the same frame count.
const SPAN = Number(flag('span', 1));
const HOUR = Number(flag('hour', 13.2));

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `nothing answering on http://localhost:${PORT} — start the dist-qa preview server first ` +
    `(VITE_BASE=/ npx vite preview --port ${PORT} --strictPort --outDir dist-qa)`,
  );
}

/** Runs entirely in-page: wraps renderOverride, drives the camera, samples luma. */
function installInPage(frames, kind, moving, span) {
  const app = window.__boston;
  const ctx = app.ctx;
  const canvas = ctx.renderer.domElement;
  // Sample through a 2D canvas `drawImage`, not `gl.readPixels` on the WebGL
  // canvas directly: the renderer is created without `preserveDrawingBuffer`,
  // so the raw default framebuffer is not reliably readable after the frame
  // has been submitted. `drawImage`/`getImageData` are specified to always see
  // the last presented content regardless of that flag (it's the same path
  // `toDataURL`/`page.screenshot` use), and downsampling here is cheap.
  const SW = 240;
  const SH = 135;
  const snap = document.createElement('canvas');
  snap.width = SW;
  snap.height = SH;
  const sctx = snap.getContext('2d', { willReadFrequently: true });
  window.__blinkLog = [];
  window.__blinkErr = null;
  const orig = app.renderOverride;

  const stepFns = {
    commave(t) {
      const x = -1400 + t * 900;
      const z = 700 - t * 430;
      return { pos: [x, 40, z], target: [x + 260, 30, z - 140] };
    },
    common(t) {
      const x = -120 + t * 260;
      const z = 60 - t * 340;
      return { pos: [x, 8.3, z], target: [x + 220, 42, z - 260] };
    },
    downtown(t) {
      const x = 300 - t * 500;
      const z = 150 + t * 100;
      return { pos: [x, 60, z], target: [x - 200, 40, z - 100] };
    },
  };
  const stepFn = stepFns[kind];

  let i = 0;
  app.renderOverride = (dt) => {
    try {
      if (moving && i < frames) {
        const t = (frames > 1 ? i / (frames - 1) : 0) * span;
        const { pos, target } = stepFn(t);
        ctx.camera.position.set(pos[0], pos[1], pos[2]);
        ctx.camera.lookAt(target[0], target[1], target[2]);
        ctx.camera.updateMatrixWorld(true);
      }
      orig(dt);
      if (i < frames) {
        sctx.drawImage(canvas, 0, 0, SW, SH);
        const buf = sctx.getImageData(0, 0, SW, SH).data;
        let sum = 0;
        let n = 0;
        for (let idx = 0; idx < buf.length; idx += 4) {
          sum += 0.2126 * buf[idx] + 0.7152 * buf[idx + 1] + 0.0722 * buf[idx + 2];
          n++;
        }
        window.__blinkLog.push({ luma: sum / n, stats: { ...ctx.stats } });
        i++;
      }
    } catch (err) {
      window.__blinkErr = String((err && err.stack) || err);
      i = frames; // stop
    }
  };
  window.__blinkDone = () => i >= frames;
}

function summarize(log, label) {
  const lumas = log.map((e) => e.luma);
  const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
  const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
  const stdev = Math.sqrt(variance);
  const min = Math.min(...lumas);
  const max = Math.max(...lumas);
  const swing = max - min;
  const swingPct = (100 * swing) / mean;
  console.log(
    `--- ${label} ---  n=${lumas.length}  mean ${mean.toFixed(2)}  stdev ${stdev.toFixed(2)}  ` +
    `swing ${swing.toFixed(2)} (${swingPct.toFixed(1)}% of mean)`,
  );

  // Biggest single-frame jumps, with a diff of every stats counter that moved.
  const jumps = [];
  for (let i = 1; i < log.length; i++) {
    const d = log[i].luma - log[i - 1].luma;
    jumps.push({ i, d: Math.abs(d), raw: d });
  }
  jumps.sort((a, b) => b.d - a.d);
  const top = jumps.slice(0, 6);
  for (const j of top) {
    const a = log[j.i - 1].stats;
    const b = log[j.i].stats;
    const changed = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (a[k] !== b[k]) changed.push(`${k}: ${a[k]} -> ${b[k]}`);
    }
    console.log(
      `  frame ${j.i.toString().padStart(3)}  dLuma ${j.raw >= 0 ? '+' : ''}${j.raw.toFixed(2)}` +
      (changed.length ? `   [${changed.join(', ')}]` : '   [no ctx.stats counter changed]'),
    );
  }
  return { mean, stdev, swing, swingPct };
}

async function main() {
  await waitForServer();
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 900000,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    page.on('pageerror', (e) => console.error('[pageerror]', e));
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.removeItem('bh-tier');
        localStorage.removeItem('bh-res');
        localStorage.setItem('bh-onboarded', '1');
      } catch { /* ignore */ }
    });

    const url = `http://localhost:${PORT}/?q=${TIER}${POST ? `&post=${POST}` : ''}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
    await page.waitForFunction('window.__ready === true', { timeout: 300000 });

    const start = (stepKind => {
      const fns = {
        commave: [[-1400, 40, 700], [-1140, 30, 560]],
        common: [[-120, 8.3, 60], [100, 42, -280]],
        downtown: [[300, 60, 150], [100, 40, 50]],
      };
      return fns[stepKind];
    })(kind);
    if (!start) throw new Error(`unknown path kind '${kind}' (want commave|common|downtown)`);

    await page.evaluate((hour) => window.__debug.setTime(hour), HOUR);
    await page.evaluate((pos, target) => window.__debug.setView(pos, target), start[0], start[1]);
    await page.evaluate((n) => window.__debug.settle(n), SETTLE);

    const moving = mode === 'fly';
    await page.evaluate(installInPage, FRAMES, kind, moving, SPAN);
    await page.waitForFunction(() => window.__blinkDone(), { timeout: 120000, polling: 'raf' });

    const err = await page.evaluate(() => window.__blinkErr);
    if (err) throw new Error(`in-page error during measurement: ${err}`);

    const log = await page.evaluate(() => window.__blinkLog);
    const label = `${mode}:${kind} tier=${TIER}${POST ? ` post=${POST}` : ' post=full'} frames=${FRAMES} span=${SPAN}`;
    summarize(log, label);

    const shotPath = flag('shot', '');
    if (shotPath) {
      const buf = await page.screenshot();
      const fs = await import('node:fs');
      fs.writeFileSync(shotPath, buf);
      console.log(`  screenshot of the last driven frame -> ${shotPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
