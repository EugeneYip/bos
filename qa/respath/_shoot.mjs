/** Capture + frame rate at a chosen device pixel ratio.
 *
 * qa/shoot.mjs pins deviceScaleFactor to 1, which is exactly the case the
 * resolution-path defect cannot be seen in: the browser only stretches the
 * canvas when the display has more pixels than the backing store. So this
 * shoots at a real DPR and screenshots the *composited page*, which is what
 * the user's eye gets -- browser blit included.
 *
 *   DPR=2 TIER=high TAG=before QA_OUTDIR=dist-respath-before \
 *     node qa/respath/_shoot.mjs charles-water water-detail
 *
 * RES pins the HUD's Resolution control (via localStorage, as qa/shoot.mjs
 * does); leave it empty for Auto. FPS is the median of repeated samples of
 * the app's own rolling-second mean, because a single reading is noise.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4492);
const OUTDIR = process.env.QA_OUTDIR || 'dist-respath-before';
const SHOTS = `${ROOT}/qa/respath/shots`;
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const DPR = Number(process.env.DPR || 2);
const TIER = process.env.TIER || 'high';
const RES = process.env.RES || '';
const TAG = process.env.TAG || 'x';
const FPS_SAMPLES = Number(process.env.FPS_SAMPLES || 12);
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));

await mkdir(SHOTS, { recursive: true });
const viewpoints = JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const wanted = ONLY.length ? viewpoints.filter((v) => ONLY.includes(v.id)) : viewpoints;
if (!wanted.length) throw new Error(`no viewpoints matched: ${ONLY.join(', ')}`);

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
    '--enable-webgl', '--enable-unsafe-swiftshader', `--window-size=${W},${H}`,
    '--hide-scrollbars', '--mute-audio'],
});
const errors = [];
const pg = await b.newPage();
await pg.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.evaluateOnNewDocument((res) => {
  try {
    localStorage.setItem('bh-onboarded', '1');
    localStorage.removeItem('bh-tier');
    if (res) localStorage.setItem('bh-res', res); else localStorage.removeItem('bh-res');
  } catch {}
}, RES);
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await pg.waitForFunction('window.__debug !== undefined', { timeout: 30000 });

const diag = await pg.evaluate(() => {
  const d = window.__debug.diag();
  return { tier: d.tier, mobile: d.mobile, safeLevel: d.safeLevel, present: d.pixelRatio, dpr: d.devicePixelRatio, buffer: d.drawingBuffer };
});
console.log(`# ${OUTDIR} tier=${TIER} res=${RES || 'auto'} dpr=${DPR} css=${W}x${H} `
  + `present=${diag.present} buffer=${diag.buffer.join('x')} mobile=${diag.mobile} safe=${diag.safeLevel}`);

const results = [];
for (const v of wanted) {
  const pose = async () => {
    await pg.evaluate((vp) => { window.__debug.setTime(vp.hour); window.__debug.setView(vp.pos, vp.target); }, v);
  };
  await pose();
  await pg.evaluate(() => window.__debug.settle(45));
  await new Promise((r) => setTimeout(r, 700));
  await pose();
  await pg.evaluate(() => window.__debug.settle(30));

  const file = `${SHOTS}/${v.id}--${TAG}.png`;
  await pg.screenshot({ path: file });

  // Free-running frames, sampled repeatedly: stats().fps is a rolling mean of
  // the last 60 frames, so give it a second per sample.
  const fps = [];
  for (let i = 0; i < FPS_SAMPLES; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await pg.evaluate(() => window.__debug.stats());
    fps.push({ fps: s.fps, low: s['fps.low'] });
  }
  const sorted = fps.map((f) => f.fps).sort((a, c) => a - c);
  const med = sorted[Math.floor(sorted.length / 2)];
  const stats = await pg.evaluate(() => window.__debug.stats());
  results.push({ id: v.id, file, fpsMedian: med, fpsAll: sorted, fpsLowMedian: fps.map((f) => f.low).sort((a, c) => a - c)[Math.floor(fps.length / 2)], calls: stats.calls, tris: stats.tris, postTotal: stats['post.total'] ?? null });
  console.log(`${v.id.padEnd(18)} fps med ${String(med).padStart(3)}  [${sorted.join(' ')}]  low ${results.at(-1).fpsLowMedian}  calls ${stats.calls}  post ${stats['post.total'] ?? '-'}`);
}

const out = `${ROOT}/qa/respath/shoot-${TAG}.json`;
await writeFile(out, JSON.stringify({ outdir: OUTDIR, tier: TIER, res: RES || 'auto', DPR, W, H, diag, results, errors: errors.slice(0, 20) }, null, 1));
console.log('->', out.replace(`${ROOT}/`, ''));
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.slice(0, 10).join('\n')); }
await b.close(); srv.kill();
process.exit(errors.length ? 2 : 0);
