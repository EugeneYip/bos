import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, src, dst, X, Y, W, H, SCALE] = process.argv;
const img = PNG.sync.read(fs.readFileSync(src));
const x0 = Number(X), y0 = Number(Y), w = Number(W), h = Number(H), s = Number(SCALE || 1);
const out = new PNG({ width: Math.round(w * s), height: Math.round(h * s) });
for (let y = 0; y < out.height; y++) {
  for (let x = 0; x < out.width; x++) {
    const sx = Math.min(img.width - 1, x0 + Math.floor(x / s));
    const sy = Math.min(img.height - 1, y0 + Math.floor(y / s));
    const si = (sy * img.width + sx) * 4, di = (y * out.width + x) * 4;
    out.data[di] = img.data[si]; out.data[di+1] = img.data[si+1];
    out.data[di+2] = img.data[si+2]; out.data[di+3] = 255;
  }
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log(`${dst} ${out.width}x${out.height} from ${img.width}x${img.height}`);
