#!/usr/bin/env node
/**
 * One-off diagnostic: boot the app headlessly and dump every quarter-res
 * field texel inside the Charles River Basin's bounding box whose baked
 * fetch is anomalously high, straight from the real WaterField instance
 * (exposed for this investigation via a temporary window hook in Water.ts).
 *
 *   node qa/_water_probe.mjs
 */
import puppeteer from 'puppeteer';

const PORT = Number(process.env.QA_PORT || 4552);
const OUTDIR = process.env.QA_OUTDIR || 'dist-water-h2o';

// Charles River Basin (r4129875) bounding box, from the raw area data.
const BBOX = { minX: -3713.98, minZ: -1410.85, maxX: -368.39, maxZ: 486.61 };

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 90000,
    protocolTimeout: 300000,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--enable-webgl2-compute-context',
      '--window-size=1600,900', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console-${m.type()}]`, m.text()); });
  await page.goto(`http://localhost:${PORT}/?q=ultra`, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 420000 });
  await page.waitForFunction('window.__waterField !== undefined', { timeout: 60000 });

  const { anomalies, total, histogram } = await page.evaluate((bbox) => {
    const f = window.__waterField;
    const bodies = window.__waterBodies;
    const anomalies = [];
    const histogram = {};
    let total = 0;
    for (let j = 0; j < f.sh; j++) {
      const z = f.z0 + (j + 0.5) * f.sts;
      if (z < bbox.minZ || z > bbox.maxZ) continue;
      for (let i = 0; i < f.sw; i++) {
        const x = f.x0 + (i + 0.5) * f.sts;
        if (x < bbox.minX || x > bbox.maxX) continue;
        total++;
        const idx = j * f.sw + i;
        const fetch = f.fetch[idx];
        const murk = f.murk[idx];
        const mask = f.mask[idx];
        const bucket = fetch.toFixed(2);
        histogram[bucket] = (histogram[bucket] || 0) + 1;
        if (fetch > 0.5) {
          const dist = f.sampleDist(x, z);
          if (dist > 0) { // only report texels that are genuinely inside water
            anomalies.push({ x: Math.round(x), z: Math.round(z), fetch: +fetch.toFixed(3), murk: +murk.toFixed(3), mask, dist: +dist.toFixed(1) });
          }
        }
      }
    }
    return { anomalies, total, histogram };
  }, BBOX);

  console.log(`scanned ${total} quarter-res texels inside the Charles bbox`);
  console.log('fetch histogram:', JSON.stringify(histogram));
  console.log(`\n${anomalies.length} texels with fetch>0.5 AND genuinely inside water (dist>0):`);
  for (const a of anomalies.slice(0, 60)) {
    console.log(`  (${a.x}, ${a.z})  fetch=${a.fetch}  murk=${a.murk}  mask=${a.mask}  dist=${a.dist}`);
  }
  if (anomalies.length > 60) console.log(`  ...and ${anomalies.length - 60} more`);

  await browser.close();
}

main().catch((e) => { console.error('[water-probe] FAILED:', e); process.exit(1); });
