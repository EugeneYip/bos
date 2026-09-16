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
const near = await page.evaluate((tx, tz) => {
  let mesh = null;
  window.__boston.ctx.scene.traverse((o) => { if (o.name === 'transit:pole') mesh = o; });
  if (!mesh) return null;
  const pos = mesh.geometry.getAttribute('position');
  let count = 0;
  const pts = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.hypot(x - tx, z - tz) < 60) { count++; if (pts.length < 6) pts.push([x.toFixed(1), y.toFixed(1), z.toFixed(1)]); }
  }
  return { totalVerts: pos.count, nearCount: count, sample: pts };
}, -3300, 610);
console.log(JSON.stringify(near, null, 2));
await browser.close();
