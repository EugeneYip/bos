import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, a, b] = process.argv;
const A = PNG.sync.read(fs.readFileSync(a)), B = PNG.sync.read(fs.readFileSync(b));
const band = (img, y0, y1) => {
  let n=0, s=0, mx=0; const hist = new Array(8).fill(0);
  for (let y = Math.floor(img.height*y0); y < Math.floor(img.height*y1); y += 2)
    for (let x = 4; x < img.width-4; x += 2) {
      const i=(y*img.width+x)*4;
      const L = 0.2126*img.data[i] + 0.7152*img.data[i+1] + 0.0722*img.data[i+2];
      n++; s+=L; if (L>mx) mx=L; hist[Math.min(7, Math.floor(L/32))]++;
    }
  return { mean:+(s/n).toFixed(1), max:Math.round(mx), hist: hist.map(h=>+(100*h/n).toFixed(1)).join(' ') };
};
for (const [lbl, y0, y1] of [['sky',0.02,0.30],['mid',0.35,0.60],['fg',0.62,0.96]]) {
  const x = band(A,y0,y1), y = band(B,y0,y1);
  console.log(`${lbl.padEnd(4)} before mean ${String(x.mean).padStart(6)} max ${x.max}  |  after mean ${String(y.mean).padStart(6)} max ${y.max}`);
  console.log(`      hist before ${x.hist}`);
  console.log(`      hist after  ${y.hist}`);
}
