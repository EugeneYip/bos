#!/usr/bin/env node
/**
 * Isolates the Vegetation near/mid tier swap from everything else that
 * animates in the scene, to find out whether it alone produces a visible
 * "flash" in Boston Common.
 *
 * Method: park the camera at `common-street` (dense canopy overhead), sample
 * baseline luma for a while with ZERO camera motion (establishes the noise
 * floor from TAA/dither/traffic/pedestrians alone), then perform a single
 * small teleport — position and look-at target both shifted by the same
 * vector, so the *composition* barely changes but the camera has moved more
 * than Vegetation's REBUILD_MOVE (28 m) threshold — and keep sampling with
 * the camera perfectly static again afterward. Vegetation.rebuild is
 * resumable (REBUILD_BUDGET_MS = 4 ms/frame) so the tier populations change
 * over several frames and then swap atomically; this logs exactly which
 * frame(s) veg.near/veg.mid change on and what mean luma did on that same
 * frame, with the camera contributing nothing of its own.
 *
 * Repeats the jump N times (small alternating strafe) to get more than one
 * sample of the swap event in a single run.
 *
 * Usage (serve a QA build first):
 *   VITE_BASE=/ npx vite build --outDir dist-qa
 *   VITE_BASE=/ npx vite preview --port 4611 --strictPort --outDir dist-qa &
 *   node qa/_common_lod.mjs --jumps=4 --tier=high
 */
import puppeteer from 'puppeteer';

const PORT = Number(process.env.QA_PORT || 4611);
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const p = argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : d;
};
const TIER = flag('tier', 'high');
const JUMPS = Number(flag('jumps', 4));
const JUMP_DIST = Number(flag('jumpdist', 30)); // > REBUILD_MOVE (28)
const SETTLE_AFTER = Number(flag('settleframes', 70)); // frames sampled after each jump
const BASELINE_FRAMES = Number(flag('baseline', 30));
const HOUR = Number(flag('hour', 15.0));

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`nothing answering on http://localhost:${PORT}`);
}

/** Runs in-page: wraps renderOverride, jumps the camera, samples luma + stats every frame. */
function installInPage(baselineFrames, jumps, jumpDist, settleAfter, shotFrames) {
  const app = window.__boston;
  const ctx = app.ctx;
  const canvas = ctx.renderer.domElement;
  const SW = 240, SH = 135;
  const snap = document.createElement('canvas');
  snap.width = SW; snap.height = SH;
  const sctx = snap.getContext('2d', { willReadFrequently: true });
  // Full-res captures for specific frame indices, taken via the same
  // drawImage path (reliable regardless of preserveDrawingBuffer), so a
  // caller can inspect the exact frame a stat changed on without racing a
  // Puppeteer screenshot against the page's own rAF loop.
  const full = document.createElement('canvas');
  full.width = canvas.width; full.height = canvas.height;
  const fctx = full.getContext('2d', { willReadFrequently: true });
  const wantShots = new Set(shotFrames || []);
  window.__lodShots = {};
  window.__lodLog = [];
  window.__lodErr = null;
  window.__lodEvents = []; // frame indices where we performed a jump
  const orig = app.renderOverride;

  const totalFrames = baselineFrames + jumps * settleAfter;
  // Alternating strafe directions, perpendicular-ish to the common-street
  // sightline, so successive jumps do not just walk off down the mall.
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  ];

  let i = 0;
  app.renderOverride = (dt) => {
    try {
      // Perform a jump exactly at the start of each settleAfter block.
      if (i >= baselineFrames && (i - baselineFrames) % settleAfter === 0) {
        const jumpIdx = (i - baselineFrames) / settleAfter;
        if (jumpIdx < jumps) {
          const d = dirs[jumpIdx % dirs.length];
          const dx = d[0] * jumpDist, dz = d[2] * jumpDist;
          const p = ctx.camera.position;
          // Read the current forward direction before touching position (it
          // depends only on rotation), then translate and re-aim at the same
          // relative point so the composition barely changes.
          const fwd = p.clone();
          ctx.camera.getWorldDirection(fwd);
          p.x += dx; p.z += dz;
          const t = p.clone().add(fwd.multiplyScalar(300));
          ctx.camera.position.set(p.x, p.y, p.z);
          ctx.camera.lookAt(t.x, t.y, t.z);
          ctx.camera.updateMatrixWorld(true);
          window.__lodEvents.push(i);
        }
      }
      orig(dt);
      if (i < totalFrames) {
        sctx.drawImage(canvas, 0, 0, SW, SH);
        const buf = sctx.getImageData(0, 0, SW, SH).data;
        let sum = 0, n = 0;
        for (let idx = 0; idx < buf.length; idx += 4) {
          sum += 0.2126 * buf[idx] + 0.7152 * buf[idx + 1] + 0.0722 * buf[idx + 2];
          n++;
        }
        window.__lodLog.push({ luma: sum / n, stats: { ...ctx.stats } });
        if (wantShots.has(i)) {
          fctx.drawImage(canvas, 0, 0);
          window.__lodShots[i] = full.toDataURL('image/png');
        }
      }
      i++;
    } catch (err) {
      window.__lodErr = String((err && err.stack) || err);
      i = totalFrames + 1;
    }
  };
  window.__lodTotal = totalFrames;
  window.__lodDone = () => i > totalFrames;
}

function analyze(log, events) {
  const lumas = log.map((e) => e.luma);
  const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
  console.log(`n=${lumas.length} frames, mean luma ${mean.toFixed(2)}`);

  // Baseline swing: before the first jump.
  const firstJump = events[0] ?? log.length;
  const baseline = lumas.slice(0, firstJump);
  if (baseline.length > 1) {
    const bmean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const bswing = Math.max(...baseline) - Math.min(...baseline);
    let maxStep = 0;
    for (let k = 1; k < baseline.length; k++) maxStep = Math.max(maxStep, Math.abs(baseline[k] - baseline[k - 1]));
    console.log(
      `baseline (camera static, ${baseline.length} frames): mean ${bmean.toFixed(2)}  `
      + `swing ${bswing.toFixed(2)} (${(100 * bswing / bmean).toFixed(2)}% of mean)  `
      + `max single-frame step ${maxStep.toFixed(3)} (${(100 * maxStep / bmean).toFixed(2)}% of mean)`,
    );
  }

  // Unconfounded readout: the luma delta on EXACTLY the frame(s) where
  // veg.near or veg.mid changed, wherever they land, regardless of whether
  // that also happens to be the single biggest jump in a wider window (which
  // can instead be dominated by an unrelated event, e.g. a building-tile
  // streaming pop).
  console.log('\n=== dLuma exactly on frames where veg.near/veg.mid changed ===');
  for (let k = 1; k < log.length; k++) {
    const a = log[k - 1].stats, b = log[k].stats;
    if (a['veg.near'] !== b['veg.near'] || a['veg.mid'] !== b['veg.mid']) {
      const d = log[k].luma - log[k - 1].luma;
      console.log(
        `  frame ${k}: veg.near ${a['veg.near']} -> ${b['veg.near']}  `
        + `veg.mid ${a['veg.mid']} -> ${b['veg.mid']}  dLuma ${d >= 0 ? '+' : ''}${d.toFixed(3)} `
        + `(${(100 * d / mean).toFixed(2)}% of mean)`,
      );
    }
  }

  console.log(`\n${events.length} jump(s) performed at frames: ${events.join(', ')}`);
  for (const ev of events) {
    console.log(`\n--- jump at frame ${ev} ---`);
    // Look at the window after the jump for the biggest single-frame luma
    // delta and correlate with veg.* stat changes.
    const windowEnd = Math.min(log.length - 1, ev + 90);
    let best = null;
    for (let k = ev; k < windowEnd; k++) {
      const d = log[k + 1].luma - log[k].luma;
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { i: k + 1, d };
    }
    if (!best) continue;
    const a = log[best.i - 1].stats, b = log[best.i].stats;
    const changed = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (a[k] !== b[k]) changed.push(`${k}: ${a[k]} -> ${b[k]}`);
    const vegChanged = changed.some((c) => c.startsWith('veg.near') || c.startsWith('veg.mid'));
    console.log(
      `  biggest jump in [frame ${ev}..${windowEnd}]: frame ${best.i}  `
      + `dLuma ${best.d >= 0 ? '+' : ''}${best.d.toFixed(2)}  vegTierChanged=${vegChanged}`,
    );
    console.log(`  changed stats: ${changed.length ? changed.join(', ') : '(none)'}`);
    // Also print the veg.near/veg.mid trace across the window so a slow
    // multi-frame resumable fill (vs one atomic swap) is visible.
    const trace = [];
    for (let k = ev; k <= windowEnd; k++) {
      const s = log[k].stats;
      trace.push(`${k}:${s['veg.near']}/${s['veg.mid']}`);
    }
    console.log(`  veg.near/veg.mid trace: ${trace.join(' ')}`);
  }
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

    const url = `http://localhost:${PORT}/?q=${TIER}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
    await page.waitForFunction('window.__ready === true', { timeout: 300000 });

    // common-street viewpoint: eye level on Boston Common, canopy overhead.
    const pos = [-120, 8.3, 60];
    const target = [156, 49.6, -326];
    await page.evaluate((h) => window.__debug.setTime(h), HOUR);
    await page.evaluate((p, t) => window.__debug.setView(p, t), pos, target);
    // Let the initial full rebuild (done synchronously in init) and any
    // startup transients fully settle before measuring anything.
    await page.evaluate((n) => window.__debug.settle(n), 180);

    const shotFramesArg = flag('shotframes', '');
    const shotFrames = shotFramesArg ? shotFramesArg.split(',').map(Number) : [];
    const shotDir = flag('shotdir', '');
    await page.evaluate(installInPage, BASELINE_FRAMES, JUMPS, JUMP_DIST, SETTLE_AFTER, shotFrames);
    await page.waitForFunction(() => window.__lodDone(), { timeout: 180000, polling: 'raf' });

    const err = await page.evaluate(() => window.__lodErr);
    if (err) throw new Error(`in-page error during measurement: ${err}`);

    const log = await page.evaluate(() => window.__lodLog);
    const events = await page.evaluate(() => window.__lodEvents);
    console.log(`=== _common_lod: tier=${TIER} jumps=${JUMPS} jumpdist=${JUMP_DIST}m settle=${SETTLE_AFTER}f ===`);
    analyze(log, events);

    if (shotFrames.length && shotDir) {
      const shots = await page.evaluate(() => window.__lodShots);
      const fs = await import('node:fs');
      for (const f of shotFrames) {
        const dataUrl = shots[f];
        if (!dataUrl) { console.log(`  no shot captured for frame ${f} (run ended before it?)`); continue; }
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const p = `${shotDir}/frame-${String(f).padStart(4, '0')}.png`;
        fs.writeFileSync(p, Buffer.from(b64, 'base64'));
        console.log(`  shot: frame ${f} -> ${p}`);
      }
    }

    const shotPath = flag('shot', '');
    if (shotPath) {
      const buf = await page.screenshot();
      const fs = await import('node:fs');
      fs.writeFileSync(shotPath, buf);
      console.log(`  screenshot of the last frame -> ${shotPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
