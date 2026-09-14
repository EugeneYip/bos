/**
 * Procedural, perfectly tileable wave maps.
 *
 * The detail normal map is a band-limited ocean spectrum rather than fbm: a
 * few dozen sinusoids on integer lattice frequencies with a Phillips-like
 * 1/k^p amplitude roll-off and a directional bias toward the wind axis. Summed
 * on the unit torus it tiles exactly, and because the derivative of a sine is
 * a cosine the normals are analytic — no Sobel, no staircase.
 *
 * Evaluated with a rotating-phasor recurrence (one complex multiply per texel
 * per wave) so a 256² map with 34 components costs a few milliseconds instead
 * of a hundred.
 */
import * as THREE from 'three';

interface Wave {
  m: number;
  n: number;
  amp: number;
  phase: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param res      texture resolution (power of two)
 * @param count    number of spectral components
 * @param kMin/kMax integer lattice frequency band
 * @param rolloff  amplitude ~ k^-rolloff
 * @param windBias 0 = isotropic, 1 = fully aligned with +u
 */
function spectrum(
  seed: number, count: number, kMin: number, kMax: number, rolloff: number, windBias: number,
): Wave[] {
  const rnd = mulberry(seed);
  const out: Wave[] = [];
  const seen = new Set<number>();
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    const k = kMin + rnd() * (kMax - kMin);
    const th = rnd() * Math.PI * 2;
    const m = Math.round(k * Math.cos(th));
    const n = Math.round(k * Math.sin(th));
    if (m === 0 && n === 0) continue;
    const key = (m + 512) * 1024 + (n + 512);
    if (seen.has(key)) continue;
    seen.add(key);
    const kk = Math.hypot(m, n);
    if (kk < kMin * 0.7 || kk > kMax * 1.3) continue;
    const dir = Math.abs(m) / kk;
    const bias = 1 - windBias + windBias * dir * dir;
    out.push({ m, n, amp: Math.pow(kk, -rolloff) * bias, phase: rnd() * Math.PI * 2 });
  }
  return out;
}

/** Accumulates a spectrum's height and analytic gradient over a res² torus. */
function evaluate(res: number, waves: Wave[]): { h: Float32Array; gx: Float32Array; gy: Float32Array } {
  const n2 = res * res;
  const h = new Float32Array(n2);
  const gx = new Float32Array(n2);
  const gy = new Float32Array(n2);
  const TAU = Math.PI * 2;

  for (const w of waves) {
    const au = (TAU * w.m) / res;
    const av = (TAU * w.n) / res;
    const cu = Math.cos(au), su = Math.sin(au);
    const cv = Math.cos(av), sv = Math.sin(av);
    let rr = Math.cos(w.phase), ri = Math.sin(w.phase);
    const kx = TAU * w.m * w.amp;
    const ky = TAU * w.n * w.amp;

    for (let v = 0; v < res; v++) {
      let pr = rr, pi = ri;
      const row = v * res;
      for (let u = 0; u < res; u++) {
        h[row + u] += w.amp * pi;
        gx[row + u] += kx * pr;
        gy[row + u] += ky * pr;
        const nr = pr * cu - pi * su;
        pi = pr * su + pi * cu;
        pr = nr;
      }
      const nr = rr * cv - ri * sv;
      ri = rr * sv + ri * cv;
      rr = nr;
      // Renormalise the row phasor to keep 256 chained multiplies exact.
      const inv = 1 / Math.hypot(rr, ri);
      rr *= inv; ri *= inv;
    }
  }
  return { h, gx, gy };
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length) || 1;
}

export interface WaterTextures {
  /** RGB tangent-space wave normal, A a decorrelated breakup mask. */
  waves: THREE.DataTexture;
  /** Four independent low-frequency noise channels for foam and sparkle. */
  noise: THREE.DataTexture;
  dispose(): void;
}

export function buildWaterTextures(anisotropy: number, res = 256): WaterTextures {
  // --- detail normal + breakup -------------------------------------------
  const base = spectrum(0x51ee7, 34, 2, 26, 1.55, 0.45);
  const { gx, gy } = evaluate(res, base);
  const fine = spectrum(0xb0a7, 22, 10, 52, 1.15, 0.2);
  const foam = evaluate(res, fine);

  const sx = 0.72 / rms(gx);
  const sy = 0.72 / rms(gy);
  const sf = 1 / (rms(foam.h) * 2.2);

  const n2 = res * res;
  const data = new Uint8Array(n2 * 4);
  for (let i = 0; i < n2; i++) {
    let nx = -gx[i] * sx;
    let ny = -gy[i] * sy;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    nx *= inv; ny *= inv;
    const nz = inv;
    data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    const f = foam.h[i] * sf + 0.5;
    data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, f)) * 255);
  }

  const waves = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  waves.wrapS = waves.wrapT = THREE.RepeatWrapping;
  waves.magFilter = THREE.LinearFilter;
  waves.minFilter = THREE.LinearMipmapLinearFilter;
  waves.generateMipmaps = true;
  waves.anisotropy = anisotropy;
  waves.colorSpace = THREE.NoColorSpace;
  waves.needsUpdate = true;

  // --- four-channel scalar noise -----------------------------------------
  const nres = 128;
  const nn = nres * nres;
  const ndata = new Uint8Array(nn * 4);
  const seeds = [0x1234, 0x9a7f, 0x2be5, 0x7711];
  for (let c = 0; c < 4; c++) {
    const s = spectrum(seeds[c], 18, 1 + c * 2, 10 + c * 8, 1.0, 0);
    const e = evaluate(nres, s);
    const k = 1 / (rms(e.h) * 2.4);
    for (let i = 0; i < nn; i++) {
      ndata[i * 4 + c] = Math.round(Math.max(0, Math.min(1, e.h[i] * k + 0.5)) * 255);
    }
  }
  const noise = new THREE.DataTexture(ndata, nres, nres, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.anisotropy = Math.min(4, anisotropy);
  noise.colorSpace = THREE.NoColorSpace;
  noise.needsUpdate = true;

  return {
    waves,
    noise,
    dispose(): void { waves.dispose(); noise.dispose(); },
  };
}
