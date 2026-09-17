/**
 * What a degraded boot actually LOOKS like, on a phone viewport.
 *
 * Every visual probe in qa/ runs at safe=0 on a desktop viewport. A real
 * iPhone boots with MOBILE_FLOOR=1 and drops a rung further on each failed
 * load, so the frame a phone user sees has never been rendered here. The
 * user's own screenshot came back as flat pale-white sheets; this reports
 * mean luma and the blown-out fraction per rung so the jump is attributable.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4407);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const W = 393, H = 852;
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });

const hud = (x, y) => (y > H - 80 && x < 300) || (y > H - 60);
const out = [];
for (const lvl of [0, 1, 2]) {
  const pg = await b.newPage();
  await pg.emulate({ userAgent: UA,
    viewport: { width: W, height: H, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false } });
  await pg.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    try { localStorage.setItem('bh-onboarded','1'); } catch {}
  });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e).slice(0,140)));
  pg.on('console', m => { if (m.type()==='error') errs.push(m.text().slice(0,140)); });
  await pg.goto(`http://localhost:${PORT}/?safe=${lvl}`, { waitUntil:'networkidle2', timeout:180000 });
  await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
  const d = await pg.evaluate(() => window.__debug.diag());
  if (d.mobile !== true) { await b.close(); srv.kill(); throw new Error(`emulation is not reaching core/gpu.ts: mobile=${d.mobile}`); }
  await pg.evaluate(() => window.__debug.settle(240));
  const png = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/safe-${lvl}.png`, png);
  // Split sky from ground: the user's frame had a plausible sky over pale
  // sheets, so a whole-frame mean would average the defect away.
  const img = PNG.sync.read(Buffer.from(png));
  const IW = img.width, IH = img.height, s = IH / H;
  const hudP = (x, y) => (y > IH - 80*s && x < 300*s) || (y > IH - 60*s);
  const band = (y0, y1) => {
    let n = 0, sum = 0, blown = 0, flat = 0;
    for (let y = Math.floor(IH*y0); y < Math.floor(IH*y1); y += 3) {
      for (let x = 4; x < IW-4; x += 3) {
        if (hudP(x, y)) continue;
        const i = (y*IW+x)*4, r = img.data[i], g = img.data[i+1], bl = img.data[i+2];
        const L = 0.2126*r + 0.7152*g + 0.0722*bl;
        n++; sum += L;
        if (L > 235) blown++;
        if (L > 200 && Math.max(r,g,bl) - Math.min(r,g,bl) < 10) flat++;
      }
    }
    return { luma: +(sum/n).toFixed(1), blownPct: +(100*blown/n).toFixed(2), paleFlatPct: +(100*flat/n).toFixed(2) };
  };
  out.push({ lvl, reported: d.safeLevel, tier: d.tier, png: `${IW}x${IH}`,
    sky: band(0.02, 0.35), ground: band(0.45, 0.98), errs: errs.slice(0,3) });
  await pg.close();
}
console.log(JSON.stringify(out, null, 1));
await b.close(); srv.kill();
