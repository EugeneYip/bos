/**
 * Procedural, perfectly tileable wave maps.
 *
 * These are synthesised in the *frequency* domain and brought into the spatial
 * domain with an inverse FFT, which is how ocean surfaces are actually
 * generated (Tessendorf). The predecessor summed 34 explicit sinusoids: cheap,
 * exactly tileable and analytically differentiable, but 34 components over a
 * 256² tile is a very sparse spectrum, and the result read as a regular carpet
 * of identical dashes — the same few crest shapes repeating everywhere the map
 * was laid down. A 512² inverse FFT fills *every* one of the 262144 modes with
 * an independent complex Gaussian for roughly a third of the arithmetic, so no
 * two crests in the tile are the same shape.
 *
 * Three fields come out of one spectrum, so they stay mutually consistent:
 *
 *   h        surface height, used to chop-warp the octave below it
 *   dh/dx    \  slope, stored directly rather than as a unit normal: the
 *   dh/dz    /  shader needs slope, and re-deriving it from a packed normal
 *               cost a divide and threw away range near the crests.
 *
 * A fourth, independent field with a much flatter spectrum becomes the
 * breakup/bubble mask. Foam needs structure across three decades of scale —
 * lacy filaments at a metre, clusters at ten centimetres — and a broadband
 * field thresholded against the foam coverage gives exactly that.
 */
import * as THREE from 'three';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the spectrum gets a proper complex Gaussian per mode. */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-7);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/* ------------------------------------------------------------------ FFT ---- */

/** Bit-reversal permutation table for length n (power of two). */
function revTable(n: number): Uint32Array {
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  return rev;
}

/** Twiddle factors for every stage, laid out contiguously. */
function twiddles(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n / 2; i++) {
    const a = (2 * Math.PI * i) / n;
    w[i * 2] = Math.cos(a);
    w[i * 2 + 1] = Math.sin(a);
  }
  return w;
}

/**
 * In-place iterative radix-2 FFT of one strided complex line.
 *
 * Signs are the *inverse* transform (e^{+i...}); no 1/n normalisation, since
 * every field is rescaled to a target rms afterwards anyway.
 */
function fftLine(
  re: Float64Array, im: Float64Array, off: number, stride: number,
  n: number, rev: Uint32Array, w: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wi = k * step;
        const wr = w[wi * 2], wq = w[wi * 2 + 1];
        const a = off + (i + k) * stride;
        const b = off + (i + k + half) * stride;
        const xr = re[b] * wr - im[b] * wq;
        const xi = re[b] * wq + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** 2D inverse FFT over an n×n grid; returns the real part in `re`. */
function ifft2(re: Float64Array, im: Float64Array, n: number): void {
  const rev = revTable(n);
  const w = twiddles(n);
  for (let r = 0; r < n; r++) fftLine(re, im, r * n, 1, n, rev, w);
  for (let c = 0; c < n; c++) fftLine(re, im, c, n, n, rev, w);
}

/* -------------------------------------------------------------- spectra ---- */

interface SpectrumOpts {
  /** Amplitude ~ k^-slope. Slope of the *gradient* spectrum is 1 - this. */
  slope: number;
  /** Modes below this wavenumber (cycles per tile) are suppressed. */
  kLo: number;
  /** Gaussian rolloff above this, well short of Nyquist so nothing aliases. */
  kHi: number;
  /** 0 isotropic, 1 fully aligned with +u. */
  windBias: number;
}

interface Field {
  h: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

/**
 * Builds one Gaussian random field and its two exact partial derivatives.
 *
 * The derivatives are taken in the frequency domain — multiply mode (m,n) by
 * i·2π·m/N — so they are the analytic gradient of the height that comes out
 * of the same spectrum, not a finite difference of it. No Sobel, no staircase,
 * and the normal agrees with the height the chop warp uses.
 */
function buildField(n: number, seed: number, o: SpectrumOpts, wantGrad: boolean): Field {
  const rnd = mulberry(seed);
  const n2 = n * n;
  const half = n >> 1;

  const sr = new Float64Array(n2);
  const si = new Float64Array(n2);

  for (let j = 0; j < n; j++) {
    const ny = j < half ? j : j - n;
    for (let i = 0; i < n; i++) {
      const nx = i < half ? i : i - n;
      const idx = j * n + i;
      const k = Math.hypot(nx, ny);
      if (k < 0.5) continue;
      let amp = Math.pow(k, -o.slope);
      // Low-k shoulder: without it a k^-1.3 spectrum is all swell and the
      // tile reads as three big blobs.
      amp *= Math.exp(-((o.kLo / k) ** 2));
      // High-k shoulder, ~1.5 texels per cycle at kHi = n/3.
      amp *= Math.exp(-((k / o.kHi) ** 2));
      if (o.windBias > 0) {
        const d = nx / k;
        amp *= 1 - o.windBias + o.windBias * d * d;
      }
      if (amp < 1e-9) continue;
      sr[idx] = amp * gauss(rnd) * 0.7071;
      si[idx] = amp * gauss(rnd) * 0.7071;
    }
  }

  const out: Field = {
    h: new Float32Array(n2),
    gx: new Float32Array(wantGrad ? n2 : 0),
    gy: new Float32Array(wantGrad ? n2 : 0),
  };

  if (wantGrad) {
    // d/du and d/dv share the spectrum, so copy before each transform.
    const tr = new Float64Array(n2);
    const ti = new Float64Array(n2);
    const TAU = Math.PI * 2;
    for (let axis = 0; axis < 2; axis++) {
      for (let j = 0; j < n; j++) {
        const ny = j < half ? j : j - n;
        for (let i = 0; i < n; i++) {
          const nx = i < half ? i : i - n;
          const idx = j * n + i;
          const c = (TAU * (axis === 0 ? nx : ny)) / n;
          // multiply by i*c
          tr[idx] = -si[idx] * c;
          ti[idx] = sr[idx] * c;
        }
      }
      ifft2(tr, ti, n);
      const dst = axis === 0 ? out.gx : out.gy;
      for (let p = 0; p < n2; p++) dst[p] = tr[p];
    }
  }

  ifft2(sr, si, n);
  for (let p = 0; p < n2; p++) out.h[p] = sr[p];
  return out;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length) || 1;
}

const enc = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);

export interface WaterTextures {
  /**
   * RG surface slope (±3, zero at 0.5), B height (±3σ), A a broadband
   * breakup/bubble mask. One tile is whatever metre size the shader divides by.
   */
  waves: THREE.DataTexture;
  /** Four independent low-frequency noise channels for gusts, silt and foam. */
  noise: THREE.DataTexture;
  dispose(): void;
}

/**
 * Slope and height are stored ±SLOPE_RANGE about 0.5.
 *
 * Measured against the field this actually generates: per-axis slope rms 0.52
 * along the wind and 0.36 across it, |slope| at the 99.99th percentile 1.97,
 * absolute maximum 2.18. A range of 3 clipped nothing but spent two thirds of
 * the code space on values that never occur, leaving 22 quantisation levels
 * per sigma; four octaves then stack four staircases. 2.25 still clips nothing
 * and buys a third more precision for free.
 */
export const WAVE_SLOPE_RANGE = 2.25;

export function buildWaterTextures(anisotropy: number, res = 512): WaterTextures {
  const t0 = performance.now();

  // Short wind chop: the gradient spectrum wants to be nearly flat, or the
  // tile is dominated by its longest mode and every lay-down of the map reads
  // as the same three blobs. slope 1.22 -> gradient ~ k^-0.22.
  // The gradient spectrum this implies is k^(1-slope) = k^-0.52, i.e. falling.
  // A flat gradient spectrum is tempting — every scale contributes equally —
  // but it renders as dark sandpaper: the eye locks onto the finest resolvable
  // scale and there is nothing larger for it to be riding on. Real short-wave
  // slope spectra fall, and the fall is what makes crests read as crests.
  //
  // kLo of three: the map is minified over most of any frame, and everything
  // above a sixth of the tile is filtered away there, so the largest few modes
  // are what survive to give the mid-field its texture.
  const base = buildField(res, 0x51ee7, {
    slope: 1.52, kLo: 3.0, kHi: res / 3.4, windBias: 0.55,
  }, true);

  // Foam/breakup: flatter still and pushed an octave higher, so thresholding
  // it produces lace at a metre and bubbles at a few centimetres.
  const brk = buildField(res, 0xb0a7f, {
    slope: 0.92, kLo: 7.0, kHi: res / 2.8, windBias: 0.0,
  }, false);

  const n2 = res * res;
  // Normalise the two slope axes together: scaling them independently rotates
  // the normal of every anisotropic crest toward 45 degrees.
  const sg = 0.52 / Math.max(rms(base.gx), rms(base.gy));
  const sh = 1 / (rms(base.h) * 3.2);
  const sb = 1 / (rms(brk.h) * 2.6);

  const data = new Uint8Array(n2 * 4);
  const inv = 1 / WAVE_SLOPE_RANGE;
  for (let i = 0; i < n2; i++) {
    data[i * 4] = enc(-base.gx[i] * sg * inv * 0.5 + 0.5);
    data[i * 4 + 1] = enc(-base.gy[i] * sg * inv * 0.5 + 0.5);
    data[i * 4 + 2] = enc(base.h[i] * sh * 0.5 + 0.5);
    data[i * 4 + 3] = enc(brk.h[i] * sb + 0.5);
  }

  const waves = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  waves.wrapS = waves.wrapT = THREE.RepeatWrapping;
  waves.magFilter = THREE.LinearFilter;
  waves.minFilter = THREE.LinearMipmapLinearFilter;
  waves.generateMipmaps = true;
  waves.anisotropy = anisotropy;
  waves.colorSpace = THREE.NoColorSpace;
  waves.needsUpdate = true;

  // --- four independent low-frequency scalar channels ---------------------
  // Gust cells, Langmuir streaks, silt plumes and the swash phase along the
  // bank. All four want to be smooth at their own scale, so this map stays
  // narrow-band and low resolution.
  const nres = 128;
  const nn = nres * nres;
  const ndata = new Uint8Array(nn * 4);
  const seeds = [0x1234, 0x9a7f, 0x2be5, 0x7711];
  const kk = [2.0, 3.5, 5.5, 8.0];
  for (let c = 0; c < 4; c++) {
    const f = buildField(nres, seeds[c], {
      slope: 1.6, kLo: kk[c], kHi: kk[c] * 3.2, windBias: 0,
    }, false);
    const k = 1 / (rms(f.h) * 2.5);
    for (let i = 0; i < nn; i++) ndata[i * 4 + c] = enc(f.h[i] * k + 0.5);
  }
  const noise = new THREE.DataTexture(ndata, nres, nres, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.anisotropy = Math.min(4, anisotropy);
  noise.colorSpace = THREE.NoColorSpace;
  noise.needsUpdate = true;

  console.info(`[Water] wave atlas ${res}² in ${(performance.now() - t0).toFixed(0)} ms`);

  return {
    waves,
    noise,
    dispose(): void { waves.dispose(); noise.dispose(); },
  };
}
