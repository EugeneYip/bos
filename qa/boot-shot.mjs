/**
 * Shoots the application's own opening camera.
 *
 * Every other harness here drives `__debug.setView`, which replaces the
 * default framing -- so none of them can photograph the first thing a visitor
 * sees. This one touches nothing: it waits for `__ready`, settles, and shoots
 * whatever `CameraRig` chose.
 *
 *   node qa/boot-shot.mjs <label> [extra query string]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const label = process.argv[2] || 'boot';
const extra = process.argv[3] || '';
const PORT = 4536;
const ROOT = '/Volumes/Projects/bos';

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', 'dist-qa'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 720 });
await pg.evaluateOnNewDocument(() => {
  try { localStorage.removeItem('bh-tier'); localStorage.removeItem('bh-res'); localStorage.setItem('bh-onboarded', '1'); } catch {}
});
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

await pg.goto(`http://localhost:${PORT}/?q=high${extra}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
// Let streaming finish and TAA converge; the opening view is what a visitor
// stares at for several seconds, not a single frame.
await new Promise((r) => setTimeout(r, 12000));

const buf = await pg.screenshot();
const out = `${ROOT}/qa/shots/fog/${label}.png`;
fs.writeFileSync(out, buf);

const p = PNG.sync.read(buf);
const L = (i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
/** Local contrast and mean luma over a band, so haze shows as low contrast. */
const band = (y0, y1, x0, x1) => {
  let s = 0, mean = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * p.width + x) * 4;
    s += Math.abs(L(i) - L(i + 4)) + Math.abs(L(i) - L(i + p.width * 4));
    mean += L(i); n++;
  }
  return { c: s / n, l: mean / n };
};
const far = band(240, 330, 100, 1180);   // middle distance, dissolving first
const sun = band(240, 460, 40, 420);     // toward the low sun
const near = band(480, 660, 200, 1080);  // foreground, should always be crisp
const skyB = band(180, 205, 100, 1180);  // sky just above the horizon
const grdB = band(232, 258, 100, 1180);  // ground just below it
const cam = await pg.evaluate(() => {
  const c = window.__boston.ctx.camera;
  return { p: [c.position.x | 0, c.position.y | 0, c.position.z | 0], exp: +window.__boston.ctx.exposure.toFixed(3) };
});
console.log(`${label}  cam ${cam.p.join(',')}  exp ${cam.exp}`);
console.log(`  far    contrast ${far.c.toFixed(2)}  luma ${far.l.toFixed(1)}`);
console.log(`  sunlit contrast ${sun.c.toFixed(2)}  luma ${sun.l.toFixed(1)}`);
console.log(`  near   contrast ${near.c.toFixed(2)}  luma ${near.l.toFixed(1)}`);
console.log(`  horizon step  sky ${skyB.l.toFixed(1)} -> ground ${grdB.l.toFixed(1)}  (${(grdB.l - skyB.l).toFixed(1)})`);
console.log(`  errors ${errs.length}${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

await b.close(); srv.kill();
