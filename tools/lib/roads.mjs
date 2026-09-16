/**
 * RoadRecord extraction: every `highway=*` way plus heavy/light rail, with a
 * per-vertex terrain elevation sample so the renderer can lay the ribbon on the
 * ground without re-querying the heightfield.
 *
 * Bridges and tunnels are tagged, not displaced: another agent owns the viaduct
 * geometry, and it needs the true ground profile underneath.
 */
import { lonLatToWorld } from './geo.mjs';
import { pathLength, simplify } from './geom.mjs';
import { isTrue, parseLength, parseSurface } from './tags.mjs';

/** highway= value -> RoadClass. */
const CLASS = {
  motorway: 'motorway', motorway_link: 'motorway',
  trunk: 'trunk', trunk_link: 'trunk',
  primary: 'primary', primary_link: 'primary',
  secondary: 'secondary', secondary_link: 'secondary',
  tertiary: 'tertiary', tertiary_link: 'tertiary', unclassified: 'tertiary', road: 'tertiary',
  residential: 'residential', living_street: 'residential',
  service: 'service',
  pedestrian: 'pedestrian',
  footway: 'footway', path: 'footway', steps: 'footway', track: 'footway',
  bridleway: 'footway', corridor: 'footway',
  cycleway: 'cycleway',
};

/** Lane count and metres per lane when `lanes`/`width` are missing. */
const DEFAULTS = {
  motorway: { lanes: 3, lane: 3.7, min: 9 },
  trunk: { lanes: 2, lane: 3.6, min: 7 },
  primary: { lanes: 2, lane: 3.5, min: 7 },
  secondary: { lanes: 2, lane: 3.4, min: 6.5 },
  tertiary: { lanes: 2, lane: 3.3, min: 6 },
  residential: { lanes: 2, lane: 3.0, min: 5.5 },
  service: { lanes: 1, lane: 3.4, min: 3 },
  pedestrian: { lanes: 1, lane: 7.0, min: 4 },
  footway: { lanes: 1, lane: 2.0, min: 1.2 },
  cycleway: { lanes: 1, lane: 2.4, min: 1.6 },
  rail: { lanes: 1, lane: 4.6, min: 3.2 },
};

/** highway= values that are not routable surfaces at all. */
const SKIP_HIGHWAY = new Set([
  'bus_stop', 'crossing', 'traffic_signals', 'street_lamp', 'give_way', 'stop',
  'turning_circle', 'turning_loop', 'motorway_junction', 'speed_camera', 'milestone',
  'elevator', 'construction', 'proposed', 'planned', 'razed', 'abandoned', 'platform',
  'rest_area', 'services', 'emergency_bay', 'traffic_mirror', 'passing_place',
]);

const SKIP_RAILWAY = new Set([
  'abandoned', 'disused', 'razed', 'proposed', 'construction', 'platform',
  'station', 'halt', 'switch', 'signal', 'level_crossing', 'buffer_stop', 'crossing',
]);

/**
 * How much general motor traffic a way should carry, from OSM's access tags.
 *
 * `undefined` is the ordinary public street. 'none' means no general traffic
 * at all -- the Navy Yard's service roads, Harvard Yard, the paths across the
 * Common that are tagged driveable because a maintenance truck uses them.
 * 'local' is somewhere a car belongs but a *stream* of cars does not: a
 * private drive, a parking aisle, a customers-only lot.
 *
 * `motor_vehicle` is checked first and on its own, because it is the specific
 * tag: `access=private` + `motor_vehicle=yes` is a public road with a private
 * right of way, and reading only `access` would empty it.
 */
const MOTOR_NONE = new Set(['no', 'permit']);
const MOTOR_LOCAL = new Set(['private', 'customers', 'destination', 'delivery']);
const SERVICE_LOCAL = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);

function motorAccess(t, cls) {
  const mv = t.motor_vehicle ?? t.vehicle;
  if (mv) {
    if (MOTOR_NONE.has(mv)) return 'none';
    if (MOTOR_LOCAL.has(mv)) return 'local';
    return undefined; // yes / designated / permissive: explicitly allowed
  }
  const ac = t.access;
  if (ac) {
    if (MOTOR_NONE.has(ac)) return 'none';
    if (MOTOR_LOCAL.has(ac)) return 'local';
  }
  if (cls === 'service' && SERVICE_LOCAL.has(t.service)) return 'local';
  return undefined;
}

export function buildRoads(elements, sampleGround, log = console.log) {
  const stats = { skipped: 0, tooShort: 0, byClass: {}, bridges: 0, tunnels: 0, cobble: 0, km: 0 };
  const out = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags || {};
    let cls = null;
    let isRail = false;

    if (t.highway) {
      if (SKIP_HIGHWAY.has(t.highway)) { stats.skipped++; continue; }
      // A pedestrian *area* is a plaza, emitted by areas.mjs, not a ribbon.
      if (t.highway === 'pedestrian' && isTrue(t.area)) { stats.skipped++; continue; }
      cls = CLASS[t.highway] ?? 'service';
    } else if (t.railway) {
      if (SKIP_RAILWAY.has(t.railway)) { stats.skipped++; continue; }
      cls = 'rail';
      isRail = true;
    } else { stats.skipped++; continue; }

    const flat = [];
    for (const p of el.geometry) { const [x, z] = lonLatToWorld(p.lon, p.lat); flat.push(x, z); }
    // 0.4 m is well under the width of any lane, so this never changes the shape
    // on screen but removes the dense GPS noise OSM carries on long ways.
    const path = simplify(flat, 0.4);
    if (path.length < 4) { stats.tooShort++; continue; }
    const len = pathLength(path);
    if (len < 3) { stats.tooShort++; continue; }

    const d = DEFAULTS[cls];
    let lanes = parseInt(t.lanes, 10);
    if (!Number.isFinite(lanes) || lanes < 1 || lanes > 16) {
      const fwd = parseInt(t['lanes:forward'], 10), bwd = parseInt(t['lanes:backward'], 10);
      lanes = Number.isFinite(fwd) && Number.isFinite(bwd) ? fwd + bwd : d.lanes;
    }
    const oneway = isTrue(t.oneway) || t.oneway === '-1' || t.junction === 'roundabout';
    if (oneway && !Number.isFinite(parseInt(t.lanes, 10)) && (cls === 'motorway' || cls === 'trunk')) {
      lanes = Math.max(2, d.lanes - 1);
    }
    let width = parseLength(t.width) ?? parseLength(t['est_width']);
    if (!(width > 0.5 && width < 80)) width = lanes * d.lane;
    width = Math.max(d.min, width);

    const layerRaw = parseInt(t.layer, 10);
    const bridge = !!t.bridge && t.bridge !== 'no';
    const tunnel = (!!t.tunnel && t.tunnel !== 'no') || t.covered === 'yes';
    let layer = Number.isFinite(layerRaw) ? Math.max(-5, Math.min(5, layerRaw)) : 0;
    if (bridge && layer === 0) layer = 1;
    if (tunnel && layer === 0) layer = -1;
    if (bridge) stats.bridges++;
    if (tunnel) stats.tunnels++;

    const surface = parseSurface(
      t.surface,
      isRail ? 'gravel' : cls === 'footway' || cls === 'pedestrian' ? 'concrete' : 'asphalt',
    );
    if (surface === 'cobblestone') stats.cobble++;

    const elevation = new Array(path.length / 2);
    for (let i = 0; i < path.length; i += 2) {
      elevation[i / 2] = Math.round(sampleGround(path[i], path[i + 1]) * 10) / 10;
    }

    stats.byClass[cls] = (stats.byClass[cls] || 0) + 1;
    stats.km += len / 1000;
    out.push({
      id: `w${el.id}`,
      class: cls,
      path,
      elevation,
      width: Math.round(width * 10) / 10,
      lanes,
      layer,
      bridge,
      tunnel,
      oneway,
      name: t.name || undefined,
      surface,
      motor: motorAccess(t, cls),
      _len: len,
    });
  }

  log(`  roads: ${out.length} ways, ${stats.km.toFixed(0)} km (${stats.skipped} skipped, ${stats.tooShort} too short)`);
  log(`    ${Object.entries(stats.byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`    ${stats.bridges} bridges, ${stats.tunnels} tunnels, ${stats.cobble} cobbled ways`);
  const noMotor = out.filter((r) => r.motor === 'none').length;
  const locMotor = out.filter((r) => r.motor === 'local').length;
  log(`    ${noMotor} closed to general traffic, ${locMotor} local access only`);
  return { roads: out, stats };
}
