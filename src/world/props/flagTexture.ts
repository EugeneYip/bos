/**
 * The flag of the United States, drawn procedurally.
 *
 * Proportions are Executive Order 10834's, expressed as fractions of the hoist
 * (the short side) so the whole thing scales from one number:
 *
 *   hoist            A = 1.0        fly              B = 1.9
 *   union hoist      C = 7/13       union fly        D = 0.76
 *   star rows        E = F = 0.054  star columns     G = H = 0.063
 *   star diameter    K = 0.0616     stripe           L = 1/13
 *
 * Thirteen stripes, red at the top and red at the bottom; the union spans the
 * upper seven of them and two fifths of the length; nine rows of stars
 * alternating six and five, which is fifty.
 *
 * Laid out with the union at the top left and the fly to the right, which is
 * the obverse. `flagCloth` maps the hoist edge to the staff, so a flag on an
 * angled facade staff puts the union at the peak (as the flag code asks) and
 * the reverse side comes out mirrored for free — a flag is one piece of cloth,
 * not two printed faces.
 */
import * as THREE from 'three';

/** Fly / hoist. Every flag in the city is built from this. */
export const FLAG_RATIO = 1.9;

const RED = '#b22234';   // Old Glory Red, cable no. 70180
const WHITE = '#ffffff';
const BLUE = '#3c3b6e';  // Old Glory Blue, cable no. 70075

/** One five-pointed star, point up, centred on (cx, cy) with circumradius r. */
function star(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const inner = r * 0.38197; // 1/phi^2 — the pentagram's inner radius
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : inner;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

/**
 * Fine multiplicative grain plus a warp/weft suggestion. Without it the flag
 * reads as vector art: flat fields of three colours, which at close range is
 * the difference between bunting and a printed sign.
 */
function weave(g: CanvasRenderingContext2D, w: number, h: number): void {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 4096) / 4096;
  };
  for (let y = 0; y < h; y++) {
    // Weft: a faint horizontal banding at the thread pitch.
    const weft = 1 + 0.018 * Math.sin(y * 1.9) + 0.012 * Math.sin(y * 0.41 + 1.1);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const warp = 1 + 0.016 * Math.sin(x * 2.1 + y * 0.3);
      const k = weft * warp * (0.972 + 0.056 * rnd());
      d[i] = Math.min(255, d[i] * k);
      d[i + 1] = Math.min(255, d[i + 1] * k);
      d[i + 2] = Math.min(255, d[i + 2] * k);
    }
  }
  g.putImageData(img, 0, 0);
}

/**
 * @param hoistPx pixels across the hoist; the canvas is 1.9x that on the fly.
 */
export function usFlagTexture(hoistPx = 640, anisotropy = 8): THREE.Texture {
  const H = hoistPx;
  const W = Math.round(H * FLAG_RATIO);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  // --- thirteen stripes, red first and last -------------------------------
  const L = H / 13;
  g.fillStyle = WHITE;
  g.fillRect(0, 0, W, H);
  g.fillStyle = RED;
  for (let i = 0; i < 13; i += 2) {
    // Round to whole pixels so no stripe picks up a seam from antialiasing.
    const y0 = Math.round(i * L);
    const y1 = Math.round((i + 1) * L);
    g.fillRect(0, y0, W, y1 - y0);
  }

  // --- the union: seven stripes tall, two fifths of the fly ---------------
  const uw = 0.76 * H;
  const uh = (7 / 13) * H;
  g.fillStyle = BLUE;
  g.fillRect(0, 0, Math.round(uw), Math.round(uh));

  // --- fifty stars, nine rows of six and five ----------------------------
  const step = 0.063 * H;
  const rowStep = 0.054 * H;
  const r = (0.0616 * H) / 2;
  g.fillStyle = WHITE;
  for (let row = 0; row < 9; row++) {
    const cy = rowStep + row * rowStep;
    const cols = row % 2 === 0 ? 6 : 5;
    for (let k = 0; k < cols; k++) {
      const col = row % 2 === 0 ? k * 2 : k * 2 + 1;
      star(g, step + col * step, cy, r);
    }
  }

  weave(g, W, H);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.max(1, anisotropy);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.name = 'flag:us';
  t.needsUpdate = true;
  return t;
}
