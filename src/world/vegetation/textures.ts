/**
 * Every pixel the vegetation module draws is generated here, on a 2D canvas,
 * at boot. Nothing is fetched.
 *
 * Four families of art:
 *
 *  - **Foliage cards (near).** A twig spray with *correctly sized* leaves.
 *    This is the one number that decides whether a tree reads as a tree from
 *    four metres away: the card is authored for a known physical size (see
 *    `cardMeters`) and each leaf is drawn at `species.leafMeters` within it, so
 *    a red maple leaf comes out 10 cm across rather than half a metre. Getting
 *    it wrong is the difference between foliage and bunting.
 *  - **Foliage clumps (mid).** The same leaves, but a 3-4 m mass of them with
 *    the form lighting baked in. A mid-tier card covers eight times the area of
 *    a near card, and drawing it with near-card art is exactly how you get
 *    dinner-plate leaves at 120 m.
 *  - **Bark.** Tileable vertical furrows, four habits (ridged, plated, cherry's
 *    horizontal lenticels, and London plane's mottled camouflage plates).
 *  - **Impostors.** A side and a top view of the whole tree, built from the
 *    species' crown envelope so a tree does not change shape when it crosses
 *    the LOD boundary.
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

/**
 * Alpha-weighted mean linear luminance of a canvas texture.
 *
 * Every family of art here is drawn in near-neutral luminance and then
 * multiplied in the shader by a species tint that is itself a real albedo. If
 * the art's mean is not 1, the two dark numbers multiply and the surface comes
 * out far darker than the colour anybody asked for — bark was landing at 0.033
 * linear against a real tree's 0.10-0.20. So the shader divides the map
 * through by this, turning it into a modulation around 1 and leaving the tint
 * as the albedo. Measuring it rather than hardcoding it means the art can be
 * redrawn without silently re-introducing the error.
 *
 * Alpha-weighted because a foliage card is mostly empty tile, and the average
 * that matters is the average over the leaves that actually get drawn.
 */
export function mapMean(t: THREE.Texture): number {
  const c = t.image as HTMLCanvasElement | undefined;
  if (!c?.getContext) return 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return 1;
  // A 512x512 read is about a megabyte; at nine textures this is a few
  // milliseconds against the two seconds the drawing itself takes.
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const lin = (v: number): number => {
    const u = v / 255;
    return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  let sum = 0;
  let weight = 0;
  // Every fourth pixel in each direction: a texture this size has nothing at
  // that frequency worth resolving and it cuts the cost sixteen-fold.
  for (let y = 0; y < c.height; y += 4) {
    for (let x = 0; x < c.width; x += 4) {
      const i = (y * c.width + x) * 4;
      const a = d[i + 3] / 255;
      sum += a * (0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
      weight += a;
    }
  }
  return weight > 1e-3 ? Math.max(0.02, sum / weight) : 1;
}

/**
 * Physical size of one near-tier foliage card for a species, metres. Geometry
 * derives the same number from `cardScale`; keeping the two in one expression
 * is what guarantees the leaves come out life-size.
 */
export function cardMeters(sp: Species): number {
  return sp.cardScale * sp.spread * 0.5 * sp.height * 0.8;
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

/** Elm: an ellipse that is fatter and blunter on one side of the midrib. */
function ellipticPath(g: G2D, len: number): void {
  const w = len * 0.44;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(w * 0.7, -len * 0.10, w * 1.06, -len * 0.42, 0, -len);
  g.bezierCurveTo(-w * 0.86, -len * 0.44, -w * 0.56, -len * 0.08, 0, 0);
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
/** London plane: three broad shallow lobes, wider than long. */
const PLANE_TIPS: Tip[] = [
  { a: 0, r: 1.0 },
  { a: 0.95, r: 0.95 },
  { a: 1.72, r: 0.60 },
];

/** Draws one leaf pointing "up" (-y) from the current origin. */
function drawLeaf(g: G2D, shape: LeafShape, len: number, fill: string, vein: string): void {
  const fine = len > 14;
  switch (shape) {
    case 'maple':
      lobedPath(g, MAPLE_TIPS, len, 1.05, 0.38);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'palmate':
      lobedPath(g, PLANE_TIPS, len, 1.22, 0.44);
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
    case 'elliptic':
      ellipticPath(g, len);
      g.fillStyle = fill;
      g.fill();
      break;
    case 'pinnate': {
      // A compound leaf: bare rachis with small opposite leaflets. Reads as the
      // lacy, see-through canopy honey locust actually has.
      g.strokeStyle = vein;
      g.lineWidth = Math.max(0.5, len * 0.016);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, -len);
      g.stroke();
      g.fillStyle = fill;
      const pairs = len > 20 ? 9 : 6;
      for (let i = 1; i <= pairs; i++) {
        const t = i / (pairs + 0.6);
        const y = -len * t;
        const s = len * 0.20 * (1 - 0.35 * Math.abs(t - 0.5));
        for (const side of [-1, 1]) {
          g.save();
          g.translate(side * len * 0.02, y);
          g.rotate(side * 1.15);
          g.beginPath();
          g.ellipse(0, -s * 0.5, Math.max(0.6, s * 0.30), Math.max(0.9, s * 0.55), 0, 0, Math.PI * 2);
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
        g.lineWidth = Math.max(0.55, len * 0.05);
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(Math.sin(a) * len * 0.4, -len * 0.55,
          Math.sin(a) * len * 1.05, -len * (0.86 + 0.14 * Math.cos(a)));
        g.stroke();
      }
      return;
    }
  }
  if (!fine) return;
  // Midrib, only where the leaf is big enough on screen for it to be visible.
  g.strokeStyle = vein;
  g.lineWidth = Math.max(0.5, len * 0.022);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.88);
  g.stroke();
}

// ---------------------------------------------------------------------------
// Foliage cards
// ---------------------------------------------------------------------------

interface Slot { x: number; y: number; a: number; s: number; depth: number }

/** Near-neutral leaf fill with a small per-leaf warm/cool skew. */
function leafPaint(r: () => number, lo: number, span: number): { fill: string; vein: string } {
  const v = lo + r() * span;
  const warm = (r() - 0.5) * 0.18;
  const cr = Math.round(255 * Math.min(1, v * (1 + warm)));
  const cg = Math.round(255 * Math.min(1, v * (1 + warm * 0.15)));
  const cb = Math.round(255 * Math.min(1, v * (1 - warm * 0.55) * 0.93));
  return {
    fill: `rgb(${cr},${cg},${cb})`,
    vein: `rgba(${Math.round(cr * 0.6)},${Math.round(cg * 0.6)},${Math.round(cb * 0.6)},0.8)`,
  };
}

/**
 * One near-tier card of the leaf mass: a forked twig rising from the
 * bottom-centre of the tile with life-size leaves along it. The bottom edge is
 * the attachment point, so cards can be pinned to branch tips and fan outwards.
 */
export function foliageCardTexture(sp: Species, size: number, aniso: number): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(Math.round(sp.height * 7919 + sp.spread * 104729 + sp.name.length * 3121));
  g.clearRect(0, 0, size, size);

  const baseX = size * 0.5;
  const baseY = size * 0.995;
  // The whole point of this file: the leaf is a fixed fraction of a card whose
  // physical size is known, so it lands at its real length in metres.
  const leafLen = Math.max(4, size * (sp.leafMeters / cardMeters(sp)));
  const twigs = sp.conifer ? 7 : 5;
  const slots: Slot[] = [];

  for (let t = 0; t < twigs; t++) {
    const spread = sp.leaf === 'pinnate' ? 1.2 : 1.0;
    const a = ((t + 0.5) / twigs - 0.5) * 2 * spread + (r() - 0.5) * 0.24;
    const len = size * (0.56 + r() * 0.36);
    const tipX = baseX + Math.sin(a) * len * 0.84;
    const tipY = baseY - Math.cos(a) * len;

    // Twig, drawn dark so it reads as structure inside the leaf mass.
    g.strokeStyle = 'rgba(66,54,40,0.9)';
    g.lineWidth = Math.max(1, size * 0.006 * (1 - t / (twigs * 2)));
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(baseX, baseY);
    g.quadraticCurveTo(baseX + Math.sin(a) * len * 0.3, baseY - len * 0.55, tipX, tipY);
    g.stroke();

    // Leaves along the twig at a realistic internode: roughly half a leaf
    // length apart, alternating sides.
    const along = Math.max(4, Math.round((len * 0.8) / (leafLen * 0.52)));
    for (let i = 0; i < along; i++) {
      const u = 0.14 + 0.88 * (i / along) + r() * 0.05;
      const px = baseX + (tipX - baseX) * u + (r() - 0.5) * leafLen * 0.5;
      const py = baseY + (tipY - baseY) * u + (r() - 0.5) * leafLen * 0.5;
      const side = i % 2 === 0 ? 1 : -1;
      const la = a + side * (0.5 + r() * 0.6) * (1 - u * 0.4);
      slots.push({ x: px, y: py, a: la, s: 0.78 + r() * 0.42, depth: u });

      // A short side shoot every third internode, which is what fills the
      // mass out without turning it into a flat fan.
      if (i % 3 === 1 && i > 1) {
        const sa = a + side * (0.75 + r() * 0.5);
        const sl = leafLen * (1.4 + r() * 1.6);
        const n2 = Math.max(2, Math.round(sl / (leafLen * 0.55)));
        for (let k = 0; k < n2; k++) {
          const v = (k + 1) / n2;
          slots.push({
            x: px + Math.sin(sa) * sl * v,
            y: py - Math.cos(sa) * sl * v,
            a: sa + (r() - 0.5) * 1.0,
            s: 0.66 + r() * 0.4,
            depth: u + 0.05,
          });
        }
      }
    }
  }
  // A handful of outliers so the silhouette is ragged rather than a clean lobe.
  for (let i = 0; i < 10; i++) {
    const a = (r() - 0.5) * 2.2;
    const d = size * (0.52 + r() * 0.44);
    slots.push({
      x: baseX + Math.sin(a) * d * 0.88,
      y: baseY - Math.cos(a) * d,
      a: a + (r() - 0.5) * 1.2,
      s: 0.5 + r() * 0.4,
      depth: 1,
    });
  }

  // Back to front, so leaves near the stem sit behind the outer ones.
  slots.sort((p, q) => p.depth - q.depth);
  for (const s of slots) {
    const paint = leafPaint(r, 0.5, 0.5);
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.a);
    drawLeaf(g, sp.leaf, leafLen * s.s, paint.fill, paint.vein);
    g.restore();
  }

  // Bake a little self-shadowing: the base of the cluster sits inside the crown.
  shadeFromBelow(g, size, 0.5);

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Darken the attachment end of a card: it is buried in the crown. */
function shadeFromBelow(g: G2D, size: number, strength: number): void {
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, 0);
  shade.addColorStop(0, `rgba(18,26,14,${0.62 * strength})`);
  shade.addColorStop(0.5, `rgba(24,32,18,${0.2 * strength})`);
  shade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';
}

/**
 * Mid-tier card: a 3-4 m clump of the same foliage, with the form lighting
 * baked in. Built as a handful of overlapping sprays inside a ragged envelope,
 * so the *silhouette* keeps leaf-scale notches while the interior resolves to
 * a mass — which is what a crown actually looks like from 120 m.
 */
export function foliageClumpTexture(
  sp: Species, size: number, aniso: number, meters: number,
): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(Math.round(sp.height * 2711 + sp.spread * 31337 + sp.name.length * 911));
  g.clearRect(0, 0, size, size);

  const leafLen = Math.max(3.0, size * (sp.leafMeters / meters));
  // Coverage target: a dense species fills the clump, an airy one lets the sky
  // through. Leaf silhouette area is ~0.42 of its bounding square.
  const cover = 0.30 + 0.52 * Math.min(1.2, sp.density);
  const perLeaf = leafLen * leafLen * 0.42;
  const total = Math.min(3400, Math.max(120, Math.round((size * size * cover) / perLeaf)));

  // Lobes of the clump, bottom-attached like the near card.
  const lobes = 5;
  const centres: [number, number, number][] = [];
  for (let i = 0; i < lobes; i++) {
    const a = ((i + 0.5) / lobes - 0.5) * 2.0;
    const d = size * (0.34 + r() * 0.30);
    centres.push([
      size * 0.5 + Math.sin(a) * d * 0.92,
      size * 0.96 - Math.cos(a) * d,
      size * (0.16 + r() * 0.12),
    ]);
  }

  // Twig structure, dark, drawn first.
  g.strokeStyle = 'rgba(58,48,36,0.85)';
  g.lineCap = 'round';
  for (const [cx, cy, cr0] of centres) {
    g.lineWidth = Math.max(1, size * 0.008);
    g.beginPath();
    g.moveTo(size * 0.5, size * 0.99);
    g.quadraticCurveTo((size * 0.5 + cx) * 0.5, (size * 0.99 + cy) * 0.5, cx, cy);
    g.stroke();
    void cr0;
  }

  for (let i = 0; i < total; i++) {
    const lobe = centres[Math.floor(r() * centres.length)];
    // Bias outward so the rim is where the leaves are and the core stays dark.
    const a = r() * Math.PI * 2;
    const q = Math.pow(r(), 0.55);
    const x = lobe[0] + Math.cos(a) * q * lobe[2] * 1.35;
    const y = lobe[1] + Math.sin(a) * q * lobe[2];
    if (y > size * 1.02 || y < -leafLen) continue;
    // Bake the form: lit from up and to the left, shadowed underneath.
    const lift = 0.44 + 0.62 * (1 - y / size) + 0.16 * (0.5 - (x / size - 0.5));
    const paint = leafPaint(r, Math.min(0.95, 0.30 + 0.62 * lift), 0.26);
    g.save();
    g.translate(x, y);
    g.rotate(a + (r() - 0.5) * 1.6);
    drawLeaf(g, sp.leaf, leafLen * (0.7 + r() * 0.6), paint.fill, paint.vein);
    g.restore();
  }

  shadeFromBelow(g, size, 0.85);

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
  } else if (kind === 'mottled') {
    // London plane: pale cream under-bark showing through olive-grey flakes
    // that shed in irregular jigsaw plates. Unmistakable close up.
    g.fillStyle = '#c9c4ad';
    g.fillRect(0, 0, size, size);
    const plates = 54;
    for (let i = 0; i < plates; i++) {
      const x = r() * size;
      const y = r() * size;
      const rx = size * (0.06 + r() * 0.14);
      const ry = size * (0.07 + r() * 0.17);
      const shade = r();
      const col = shade < 0.42
        ? `rgba(${96 + r() * 26 | 0},${96 + r() * 24 | 0},${74 + r() * 20 | 0},0.85)`
        : shade < 0.78
          ? `rgba(${150 + r() * 28 | 0},${148 + r() * 24 | 0},${120 + r() * 22 | 0},0.8)`
          : `rgba(${212 + r() * 28 | 0},${208 + r() * 26 | 0},${182 + r() * 24 | 0},0.85)`;
      g.fillStyle = col;
      g.beginPath();
      const lobes = 8;
      for (let k = 0; k <= lobes; k++) {
        const a = (k / lobes) * Math.PI * 2;
        const kk = 0.6 + r() * 0.7;
        const px = x + Math.cos(a) * rx * kk;
        const py = y + Math.sin(a) * ry * kk;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
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

/**
 * A ragged dab of leaf mass, used to build the distance silhouette.
 *
 * The outline is a closed quadratic spline through the midpoints of a
 * jittered heptagon, so the vertices act as control points and the edge comes
 * out curved. It used to be `lineTo` between the vertices with the radius
 * jittered +-47 %, which at the sizes these are actually drawn at -- 15 to 25
 * px on a 256 px tile -- is not a soft clump of leaves, it is a paper chip
 * with straight edges and sharp corners. Forty-seven of them scattered over a
 * crown is what made the city's canopy read as crumpled litter from the air.
 */
function dab(g: G2D, x: number, y: number, rx: number, ry: number, r: () => number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  const lobes = 7;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const k = 0.66 + r() * 0.52;
    px.push(x + Math.cos(a) * rx * k);
    py.push(y + Math.sin(a) * ry * k);
  }
  g.moveTo((px[lobes - 1] + px[0]) * 0.5, (py[lobes - 1] + py[0]) * 0.5);
  for (let i = 0; i < lobes; i++) {
    const j = (i + 1) % lobes;
    g.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) * 0.5, (py[i] + py[j]) * 0.5);
  }
  g.closePath();
  g.fill();
}

/** Mean of the crown envelope over its height; sets the silhouette's area. */
function meanCrownRadius(sp: Species): number {
  let s = 0;
  const n = 24;
  for (let i = 0; i < n; i++) s += crownRadius(sp.shape, (i + 0.5) / n);
  return s / n;
}

/**
 * How many dabs of area `dabPx²`-ish it takes to *cover* `areaPx` of crown.
 *
 * Coverage, not a density guess, is the number that decides whether an
 * impostor is a tree or a scatter of chips: random dabs at 1.0x coverage
 * leave holes over about a third of the area, and the holes are what the
 * alpha test then widens as the mip chain averages them down. 2.6x is the
 * point at which the interior of a crown comes out solid and only the rim
 * stays ragged, which is what a real crown does at 300 m — you are looking
 * through two crossings of the leaf shell and everything between them.
 */
function dabsToCover(areaPx: number, dabPx: number, density: number): number {
  const perDab = 3.1 * dabPx * dabPx;
  return Math.round(THREE.MathUtils.clamp((areaPx * 2.6 * Math.min(1.15, density)) / perDab, 60, 1200));
}

/**
 * Two views of a whole tree, side by side: [side | top]. The side view carries
 * the species silhouette for ground-level distance; the top view is what an
 * aerial camera sees. The two are cross-faded in the shader by the view's
 * elevation angle, so neither is ever visible edge-on as a flat card.
 *
 * The thing that makes an impostor read as a *tree* rather than a green ball
 * at 300 m is, in order: a visible trunk and crown base; an outline that
 * follows the species' crown envelope and is notched at clump scale; and
 * baked form lighting with genuine shadow underneath.
 */
export function impostorTexture(sp: Species, tile: number, aniso: number): THREE.Texture {
  const { c, g } = surface(tile * 2, tile);
  const r = rand(Math.round(sp.height * 3733 + sp.spread * 65537 + sp.name.length * 77));
  g.clearRect(0, 0, tile * 2, tile);

  const leafFill = (v: number): string => {
    const cr = Math.round(255 * Math.min(1, v));
    const cg = Math.round(255 * Math.min(1, v * 1.02));
    const cb = Math.round(255 * Math.min(1, v * 0.9));
    return `rgb(${cr},${cg},${cb})`;
  };

  // ---- side view -----------------------------------------------------------
  const base = tile * 0.995;
  const top = tile * 0.015;
  const H = base - top;
  const cx = tile * 0.5;
  // The crown fills the tile width; the billboard quad is `spread` wide, so
  // the two agree and the tree is neither pinched nor clipped.
  const halfW = tile * 0.5 * 0.96;
  const cb = sp.crownBase;
  const crownTop = base - H;

  // Trunk: tapered, flared at the root, carried up to the crown base and a
  // little beyond. Drawn as a filled shape so the taper is real.
  const rBase = Math.max(1.6, tile * sp.trunkRadius * 2.1);
  const trunkTop = base - H * (cb * 0.96 + (sp.conifer ? 0.55 : 0.12));
  g.fillStyle = 'rgba(78,68,56,1)';
  g.beginPath();
  g.moveTo(cx - rBase * 1.5, base);
  g.quadraticCurveTo(cx - rBase * 0.95, base - H * cb * 0.35, cx - rBase * 0.5, trunkTop);
  g.lineTo(cx + rBase * 0.5, trunkTop);
  g.quadraticCurveTo(cx + rBase * 0.95, base - H * cb * 0.35, cx + rBase * 1.5, base);
  g.closePath();
  g.fill();

  // Primary limbs, following the crown envelope so the armature and the leaf
  // mass agree.
  g.strokeStyle = 'rgba(74,64,52,1)';
  g.lineCap = 'round';
  const limbs = Math.max(3, sp.limbs);
  for (let i = 0; i < limbs; i++) {
    const side = i % 2 ? 1 : -1;
    const t = 0.12 + 0.72 * (i / limbs);
    const y0 = base - H * (cb * (sp.conifer ? 0.3 : 0.92) + t * 0.18);
    const rr = crownRadius(sp.shape, t) * halfW;
    g.lineWidth = Math.max(1.0, rBase * (1.05 - 0.55 * t));
    g.beginPath();
    g.moveTo(cx + side * rBase * 0.2, y0);
    g.quadraticCurveTo(
      cx + side * rr * 0.35, y0 - H * (1 - cb) * 0.18,
      cx + side * rr * 0.86, base - H * (cb + (1 - cb) * Math.min(0.98, t + 0.22)),
    );
    g.stroke();
  }

  // Leaf mass: clumps laid over the crown envelope, with the dab radius set
  // in *metres* so a 24 m elm is not built from the same size of clump as a
  // 9 m cherry.
  //
  // The horizontal placement is uniform across the envelope's *width*, which
  // is the distribution that gives a uniform projected density — a crown
  // seen from 300 m is opaque through the middle, where the line of sight
  // crosses the most leaf. The sqrt() that used to be here is the
  // uniform-over-a-*disc* rule, which for a side elevation piles everything
  // on the rim and leaves a hole down the axis; the Emerald Necklace read as
  // a row of green horseshoes because of it.
  const clumpM = 0.85;
  const dabPx = Math.max(2.0, (clumpM / sp.height) * H);
  const crownArea = 2 * halfW * H * (1 - cb) * meanCrownRadius(sp);
  const dabs = dabsToCover(crownArea, dabPx, sp.density);
  interface Blob { x: number; y: number; s: number; v: number }
  const blobs: Blob[] = [];
  for (let i = 0; i < dabs; i++) {
    const t = Math.pow(r(), 0.8);
    const rr = crownRadius(sp.shape, t);
    const u = r() * 2 - 1;
    const q = u * rr;
    const x = cx + q * halfW;
    const y = base - H * (cb + (1 - cb) * t);
    const s = dabPx * (0.72 + r() * 0.66) * (sp.conifer ? 0.85 : 1);
    // Bake form: brighter up and to the left, deep shade underneath, and the
    // core of the crown darker than its rim.
    const lift = 0.40 + 0.60 * t;
    const sideLight = 0.86 + 0.26 * (0.5 - u * 0.5);
    const core = 0.80 + 0.28 * Math.abs(u);
    // 0.72 keeps the brightest clump just under white. The shader divides the
    // whole map through by its own mean before it applies the species tint
    // (see `uMapMean`), so clipping here buys no brightness at all — it only
    // flattens the sunlit shoulder of the crown into a blank patch.
    blobs.push({ x, y, s, v: lift * sideLight * core * (0.82 + r() * 0.30) * 0.72 });
  }
  // Darkest first, so the lit rim overdraws the shaded interior rather than
  // being buried under whatever happened to come last.
  blobs.sort((p, q2) => p.v - q2.v);
  for (const bl of blobs) {
    dab(g, bl.x, bl.y, bl.s * (sp.conifer ? 0.9 : 1.2), bl.s * 0.8, r, leafFill(bl.v));
  }
  void crownTop;

  // ---- top view ------------------------------------------------------------
  const tx = tile * 1.5;
  const ty = tile * 0.5;
  const tr = tile * 0.48;
  const topDabPx = Math.max(2.0, (clumpM / (sp.spread * sp.height)) * tile);
  const topDabs = dabsToCover(Math.PI * tr * tr, topDabPx, sp.density);
  // A crown from above is a lobed dome, not a disc: limb masses with shallow
  // bays between them. The modulation is continuous in angle rather than a
  // set of hard sectors, because a sector boundary is a straight radial step
  // and at the five or six pixels an impostor covers from 2 km a step reads
  // as a bite out of the tree.
  const lobeN = 3 + Math.floor(r() * 3);
  const lobeA = r() * Math.PI * 2;
  const lobeB = r() * Math.PI * 2;
  const lobeAt = (a: number): number =>
    0.86 + 0.14 * Math.sin(a * lobeN + lobeA) + 0.07 * Math.sin(a * (lobeN * 2 + 1) + lobeB);
  const tops: { x: number; y: number; s: number; v: number }[] = [];
  for (let i = 0; i < topDabs; i++) {
    const a = r() * Math.PI * 2;
    const q = Math.sqrt(r()) * lobeAt(a);
    const x = tx + Math.cos(a) * q * tr;
    const y = ty + Math.sin(a) * q * tr;
    const s = topDabPx * (0.72 + r() * 0.66);
    // Lit from the same side as the side view; the far rim falls away.
    const lift = 1.00 - 0.30 * q + 0.16 * (Math.cos(a) * -0.5 - Math.sin(a) * 0.5);
    tops.push({ x, y, s, v: lift * (0.78 + r() * 0.36) * 0.74 });
  }
  tops.sort((p, q2) => p.v - q2.v);
  for (const bl of tops) dab(g, bl.x, bl.y, bl.s * 1.1, bl.s, r, leafFill(bl.v));

  const t = tex(c, true, aniso);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// Ground cover
// ---------------------------------------------------------------------------

/**
 * Width of one grass card in metres. `GroundCover` scales its instances to the
 * same number, so the blades drawn here land at a real blade's width on screen.
 */
export const GRASS_CARD = 0.40;

/**
 * A tuft of grass blades filling the tile, attached along the bottom edge.
 * `tileMeters` sets the blade width, and a card whose "blades" are 40 mm wide
 * reads as reeds. A park's coarse ryegrass/fescue sward runs 5-7 mm across,
 * near the top of the range for turf, because the thinner it is authored the
 * more of it the mip chain and the alpha test throw away: at 3.8 mm the blades
 * came out a pixel and a half wide on screen and the lawn read as bare paint.
 */
export function grassTexture(size: number, aniso: number, tileMeters = GRASS_CARD): THREE.Texture {
  const { c, g } = surface(size, size);
  const r = rand(90210);
  g.clearRect(0, 0, size, size);
  g.lineCap = 'round';
  const bladeW = Math.max(1.4, (0.0060 / tileMeters) * size);
  const blades = 150;
  for (let i = 0; i < blades; i++) {
    const x0 = size * (0.04 + r() * 0.92);
    const h = size * (0.34 + r() * 0.62);
    const lean = (r() - 0.5) * size * 0.42 * (0.4 + h / size);
    const v = 0.40 + r() * 0.56;
    g.strokeStyle = `rgb(${Math.round(226 * v)},${Math.round(255 * v)},${Math.round(184 * v)})`;
    g.lineWidth = bladeW * (0.7 + r() * 0.7);
    g.beginPath();
    g.moveTo(x0, size);
    // A real blade is straight for most of its length and folds near the tip.
    g.quadraticCurveTo(x0 + lean * 0.18, size - h * 0.62, x0 + lean, size - h);
    g.stroke();
  }
  // A few broadleaf weeds and clover rosettes at the base: no lawn is a
  // monoculture, least of all a public park's.
  for (let i = 0; i < 26; i++) {
    const x = size * (0.06 + r() * 0.88);
    const y = size * (0.72 + r() * 0.27);
    const s = size * (0.05 + r() * 0.05);
    const v = 0.38 + r() * 0.34;
    g.fillStyle = `rgb(${Math.round(210 * v)},${Math.round(255 * v)},${Math.round(180 * v)})`;
    for (let k = 0; k < 3; k++) {
      g.save();
      g.translate(x, y);
      g.rotate((k / 3) * Math.PI * 2 + r());
      g.beginPath();
      g.ellipse(0, -s * 0.5, s * 0.34, s * 0.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  // Roots in shade.
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, size * 0.3);
  shade.addColorStop(0, 'rgba(20,28,14,0.66)');
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
  // A clipped hedge unit is ~1.2 m of card and its leaves are 25-40 mm.
  const leafPx = Math.max(3, size * 0.032);
  const n = 900;
  for (let i = 0; i < n; i++) {
    const a = (r() - 0.5) * 2.5;
    const d = Math.pow(r(), 0.55) * size * 0.66;
    const x = size * 0.5 + Math.sin(a) * d * 0.92;
    const y = size - Math.cos(a) * d;
    if (y < 0) continue;
    const v = 0.40 + r() * 0.56;
    g.save();
    g.translate(x, y);
    g.rotate(a + (r() - 0.5) * 1.6);
    g.fillStyle = `rgb(${Math.round(236 * v)},${Math.round(255 * v)},${Math.round(206 * v)})`;
    ovatePath(g, leafPx * (0.7 + r() * 0.7));
    g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, size, 0, 0);
  shade.addColorStop(0, 'rgba(16,24,12,0.66)');
  shade.addColorStop(0.55, 'rgba(20,28,14,0.18)');
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
  clump: THREE.Texture[];
  bark: Map<BarkKind, THREE.Texture>;
  impostor: THREE.Texture[];
  grass: THREE.Texture;
  shrub: THREE.Texture;
  /** Physical size of a mid-tier clump card, metres, per species. */
  clumpMeters: number[];
  /** Mean linear luminance of each map. See `mapMean`. */
  mean: {
    leaf: number[];
    clump: number[];
    bark: Map<BarkKind, number>;
    impostor: number[];
    grass: number;
    shrub: number;
  };
}

const BARK_KINDS: BarkKind[] = ['ridged', 'plated', 'lenticel', 'mottled'];

export function buildTextures(
  species: Species[], aniso: number, hiRes: boolean, clumpMeters: number[],
): VegTextures {
  const leafSize = hiRes ? 512 : 256;
  const clumpSize = hiRes ? 512 : 256;
  const barkSize = hiRes ? 512 : 256;
  const impSize = hiRes ? 256 : 128;
  const bark = new Map<BarkKind, THREE.Texture>();
  for (const k of BARK_KINDS) bark.set(k, barkTexture(k, barkSize, aniso));
  const leaf = species.map((s) => foliageCardTexture(s, leafSize, aniso));
  const clump = species.map((s, i) => foliageClumpTexture(s, clumpSize, aniso, clumpMeters[i]));
  const impostor = species.map((s) => impostorTexture(s, impSize, aniso));
  const grass = grassTexture(hiRes ? 512 : 256, aniso);
  const shrub = shrubTexture(hiRes ? 512 : 256, aniso);
  const barkMean = new Map<BarkKind, number>();
  for (const [k, t] of bark) barkMean.set(k, mapMean(t));
  return {
    leaf,
    clump,
    bark,
    impostor,
    grass,
    shrub,
    clumpMeters,
    mean: {
      leaf: leaf.map(mapMean),
      clump: clump.map(mapMean),
      bark: barkMean,
      impostor: impostor.map(mapMean),
      grass: mapMean(grass),
      shrub: mapMean(shrub),
    },
  };
}

export function disposeTextures(t: VegTextures | undefined): void {
  if (!t) return;
  for (const x of t.leaf) x.dispose();
  for (const x of t.clump) x.dispose();
  for (const x of t.bark.values()) x.dispose();
  for (const x of t.impostor) x.dispose();
  t.grass.dispose();
  t.shrub.dispose();
}

/** Only needed by the crown-shape helper; kept here so callers see one seed API. */
export type { CrownShape };
