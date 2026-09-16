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
const pts = [[200,620],[300,650],[100,680],[400,600],[250,550],[500,590],[150,600]];
for (const [x,y] of pts) {
  const hits = await page.evaluate((x, y) => window.__debug.pick(x, y, 8), x, y);
  console.log(`pick(${x},${y}):`, JSON.stringify(hits));
}
const buf = await page.screenshot();
const fs = await import('node:fs');
fs.writeFileSync('qa/shots/common/water-pick-check.png', buf);
await browser.close();
