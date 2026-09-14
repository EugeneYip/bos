import * as THREE from 'three';

interface Pending {
  label: string;
  query: WebGLQuery;
  frame: number;
}

/**
 * Per-pass GPU timing via `EXT_disjoint_timer_query_webgl2`.
 *
 * Only one `TIME_ELAPSED` query may be active at a time, which suits a linear
 * post chain. Results are polled without blocking: a query started on frame N
 * is normally readable on frame N+2, so the numbers lag slightly but never
 * stall the pipeline. Falls back to a CPU-side estimate (which mostly measures
 * command submission, so it is reported separately) when the extension is
 * unavailable — Chrome only exposes it with `--enable-webgl-draft-extensions`
 * on some platforms.
 */
export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: Pending[] = [];
  private pool: WebGLQuery[] = [];
  private active: Pending | null = null;
  private frame = 0;
  /** Exponential moving average per label, milliseconds. */
  readonly ms = new Map<string, number>();
  private cpuStart = 0;
  private cpuLabel = '';
  readonly cpuMs = new Map<string, number>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext'];
  }

  get supported(): boolean { return this.ext !== null; }

  begin(label: string): void {
    this.cpuLabel = label;
    this.cpuStart = performance.now();
    if (!this.ext || this.active) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { label, query: q, frame: this.frame };
  }

  end(): void {
    if (this.cpuLabel) {
      const dt = performance.now() - this.cpuStart;
      const prev = this.cpuMs.get(this.cpuLabel) ?? dt;
      this.cpuMs.set(this.cpuLabel, prev + (dt - prev) * 0.1);
      this.cpuLabel = '';
    }
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Poll finished queries. Call once per frame after the chain has run. */
  collect(): void {
    this.frame++;
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    let i = 0;
    while (i < this.pending.length) {
      const p = this.pending[i];
      const available = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) { i++; continue; }
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        const prev = this.ms.get(p.label);
        // Fast attack on first sample, then a gentle EMA so the HUD is stable.
        this.ms.set(p.label, prev === undefined ? ms : prev + (ms - prev) * 0.08);
      }
      this.pool.push(p.query);
      this.pending.splice(i, 1);
    }
    // Bound the pending list if the driver never reports (defensive).
    if (this.pending.length > 64) {
      for (const p of this.pending.splice(0, 32)) this.gl.deleteQuery(p.query);
    }
  }

  total(exclude: string[] = []): number {
    let t = 0;
    for (const [k, v] of this.ms) if (!exclude.includes(k)) t += v;
    return t;
  }

  dispose(): void {
    for (const q of this.pool) this.gl.deleteQuery(q);
    for (const p of this.pending) this.gl.deleteQuery(p.query);
    this.pool.length = 0;
    this.pending.length = 0;
  }
}
