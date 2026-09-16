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

const info = await page.evaluate(() => {
  const app = window.__boston;
  const ctx = app.ctx;
  const samples = [];
  for (let i = 95; i <= 122; i += 3) {
    const t = i / 179 * 0.1;
    const x = -120 + t * 260;
    const z = 60 - t * 340;
    const h = ctx.sampleHeight(x, z);
    samples.push({ i, x: +x.toFixed(2), z: +z.toFixed(2), h: +h.toFixed(3), camY: 8.3, below: h > 8.3 });
  }
  return {
    samples,
    background: ctx.scene.background ? String(ctx.scene.background) : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
