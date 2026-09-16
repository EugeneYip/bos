/**
 * Shared data contract between the offline extraction pipeline (tools/) and the
 * runtime (src/). Everything in `public/data/` conforms to these types.
 *
 * Geometry is pre-projected to world metres (see core/geo.ts) at build time so
 * the runtime never touches lat/lon. Coordinates are stored in flat Float32-
 * friendly arrays as [x0,z0, x1,z1, ...] to keep payloads small and parsing fast.
 */

/** Broad surface/material family, used to pick the PBR material at runtime. */
export type BuildingMaterial =
  | 'brick'        // Back Bay / Beacon Hill / South End rowhouses
  | 'brownstone'
  | 'glass'        // modern curtain wall
  | 'concrete'     // brutalist (City Hall, Government Center)
  | 'stone'        // granite & limestone civic buildings
  | 'metal'
  | 'wood'         // triple-deckers, clapboard
  | 'plaster';

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'mansard' | 'pyramidal' | 'dome' | 'skillion';

export interface BuildingRecord {
  /** OSM element id, prefixed `w` (way) or `r` (relation). */
  id: string;
  /** Outer ring, closed (last point != first point), CCW, world metres: [x,z,...]. */
  outline: number[];
  /** Inner rings (courtyards), same encoding. */
  holes?: number[][];
  /** Height of the top of the walls above local ground, metres. */
  height: number;
  /** Height of the base above local ground (for buildings on plinths / bridges). */
  minHeight: number;
  /** Terrain elevation at the footprint centroid, metres above sea level. */
  ground: number;
  levels: number;
  roof: RoofShape;
  /** Additional height of the roof volume above `height`, metres. */
  roofHeight: number;
  material: BuildingMaterial;
  /** sRGB hex of the dominant wall colour, e.g. 0x8a5a44. */
  color: number;
  roofColor: number;
  name?: string;
  /** Set when a bespoke hand-built landmark mesh replaces the extruded footprint. */
  landmark?: string;
}

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'residential' | 'service' | 'pedestrian' | 'footway' | 'cycleway' | 'rail';

export interface RoadRecord {
  id: string;
  class: RoadClass;
  /** Polyline in world metres: [x,z,...]. */
  path: number[];
  /** Per-vertex ground elevation, metres. Same length as path/2. */
  elevation: number[];
  width: number;
  lanes: number;
  /** Structural layer: 0 ground, >0 viaduct, <0 tunnel. */
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  oneway: boolean;
  name?: string;
  surface: 'asphalt' | 'concrete' | 'cobblestone' | 'brick' | 'gravel' | 'ground';
  /**
   * How much general motor traffic belongs here, from OSM's access tags.
   * Absent is an ordinary public street.
   *
   * 'none' is closed to general traffic -- the Navy Yard's service roads, the
   * paths across the Common that carry a maintenance truck, an airside
   * service road. 'local' is somewhere a car belongs but a *stream* of cars
   * does not: a private drive, a parking aisle, a customers-only lot.
   */
  motor?: 'none' | 'local';
}

export type AreaKind =
  | 'water' | 'river' | 'park' | 'grass' | 'forest' | 'cemetery' | 'beach'
  | 'pitch' | 'parking' | 'pier' | 'plaza' | 'sand' | 'wetland' | 'golf'
  | 'runway' | 'railyard';

export interface AreaRecord {
  id: string;
  kind: AreaKind;
  /** Outer ring, world metres: [x,z,...]. */
  outline: number[];
  holes?: number[][];
  /** Constant surface elevation (water bodies) or terrain-draped flag. */
  elevation: number;
  drape: boolean;
  name?: string;
}

export type PropKind =
  | 'tree' | 'streetlamp' | 'traffic_signal' | 'bench' | 'bollard'
  | 'fountain' | 'statue' | 'mast' | 'chimney' | 'crane' | 'flagpole';

/** Point features. Packed columnar for size; index i is one prop. */
export interface PropSet {
  kind: PropKind;
  /** [x,y,z, ...] world metres, y already includes terrain elevation. */
  positions: number[];
  /** Per-prop uniform scale multiplier. */
  scales: number[];
  /** Per-prop Y rotation in radians. */
  rotations: number[];
  /** Optional per-prop variant index (e.g. tree species). */
  variants?: number[];
}

/** Heightfield covering BOUNDS, row-major from north-west, metres above sea level. */
export interface TerrainData {
  width: number;
  height: number;
  /** World-space size of the grid. */
  sizeX: number;
  sizeZ: number;
  /** World-space position of the grid's north-west corner. */
  originX: number;
  originZ: number;
  /** Elevations, length = width*height. */
  elevations: Float32Array;
}

export interface CityManifest {
  version: number;
  generated: string;
  bounds: { south: number; west: number; north: number; east: number };
  origin: { lat: number; lon: number };
  attribution: string[];
  counts: Record<string, number>;
  files: {
    terrain: string;
    buildings: string[];
    roads: string[];
    areas: string[];
    props: string[];
  };
}
