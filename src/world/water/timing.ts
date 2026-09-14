/**
 * GPU timing for the water pass.
 *
 * `EXT_disjoint_timer_query_webgl2` is the only way to get an honest number
 * out of a deferred driver — wall-clock around `renderer.render` measures
 * command submission, not work. Results are not readable until the GPU has
 * drained, so spans are tagged with the frame they belong to, kept in a small
 * ring, and a frame's total is emitted once every one of its spans has come
 * back. The reported figure is an exponential moving average in milliseconds.
 *
 * Everything degrades to `supported === false` when the extension is missing,
 * which is the common case in some headless configurations — callers must
 * handle that rather than report a fabricated number.
 */

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface Span {
  query: WebGLQuery;
  frame: number;
}

export class GpuTimer {
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private pool: WebGLQuery[] = [];
  private inFlight: Span[] = [];
  private active = false;
  private frame = 0;
  private openThisFrame = 0;
  private expected = new Map<number, number>();
  private totals = new Map<number, number>();

  /** Smoothed GPU milliseconds for one frame's worth of spans. */
  ms = 0;
  private seeded = false;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext, private budget = 96) {
    const g = gl as WebGL2RenderingContext;
    if (typeof g.createQuery !== 'function') return;
    const ext = g.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    if (!ext) return;
    this.gl = g;
    this.ext = ext;
  }

  get supported(): boolean { return this.ext !== null; }

  /** Start a new frame. Call once per frame before anything is timed. */
  beginFrame(): void {
    if (!this.ext) return;
    if (this.openThisFrame > 0) this.expected.set(this.frame, this.openThisFrame);
    this.frame++;
    this.openThisFrame = 0;
  }

  begin(): void {
    const gl = this.gl;
    if (!gl || !this.ext || this.active) return;
    if (this.inFlight.length >= this.budget) return;
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.inFlight.push({ query: q, frame: this.frame });
    this.openThisFrame++;
    this.active = true;
  }

  end(): void {
    const gl = this.gl;
    if (!gl || !this.ext || !this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  /** Drain completed spans. Call once per frame. */
  poll(): void {
    const gl = this.gl;
    if (!gl || !this.ext) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.inFlight.length) {
      const s = this.inFlight[0];
      if (s.frame === this.frame) break; // still being written this frame
      if (!gl.getQueryParameter(s.query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inFlight.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(s.query, gl.QUERY_RESULT) as number;
        this.totals.set(s.frame, (this.totals.get(s.frame) ?? 0) + ns / 1e6);
      }
      this.pool.push(s.query);

      const want = this.expected.get(s.frame);
      if (want !== undefined) {
        const stillOpen = this.inFlight.some((o) => o.frame === s.frame);
        if (!stillOpen) {
          const sample = this.totals.get(s.frame) ?? 0;
          this.totals.delete(s.frame);
          this.expected.delete(s.frame);
          this.ms = this.seeded ? this.ms * 0.82 + sample * 0.18 : sample;
          this.seeded = true;
        }
      }
    }
    // Forget anything that fell behind so the maps cannot grow.
    for (const f of this.expected.keys()) {
      if (this.frame - f > 12) { this.expected.delete(f); this.totals.delete(f); }
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl || !this.ext) return;
    if (this.active) { try { gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch { /* context lost */ } }
    for (const q of this.pool) gl.deleteQuery(q);
    for (const s of this.inFlight) gl.deleteQuery(s.query);
    this.pool.length = 0;
    this.inFlight.length = 0;
  }
}
