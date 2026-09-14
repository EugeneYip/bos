/**
 * Projection + config constants for the offline pipeline.
 *
 * NOTE: this file intentionally DUPLICATES the maths in `src/core/geo.ts` and the
 * constants in `src/core/config.ts`, because tools/ runs under plain node with no
 * TypeScript loader. The two implementations MUST stay numerically identical;
 * `tools/check-geo.mjs` asserts agreement to < 1e-9 m over the whole of BOUNDS by
 * re-deriving the constants straight out of the .ts sources.
 *
 * World axes: +X = east, +Y = up, +Z = south.
 */

/** @see src/core/config.ts ORIGIN */
export const ORIGIN = { lat: 42.3554, lon: -71.0655 };

/** @see src/core/config.ts BOUNDS */
export const BOUNDS = {
  south: 42.3180,
  west: -71.1320,
  north: 42.3960,
  east: -71.0060,
};

/** @see src/core/config.ts SEA_LEVEL */
export const SEA_LEVEL = 0;

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const lat0 = (ORIGIN.lat * Math.PI) / 180;
const sinLat0 = Math.sin(lat0);
const w = Math.sqrt(1 - WGS84_E2 * sinLat0 * sinLat0);

/** Radius of curvature in the meridian (north-south) at the origin. */
export const METERS_PER_DEG_LAT = (Math.PI / 180) * ((WGS84_A * (1 - WGS84_E2)) / (w * w * w));
/** Radius of curvature in the prime vertical (east-west) at the origin. */
export const METERS_PER_DEG_LON = (Math.PI / 180) * ((WGS84_A / w) * Math.cos(lat0));

/** Longitude/latitude (degrees) -> world X/Z (metres). */
export function lonLatToWorld(lon, lat) {
  return [(lon - ORIGIN.lon) * METERS_PER_DEG_LON, -(lat - ORIGIN.lat) * METERS_PER_DEG_LAT];
}

/** World X/Z (metres) -> longitude/latitude (degrees). */
export function worldToLonLat(x, z) {
  return [ORIGIN.lon + x / METERS_PER_DEG_LON, ORIGIN.lat - z / METERS_PER_DEG_LAT];
}

/** Web-Mercator tile x/y for a lon/lat at a given zoom (fractional). */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Inverse of {@link lonLatToTile}; accepts fractional tile coordinates. */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** World-space AABB of BOUNDS. */
export const WORLD_BOUNDS = (() => {
  const [minX, maxZ] = lonLatToWorld(BOUNDS.west, BOUNDS.south);
  const [maxX, minZ] = lonLatToWorld(BOUNDS.east, BOUNDS.north);
  return { minX, maxX, minZ, maxZ, sizeX: maxX - minX, sizeZ: maxZ - minZ };
})();
