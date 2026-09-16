import fs from 'node:fs'; import { PNG } from 'pngjs';
const [src,out,x0,y0,w,h,scale]=process.argv.slice(2);
const p=PNG.sync.read(fs.readFileSync(src));
const S=Number(scale||1), W=Number(w), H=Number(h);
const o=new PNG({width:W*S,height:H*S});
for(let y=0;y<H*S;y++)for(let x=0;x<W*S;x++){
  const si=(((Number(y0)+(y/S|0))*p.width)+(Number(x0)+(x/S|0)))*4, di=(y*o.width+x)*4;
  o.data[di]=p.data[si];o.data[di+1]=p.data[si+1];o.data[di+2]=p.data[si+2];o.data[di+3]=255;}
fs.writeFileSync(out,PNG.sync.write(o));
console.log(out);
