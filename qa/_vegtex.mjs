/**
 * Dump every vegetation texture the running app built, straight off the
 * canvas it was drawn on, so the art can be inspected at 1:1 instead of
 * guessed at from the render.
 *
 *   QA_OUTDIR=dist-p QA_PORT=4433 node qa/_vegtex.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4433);
const OUT = process.env.QA_OUTDIR || 'dist-p';
const TIER = process.env.TIER || 'high';
const DIR = `${ROOT}/qa/shots/vegtex`;

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUT],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'] });
const pg = await b.newPage();
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });

const maps = await pg.evaluate(() => {
  const out = [];
  const seen = new Set();
  window.__boston.ctx.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m || !m.map || !m.map.image || seen.has(m.map)) continue;
      seen.add(m.map);
      if (!/^veg:|^park:/.test(m.name || '')) continue;
      const img = m.map.image;
      if (typeof img.toDataURL !== 'function') continue;
      out.push({ name: m.name, w: img.width, h: img.height, url: img.toDataURL('image/png') });
    }
  });
  return out;
});
await mkdir(DIR, { recursive: true });
for (const m of maps) {
  const f = `${DIR}/${m.name.replace(/[^a-z0-9]+/gi, '_')}.png`;
  await writeFile(f, Buffer.from(m.url.split(',')[1], 'base64'));
  console.log(`${m.name.padEnd(34)} ${m.w}x${m.h} -> ${f}`);
}
await b.close(); srv.kill();
