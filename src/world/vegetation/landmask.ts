/**
 * A coarse raster of "what is the ground here" for the whole city, built once
 * from the OSM area polygons and the road network.
 *
 * Vegetation needs two fast answers, millions of times:
 *   - *is this point park, lawn, woodland or street?* — which decides what
 *     species goes there, how big it grows, and how it is spaced;
 *   - *can I put a grass tuft here?* — which additionally needs to exclude
 *     carriageways, paths, water, ball pitches and paving.
 *
 * Point-in-polygon against 6 000 rings cannot answer that at the rate the
 * ground-cover pass asks, so both live in one byte per 5 m cell.
 */
import type { AreaRecord, BuildingRecord, RoadRecord } from '../../core/types';

export const CLASS_NONE = 0;
export const CLASS_LAWN = 1;
export const CLASS_PARK = 2;
export const CLASS_FOREST = 3;
export const CLASS_CEMETERY = 4;
export const CLASS_BLOCKED = 5;
/** Bit 3: a carriageway, path or rail corridor covers this cell. */
export const FLAG_ROAD = 8;
/** Bit 4: a building footprint covers this cell. */
export const FLAG_BUILDING = 16;
/**
 * Bit 5: inside the airfield. Not the pavement -- the `runway` polygons are
 * already CLASS_BLOCKED -- but the mown infield between and around it, which
 * OSM does map as grass and which therefore grew a forest of street and park
 * trees in the middle of Logan. An operational airfield has nothing taller
 * than the grass anywhere near the movement area.
 */
export const FLAG_AIRSIDE = 32;

const CELL = 5;
/**
 * How far the airside flag reaches beyond the pavement, metres. Matches
 * `INFIELD_REACH` in terrain/landcover.ts, which sows the same ground with
 * grass -- the two want to describe the same region.
 */
const AIRSIDE_REACH = 220;
/** Coarse grid the dilation runs on. The fine grid is 3.6M cells. */
const AIRSIDE_CELL = 40;

interface Key { cls: number; pass: number }

const AREA_CLASS: Partial<Record<AreaRecord['kind'], Key>> = {
  forest: { cls: CLASS_FOREST, pass: 0 },
  wetland: { cls: CLASS_FOREST, pass: 0 },
  golf: { cls: CLASS_LAWN, pass: 1 },
  park: { cls: CLASS_PARK, pass: 1 },
  cemetery: { cls: CLASS_CEMETERY, pass: 2 },
  grass: { cls: CLASS_LAWN, pass: 2 },
  pitch: { cls: CLASS_BLOCKED, pass: 3 },
  beach: { cls: CLASS_BLOCKED, pass: 3 },
  sand: { cls: CLASS_BLOCKED, pass: 3 },
  parking: { cls: CLASS_BLOCKED, pass: 4 },
  railyard: { cls: CLASS_BLOCKED, pass: 4 },
  runway: { cls: CLASS_BLOCKED, pass: 4 },
  plaza: { cls: CLASS_BLOCKED, pass: 5 },
  pier: { cls: CLASS_BLOCKED, pass: 5 },
  water: { cls: CLASS_BLOCKED, pass: 6 },
  river: { cls: CLASS_BLOCKED, pass: 6 },
};

export class LandMask {
  readonly cell = CELL;
  private nx = 0;
  private nz = 0;
  private x0 = 0;
  private z0 = 0;
  private data = new Uint8Array(0);
  /** Per-cell hint of how big the containing green polygon is (metres/4). */
  private extent = new Uint8Array(0);

  /** Cells painted with something green; useful as a sanity check. */
  greenCells = 0;

  build(areas: AreaRecord[], roads: RoadRecord[]): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const a of areas) {
      const o = a.outline;
      for (let i = 0; i < o.length; i += 2) {
        if (o[i] < minX) minX = o[i];
        if (o[i] > maxX) maxX = o[i];
        if (o[i + 1] < minZ) minZ = o[i + 1];
        if (o[i + 1] > maxZ) maxZ = o[i + 1];
      }
    }
    if (!isFinite(minX)) return;

    const pad = 200;
    this.x0 = Math.floor((minX - pad) / CELL) * CELL;
    this.z0 = Math.floor((minZ - pad) / CELL) * CELL;
    this.nx = Math.ceil((maxX + pad - this.x0) / CELL) + 1;
    this.nz = Math.ceil((maxZ + pad - this.z0) / CELL) + 1;
    this.data = new Uint8Array(this.nx * this.nz);
    this.extent = new Uint8Array(this.nx * this.nz);

    const sorted = areas
      .map((a) => ({ a, k: AREA_CLASS[a.kind] }))
      .filter((e): e is { a: AreaRecord; k: Key } => e.k !== undefined)
      .sort((p, q) => p.k.pass - q.k.pass);

    for (const { a, k } of sorted) this.fill(a, k.cls);
    for (const r of roads) this.stampRoad(r);
    this.markAirside(areas);

    let green = 0;
    for (let i = 0; i < this.data.length; i++) {
      const c = this.data[i] & 7;
      if (c >= CLASS_LAWN && c <= CLASS_CEMETERY) green++;
    }
    this.greenCells = green;
  }

  get ready(): boolean {
    return this.data.length > 0;
  }

  /**
   * Flag everything within {@link AIRSIDE_REACH} of a runway polygon.
   *
   * Dilated on a coarse grid and written back, because a 220 m reach is 44
   * cells at the 5 m resolution and a sliding max over 3.6M of them for an
   * 89-wide window is not worth it for a boundary this soft.
   */
  private markAirside(areas: AreaRecord[]): void {
    const runways = areas.filter((a) => a.kind === 'runway' && a.outline.length >= 6);
    if (!runways.length) return;

    const cx = Math.ceil((this.nx * CELL) / AIRSIDE_CELL) + 1;
    const cz = Math.ceil((this.nz * CELL) / AIRSIDE_CELL) + 1;
    const seed = new Uint8Array(cx * cz);
    // Walk the edges rather than the vertices: a runway polygon is four
    // corners around a 2,800 m strip, and seeding only those would leave the
    // whole middle of it unflagged however far the result is dilated.
    for (const a of runways) {
      const o = a.outline;
      for (let i = 0; i < o.length; i += 2) {
        const k = (i + 2) % o.length;
        const ax = o[i], az = o[i + 1], bx = o[k], bz = o[k + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (AIRSIDE_CELL * 0.5)));
        for (let t = 0; t <= steps; t++) {
          const u = t / steps;
          const i0 = Math.floor((ax + (bx - ax) * u - this.x0) / AIRSIDE_CELL);
          const j0 = Math.floor((az + (bz - az) * u - this.z0) / AIRSIDE_CELL);
          if (i0 < 0 || j0 < 0 || i0 >= cx || j0 >= cz) continue;
          seed[j0 * cx + i0] = 1;
        }
      }
    }

    const r = Math.ceil(AIRSIDE_REACH / AIRSIDE_CELL);
    const tmp = new Uint8Array(cx * cz);
    for (let j = 0; j < cz; j++) {
      for (let i = 0; i < cx; i++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const ii = i + k;
          if (ii >= 0 && ii < cx && seed[j * cx + ii]) v = 1;
        }
        tmp[j * cx + i] = v;
      }
    }
    for (let j = 0; j < cz; j++) {
      for (let i = 0; i < cx; i++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const jj = j + k;
          if (jj >= 0 && jj < cz && tmp[jj * cx + i]) v = 1;
        }
        if (!v) continue;
        // Write the coarse cell back over the fine cells it covers.
        const fi0 = Math.floor((i * AIRSIDE_CELL) / CELL);
        const fj0 = Math.floor((j * AIRSIDE_CELL) / CELL);
        const span = Math.ceil(AIRSIDE_CELL / CELL);
        for (let fj = fj0; fj < fj0 + span && fj < this.nz; fj++) {
          const row = fj * this.nx;
          for (let fi = fi0; fi < fi0 + span && fi < this.nx; fi++) {
            this.data[row + fi] |= FLAG_AIRSIDE;
          }
        }
      }
    }
  }

  /** Approximate area of a ring, used to size the trees a park grows. */
  private static ringArea(r: number[]): number {
    let s = 0;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      s += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
    }
    return Math.abs(s) * 0.5;
  }

  /** Even-odd scanline fill of outline + holes. */
  private fill(a: AreaRecord, cls: number): void {
    const rings: number[][] = [a.outline];
    if (a.holes) for (const h of a.holes) rings.push(h);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const o = a.outline;
    for (let i = 0; i < o.length; i += 2) {
      if (o[i] < minX) minX = o[i];
      if (o[i] > maxX) maxX = o[i];
      if (o[i + 1] < minZ) minZ = o[i + 1];
      if (o[i + 1] > maxZ) maxZ = o[i + 1];
    }
    const j0 = Math.max(0, Math.floor((minZ - this.z0) / CELL));
    const j1 = Math.min(this.nz - 1, Math.ceil((maxZ - this.z0) / CELL));
    if (j1 < j0) return;

    const hint = Math.min(255, Math.round(Math.sqrt(LandMask.ringArea(a.outline)) / 4));
    const xs: number[] = [];

    for (let j = j0; j <= j1; j++) {
      const zc = this.z0 + (j + 0.5) * CELL;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length / 2;
        for (let i = 0; i < n; i++) {
          const k = (i + 1) % n;
          const za = ring[i * 2 + 1];
          const zb = ring[k * 2 + 1];
          if ((za <= zc && zb > zc) || (zb <= zc && za > zc)) {
            const t = (zc - za) / (zb - za);
            xs.push(ring[i * 2] + t * (ring[k * 2] - ring[i * 2]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const row = j * this.nx;
      for (let s = 0; s + 1 < xs.length; s += 2) {
        let i0 = Math.max(0, Math.ceil((xs[s] - this.x0) / CELL - 0.5));
        const i1 = Math.min(this.nx - 1, Math.floor((xs[s + 1] - this.x0) / CELL - 0.5));
        for (; i0 <= i1; i0++) {
          this.data[row + i0] = cls;
          if (cls >= CLASS_LAWN && cls <= CLASS_CEMETERY) this.extent[row + i0] = hint;
        }
      }
    }
  }

  /** Marks a road corridor, but only where something green would care. */
  private stampRoad(r: RoadRecord): void {
    const p = r.path;
    if (p.length < 4) return;
    if (r.tunnel) return;
    const halfW = Math.max(1.5, r.width * 0.5 + 1.2);
    const cells = Math.ceil(halfW / CELL);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i], z0 = p[i + 1], x1 = p[i + 2], z1 = p[i + 3];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(1, Math.ceil(len / CELL));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const cx = x0 + (x1 - x0) * u;
        const cz = z0 + (z1 - z0) * u;
        const ci = Math.floor((cx - this.x0) / CELL);
        const cj = Math.floor((cz - this.z0) / CELL);
        if (ci < 0 || cj < 0 || ci >= this.nx || cj >= this.nz) continue;
        for (let dj = -cells; dj <= cells; dj++) {
          const jj = cj + dj;
          if (jj < 0 || jj >= this.nz) continue;
          const row = jj * this.nx;
          for (let di = -cells; di <= cells; di++) {
            const ii = ci + di;
            if (ii < 0 || ii >= this.nx) continue;
            this.data[row + ii] |= FLAG_ROAD;
          }
        }
      }
    }
  }

  /** Raw cell byte (class in the low 3 bits, FLAG_ROAD in bit 3). */
  at(x: number, z: number): number {
    if (!this.data.length) return 0;
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.data[j * this.nx + i];
  }

  classAt(x: number, z: number): number {
    return this.at(x, z) & 7;
  }

  /** Size hint (metres) of the green polygon covering this point, 0 if none. */
  extentAt(x: number, z: number): number {
    if (!this.extent.length) return 0;
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.extent[j * this.nx + i] * 4;
  }

  /**
   * Release the per-cell park-size hint.
   *
   * `extent` is a second byte per 5 m cell over the whole city -- 4.3 MB --
   * and it is read exactly once, by `buildTreeField`, to decide how big a
   * specimen a park is old enough to have grown. Nothing consults it after
   * placement, and holding it for the life of the page is 4.3 MB that an
   * iPad does not have. `extentAt` answers 0 afterwards, which is the same
   * answer it gives outside the raster.
   */
  dropExtent(): void {
    this.extent = new Uint8Array(0);
  }

  /** True when ground cover may grow here. */
  plantable(x: number, z: number): number {
    const v = this.at(x, z);
    if (v & FLAG_ROAD) return 0;
    const c = v & 7;
    return c >= CLASS_LAWN && c <= CLASS_CEMETERY ? c : 0;
  }

  /**
   * How far (in cells, capped at `max`) this point is from the edge of its
   * green patch. Hedges and shrub borders want the rim; open lawn wants the
   * middle.
   */
  edgeDistance(x: number, z: number, max: number): number {
    const c0 = this.plantable(x, z);
    if (!c0) return 0;
    for (let r = 1; r <= max; r++) {
      const d = r * CELL;
      if (!this.plantable(x + d, z) || !this.plantable(x - d, z)
        || !this.plantable(x, z + d) || !this.plantable(x, z - d)) return r;
    }
    return max + 1;
  }
}
