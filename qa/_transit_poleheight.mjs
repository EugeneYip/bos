import puppeteer from 'puppeteer';
const PORT = 4612;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
const result = await page.evaluate((tx, tz) => {
  let mesh = null;
  window.__boston.ctx.scene.traverse((o) => { if (o.name === 'transit:pole') mesh = o; });
  const pos = mesh.geometry.getAttribute('position');
  let minY = Infinity, maxY = -Infinity, n = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.hypot(x - tx, z - tz) < 8) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); n++; }
  }
  return { n, minY, maxY, height: maxY - minY };
}, -3247.1, 619.2);
console.log(JSON.stringify(result));
await browser.close();
