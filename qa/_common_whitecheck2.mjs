#!/usr/bin/env node
import puppeteer from 'puppeteer';
const PORT = Number(process.env.QA_PORT || 4611);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await page.evaluate(() => window.__debug.setTime(15.0));
await page.evaluate(() => window.__debug.setView([-103.7, 8.3, 38.7], [116.3, 30, -101.3]));
await page.evaluate(() => window.__debug.settle(30));
const fs = await import('node:fs');

const nParks = await page.evaluate(() => window.__debug.toggle('parks', false));
await page.evaluate(() => window.__debug.settle(5));
let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-noParks.png', buf);
console.log('toggled off parks:', nParks);

await page.evaluate(() => window.__debug.toggle('parks', true));
const nVeg = await page.evaluate(() => window.__debug.toggle('vegetation', false));
const nWater = await page.evaluate(() => window.__debug.toggle('water', false));
await page.evaluate(() => window.__debug.settle(5));
// Now also hide parks, on top of water+veg already hidden, to see the bare scene.
const nParks2 = await page.evaluate(() => window.__debug.toggle('parks', false));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-noParksNoWaterNoVeg.png', buf);
console.log('parks+water+veg all off:', nParks2, nWater, nVeg);

// Report scene graph names near the camera for context (dedup).
const names = await page.evaluate(() => {
  const app = window.__boston;
  const ctx = app.ctx;
  const set = new Set();
  ctx.scene.traverse((o) => { if (o.name) set.add(o.name); });
  return [...set].filter((n) => /park|terrain|water|ground/i.test(n));
});
console.log('matching scene names:', JSON.stringify(names));

await browser.close();
