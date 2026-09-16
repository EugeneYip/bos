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
await page.evaluate(() => window.__debug.setView([-120, 8.3, 60], [156, 49.6, -326]));
await page.evaluate(() => window.__debug.settle(120));
let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/official-common-street.png', buf);

await page.evaluate(() => window.__debug.setTime(18.2));
await page.evaluate(() => window.__debug.setView([-420, 95, 260], [-120, 55, -30]));
await page.evaluate(() => window.__debug.settle(120));
buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/official-golden-hour-dome.png', buf);

console.log('done');
await browser.close();
