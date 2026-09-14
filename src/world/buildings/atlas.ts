/**
 * Procedural facade / roof texture atlas.
 *
 * Everything the city's shell renders with lives in two `DataArrayTexture`s, so
 * one material can draw every building in a tile in a single call:
 *
 *   `albedo`   rgb = neutral detail colour (sRGB), a = how strongly the
 *              per-building tint applies (mortar and glass stay un-tinted)
 *   `surface`  rg  = tangent-space normal xy, b = roughness, a = recess depth
 *
 * Layer layout is fixed (see `LAYER`), because the shader picks between the
 * ground-floor, upper-floor and crown layer of a family per *fragment* from the
 * wall's vertical UV. That is what lets a wall be a single quad and still have
 * a taller glazed ground floor, correct floor lines, and a cornice.
 *
 * Tiles are authored in metres: a field tile is `refBay * BAYS` wide and
 * `refFloor` tall for its family, so brick courses, mullion spacing and window
 * proportions are physically sized and line up across neighbouring buildings.
 */
import * as THREE from 'three';
import type { BuildingMaterial } from '../../core/types';
import { mulberry32 } from './rng';

/** Bays across one field/ground tile. */
export const BAYS = 3;

export const FAMILIES: BuildingMaterial[] = [
  'brick', 'brownstone', 'stone', 'concrete', 'glass', 'metal', 'wood', 'plaster',
];

export const FAMILY_INDEX: Record<BuildingMaterial, number> = {
  brick: 0, brownstone: 1, stone: 2, concrete: 3, glass: 4, metal: 5, wood: 6, plaster: 7,
};

/** Physical tile metrics per family, metres. */
export const REF_BAY: number[] = [3.05, 3.25, 3.6, 3.4, 1.62, 2.9, 2.75, 3.0];
export const REF_FLOOR: number[] = [3.35, 3.5, 3.9, 3.55, 3.85, 3.6, 3.05, 3.3];
export const REF_GROUND: number[] = [4.5, 4.3, 5.2, 4.6, 4.9, 4.4, 3.4, 4.2];
/** Crown band height in floor units (matches the shader constant). */
export const CROWN_FRAC = 0.42;

/** Layer indices. Field layers are 0..7 so `familyIndex` doubles as the layer. */
export const LAYER = {
  field: [0, 1, 2, 3, 4, 5, 6, 7],
  ground: [8, 9, 10, 11, 12, 13, 14, 15],
  crown: [16, 17, 18, 19, 20, 21, 22, 23],
  roofTar: 24,
  roofGravel: 25,
  roofShingle: 26,
  roofSlate: 27,
  roofSeam: 28,
  roofTile: 29,
  clutterMetal: 30,
  clutterPaint: 31,
} as const;

export const LAYER_COUNT = 32;

export interface FacadeAtlas {
  albedo: THREE.DataArrayTexture;
  surface: THREE.DataArrayTexture;
  width: number;
  height: number;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Painter — draws the same shapes into the albedo and the aux (tint/rough/depth)
// buffer at once, in metres.
// ---------------------------------------------------------------------------

interface Style {
  /** sRGB css colour of the detail layer. */
  c: string;
  /** 0 = keep the authored colour, 1 = fully take the building tint. */
  tint: number;
  rough: number;
  /** 0 = flush with the outer surface, 1 = deepest recess. */
  depth: number;
}

class Painter {
  readonly a: CanvasRenderingContext2D;
  readonly b: CanvasRenderingContext2D;
  /** pixels per metre, horizontal and vertical. */
  px = 1;
  py = 1;
  constructor(
    readonly w: number,
    readonly h: number,
    a: CanvasRenderingContext2D,
    b: CanvasRenderingContext2D,
  ) {
    this.a = a;
    this.b = b;
  }

  /** Configure the metre grid: tile covers `wm` x `hm` metres. */
  metrics(wm: number, hm: number): void {
    this.px = this.w / wm;
    this.py = this.h / hm;
  }

  /** v is 0 at the bottom of the tile; canvas y grows down. */
  Y(v: number): number {
    return (1 - v) * this.h;
  }

  style(s: Style): void {
    this.a.fillStyle = s.c;
    this.a.strokeStyle = s.c;
    const bs = `rgb(${Math.round(Math.min(1, Math.max(0, s.tint)) * 255)},${Math.round(
      Math.min(1, Math.max(0, s.rough)) * 255,
    )},${Math.round(Math.min(1, Math.max(0, s.depth)) * 255)})`;
    this.b.fillStyle = bs;
    this.b.strokeStyle = bs;
  }

  fill(x: number, y: number, w: number, h: number): void {
    this.a.fillRect(x, y, w, h);
    this.b.fillRect(x, y, w, h);
  }

  /** Fill wrapping horizontally so tiles stay seamless. */
  fillWrap(x: number, y: number, w: number, h: number): void {
    this.fill(x, y, w, h);
    if (x < 0) this.fill(x + this.w, y, w, h);
    if (x + w > this.w) this.fill(x - this.w, y, w, h);
  }

  clear(s: Style): void {
    this.style(s);
    this.fill(0, 0, this.w, this.h);
  }

  /** Albedo-only overlay (shading, grime, gradients). */
  shade(x: number, y: number, w: number, h: number, css: string, alpha: number): void {
    this.a.save();
    this.a.globalAlpha = alpha;
    this.a.fillStyle = css;
    this.a.fillRect(x, y, w, h);
    this.a.restore();
  }

  grad(x: number, y: number, w: number, h: number, stops: Array<[number, string]>, alpha = 1): void {
    const g = this.a.createLinearGradient(x, y, x, y + h);
    for (const [t, c] of stops) g.addColorStop(t, c);
    this.a.save();
    this.a.globalAlpha = alpha;
    this.a.fillStyle = g;
    this.a.fillRect(x, y, w, h);
    this.a.restore();
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): void {
    for (const c of [this.a, this.b]) {
      c.beginPath();
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  poly(pts: number[]): void {
    for (const c of [this.a, this.b]) {
      c.beginPath();
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.closePath();
      c.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Shared masonry / cladding patterns
// ---------------------------------------------------------------------------

const hex = (r: number, g: number, b: number): string =>
  `rgb(${Math.round(Math.max(0, Math.min(255, r)))},${Math.round(Math.max(0, Math.min(255, g)))},${Math.round(
    Math.max(0, Math.min(255, b)),
  )})`;

interface MasonryOpts {
  unitW: number;
  unitH: number;
  joint: number;
  base: [number, number, number];
  jitter: number;
  hueJitter: number;
  mortar: [number, number, number];
  rough: number;
  faceDepth: number;
  jointDepth: number;
  /** 0 = stack bond, 0.5 = running bond. */
  offset: number;
  tint: number;
}

function masonry(p: Painter, rnd: () => number, o: MasonryOpts): void {
  const uw = o.unitW * p.px;
  const uh = o.unitH * p.py;
  const jx = o.joint * p.px;
  const jy = o.joint * p.py;

  // mortar bed
  p.style({ c: hex(o.mortar[0], o.mortar[1], o.mortar[2]), tint: o.tint * 0.28, rough: 0.92, depth: o.jointDepth });
  p.fill(0, 0, p.w, p.h);

  const rows = Math.max(1, Math.round(p.h / uh));
  const rh = p.h / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    const shift = (r % 2) * o.offset * uw + (rnd() - 0.5) * uw * 0.06;
    const cols = Math.max(1, Math.round(p.w / uw));
    const cw = p.w / cols;
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + shift;
      const l = o.base[0] + (rnd() - 0.5) * o.jitter;
      const hj = (rnd() - 0.5) * o.hueJitter;
      p.style({
        c: hex(l + hj, o.base[1] + (rnd() - 0.5) * o.jitter, o.base[2] - hj * 0.6 + (rnd() - 0.5) * o.jitter),
        tint: o.tint,
        rough: o.rough + (rnd() - 0.5) * 0.12,
        depth: o.faceDepth + (rnd() - 0.5) * 0.012,
      });
      p.fillWrap(x + jx * 0.5, y + jy * 0.5, cw - jx, rh - jy);
    }
  }
}

function clapboard(p: Painter, rnd: () => number, base: [number, number, number], tint: number): void {
  const lap = 0.14 * p.py;
  const rows = Math.max(2, Math.round(p.h / lap));
  const rh = p.h / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    const v = (rnd() - 0.5) * 7;
    p.style({ c: hex(base[0] + v, base[1] + v, base[2] + v), tint, rough: 0.62, depth: 0.1 });
    p.fill(0, y, p.w, rh);
    // shadow line under each lap
    p.style({ c: hex(base[0] * 0.72, base[1] * 0.72, base[2] * 0.74), tint: tint * 0.8, rough: 0.7, depth: 0.2 });
    p.fill(0, y + rh - Math.max(1, rh * 0.17), p.w, Math.max(1, rh * 0.17));
  }
}

function stucco(p: Painter, rnd: () => number, base: [number, number, number], tint: number, rough: number): void {
  p.style({ c: hex(base[0], base[1], base[2]), tint, rough, depth: 0.1 });
  p.fill(0, 0, p.w, p.h);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    const r = 1 + rnd() * 3.2;
    const d = (rnd() - 0.5) * 16;
    p.style({ c: hex(base[0] + d, base[1] + d, base[2] + d), tint, rough: rough + (rnd() - 0.5) * 0.1, depth: 0.1 + d * 0.0016 });
    p.ellipse(x, y, r, r * 0.85);
  }
}

function precast(p: Painter, rnd: () => number, base: [number, number, number], tint: number): void {
  p.style({ c: hex(base[0], base[1], base[2]), tint, rough: 0.76, depth: 0.1 });
  p.fill(0, 0, p.w, p.h);
  // board-form horizontal grain
  const bw = 0.22 * p.py;
  for (let y = 0; y < p.h; y += bw) {
    const d = (rnd() - 0.5) * 9;
    p.style({ c: hex(base[0] + d, base[1] + d, base[2] + d), tint, rough: 0.78, depth: 0.1 });
    p.fill(0, y, p.w, bw * 0.92);
    p.style({ c: hex(base[0] * 0.85, base[1] * 0.85, base[2] * 0.86), tint, rough: 0.8, depth: 0.14 });
    p.fill(0, y + bw * 0.92, p.w, Math.max(1, bw * 0.08));
  }
  // panel joints every bay
  const panel = p.w / BAYS;
  p.style({ c: hex(base[0] * 0.7, base[1] * 0.7, base[2] * 0.72), tint, rough: 0.82, depth: 0.3 });
  for (let i = 0; i < BAYS; i++) p.fill(i * panel - 1.2, 0, 2.4, p.h);
  // tie-rod dimples
  for (let i = 0; i < 26; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    p.style({ c: hex(base[0] * 0.82, base[1] * 0.82, base[2] * 0.84), tint, rough: 0.8, depth: 0.26 });
    p.ellipse(x, y, 2.2, 2.2);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface WinOpts {
  /** rect in canvas pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'punched' masonry opening, 'curtain' glazed panel, 'sash' timber */
  kind: 'punched' | 'curtain' | 'sash' | 'strip';
  frame: [number, number, number];
  /** protruding stone sill */
  sill: boolean;
  arch: boolean;
  muntinsX: number;
  muntinsY: number;
  rnd: () => number;
}

/** Glass is authored dark, very smooth and deeply recessed; the shader turns
 *  `depth > ~0.6` into the metallic/emissive window mask. */
function glassFill(p: Painter, x: number, y: number, w: number, h: number, rnd: () => number): void {
  p.style({ c: hex(38, 48, 58), tint: 0.12, rough: 0.05, depth: 0.86 });
  p.fill(x, y, w, h);
  // sky gradient reflection baked faintly in so glass never reads as a black hole
  p.grad(x, y, w, h, [
    [0, 'rgb(150,178,205)'],
    [0.42, 'rgb(86,108,130)'],
    [0.55, 'rgb(46,58,70)'],
    [1, 'rgb(30,38,47)'],
  ], 0.85);
  // occasional blind / curtain
  const r = rnd();
  if (r < 0.3) {
    const dh = h * (0.25 + rnd() * 0.45);
    p.style({ c: hex(176, 170, 158), tint: 0.1, rough: 0.75, depth: 0.72 });
    p.fill(x, y, w, dh);
  } else if (r < 0.42) {
    p.style({ c: hex(120, 112, 104), tint: 0.1, rough: 0.7, depth: 0.72 });
    p.fill(x, y + h * 0.55, w, h * 0.45);
  }
}

function drawWindow(p: Painter, o: WinOpts): void {
  const { x, y, w, h, rnd } = o;
  if (w < 3 || h < 3) return;
  const fw = Math.max(1.4, 0.055 * p.px);

  if (o.kind === 'curtain' || o.kind === 'strip') {
    // mullion frame, flush-ish, glazing behind
    p.style({ c: hex(o.frame[0], o.frame[1], o.frame[2]), tint: 0.08, rough: 0.34, depth: 0.42 });
    p.fill(x, y, w, h);
    const gx = x + fw;
    const gy = y + fw;
    const gw = w - fw * 2;
    const gh = h - fw * 2;
    const cols = Math.max(1, o.muntinsX);
    const rows = Math.max(1, o.muntinsY);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = gx + (gw / cols) * c + fw * 0.4;
        const cy = gy + (gh / rows) * r + fw * 0.4;
        glassFill(p, cx, cy, gw / cols - fw * 0.8, gh / rows - fw * 0.8, rnd);
      }
    }
    return;
  }

  // masonry opening: reveal -> frame -> glass
  const rev = Math.max(1.2, 0.1 * p.px);

  if (o.arch) {
    const r = w * 0.5;
    p.style({ c: hex(o.frame[0] * 0.55, o.frame[1] * 0.55, o.frame[2] * 0.56), tint: 0.2, rough: 0.8, depth: 0.5 });
    p.a.beginPath();
    p.b.beginPath();
    for (const c of [p.a, p.b]) {
      c.beginPath();
      c.moveTo(x, y + h);
      c.lineTo(x, y + r);
      c.arc(x + r, y + r, r, Math.PI, 0);
      c.lineTo(x + w, y + h);
      c.closePath();
      c.fill();
    }
  } else {
    p.style({ c: hex(o.frame[0] * 0.5, o.frame[1] * 0.5, o.frame[2] * 0.52), tint: 0.2, rough: 0.82, depth: 0.5 });
    p.fill(x, y, w, h);
  }

  // sash frame
  const ix = x + rev;
  const iy = y + rev * (o.arch ? 1.9 : 1);
  const iw = w - rev * 2;
  const ih = h - rev * (o.arch ? 2.9 : 2);
  if (iw < 2 || ih < 2) return;
  p.style({ c: hex(o.frame[0], o.frame[1], o.frame[2]), tint: 0.07, rough: 0.4, depth: 0.6 });
  p.fill(ix, iy, iw, ih);

  const cols = Math.max(1, o.muntinsX);
  const rows = Math.max(1, o.muntinsY);
  const pad = fw;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cw = (iw - pad) / cols - pad;
      const ch = (ih - pad) / rows - pad;
      if (cw < 1 || ch < 1) continue;
      glassFill(p, ix + pad + ((iw - pad) / cols) * c, iy + pad + ((ih - pad) / rows) * r, cw, ch, rnd);
    }
  }

  if (o.sill) {
    const sh = Math.max(1.5, 0.09 * p.py);
    const over = Math.max(1.5, 0.07 * p.px);
    p.style({ c: hex(212, 208, 198), tint: 0.18, rough: 0.66, depth: 0.0 });
    p.fill(x - over, y + h - sh * 0.35, w + over * 2, sh);
    // shadow the sill casts on the wall below
    p.shade(x - over, y + h + sh * 0.6, w + over * 2, sh * 1.4, '#000', 0.13);
  }
}

// ---------------------------------------------------------------------------
// Layer painters
// ---------------------------------------------------------------------------

type LayerFn = (p: Painter, rnd: () => number) => void;

interface FamilySpec {
  wall(p: Painter, rnd: () => number): void;
  windowKind: WinOpts['kind'];
  frame: [number, number, number];
  arch: boolean;
  sill: boolean;
  mx: number;
  my: number;
  /** window opening as a fraction of the bay / floor */
  wFrac: number;
  top: number;
  bottom: number;
  trim: [number, number, number];
  glazedGround: boolean;
}

function familySpec(fi: number): FamilySpec {
  switch (fi) {
    case 0: // brick
      return {
        wall: (p, r) => masonry(p, r, {
          unitW: 0.205, unitH: 0.072, joint: 0.012, base: [228, 223, 216], jitter: 26, hueJitter: 10,
          mortar: [206, 202, 193], rough: 0.86, faceDepth: 0.1, jointDepth: 0.155, offset: 0.5, tint: 1,
        }),
        windowKind: 'sash', frame: [232, 230, 224], arch: false, sill: true, mx: 2, my: 3,
        wFrac: 0.44, top: 0.78, bottom: 0.18, trim: [214, 209, 199], glazedGround: false,
      };
    case 1: // brownstone
      return {
        wall: (p, r) => masonry(p, r, {
          unitW: 0.62, unitH: 0.3, joint: 0.014, base: [224, 219, 212], jitter: 14, hueJitter: 7,
          mortar: [204, 199, 190], rough: 0.8, faceDepth: 0.1, jointDepth: 0.15, offset: 0.5, tint: 1,
        }),
        windowKind: 'sash', frame: [226, 224, 218], arch: true, sill: true, mx: 2, my: 3,
        wFrac: 0.42, top: 0.82, bottom: 0.16, trim: [206, 200, 190], glazedGround: false,
      };
    case 2: // stone / granite
      return {
        wall: (p, r) => masonry(p, r, {
          unitW: 0.92, unitH: 0.44, joint: 0.016, base: [231, 229, 223], jitter: 12, hueJitter: 5,
          mortar: [212, 210, 204], rough: 0.72, faceDepth: 0.1, jointDepth: 0.16, offset: 0.5, tint: 1,
        }),
        windowKind: 'sash', frame: [216, 214, 208], arch: false, sill: true, mx: 3, my: 3,
        wFrac: 0.46, top: 0.8, bottom: 0.16, trim: [222, 220, 214], glazedGround: false,
      };
    case 3: // concrete
      return {
        wall: (p, r) => precast(p, r, [225, 224, 219], 1),
        windowKind: 'strip', frame: [128, 130, 132], arch: false, sill: false, mx: 2, my: 2,
        wFrac: 0.66, top: 0.8, bottom: 0.2, trim: [206, 205, 200], glazedGround: true,
      };
    case 4: // glass curtain wall
      return {
        wall: (p, r) => {
          p.style({ c: hex(150, 154, 158), tint: 0.5, rough: 0.3, depth: 0.12 });
          p.fill(0, 0, p.w, p.h);
          for (let i = 0; i < 200; i++) {
            const d = (r() - 0.5) * 10;
            p.style({ c: hex(150 + d, 154 + d, 158 + d), tint: 0.5, rough: 0.3, depth: 0.12 });
            p.ellipse(r() * p.w, r() * p.h, 2 + r() * 4, 2 + r() * 3);
          }
        },
        windowKind: 'curtain', frame: [118, 122, 126], arch: false, sill: false, mx: 1, my: 2,
        wFrac: 0.95, top: 0.98, bottom: 0.02, trim: [110, 114, 118], glazedGround: true,
      };
    case 5: // metal panel
      return {
        wall: (p, r) => {
          p.style({ c: hex(214, 216, 218), tint: 1, rough: 0.42, depth: 0.1 });
          p.fill(0, 0, p.w, p.h);
          const rib = 0.19 * p.px;
          for (let x = 0; x < p.w; x += rib) {
            p.style({ c: hex(196, 199, 202), tint: 1, rough: 0.4, depth: 0.2 });
            p.fill(x, 0, Math.max(1, rib * 0.16), p.h);
            p.style({ c: hex(232, 234, 236), tint: 1, rough: 0.36, depth: 0.04 });
            p.fill(x + rib * 0.42, 0, Math.max(1, rib * 0.16), p.h);
          }
          for (let i = 0; i < 40; i++) {
            const d = (r() - 0.5) * 10;
            p.shade(r() * p.w, r() * p.h, 8 + r() * 40, 4 + r() * 20, d > 0 ? '#fff' : '#000', 0.05);
          }
        },
        windowKind: 'strip', frame: [140, 143, 146], arch: false, sill: false, mx: 2, my: 1,
        wFrac: 0.7, top: 0.76, bottom: 0.24, trim: [190, 193, 196], glazedGround: true,
      };
    case 6: // wood clapboard (triple-deckers)
      return {
        wall: (p, r) => clapboard(p, r, [233, 231, 226], 1),
        windowKind: 'sash', frame: [246, 245, 242], arch: false, sill: true, mx: 2, my: 3,
        wFrac: 0.4, top: 0.8, bottom: 0.18, trim: [248, 247, 244], glazedGround: false,
      };
    default: // plaster / stucco
      return {
        wall: (p, r) => stucco(p, r, [232, 229, 223], 1, 0.84),
        windowKind: 'sash', frame: [238, 236, 231], arch: false, sill: true, mx: 2, my: 2,
        wFrac: 0.42, top: 0.8, bottom: 0.18, trim: [226, 223, 217], glazedGround: false,
      };
  }
}

/** Upper-floor field tile: BAYS windows, one storey tall, seamless on all edges. */
function paintField(fi: number): LayerFn {
  return (p, rnd) => {
    const s = familySpec(fi);
    s.wall(p, rnd);

    const bayW = p.w / BAYS;
    for (let i = 0; i < BAYS; i++) {
      const wW = bayW * s.wFrac;
      const wH = p.h * (s.top - s.bottom);
      const x = i * bayW + (bayW - wW) * 0.5;
      const y = p.Y(s.top);
      drawWindow(p, {
        x, y, w: wW, h: wH, kind: s.windowKind, frame: s.frame, sill: s.sill,
        arch: s.arch, muntinsX: s.mx, muntinsY: s.my, rnd,
      });
      // lintel over masonry openings
      if (s.windowKind === 'sash' && !s.arch) {
        p.style({ c: hex(s.trim[0], s.trim[1], s.trim[2]), tint: 0.25, rough: 0.7, depth: 0.02 });
        p.fill(x - 0.05 * p.px, y - 0.1 * p.py, wW + 0.1 * p.px, 0.1 * p.py);
      }
    }

    // string course at the floor line, and its cast shadow
    if (fi <= 2 || fi === 7) {
      const t = Math.max(1.5, 0.075 * p.py);
      p.style({ c: hex(s.trim[0], s.trim[1], s.trim[2]), tint: 0.3, rough: 0.72, depth: 0.0 });
      p.fill(0, p.h - t, p.w, t);
      p.shade(0, 0, p.w, Math.max(2, t * 1.6), '#000', 0.1);
    }

    // vertical grime streaks under sills
    for (let i = 0; i < 26; i++) {
      const x = rnd() * p.w;
      p.shade(x, rnd() * p.h * 0.5, 1 + rnd() * 5, p.h * (0.2 + rnd() * 0.6), '#3a342c', 0.035 + rnd() * 0.04);
    }
  };
}

/** Ground floor: taller, shopfronts or stoops, a heavier base. */
function paintGround(fi: number): LayerFn {
  return (p, rnd) => {
    const s = familySpec(fi);
    s.wall(p, rnd);

    const bayW = p.w / BAYS;
    const commercial = s.glazedGround || fi === 0 || fi === 2;

    // plinth / water table
    const plinth = 0.72 * p.py;
    p.style({ c: hex(198, 196, 190), tint: 0.35, rough: 0.78, depth: 0.02 });
    p.fill(0, p.h - plinth, p.w, plinth);
    p.shade(0, p.h - plinth, p.w, plinth, '#000', 0.12);

    if (commercial) {
      // storefront: full-height glazing between piers, signage band above
      const bandTop = 0.82;
      const bandH = 0.16;
      for (let i = 0; i < BAYS; i++) {
        const pier = bayW * 0.14;
        const x = i * bayW + pier;
        const w = bayW - pier * 2;
        const y = p.Y(bandTop - bandH);
        const h = p.Y(0.1) - y;
        drawWindow(p, {
          x, y, w, h, kind: 'curtain', frame: [92, 92, 94], sill: false, arch: false,
          muntinsX: 2, muntinsY: 1, rnd,
        });
        // recessed entry on one bay
        if (i === 1) {
          const dw = w * 0.3;
          p.style({ c: hex(70, 66, 62), tint: 0.1, rough: 0.5, depth: 0.75 });
          p.fill(x + w * 0.35, y + h * 0.42, dw, h * 0.58);
        }
        // awning on some bays
        if (rnd() < 0.4) {
          const ah = 0.34 * p.py;
          p.style({ c: hex(150, 60, 52), tint: 0.05, rough: 0.75, depth: 0.0 });
          p.fill(x - pier * 0.4, y - ah, w + pier * 0.8, ah);
          p.shade(x - pier * 0.4, y, w + pier * 0.8, ah * 0.7, '#000', 0.2);
        }
      }
      // signage band
      p.style({ c: hex(64, 62, 60), tint: 0.12, rough: 0.6, depth: 0.05 });
      p.fill(0, p.Y(bandTop), p.w, p.Y(bandTop - bandH) - p.Y(bandTop));
      for (let i = 0; i < BAYS; i++) {
        const cy = (p.Y(bandTop) + p.Y(bandTop - bandH)) * 0.5;
        p.style({ c: hex(226, 218, 200), tint: 0.05, rough: 0.55, depth: 0.02 });
        const lw = bayW * (0.2 + rnd() * 0.32);
        p.fill(i * bayW + (bayW - lw) * 0.5, cy - 0.06 * p.py, lw, 0.12 * p.py);
      }
    } else {
      // residential: stoop, tall parlour windows, basement lights
      for (let i = 0; i < BAYS; i++) {
        const wW = bayW * s.wFrac;
        const x = i * bayW + (bayW - wW) * 0.5;
        const y = p.Y(0.86);
        const h = p.Y(0.3) - y;
        if (i === 1) {
          // doorway
          p.style({ c: hex(s.trim[0], s.trim[1], s.trim[2]), tint: 0.25, rough: 0.66, depth: 0.0 });
          p.fill(x - 0.12 * p.px, y - 0.14 * p.py, wW + 0.24 * p.px, h + 0.16 * p.py);
          p.style({ c: hex(86, 62, 48), tint: 0.16, rough: 0.42, depth: 0.5 });
          p.fill(x, y, wW, h);
          // fanlight
          p.style({ c: hex(120, 140, 156), tint: 0.08, rough: 0.1, depth: 0.62 });
          p.fill(x + wW * 0.08, y + h * 0.04, wW * 0.84, h * 0.14);
          // door panels
          p.style({ c: hex(66, 48, 38), tint: 0.16, rough: 0.45, depth: 0.58 });
          p.fill(x + wW * 0.14, y + h * 0.26, wW * 0.72, h * 0.3);
          p.fill(x + wW * 0.14, y + h * 0.62, wW * 0.72, h * 0.3);
        } else {
          drawWindow(p, {
            x, y, w: wW, h, kind: s.windowKind, frame: s.frame, sill: s.sill,
            arch: s.arch, muntinsX: s.mx, muntinsY: 4, rnd,
          });
        }
      }
    }

    for (let i = 0; i < 22; i++) {
      p.shade(rnd() * p.w, p.h * (0.5 + rnd() * 0.5), 2 + rnd() * 9, p.h * 0.3 * rnd(), '#2e2a24', 0.05);
    }
  };
}

/** Crown band: cornice, frieze, parapet coping. Sits in the top of the wall. */
function paintCrown(fi: number): LayerFn {
  return (p, rnd) => {
    const s = familySpec(fi);
    s.wall(p, rnd);

    const heavy = fi <= 2 || fi === 7 || fi === 6;
    if (heavy) {
      // frieze
      p.style({ c: hex(s.trim[0], s.trim[1], s.trim[2]), tint: 0.3, rough: 0.7, depth: 0.06 });
      p.fill(0, p.Y(0.82), p.w, p.Y(0.3) - p.Y(0.82));
      // dentils
      const n = Math.round(p.w / (0.28 * p.px));
      const dw = p.w / n;
      p.style({ c: hex(s.trim[0] * 1.02, s.trim[1] * 1.02, s.trim[2] * 1.02), tint: 0.28, rough: 0.7, depth: 0.0 });
      for (let i = 0; i < n; i++) p.fill(i * dw + dw * 0.22, p.Y(0.62), dw * 0.56, p.Y(0.44) - p.Y(0.62));
      p.shade(0, p.Y(0.44), p.w, Math.max(2, 0.08 * p.py), '#000', 0.28);
      // projecting cornice slab
      p.style({ c: hex(s.trim[0] * 1.05, s.trim[1] * 1.05, s.trim[2] * 1.05), tint: 0.26, rough: 0.66, depth: 0.0 });
      p.fill(0, p.Y(1.0), p.w, p.Y(0.82) - p.Y(1.0));
      p.shade(0, p.Y(0.82), p.w, Math.max(2, 0.12 * p.py), '#000', 0.34);
      // shadow the cornice throws down the wall
      p.grad(0, p.Y(0.8), p.w, p.h * 0.32, [[0, 'rgba(0,0,0,0.34)'], [1, 'rgba(0,0,0,0)']], 1);
    } else {
      // modern parapet: coping band and a shadow reveal
      p.style({ c: hex(176, 178, 180), tint: 0.4, rough: 0.55, depth: 0.0 });
      p.fill(0, p.Y(1.0), p.w, p.Y(0.7) - p.Y(1.0));
      p.shade(0, p.Y(0.7), p.w, Math.max(2, 0.1 * p.py), '#000', 0.3);
      p.style({ c: hex(96, 98, 100), tint: 0.25, rough: 0.6, depth: 0.36 });
      p.fill(0, p.Y(0.7), p.w, Math.max(2, 0.09 * p.py));
    }
  };
}

// --- roofs -----------------------------------------------------------------

const paintRoofTar: LayerFn = (p, rnd) => {
  p.metrics(6, 6);
  p.style({ c: hex(92, 90, 88), tint: 1, rough: 0.93, depth: 0.14 });
  p.fill(0, 0, p.w, p.h);
  // rolled bitumen seams
  const seam = 0.95 * p.py;
  for (let y = 0; y < p.h; y += seam) {
    const d = (rnd() - 0.5) * 16;
    p.style({ c: hex(92 + d, 90 + d, 88 + d), tint: 1, rough: 0.94, depth: 0.14 });
    p.fill(0, y, p.w, seam);
    p.style({ c: hex(72, 70, 69), tint: 1, rough: 0.9, depth: 0.06 });
    p.fill(0, y, p.w, Math.max(1, seam * 0.08));
  }
  // patches and ponding stains
  for (let i = 0; i < 34; i++) {
    const d = (rnd() - 0.5) * 34;
    p.style({ c: hex(96 + d, 94 + d, 91 + d), tint: 1, rough: 0.95, depth: 0.15 });
    p.ellipse(rnd() * p.w, rnd() * p.h, 4 + rnd() * 26, 3 + rnd() * 18);
  }
  for (let i = 0; i < 400; i++) {
    const g = 120 + rnd() * 90;
    p.shade(rnd() * p.w, rnd() * p.h, 1 + rnd() * 2, 1 + rnd() * 2, hex(g, g - 6, g - 12), 0.4);
  }
};

const paintRoofGravel: LayerFn = (p, rnd) => {
  p.metrics(5, 5);
  p.style({ c: hex(168, 164, 154), tint: 1, rough: 0.96, depth: 0.14 });
  p.fill(0, 0, p.w, p.h);
  for (let i = 0; i < 5200; i++) {
    const g = 120 + rnd() * 120;
    const d = (rnd() - 0.5) * 20;
    p.style({ c: hex(g + d, g + d * 0.9, g - 8 + d * 0.8), tint: 1, rough: 0.96, depth: 0.12 + rnd() * 0.06 });
    p.ellipse(rnd() * p.w, rnd() * p.h, 1 + rnd() * 2.4, 1 + rnd() * 2.1);
  }
};

const paintRoofShingle: LayerFn = (p, rnd) => {
  p.metrics(3.2, 3.2);
  p.style({ c: hex(150, 147, 142), tint: 1, rough: 0.94, depth: 0.2 });
  p.fill(0, 0, p.w, p.h);
  const rh = 0.14 * p.py;
  const tw = 0.3 * p.px;
  for (let r = 0, i = 0; r < p.h + rh; r += rh, i++) {
    const off = (i % 2) * tw * 0.5;
    for (let x = -tw; x < p.w + tw; x += tw) {
      const d = (rnd() - 0.5) * 30;
      p.style({ c: hex(186 + d, 183 + d, 178 + d), tint: 1, rough: 0.94, depth: 0.12 });
      p.fill(x + off + 1, r, tw - 2, rh * 1.55);
    }
    p.shade(0, r + rh * 1.5, p.w, Math.max(1.5, rh * 0.3), '#000', 0.3);
  }
};

const paintRoofSlate: LayerFn = (p, rnd) => {
  p.metrics(3.0, 3.0);
  const rh = 0.16 * p.py;
  const tw = 0.24 * p.px;
  p.style({ c: hex(120, 122, 128), tint: 1, rough: 0.66, depth: 0.2 });
  p.fill(0, 0, p.w, p.h);
  for (let r = 0, i = 0; r < p.h + rh; r += rh, i++) {
    const off = (i % 2) * tw * 0.5;
    for (let x = -tw; x < p.w + tw; x += tw) {
      const d = (rnd() - 0.5) * 34;
      p.style({ c: hex(196 + d, 198 + d, 204 + d), tint: 1, rough: 0.6 + rnd() * 0.2, depth: 0.1 });
      p.fill(x + off + 1, r, tw - 2, rh * 1.7);
    }
    p.shade(0, r + rh * 1.62, p.w, Math.max(1.5, rh * 0.3), '#000', 0.34);
  }
};

const paintRoofSeam: LayerFn = (p, rnd) => {
  p.metrics(3.0, 3.0);
  p.style({ c: hex(198, 200, 202), tint: 1, rough: 0.36, depth: 0.14 });
  p.fill(0, 0, p.w, p.h);
  const sp = 0.42 * p.px;
  for (let x = 0; x < p.w; x += sp) {
    const d = (rnd() - 0.5) * 10;
    p.style({ c: hex(206 + d, 208 + d, 210 + d), tint: 1, rough: 0.34, depth: 0.14 });
    p.fill(x, 0, sp, p.h);
    p.style({ c: hex(232, 234, 236), tint: 1, rough: 0.28, depth: 0.0 });
    p.fill(x, 0, Math.max(1.6, sp * 0.07), p.h);
    p.shade(x + sp * 0.07, 0, Math.max(2, sp * 0.08), p.h, '#000', 0.25);
  }
};

const paintRoofTile: LayerFn = (p, rnd) => {
  p.metrics(3.0, 3.0);
  p.style({ c: hex(150, 120, 104), tint: 1, rough: 0.86, depth: 0.22 });
  p.fill(0, 0, p.w, p.h);
  const rh = 0.3 * p.py;
  const tw = 0.2 * p.px;
  for (let r = 0, i = 0; r < p.h + rh; r += rh, i++) {
    for (let x = -tw; x < p.w + tw; x += tw) {
      const d = (rnd() - 0.5) * 26;
      p.style({ c: hex(216 + d, 196 + d, 182 + d), tint: 1, rough: 0.84, depth: 0.08 });
      for (const c of [p.a, p.b]) {
        c.beginPath();
        c.ellipse(x + tw * 0.5, r + rh * 0.6, tw * 0.52, rh * 0.66, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
    p.shade(0, r + rh * 1.15, p.w, Math.max(1.5, rh * 0.22), '#000', 0.28);
  }
};

const paintClutterMetal: LayerFn = (p, rnd) => {
  p.metrics(2.0, 2.0);
  p.style({ c: hex(198, 200, 203), tint: 1, rough: 0.42, depth: 0.12 });
  p.fill(0, 0, p.w, p.h);
  const rib = 0.09 * p.px;
  for (let x = 0; x < p.w; x += rib) {
    p.style({ c: hex(180, 183, 187), tint: 1, rough: 0.4, depth: 0.2 });
    p.fill(x, 0, Math.max(1, rib * 0.22), p.h);
  }
  for (let i = 0; i < 260; i++) {
    const d = (rnd() - 0.5) * 40;
    p.shade(rnd() * p.w, rnd() * p.h, 2 + rnd() * 10, 2 + rnd() * 10, d > 0 ? '#fff' : '#4a4038', 0.07);
  }
};

const paintClutterPaint: LayerFn = (p, rnd) => {
  p.metrics(2.0, 2.0);
  p.style({ c: hex(216, 214, 208), tint: 1, rough: 0.6, depth: 0.12 });
  p.fill(0, 0, p.w, p.h);
  for (let i = 0; i < 300; i++) {
    const d = (rnd() - 0.5) * 26;
    p.shade(rnd() * p.w, rnd() * p.h, 2 + rnd() * 14, 2 + rnd() * 14, d > 0 ? '#fff' : '#3b352c', 0.06);
  }
  // rust streaks
  for (let i = 0; i < 22; i++) {
    p.shade(rnd() * p.w, rnd() * p.h * 0.6, 1 + rnd() * 4, p.h * rnd() * 0.5, '#6a3a22', 0.12);
  }
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function layerPainters(): Array<{ fn: LayerFn; wm: number; hm: number }> {
  const out: Array<{ fn: LayerFn; wm: number; hm: number }> = new Array(LAYER_COUNT);
  for (let f = 0; f < 8; f++) {
    out[LAYER.field[f]] = { fn: paintField(f), wm: REF_BAY[f] * BAYS, hm: REF_FLOOR[f] };
    out[LAYER.ground[f]] = { fn: paintGround(f), wm: REF_BAY[f] * BAYS, hm: REF_GROUND[f] };
    out[LAYER.crown[f]] = { fn: paintCrown(f), wm: REF_BAY[f] * BAYS, hm: REF_FLOOR[f] * CROWN_FRAC };
  }
  out[LAYER.roofTar] = { fn: paintRoofTar, wm: 6, hm: 6 };
  out[LAYER.roofGravel] = { fn: paintRoofGravel, wm: 5, hm: 5 };
  out[LAYER.roofShingle] = { fn: paintRoofShingle, wm: 3.2, hm: 3.2 };
  out[LAYER.roofSlate] = { fn: paintRoofSlate, wm: 3, hm: 3 };
  out[LAYER.roofSeam] = { fn: paintRoofSeam, wm: 3, hm: 3 };
  out[LAYER.roofTile] = { fn: paintRoofTile, wm: 3, hm: 3 };
  out[LAYER.clutterMetal] = { fn: paintClutterMetal, wm: 2, hm: 2 };
  out[LAYER.clutterPaint] = { fn: paintClutterPaint, wm: 2, hm: 2 };
  return out;
}

/** Physical size in metres of one tile of each roof/clutter layer (for UVs). */
export const LAYER_TILE_M: Record<number, number> = {
  [LAYER.roofTar]: 6,
  [LAYER.roofGravel]: 5,
  [LAYER.roofShingle]: 3.2,
  [LAYER.roofSlate]: 3,
  [LAYER.roofSeam]: 3,
  [LAYER.roofTile]: 3,
  [LAYER.clutterMetal]: 2,
  [LAYER.clutterPaint]: 2,
};

function ctx2d(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2d context unavailable');
  g.imageSmoothingEnabled = false;
  return g;
}

/**
 * Build the atlas. Yields to the browser every few layers so the loading bar
 * keeps painting instead of the tab going white for a second.
 */
export async function buildFacadeAtlas(
  size: number,
  anisotropy: number,
  yieldFn?: (done: number, total: number) => Promise<void> | void,
): Promise<FacadeAtlas> {
  const W = size;
  const H = size >> 1;
  const painters = layerPainters();

  const ca = ctx2d(W, H);
  const cb = ctx2d(W, H);
  const p = new Painter(W, H, ca, cb);

  const stride = W * H * 4;
  const albData = new Uint8Array(stride * LAYER_COUNT);
  const surData = new Uint8Array(stride * LAYER_COUNT);

  for (let li = 0; li < LAYER_COUNT; li++) {
    const spec = painters[li];
    const rnd = mulberry32(0x5ca1ab1e + li * 7919);
    ca.globalAlpha = 1;
    cb.globalAlpha = 1;
    ca.clearRect(0, 0, W, H);
    cb.clearRect(0, 0, W, H);
    p.metrics(spec.wm, spec.hm);
    p.clear({ c: 'rgb(200,198,194)', tint: 1, rough: 0.85, depth: 0.1 });
    try {
      spec.fn(p, rnd);
    } catch {
      /* a broken layer must not take the city down */
    }

    const ia = ca.getImageData(0, 0, W, H).data;
    const ib = cb.getImageData(0, 0, W, H).data;

    // Flip vertically (canvas y-down -> uv v-up) while packing.
    const base = li * stride;
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      const dst = base + y * W * 4;
      for (let x = 0; x < W * 4; x += 4) {
        albData[dst + x] = ia[src + x];
        albData[dst + x + 1] = ia[src + x + 1];
        albData[dst + x + 2] = ia[src + x + 2];
        albData[dst + x + 3] = ib[src + x]; // tint weight
        surData[dst + x + 2] = ib[src + x + 1]; // roughness
        surData[dst + x + 3] = ib[src + x + 2]; // depth
      }
    }

    // Normals from the (already flipped) depth channel. Relief is scaled so a
    // full 0..1 depth step reads as ~0.22 m of recess.
    const relief = 3.4;
    for (let y = 0; y < H; y++) {
      const yUp = ((y + 1) % H) * W * 4;
      const yDn = ((y - 1 + H) % H) * W * 4;
      const yC = y * W * 4;
      for (let x = 0; x < W; x++) {
        const xR = ((x + 1) % W) * 4;
        const xL = ((x - 1 + W) % W) * 4;
        const dR = surData[base + yC + xR + 3];
        const dL = surData[base + yC + xL + 3];
        const dU = surData[base + yUp + x * 4 + 3];
        const dD = surData[base + yDn + x * 4 + 3];
        // depth grows inward, so the surface height is -depth
        let nx = ((dR - dL) / 255) * relief;
        let ny = ((dU - dD) / 255) * relief;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv;
        ny *= inv;
        surData[base + yC + x * 4] = Math.round((nx * 0.5 + 0.5) * 255);
        surData[base + yC + x * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      }
    }

    if (yieldFn && (li & 3) === 3) await yieldFn(li + 1, LAYER_COUNT);
  }

  const albedo = new THREE.DataArrayTexture(albData, W, H, LAYER_COUNT);
  const surface = new THREE.DataArrayTexture(surData, W, H, LAYER_COUNT);
  for (const t of [albedo, surface]) {
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.max(1, Math.min(16, anisotropy));
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
  }

  return {
    albedo,
    surface,
    width: W,
    height: H,
    dispose(): void {
      albedo.dispose();
      surface.dispose();
    },
  };
}
