import fs from 'node:fs';
import { PNG } from 'pngjs';
const img = PNG.sync.read(fs.readFileSync(process.argv[2]));
const MIN = Number(process.argv[3] || 140);
const hits = [];
for (let y=Math.floor(img.height*0.50); y<img.height-80; y+=7)
  for (let x=10; x<img.width-10; x+=7) {
    const i=(y*img.width+x)*4, r=img.data[i], g=img.data[i+1], b=img.data[i+2];
    const L=0.2126*r+0.7152*g+0.0722*b, sat=Math.max(r,g,b)-Math.min(r,g,b);
    if (L>MIN && sat<26) hits.push({x,y,r,g,b,L:+L.toFixed(1),sat});
  }
console.log(`bright flat samples: ${hits.length}`);
// spread them out so they are not all one patch
const picked=[];
for (const h of hits) if (picked.every(p=>Math.hypot(p.x-h.x,p.y-h.y)>180)) picked.push(h);
for (const p of picked.slice(0,10)) console.log(`(${p.x},${p.y}) rgb ${p.r},${p.g},${p.b} luma ${p.L} sat ${p.sat}`);
