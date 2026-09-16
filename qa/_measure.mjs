import fs from 'node:fs'; import { PNG } from 'pngjs';
for (const f of process.argv.slice(2)) {
  const p = PNG.sync.read(fs.readFileSync(f));
  const L=(i)=>0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];
  const band=(y0,y1,x0,x1)=>{let s=0,m=0,n=0;for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const i=(y*p.width+x)*4;
    s+=Math.abs(L(i)-L(i+4))+Math.abs(L(i)-L(i+p.width*4));m+=L(i);n++;}return{c:s/n,l:m/n};};
  const far=band(240,330,100,1180), sun=band(240,460,40,420), near=band(480,660,200,1080);
  const sky=band(180,205,100,1180), grd=band(232,258,100,1180);
  console.log(f.split('/').pop().padEnd(20)
    +` far ${far.c.toFixed(2)}/${far.l.toFixed(1)}  sun ${sun.c.toFixed(2)}/${sun.l.toFixed(1)}`
    +`  near ${near.c.toFixed(2)}/${near.l.toFixed(1)}  horizonStep ${(grd.l-sky.l).toFixed(1)}`);
}
