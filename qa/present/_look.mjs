/**
 * Shoot the LIVE deployed site, at the tiers a visitor can pick.
 *
 * Not a metric probe. The user reports the presented site looks rough across
 * all four quality tiers and the reduced-detail mode, and every measurement
 * here has been taken against a local build at safe=0 on a clean load. This
 * loads https://eugeneyip.github.io/bos/ exactly as they get it and saves
 * frames to look at.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const OUT = '/Volumes/Projects/bos/qa/present/shots';
fs.mkdirSync(OUT, { recursive: true });
const SITE = 'https://eugeneyip.github.io/bos/';
const W = 1600, H = 900, DPR = Number(process.env.DPR || 2);
const ARM = process.env.ARM || 'high';           // q tier, or 'safe1' / 'safe3'
const POSES = (process.env.POSES || 'boot-default,charles-water,water-detail,common-street').split(',');
const views = JSON.parse(fs.readFileSync('/Volumes/Projects/bos/qa/viewpoints.json', 'utf8'));
const byId = Object.fromEntries((Array.isArray(views) ? views : views.viewpoints).map(v => [v.id, v]));

const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });
const pg = await b.newPage();
await pg.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded','1'); localStorage.removeItem('bh-safe'); localStorage.removeItem('bh-boot'); } catch {} });
const errs = [];
pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
pg.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

const q = ARM.startsWith('safe') ? `?safe=${ARM.slice(4)}` : `?q=${ARM}`;
const t0 = Date.now();
await pg.goto(SITE + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
await pg.waitForFunction('window.__ready === true', { timeout: 420000, polling: 500 });
const bootMs = Date.now() - t0;
const d = await pg.evaluate(() => window.__debug.diag());

const drift = [];
for (const id of POSES) {
  const v = byId[id];
  if (!v) { console.log(`(no such pose ${id})`); continue; }
  await pg.evaluate((p) => { window.__debug.setTime(p.hour); window.__debug.setView(p.pos, p.target); }, v);
  // 700 frames, not 160. `Sky.advanceWeather` eases weather over about eight
  // simulated seconds and `weather.haze` drives `uApBetaM`, so a frame taken
  // before that completes is a frame of a different atmosphere. At 160 frames
  // (~2.7 s) every shot lands mid-transition, which silently confounded an
  // envMapIntensity sweep in this session: it read 0.93% / 1.69% / 0.38% /
  // 0.26% for 1.0 / 0.6 / 0.35 / 0.15 -- non-monotonic, because what was
  // actually changing between steps was the haze settling, not the parameter.
  await pg.evaluate(() => window.__debug.settle(700));
  const shot = await pg.screenshot();
  fs.writeFileSync(`${OUT}/${ARM}--${id}.png`, shot);

  // Prove the scene is stationary rather than assuming 700 is enough. Settle
  // again and compare: if the two frames differ, the atmosphere or the
  // streaming set is still moving and NOTHING measured here can be trusted.
  // This is the check whose absence made a haze transition look like a fix.
  await pg.evaluate(() => window.__debug.settle(400));
  const again = PNG.sync.read(Buffer.from(await pg.screenshot()));
  const first = PNG.sync.read(Buffer.from(shot));
  let n = 0, moved = 0, sum = 0;
  for (let y = 0; y < first.height; y += 3) for (let x = 0; x < first.width; x += 3) {
    const i = (y * first.width + x) * 4;
    const d = Math.abs(first.data[i] - again.data[i])
      + Math.abs(first.data[i+1] - again.data[i+1])
      + Math.abs(first.data[i+2] - again.data[i+2]);
    n++; sum += d; if (d > 12) moved++;
  }
  drift.push(`${id}: ${(100*moved/n).toFixed(2)}% pixels moved, mean |d| ${(sum/n/3).toFixed(2)}`);
}
const s = await pg.evaluate(() => window.__debug.stats());
for (const d of drift) console.log(`  drift ${d}`);
console.log(JSON.stringify({ arm: ARM, bootMs, tier: d.tier, safeLevel: d.safeLevel,
  pixelRatio: d.pixelRatio, dpr: d.devicePixelRatio, fps: s.fps, tris: s.tris,
  errs: errs.slice(0, 4) }));
await b.close();
