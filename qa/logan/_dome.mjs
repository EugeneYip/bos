/**
 * Is the pale field the sky dome, or the terrain?
 *
 * Runs both attributions in one boot, at hour 23 where the sun is exactly zero:
 *   - hide `sky-dome` alone (layers, not `visible`)
 *   - hide the terrain alone, and both together
 *   - `__terrain.setDebug(1|2)` — the terrain module's OWN uniform, which is
 *     live after `init` (the claim that it no-ops is true only of the URL path
 *     at boot) — paints the ground in LOD / splat-weight colours
 *   - `__terrain.setWireframe(true)`
 *   - terrain `material.color` -> magenta
 * and screenshots each so the answer is visual as well as numeric.
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4639);
const OUTDIR = process.env.QA_OUTDIR || 'dist-loganfix';
const A = process.argv.slice(2);
const fl = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const VIEW = fl('view', 'logan-taxi-wide');
const TIER = fl('tier', 'high');
const HOUR = Number(fl('hour', '23'));
const BOXES = (fl('boxes', 'paleA:855,455,45,18|paleB:350,455,25,18|darkA:430,455,45,18|sky:800,20,300,40'))
  .split('|').filter(Boolean).map((t) => { const [n, b] = t.split(':'); return { n, b: b.split(',').map(Number) }; });

await mkdir(`${ROOT}/qa/logan/shots`, { recursive: true });
const nonce = `${Date.now()}-dome`;
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
if (!await p.evaluate(() => !!window.__boston && !!window.__terrain)) { await b.close(); srv.kill(); throw new Error('no app/__terrain'); }

const vps = JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
await p.evaluate((v, hh) => { window.__debug.setTime(hh); window.__debug.setView(v.pos, v.target); }, vp, HOUR);
await new Promise((r) => setTimeout(r, 3500));

const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
async function settle(n = 50) {
  await p.evaluate((k) => window.__debug.settle(k), n);
  await new Promise((r) => setTimeout(r, 350));
  await p.evaluate((k) => window.__debug.settle(k), 25);
}
async function shot(name) {
  const buf = await p.screenshot({ type: 'png' });
  if (name) await writeFile(`${ROOT}/qa/logan/shots/${VIEW}--${name}.png`, buf);
  return PNG.sync.read(buf);
}
function rgbBox(img, bx) {
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = bx[1]; y < Math.min(bx[1] + bx[3], img.height); y++) {
    for (let x = bx[0]; x < Math.min(bx[0] + bx[2], img.width); x++) {
      const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2]; n++;
    }
  }
  r /= n; g /= n; bl /= n;
  return { mu: 0.2126 * r + 0.7152 * g + 0.0722 * bl, r, g, b: bl };
}
async function report(label, tag) {
  await settle(45);
  const img = await shot(tag);
  const parts = BOXES.map((r) => {
    const s = rgbBox(img, r.b);
    return `${r.n}=${s.mu.toFixed(1)}[${s.r.toFixed(0)}/${s.g.toFixed(0)}/${s.b.toFixed(0)}]`;
  });
  console.log(`  ${label.padEnd(38)} ${parts.join('  ')}`);
}

await settle(120);
const pr = await p.evaluate(() => window.__debug.probe());
console.log(`[probe] exp=${pr.exposure.toFixed(4)} sunInt=${pr.sunIntensity.toFixed(4)} elev=${pr.sunElevation.toFixed(4)}`);
console.log(`[terrain stats] ${JSON.stringify(await p.evaluate(() => window.__terrain.stats()))}`);
await report('BASE', `h${HOUR}-dome-base`);

// helpers in page
await p.evaluate(() => {
  const scene = window.__boston.ctx.scene;
  window.__byName = (n) => { let h = null; scene.traverse((o) => { if (!h && o.name === n) h = o; }); return h; };
  window.__hide = (n) => { const o = window.__byName(n); if (o) o.traverse((c) => c.layers.disable(0)); return !!o; };
  window.__show = (n) => { const o = window.__byName(n); if (o) o.traverse((c) => c.layers.enable(0)); return !!o; };
});

console.log('[layer ablation]');
console.log('  hide sky-dome ->', await p.evaluate(() => window.__hide('sky-dome')));
await report('sky-dome hidden', `h${HOUR}-dome-nodome`);
console.log('  hide terrain ->', await p.evaluate(() => window.__hide('terrain')));
await report('sky-dome + terrain hidden', `h${HOUR}-dome-nodome-noterrain`);
await p.evaluate(() => { window.__show('sky-dome'); });
await report('terrain hidden only', `h${HOUR}-dome-noterrain`);
await p.evaluate(() => { window.__show('terrain'); });
await report('restored', null);

console.log('[terrain own debug api]');
await p.evaluate(() => window.__terrain.setDebug(1));
await report('__terrain.setDebug(1) LOD levels', `h${HOUR}-dome-tdebug1`);
await p.evaluate(() => window.__terrain.setDebug(2));
await report('__terrain.setDebug(2) splat weights', `h${HOUR}-dome-tdebug2`);
await p.evaluate(() => window.__terrain.setDebug(0));
await p.evaluate(() => window.__terrain.setWireframe(true));
await report('__terrain.setWireframe(true)', `h${HOUR}-dome-twire`);
await p.evaluate(() => window.__terrain.setWireframe(false));

console.log('[terrain material colour]');
const tinted = await p.evaluate(() => {
  const t = window.__byName('terrain');
  const m = Array.isArray(t.material) ? t.material[0] : t.material;
  window.__tc = m.color.clone();
  m.color.setRGB(1, 0, 1);
  return `${m.type} name='${m.name}' envMap=${!!m.envMap} envMapIntensity=${m.envMapIntensity} fog=${m.fog}`;
});
console.log('  ' + tinted);
await report('terrain material.color = magenta', `h${HOUR}-dome-tmagenta`);
await p.evaluate(() => { const t = window.__byName('terrain'); const m = Array.isArray(t.material) ? t.material[0] : t.material; m.color.copy(window.__tc); });

// Where does the view ray at the pale pixel actually land on the heightfield?
const march = await p.evaluate(() => {
  const THREE = window.__THREE;
  const ctx = window.__boston.ctx;
  const el = ctx.renderer.domElement;
  const out = {};
  for (const [label, px, py] of [['paleA', 877, 464], ['darkA', 452, 464], ['paleB', 362, 464]]) {
    const ndc = new THREE.Vector2((px / el.clientWidth) * 2 - 1, -(py / el.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, ctx.camera);
    const o = ray.ray.origin.clone(); const d = ray.ray.direction.clone();
    let hit = null;
    for (let t = 1; t < 20000; t += 1) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y < ctx.sampleHeight(x, z)) { hit = { t, x: +x.toFixed(1), y: +y.toFixed(2), z: +z.toFixed(1), h: +ctx.sampleHeight(x, z).toFixed(2) }; break; }
    }
    out[label] = hit;
  }
  const t = window.__byName('terrain');
  const geo = t.geometry;
  const buf = geo.attributes.iChunk.data.array;
  const n = geo.instanceCount;
  const chunks = [];
  for (let i = 0; i < n; i++) chunks.push([buf[i * 5], buf[i * 5 + 1], buf[i * 5 + 2]]);
  const covers = (px, pz) => chunks.filter((c) => px >= c[0] && px < c[0] + c[2] && pz >= c[1] && pz < c[1] + c[2]);
  const res = { hits: out, instanceCount: n, cover: {} };
  for (const k of Object.keys(out)) {
    if (out[k]) res.cover[k] = covers(out[k].x, out[k].z).map((c) => `${c[0]},${c[1]} s=${c[2]}`);
  }
  res.chunkSizes = [...new Set(chunks.map((c) => c[2]))].sort((a, c) => a - c);
  res.chunkExtent = chunks.length ? [
    Math.min(...chunks.map((c) => c[0])), Math.max(...chunks.map((c) => c[0] + c[2])),
    Math.min(...chunks.map((c) => c[1])), Math.max(...chunks.map((c) => c[1] + c[2])),
  ] : null;
  return res;
});
console.log('[ray march vs heightfield]', JSON.stringify(march, null, 1));

await b.close();
srv.kill();
