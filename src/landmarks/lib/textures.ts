/**
 * Procedural canvas textures used as a *fallback* when the Materials module has
 * not published a real texture set for a surface family. Everything here is
 * generated once, cached, and disposed with the module.
 *
 * Colour maps are tagged `SRGBColorSpace`; normal/roughness data maps are
 * `NoColorSpace`, per the rendering conventions in ARCHITECTURE.md.
 */
import * as THREE from 'three';
import { rng } from './util';
import { WINDOW_ATLAS_SIZE } from './atlas';

const cache = new Map<string, THREE.Texture>();

function canvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  return { c, g };
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = 1): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function memo(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/** Convert a packed sRGB hex into a css string. */
const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

/**
 * Running-bond brick. `tileMeters` worth of wall per texture tile; a standard
 * US modular brick is 194 x 57 mm with 10 mm joints, so 2.4 m of wall is
 * ~12 courses — that's what this draws.
 */
export function brickTexture(base = 0x8d4f3c, mortar = 0xb9ac9c): THREE.Texture {
  return memo(`brick-${base}-${mortar}`, () => {
    const S = 512;
    const { c, g } = canvas(S);
    const rows = 12;
    const cols = 6;
    const h = S / rows;
    const w = S / cols;
    const r = rng(101);
    g.fillStyle = css(mortar);
    g.fillRect(0, 0, S, S);
    for (let y = 0; y < rows; y++) {
      const off = y % 2 ? w / 2 : 0;
      for (let x = -1; x <= cols; x++) {
        const v = r();
        const shade = 0.82 + v * 0.36;
        const col = new THREE.Color(base).multiplyScalar(shade);
        // A little hue scatter so the wall never reads as one flat colour.
        col.offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, 0);
        g.fillStyle = `#${col.getHexString()}`;
        g.fillRect(x * w + off + 1.5, y * h + 1.5, w - 3, h - 3);
        // Face speckle.
        for (let s = 0; s < 10; s++) {
          g.fillStyle = `rgba(0,0,0,${r() * 0.06})`;
          g.fillRect(x * w + off + r() * w, y * h + r() * h, 2, 2);
        }
      }
    }
    return finish(c, true);
  });
}

/** Coarse speckled granite — Quincy granite for the civic buildings. */
export function graniteTexture(base = 0x9c9a94, contrast = 0.28): THREE.Texture {
  return memo(`granite-${base}-${contrast}`, () => {
    const S = 512;
    const { c, g } = canvas(S);
    const r = rng(7);
    g.fillStyle = css(base);
    g.fillRect(0, 0, S, S);
    const col = new THREE.Color(base);
    for (let i = 0; i < 26000; i++) {
      const v = (r() - 0.5) * 2 * contrast;
      const s = new THREE.Color(col.r + v, col.g + v * 0.95, col.b + v * 0.9);
      g.fillStyle = `#${s.getHexString()}`;
      const sz = 1 + r() * 2.6;
      g.fillRect(r() * S, r() * S, sz, sz);
    }
    // Faint horizontal coursing so ashlar blocks read at close range.
    g.strokeStyle = 'rgba(0,0,0,0.16)';
    g.lineWidth = 1.5;
    for (let y = 0; y < 4; y++) {
      const yy = (y / 4) * S;
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(S, yy);
      g.stroke();
      const off = (y % 2) * (S / 6);
      for (let x = 0; x < 3; x++) {
        const xx = off + (x / 3) * S;
        g.beginPath();
        g.moveTo(xx, yy);
        g.lineTo(xx, yy + S / 4);
        g.stroke();
      }
    }
    return finish(c, true);
  });
}

/** Smooth pale marble with faint grey veining — the State House wings. */
export function marbleTexture(base = 0xe9e6de): THREE.Texture {
  return memo(`marble-${base}`, () => {
    const S = 512;
    const { c, g } = canvas(S);
    const r = rng(31);
    g.fillStyle = css(base);
    g.fillRect(0, 0, S, S);
    for (let v = 0; v < 26; v++) {
      g.strokeStyle = `rgba(120,118,112,${0.05 + r() * 0.09})`;
      g.lineWidth = 0.6 + r() * 2.2;
      g.beginPath();
      let x = r() * S;
      let y = -10;
      g.moveTo(x, y);
      while (y < S + 10) {
        x += (r() - 0.5) * 34;
        y += 12 + r() * 18;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    return finish(c, true);
  });
}

/** Board-formed concrete: horizontal plank lines + tie holes. City Hall. */
export function boardConcreteTexture(base = 0xa8a49b): THREE.Texture {
  return memo(`boardconc-${base}`, () => {
    const S = 512;
    const { c, g } = canvas(S);
    const r = rng(59);
    g.fillStyle = css(base);
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 16000; i++) {
      const v = (r() - 0.5) * 0.12;
      const col = new THREE.Color(base).offsetHSL(0, 0, v);
      g.fillStyle = `#${col.getHexString()}`;
      g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2);
    }
    // 200 mm boards; the tile covers 3.2 m of wall.
    const boards = 16;
    for (let i = 0; i <= boards; i++) {
      const y = (i / boards) * S;
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, y - 1, S, 2);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, y + 1, S, 1.5);
      // Wood grain streaks picked up from the formwork.
      for (let s = 0; s < 40; s++) {
        g.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
        g.fillRect(r() * S, y + 2 + r() * (S / boards - 4), 20 + r() * 60, 1);
      }
    }
    for (let i = 0; i < 12; i++) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath();
      g.arc(r() * S, r() * S, 3, 0, Math.PI * 2);
      g.fill();
    }
    return finish(c, true);
  });
}

/** Oxidised copper for Quincy Market's dome and Old North's spire trim. */
export function copperPatinaTexture(base = 0x5fa38c): THREE.Texture {
  return memo(`copper-${base}`, () => {
    const S = 256;
    const { c, g } = canvas(S);
    const r = rng(17);
    g.fillStyle = css(base);
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 900; i++) {
      const col = new THREE.Color(base).offsetHSL((r() - 0.5) * 0.06, (r() - 0.5) * 0.2, (r() - 0.5) * 0.18);
      g.fillStyle = `#${col.getHexString()}`;
      g.beginPath();
      g.arc(r() * S, r() * S, 2 + r() * 16, 0, Math.PI * 2);
      g.globalAlpha = 0.09 + r() * 0.14;
      g.fill();
    }
    g.globalAlpha = 1;
    return finish(c, true);
  });
}

/**
 * Gold-leaf micro-relief. Hand-laid leaf is never perfectly flat: this is the
 * roughness map that gives the State House dome its slightly quilted gleam
 * instead of a mirror-chrome look.
 */
export function goldLeafRoughness(): THREE.Texture {
  return memo('goldleaf-rough', () => {
    const S = 256;
    const { c, g } = canvas(S);
    const r = rng(1861);
    g.fillStyle = '#4a4a4a'; // ~0.29 roughness base
    g.fillRect(0, 0, S, S);
    // 85 mm leaf squares -> the tile covers ~2.7 m.
    const n = 32;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 40 + r() * 44;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect((x * S) / n, (y * S) / n, S / n - 0.5, S / n - 0.5);
      }
    }
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(255,255,255,${r() * 0.25})`;
      g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3);
    }
    return finish(c, false);
  });
}

/** Generic fine-grained bump normal map for stone/plaster surfaces. */
export function noiseNormal(strength = 0.5, seed = 3): THREE.Texture {
  return memo(`noisenrm-${strength}-${seed}`, () => {
    const S = 256;
    const { c, g } = canvas(S);
    const r = rng(seed);
    const img = g.createImageData(S, S);
    const h = new Float32Array(S * S);
    for (let i = 0; i < h.length; i++) h[i] = r();
    // Cheap 2-octave smoothing.
    const sm = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let a = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) a += h[((y + dy + S) % S) * S + ((x + dx + S) % S)];
        sm[y * S + x] = a / 9;
      }
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const l = sm[y * S + ((x - 1 + S) % S)];
        const rr = sm[y * S + ((x + 1) % S)];
        const u = sm[((y - 1 + S) % S) * S + x];
        const d = sm[((y + 1) % S) * S + x];
        const nx = (l - rr) * strength;
        const ny = (u - d) * strength;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz);
        const i = (y * S + x) * 4;
        img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
        img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c, false);
  });
}

/**
 * Emissive "lit window" lookup. Each texel is one window: a warm interior
 * colour at a random brightness, with ~45% of them completely dark so a night
 * tower never reads as a uniformly-lit slab. Sampled with NearestFilter and
 * one texel per pane (see curtainwall.ts).
 */
export function windowLightAtlas(seed = 12345, litFraction = 0.55): THREE.Texture {
  return memo(`winatlas-${seed}-${litFraction}`, () => {
    const S = WINDOW_ATLAS_SIZE;
    const { c, g } = canvas(S);
    const r = rng(seed);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let col: string;
        if (r() > litFraction) {
          col = '#000000';
        } else {
          const warm = r();
          const b = 0.35 + r() * 0.65;
          // Office fluorescent (cool) vs. incandescent/residential (warm).
          const cc = warm > 0.62
            ? new THREE.Color(0.82, 0.88, 1.0)
            : new THREE.Color(1.0, 0.86, 0.62);
          cc.multiplyScalar(b);
          col = `#${cc.getHexString()}`;
        }
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  });
}

export { WINDOW_ATLAS_SIZE };

/**
 * A flat colour + faint mullion grid for curtain-wall glass seen at LOD1/2,
 * where individual pane geometry has been dropped. `cols`/`rows` are panes per
 * texture tile.
 */
export function mullionGrid(cols = 8, rows = 8, line = 0.16): THREE.Texture {
  return memo(`mullion-${cols}-${rows}-${line}`, () => {
    const S = 256;
    const { c, g } = canvas(S);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    g.fillStyle = `rgba(20,24,30,${line})`;
    for (let x = 0; x <= cols; x++) g.fillRect(Math.round((x * S) / cols) - 1, 0, 2, S);
    for (let y = 0; y <= rows; y++) g.fillRect(0, Math.round((y * S) / rows) - 1, S, 2);
    return finish(c, true);
  });
}

/** Vertical slat/louvre pattern for mechanical screens and parking decks. */
export function louvreTexture(base = 0x3a3d41, n = 24): THREE.Texture {
  return memo(`louvre-${base}-${n}`, () => {
    const S = 128;
    const { c, g } = canvas(S);
    g.fillStyle = css(base);
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < n; i++) {
      const y = (i / n) * S;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, y, S, S / n / 2);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, y + S / n / 2, S, 1);
    }
    return finish(c, true);
  });
}

export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
