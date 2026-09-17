#!/usr/bin/env node
/**
 * One pedestrian, in a fixed pose, in a fixed coat, 8 m from a fixed camera.
 *
 * Defect #1 was measured on a figure that happened to walk into the middle of
 * one screenshot, which cannot be repeated after a change: the crowd is
 * re-seeded on every boot, and seeding the generator does not survive a code
 * change either. So this places a walker rather than looking for one. The
 * frame loop is stopped, every other walker and every vehicle is drawn zero
 * times, and slot zero's instance matrix, instance colour and skin tone are
 * overwritten with a canonical pose. Both arms then measure the same figure
 * in the same coat under the same light.
 *
 * '--yaw 180' faces them at the camera, which is the only view that says
 * anything about a head.
 *
 *   QA_PORT=4445 QA_OUTDIR=dist-v node qa/_heroped.mjs --view common-street \
 *     [--hour 15] [--yaw 180] [--coat 45505c] [--tone 0.32] [--png prefix]
 */
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4445);
const OUTDIR = process.env.QA_OUTDIR || 'dist-v';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'common-street');
const HOUR = flag('hour', null);
const COAT = flag('coat', '45505c');
const TONE = Number(flag('tone', '0.32'));
const DIST = Number(flag('dist', '8'));
const YAW = Number(flag('yaw', '180'));
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

await page.evaluate(() => { window.__boston.running = false; });
const redraw = () => page.evaluate(() => {
  const app = window.__boston;
  if (app.renderOverride) app.renderOverride(1 / 60);
  else app.ctx.renderer.render(app.ctx.scene, app.ctx.camera);
});
const shot = async () => PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));

const placed = await page.evaluate((hex, tone, dist, yawDeg) => {
  const ctx = window.__boston.ctx;
  const cam = ctx.camera;
  let mesh = null;
  const others = [];
  ctx.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (o.name === 'pedestrians') mesh = o;
    else if ((o.name || '').startsWith('traffic:')) others.push(o);
  });
  if (!mesh) return null;
  for (const o of others) o.count = 0;

  const fwd = new (cam.position.constructor)();
  cam.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const px = cam.position.x + fwd.x * dist;
  const pz = cam.position.z + fwd.z * dist;
  const g = ctx.sampleHeight ? ctx.sampleHeight(px, pz) : null;
  const py = Number.isFinite(g) ? g : cam.position.y - 1.6;
  const yaw = Math.atan2(-fwd.z, fwd.x) + (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);

  mesh.count = 1;
  mesh.instanceMatrix.array.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, px, py, pz, 1], 0);
  mesh.instanceMatrix.needsUpdate = true;
  const n = parseInt(hex, 16);
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  mesh.instanceColor.setXYZ(0, lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255));
  mesh.instanceColor.needsUpdate = true;
  for (const [a, v] of [['aPhase', 0.45], ['aSwing', 0.8], ['aTone', tone]]) {
    const at = mesh.geometry.getAttribute(a);
    if (at) { at.setX(0, v); at.needsUpdate = true; }
  }
  // Where the figure will land on screen, so the mask can be confined to it.
  // The post chain re-jitters between two draws and scatters a few thousand
  // single-pixel differences across every leaf in the frame; unconfined, that
  // noise was most of the 'pedestrian'.
  cam.updateMatrixWorld(true);
  const pm = cam.projectionMatrix.elements, vm = cam.matrixWorldInverse.elements;
  const vpm = [];
  for (let cc = 0; cc < 4; cc++) {
    for (let rr = 0; rr < 4; rr++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += pm[k * 4 + rr] * vm[cc * 4 + k];
      vpm[cc * 4 + rr] = acc;
    }
  }
  let sx0 = 1e9, sy0 = 1e9, sx1 = -1e9, sy1 = -1e9;
  for (const dx of [-0.6, 0.6]) {
    for (const dy of [-0.05, 2.0]) {
      for (const dz of [-0.6, 0.6]) {
        const wx = px + dx, wy = py + dy, wz = pz + dz;
        const cw = vpm[3] * wx + vpm[7] * wy + vpm[11] * wz + vpm[15];
        const ex = (vpm[0] * wx + vpm[4] * wy + vpm[8] * wz + vpm[12]) / cw;
        const ey = (vpm[1] * wx + vpm[5] * wy + vpm[9] * wz + vpm[13]) / cw;
        const ux = (ex * 0.5 + 0.5) * window.innerWidth;
        const uy = (-ey * 0.5 + 0.5) * window.innerHeight;
        sx0 = Math.min(sx0, ux); sx1 = Math.max(sx1, ux);
        sy0 = Math.min(sy0, uy); sy1 = Math.max(sy1, uy);
      }
    }
  }
  return {
    world: [px, py, pz], exposure: ctx.exposure,
    hasTone: !!mesh.geometry.getAttribute('aTone'),
    screen: [Math.floor(sx0), Math.floor(sy0), Math.ceil(sx1), Math.ceil(sy1)],
  };
}, COAT, TONE, DIST, YAW);
if (!placed) { await browser.close(); server.kill(); throw new Error('no pedestrian mesh'); }

await redraw();
const withPed = await shot();
await page.evaluate(() => {
  window.__boston.ctx.scene.traverse((o) => { if (o.name === 'pedestrians') o.count = 0; });
});
await redraw();
const without = await shot();
await browser.close(); server.kill();

const mask = new Uint8Array(W * H);
const [gx0, gy0, gx1, gy1] = placed.screen;
let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
for (let p = 0; p < W * H; p++) {
  const px0 = p % W, py0 = (p / W) | 0;
  if (px0 < gx0 || px0 > gx1 || py0 < gy0 || py0 > gy1) continue;
  const i = p * 4;
  const d = Math.abs(withPed.data[i] - without.data[i])
    + Math.abs(withPed.data[i + 1] - without.data[i + 1])
    + Math.abs(withPed.data[i + 2] - without.data[i + 2]);
  if (d <= 20) continue;
  mask[p] = 1; n++;
  const x = p % W, y = (p / W) | 0;
  if (x < x0) x0 = x;
  if (x > x1) x1 = x;
  if (y < y0) y0 = y;
  if (y > y1) y1 = y;
}
if (!n) throw new Error('walker did not render');
const bh = y1 - y0, bw = x1 - x0;

function over(pred, src) {
  const img = src ?? withPed;
  const uniq = new Set();
  let m = 0, sl = 0, sl2 = 0, sat = 0, sr = 0, sg = 0, sb = 0;
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || !pred(p % W, (p / W) | 0)) continue;
    const i = p * 4;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    uniq.add((r << 16) | (g << 8) | b);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    m++; sl += l; sl2 += l * l; sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 0) sat += (mx - mn) / mx;
  }
  if (!m) return { n: 0 };
  const mean = sl / m;
  return {
    n: m, uniq: uniq.size, uniqPerKpx: +((uniq.size / m) * 1000).toFixed(1),
    luma: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sl2 / m - mean * mean)).toFixed(2),
    sat: +(sat / m).toFixed(3),
    rgb: [+(sr / m).toFixed(1), +(sg / m).toFixed(1), +(sb / m).toFixed(1)],
  };
}

// What the figure is standing in front of, sampled from the frame with the
// figure removed over exactly the pixels it covered. A ratio inside one frame
// is the only brightness claim that survives auto-exposure moving.
const behind = over(() => true, without);
const all = over(() => true);
const head = over((x, y) => y < y0 + bh * 0.14);
const torso = over((x, y) => y > y0 + bh * 0.20 && y < y0 + bh * 0.52);
const legs = over((x, y) => y > y0 + bh * 0.66);

console.log(JSON.stringify({
  view: VIEW, hour, tier: TIER, coat: COAT, tone: TONE, yaw: YAW,
  exposure: +placed.exposure.toFixed(4), hasTone: placed.hasTone,
  box: { x: x0, y: y0, w: bw + 1, h: bh + 1 }, pixels: n,
  all, head, torso, legs, behind,
  figureOverBackground: +(all.luma / Math.max(behind.luma, 0.01)).toFixed(2),
}, null, 2));
if (errors.length) console.error('ERRORS', errors.slice(0, 6));

if (PNGOUT) {
  const pad = 20, z = 4;
  const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad);
  const cw = Math.min(W - cx, bw + 1 + pad * 2), ch = Math.min(H - cy, bh + 1 + pad * 2);
  const zo = new PNG({ width: cw * z, height: ch * z });
  for (let y = 0; y < ch * z; y++) {
    for (let x = 0; x < cw * z; x++) {
      const si = ((cy + Math.floor(y / z)) * W + cx + Math.floor(x / z)) * 4;
      const di = (y * zo.width + x) * 4;
      zo.data[di] = withPed.data[si]; zo.data[di + 1] = withPed.data[si + 1];
      zo.data[di + 2] = withPed.data[si + 2]; zo.data[di + 3] = 255;
    }
  }
  await writeFile(`${PNGOUT}-hero.png`, PNG.sync.write(zo));
  await writeFile(`${PNGOUT}-frame.png`, PNG.sync.write(withPed));
}
