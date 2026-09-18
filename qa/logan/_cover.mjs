/**
 * How much of a frame is the *bare sky dome*, and how much is CDLOD terrain?
 *
 * Both are measured as screen coverage by differencing two renders of the same
 * pose, which needs no names and no raycasts:
 *   dome%    = pixels that change when `sky-dome` is hidden by layer
 *   terrain% = pixels that change when `__terrain.setDebug(1)` recolours it
 * The HUD region is excluded (its glyphs are pure white and sit on top).
 *
 * `dome%` below the horizon is the defect: the dome has `depthTest: false` and
 * `renderOrder: -10000`, so every pixel no geometry covers is dome. Below the
 * horizon the dome draws the sky-view LUT's synthetic ~0.22-albedo ground,
 * which is flat, sun-independent and brighter than the sky above it.
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4641);
const OUTDIR = process.env.QA_OUTDIR || 'dist-loganfix';
const A = process.argv.slice(2);
const fl = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const TIER = fl('tier', 'high');
const TAG = fl('tag', 'cover');
const SHOOT = A.includes('--shots');
// view[:hour] pairs
const JOBS = fl('views', 'logan-taxi-wide:23|logan-taxi-wide:13.5|dusk-harbour:23|dusk-harbour:17.1|common-street:15|aerial-city:11|boot-default:17.1')
  .split('|').map((t) => { const [v, h] = t.split(':'); return { v, h: h === undefined ? undefined : Number(h) }; });

await mkdir(`${ROOT}/qa/logan/shots`, { recursive: true });
const nonce = `${Date.now()}-cover`;
await writeFile(`${ROOT}/${OUTDIR}/qa-build-id.txt`, nonce);
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
let owned = false;
for (let i = 0; i < 200; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/qa-build-id.txt`);
    if (r.ok) { if ((await r.text()).trim() === nonce) { owned = true; break; } srv.kill(); throw new Error('another build'); }
  } catch (e) { if (String(e.message).includes('another build')) throw e; }
  await new Promise((r) => setTimeout(r, 250));
}
if (!owned) { srv.kill(); throw new Error('preview server never came up'); }

const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000, timeout: 180000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await p.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); } catch { /* ignore */ }
});
await p.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 240000 });
await p.waitForFunction('window.__ready === true', { timeout: 300000 });
if (!await p.evaluate(() => !!window.__boston && !!window.__terrain)) { await b.close(); srv.kill(); throw new Error('no app'); }
await p.evaluate(() => {
  const scene = window.__boston.ctx.scene;
  window.__byName = (n) => { let h = null; scene.traverse((o) => { if (!h && o.name === n) h = o; }); return h; };
  window.__hide = (n) => { const o = window.__byName(n); if (o) o.traverse((c) => c.layers.disable(0)); return !!o; };
  window.__show = (n) => { const o = window.__byName(n); if (o) o.traverse((c) => c.layers.enable(0)); return !!o; };
});

const vps = JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'));
async function settle(n = 45) {
  await p.evaluate((k) => window.__debug.settle(k), n);
  await new Promise((r) => setTimeout(r, 300));
  await p.evaluate((k) => window.__debug.settle(k), 25);
}
async function shot(name) {
  const buf = await p.screenshot({ type: 'png' });
  if (name && SHOOT) await writeFile(`${ROOT}/qa/logan/shots/${name}.png`, buf);
  return PNG.sync.read(buf);
}
const hud = (x, y, W, H) => y > H - 72 || (y > H - 140 && x < 330) || (y < 112 && x < 430);
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
/**
 * Bare-dome coverage, measured without differencing two exposures.
 *
 * Auto-exposure makes a plain A/B diff useless here: pulling the dome out of
 * the frame moves the metered luminance, so *every* pixel changes and the diff
 * reads 90%. Instead, read the dome-hidden frame on its own — the dome has
 * `depthTest: false` and draws first, so any pixel no geometry covers falls
 * back to the renderer's clear colour, which is black (measured: 0.1-0.6 luma).
 *   hole   = dome-hidden luma < 1.5                (nothing is drawn there)
 *   bright = that, and the real frame has >= 20 luma there (the visible defect)
 * `low` restricts to the bottom 60% of the frame, i.e. below the horizon.
 */
function holes(base, nodome) {
  const W = base.width, H = base.height;
  let n = 0, h = 0, br = 0, nLow = 0, hLow = 0, brLow = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (hud(x, y, W, H)) continue;
      const i = (y * W + x) * 4;
      const isHole = lum(nodome.data, i) < 1.5;
      const isBright = isHole && lum(base.data, i) >= 20;
      n++; if (isHole) h++; if (isBright) br++;
      if (y > H * 0.4) { nLow++; if (isHole) hLow++; if (isBright) brLow++; }
    }
  }
  return {
    all: (100 * h) / n, low: (100 * hLow) / nLow,
    bright: (100 * br) / n, brightLow: (100 * brLow) / nLow,
  };
}

console.log(`[tier] ${TIER}`);
console.log('view                 hour   exp    sunInt   hole%  hole%low  bright%  bri%low   chunks     tris calls  fps  chunkDist(km)');
for (const job of JOBS) {
  const vp = vps.find((v) => v.id === job.v);
  if (!vp) { console.log(`  no viewpoint ${job.v}`); continue; }
  const hour = job.h ?? vp.hour;
  await p.evaluate((v, hh) => { window.__debug.setTime(hh); window.__debug.setView(v.pos, v.target); }, vp, hour);
  await new Promise((r) => setTimeout(r, 2500));
  await settle(100);
  const base = await shot(`${job.v}--h${hour}-${TAG}-base`);
  const pr = await p.evaluate(() => window.__debug.probe());

  await p.evaluate(() => window.__hide('sky-dome'));
  await settle(35);
  const nodome = await shot(`${job.v}--h${hour}-${TAG}-nodome`);
  await p.evaluate(() => window.__show('sky-dome'));

  await p.evaluate(() => window.__terrain.setDebug(1));
  await settle(35);
  const tdbg = await shot(`${job.v}--h${hour}-${TAG}-tdebug`);
  await p.evaluate(() => window.__terrain.setDebug(0));
  await settle(20);

  const info = await p.evaluate(() => {
    const ctx = window.__boston.ctx;
    const t = window.__byName('terrain');
    const arr = t.geometry.attributes.iChunk.data.array;
    const n = t.geometry.instanceCount;
    const cam = ctx.camera.position;
    let near = Infinity, far = 0;
    for (let i = 0; i < n; i++) {
      const x0 = arr[i * 5], z0 = arr[i * 5 + 1], s = arr[i * 5 + 2];
      const dx = cam.x < x0 ? x0 - cam.x : (cam.x > x0 + s ? cam.x - (x0 + s) : 0);
      const dz = cam.z < z0 ? z0 - cam.z : (cam.z > z0 + s ? cam.z - (z0 + s) : 0);
      const d = Math.hypot(dx, dz);
      if (d < near) near = d; if (d > far) far = d;
    }
    const st = window.__debug.stats();
    return {
      n, near: n ? +(near / 1000).toFixed(2) : -1, far: n ? +(far / 1000).toFixed(1) : -1,
      tris: st.terrainTris ?? -1, calls: st.calls ?? -1, fps: st.fps ?? -1,
    };
  });

  const hh = holes(base, nodome);
  void tdbg;
  console.log(`${job.v.padEnd(20)} ${String(hour).padEnd(6)} ${pr.exposure.toFixed(3)} ${pr.sunIntensity.toFixed(3)}   `
    + `${hh.all.toFixed(1).padStart(5)} ${hh.low.toFixed(1).padStart(7)} `
    + `${hh.bright.toFixed(1).padStart(7)} ${hh.brightLow.toFixed(1).padStart(8)}   `
    + `${String(info.n).padStart(5)} ${String(info.tris).padStart(8)} ${String(info.calls).padStart(5)} ${String(info.fps).padStart(4)}  ${info.near}..${info.far}`);
}

await b.close();
srv.kill();
