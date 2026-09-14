/**
 * Deterministic hashing and pseudo-random numbers.
 *
 * Everything the buildings module scatters — roof clutter, window lighting,
 * facade variants, dormer spacing — is seeded from the OSM id so the city is
 * bit-identical on every reload and every machine. Nothing here ever touches
 * `Math.random()`.
 */

/** FNV-1a over a string -> uint32. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer avalanche (murmur3 finaliser) -> uint32. */
export function hash32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Integer -> [0,1). */
export function hash01(n: number): number {
  return hash32(n) / 4294967296;
}

/** Two integers -> [0,1). */
export function hash2(a: number, b: number): number {
  return hash32((a | 0) ^ Math.imul(b | 0, 0x27d4eb2f)) / 4294967296;
}

/** mulberry32 — small, fast, good enough, and fully reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rand {
  (): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of `arr` (never returns undefined for a non-empty array). */
  pick<T>(arr: readonly T[]): T;
  /** Roughly normal in [-1,1], concentrated near 0. */
  bell(): number;
}

/** Wrap a raw generator with the sampling helpers used all over this module. */
export function rand(seed: number): Rand {
  const r = mulberry32(seed) as Rand;
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1 - 1e-9));
  r.chance = (p) => r() < p;
  r.pick = <T,>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
  r.bell = () => (r() + r() + r()) * (2 / 3) - 1;
  return r;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
