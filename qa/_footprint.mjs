/**
 * TOTAL footprint on a phone, over time — what actually gets the tab killed.
 *
 * The user reports the view surviving a few seconds and then returning to the
 * loading screen, which is a steady-state kill, not a boot-peak kill. Peak JS
 * heap (qa/_peak.mjs) cannot see that: GPU memory is not in
 * `performance.memory`, and iOS counts it. This sums the three that matter --
 * JS heap, render targets, and GPU-resident vertex/index data -- and samples
 * them while the camera flies, so streaming churn is included.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4413);
const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const PHONE = !process.env.DESKTOP;
const W = Number(process.env.W || (PHONE ? 393 : 1600));
const H = Number(process.env.H || (PHONE ? 852 : 900));
const DPR = Number(process.env.DPR || (PHONE ? 3 : 1));
const SAFE = process.env.SAFE ?? (PHONE ? '1' : '0');
const SECONDS = Number(process.env.SECONDS || 45);

const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir', process.env.QA_OUTDIR ?? 'dist-final'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });
const pg = await b.newPage();
await pg.emulate({ userAgent: PHONE ? UA_PHONE : UA_MAC,
  viewport: { width: W, height: H, deviceScaleFactor: DPR, isMobile: PHONE, hasTouch: PHONE, isLandscape: W > H } });
if (PHONE) await pg.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
});
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded','1'); } catch {} });

const MEASURE = () => {
  const app = window.__boston, r = app.ctx.renderer, gl = r.getContext();
  // Render targets: walk the modules, same shape as qa/_gpumem.mjs.
  const bytesFor = (t) => {
    const tex = t.texture; if (!tex) return 0;
    const ch = tex.format === 1028 ? 1 : 4;
    const bpc = (tex.type === 1016 || tex.type === 1017) ? 2 : (tex.type === 1015 ? 4 : 1);
    let n = t.width * t.height * ch * bpc;
    if (t.depthTexture || t.depthBuffer) n += t.width * t.height * 4;
    return n;
  };
  const seen = new Set(); let rtBytes = 0;
  const walk = (o, d) => { if (!o || d > 3 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
    if (o.isWebGLRenderTarget) { rtBytes += bytesFor(o); return; }
    if (Array.isArray(o)) { for (const v of o) walk(v, d + 1); return; }
    for (const k in o) { try { walk(o[k], d + 1); } catch {} } };
  for (const m of app.modules) walk(m, 0);

  // GPU-resident geometry: count*itemSize*bytes, which survives the CPU-side
  // array being nulled by releaseStaticAttributes.
  const geo = new Set(); let gpuGeoBytes = 0, tris = 0;
  app.ctx.scene.traverse((o) => {
    const g = o.geometry; if (!g || geo.has(g)) return; geo.add(g);
    for (const name in g.attributes) {
      const a = g.attributes[name];
      const bpe = a.array ? a.array.BYTES_PER_ELEMENT : 4;
      gpuGeoBytes += a.count * a.itemSize * bpe;
    }
    if (g.index) gpuGeoBytes += g.index.count * (g.index.array?.BYTES_PER_ELEMENT ?? 4);
    tris += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
  });

  const heap = performance.memory?.usedJSHeapSize || 0;
  return {
    heapMB: Math.round(heap / 1048576),
    rtMB: Math.round(rtBytes / 1048576),
    gpuGeoMB: Math.round(gpuGeoBytes / 1048576),
    totalMB: Math.round((heap + rtBytes + gpuGeoBytes) / 1048576),
    buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
    textures: r.info.memory.textures, geometries: r.info.memory.geometries,
    triM: +(tris / 1e6).toFixed(2),
  };
};

const missing = [];
pg.on('requestfailed', (r) => missing.push(r.url()));
pg.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
await pg.goto(`http://localhost:${PORT}/?safe=${SAFE}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
// A build made without VITE_BASE=/ asks for /bos/assets/... , every asset
// 404s, and the page sits on the boot overlay forever -- which is
// indistinguishable from a real boot hang, and has burned two probe runs.
// Say so in one line instead of timing out five minutes later.
await new Promise((r) => setTimeout(r, 1500));
if (missing.some((u) => /\/bos\//.test(u))) {
  await b.close(); srv.kill();
  throw new Error(`the build in ${process.env.QA_OUTDIR ?? 'dist-final'} was made without VITE_BASE=/ -- assets 404 under /bos/. Rebuild: VITE_BASE=/ npx vite build --outDir <dir>`);
}
await pg.waitForFunction('window.__ready === true', { timeout: 240000, polling: 500 });
const d = await pg.evaluate(() => window.__debug.diag());
if (PHONE !== d.mobile) { await b.close(); srv.kill(); throw new Error(`wanted mobile=${PHONE}, app says ${d.mobile}`); }
await pg.evaluate(() => window.__debug.settle(240));

const samples = [{ t: 0, ...(await pg.evaluate(MEASURE)) }];
// Fly, so streaming loads and unloads the way it does for a real visitor.
for (let i = 1; i <= SECONDS / 5; i++) {
  await pg.evaluate((k) => {
    const a = k * 0.9;
    window.__debug.setView([1200 * Math.cos(a), 220 + 60 * Math.sin(a * 0.7), 1200 * Math.sin(a)], [0, 40, 0]);
  }, i);
  await pg.evaluate(() => window.__debug.settle(90));
  samples.push({ t: i * 5, ...(await pg.evaluate(MEASURE)) });
}
// Then hold still. If the footprint comes back down, eviction is merely
// lagging the camera and the fix is to bound it; if it stays up, shards are
// being retained after they leave range and it is a leak. The distinction
// decides the whole fix, so measure it rather than assuming.
const rest = [];
for (const wait of [5, 10, 20]) {
  await pg.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), wait * 1000);
  await pg.evaluate(() => window.__debug.settle(60));
  rest.push({ t: `still+${wait}s`, ...(await pg.evaluate(MEASURE)) });
}
const peak = samples.reduce((a, s) => s.totalMB > a.totalMB ? s : a, samples[0]);
console.log(JSON.stringify({
  arm: `${PHONE ? 'phone' : 'desktop'} ${W}x${H}@${DPR} safe=${SAFE} tier=${d.tier}`,
  first: samples[0], peak, rest,
  totalCurve: samples.map(s => s.totalMB).join(','),
  heapCurve: samples.map(s => s.heapMB).join(','),
}, null, 1));
await b.close(); srv.kill();
