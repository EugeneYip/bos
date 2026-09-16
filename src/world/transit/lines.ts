/**
 * Which MBTA system a rail `RoadRecord` belongs to, read straight off its
 * `name` field — the extraction pipeline keeps the real OSM route names
 * (`public/data/roads-*.json`), so no separate manifest of line geometry is
 * needed here.
 *
 * The rail network includes a lot that is not passenger trackage: yard
 * leads, numbered storage tracks, crane tracks at the container terminal and
 * the dry docks, industrial sidings (a coke works, a cement importer, a
 * metal recycler). None of that carries a name this module recognises, so it
 * is drawn as track by `Roads` but never gets a train — which is correct.
 */

export type SystemId = 'green' | 'red' | 'orange' | 'blue' | 'commuter';

/**
 * Named commuter-rail corridors worth running trains on. These are the
 * historical route names the extraction pipeline preserved from OSM
 * (`Northeast Corridor`, `Dorchester Branch`, `Middleborough Main Line`, the
 * old B&M route names for the northside lines), as distinct from the
 * numbered yard tracks and industrial spurs that share the right-of-way.
 */
const COMMUTER_NAMES = new Set<string>([
  'Northeast Corridor',
  'Dorchester Branch',
  'Fitchburg Route',
  'New Hampshire Route',
  'New Hampshire Route Main Line',
  'Eastern Route',
  'Western Route',
  'Worcester Main Line',
  'Middleborough Main Line',
  'Boston Subdivision',
  'B&A Westbound',
  'B&A Eastbound',
]);

/** Classifies a rail way's OSM name into one of the five systems we animate. */
export function classifyRail(name: string | undefined): SystemId | null {
  if (!name) return null;
  if (name.startsWith('Green Line')) return 'green';
  if (name.startsWith('Red Line')) return 'red';
  if (name === 'Orange Line') return 'orange';
  if (name === 'Blue Line') return 'blue';
  if (COMMUTER_NAMES.has(name)) return 'commuter';
  return null;
}

export const SYSTEM_IDS: SystemId[] = ['green', 'red', 'orange', 'blue', 'commuter'];

/** Human-readable label, for the console summary only. */
export const SYSTEM_LABEL: Record<SystemId, string> = {
  green: 'Green Line',
  red: 'Red Line',
  orange: 'Orange Line',
  blue: 'Blue Line',
  commuter: 'Commuter Rail',
};
