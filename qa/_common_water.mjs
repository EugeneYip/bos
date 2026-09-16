#!/usr/bin/env node
/**
 * Follow-up to _blink.mjs's `fly:common --span=0.1` run, which found a huge
 * (~19% single-frame, 93% peak-to-peak) luma swing around frames 108-120 that
 * correlates with `water.seen`/`water.reflect` flipping 0 -> 1 and `calls`/
 * `tris` jumping by ~592 draws / ~2.8M triangles in one frame — not with any
 * `veg.*` stat. This script re-flies the exact same path at the exact same
 * speed, but dumps the RAW per-frame trace (no top-N sorting) across the
 * suspect window plus `ctx.exposure`, and grabs full-res screenshots either
 * side of the transition, so the event can be attributed and *seen* rather
 * than inferred from a stats diff alone.
 *
 * Usage (serve a QA build first, same as _blink.mjs):
 *   node qa/_common_water.mjs --tier=high --span=0.1 --frames=180
 */
import puppeteer from 'puppeteer';

const PORT = Number(process.env.QA_PORT || 4611);
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const p = argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : d;
};
const TIER = flag('tier', 'high');
const FRAMES = Number(flag('frames', 180));
const SPAN = Number(flag('span', 0.1));
const HOUR = Number(flag('hour', 15.0));
const SETTLE = Number(flag('settle', 90));
const WINLO = Number(flag('winlo', 100));
const WINHI = Number(flag('winhi', 130));
const SHOTDIR = flag('shotdir', 'qa/shots/common');

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`nothing answering on http://localhost:${PORT}`);
}

function installInPage(frames, span, shotFrames) {
  const app = window.__boston;
  const ctx = app.ctx;
  const canvas = ctx.renderer.domElement;
  const SW = 240, SH = 135;
  const snap = document.createElement('canvas');
  snap.width = SW; snap.height = SH;
  const sctx = snap.getContext('2d', { willReadFrequently: true });
  const full = document.createElement('canvas');
  full.width = canvas.width; full.height = canvas.height;
  const fctx = full.getContext('2d', { willReadFrequently: true });
  const wantShots = new Set(shotFrames || []);
  window.__wLog = [];
  window.__wShots = {};
  window.__wErr = null;
  const orig = app.renderOverride;

  // Identical stepFn to _blink.mjs's 'common' path.
  const stepFn = (t) => {
    const x = -120 + t * 260;
    const z = 60 - t * 340;
    return { pos: [x, 8.3, z], target: [x + 220, 30, z - 140] };
  };

  let i = 0;
  app.renderOverride = (dt) => {
    try {
      if (i < frames) {
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
        let sum = 0, n = 0;
        for (let idx = 0; idx < buf.length; idx += 4) {
          sum += 0.2126 * buf[idx] + 0.7152 * buf[idx + 1] + 0.0722 * buf[idx + 2];
          n++;
        }
        window.__wLog.push({
          luma: sum / n,
          exposure: ctx.exposure,
          pos: ctx.camera.position.toArray(),
          stats: { ...ctx.stats },
        });
        if (wantShots.has(i)) {
          fctx.drawImage(canvas, 0, 0);
          window.__wShots[i] = full.toDataURL('image/png');
        }
      }
      i++;
    } catch (err) {
      window.__wErr = String((err && err.stack) || err);
      i = frames;
    }
  };
  window.__wDone = () => i >= frames;
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

    await page.evaluate((h) => window.__debug.setTime(h), HOUR);
    await page.evaluate((p, t) => window.__debug.setView(p, t), [-120, 8.3, 60], [100, 30, -140]);
    await page.evaluate((n) => window.__debug.settle(n), SETTLE);

    const shotFrames = [];
    for (let f = WINLO; f <= WINHI; f++) shotFrames.push(f);
    await page.evaluate(installInPage, FRAMES, SPAN, shotFrames);
    await page.waitForFunction(() => window.__wDone(), { timeout: 180000, polling: 'raf' });

    const err = await page.evaluate(() => window.__wErr);
    if (err) throw new Error(`in-page error: ${err}`);

    const log = await page.evaluate(() => window.__wLog);
    console.log(`=== _common_water: tier=${TIER} span=${SPAN} frames=${FRAMES} hour=${HOUR} ===`);
    console.log(`raw trace, frames ${WINLO}..${WINHI}:`);
    for (let k = WINLO; k <= Math.min(WINHI, log.length - 1); k++) {
      const e = log[k];
      const prev = log[k - 1];
      const d = prev ? e.luma - prev.luma : 0;
      const s = e.stats;
      console.log(
        `  f${k}: luma ${e.luma.toFixed(2)} (d${d >= 0 ? '+' : ''}${d.toFixed(2)})  exposure ${e.exposure?.toFixed(4)}  `
        + `pos [${e.pos.map((v) => v.toFixed(1)).join(',')}]  water.seen=${s['water.seen']} water.reflect=${s['water.reflect']} `
        + `veg.near=${s['veg.near']} veg.mid=${s['veg.mid']} calls=${s['calls']} tris=${s['tris']} `
        + `buildingTilesVisible=${s['buildingTilesVisible']}`,
      );
    }

    // Also scan the WHOLE run for water.seen/water.reflect transitions, wherever they land.
    console.log('\n=== every water.seen / water.reflect transition over the whole run ===');
    for (let k = 1; k < log.length; k++) {
      const a = log[k - 1].stats, b = log[k].stats;
      if (a['water.seen'] !== b['water.seen'] || a['water.reflect'] !== b['water.reflect']) {
        const d = log[k].luma - log[k - 1].luma;
        console.log(
          `  frame ${k}: water.seen ${a['water.seen']}->${b['water.seen']}  `
          + `water.reflect ${a['water.reflect']}->${b['water.reflect']}  dLuma ${d >= 0 ? '+' : ''}${d.toFixed(2)} `
          + `exposure ${log[k - 1].exposure?.toFixed(4)}->${log[k].exposure?.toFixed(4)}`,
        );
      }
    }

    const shots = await page.evaluate(() => window.__wShots);
    const fs = await import('node:fs');
    for (const f of shotFrames) {
      const dataUrl = shots[f];
      if (!dataUrl) continue;
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const p = `${SHOTDIR}/water-frame-${String(f).padStart(4, '0')}.png`;
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    }
    console.log(`\nshots written to ${SHOTDIR}/water-frame-*.png for frames ${WINLO}..${WINHI}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
