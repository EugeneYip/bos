import puppeteer from 'puppeteer';
const PORT = 4612;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
const info = await page.evaluate(() => {
  const out = [];
  window.__boston.ctx.scene.traverse((o) => {
    if (o.name === 'transit:wire' || o.name === 'transit:pole') {
      const g = o.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      out.push({
        name: o.name,
        vertexCount: g.getAttribute('position')?.count ?? null,
        bbox: bb ? { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] } : null,
        visible: o.visible,
        materialColor: o.material?.color?.getHexString?.(),
      });
    }
  });
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
