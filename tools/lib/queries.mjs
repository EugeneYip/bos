/**
 * The Overpass QL used by the pipeline, plus the tiling strategy per theme.
 * Kept in one place so `tools/fetch-osm.mjs` (cache warmer) and
 * `tools/build-data.mjs` issue byte-identical queries and therefore share a cache.
 */
import { BOUNDS } from './geo.mjs';
import { fetchTiled, overpass } from './overpass.mjs';

const T = 240; // per-query Overpass timeout, seconds

/** Buildings are by far the densest layer -> smallest tiles. */
const BUILDING_QL = (b) => `[out:json][timeout:${T}];
(
  way["building"](${b});
  way["building:part"](${b});
  relation["building"](${b});
  relation["building:part"](${b});
);
out geom;`;

const ROAD_QL = (b) => `[out:json][timeout:${T}];
(
  way["highway"](${b});
  way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge|funicular|monorail|preserved)$"](${b});
);
out geom;`;

const NATURAL = 'water|beach|sand|wetland|wood|scrub|grassland|bare_rock|shingle|mud';
const LANDUSE =
  'reservoir|basin|grass|forest|meadow|cemetery|village_green|recreation_ground|allotments|orchard|brownfield|greenfield|railway|farmland|flowerbed|plant_nursery';
const LEISURE =
  'park|garden|pitch|golf_course|playground|track|common|dog_park|nature_reserve|marina|stadium|sports_centre|swimming_pool|water_park';

const AREA_QL = (b) => `[out:json][timeout:${T}];
(
  way["natural"~"^(${NATURAL})$"](${b});
  relation["natural"~"^(${NATURAL})$"](${b});
  way["waterway"~"^(riverbank|dock|canal)$"](${b});
  relation["waterway"~"^(riverbank|dock|canal)$"](${b});
  way["landuse"~"^(${LANDUSE})$"](${b});
  relation["landuse"~"^(${LANDUSE})$"](${b});
  way["leisure"~"^(${LEISURE})$"](${b});
  relation["leisure"~"^(${LEISURE})$"](${b});
  way["amenity"~"^(parking|grave_yard)$"](${b});
  relation["amenity"~"^(parking|grave_yard)$"](${b});
  way["man_made"~"^(pier|breakwater|bridge|groyne)$"](${b});
  relation["man_made"~"^(pier|breakwater|bridge)$"](${b});
  way["aeroway"~"^(runway|taxiway|apron|helipad)$"](${b});
  relation["aeroway"~"^(runway|taxiway|apron)$"](${b});
  way["highway"="pedestrian"]["area"="yes"](${b});
  way["place"="square"](${b});
);
out geom;`;

const PROP_QL = (b) => `[out:json][timeout:${T}];
(
  node["natural"="tree"](${b});
  way["natural"="tree_row"](${b});
  node["highway"~"^(street_lamp|traffic_signals)$"](${b});
  node["amenity"~"^(bench|fountain)$"](${b});
  node["barrier"="bollard"](${b});
  node["historic"~"^(memorial|monument)$"](${b});
  node["tourism"="artwork"](${b});
  node["man_made"~"^(mast|chimney|crane|flagpole|water_tower|communications_tower|obelisk|lighthouse)$"](${b});
  way["man_made"~"^(chimney|crane|mast|water_tower|lighthouse)$"](${b});
);
out geom;`;

/** Coastline must be fetched well outside BOUNDS so open chains fully cross it. */
export const COAST_PAD = 0.16;
const COAST_QL = (b) => `[out:json][timeout:600];
way["natural"="coastline"](${b});
out geom;`;

export async function fetchBuildings() {
  return fetchTiled("bld", BOUNDS, 0.012, BUILDING_QL, { concurrency: 3 });
}
export async function fetchRoads() {
  return fetchTiled('road', BOUNDS, 0.026, ROAD_QL, { concurrency: 2 });
}
export async function fetchAreas() {
  return fetchTiled('area', BOUNDS, 0.026, AREA_QL, { concurrency: 2 });
}
export async function fetchProps() {
  return fetchTiled('prop', BOUNDS, 0.026, PROP_QL, { concurrency: 2 });
}
export async function fetchCoastline() {
  const b = {
    south: (BOUNDS.south - COAST_PAD).toFixed(6),
    west: (BOUNDS.west - COAST_PAD).toFixed(6),
    north: (BOUNDS.north + COAST_PAD).toFixed(6),
    east: (BOUNDS.east + COAST_PAD).toFixed(6),
  };
  const json = await overpass('coast', COAST_QL(`${b.south},${b.west},${b.north},${b.east}`));
  return json.elements;
}
