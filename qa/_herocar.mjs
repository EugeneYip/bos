#!/usr/bin/env node
/**
 * One vehicle, in a fixed pose, in a fixed colour, in front of a fixed
 * camera — so two builds can be compared on the same car.
 *
 * Everything about the fleet is random at boot, and seeding the generator
 * does not help across a change, because changing the code changes how many
 * times anything draws from it. So this does not look for a representative
 * car; it *places* one. The frame loop is stopped, every traffic mesh but one
 * is drawn zero times, and that one's instance matrix and instance colour are
 * overwritten with a canonical pose 9 m in front of the camera and the
 * critic's maroon. Both arms then measure the same pixels of the same object
 * under the same light.
 *
 *   QA_PORT=4446 QA_OUTDIR=dist-v node qa/_herocar.mjs --view street-night \
 *     --hour 21.4 --type van --color 7a1116 [--png out-prefix]
 */
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4446);
const OUTDIR = process.env.QA_OUTDIR || 'dist-v';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'street-night');
const HOUR = flag('hour', null);
const TYPE = flag('type', 'van');
const COLOR = flag('color', '7a1116');
const DIST = Number(flag('dist', '9'));
/** e.g. --sweep uCoatLamp=0.5,1,2,4 — one boot, one value per measurement. */
const SWEEP = flag('sweep', null);
const YAW = Number(flag('yaw', '35'));
const PNGOUT = flag('png', null);
const W = 1600, H = 900;

// A previous run's preview server can still hold the port. `--strictPort`
// makes the new one fail, the poll below then finds the *old* server healthy,
// and the whole measurement silently reports the old build — which is how a
// before and an after came back byte-identical once.
try {
  execSync(`lsof -ti tcp:${PORT} | xargs -r kill -9`, { stdio: 'ignore', shell: '/bin/bash' });
} catch { /* nothing listening */ }

async function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return p; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill(); throw new Error('preview server did not start');
}

const server = await startServer();
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
if (!vp) throw new Error(`no viewpoint ${VIEW}`);
const hour = HOUR !== null ? Number(HOUR) : vp.hour;
await page.evaluate((v, h) => { window.__debug.setView(v.pos, v.target); window.__debug.setTime(h); }, vp, hour);
await page.evaluate(() => window.__debug.settle(90));
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => window.__debug.settle(40));

// Stop the world before touching anything: the traffic module rewrites every
// instance matrix on its own update, so a pose written while it is running
// survives for one frame at most.
await page.evaluate(() => { window.__boston.running = false; });
const redraw = () => page.evaluate(() => {
  const app = window.__boston;
  if (app.renderOverride) app.renderOverride(1 / 60);
  else app.ctx.renderer.render(app.ctx.scene, app.ctx.camera);
});
const shot = async () => PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));

const placed = await page.evaluate((type, hex, dist, yawDeg) => {
  const ctx = window.__boston.ctx;
  const cam = ctx.camera;
  const mine = [];
  const others = [];
  ctx.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const n = o.name || '';
    if (n === `traffic:${type}:shell` || n === `traffic:${type}:glass` || n === `traffic:${type}:light`) mine.push(o);
    else if (n.startsWith('traffic:') || n === 'pedestrians') others.push(o);
  });
  if (mine.length < 2) return null;
  for (const o of others) { o.userData.qaCount = o.count; o.count = 0; }

  // A point straight ahead of the camera on the horizontal, dropped to the
  // ground the terrain reports there.
  const fwd = new (cam.position.constructor)();
  cam.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const px = cam.position.x + fwd.x * dist;
  const pz = cam.position.z + fwd.z * dist;
  const g = ctx.sampleHeight ? ctx.sampleHeight(px, pz) : null;
  const py = Number.isFinite(g) ? g : cam.position.y - 1.6;

  // Yaw so the car is seen three-quarter on: its own +X is forward.
  const yaw = Math.atan2(-fwd.z, fwd.x) + (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const e = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, px, py, pz, 1];

  for (const o of mine) {
    o.count = 1;
    o.instanceMatrix.array.set(e, 0);
    o.instanceMatrix.needsUpdate = true;
    if (o.instanceColor) {
      const n = parseInt(hex, 16);
      // sRGB hex to linear-sRGB, the same conversion the traffic palette uses.
      const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      o.instanceColor.setXYZ(0, lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255));
      o.instanceColor.needsUpdate = true;
    }
    for (const a of ['aRoll', 'aSteer', 'aBrake', 'aIndicator']) {
      const at = o.geometry.getAttribute(a);
      if (at) { at.setX(0, 0); at.needsUpdate = true; }
    }
  }
  return { world: [px, py, pz], yaw, exposure: ctx.exposure };
}, TYPE, COLOR, DIST, YAW);
if (!placed) { await browser.close(); server.kill(); throw new Error(`no traffic:${TYPE}:* meshes`); }

/**
 * Frame cost of the shell and glazing shaders, per screen of coverage.
 *
 * The obvious measurement — fps with the whole fleet on against the fleet off
 * — is hopeless here: several agents share this machine and the same build
 * measured twice came back 0.0 ms and 1.1 ms for a layer that submits 115
 * draw calls. This instead parks one vehicle close enough to fill a large,
 * *known* share of the frame and alternates it on and off, so the signal is
 * fill rate rather than submission and is large against the noise; and it
 * reports the fastest frame of each arm, because load can only ever make a
 * frame slower.
 */
if (argv.includes('--perf')) {
  await page.evaluate(() => { window.__boston.running = true; });
  await page.evaluate(() => window.__debug.settle(30));
  const sample = (ms) => page.evaluate((d) => new Promise((resolve) => {
    const t = [];
    let last = performance.now();
    const stop = last + d;
    const step = () => {
      const now = performance.now();
      t.push(now - last); last = now;
      if (now < stop) requestAnimationFrame(step);
      else {
        t.sort((a, b) => a - b);
        const lo = t.slice(0, Math.max(1, Math.ceil(t.length * 0.12)));
        resolve(lo.reduce((s, v) => s + v, 0) / lo.length);
      }
    };
    requestAnimationFrame(step);
  }), ms);
  // The traffic module rewrites instance matrices every frame while running,
  // so the pose is not held here — but coverage is what is being measured and
  // a car 3 m from the lens covers the frame wherever the module puts it.
  const show = (k) => page.evaluate((type, n) => {
    window.__boston.ctx.scene.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const nm = o.name || '';
      if (nm.startsWith('traffic:') || nm === 'pedestrians') o.count = 0;
      if (nm.startsWith(`traffic:${type}:`)) o.count = n;
    });
  }, TYPE, k);
  const on = [], off = [];
  for (let i = 0; i < 6; i++) {
    await show(24); on.push(await sample(1400));
    await show(0); off.push(await sample(1400));
  }
  const best = (a) => Math.min(...a);
  console.log(JSON.stringify({
    outdir: OUTDIR, view: VIEW, hour, type: TYPE, mode: 'perf',
    fastestWith: +best(on).toFixed(2), fastestWithout: +best(off).toFixed(2),
    deltaMs: +(best(on) - best(off)).toFixed(2), on, off,
  }, null, 2));
  await browser.close(); server.kill();
  process.exit(0);
}

const setUniform = (name, value) => page.evaluate((n, v) => {
  const mods = window.__boston.modules || [];
  const t = mods.find((m) => m.name === 'Traffic');
  if (t && t.coatUniforms && t.coatUniforms[n]) { t.coatUniforms[n].value = v; return true; }
  return false;
}, name, value);

const sweepName = SWEEP ? SWEEP.split('=')[0] : null;
const sweepVals = SWEEP ? SWEEP.split('=')[1].split(',').map(Number) : [null];
const runs = [];
let withCar = null, without = null;
for (const val of sweepVals) {
  if (sweepName) {
    const ok = await setUniform(sweepName, val);
    if (!ok) { await browser.close(); server.kill(); throw new Error(`no uniform ${sweepName}`); }
  }
  await redraw();
  withCar = await shot();
  await page.evaluate((type) => {
    window.__boston.ctx.scene.traverse((o) => {
      if (o.isInstancedMesh && (o.name || '').startsWith(`traffic:${type}:`)) o.count = 0;
    });
  }, TYPE);
  await redraw();
  without = await shot();
  await page.evaluate((type) => {
    window.__boston.ctx.scene.traverse((o) => {
      if (o.isInstancedMesh && (o.name || '').startsWith(`traffic:${type}:`)) o.count = 1;
    });
  }, TYPE);
  runs.push({ val, withCar, without });
}
await browser.close(); server.kill();

// The car is exactly the pixels that changed; with the world stopped nothing
// else could have.
function measure(withCar, without) {
  const mask = new Uint8Array(W * H);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const d = Math.abs(withCar.data[i] - without.data[i])
      + Math.abs(withCar.data[i + 1] - without.data[i + 1])
      + Math.abs(withCar.data[i + 2] - without.data[i + 2]);
    if (d <= 20) continue;
    mask[p] = 1; n++;
    const x = p % W, y = (p / W) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!n) throw new Error('car did not render');

  const over = (pred) => {
    const uniq = new Set();
    let m = 0, sl = 0, sl2 = 0, sat = 0, dead = 0, sr = 0, sg = 0, sb = 0, hi = 0;
    for (let p = 0; p < W * H; p++) {
      if (!mask[p] || !pred(p % W, (p / W) | 0)) continue;
      const i = p * 4;
      const r = withCar.data[i], g = withCar.data[i + 1], b = withCar.data[i + 2];
      uniq.add((r << 16) | (g << 8) | b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      m++; sl += l; sl2 += l * l; sr += r; sg += g; sb += b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 0) sat += (mx - mn) / mx;
      if (mx >= 30 && mn <= 2) dead++;
      if (l > 128) hi++;
    }
    if (!m) return { n: 0 };
    const mean = sl / m;
    return {
      n: m, uniqPerKpx: +((uniq.size / m) * 1000).toFixed(1),
      luma: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sl2 / m - mean * mean)).toFixed(2),
      sat: +(sat / m).toFixed(3), deadPct: +((dead / m) * 100).toFixed(2),
      rgb: [+(sr / m).toFixed(1), +(sg / m).toFixed(1), +(sb / m).toFixed(1)],
      brightPct: +((hi / m) * 100).toFixed(2),
    };
  };

  // Road just beyond the car, as the in-frame brightness reference.
  let rm = 0, rl = 0;
  for (let y = Math.min(H - 1, y1 + 6); y < Math.min(H, y1 + 40); y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      rl += 0.2126 * without.data[i] + 0.7152 * without.data[i + 1] + 0.0722 * without.data[i + 2];
      rm++;
    }
  }
  const road = rm ? rl / rm : 0;
  const bh = y1 - y0;
  const all = over(() => true);
  return {
    box: { x: x0, y: y0, w: x1 - x0 + 1, h: bh + 1 }, pixels: n,
    all,
    flank: over((x, y) => y > y0 + bh * 0.45),
    cabin: over((x, y) => y <= y0 + bh * 0.45),
    road: +road.toFixed(1),
    carOverRoad: +(all.luma / Math.max(road, 0.01)).toFixed(2),
  };
}

const results = runs.map((r) => ({
  [sweepName ?? 'run']: r.val ?? 'default', ...measure(r.withCar, r.without),
}));
console.log(JSON.stringify({
  view: VIEW, hour, tier: TIER, type: TYPE, color: COLOR,
  exposure: +placed.exposure.toFixed(4), results,
}, null, 2));
if (errors.length) console.error('ERRORS', errors.slice(0, 6));

if (PNGOUT) {
  const last = runs[runs.length - 1];
  const b = results[results.length - 1].box;
  const pad = 18, z = 2;
  const cx = Math.max(0, b.x - pad), cy = Math.max(0, b.y - pad);
  const cw = Math.min(W - cx, b.w + pad * 2), ch = Math.min(H - cy, b.h + pad * 2);
  const zo = new PNG({ width: cw * z, height: ch * z });
  for (let y = 0; y < ch * z; y++) {
    for (let x = 0; x < cw * z; x++) {
      const si = ((cy + Math.floor(y / z)) * W + cx + Math.floor(x / z)) * 4;
      const di = (y * zo.width + x) * 4;
      zo.data[di] = last.withCar.data[si]; zo.data[di + 1] = last.withCar.data[si + 1];
      zo.data[di + 2] = last.withCar.data[si + 2]; zo.data[di + 3] = 255;
    }
  }
  await writeFile(`${PNGOUT}-car.png`, PNG.sync.write(zo));
  await writeFile(`${PNGOUT}-frame.png`, PNG.sync.write(last.withCar));
}
