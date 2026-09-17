/** Scene-cost invariance table, measured on a *fresh boot* per configuration.
 *
 * Why not just switch tier in-page the way _ratios.mjs does: because doing
 * that is not equivalent, and finding out why turned up a second defect.
 * `Post` stores `this.width` in *device* pixels, and its `quality-changed` /
 * `resolution-changed` handlers re-entered `resize(this.width, this.height)`
 * -- so every touch of the settings panel multiplied the scene target by the
 * pixel ratio a second time. On a dpr-2 panel at `ultra` that is a 3600x2025
 * scene target instead of 2400x1350, and 403 MB of render targets instead of
 * ~180. A fresh boot is the honest "today" for a user who never opens the
 * panel, so that is what the invariant is measured against.
 *
 * Each config therefore gets its own reload with the tier and the Resolution
 * pin pre-seeded into localStorage, exactly the way the app would restore
 * them. Then, for the record, the same config is re-read after a no-op
 * `setQuality(sameTier)` so the doubling is quantified rather than asserted.
 *
 * Reads the dimensions of the real `post.scene` render target by walking the
 * module tree (as qa/_gpumem.mjs does) rather than any number the code
 * reports about itself, so before/after runs stay comparable even though the
 * code changed underneath.
 *
 *   W=1600 H=900 DPR=2 QA_OUTDIR=dist-respath-before node qa/respath/_fresh.mjs
 *   MOBILE_UA=1 DPR=3 ... node qa/respath/_fresh.mjs        # the phone gate
 *   TIERS=high PINS=auto ... node qa/respath/_fresh.mjs     # one cell, for timing
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4493);
const OUTDIR = process.env.QA_OUTDIR || 'dist-respath-before';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const DPR = Number(process.env.DPR || 2);
const MOB = !!process.env.MOBILE_UA;
const OUT = process.env.OUT || `qa/respath/fresh-${OUTDIR}-dpr${DPR}${MOB ? '-mobile' : ''}.json`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const TIERS = (process.env.TIERS || 'low,medium,high,ultra').split(',');
// `auto` is the absence of a pin; `native` is the display's own dpr.
const PINS = (process.env.PINS || `auto,0.5,1,native`).split(',')
  .map((p) => (p === 'auto' ? null : p === 'native' ? DPR : Number(p)));

const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
await writeFile(`${ROOT}/${OUTDIR}/qa-build-id.txt`, nonce);
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
let served = false;
for (let i = 0; i < 200 && !served; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/qa-build-id.txt`);
    if (r.ok) {
      if ((await r.text()).trim() === nonce) served = true;
      else { srv.kill(); throw new Error(`port ${PORT} is serving another build — pick a different QA_PORT`); }
    }
  } catch (e) { if (String(e.message).includes('another build')) throw e; }
  if (!served) await new Promise((r) => setTimeout(r, 250));
}
if (!served) { srv.kill(); throw new Error(`preview server never came up on ${PORT}`); }

const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--enable-unsafe-swiftshader', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const pg = await b.newPage();
await pg.setViewport({ width: W, height: H, deviceScaleFactor: DPR, isMobile: MOB, hasTouch: MOB });
if (MOB) await pg.setUserAgent(IPHONE);

/** Dimensions of the real scene target, plus the whole chain's footprint. */
const READ = () => {
  const app = window.__boston, r = app.ctx.renderer, gl = r.getContext();
  const bytesFor = (t) => {
    const tex = t.texture; if (!tex) return 0;
    const ch = tex.format === 1023 ? 4 : tex.format === 1028 ? 1 : 4;
    const bpc = (tex.type === 1016 || tex.type === 1017) ? 2 : (tex.type === 1015 ? 4 : 1);
    let n = t.width * t.height * ch * bpc;
    n += (t.depthTexture || t.depthBuffer) ? t.width * t.height * 4 : 0;
    return n;
  };
  const seen = new Set(); let rtBytes = 0; let targets = 0; let scene = null;
  const walk = (o, d) => {
    if (!o || d > 3 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
    if (o.isWebGLRenderTarget) {
      rtBytes += bytesFor(o); targets++;
      if ((o.texture?.name || '') === 'post.scene') scene = [o.width, o.height];
      return;
    }
    if (Array.isArray(o)) { for (const v of o) walk(v, d + 1); return; }
    for (const k in o) { try { walk(o[k], d + 1); } catch {} }
  };
  for (const m of app.modules) walk(m, 0);
  return {
    present: r.getPixelRatio(),
    buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    scene,
    rtMB: +(rtBytes / 1048576).toFixed(1),
    targets,
    mobile: window.__debug.diag().mobile,
    css: [window.innerWidth, window.innerHeight],
  };
};

const rows = [];
for (const tier of TIERS) {
  for (const pin of PINS) {
    // Seed the way a returning user's browser would, then boot.
    await pg.evaluateOnNewDocument((t, p) => {
      try {
        localStorage.setItem('bh-onboarded', '1');
        localStorage.setItem('bh-tier', t);
        if (p === null) localStorage.removeItem('bh-res'); else localStorage.setItem('bh-res', String(p));
      } catch {}
    }, tier, pin);
    const t0 = Date.now();
    await pg.goto(`http://localhost:${PORT}/?q=${tier}`, { waitUntil: 'networkidle2', timeout: 180000 });
    await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
    await pg.evaluate(() => window.__debug.settle(30));
    const fresh = await pg.evaluate(READ);
    // Assert we are looking at a booted app, not a blank page that timed out.
    if (!fresh.scene) { srv.kill(); await b.close(); throw new Error(`no post.scene target at ${tier}/${pin} — did the app boot?`); }

    // A no-op settings touch, to measure the re-entrant resize.
    await pg.evaluate((t) => window.__boston.setQuality(t), tier);
    await pg.evaluate(() => window.__debug.settle(10));
    const touched = await pg.evaluate(READ);

    const sceneRatio = +(fresh.scene[0] / W).toFixed(5);
    rows.push({
      dpr: DPR, tier, pin, boot: ((Date.now() - t0) / 1000).toFixed(1),
      ...fresh, sceneRatio,
      renderScale: +(fresh.scene[0] / fresh.buffer[0]).toFixed(5),
      touchedScene: touched.scene, touchedRtMB: touched.rtMB,
      touchedGrowth: +(touched.scene[0] / fresh.scene[0]).toFixed(4),
    });
    const r = rows.at(-1);
    console.log(`${tier.padEnd(6)} ${String(r.pin ?? 'auto').padEnd(6)} present ${String(r.present).padEnd(6)} `
      + `buf ${`${r.buffer[0]}x${r.buffer[1]}`.padEnd(11)} scene ${`${r.scene[0]}x${r.scene[1]}`.padEnd(11)} `
      + `sceneRatio ${String(r.sceneRatio).padEnd(8)} rs ${String(r.renderScale).padEnd(8)} `
      + `${String(r.rtMB).padStart(6)} MB  n=${r.targets}  | touched ${`${r.touchedScene[0]}x${r.touchedScene[1]}`.padEnd(11)} x${r.touchedGrowth}`);
  }
}

console.log(`\n# ${OUTDIR}  css ${W}x${H}  dpr ${DPR}  MOBILE=${rows[0].mobile}`);
await writeFile(`${ROOT}/${OUT}`, JSON.stringify({ outdir: OUTDIR, W, H, DPR, mobileUA: MOB, mobile: rows[0].mobile, rows }, null, 1));
console.log('->', OUT);
await b.close(); srv.kill();
