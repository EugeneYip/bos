/**
 * Why boot never finishes on a phone-sized viewport.
 *
 * `qa/_safelvl.mjs` timed out waiting for `window.__ready` at 393x852 dpr 3 on
 * an M2 -- the same symptom the user reports on a real iPhone, where the tab
 * is then killed and reloaded, which is the loop. This reports how far boot
 * got instead of just failing: the progress caption, console errors, whether
 * the WebGL context was lost, and whether the renderer is still alive.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4411);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-final'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });

// width,height,dpr,safe — isolate which of these stalls boot.
const ARMS = (process.env.ARMS || '393,852,3,0|393,852,2,0|393,852,1,0|1180,820,2,0|1600,900,1,0').split('|');
for (const arm of ARMS) {
  const [W, H, DPR, SAFE] = arm.split(',').map(Number);
  const pg = await b.newPage();
  const errs = [], warns = [];
  pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  pg.on('console', m => { const t = m.text().slice(0,160);
    if (m.type() === 'error') errs.push(t); else if (/lost|fail|safe|WebGL/i.test(t)) warns.push(t); });
  await pg.emulate({ userAgent: UA,
    viewport: { width: W, height: H, deviceScaleFactor: DPR, isMobile: true, hasTouch: true, isLandscape: W > H } });
  await pg.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    try { localStorage.setItem('bh-onboarded','1'); } catch {}
    window.__ctxLost = 0;
    addEventListener('DOMContentLoaded', () => {
      const c = document.querySelector('canvas');
      if (c) c.addEventListener('webglcontextlost', () => { window.__ctxLost++; }, true);
    });
  });
  const t0 = Date.now();
  let ready = false;
  try {
    await pg.goto(`http://localhost:${PORT}/?safe=${SAFE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForFunction('window.__ready === true', { timeout: 90000, polling: 500 });
    ready = true;
  } catch {}
  const st = await pg.evaluate(() => {
    const boot = document.getElementById('boot');
    const cap = boot ? (boot.querySelector('#status,.status,p,span')?.textContent ?? boot.textContent ?? '') : '(no #boot)';
    const c = document.querySelector('canvas');
    return {
      caption: cap.trim().slice(0, 110),
      bootPresent: !!boot,
      canvas: c ? `${c.width}x${c.height}` : '(no canvas)',
      ctxLost: window.__ctxLost ?? -1,
      ready: window.__ready === true,
      heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
      diag: window.__debug ? (() => { try { const d = window.__debug.diag();
        return { mobile: d.mobile, tier: d.tier, safeLevel: d.safeLevel, pixelRatio: d.pixelRatio }; } catch { return 'diag threw'; } })() : '(no __debug)',
    };
  }).catch(e => ({ evalFailed: String(e).slice(0, 120) }));
  console.log(JSON.stringify({ arm: `${W}x${H}@${DPR} safe=${SAFE}`, ready, ms: Date.now()-t0, ...st,
    errs: errs.slice(0, 4), warns: warns.slice(0, 3) }));
  await pg.close();
}
await b.close(); srv.kill();
