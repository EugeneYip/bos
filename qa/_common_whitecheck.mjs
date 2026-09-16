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

let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-before.png', buf);

const nWater = await page.evaluate(() => window.__debug.toggle('water', false));
const nVeg = await page.evaluate(() => window.__debug.toggle('vegetation', false));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-noWaterNoVeg.png', buf);
console.log('toggled off water:', nWater, ' vegetation:', nVeg);

// Restore vegetation, keep water off, to isolate.
const nVeg2 = await page.evaluate(() => window.__debug.toggle('vegetation', true));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-noWaterOnly.png', buf);
console.log('restored vegetation:', nVeg2, ' (water still off)');

// Restore water, hide terrain instead, to see if it's terrain.
await page.evaluate(() => window.__debug.toggle('water', true));
const nTerrain = await page.evaluate(() => window.__debug.toggle('terrain', false));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/white-noTerrain.png', buf);
console.log('toggled off terrain:', nTerrain, '(water restored)');

await browser.close();
