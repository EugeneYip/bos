/**
 * The water field: two lookup textures, addressed in world XZ, that carry
 * everything the shader needs to know about *where* it is.
 *
 *   distTex (R16F, ~6 m/texel)  signed distance to the shoreline, metres,
 *                               positive inside the water.
 *   auxTex  (RGBA8, 1/4 res)    R bed height, G fetch, B murk, A body mask.
 *
 * Why a baked field rather than the scene depth buffer: the depth buffer only
 * exists if someone hands us one, the terrain that will carve the harbour
 * floor is being written in another lane right now, and a world-space field
 * gives a view-independent shoreline that cannot swim or alias when the camera
 * moves. The bed-height channel is re-baked whenever `ctx.sampleHeight` is
 * replaced, so the moment real bathymetry lands the water gets deeper for
 * free; until then the distance channel alone drives a plausible depth ramp.
 *
 * The signed distance is an exact Euclidean transform (Felzenszwalb &
 * Huttenlocher, two separable O(n) passes per sign), which costs ~110 ms per
 * pass at 1900x1620 and is split across animation frames so the loading bar
 * keeps moving.
 */
import * as THREE from 'three';
import type { HeightSampler } from '../../core/Context';
import type { AreaRecord } from '../../core/types';
import { cleanRing, scanFill } from './poly';
import type { WaterBody } from './bodies';

export interface FieldBounds {
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export class WaterField {
  /** World coordinate of the grid's minimum corner (texel 0 spans x0..x0+ts). */
  readonly x0: number;
  readonly z0: number;
  readonly ts: number;
  readonly w: number;
  readonly h: number;

  /**
   * Signed shore distance in metres, positive inside water.
   *
   * Live only until {@link compact}; after that {@link sampleDist} reads the
   * half-float texture staging buffer instead, which is the same field at
   * half the bytes and is exactly what the shader samples.
   */
  private dist: Float32Array;

  // Quarter-resolution channels.
  readonly sw: number;
  readonly sh: number;
  readonly sts: number;
  private bed: Float32Array;
  private fetch: Float32Array;
  private murk: Float32Array;
  /**
   * How much surf this stretch of shore is allowed, 0..1. See
   * {@link paintSurf}. This slot used to hold a body mask that no consumer
   * ever read -- the shader samples aux .r, .g and .b and has never looked
   * at .a.
   */
  private surf: Float32Array;
  /** Half-float copy of {@link dist}; the distance texture's own storage. */
  private half: Uint16Array = new Uint16Array(0);

  distTex!: THREE.DataTexture;
  auxTex!: THREE.DataTexture;

  /** uv = (world.xz - origin) * invSize */
  readonly origin = new THREE.Vector2();
  readonly invSize = new THREE.Vector2();

  private bodyAt: Int32Array;
  private padTexels: number;

  constructor(rect: FieldBounds, pad: number, texel: number) {
    const wSpan = rect.maxX - rect.minX + pad * 2;
    const hSpan = rect.maxZ - rect.minZ + pad * 2;
    this.ts = texel;
    this.w = Math.ceil(wSpan / texel);
    this.h = Math.ceil(hSpan / texel);
    this.x0 = rect.minX - pad;
    this.z0 = rect.minZ - pad;
    this.padTexels = Math.max(0, Math.floor(pad / texel));

    this.dist = new Float32Array(this.w * this.h);
    this.bodyAt = new Int32Array(this.w * this.h).fill(-1);

    this.sw = Math.ceil(this.w / 4);
    this.sh = Math.ceil(this.h / 4);
    this.sts = texel * 4;
    const sn = this.sw * this.sh;
    this.bed = new Float32Array(sn).fill(60);
    this.fetch = new Float32Array(sn);
    this.murk = new Float32Array(sn);
    this.surf = new Float32Array(sn);

    this.origin.set(this.x0, this.z0);
    this.invSize.set(1 / (this.w * texel), 1 / (this.h * texel));
  }

  /** Rasterise the bodies into the water mask and the per-body aux channels. */
  rasterise(bodies: WaterBody[]): void {
    const { w, h, ts, x0, z0 } = this;
    const inside = new Uint8Array(w * h);
    const bodyAt = this.bodyAt;

    // Largest first, so a marina cut into the harbour wins the aux channels
    // underneath it while the overlap count marks it as geometry-redundant.
    for (let bi = 0; bi < bodies.length; bi++) {
      const b = bodies[bi];
      let total = 0, dup = 0;
      scanFill(b.rings, x0, z0, ts, ts, w, h, (idx) => {
        total++;
        if (inside[idx]) dup++;
        inside[idx] = 1;
        bodyAt[idx] = bi;
      });
      b.skipGeometry = total > 3 && dup / total > 0.8;
    }

    // Continue the mask outwards past the modelled rectangle by clamping, so
    // the open-ocean skirt inherits a coastline that runs to the horizon
    // instead of stopping at a hard data boundary. East of Boston that is the
    // outer harbour, west of it Brighton keeps being dry land — which is
    // exactly what a clamped coastline gives you.
    const p = this.padTexels;
    if (p > 0) {
      const iLo = p, iHi = w - 1 - p, jLo = p, jHi = h - 1 - p;
      for (let j = 0; j < h; j++) {
        const cj = Math.min(jHi, Math.max(jLo, j));
        const row = j * w, crow = cj * w;
        for (let i = 0; i < w; i++) {
          if (i >= iLo && i <= iHi && j >= jLo && j <= jHi) continue;
          const ci = Math.min(iHi, Math.max(iLo, i));
          if (inside[crow + ci]) {
            inside[row + i] = 1;
            if (bodyAt[row + i] < 0) bodyAt[row + i] = bodyAt[crow + ci];
          }
        }
      }
    }

    this.insideToSigned(inside);

    // Aux channels at quarter resolution. Vote across the whole 4x4 block
    // rather than trusting a single representative texel: a pier, a line of
    // piles or the edge of a hole can sit exactly on that one sample and hand
    // the block to whatever the neighbour-search finds next — which is how
    // one dock could paint a harbour-sized fetch value across a reach of the
    // Charles that is visibly, entirely river. The other fifteen texels are
    // nearly always still inside the real body.
    const { sw, sh } = this;
    const voteCount = new Int32Array(bodies.length);
    const touched: number[] = [];
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const si = j * sw + i;
        for (let t = 0; t < touched.length; t++) voteCount[touched[t]] = 0;
        touched.length = 0;
        let bi = -1, bestVotes = 0;
        const j0 = j * 4, i0 = i * 4;
        for (let sdj = 0; sdj < 4; sdj++) {
          const jj = Math.min(h - 1, j0 + sdj);
          const row = jj * w;
          for (let sdi = 0; sdi < 4; sdi++) {
            const ii = Math.min(w - 1, i0 + sdi);
            const k = bodyAt[row + ii];
            if (k < 0) continue;
            if (voteCount[k] === 0) touched.push(k);
            const c = ++voteCount[k];
            if (c > bestVotes) { bestVotes = c; bi = k; }
          }
        }
        if (bi >= 0) {
          const b = bodies[bi];
          this.fetch[si] = b.fetch;
          this.murk[si] = b.murk;
        } else {
          // Nearest-body lookup in a small neighbourhood keeps the aux map from
          // snapping to zero one texel outside the shoreline (it is filtered).
          let best = -1;
          outer:
          for (let r = 1; r <= 2 && best < 0; r++) {
            for (let dj = -r; dj <= r; dj++) {
              for (let di = -r; di <= r; di++) {
                const jj = Math.min(h - 1, Math.max(0, j * 4 + 1 + dj * 4));
                const ii = Math.min(w - 1, Math.max(0, i * 4 + 1 + di * 4));
                const k = bodyAt[jj * w + ii];
                if (k >= 0) { best = k; break outer; }
              }
            }
          }
          if (best >= 0) {
            const b = bodies[best];
            this.fetch[si] = b.fetch;
            this.murk[si] = b.murk;
          } else {
            this.fetch[si] = 0.85;
            this.murk[si] = 0.12;
          }
        }
      }
    }
  }

  /** Re-read the per-body fetch after it has been refined against the SDF. */
  refreshFetch(bodies: WaterBody[]): void {
    const { w, sw, sh } = this;
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const fi = Math.min(this.h - 1, j * 4 + 1) * w + Math.min(w - 1, i * 4 + 1);
        const bi = this.bodyAt[fi];
        if (bi >= 0) this.fetch[j * sw + i] = bodies[bi].fetch;
      }
    }
  }

  /** Largest inscribed radius of each body, straight off the finished SDF. */
  measureInradii(bodies: WaterBody[]): void {
    const best = new Float32Array(bodies.length);
    const { w, h } = this;
    for (let k = 0; k < w * h; k++) {
      const bi = this.bodyAt[k];
      if (bi < 0) continue;
      const d = this.dist[k];
      if (d > best[bi]) best[bi] = d;
    }
    for (let i = 0; i < bodies.length; i++) bodies[i].inradius = best[i];
  }

  /**
   * Where the shoreline is soft enough to break surf on.
   *
   * Boston's waterline is overwhelmingly hard: granite seawall, steel sheet
   * pile, riprap, wharf. Surf is a *beach* phenomenon -- it needs a shoaling
   * bottom to trip a wave over -- and against a vertical bulkhead the water
   * goes dark right up to the wall with, at most, a thin line of scum. The
   * foam block in the shader had no way to know the difference and laid a
   * nine-metre wash band along every metre of coast in the city, which at
   * `dusk-harbour` reads as snow piled up against the Seaport quays.
   *
   * The terrain cannot answer this either: `carveShoreline` gives every body
   * of water the same 1:12 approach slope, so the bed is exactly as shallow
   * off a bulkhead as off a beach, and any test on depth would pass
   * everywhere.
   *
   * So it comes from the data. OSM's `beach` and `sand` areas are painted
   * into the aux map's fourth channel and spread a few texels seaward -- the
   * polygons sit on the dry sand, and the fragments that need to know are the
   * ones just offshore. 216,000 m2 of beach and 78,000 of sand, against
   * roughly forty kilometres of hard edge.
   */
  paintSurf(records: readonly AreaRecord[]): void {
    const { sw, sh, sts, x0, z0, surf } = this;
    let painted = 0;
    for (const rec of records) {
      if (rec.kind !== 'beach' && rec.kind !== 'sand') continue;
      if (!rec.outline || rec.outline.length < 6) continue;
      const ring = cleanRing(rec.outline);
      if (ring.length < 6) continue;
      scanFill([ring], x0, z0, sts, sts, sw, sh, (idx) => { surf[idx] = 1; painted++; });
    }
    if (!painted) return;

    // Separable max-with-decay, three passes at 24 m per texel: the flag
    // reaches ~70 m out, at a fifth strength, which is about as far as a
    // wash band ever gets. A blur would be wrong -- this wants to *grow*
    // from the sand, not average with the water beside it.
    const tmp = new Float32Array(surf.length);
    const DECAY = 0.62;
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < sh; j++) {
        const row = j * sw;
        for (let i = 0; i < sw; i++) {
          const c = surf[row + i];
          const l = i > 0 ? surf[row + i - 1] : 0;
          const r = i + 1 < sw ? surf[row + i + 1] : 0;
          tmp[row + i] = Math.max(c, DECAY * Math.max(l, r));
        }
      }
      for (let j = 0; j < sh; j++) {
        const row = j * sw;
        const up = j > 0 ? row - sw : row;
        const dn = j + 1 < sh ? row + sw : row;
        for (let i = 0; i < sw; i++) {
          surf[row + i] = Math.max(tmp[row + i], DECAY * Math.max(tmp[up + i], tmp[dn + i]));
        }
      }
    }
  }

  /** Sample the bed height from the terrain wherever there is water nearby. */
  bakeBed(sampleHeight: HeightSampler): void {
    const { sw, sh, sts, x0, z0 } = this;
    for (let j = 0; j < sh; j++) {
      const z = z0 + (j + 0.5) * sts;
      for (let i = 0; i < sw; i++) {
        const si = j * sw + i;
        const x = x0 + (i + 0.5) * sts;
        // Only where it matters: inside the water or within ~40 m of it.
        if (this.sampleDist(x, z) < -40) { this.bed[si] = 60; continue; }
        let hgt = sampleHeight(x, z);
        if (!isFinite(hgt)) hgt = 0;
        this.bed[si] = Math.min(100, Math.max(-60, hgt));
      }
    }
  }

  // ---------------------------------------------------------- sampling ----

  /**
   * Bilinear signed distance in metres, clamped at the field edge.
   *
   * Reads the float field while it exists and the half-float one after
   * {@link compact} has dropped it. That is not a degradation: the half
   * field *is* what the shader samples, so after compaction the CPU and the
   * GPU answer the same question the same way. Half precision is 0.015 m at
   * 60 m from a bank and 0.25 m at the 400 m clamp, and every consumer --
   * bridge decks, park placement, the boat no-drive mask -- cares only about
   * the first few tens of metres.
   */
  sampleDist(x: number, z: number): number {
    const { w, h, ts } = this;
    let u = (x - this.x0) / ts - 0.5;
    let v = (z - this.z0) / ts - 0.5;
    u = Math.min(w - 1.001, Math.max(0, u));
    v = Math.min(h - 1.001, Math.max(0, v));
    const i = u | 0, j = v | 0;
    const fx = u - i, fz = v - j;
    const d = this.dist;
    if (d.length !== 0) {
      const a = d[j * w + i], b = d[j * w + i + 1];
      const c = d[(j + 1) * w + i], e = d[(j + 1) * w + i + 1];
      return (a + (b - a) * fx) * (1 - fz) + (c + (e - c) * fx) * fz;
    }
    const q = this.half;
    const f = THREE.DataUtils.fromHalfFloat;
    const a = f(q[j * w + i]), b = f(q[j * w + i + 1]);
    const c = f(q[(j + 1) * w + i]), e = f(q[(j + 1) * w + i + 1]);
    return (a + (b - a) * fx) * (1 - fz) + (c + (e - c) * fx) * fz;
  }

  sampleFetch(x: number, z: number): number {
    const { sw, sh, sts } = this;
    let u = (x - this.x0) / sts - 0.5;
    let v = (z - this.z0) / sts - 0.5;
    u = Math.min(sw - 1.001, Math.max(0, u));
    v = Math.min(sh - 1.001, Math.max(0, v));
    const i = u | 0, j = v | 0;
    const fx = u - i, fz = v - j;
    const f = this.fetch;
    const a = f[j * sw + i], b = f[j * sw + i + 1];
    const c = f[(j + 1) * sw + i], e = f[(j + 1) * sw + i + 1];
    return (a + (b - a) * fx) * (1 - fz) + (c + (e - c) * fx) * fz;
  }

  // ---------------------------------------------------------- textures ----

  buildTextures(): void {
    const n = this.w * this.h;
    const half = new Uint16Array(n);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < n; i++) half[i] = toHalf(Math.max(-400, Math.min(400, this.dist[i])));
    this.half = half;

    this.distTex = new THREE.DataTexture(half, this.w, this.h, THREE.RedFormat, THREE.HalfFloatType);
    this.distTex.magFilter = THREE.LinearFilter;
    this.distTex.minFilter = THREE.LinearFilter;
    this.distTex.wrapS = THREE.ClampToEdgeWrapping;
    this.distTex.wrapT = THREE.ClampToEdgeWrapping;
    this.distTex.generateMipmaps = false;
    this.distTex.colorSpace = THREE.NoColorSpace;
    this.distTex.needsUpdate = true;

    const sn = this.sw * this.sh;
    const aux = new Uint8Array(sn * 4);
    this.packAux(aux);
    this.auxTex = new THREE.DataTexture(aux, this.sw, this.sh, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.auxTex.magFilter = THREE.LinearFilter;
    this.auxTex.minFilter = THREE.LinearFilter;
    this.auxTex.wrapS = THREE.ClampToEdgeWrapping;
    this.auxTex.wrapT = THREE.ClampToEdgeWrapping;
    this.auxTex.generateMipmaps = false;
    this.auxTex.colorSpace = THREE.NoColorSpace;
    this.auxTex.needsUpdate = true;
  }

  private packAux(aux: Uint8Array): void {
    const sn = this.sw * this.sh;
    for (let i = 0; i < sn; i++) {
      // bed: -60..100 m over the byte range
      aux[i * 4] = Math.round(Math.min(255, Math.max(0, ((this.bed[i] + 60) / 160) * 255)));
      aux[i * 4 + 1] = Math.round(Math.min(255, Math.max(0, this.fetch[i] * 255)));
      aux[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, this.murk[i] * 255)));
      aux[i * 4 + 3] = Math.round(Math.min(255, Math.max(0, this.surf[i] * 255)));
    }
  }

  /**
   * Drop everything that only the build needed.
   *
   * The field is the single largest CPU allocation in the module and most of
   * it is scratch. At the shipped 6 m texel the grid is 2131 x 1845, so:
   *
   *   bodyAt   Int32    15.0 MB   which body owns a texel; wanted by
   *                               'rasterise', 'refreshFetch' and
   *                               'measureInradii', all of which have run
   *   dist     Float32  15.0 MB   superseded by the half-float copy the
   *                               texture already holds, which is the same
   *                               field at half the bytes
   *   bed/fetch/murk/mask
   *            Float32   3.8 MB   staged into 'auxTex' by 'buildTextures';
   *                               'sampleFetch' wants 'fetch', and the
   *                               surface builder is the only caller
   *
   * 33.8 MB, none of it reachable by anything that runs after load. What
   * stays is the 7.5 MB half-float field (which 'sampleDist' now reads and
   * 'distTex' owns) and the 0.9 MB packed aux bytes.
   *
   * Call once, after the surfaces have been built -- 'buildSurfaces' and
   * 'buildOceanSkirt' both sample 'fetch'.
   */
  compact(): number {
    const freed = this.dist.byteLength + this.bodyAt.byteLength
      + this.bed.byteLength + this.fetch.byteLength
      + this.murk.byteLength + this.surf.byteLength;
    const none = new Float32Array(0);
    this.dist = none;
    this.bodyAt = new Int32Array(0);
    this.bed = none;
    this.fetch = none;
    this.murk = none;
    this.surf = none;
    return freed;
  }

  dispose(): void {
    this.distTex?.dispose();
    this.auxTex?.dispose();
  }

  // ----------------------------------------------------- distance field ----

  /**
   * Exact Euclidean distance transform in both directions, converted to a
   * signed field in metres. Positive = inside the water.
   */
  private insideToSigned(inside: Uint8Array): void {
    const { w, h, ts } = this;
    const n = w * h;
    const INF = 1e12;

    const a = new Float32Array(n); // distance² to the nearest land texel
    const b = new Float32Array(n); // distance² to the nearest water texel
    for (let i = 0; i < n; i++) {
      a[i] = inside[i] ? INF : 0;
      b[i] = inside[i] ? 0 : INF;
    }
    edt2d(a, w, h);
    edt2d(b, w, h);

    const d = this.dist;
    for (let i = 0; i < n; i++) {
      // The half-texel bias puts the zero crossing on the boundary rather than
      // on the first covered texel centre.
      d[i] = inside[i]
        ? (Math.sqrt(a[i]) - 0.5) * ts
        : -(Math.sqrt(b[i]) - 0.5) * ts;
    }
  }
}

// --------------------------------------------------------- EDT internals ----

/** Felzenszwalb–Huttenlocher separable squared-distance transform, in place. */
function edt2d(grid: Float32Array, w: number, h: number): void {
  const m = Math.max(w, h);
  const f = new Float32Array(m);
  const d = new Float32Array(m);
  const v = new Int32Array(m);
  const z = new Float32Array(m + 1);

  const pass = (n: number): void => {
    let k = 0;
    v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dd = q - v[k];
      d[q] = dd * dd + f[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[o + x];
    pass(w);
    for (let x = 0; x < w; x++) grid[o + x] = d[x];
  }
}
