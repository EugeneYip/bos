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

await page.evaluate(() => window.__debug.setTime(15.0));
// Common-street position, but aimed down and across the open lawn instead of
// up into the canopy: a moderate downward pitch, still looking well ahead
// rather than at the camera's own feet, matching how the paver lattice was
// originally spotted "in the foreground".
await page.evaluate(() => window.__debug.setView([-120, 1.7, 60], [-40, 0.2, -40]));
await page.evaluate(() => window.__debug.settle(90));
const nVeg = await page.evaluate(() => window.__debug.toggle('vegetation', false));
await page.evaluate(() => window.__debug.settle(5));
let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/after-grazing-lawn2.png', buf);
console.log('vegetation toggled off:', nVeg);
await page.evaluate(() => window.__debug.toggle('vegetation', true));
await page.evaluate(() => window.__debug.settle(5));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/after-grazing-lawn2-withveg.png', buf);

await browser.close();
