/** The scene-cost invariance table: one boot, every (tier, pin) combination.
 *
 * A fresh boot costs ~215 s here, so 16 configs x 3 dpr x 2 builds of them is
 * most of a day. This gets the same numbers from a single boot.
 *
 * The trick is a workaround for the re-entrant-resize defect described in
 * NOTES.md: `Post.width` is in device pixels, and the `quality-changed` /
 * `resolution-changed` handlers re-entered `resize(this.width, ...)`, applying
 * the pixel ratio twice. `App.onResize` passes *CSS* pixels, so dispatching a
 * `resize` event after the switch lands on exactly the geometry a fresh boot
 * would have. Verified against `_fresh.mjs`: dpr 2, high, Auto reads
 * 2000x1125 either way.
 *
 * Both reads are reported. `switched` is what the app is left in after a
 * settings change; `settled` is the fresh-boot equivalent. Before the fix
 * they differ by the pixel ratio; after it they must be identical, and the
 * `x` column says so per row rather than my asserting it.
 *
 * Scene dimensions come from walking the module tree for the real
 * `post.scene` render target (as qa/_gpumem.mjs does), not from any number
 * the code reports about itself, so the two builds stay comparable.
 *
 *   W=1600 H=900 DPR=2 QA_OUTDIR=dist-respath-before node qa/respath/_table.mjs
 *   MOBILE_UA=1 DPR=3 QA_OUTDIR=dist-respath-after node qa/respath/_table.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4494);
const OUTDIR = process.env.QA_OUTDIR || 'dist-respath-before';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const DPR = Number(process.env.DPR || 2);
const MOB = !!process.env.MOBILE_UA;
const OUT = process.env.OUT || `qa/respath/table-${OUTDIR}-dpr${DPR}${MOB ? '-mobile' : ''}.json`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const TIERS = (process.env.TIERS || 'low,medium,high,ultra').split(',');
const PINS = (process.env.PINS || 'auto,0.5,1,native').split(',')
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
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await pg.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); localStorage.removeItem('bh-tier'); } catch {}
});
await pg.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 420000 });

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
    scene, rtMB: +(rtBytes / 1048576).toFixed(1), targets,
    mobile: window.__debug.diag().mobile, css: [window.innerWidth, window.innerHeight],
  };
};

const rows = [];
console.log(`tier   pin    present  buffer       scene        sceneRatio  rndScale  rtMB    n   switched     x`);
for (const tier of TIERS) {
  for (const pin of PINS) {
    await pg.evaluate((t, p) => { window.__boston.setQuality(t); window.__boston.setResolution(p); }, tier, pin);
    await pg.evaluate(() => window.__debug.settle(20));
    const switched = await pg.evaluate(READ);
    // A real resize passes CSS pixels, which is the fresh-boot path.
    await pg.evaluate(() => window.dispatchEvent(new Event('resize')));
    await pg.evaluate(() => window.__debug.settle(20));
    const r = await pg.evaluate(READ);
    if (!r.scene) { srv.kill(); await b.close(); throw new Error(`no post.scene at ${tier}/${pin} — did the app boot?`); }

    rows.push({
      dpr: DPR, tier, pin, ...r,
      sceneRatio: +(r.scene[0] / W).toFixed(5),
      renderScale: +(r.scene[0] / r.buffer[0]).toFixed(5),
      switchedScene: switched.scene, switchedRtMB: switched.rtMB,
      switchedGrowth: +(switched.scene[0] / r.scene[0]).toFixed(4),
    });
    const q = rows.at(-1);
    console.log(`${tier.padEnd(6)} ${String(q.pin ?? 'auto').padEnd(6)} ${String(q.present).padEnd(8)} `
      + `${`${q.buffer[0]}x${q.buffer[1]}`.padEnd(12)} ${`${q.scene[0]}x${q.scene[1]}`.padEnd(12)} `
      + `${String(q.sceneRatio).padEnd(11)} ${String(q.renderScale).padEnd(9)} ${String(q.rtMB).padStart(6)}  ${String(q.targets).padEnd(3)} `
      + `${`${q.switchedScene[0]}x${q.switchedScene[1]}`.padEnd(12)} x${q.switchedGrowth}`);
  }
}
await pg.evaluate(() => window.__boston.setResolution(null));

console.log(`\n# ${OUTDIR}  css ${W}x${H}  dpr ${DPR}  MOBILE=${rows[0].mobile}  mobileUA=${MOB}`);
if (errors.length) console.log(`# page errors: ${errors.slice(0, 5).join(' | ')}`);
await writeFile(`${ROOT}/${OUT}`, JSON.stringify({ outdir: OUTDIR, W, H, DPR, mobileUA: MOB, mobile: rows[0].mobile, rows, errors }, null, 1));
console.log('->', OUT);
await b.close(); srv.kill();
