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
 * asks for less. Three rungs, and the bottom one is deliberately austere
 * enough to run anywhere.
 *
 * The visitor can always override it: `?safe=0` forces the full model,
 * `?safe=2` forces the bottom rung, and reaching a steady state at any level
 * resets the ladder so the next visit starts from the top again.
 */

const KEY = 'bh-boot';
const LEVEL_KEY = 'bh-safe';
/** How long a session must survive before its boot counts as successful. */
const STABLE_AFTER_MS = 20000;
/** Rungs below the full model. */
export const MAX_SAFE_LEVEL = 2;

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

export function enterSafeMode(params: URLSearchParams): SafeMode {
  const forced = params.get('safe');
  if (forced !== null) {
    const level = Math.max(0, Math.min(MAX_SAFE_LEVEL, Number(forced) || 0));
    drop(KEY);
    write(LEVEL_KEY, String(level));
    return { level, degraded: false, armStable: () => { /* explicit choice */ } };
  }

  const crashed = read(KEY) !== null;
  const previous = Math.max(0, Math.min(MAX_SAFE_LEVEL, Number(read(LEVEL_KEY)) || 0));
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
        // A level that works is not a permanent sentence, but it is the
        // sensible place for the *next* visit to start. Only a clean run at
        // level 0 clears the ladder entirely.
        if (level === 0) drop(LEVEL_KEY);
      }, STABLE_AFTER_MS);
    },
  };
}
