/**
 * Packs the CPU heightfield and land-cover maps into the three GPU textures the
 * terrain shader reads.
 *
 *   height  RG8    16-bit fixed-point elevation, point-sampled and manually
 *                  bilinear-filtered in the vertex shader so the GPU surface
 *                  matches `ctx.sampleHeight` to within 2 mm. Float textures
 *                  would need OES_texture_float_linear; half floats quantise to
 *                  6 cm at Boston's elevations, which is enough to float or
 *                  sink a kerb.
 *   normal  RGBA8  world-space normal derived from the *heightfield*, never
 *                  from the tessellated mesh, so shading does not shift when a
 *                  chunk changes LOD. Alpha carries the signed distance to the
 *                  waterline, which drives the wet band and the beach blend.
 *   cover   RGBA8  the land-cover splat key (see landcover.ts).
 */
import * as THREE from 'three';
import type { Heightfield } from './Heightfield';
import type { LandCover } from './landcover';

/** Metres either side of the waterline resolvable by the packed shore field. */
export const SHORE_RANGE = 24;

export interface FieldTextures {
  height: THREE.DataTexture;
  normal: THREE.DataTexture;
  cover: THREE.DataTexture;
  /** Elevation encoded by byte 0 of the height texture. */
  heightBase: number;
  heightRange: number;
  bytes: number;
  dispose(): void;
}

export function buildFieldTextures(
  hf: Heightfield,
  lc: LandCover,
  shoreDist: Int16Array,
  anisotropy: number,
): FieldTextures {
  const w = hf.width;
  const h = hf.height;
  const n = w * h;
  const data = hf.data;

  const heightBase = Math.floor(hf.minElevation) - 2;
  const heightRange = Math.ceil(hf.maxElevation) + 4 - heightBase;
  const invRange = 65535 / heightRange;

  const hBytes = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    let q = Math.round((data[k] - heightBase) * invRange);
    if (q < 0) q = 0; else if (q > 65535) q = 65535;
    hBytes[k * 2] = q >> 8;
    hBytes[k * 2 + 1] = q & 255;
  }

  const nBytes = new Uint8Array(n * 4);
  const sx2 = 2 * hf.spacingX;
  const sz2 = 2 * hf.spacingZ;
  const shoreScale = 127.5 / SHORE_RANGE;
  for (let j = 0; j < h; j++) {
    const row = j * w;
    const up = j > 0 ? row - w : row;
    const dn = j < h - 1 ? row + w : row;
    for (let i = 0; i < w; i++) {
      const k = row + i;
      const il = i > 0 ? i - 1 : i;
      const ir = i < w - 1 ? i + 1 : i;
      const dx = (data[row + il] - data[row + ir]) / sx2;
      const dz = (data[up + i] - data[dn + i]) / sz2;
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const o = k * 4;
      nBytes[o] = (dx * inv * 127.5 + 127.5) | 0;
      nBytes[o + 1] = (inv * 127.5 + 127.5) | 0;
      nBytes[o + 2] = (dz * inv * 127.5 + 127.5) | 0;
      let s = shoreDist[k] * 0.1 * shoreScale + 127.5;
      if (s < 0) s = 0; else if (s > 255) s = 255;
      nBytes[o + 3] = s | 0;
    }
  }

  const height = new THREE.DataTexture(hBytes, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  height.magFilter = THREE.NearestFilter;
  height.minFilter = THREE.NearestFilter;
  height.wrapS = THREE.ClampToEdgeWrapping;
  height.wrapT = THREE.ClampToEdgeWrapping;
  height.generateMipmaps = false;
  height.unpackAlignment = 1;
  height.colorSpace = THREE.NoColorSpace;
  height.needsUpdate = true;

  const normal = dataRgba(nBytes, w, h, anisotropy);
  const cover = dataRgba(lc.cover, w, h, anisotropy);

  return {
    height,
    normal,
    cover,
    heightBase,
    heightRange,
    bytes: n * 2 + n * 4 * 2,
    dispose(): void {
      height.dispose();
      normal.dispose();
      cover.dispose();
    },
  };
}

function dataRgba(bytes: Uint8Array<ArrayBuffer>, w: number, h: number, aniso: number): THREE.DataTexture {
  const t = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.anisotropy = Math.min(4, aniso);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
