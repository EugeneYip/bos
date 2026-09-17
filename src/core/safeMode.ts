/**
 * Crash-loop breaker.
 *
 * iOS Safari answers an out-of-memory tab by reloading it, which on a page
 * this heavy means reloading into the same out-of-memory tab: the visitor
 * gets the city for a few seconds, then the loading screen, forever. No
 * amount of tuning fixes that for every device, because the ceiling differs
 * per model and there is no API that reports it.
 *
 * So treat a boot that never reached a steady state as evidence. A flag is
 * written to storage before the world is built and cleared only once the
 * page has been running for {@link STABLE_AFTER_MS}. If a later boot finds
 * that flag still set, the previous attempt died on the way up, and this one
 * asks for less. Four rungs, and the bottom one is deliberately austere
 * enough to run anywhere.
 *
 * The visitor can always override it: `?safe=0` forces the full model,
 * `?safe=3` forces the bottom rung, and reaching a steady state at any level
 * resets the ladder so the next visit starts from the top again.
 *
 * A rung only counts if it takes something off the PEAK heap during load,
 * which is the number iOS kills the tab on -- not off the settled heap. The
 * first two rungs failed that test: every module they drop allocates after the
 * peak has already been reached, so a phone that could not boot at level 2 had
 * nowhere left to fall and looped forever. See the attribution table in
 * `src/main.ts` for the measurement, and add new rungs against it rather than
 * against a guess at what looks expensive.
 */

const KEY = 'bh-boot';
const LEVEL_KEY = 'bh-safe';
/** How long a session must survive before its boot counts as successful. */
const STABLE_AFTER_MS = 20000;
/** Rungs below the full model. */
export const MAX_SAFE_LEVEL = 3;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* private mode */ }
}
function drop(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export interface SafeMode {
  /** 0 is the full model; higher asks for less. */
  level: number;
  /** True when this level was forced by a previous boot failing. */
  degraded: boolean;
  /** Call once the page has actually run; disarms the guard. */
  armStable(): void;
}

/**
 * The rung a phone or tablet starts on.
 *
 * Not zero. Measured with a verified mobile code path -- which matters, since
 * a user-agent string alone no longer selects it -- the full model peaks at
 * 614 MB of JS heap during load and settles at 364. One rung down is 527 and
 * 318, and what it gives up is rigid-body physics over 61,000 footprints and
 * the rail network: the two systems a visitor on a phone is least likely to
 * look for, for 87 MB off the number iOS actually kills on.
 *
 * It is also a floor rather than a starting point. The ladder steps *down* a
 * rung after every boot that survives, so without a floor a phone would climb
 * to level 0, fail, drop back, survive, climb again -- oscillating between a
 * working page and a reload loop. `?safe=0` still overrides it outright for
 * anyone who wants to try.
 */
const MOBILE_FLOOR = 1;

export function enterSafeMode(params: URLSearchParams, mobile: boolean): SafeMode {
  const floor = mobile ? MOBILE_FLOOR : 0;

  const forced = params.get('safe');
  if (forced !== null) {
    const level = Math.max(0, Math.min(MAX_SAFE_LEVEL, Number(forced) || 0));
    drop(KEY);
    write(LEVEL_KEY, String(level));
    return { level, degraded: false, armStable: () => { /* explicit choice */ } };
  }

  const crashed = read(KEY) !== null;
  const stored = Math.max(0, Math.min(MAX_SAFE_LEVEL, Number(read(LEVEL_KEY)) || 0));
  const previous = Math.max(floor, stored);
  const level = crashed ? Math.min(MAX_SAFE_LEVEL, previous + 1) : previous;

  write(LEVEL_KEY, String(level));
  // Armed for this attempt. Surviving clears it; dying leaves it set, and the
  // next boot reads it as a failure.
  write(KEY, String(Date.now()));

  if (crashed) {
    console.warn(`[safe] previous boot did not reach a steady state; dropping to level ${level}`);
  }

  return {
    level,
    degraded: crashed || level > 0,
    armStable(): void {
      setTimeout(() => {
        drop(KEY);
        // Climb back. A surviving run at level N means N was enough, not that
        // N is required forever -- and the reason for the crash is usually
        // fixed in a later build, or was another tab. Stepping down one rung
        // per good visit recovers the full model in a couple of loads.
        //
        // Without this a visitor who hit a bad build once stayed stripped
        // permanently, and every later improvement was invisible to them.
        if (level <= floor) drop(LEVEL_KEY);
        else write(LEVEL_KEY, String(Math.max(floor, level - 1)));
      }, STABLE_AFTER_MS);
    },
  };
}
