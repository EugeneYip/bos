#!/usr/bin/env node
/** Grabs the [VegDiag] console line: mean linear luminance of each species'
 * near (leaf), mid (clump) and far (impostor) textures, straight from the
 * build. Used to check whether a tree's near-tier and mid-tier art differ
 * enough in brightness that swapping between them in a single frame (the
 * near/mid LOD boundary, see Vegetation.ts materialsFor) would actually be
 * visible as a pop, independent of any screen-space luma measurement. */
import puppeteer from 'puppeteer';
const PORT = Number(process.env.QA_PORT || 4611);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage();
let line = null;
page.on('console', (m) => { if (m.text().includes('[VegDiag]')) line = m.text(); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* ignore */ } });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await new Promise((r) => setTimeout(r, 500));
console.log(line);
await browser.close();
