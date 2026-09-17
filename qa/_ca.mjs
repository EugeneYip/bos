/** Chromatic aberration census: |R-B| on high-contrast edges, by radius. */
import fs from 'node:fs';
import { PNG } from 'pngjs';
const files = process.argv.slice(2);
for (const f of files) {
  const a = PNG.sync.read(fs.readFileSync(f));
  const W = a.width, H = a.height;
  let inner = [0, 0], outer = [0, 0], big = 0, tot = 0, peak = 0;
  const lum = (i) => 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = (y * W + x) * 4;
      // Only look at edges: CA is invisible on flat fields.
      const g = Math.abs(lum(i + 4) - lum(i - 4)) + Math.abs(lum(i + W * 4) - lum(i - W * 4));
      if (g < 60) continue;
      const rb = Math.abs(a.data[i] - a.data[i + 2]);
      const dx = (x / W - 0.5), dy = (y / H - 0.5);
      const r = Math.hypot(dx, dy) / 0.707;
      tot++; if (rb > 60) big++; if (rb > peak) peak = rb;
      if (r < 0.2) { inner[0] += rb; inner[1]++; } else if (r > 0.8) { outer[0] += rb; outer[1]++; }
    }
  }
  const nm = f.split('/').pop();
  console.log(`${nm.padEnd(34)} edges ${String(tot).padStart(7)}  |R-B|>60 ${(big/Math.max(tot,1)*100).toFixed(2).padStart(6)}%  `
    + `inner ${(inner[0]/Math.max(inner[1],1)).toFixed(1).padStart(5)}  outer ${(outer[0]/Math.max(outer[1],1)).toFixed(1).padStart(5)}  peak ${peak}`);
}
