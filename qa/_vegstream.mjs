/**
 * Does the impostor streamer follow the camera on a phone, and does it give
 * the memory back?
 *
 *   QA_OUTDIR=dist-p QA_PORT=4460 node qa/_vegstream.mjs
 *
 * Boots under an iPad user agent (which resolves to the `low` tier), reports
 * live impostor tiles and heap at the start, flies 6 km east, reports again,
 * flies back and reports a third time. A streamer that only ever adds will
 * show a monotonically rising tile count.
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4460);
const UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
  + 'Version/17.0 Mobile/15E148 Safari/604.1';
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir',
  process.env.QA_OUTDIR ?? 'dist-p'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--js-flags=--expose-gc', '--window-size=1180,820'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1180, height: 820 });
await pg.setUserAgent(UA);
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });

const cdp = await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable');
const probe = async (label) => {
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 900));
  const s = await pg.evaluate(() => {
    const st = window.__debug.stats();
    let far = 0;
    window.__boston.ctx.scene.traverse((o) => {
      if (o.isInstancedMesh && /:far:/.test(o.name)) far += o.count;
    });
    return { tiles: st['veg.farTiles'], farInstances: far, worstStreamMs: st['veg.worstStreamMs'],
      near: st['veg.near'], mid: st['veg.mid'], grass: st['veg.grass'],
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), fps: st.fps, calls: st.calls };
  });
  console.log(label.padEnd(24), JSON.stringify(s));
};

await pg.evaluate(() => window.__debug.settle(160));
await probe('boot (default view)');
await pg.evaluate(() => window.__debug.setView([-120, 40, 60], [400, 20, -300]));
await pg.evaluate(() => window.__debug.settle(200));
await probe('over the Common');
await writeFile(`${ROOT}/qa/shots/vegstream-common.png`, await pg.screenshot({ type: 'png' }));

for (let i = 1; i <= 12; i++) {
  await pg.evaluate((k) => window.__debug.setView([-120 + k * 400, 300, 60], [300 + k * 400, 0, -300]), i);
  await pg.evaluate(() => window.__debug.settle(40));
}
await pg.evaluate(() => window.__debug.settle(240));
await probe('after 4.8 km east');
await writeFile(`${ROOT}/qa/shots/vegstream-east.png`, await pg.screenshot({ type: 'png' }));

for (let i = 11; i >= 0; i--) {
  await pg.evaluate((k) => window.__debug.setView([-120 + k * 400, 300, 60], [300 + k * 400, 0, -300]), i);
  await pg.evaluate(() => window.__debug.settle(40));
}
await pg.evaluate(() => window.__debug.settle(240));
await probe('back at the Common');
if (errs.length) console.log('ERRORS', errs.slice(0, 6));
await b.close(); srv.kill();
