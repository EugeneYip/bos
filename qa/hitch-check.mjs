#!/usr/bin/env node
/**
 * Measures the streaming hitches you feel while moving, which no still
 * screenshot and no average can show you.
 *
 *   QA_OUTDIR=dist-qa node qa/hitch-check.mjs
 *
 * Flies a kilometre along Commonwealth Avenue and reports the *worst* single
 * frame each streaming system spent, not the mean. That distinction is the
 * whole point: these systems only do work when the camera moves, so an
 * exponential average of them reads about zero from a parked camera — which is
 * why a fifth of a second of frozen picture every 28 metres went unnoticed
 * while `fps` looked fine.
 *
 * It was reported as "the whole scene keeps blinking during ultra resolution".
 * It had nothing to do with ultra, or with resolution: on a still camera the
 * frame-to-frame brightness swing is under 0.15% at every tier. Baselines when
 * this was written, after the fixes:
 *
 *     veg.worstRebuildMs    17  (was 203)
 *     veg.worstGroundMs     36  (was 229)
 *     roadWorstTileMs      102  (unfixed; the queue checks its budget *before*
 *                                a build, so one tile overshoots freely)
 *
 * Read these as order-of-magnitude. Run it with other browsers idle: four
 * concurrent puppeteer sessions inflated the road figure to 1,399 ms and had me
 * believing in a regression that was contention.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT=Number(process.env.QA_PORT||4499);
const OUTDIR=process.env.QA_OUTDIR||'dist-qa';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUTDIR],{cwd:'/Volumes/Projects/bos',stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
// Fly the camera along Commonwealth Avenue so the streaming systems have to work.
await pg.evaluate(()=>{window.__debug.setTime(13.2);window.__debug.setView([-1400,40,700],[-600,30,300]);});
await pg.evaluate(()=>window.__debug.settle(90));
for (let i=0;i<26;i++){
  const t=i/25;
  await pg.evaluate((t)=>{
    const x=-1400+t*900, z=700-t*430;
    window.__debug.setView([x,40,z],[x+260,30,z-140]);
  }, t);
  await pg.evaluate(()=>window.__debug.settle(5));
}
const s=await pg.evaluate(()=>window.__debug.stats());
console.log('after a 1 km fly-through:');
console.log('  fps', s.fps, ' fps.low', s['fps.low']);
console.log('  veg.worstRebuildMs ', s['veg.worstRebuildMs']);
console.log('  veg.worstGroundMs  ', s['veg.worstGroundMs']);
console.log('  roadWorstTileMs    ', s['roadWorstTileMs']);
await b.close(); srv.kill();
