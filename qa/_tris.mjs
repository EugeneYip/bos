/**
 * What is actually being submitted, counted rather than timed.
 *
 * Frame timings on this machine are worthless when anything else is using the
 * GPU. Geometry counts are not: they come straight off the scene graph. For a
 * viewpoint this reports every group of meshes over a threshold, its triangle
 * count, how many draw calls it costs, and -- separately -- whether the
 * renderer's own counters are still moving 60 frames after the camera stopped,
 * which is the difference between "expensive" and "never finishes streaming".
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const VIEWS = (process.argv[2] || 'high-street').split(',');
const TIER = process.argv[3] || 'high';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const byId = new Map(Object.values(vp).map((v) => [v.id, v]));
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,8000));

for (const id of VIEWS) {
  const v = byId.get(id);
  if (!v) { console.log(`?? ${id}`); continue; }
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,9000));
  await pg.evaluate(()=>window.__debug.settle(90));

  // Are the counters still moving with the camera parked?
  const churn = await pg.evaluate(async () => {
    const r = window.__boston.ctx.renderer.info.render;
    const out = [];
    for (let i = 0; i < 24; i++) {
      out.push([r.calls, r.triangles]);
      await new Promise((res) => requestAnimationFrame(res));
    }
    const c = out.map((o) => o[0]), t = out.map((o) => o[1]);
    return { cMin: Math.min(...c), cMax: Math.max(...c), tMin: Math.min(...t), tMax: Math.max(...t) };
  });

  const rep = await pg.evaluate(() => {
    const { scene, camera } = window.__boston.ctx;
    camera.updateMatrixWorld(true);
    // Gribb-Hartmann planes, in plain arithmetic: the page does not export
    // three, and importing a second copy of it here would be a different
    // camera than the one that drew the frame.
    const mul = (a, b) => { const o = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = v; } return o; };
    const m = mul(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements);
    const pl = (i, j, sg) => { const p = [sg * m[i] + m[j], sg * m[4 + i] + m[4 + j],
      sg * m[8 + i] + m[8 + j], sg * m[12 + i] + m[12 + j]];
      const L = Math.hypot(p[0], p[1], p[2]); return p.map((x) => x / L); };
    const planes = [pl(0, 3, 1), pl(0, 3, -1), pl(1, 3, 1), pl(1, 3, -1), pl(2, 3, 1), pl(2, 3, -1)];
    const sphereInView = (cx, cy, cz, r) =>
      planes.every((p) => p[0] * cx + p[1] * cy + p[2] * cz + p[3] >= -r);
    const groups = new Map();
    let total = 0, calls = 0;
    scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      const g = o.geometry; if (!g) return;
      const idx = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
      const per = o.isPoints || o.isLine ? idx : idx / 3;
      const n = o.isInstancedMesh ? o.count : 1;
      let inView = true;
      if (o.isInstancedMesh) inView = true;           // per-instance culling is the module's job
      else {
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = g.boundingSphere; if (!bs) return;
        const e = o.matrixWorld.elements;
        const cx = e[0] * bs.center.x + e[4] * bs.center.y + e[8] * bs.center.z + e[12];
        const cy = e[1] * bs.center.x + e[5] * bs.center.y + e[9] * bs.center.z + e[13];
        const cz = e[2] * bs.center.x + e[6] * bs.center.y + e[10] * bs.center.z + e[14];
        const sc = Math.sqrt(Math.max(e[0] ** 2 + e[1] ** 2 + e[2] ** 2,
          e[4] ** 2 + e[5] ** 2 + e[6] ** 2, e[8] ** 2 + e[9] ** 2 + e[10] ** 2));
        inView = sphereInView(cx, cy, cz, bs.radius * sc);
      }
      if (!inView) return;
      const tris = per * n;
      total += tris; calls += 1;
      // Group by the first two colon-separated segments of the name, else by
      // the nearest named ancestor, so a module's share is one line.
      let key = o.name || '';
      if (!key) { for (let p = o.parent; p; p = p.parent) if (p.name) { key = p.name + ' (child)'; break; } }
      key = key.split(':').slice(0, 2).join(':') || '(unnamed)';
      const e = groups.get(key) || { tris: 0, calls: 0, inst: 0 };
      e.tris += tris; e.calls += 1; e.inst += n; groups.set(key, e);
    });
    return { total, calls, groups: [...groups].sort((a, b) => b[1].calls - a[1].calls).slice(0, 26) };
  });

  console.log(`\n== ${id} (${TIER})  frustum-visible ${(rep.total/1e6).toFixed(2)}M tris in ${rep.calls} draws`);
  console.log(`   counters over 24 parked frames: calls ${churn.cMin}..${churn.cMax}  tris ${(churn.tMin/1e6).toFixed(2)}..${(churn.tMax/1e6).toFixed(2)}M`);
  for (const [k, e] of rep.groups) {
    if (e.calls < 4) continue;
    console.log(`   draws ${String(e.calls).padStart(4)}  ${k.padEnd(26)} ${(e.tris/1e6).toFixed(3)}M tris  instances ${e.inst}`);
  }
}
await b.close(); srv.kill();
