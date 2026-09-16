/**
 * Is any of the water surface actually on screen?
 *
 * Not "is it in the frustum" — that question is cheap and useless here. From a
 * street in the Back Bay the Charles is squarely in the frustum and squarely
 * behind four blocks of buildings, and `Water`'s screen-coverage estimate,
 * which cannot see occlusion, reports 52% where the truth is zero. The whole
 * point of asking is to skip the planar reflection, which is a quarter of the
 * frame, so a test that cannot tell those apart does not help.
 *
 * So ask the depth test, which has already worked it out: wrap the water draws
 * in a WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE` query. Occluded water fails
 * depth before it is shaded, no samples pass, and the answer is exact.
 *
 * ## Getting one query around all of it
 *
 * `onBeforeRender` / `onAfterRender` fire per mesh, and the surface is 128 of
 * them, so the hooks give 128 sequential pairs rather than one span. Opening a
 * query per mesh would mean polling 128 result objects a frame; opening one at
 * the first mesh and never closing it would swallow the entire rest of the
 * frame, including full-screen post quads, and always answer yes.
 *
 * The span is closed instead by a sentinel: a zero-area triangle at
 * `renderOrder` one past the water's, `frustumCulled = false` so it is always
 * in the render list, `colorWrite` and `depthWrite` off so it cannot tint or
 * occlude anything, and no area so it cannot contribute a sample of its own.
 * Its `onBeforeRender` is the hook that says "the water is finished".
 *
 * ## Arming
 *
 * The scene is rendered more than once per frame — the main pass, then a
 * g-buffer pass with an override material which the water joins, via
 * `userData.ssr`, on the SSR layer. Only the first run is the one whose depth
 * test reflects what the viewer sees, so a query is armed once per frame by
 * {@link beginFrame} and disarmed the moment it opens.
 *
 * ## Failing safe
 *
 * Every unknown answers "visible", which draws the reflection: a wasted pass
 * costs 6 ms, a wrongly skipped one costs a missing reflection on water the
 * viewer is looking at. Results arrive a frame or two late, so visibility is
 * latched on immediately and requires several consecutive misses to latch off.
 */

const MISSES_TO_HIDE = 3;

interface Pending {
  query: WebGLQuery;
  frame: number;
}

export class SurfaceVisibility {
  private gl: WebGL2RenderingContext | null = null;
  private pool: WebGLQuery[] = [];
  private inFlight: Pending[] = [];
  private open: WebGLQuery | null = null;
  private armed = false;
  private frame = 0;
  private misses = 0;

  /** Whether any water fragment survived the depth test recently. */
  visible = true;
  /** Completed queries whose answer was 'nothing passed'. */
  hidden = 0;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const g = gl as WebGL2RenderingContext;
    if (typeof g.createQuery !== 'function') return;
    if (typeof g.ANY_SAMPLES_PASSED_CONSERVATIVE !== 'number') return;
    this.gl = g;
  }

  get supported(): boolean {
    return this.gl !== null;
  }

  /**
   * Call once per frame, before the render. Drains finished queries and arms
   * the next one.
   */
  beginFrame(): void {
    const gl = this.gl;
    if (!gl) return;

    // A span left open means the sentinel never drew. Close it and throw the
    // result away rather than let the next `beginQuery` fail on it.
    if (this.open) {
      try {
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      } catch {
        /* context lost */
      }
      this.pool.push(this.open);
      this.open = null;
    }

    while (this.inFlight.length) {
      const p = this.inFlight[0];
      if (p.frame === this.frame) break; // still being written
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inFlight.shift();
      const passed = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as boolean;
      this.pool.push(p.query);
      if (passed) {
        this.misses = 0;
        this.visible = true;
      } else {
        this.hidden++;
        if (++this.misses >= MISSES_TO_HIDE) this.visible = false;
      }
    }

    this.frame++;
    this.armed = true;
  }

  /** From the first water mesh's `onBeforeRender`. */
  begin(): void {
    const gl = this.gl;
    if (!gl || !this.armed || this.open) return;
    // Two queries in flight is plenty; results are a frame or two behind and
    // nothing here needs a backlog.
    if (this.inFlight.length >= 3) return;
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q);
    this.open = q;
    this.armed = false;
  }

  /** From the sentinel's `onBeforeRender`, once the water has all been drawn. */
  end(): void {
    const gl = this.gl;
    if (!gl || !this.open) return;
    gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    this.inFlight.push({ query: this.open, frame: this.frame });
    this.open = null;
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.open) {
      try {
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      } catch {
        /* context lost */
      }
      gl.deleteQuery(this.open);
      this.open = null;
    }
    for (const q of this.pool) gl.deleteQuery(q);
    for (const p of this.inFlight) gl.deleteQuery(p.query);
    this.pool.length = 0;
    this.inFlight.length = 0;
    this.gl = null;
  }
}
