/**
 * Attribution harness for the pale, sun-independent surfaces at Logan and in
 * the harbour.
 *
 * The defect is measured at hour 23 with `sunIntensity = 0`, where the pale
 * surfaces hold ~78 luma against 3.1 for the pavement beside them. That 25x
 * contrast is the cheapest decisive signal in the build.
 *
 * Ablation is done with `Object3D.layers`, NOT `visible`:
 *   - `__debug.toggle` writes `visible`, and AirTraffic (and the CDLOD
 *     selector, and the water reflection pass) rewrite it every frame.
 *   - nothing in `src/` ever writes bit 0 of `layers` except `Post`, which
 *     only touches the SSR layer.
 * So `o.layers.disable(0)` over a whole sub-tree is a hide that cannot be
 * silently undone.
 *
 * Usage:
 *   node qa/logan/_ablate.mjs --view logan-taxi-wide --hour 23 --mode scan
 *   node qa/logan/_ablate.mjs --view logan-taxi-wide --mode roots --boxes 'paleA:855,455,45,18|darkA:430,455,45,18|sky:800,20,300,40'
 *   node qa/logan/_ablate.mjs --mode kids --root terrain ...
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4633);
const OUTDIR = process.env.QA_OUTDIR || 'dist-loganfix';
const A = process.argv.slice(2);
const fl = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const has = (n) => A.includes('--' + n);

const VIEW = fl('view', 'logan-taxi-wide');
const TIER = fl('tier', 'high');
const HOUR = Number(fl('hour', '23'));
const MODE = fl('mode', 'scan');
const ROOTNAME = fl('root', '');
const TAG = fl('tag', MODE);
const EXTRA = fl('eval', '');
const BOXES = (fl('boxes', '')).split('|').filter(Boolean)
  .map((t) => { const [n, b] = t.split(':'); return { n, b: b.split(',').map(Number) }; });

await mkdir(`${ROOT}/qa/logan/shots`, { recursive: true });

const nonce = `${Date.now()}-logan`;
await writeFile(`${ROOT}/${OUTDIR}/qa-build-id.txt`, nonce);
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
let owned = false;
for (let i = 0; i < 200; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/qa-build-id.txt`);
    if (r.ok) {
      const t = (await r.text()).trim();
      if (t === nonce) { owned = true; break; }
      srv.kill();
      throw new Error(`port ${PORT} is serving another build`);
    }
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
const logs = [];
p.on('console', (m) => { const t = m.text(); if (/Terrain|Materials|family|warn|error/i.test(t)) logs.push(t); });
p.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message}`));
await p.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 240000 });
await p.waitForFunction('window.__ready === true', { timeout: 300000 });
// Assert the page really booted rather than trusting the timeout.
const booted = await p.evaluate(() => typeof window.__debug?.probe === 'function'
  && (window.__debug.stats().drawCalls ?? 0) >= 0);
if (!booted) { await b.close(); srv.kill(); throw new Error('page did not boot'); }
const dg = await p.evaluate(() => window.__debug.diag());
console.log(`[diag] tier=${dg.tier} mobile=${dg.mobile} safe=${dg.safeLevel} pr=${dg.pixelRatio} `
  + `envBound=${dg.envBound} envIntensity=${dg.environmentIntensity} gpu=${dg.gpu}`);

const vps = JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
if (!vp) throw new Error(`no viewpoint ${VIEW}`);

// Layer-based hide/show helpers installed once in the page.
await p.evaluate(() => {
  const s = window.__debug;
  window.__ab = {
    hide(o) { o.traverse((c) => c.layers.disable(0)); },
    show(o) { o.traverse((c) => c.layers.enable(0)); },
  };
  void s;
});

async function settle(n = 70) {
  await p.evaluate((k) => window.__debug.settle(k), n);
  await new Promise((r) => setTimeout(r, 400));
  await p.evaluate((k) => window.__debug.settle(k), 30);
}

await p.evaluate((v, hh) => { window.__debug.setTime(hh); window.__debug.setView(v.pos, v.target); }, vp, HOUR);
await new Promise((r) => setTimeout(r, 3500));
await settle(120);

const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

async function shot(name) {
  const buf = await p.screenshot({ type: 'png' });
  if (name) await writeFile(`${ROOT}/qa/logan/shots/${VIEW}--${name}.png`, buf);
  return PNG.sync.read(buf);
}

function stat(img, bx) {
  let n = 0, s = 0, s2 = 0;
  for (let y = bx[1]; y < Math.min(bx[1] + bx[3], img.height); y++) {
    for (let x = bx[0]; x < Math.min(bx[0] + bx[2], img.width); x++) {
      const i = (y * img.width + x) * 4; n++; const l = L(img.data, i); s += l; s2 += l * l;
    }
  }
  const mu = s / n;
  return { mu, sd: Math.sqrt(Math.max(0, s2 / n - mu * mu)) };
}

function measure(img) {
  const o = {};
  for (const r of BOXES) { const st = stat(img, r.b); o[r.n] = st.mu; }
  return o;
}

const pr0 = await p.evaluate(() => window.__debug.probe());
console.log(`[probe] exp=${pr0.exposure.toFixed(4)} sunInt=${pr0.sunIntensity.toFixed(4)} `
  + `sunElev=${pr0.sunElevation.toFixed(4)} envBound=${pr0.envBound} aerial=${pr0.aerialBound}`);

if (MODE === 'scan') {
  const img = await shot(`h${String(HOUR).replace('.', 'p')}-${TAG}`);
  // Brightest 16x16 blocks outside the HUD.
  const W = img.width, H = img.height, B = 16;
  const blocks = [];
  for (let by = 0; by + B <= H; by += B) {
    for (let bx = 0; bx + B <= W; bx += B) {
      const y = by + B / 2, x = bx + B / 2;
      if (y > H - 72 || (y > H - 140 && x < 330) || (y < 112 && x < 430)) continue;
      const st = stat(img, [bx, by, B, B]);
      blocks.push({ x: bx, y: by, mu: st.mu, sd: st.sd });
    }
  }
  blocks.sort((a, c) => c.mu - a.mu);
  console.log('[brightest 16x16 blocks, HUD excluded]');
  for (const bl of blocks.slice(0, 26)) {
    console.log(`  ${String(bl.x).padStart(4)},${String(bl.y).padStart(4)}  luma ${bl.mu.toFixed(1)}  sd ${bl.sd.toFixed(1)}`);
  }
  if (BOXES.length) console.log('[boxes]', JSON.stringify(measure(img)));
}

if (MODE === 'roots' || MODE === 'kids') {
  const base = await shot(`h${String(HOUR).replace('.', 'p')}-${TAG}-base`);
  const b0 = measure(base);
  console.log('[base]', JSON.stringify(b0));

  const names = await p.evaluate((rootName) => {
    const app = window.__boston;
    const scene = app ? app.ctx.scene : null;
    if (!scene) return { err: 'no window.__boston' };
    let list;
    if (rootName) {
      let hit = null;
      scene.traverse((o) => { if (!hit && o.name === rootName) hit = o; });
      if (!hit) return { err: `no object named ${rootName}` };
      list = hit.children;
    } else {
      list = scene.children;
    }
    return {
      items: list.map((o, i) => ({
        i, name: o.name || '(unnamed)', type: o.type, kids: o.children.length,
        visible: o.visible,
      })),
    };
  }, ROOTNAME);
  if (names.err) { console.log('[err]', names.err); } else {
    console.log(`[children of ${ROOTNAME || 'scene'}] ${names.items.length}`);
    for (const it of names.items) {
      console.log(`  #${it.i} ${it.name} (${it.type}, kids=${it.kids}, visible=${it.visible})`);
    }
    for (const it of names.items) {
      await p.evaluate((rootName, idx) => {
        const scene = window.__boston.ctx.scene;
        let parent = scene;
        if (rootName) { let hit = null; scene.traverse((o) => { if (!hit && o.name === rootName) hit = o; }); parent = hit; }
        window.__ab.hide(parent.children[idx]);
      }, ROOTNAME, it.i);
      await settle(40);
      const img = await shot(null);
      const m = measure(img);
      const delta = Object.fromEntries(Object.keys(m).map((k) => [k, +(m[k] - b0[k]).toFixed(1)]));
      console.log(`  hide #${it.i} ${it.name.padEnd(26)} -> ${JSON.stringify(m).replace(/"/g, '')}  d=${JSON.stringify(delta).replace(/"/g, '')}`);
      await p.evaluate((rootName, idx) => {
        const scene = window.__boston.ctx.scene;
        let parent = scene;
        if (rootName) { let hit = null; scene.traverse((o) => { if (!hit && o.name === rootName) hit = o; }); parent = hit; }
        window.__ab.show(parent.children[idx]);
      }, ROOTNAME, it.i);
      await settle(25);
    }
  }
}

if (MODE === 'eval') {
  const base = await shot(`h${String(HOUR).replace('.', 'p')}-${TAG}-base`);
  console.log('[base]', JSON.stringify(measure(base)));
  const res = await p.evaluate((src) => {
    try { return { ok: eval(src) }; } catch (e) { return { err: String(e) }; }
  }, EXTRA);
  console.log('[eval]', JSON.stringify(res));
  await settle(60);
  const after = await shot(`h${String(HOUR).replace('.', 'p')}-${TAG}-after`);
  console.log('[after]', JSON.stringify(measure(after)));
}

if (has('logs')) { console.log('[console]'); for (const l of logs.slice(0, 60)) console.log('  ' + l); }

await b.close();
srv.kill();
