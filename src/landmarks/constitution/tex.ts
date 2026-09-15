/**
 * Two textures the shared library has no family for: a scrubbed pine deck and
 * the 1797 fifteen-star ensign she flies. Both are tiny canvases, generated
 * once and cached for the lifetime of the page.
 */
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

function memo(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

function surface(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return { c, g: c.getContext('2d')! };
}

/**
 * Holystoned deck planking. One tile is 2 m of deck: eight 250 mm strakes with
 * caulked seams and butt joints, which at eye level is the difference between a
 * deck and a beige plane.
 */
export function deckPlanks(): THREE.Texture {
  return memo('deck', () => {
    const S = 512;
    const { c, g } = surface(S);
    const strakes = 8;
    const h = S / strakes;
    g.fillStyle = '#cbb894';
    g.fillRect(0, 0, S, S);
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < strakes; i++) {
      const y = i * h;
      // Plank body: pine varies course to course after a century of scrubbing.
      const v = 0.86 + rnd() * 0.22;
      const r = Math.round(203 * v);
      const gg = Math.round(184 * v);
      const bb = Math.round(148 * v);
      g.fillStyle = `rgb(${r},${gg},${bb})`;
      g.fillRect(0, y, S, h);
      // Grain.
      for (let k = 0; k < 26; k++) {
        g.fillStyle = `rgba(120,96,64,${0.035 + rnd() * 0.05})`;
        const gy = y + rnd() * h;
        g.fillRect(rnd() * S, gy, 20 + rnd() * 160, 1);
      }
      // Butt joint somewhere along the strake.
      const bx = rnd() * S;
      g.fillStyle = 'rgba(46,38,28,0.85)';
      g.fillRect(bx, y + 1, 1.5, h - 2);
      // Caulked seam at the strake edge.
      g.fillStyle = 'rgba(28,24,20,0.92)';
      g.fillRect(0, y, S, 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  });
}

/**
 * The fifteen-star, fifteen-stripe ensign of 1795-1818 — the flag she was
 * launched under and the one she wears today. Drawn 1.9:1, the proportion of a
 * US naval ensign.
 */
export function ensignTexture(): THREE.Texture {
  return memo('ensign', () => {
    const W = 256;
    const H = 135;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const stripes = 15;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 === 0 ? '#a8232c' : '#eceae2';
      g.fillRect(0, (i * H) / stripes, W, H / stripes + 1);
    }
    const cw = W * 0.42;
    const ch = (H / stripes) * 9;
    g.fillStyle = '#1d2b58';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#f2f0e8';
    for (let r = 0; r < 5; r++) {
      for (let k = 0; k < 3; k++) {
        const x = (cw * (k + 0.5)) / 3;
        const y = (ch * (r + 0.5)) / 5;
        g.beginPath();
        g.arc(x, y, 3.1, 0, Math.PI * 2);
        g.fill();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  });
}

/** The naval jack: the canton alone, flown from the bowsprit. */
export function jackTexture(): THREE.Texture {
  return memo('jack', () => {
    const W = 160;
    const H = 110;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1d2b58';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2f0e8';
    for (let r = 0; r < 5; r++) {
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        g.arc((W * (k + 0.5)) / 3, (H * (r + 0.5)) / 5, 6.2, 0, Math.PI * 2);
        g.fill();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  });
}

export function disposeShipTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
