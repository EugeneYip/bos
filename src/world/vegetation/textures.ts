/**
 * Every pixel the vegetation module draws is generated here, on a 2D canvas,
 * at boot. Nothing is fetched.
 *
 * Three families of art:
 *
 *  - **Foliage cards.** A cluster of individually-drawn leaves radiating from
 *    a stem at the bottom edge of the tile. Alpha-tested. This is what gives a
 *    crown a real leaf silhouette and lets daylight through it, instead of the
 *    solid "broccoli" you get from a displaced icosahedron.
 *  - **Bark.** Tileable vertical furrows, three habits (ridged, plated, and
 *    cherry's horizontal lenticels).
 *  - **Impostors.** A side and a top view of the whole tree, drawn from the
 *    same leaf outlines so a tree does not change species when it crosses the
 *    LOD boundary.
 *
 * Everything is drawn in near-neutral luminance: the shader multiplies by the
 * species' summer/autumn colour, so one grey texture serves a green June and a
 * scarlet October.
 */
import * as THREE from 'three';
import { crownRadius, type BarkKind, type CrownShape, type LeafShape, type Species } from './species';

type G2D = CanvasRenderingContext2D;

function surface(w: number, h: number): { c: HTMLCanvasElement; g: G2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: false });
  if (!g) throw new Error('[Vegetation] 2D canvas context unavailable');
  return { c, g };
}

/** Deterministic LCG so every boot produces the identical forest. */
export function rand(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function tex(c: HTMLCanvasElement, srgb: boolean, aniso: number): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Leaf outlines
// ---------------------------------------------------------------------------

interface Tip { a: number; r: number }

/** Palmate / lobed outline: pointed tips, rounded sinuses between them. */
function lobedPath(g: G2D, tips: Tip[], len: number, wide: number, sinus: number): void {
  const pt = (a: number, r: number): [number, number] => [
    Math.sin(a) * r * len * wide,
    -Math.cos(a) * r * len,
  ];
  // Left flank (mirrored, base -> apex), apex, right flank (apex -> base).
  const order: Tip[] = [];
  for (let i = tips.length - 1; i >= 1; i--) order.push({ a: -tips[i].a, r: tips[i].r });
  order.push(tips[0]);
  for (let i = 1; i < tips.length; i++) order.push(tips[i]);

  g.beginPath();
  g.moveTo(0, 0);
  let prev = order[0];
  g.lineTo(...pt(prev.a, prev.r));
  for (let i = 1; i < order.length; i++) {
    const cur = order[i];
    const ma = (prev.a + cur.a) * 0.5;
    const mr = Math.min(prev.r, cur.r) * sinus;
    const ctrl = pt(ma, mr);
    const end = pt(cur.a, cur.r);
    g.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    prev = cur;
  }
  g.closePath();
}

/** Heart-shaped (linden). */
function cordatePath(g: G2D, len: number): void {
  const w = len * 0.52;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-w * 0.35, -len * 0.02, -w, -len * 0.16, -w, -len * 0.45);
  g.bezierCurveTo(-w, -len * 0.82, -w * 0.4, -len, 0, -len);
  g.bezierCurveTo(w * 0.4, -len, w, -len * 0.82, w, -len * 0.45);
  g.bezierCurveTo(w, -len * 0.16, w * 0.35, -len * 0.02, 0, 0);
  g.closePath();
}

/** Simple pointed ellipse with a serrated edge (cherry). */
function ovatePath(g: G2D, len: number): void {
  const w = len * 0.40;
  g.beginPath();
  g.moveTo(0, 0);
  const steps = 9;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const y = -len * t;
    const x = w * Math.sin(Math.PI * Math.pow(t, 0.75)) * (i % 2 ? 1.0 : 0.88);
    g.lineTo(x, y);
  }
  for (let i = steps - 1; i >= 1; i--) {
    const t = i / steps;
    const y = -len * t;
    const x = -w * Math.sin(Math.PI * Math.pow(t, 0.75)) * (i % 2 ? 0.88 : 1.0);
    g.lineTo(x, y);
  }
  g.closePath();
}

const MAPLE_TIPS: Tip[] = [
  { a: 0, r: 1.0 },
  { a: 0.72, r: 0.93 },
  { a: 1.5, r: 0.66 },
];
const OAK_TIPS: Tip[] = [
  { a: 0, r: 1.0 },
  { a: 0.42, r: 0.94 },
  { a: 0.78, r: 0.85 },
  { a: 1.12, r: 0.66 },
  { a: 1.46, r: 0.42 },
];

/** Draws one leaf pointing "up" (-y) from the current origin. */
function drawLeaf(g: G2D, shape: LeafShape, len: number, fill: string, vein: string): void {
  switch (shape) {
    case 'maple':
      lobedPath(g, MAPLE_TIPS, len, 1.05, 0.38);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'oak':
      lobedPath(g, OAK_TIPS, len, 0.62, 0.46);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'cordate':
      cordatePath(g, len);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'ovate':
      ovatePath(g, len);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'pinnate': {
      // A compound leaf: bare rachis with small opposite leaflets. Reads as the
      // lacy, see-through canopy honey locust actually has.
      g.strokeStyle = vein;
      g.lineWidth = Math.max(0.6, len * 0.014);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, -len);
      g.stroke();
      g.fillStyle = fill;
      const pairs = 8;
      for (let i = 1; i <= pairs; i++) {
        const t = i / (pairs + 0.6);
        const y = -len * t;
        const s = len * 0.19 * (1 - 0.35 * Math.abs(t - 0.5));
        for (const side of [-1, 1]) {
          g.save();
          g.translate(side * len * 0.02, y);
          g.rotate(side * 1.15);
          g.beginPath();
          g.ellipse(0, -s * 0.5, s * 0.30, s * 0.55, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      }
      return;
    }
    case 'needle': {
      // A fascicle of five long needles, the white pine signature.
      g.strokeStyle = fill;
      g.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const a = (i / 4 - 0.5) * 0.44;
        g.lineWidth = Math.max(0.7, len * 0.026);
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(Math.sin(a) * len * 0.4, -len * 0.55,
          Math.sin(a) * len * 1.05, -len * (0.86 + 0.14 * Math.cos(a)));
        g.stroke();
      }
      return;
    }
  }
  // Midrib, for close-range detail.
  g.strokeStyle = vein;
  g.lineWidth = Math.max(0.5, len * 0.022);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.88);
  g.stroke();
}

// ---------------------------------------------------------------------------
// Foliage card
// ---------------------------------------------------------------------------

/**
 * One card of the leaf mass: a short forked twig rising from the bottom-centre
 * of the tile with leaves along it. The bottom edge is the attachment point, so
 * cards can be pinned to branch tips and fan outwards.
 */
export function foliageCardTexture(sp: Species, size: number, aniso: number): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(Math.round(sp.height * 7919 + sp.spread * 104729 + sp.leaf.length * 31));
  g.clearRect(0, 0, size, size);

  const baseX = size * 0.5;
  const baseY = size * 0.995;
  const leafLen = size * (sp.leaf === 'needle' ? 0.30 : sp.leaf === 'pinnate' ? 0.34 : 0.235);
  const twigs = sp.leaf === 'needle' ? 7 : 5;

  interface Slot { x: number; y: number; a: number; s: number; depth: number }
  const slots: Slot[] = [];

  for (let t = 0; t < twigs; t++) {
    const spread = sp.leaf === 'pinnate' ? 1.15 : 0.95;
    const a = ((t + 0.5) / twigs - 0.5) * 2 * spread + (r() - 0.5) * 0.22;
    const len = size * (0.52 + r() * 0.34);
    const tipX = baseX + Math.sin(a) * len * 0.82;
    const tipY = baseY - Math.cos(a) * len;

    // Twig, drawn dark so it reads as structure inside the leaf mass.
    g.strokeStyle = 'rgba(70,58,44,0.85)';
    g.lineWidth = Math.max(1, size * 0.008 * (1 - t / (twigs * 2)));
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(baseX, baseY);
    g.quadraticCurveTo(baseX + Math.sin(a) * len * 0.3, baseY - len * 0.55, tipX, tipY);
    g.stroke();

    const n = sp.leaf === 'needle' ? 9 : sp.leaf === 'pinnate' ? 5 : 7;
    for (let i = 0; i < n; i++) {
      const u = 0.22 + 0.82 * (i / n) + r() * 0.08;
      const px = baseX + (tipX - baseX) * u + (r() - 0.5) * size * 0.05;
      const py = baseY + (tipY - baseY) * u + (r() - 0.5) * size * 0.05;
      const side = i % 2 === 0 ? 1 : -1;
      const la = a + side * (0.55 + r() * 0.5) * (1 - u * 0.45);
      slots.push({ x: px, y: py, a: la, s: 0.72 + r() * 0.5, depth: u });
    }
  }
  // A handful of outliers so the silhouette is ragged rather than a clean lobe.
  for (let i = 0; i < 7; i++) {
    const a = (r() - 0.5) * 2.1;
    const d = size * (0.5 + r() * 0.42);
    slots.push({
      x: baseX + Math.sin(a) * d * 0.85,
      y: baseY - Math.cos(a) * d,
      a: a + (r() - 0.5) * 1.1,
      s: 0.55 + r() * 0.4,
      depth: 1,
    });
  }

  // Back to front, so leaves near the stem sit behind the outer ones.
  slots.sort((p, q) => p.depth - q.depth);
  for (const s of slots) {
    // Near-neutral luminance with a slight warm/cool skew per leaf: the shader
    // supplies the hue, this supplies the variation.
    const v = 0.56 + r() * 0.44;
    const warm = (r() - 0.5) * 0.16;
    const cr = Math.round(255 * Math.min(1, v * (1 + warm)));
    const cg = Math.round(255 * Math.min(1, v * (1 + warm * 0.15)));
    const cb = Math.round(255 * Math.min(1, v * (1 - warm * 0.55) * 0.93));
    const fill = `rgb(${cr},${cg},${cb})`;
    const vein = `rgba(${Math.round(cr * 0.62)},${Math.round(cg * 0.62)},${Math.round(cb * 0.62)},0.85)`;
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.a);
    drawLeaf(g, sp.leaf, leafLen * s.s, fill, vein);
    g.restore();
  }

  // Bake a little self-shadowing: the base of the cluster sits inside the crown.
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, 0);
  shade.addColorStop(0, 'rgba(18,26,14,0.55)');
  shade.addColorStop(0.45, 'rgba(24,32,18,0.18)');
  shade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// Bark
// ---------------------------------------------------------------------------

export function barkTexture(kind: BarkKind, size: number, aniso: number): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(kind.length * 7717 + 13);
  g.fillStyle = '#9b948a';
  g.fillRect(0, 0, size, size);

  // Vertical furrows. Wrapping in y is free because every stroke spans the tile.
  const strips = kind === 'plated' ? 26 : 44;
  for (let i = 0; i < strips; i++) {
    const x = r() * size;
    const w = size * (0.008 + r() * 0.035);
    const dark = 0.32 + r() * 0.45;
    g.strokeStyle = `rgba(${Math.round(60 * dark)},${Math.round(54 * dark)},${Math.round(46 * dark)},${0.28 + r() * 0.45})`;
    g.lineWidth = w;
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= size; y += size / 12) {
      px += (r() - 0.5) * size * 0.035;
      g.lineTo(px, y);
    }
    g.stroke();
  }
  // Highlight ridges between the furrows.
  for (let i = 0; i < strips * 0.7; i++) {
    const x = r() * size;
    g.strokeStyle = `rgba(226,220,208,${0.08 + r() * 0.22})`;
    g.lineWidth = size * (0.004 + r() * 0.016);
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= size; y += size / 10) {
      px += (r() - 0.5) * size * 0.03;
      g.lineTo(px, y);
    }
    g.stroke();
  }

  if (kind === 'plated') {
    for (let i = 0; i < 90; i++) {
      const x = r() * size;
      const y = r() * size;
      const w = size * (0.05 + r() * 0.1);
      const h = size * (0.06 + r() * 0.16);
      g.fillStyle = `rgba(${40 + r() * 50 | 0},${36 + r() * 44 | 0},${30 + r() * 38 | 0},${0.1 + r() * 0.2})`;
      g.beginPath();
      g.ellipse(x, y, w * 0.5, h * 0.5, (r() - 0.5) * 0.6, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'lenticel') {
    // Cherry: smooth, glossy, banded with horizontal lenticels.
    g.fillStyle = 'rgba(180,168,158,0.35)';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 150; i++) {
      const y = r() * size;
      const x = r() * size;
      const w = size * (0.03 + r() * 0.12);
      g.fillStyle = `rgba(${30 + r() * 30 | 0},${24 + r() * 24 | 0},${20 + r() * 20 | 0},${0.25 + r() * 0.45})`;
      g.fillRect(x, y, w, Math.max(1, size * 0.006));
    }
  }

  // Fine grain.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 26;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);

  return tex(c, true, aniso);
}

// ---------------------------------------------------------------------------
// Impostor
// ---------------------------------------------------------------------------

/** A ragged dab of leaf mass, used to build the distance silhouette. */
function dab(g: G2D, x: number, y: number, rx: number, ry: number, r: () => number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  const lobes = 7;
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const k = 0.62 + r() * 0.72;
    const px = x + Math.cos(a) * rx * k;
    const py = y + Math.sin(a) * ry * k;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}

/**
 * Two 256 px views of a whole tree, side by side: [side | top]. The side view
 * carries the species silhouette for ground-level distance, the top view is
 * what an aerial camera sees — without it, a vertical billboard is edge-on from
 * above and the city's canopy vanishes at altitude.
 */
export function impostorTexture(sp: Species, tile: number, aniso: number): THREE.Texture {
  const { c, g } = surface(tile * 2, tile);
  const r = rand(Math.round(sp.height * 3733 + sp.spread * 65537 + sp.shape.length));
  g.clearRect(0, 0, tile * 2, tile);

  const leafFill = (v: number): string => {
    const cr = Math.round(255 * Math.min(1, v));
    const cg = Math.round(255 * Math.min(1, v * 1.02));
    const cb = Math.round(255 * Math.min(1, v * 0.9));
    return `rgb(${cr},${cg},${cb})`;
  };

  // ---- side view -----------------------------------------------------------
  const base = tile * 0.985;
  const top = tile * 0.02;
  const H = base - top;
  const cx = tile * 0.5;
  const halfW = tile * 0.5 * 0.94;
  const cb = sp.crownBase;

  // Trunk and primary limbs, drawn first so the leaf mass buries most of them.
  g.strokeStyle = 'rgba(96,86,74,1)';
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, tile * sp.trunkRadius * 1.9);
  g.beginPath();
  g.moveTo(cx, base);
  g.lineTo(cx, base - H * (cb + 0.1));
  g.stroke();
  for (let i = 0; i < sp.limbs; i++) {
    const side = i % 2 ? 1 : -1;
    const t = 0.1 + 0.55 * (i / sp.limbs);
    const y0 = base - H * (cb + t * 0.25);
    const rr = crownRadius(sp.shape, t) * halfW * (sp.spread / 0.8);
    g.lineWidth = Math.max(1.2, tile * sp.trunkRadius * (1.1 - 0.5 * t));
    g.beginPath();
    g.moveTo(cx, y0);
    g.quadraticCurveTo(cx + side * rr * 0.4, y0 - H * 0.08,
      cx + side * rr * 0.8, base - H * (cb + (1 - cb) * (t + 0.25)));
    g.stroke();
  }

  const dabs = Math.round(150 * sp.density);
  for (let i = 0; i < dabs; i++) {
    const t = Math.pow(r(), 0.72);
    const rr = crownRadius(sp.shape, t);
    // Bias outwards so the interior stays open and the rim is dense.
    const q = Math.sqrt(r()) * rr;
    const sign = r() < 0.5 ? -1 : 1;
    const x = cx + sign * q * halfW * (sp.spread / 0.8);
    const y = base - H * (cb + (1 - cb) * t);
    const s = tile * 0.055 * (0.7 + r() * 0.7) * (sp.conifer ? 0.8 : 1);
    // Bake form: brighter up and to the left, deep shade underneath.
    const lift = 0.42 + 0.58 * t;
    const sideLight = 0.86 + 0.28 * (0.5 - sign * q * 0.5);
    dab(g, x, y, s * (sp.conifer ? 0.9 : 1.15), s * 0.85, r,
      leafFill(lift * sideLight * (0.72 + r() * 0.5)));
  }

  // ---- top view ------------------------------------------------------------
  const tx = tile * 1.5;
  const ty = tile * 0.5;
  const tr = tile * 0.47;
  const topDabs = Math.round(130 * sp.density);
  for (let i = 0; i < topDabs; i++) {
    const a = r() * Math.PI * 2;
    const q = Math.pow(r(), 0.55);
    const x = tx + Math.cos(a) * q * tr;
    const y = ty + Math.sin(a) * q * tr;
    const s = tile * 0.055 * (0.7 + r() * 0.7);
    // A crown from above is a dome: bright centre, shaded rim.
    const lift = 1.06 - 0.42 * q;
    dab(g, x, y, s * 1.1, s, r, leafFill(lift * (0.72 + r() * 0.5)));
  }

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// Ground cover
// ---------------------------------------------------------------------------

/** A tuft of grass blades filling the tile, attached along the bottom edge. */
export function grassTexture(size: number, aniso: number): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(90210);
  g.clearRect(0, 0, size, size);
  g.lineCap = 'round';
  const blades = 54;
  for (let i = 0; i < blades; i++) {
    const x0 = size * (0.08 + r() * 0.84);
    const h = size * (0.42 + r() * 0.56);
    const lean = (r() - 0.5) * size * 0.34;
    const v = 0.46 + r() * 0.5;
    const w = size * (0.008 + r() * 0.016);
    g.strokeStyle = `rgb(${Math.round(232 * v)},${Math.round(255 * v)},${Math.round(196 * v)})`;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, size);
    g.quadraticCurveTo(x0 + lean * 0.3, size - h * 0.6, x0 + lean, size - h);
    g.stroke();
  }
  // Roots in shade.
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, size * 0.35);
  shade.addColorStop(0, 'rgba(20,28,14,0.6)');
  shade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Small dense leaves for shrubs and hedges. */
export function shrubTexture(size: number, aniso: number): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(4242);
  g.clearRect(0, 0, size, size);
  const n = 190;
  for (let i = 0; i < n; i++) {
    const a = (r() - 0.5) * 2.4;
    const d = Math.pow(r(), 0.6) * size * 0.62;
    const x = size * 0.5 + Math.sin(a) * d * 0.9;
    const y = size - Math.cos(a) * d;
    if (y < 0) continue;
    const v = 0.44 + r() * 0.52;
    const s = size * (0.05 + r() * 0.05);
    g.save();
    g.translate(x, y);
    g.rotate(a + (r() - 0.5) * 1.4);
    g.fillStyle = `rgb(${Math.round(240 * v)},${Math.round(255 * v)},${Math.round(214 * v)})`;
    ovatePath(g, s * 2.2);
    g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, 0);
  shade.addColorStop(0, 'rgba(16,24,12,0.62)');
  shade.addColorStop(0.55, 'rgba(20,28,14,0.16)');
  shade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export interface VegTextures {
  leaf: THREE.Texture[];
  bark: Map<BarkKind, THREE.Texture>;
  impostor: THREE.Texture[];
  grass: THREE.Texture;
  shrub: THREE.Texture;
}

export function buildTextures(species: Species[], aniso: number, hiRes: boolean): VegTextures {
  const leafSize = hiRes ? 512 : 256;
  const barkSize = hiRes ? 512 : 256;
  const impSize = hiRes ? 256 : 128;
  const bark = new Map<BarkKind, THREE.Texture>();
  for (const k of ['ridged', 'plated', 'lenticel'] as BarkKind[]) {
    bark.set(k, barkTexture(k, barkSize, aniso));
  }
  return {
    leaf: species.map((s) => foliageCardTexture(s, leafSize, aniso)),
    bark,
    impostor: species.map((s) => impostorTexture(s, impSize, aniso)),
    grass: grassTexture(hiRes ? 512 : 256, aniso),
    shrub: shrubTexture(hiRes ? 512 : 256, aniso),
  };
}

export function disposeTextures(t: VegTextures | undefined): void {
  if (!t) return;
  for (const x of t.leaf) x.dispose();
  for (const x of t.bark.values()) x.dispose();
  for (const x of t.impostor) x.dispose();
  t.grass.dispose();
  t.shrub.dispose();
}

/** Only needed by the crown-shape helper; kept here so callers see one seed API. */
export type { CrownShape };
