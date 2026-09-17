#!/usr/bin/env node
/**
 * Put the camera 8 m from a pedestrian and report what the pedestrian is made
 * of.
 *
 * Defect #1 was measured on a figure that happened to walk into the middle of
 * one screenshot; that cannot be repeated after a change, because the crowd is
 * re-seeded on every boot. So this finds a walker instead: it reads the
 * instance matrices off the pedestrian mesh, picks the one nearest the centre
 * of the frame at a sensible distance, projects its bounding box, and measures
 * inside it — plus an equal-area patch of whatever is immediately beside it,
 * which is the only brightness reference that survives auto-exposure.
 *
 *   QA_PORT=4445 QA_OUTDIR=dist-v node qa/_heroped.mjs [--view common-street]
 *     [--hour 15] [--tier ultra] [--png out-prefix]
 */
import { spawn } from 'node:child_process';
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
const PNGOUT = flag('png', null);
const W = 1600, H = 900;

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
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
// Seed the world.
//
// Every car's colour, lane and position comes out of Math.random at boot, so
// two runs put a different fleet on a different street and no statistic over
// 'the vehicles in this frame' means the same thing twice — one run of this
// script found 10% of the frame covered in bodywork and the next found 0.03%.
// Replacing the generator before any module loads makes the whole city
// reproducible, so a before and an after describe the same cars.
await page.evaluateOnNewDocument((seed) => {
  let s = seed >>> 0;
  Math.random = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}, Number(process.env.QA_SEED || 0x2f6e2b1));
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
if (!vp) throw new Error(`no viewpoint ${VIEW}`);
const hour = HOUR !== null ? Number(HOUR) : vp.hour;
await page.evaluate((v, h) => { window.__debug.setView(v.pos, v.target); window.__debug.setTime(h); }, vp, hour);
await page.evaluate(() => window.__debug.settle(90));
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => window.__debug.settle(30));

/**
 * Stop the world.
 *
 * A walker covers 1.4 m/s and a screenshot round trip is about half a
 * second, so measuring a box computed before the capture put the rectangle
 * two thirds of a metre — 110 px at this range — to the left of the figure
 * it was supposed to describe. `running` is the app's own frame-loop latch;
 * with it down nothing steps, and a frame is drawn on demand instead.
 */
const freeze = () => page.evaluate(() => { window.__boston.running = false; });
const redraw = () => page.evaluate(() => {
  const app = window.__boston;
  if (app.renderOverride) app.renderOverride(1 / 60);
  else app.ctx.renderer.render(app.ctx.scene, app.ctx.camera);
});
await freeze();
await redraw();

/** Screen-space box of the best-placed walker, and the frame's exposure. */
const find = () => page.evaluate((w, h) => {
  const ctx = window.__boston.ctx;
  let mesh = null;
  ctx.scene.traverse((o) => { if (o.name === 'pedestrians') mesh = o; });
  if (!mesh) return null;
  const cam = ctx.camera;
  cam.updateMatrixWorld(true);
  const im = mesh.instanceMatrix.array;
  const vp = [];
  {
    // projection * viewInverse, column-major, both straight off the camera.
    const p = cam.projectionMatrix.elements, v = cam.matrixWorldInverse.elements;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += p[k * 4 + r] * v[c * 4 + k];
        vp[c * 4 + r] = s;
      }
    }
  }
  /** Object-space point through the instance matrix and then the camera. */
  const project = (e, x, y, z) => {
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
    const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
    const cz = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    return [cx / cw, cy / cw, cz / cw, cw];
  };
  let best = null;
  for (let i = 0; i < mesh.count; i++) {
    const m = { elements: im.subarray(i * 16, i * 16 + 16) };
    const px = m.elements[12], py = m.elements[13], pz = m.elements[14];
    const d = Math.hypot(px - cam.position.x, py - cam.position.y, pz - cam.position.z);
    if (d < 4 || d > 16) continue;
    // Corners of the instance's own box, so the reported rectangle is the
    // figure and not a guess from its origin.
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, behind = false;
    for (const dx of [-0.45, 0.45]) {
      for (const dy of [0.0, 1.85]) {
        for (const dz of [-0.45, 0.45]) {
          const v = project(m.elements, dx, dy, dz);
          if (v[3] <= 0) behind = true;
          const sx = (v[0] * 0.5 + 0.5) * w, sy = (-v[1] * 0.5 + 0.5) * h;
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
          y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
      }
    }
    if (behind) continue;
    if (x0 < 8 || y0 < 8 || x1 > w - 8 || y1 > h - 8) continue;
    // Prefer big and central.
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
    const score = (y1 - y0) - 0.10 * Math.hypot(cx - w / 2, cy - h / 2);
    if (!best || score > best.score) {
      best = { i, d, score, x0, y0, x1, y1, world: [px, py, pz] };
    }
  }
  return best ? { ...best, exposure: ctx.exposure, count: mesh.count } : null;
}, W, H);

let hero = await find();
if (!hero) {
  // Nobody close enough in the stock pose: drop the camera onto the footway
  // beside the nearest walker and look along it.
  const moved = await page.evaluate(() => {
    const ctx = window.__boston.ctx;
    let mesh = null;
    ctx.scene.traverse((o) => { if (o.name === 'pedestrians') mesh = o; });
    if (!mesh || !mesh.count) return false;
    const im = mesh.instanceMatrix.array;
    let bi = -1, bd = 1e9;
    for (let i = 0; i < mesh.count; i++) {
      const d = Math.hypot(im[i * 16 + 12] - ctx.camera.position.x, im[i * 16 + 14] - ctx.camera.position.z);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return false;
    const p = [im[bi * 16 + 12], im[bi * 16 + 13], im[bi * 16 + 14]];
    const a = Math.atan2(p[2] - ctx.camera.position.z, p[0] - ctx.camera.position.x);
    window.__debug.setView(
      [p[0] - Math.cos(a) * 8, p[1] + 1.55, p[2] - Math.sin(a) * 8],
      [p[0], p[1] + 0.95, p[2]],
    );
    return true;
  });
  if (moved) {
    await page.evaluate(() => { window.__boston.running = true; });
    await page.evaluate(() => window.__debug.settle(40));
    await freeze();
    await redraw();
    hero = await find();
  }
}
if (!hero) { await browser.close(); server.kill(); throw new Error('no pedestrian in frame'); }

const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
await browser.close(); server.kill();

const bx = Math.max(0, Math.round(hero.x0));
const by = Math.max(0, Math.round(hero.y0));
const bw = Math.min(png.width - bx, Math.round(hero.x1 - hero.x0));
const bh = Math.min(png.height - by, Math.round(hero.y1 - hero.y0));

function patch(x0, y0, w, h) {
  const uniq = new Set();
  let n = 0, sl = 0, sl2 = 0, sat = 0, sr = 0, sg = 0, sb = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      uniq.add((r << 16) | (g << 8) | b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++; sl += l; sl2 += l * l; sr += r; sg += g; sb += b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 0) sat += (mx - mn) / mx;
    }
  }
  const mean = sl / Math.max(n, 1);
  return {
    n, uniq: uniq.size, uniqPerKpx: +((uniq.size / Math.max(n, 1)) * 1000).toFixed(1),
    luma: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sl2 / n - mean * mean)).toFixed(2),
    sat: +(sat / Math.max(n, 1)).toFixed(3),
    rgb: [+(sr / n).toFixed(1), +(sg / n).toFixed(1), +(sb / n).toFixed(1)],
  };
}

// The torso: the middle third of the box, which is all clothing.
const torso = patch(bx + Math.round(bw * 0.25), by + Math.round(bh * 0.30),
  Math.max(2, Math.round(bw * 0.5)), Math.max(2, Math.round(bh * 0.25)));
// The head: the top eighth.
const head = patch(bx + Math.round(bw * 0.3), by, Math.max(2, Math.round(bw * 0.4)),
  Math.max(2, Math.round(bh * 0.13)));
// Whatever is beside the figure, same area, one box-width to the left.
const beside = patch(Math.max(0, bx - bw - 6), by + Math.round(bh * 0.55), bw, Math.round(bh * 0.3));

const out = {
  view: VIEW, hour, tier: TIER, exposure: +hero.exposure.toFixed(4),
  distance: +hero.d.toFixed(2), crowd: hero.count,
  box: { x: bx, y: by, w: bw, h: bh },
  torso, head, beside,
  torsoOverBeside: +(torso.luma / Math.max(beside.luma, 0.01)).toFixed(2),
};
console.log(JSON.stringify(out, null, 2));
if (errors.length) console.error('ERRORS', errors.slice(0, 6));

if (PNGOUT) {
  await writeFile(`${PNGOUT}-frame.png`, PNG.sync.write(png));
  const pad = 24, z = 4;
  const cx = Math.max(0, bx - pad), cy = Math.max(0, by - pad);
  const cw = Math.min(png.width - cx, bw + pad * 2), ch = Math.min(png.height - cy, bh + pad * 2);
  const zo = new PNG({ width: cw * z, height: ch * z });
  for (let y = 0; y < ch * z; y++) {
    for (let x = 0; x < cw * z; x++) {
      const si = ((cy + Math.floor(y / z)) * png.width + cx + Math.floor(x / z)) * 4;
      const di = (y * zo.width + x) * 4;
      zo.data[di] = png.data[si]; zo.data[di + 1] = png.data[si + 1];
      zo.data[di + 2] = png.data[si + 2]; zo.data[di + 3] = 255;
    }
  }
  await writeFile(`${PNGOUT}-hero.png`, PNG.sync.write(zo));
}
