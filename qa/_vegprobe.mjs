/**
 * Vegetation probe: boot one page session, drive to a viewpoint, and in that
 * single session pick pixels, dump stats, and shoot a set of mesh-toggle arms.
 *
 * Interleaving the arms in one session is the only way to compare them: the
 * auto-exposure moves between builds, so absolute luma across sessions means
 * nothing.
 *
 *   TIER=high VP=common-street \
 *   PTS='[[1170,380,"bald tree"],[200,700,"lawn"]]' \
 *   ARMS='[["base",[]],["nograss",[["vegetation:grass",false]]]]' \
 *   QA_OUTDIR=dist-p QA_PORT=4430 node qa/_vegprobe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4430);
const OUT = process.env.QA_OUTDIR || 'dist-p';
const TIER = process.env.TIER || 'high';
const VP = process.env.VP || 'common-street';
const PTS = JSON.parse(process.env.PTS || '[]');
const ARMS = JSON.parse(process.env.ARMS || '[]');
const TAG = process.env.TAG || '';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);

const viewpoints = JSON.parse(
  await (await import('node:fs/promises')).readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'),
);
const vp = viewpoints.find((v) => v.id === VP);
if (!vp) throw new Error(`no viewpoint ${VP}`);

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUT],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}

const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const pg = await b.newPage();
await pg.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errs = [];
pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
pg.on('pageerror', (e) => errs.push(String(e)));
await pg.evaluateOnNewDocument((res) => {
  try {
    localStorage.setItem('bh-onboarded', '1');
    localStorage.removeItem('bh-tier');
    if (res) localStorage.setItem('bh-res', res); else localStorage.removeItem('bh-res');
  } catch { /* private mode */ }
}, process.env.QA_RES ?? '');
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await pg.evaluate((h) => window.__debug.setTime(h), vp.hour);
await pg.evaluate((p, t) => window.__debug.setView(p, t), vp.pos, vp.target);
await new Promise((r) => setTimeout(r, 9000));
await pg.evaluate(() => window.__debug.settle(120));

const stats = await pg.evaluate(() => window.__debug.stats());
console.log('stats', JSON.stringify(Object.fromEntries(Object.entries(stats).filter(
  ([k]) => /veg|tree|park|fps|tris|calls/i.test(k)))));

/**
 * Which tree instances project near a pixel. `__debug.pick` cannot be used:
 * the release sweep nulls every non-position attribute, and three's
 * `checkGeometryIntersection` dereferences `attributes.uv.array`.
 */
for (const [x, y, label] of PTS) {
  const hits = await pg.evaluate(([px, py]) => {
    const ctx = window.__boston.ctx;
    const cam = ctx.camera;
    const el = ctx.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    cam.updateMatrixWorld(true);
    const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
    const xf = (M, x0, y0, z0, ww) => [
      M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12] * ww,
      M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13] * ww,
      M[2] * x0 + M[6] * y0 + M[10] * z0 + M[14] * ww,
      M[3] * x0 + M[7] * y0 + M[11] * z0 + M[15] * ww,
    ];
    const out = [];
    ctx.scene.traverse((o) => {
      if (!o.isInstancedMesh || !/^trees:|^vegetation:/.test(o.name)) return;
      const a = o.instanceMatrix.array;
      const W = o.matrixWorld.elements;
      for (let i = 0; i < o.count; i++) {
        const b = i * 16;
        const hgt = Math.hypot(a[b + 4], a[b + 5], a[b + 6]);
        // Sample the crown centre, not the root, so a tall tree reports where
        // its foliage actually is.
        const wp = xf(W, a[b + 12], a[b + 13] + hgt * 0.6, a[b + 14], 1);
        const e = xf(V, wp[0], wp[1], wp[2], 1);
        const c = xf(P, e[0], e[1], e[2], 1);
        if (c[3] <= 0) continue;
        const sx2 = (c[0] / c[3] * 0.5 + 0.5) * w;
        const sy2 = (-c[1] / c[3] * 0.5 + 0.5) * h;
        const d = Math.hypot(sx2 - px, sy2 - py);
        if (d > 90) continue;
        out.push({ name: o.name, d: Math.round(d), dist: Math.round(Math.hypot(
          wp[0] - cam.position.x, wp[2] - cam.position.z)), height: +hgt.toFixed(1) });
      }
    });
    out.sort((a2, b2) => a2.d - b2.d);
    return out.slice(0, 6);
  }, [x, y]);
  console.log(`(${String(x).padStart(4)},${String(y).padStart(3)}) ${String(label).padEnd(14)}`
    + (hits.length ? hits.map((k) => `${k.name} h=${k.height} @${k.dist}m ${k.d}px`).join(' | ') : '(none)'));
}

// Per-mesh instance census: count and the distance range actually occupied.
const census = await pg.evaluate(() => {
  const ctx = window.__boston.ctx;
  const cam = ctx.camera.position;
  const rows = [];
  ctx.scene.traverse((o) => {
    if (!o.isInstancedMesh || !/^trees:|^vegetation:/.test(o.name)) return;
    if (!o.count) return;
    const a = o.instanceMatrix.array;
    let lo = 1e9, hi = 0, hmin = 1e9, hmax = 0;
    for (let i = 0; i < o.count; i++) {
      const b = i * 16;
      const d = Math.hypot(a[b + 12] - cam.x, a[b + 14] - cam.z);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      const h = Math.hypot(a[b + 4], a[b + 5], a[b + 6]);
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
    rows.push({ n: o.name, c: o.count, lo: Math.round(lo), hi: Math.round(hi),
      h: `${hmin.toFixed(0)}-${hmax.toFixed(0)}`, vis: o.visible });
  });
  const agg = {};
  for (const r of rows) {
    const k = r.n.replace(/:far:\d+$/, ':far');
    if (!agg[k]) agg[k] = { c: 0, lo: 1e9, hi: 0 };
    agg[k].c += r.c; agg[k].lo = Math.min(agg[k].lo, r.lo); agg[k].hi = Math.max(agg[k].hi, r.hi);
  }
  return agg;
});
for (const [k, v] of Object.entries(census)) {
  if (!/:near|:mid|vegetation:/.test(k) && v.c < 1) continue;
  console.log(`  ${k.padEnd(34)} n=${String(v.c).padStart(6)}  d=${v.lo}..${v.hi}m`);
}

await mkdir(`${ROOT}/qa/shots`, { recursive: true });
for (const [name, toggles] of ARMS) {
  for (const [mesh, on] of toggles) await pg.evaluate((m, v) => window.__debug.toggle(m, v), mesh, on);
  await pg.evaluate(() => window.__debug.settle(90));
  const buf = await pg.screenshot({ type: 'png' });
  const f = `${ROOT}/qa/shots/${VP}--${TAG || TIER}-${name}.png`;
  await writeFile(f, buf);
  console.log('[arm]', f);
  // restore
  for (const [mesh] of toggles) await pg.evaluate((m) => window.__debug.toggle(m, true), mesh);
}

if (errs.length) console.log('ERRORS', errs.slice(0, 8));
await b.close();
srv.kill();
