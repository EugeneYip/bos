/**
 * Before/after verification for the pale sky-dome holes.
 *
 * Measures the critic's own boxes at the critic's own poses and hours, and
 * quotes every absolute luma against the `sky` box in the same frame — the
 * exposure loop moves both together, so only the ratio is safe to compare
 * across builds.
 *
 *   node qa/logan/_verify.mjs                     # default four rows
 *   QA_OUTDIR=dist-loganbefore node qa/logan/_verify.mjs --tag before
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4645);
const OUTDIR = process.env.QA_OUTDIR || 'dist-loganfix';
const A = process.argv.slice(2);
const fl = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const TIER = fl('tier', 'high');
const TAG = fl('tag', 'after');

/** The critic's boxes, verbatim from qa/crit2/NOTES.md. */
const JOBS = [
  { v: 'logan-taxi-wide', h: 23, boxes: 'paleA:855,455,45,18|paleB:350,455,25,18|darkA:430,455,45,18|sky:800,20,300,40' },
  { v: 'logan-taxi-wide', h: 13.5, boxes: 'paleA:855,455,45,18|paleB:350,455,25,18|darkA:430,455,45,18|sky:800,20,300,40' },
  { v: 'dusk-harbour', h: 23, boxes: 'stampM:705,485,38,8|stampB:418,496,84,24|openWater:400,620,500,80|seawall:400,470,760,55|sky:600,150,400,60' },
  { v: 'dusk-harbour', h: 13.5, boxes: 'stampM:705,485,38,8|stampB:418,496,84,24|openWater:400,620,500,80|seawall:400,470,760,55|sky:600,150,400,60' },
  { v: 'boot-default', h: 23, boxes: 'ground:1240,690,360,110|sky:700,60,400,40' },
  { v: 'boot-default', h: 17.1, boxes: 'ground:1240,690,360,110|sky:700,60,400,40' },
];

await mkdir(`${ROOT}/qa/logan/shots`, { recursive: true });
const nonce = `${Date.now()}-verify`;
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
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
async function settle(n = 60) {
  await p.evaluate((k) => window.__debug.settle(k), n);
  await new Promise((r) => setTimeout(r, 350));
  await p.evaluate((k) => window.__debug.settle(k), 25);
}
async function shot(name) {
  const buf = await p.screenshot({ type: 'png' });
  if (name) await writeFile(`${ROOT}/qa/logan/shots/${name}.png`, buf);
  return PNG.sync.read(buf);
}
function box(img, bx) {
  let n = 0, s = 0, s2 = 0;
  for (let y = bx[1]; y < Math.min(bx[1] + bx[3], img.height); y++) {
    for (let x = bx[0]; x < Math.min(bx[0] + bx[2], img.width); x++) {
      const i = (y * img.width + x) * 4; const l = lum(img.data, i); s += l; s2 += l * l; n++;
    }
  }
  const mu = s / n;
  return { mu, sd: Math.sqrt(Math.max(0, s2 / n - mu * mu)) };
}

console.log(`[build] ${OUTDIR}  tier=${TIER}  tag=${TAG}`);
for (const job of JOBS) {
  const vp = vps.find((v) => v.id === job.v);
  const regions = job.boxes.split('|').map((t) => { const [n, bx] = t.split(':'); return { n, b: bx.split(',').map(Number) }; });
  await p.evaluate((v, hh) => { window.__debug.setTime(hh); window.__debug.setView(v.pos, v.target); }, vp, job.h);
  await new Promise((r) => setTimeout(r, 2500));
  await settle(110);
  const img = await shot(`${job.v}--h${String(job.h).replace('.', 'p')}-${TAG}`);
  const pr = await p.evaluate(() => window.__debug.probe());
  const st = await p.evaluate(() => window.__debug.stats());

  // How much of the frame is still bare dome, on its own terms.
  await p.evaluate(() => window.__hide('sky-dome'));
  await settle(35);
  const nd = await shot(null);
  await p.evaluate(() => window.__show('sky-dome'));
  const W = img.width, H = img.height;
  let nLow = 0, hLow = 0;
  for (let y = Math.floor(H * 0.4); y < H - 72; y++) {
    for (let x = 0; x < W; x++) {
      if (y > H - 140 && x < 330) continue;
      const i = (y * W + x) * 4; nLow++;
      if (lum(nd.data, i) < 1.5) hLow++;
    }
  }

  const skyBox = regions.find((r) => r.n === 'sky');
  const sky = skyBox ? box(img, skyBox.b).mu : NaN;
  const cells = regions.filter((r) => r.n !== 'sky').map((r) => {
    const s = box(img, r.b);
    return `${r.n}=${s.mu.toFixed(1)}(sd${s.sd.toFixed(1)}, /sky ${(s.mu / sky).toFixed(2)})`;
  });
  console.log(`${job.v} h=${job.h}  exp=${pr.exposure.toFixed(4)} sunInt=${pr.sunIntensity.toFixed(3)} `
    + `sky=${sky.toFixed(1)} | ${cells.join('  ')}`);
  console.log(`   holeLow=${((100 * hLow) / nLow).toFixed(1)}%  chunks=${st.terrainChunks} terrainTris=${st.terrainTris} `
    + `calls=${st.calls} tris=${st.tris} fps=${st.fps}`);
}

await b.close();
srv.kill();
