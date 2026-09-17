#!/usr/bin/env node
/**
 * Which tree is bare, and why.
 *
 * Picks along a column of pixels through a suspect crown and reports what the
 * ray hits, then isolates each species/LOD mesh in turn and shoots it, so a
 * crown that is missing can be told from a crown that is merely hidden behind
 * a trunk or eaten by the LOD cross-fade.
 *
 *   QA_PORT=4434 QA_OUTDIR=dist-p node qa/_bare.mjs [--view common-street]
 *     [--picks 1160,340 1160,400 1160,460] [--isolate 1]
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4434);
const OUTDIR = process.env.QA_OUTDIR || 'dist-p';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const list = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
};
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'common-street');
const TAG = flag('tag', 'bare');
const PICKS = list('picks');
const ISOLATE = flag('isolate', '') === '1';

async function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return p; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill(); throw new Error('preview server did not start');
}

const server = await startServer();
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); } catch { /* */ }
});
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 240000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
await page.evaluate((h) => window.__debug.setTime(h), vp.hour);
await page.evaluate((p, t) => window.__debug.setView(p, t), vp.pos, vp.target);
await new Promise((r) => setTimeout(r, 6000));
await page.evaluate(() => window.__debug.settle(90));

/* --------------------------------------------------- what is drawn at all */
const meshes = await page.evaluate(() => {
  const out = [];
  window.__boston.ctx.scene.traverse((o) => {
    if (!/^trees:/.test(o.name || '')) return;
    out.push({
      name: o.name,
      count: o.count,
      visible: o.visible,
      groups: (o.geometry?.groups ?? []).map((g) => `${g.start}+${g.count}@${g.materialIndex}`),
      mats: (Array.isArray(o.material) ? o.material : [o.material]).map((m) => m && m.name),
    });
  });
  return out.filter((m) => m.count > 0);
});
console.log('[stats]', JSON.stringify(await page.evaluate(() => {
  const s = window.__debug.stats();
  const out = {};
  for (const [k, v] of Object.entries(s)) if (/veg|tri|draw|fps|frame/i.test(k)) out[k] = v;
  return out;
})));
console.log('[meshes]');
for (const m of meshes) {
  console.log(`  ${m.name.padEnd(34)} n=${String(m.count).padStart(6)} vis=${m.visible} `
    + `groups=[${m.groups.join(' ')}] mats=[${m.mats.join(' ')}]`);
}

/* ------------------------------------------------------------------ picks */
for (const p of PICKS) {
  const [x, y] = p.split(',').map(Number);
  const hits = await page.evaluate((a, b) => window.__debug.pick(a, b, 8), x, y);
  console.log(`[pick] ${x},${y}`, JSON.stringify(hits));
}

await writeFile(path.join(ROOT, `qa/shots/${VIEW}--${TAG}-all.png`), await page.screenshot({ type: 'png' }));

/* ------------------------------------------------------------ lod paint -- */
/**
 * Recolour the leaf cards by LOD tier and black out every trunk, so a crown
 * that has no foliage can be told apart from one whose foliage is simply
 * behind a bright trunk — which is what the last investigation of this
 * turned out to be.
 */
if (flag('paint', '') === '1') {
  await page.evaluate(() => {
    // Hue, not brightness: wood pure red, foliage pure green, so the
    // classifier below is a channel comparison and a card standing in deep
    // shade is still counted as a card. Painting wood *black* — the obvious
    // thing — silently counts every shaded leaf as a branch.
    const paint = { near: [0, 3, 0], mid: [0, 3, 0], far: [0, 3, 0] };
    window.__boston.ctx.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) {
        const n = (m && m.name) || '';
        if (!n.startsWith('veg:')) continue;
        const u = m.userData && m.userData.uniforms;
        if (!u || !u.uSummer) continue;
        const lod = n.includes(':near:') ? 'near' : n.includes(':mid:') ? 'mid' : 'far';
        const c = n.endsWith(':bark') ? [3, 0, 0] : paint[lod];
        for (const k of ['uSummer', 'uAutumn', 'uSenescent']) u[k].value.setRGB(c[0], c[1], c[2]);
      }
    });
  });
  await page.evaluate(() => window.__debug.settle(60));
  const shot = await page.screenshot({ type: 'png' });
  await writeFile(path.join(ROOT, `qa/shots/${VIEW}--${TAG}-paint.png`), shot);
  // With trunks painted near-black and foliage painted in saturated primaries,
  // the share of the canopy band that is *wood* is a direct, repeatable
  // measure of how skeletal the trees read. Sky is excluded by its blue.
  const img = PNG.sync.read(shot);
  const [bx, by, bw, bh] = (flag('band', '0,0,1600,500')).split(',').map(Number);
  let wood = 0, foliage = 0, other = 0;
  for (let y = by; y < Math.min(by + bh, img.height); y++) {
    for (let x = bx; x < Math.min(bx + bw, img.width); x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > g * 1.3 && r >= b) wood++;
      else if (g > r * 1.3 && g >= b) foliage++;
      else other++;                                             // sky, ground, people
    }
  }
  console.log('[wood]', JSON.stringify({
    wood, foliage, other,
    woodShare: +(wood / (wood + foliage)).toFixed(4),
  }));
}

/* -------------------------------------------------------------- isolation */
if (ISOLATE) {
  const species = [...new Set(meshes.map((m) => m.name.replace(/^trees:/, '').replace(/:(near|mid|far).*$/, '')))];
  for (const s of species) {
    await page.evaluate((sp) => {
      window.__debug.toggle('trees:', false);
      window.__boston.ctx.scene.traverse((o) => {
        if ((o.name || '').startsWith(`trees:${sp}:`)) o.visible = true;
      });
    }, s);
    await page.evaluate(() => window.__debug.settle(50));
    await writeFile(
      path.join(ROOT, `qa/shots/${VIEW}--${TAG}-${s.replace(/\s+/g, '_')}.png`),
      await page.screenshot({ type: 'png' }),
    );
    console.log('[isolate]', s);
  }
  await page.evaluate(() => window.__debug.toggle('trees:', true));
}

console.log('[errors]', errs.slice(0, 5));
await browser.close();
server.kill();
