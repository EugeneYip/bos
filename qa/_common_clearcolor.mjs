#!/usr/bin/env node
import puppeteer from 'puppeteer';
const PORT = Number(process.env.QA_PORT || 4611);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await page.evaluate(() => window.__debug.setTime(15.0));
await page.evaluate(() => window.__debug.setView([-120, 1.7, 60], [-40, 0.2, -40]));
await page.evaluate(() => window.__debug.settle(60));

const info = await page.evaluate(() => {
  const app = window.__boston;
  const ctx = app.ctx;
  const r = ctx.renderer;
  const c = new (Object.getPrototypeOf(ctx.scene).constructor === undefined ? Object : Object)();
  const out = { autoClear: r.autoClear, autoClearColor: r.autoClearColor };
  try {
    const col = r.getClearColor(new (r.getClearColor.length ? Object : Object)());
  } catch (e) { out.clearColorErr = String(e); }
  // three's WebGLRenderer.getClearColor needs a THREE.Color target; grab THREE off a material instead.
  return out;
});
console.log('renderer flags:', JSON.stringify(info));

const info2 = await page.evaluate(() => {
  const app = window.__boston;
  const ctx = app.ctx;
  // Reach into three via an existing object's constructor chain to build a Color.
  const anyMat = ctx.scene.children[0];
  return {
    sceneBackground: ctx.scene.background ? 'set' : null,
    fog: ctx.scene.fog ? { near: ctx.scene.fog.near, far: ctx.scene.fog.far, color: ctx.scene.fog.color ? [ctx.scene.fog.color.r, ctx.scene.fog.color.g, ctx.scene.fog.color.b] : null } : null,
  };
});
console.log('scene:', JSON.stringify(info2));

const nFar = await page.evaluate(() => window.__debug.toggle('far-terrain', false));
await page.evaluate(() => window.__debug.settle(5));
const fs = await import('node:fs');
let buf = await page.screenshot();
fs.writeFileSync('qa/shots/common/after-nofarterrain.png', buf);
console.log('toggled off far-terrain:', nFar);
await browser.close();
