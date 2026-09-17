/** High-frequency energy: mean |laplacian| over the frame. */
import fs from 'node:fs';
import { PNG } from 'pngjs';
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(f, 'missing'); continue; }
  const a = PNG.sync.read(fs.readFileSync(f));
  const W=a.width,H=a.height; const L=(x,y)=>{const i=(y*W+x)*4;return 0.2126*a.data[i]+0.7152*a.data[i+1]+0.0722*a.data[i+2];};
  let s=0,n=0;
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){
    s+=Math.abs(4*L(x,y)-L(x-1,y)-L(x+1,y)-L(x,y-1)-L(x,y+1)); n++; }
  console.log(`${f.split('/').pop().padEnd(34)} hf ${(s/n).toFixed(2)}`);
}
