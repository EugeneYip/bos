/** Scene-cost invariance table for the resolution path.
 *
 * The claim under test: decoupling "pixels we present" from "pixels we shade"
 * must not change a single shaded pixel. So this reads the thing that actually
 * costs money -- the dimensions of the `post.scene` render target -- rather
 * than any number the code reports about itself, by walking the module tree
 * the way qa/_gpumem.mjs does. That works identically before and after the
 * change, so the two runs are comparable.
 *
 *   W=1600 H=900 DPR=2 QA_OUTDIR=dist-respath-before node qa/respath/_ratios.mjs
 *   MOBILE_UA=1 DPR=3 ... node qa/respath/_ratios.mjs     # the phone gate
 *
 * Emits TSV plus a JSON blob for diffing.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4491);
const OUTDIR = process.env.QA_OUTDIR || 'dist-respath-before';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const DPR = Number(process.env.DPR || 2);
const OUT = process.env.OUT || `qa/respath/ratios-${OUTDIR}-dpr${DPR}${process.env.MOBILE_UA ? '-mobile' : ''}.json`;
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const TIERS = ['low', 'medium', 'high', 'ultra'];
const PINS = [null, 0.5, 1, DPR];

// Prove the port is serving OUR build: a preview server left behind on the
// same port answers the readiness probe perfectly happily, and then every
// number below is from somebody else's bundle. See qa/shoot.mjs.
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
await pg.setViewport({ width: W, height: H, deviceScaleFactor: DPR, isMobile: !!process.env.MOBILE_UA, hasTouch: !!process.env.MOBILE_UA });
if (process.env.MOBILE_UA) await pg.setUserAgent(IPAD);
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); localStorage.removeItem('bh-tier'); } catch {} });
await pg.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });

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
  };
};

const rows = [];
for (const tier of TIERS) {
  for (const pin of PINS) {
    await pg.evaluate((t, p) => { window.__boston.setQuality(t); window.__boston.setResolution(p); }, tier, pin);
    await pg.evaluate(() => window.__debug.settle(30));
    const r = await pg.evaluate(READ);
    // What the scene actually costs, per CSS pixel, in each axis.
    const sceneRatio = r.scene ? +(r.scene[0] / W).toFixed(5) : null;
    rows.push({ dpr: DPR, tier, pin, ...r, sceneRatio, renderScale: r.scene ? +(r.scene[0] / r.buffer[0]).toFixed(5) : null });
  }
}
await pg.evaluate(() => window.__boston.setResolution(null));

const mob = rows[0].mobile;
console.log(`# ${OUTDIR}  css ${W}x${H}  dpr ${DPR}  MOBILE=${mob}`);
console.log('tier   pin     present  buffer       scene        sceneRatio  renderScale  rtMB  n');
for (const r of rows) {
  console.log(`${r.tier.padEnd(6)} ${String(r.pin).padEnd(7)} ${String(r.present).padEnd(8)} `
    + `${`${r.buffer[0]}x${r.buffer[1]}`.padEnd(12)} ${`${r.scene?.[0]}x${r.scene?.[1]}`.padEnd(12)} `
    + `${String(r.sceneRatio).padEnd(11)} ${String(r.renderScale).padEnd(12)} ${String(r.rtMB).padEnd(5)} ${r.targets}`);
}
await writeFile(`${ROOT}/${OUT}`, JSON.stringify({ outdir: OUTDIR, W, H, DPR, mobile: mob, rows }, null, 1));
console.log('->', OUT);
await b.close(); srv.kill();
