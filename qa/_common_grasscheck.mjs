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
const fs = await import('node:fs');

// Official common-street viewpoint, exactly as shipped in qa/viewpoints.json.
await page.evaluate(() => window.__debug.setTime(15.0));
await page.evaluate(() => window.__debug.setView([-120, 8.3, 60], [156, 49.6, -326]));
await page.evaluate(() => window.__debug.settle(120));
let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/after-common-street.png', buf);

// A steep, close-range grazing angle over open lawn -- the framing where a
// tile lattice would be most visible -- with vegetation's ground-cover
// blades hidden so the bare parks:grass surface itself is what's on screen.
await page.evaluate(() => window.__debug.setView([-60, 1.6, -40], [-40, 0.3, -70]));
await page.evaluate(() => window.__debug.settle(60));
const nVeg = await page.evaluate(() => window.__debug.toggle('vegetation', false));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/after-grazing-lawn.png', buf);
console.log('vegetation toggled off:', nVeg);

const pts = [[300,600],[500,650],[700,600],[900,650],[1000,550]];
for (const [x,y] of pts) {
  const hits = await page.evaluate((x, y) => window.__debug.pick(x, y, 4), x, y);
  console.log(`pick(${x},${y}):`, JSON.stringify(hits));
}

await browser.close();
