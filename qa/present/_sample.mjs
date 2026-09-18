import fs from 'node:fs';
import { PNG } from 'pngjs';
const img = PNG.sync.read(fs.readFileSync(process.argv[2]));
const pts = process.argv.slice(3).map(s => s.split(',').map(Number));
for (const [x,y] of pts) {
  const i=(y*img.width+x)*4, r=img.data[i], g=img.data[i+1], b=img.data[i+2];
  console.log(`(${x},${y}) rgb ${r},${g},${b}  luma ${(0.2126*r+0.7152*g+0.0722*b).toFixed(1)}  sat ${Math.max(r,g,b)-Math.min(r,g,b)}`);
}
// Histogram of the lower half, to find where the big flat population sits.
const buck = new Array(16).fill(0); let n=0;
for (let y=Math.floor(img.height*0.55); y<img.height-60; y+=2)
  for (let x=4; x<img.width-4; x+=2) {
    const i=(y*img.width+x)*4;
    const L=0.2126*img.data[i]+0.7152*img.data[i+1]+0.0722*img.data[i+2];
    buck[Math.min(15,Math.floor(L/16))]++; n++;
  }
console.log('lower-half luma histogram, 16-wide buckets (%):');
console.log(buck.map((v,i)=>`${i*16}-${i*16+15}:${(100*v/n).toFixed(1)}`).join('  '));
