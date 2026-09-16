/**
 * Scans a straight-down pick() across a line of world points, to map the
 * transverse profile of a road/rail cross-section (asphalt / ballast /
 * sidewalk / ballast / asphalt, for a double-track median) without having to
 * eyeball a screenshot. One browser session, one page load, many picks.
 *
 * Usage: node qa/_transit_profile.mjs <x0> <z0> <x1> <z1> <steps> [hour]
 *   Steps from (x0,z0) to (x1,z1) inclusive, straight-down pick at each.
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const [x0, z0, x1, z1, stepsArg, hourArg] = process.argv.slice(2);
const X0 = Number(x0), Z0 = Number(z0), X1 = Number(x1), Z1 = Number(z1);
const STEPS = Number(stepsArg || 10);
const HOUR = Number(hourArg || 13);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private */ }
});
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });
await page.evaluate((h) => window.__debug.setTime(h), HOUR);

for (let i = 0; i <= STEPS; i++) {
  const t = i / STEPS;
  const x = X0 + (X1 - X0) * t;
  const z = Z0 + (Z1 - Z0) * t;
  await page.evaluate((xx, zz) => {
    window.__debug.setView([xx, 120, zz + 0.01], [xx, 0, zz]);
  }, x, z);
  await page.evaluate(() => window.__debug.settle(3));
  const hits = await page.evaluate(() => window.__debug.pick(640, 360, 4));
  const names = (hits || []).map((hh) => hh.name).join(', ');
  console.log(`(${x.toFixed(1)}, ${z.toFixed(1)}) -> ${names}`);
}

await browser.close();
