import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, a, b] = process.argv;
const A = PNG.sync.read(fs.readFileSync(a)), B = PNG.sync.read(fs.readFileSync(b));
let n=0, ch=0, whiteN=0, whiteCh=0;
for (let y=0; y<A.height; y+=2) for (let x=0; x<A.width; x+=2) {
  const i=(y*A.width+x)*4;
  const d = Math.abs(A.data[i]-B.data[i]) + Math.abs(A.data[i+1]-B.data[i+1]) + Math.abs(A.data[i+2]-B.data[i+2]);
  n++; if (d > 12) ch++;
  // "the white ground": bright and desaturated in the BEFORE frame
  const r=A.data[i], g=A.data[i+1], bl=A.data[i+2];
  const L = 0.2126*r+0.7152*g+0.0722*bl;
  if (L > 170 && Math.max(r,g,bl)-Math.min(r,g,bl) < 22) { whiteN++; if (d > 12) whiteCh++; }
}
console.log(`changed overall: ${(100*ch/n).toFixed(2)}%  (${ch}/${n})`);
console.log(`pale-flat pixels: ${(100*whiteN/n).toFixed(2)}% of frame; of those, changed: ${whiteN? (100*whiteCh/whiteN).toFixed(2):0}%`);
