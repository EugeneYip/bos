import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { QualityTier } from '../core/config';
import './hud.css';
import { el, append, clear, icon, clockLabel, dayLabel, compactNumber, reducedMotion, safeRead, safeStore } from './dom';
import { ICONS } from './icons';
import { row, slider, segmented, toggle, pill, hint, type HudHost, type SliderHandle } from './widgets';
import { buildIndex, baseIndex, type IndexEntry } from './landmarks';
import { solarPosition, sunTimes } from './solar';

/**
 * The on-screen interface.
 *
 * Deliberately collapsed to a small dock so the city is never obscured; panels
 * open over it on demand. Everything drives other modules through `ctx.emit`
 * rather than reaching into them, so the HUD stays decoupled and degrades
 * gracefully when a subsystem has not loaded.
 *
 * Event contracts consumed by other modules:
 *   camera:set-mode   (ModeId)          camera:fly-to     (FlyToRequest)
 *   camera:play-tour  ({id, speed})     photo-mode        (boolean)
 *   weather           (WeatherPreset)   post:set          ({key, value})
 *   time-changed      (hours)
 */

type PanelId = 'time' | 'view' | 'quality' | 'places' | null;
const TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/**
 * The onboarding key list. `hud.css` styles this as a `dl` of `dt`/`dd` pairs
 * with real `kbd` elements, which is also the correct semantics for a list of
 * key bindings.
 */
function keyList(rows: Array<[string[], string]>): HTMLElement {
  const dl = el('dl', { class: 'bh-keys' });
  for (const [keys, desc] of rows) {
    const dt = el('dt');
    for (const k of keys) dt.appendChild(el('kbd', { class: 'bh-kbd' }, k));
    dl.append(dt, el('dd', {}, desc));
  }
  return dl;
}

export class Hud implements WorldModule, HudHost {
  readonly name = 'Hud';
  ctx!: Ctx;

  private root!: HTMLElement;
  private dock!: HTMLElement;
  private panel!: HTMLElement;
  private panelBody!: HTMLElement;
  private panelHead!: HTMLElement;
  private statsEl!: HTMLElement;
  private clockEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private compass!: SVGSVGElement;

  private open: PanelId = null;
  private showStats = false;
  private hidden = false;
  private playing = false;
  private daySpeed = 120; // simulated seconds per real second
  private timeSlider?: SliderHandle;
  private index: IndexEntry[] = baseIndex();
  private fpsHistory: number[] = [];
  private lastStatsPaint = 0;

  async init(ctx: Ctx): Promise<void> {
    this.ctx = ctx;

    const params = new URLSearchParams(location.search);
    if (params.get('ui') === 'off') {
      this.hidden = true;
      return; // build nothing at all — clean captures cost zero DOM
    }

    this.build(ctx);
    this.bindKeys();
    this.maybeOnboard();

    // The landmark index is assembled from the Landmarks registry when it
    // exists, falling back to the curated list and the QA viewpoints.
    buildIndex()
      .then((list) => { this.index = list; if (this.open === 'places') this.renderPanel(); })
      .catch(() => { /* keep the base index */ });
  }

  /* ------------------------------------------------------------- construction */

  private build(ctx: Ctx): void {
    this.root = el('div', { class: 'bh-root' });

    this.clockEl = el('div', { class: 'bh-clock' });
    this.compass = icon(ICONS.orbit, 18);
    this.compass.classList.add('bh-map-n');

    const btn = (id: Exclude<PanelId, null>, label: string, path: string): HTMLElement => {
      const b = el('button', { class: 'bh-btn', type: 'button', title: label, 'aria-label': label });
      b.append(icon(path, 17));
      b.addEventListener('click', () => this.togglePanel(id));
      b.dataset.panel = id;
      return b;
    };

    this.dock = el(
      'div',
      { class: 'bh-dock', role: 'toolbar', 'aria-label': 'View controls' },
      el('div', { class: 'bh-dock-group' }, this.clockEl),
      el('div', { class: 'bh-sep' }),
      el(
        'div',
        { class: 'bh-dock-group' },
        btn('time', 'Time of day', ICONS.clock),
        btn('view', 'Camera', ICONS.camera),
        btn('places', 'Landmarks', ICONS.pin),
        btn('quality', 'Settings', ICONS.sliders),
      ),
      el('div', { class: 'bh-sep' }),
      el('div', { class: 'bh-dock-group' }, this.compass),
    );

    this.panelHead = el('div', { class: 'bh-panel-head' });
    this.panelBody = el('div', { class: 'bh-panel-body' });
    this.panel = el(
      'div',
      { class: 'bh-panel bh-glass bh-hidden', role: 'dialog', 'aria-modal': 'false' },
      this.panelHead,
      this.panelBody,
      el(
        'div',
        { class: 'bh-panel-foot bh-attr' },
        el('span', {}, 'Geometry © '),
        el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'),
        el('span', {}, ' contributors (ODbL) · Elevation USGS 3DEP / SRTM'),
      ),
    );

    this.statsEl = el('div', { class: 'bh-stats bh-glass bh-hidden', 'aria-live': 'off' });
    this.toastEl = el('div', { class: 'bh-toast bh-hidden', role: 'status' });

    append(this.root, [this.panel, this.dock, this.statsEl, this.toastEl]);
    document.body.appendChild(this.root);
    void ctx;
  }

  /* ------------------------------------------------------------------- panels */

  private togglePanel(id: PanelId): void {
    this.open = this.open === id ? null : id;
    this.panel.classList.toggle('bh-hidden', this.open === null);
    for (const b of this.dock.querySelectorAll<HTMLElement>('[data-panel]')) {
      b.classList.toggle('bh-accent', b.dataset.panel === this.open);
    }
    if (this.open) this.renderPanel();
  }

  closePanel(): void {
    this.open = null;
    this.panel.classList.add('bh-hidden');
    for (const b of this.dock.querySelectorAll<HTMLElement>('[data-panel]')) b.classList.remove('bh-accent');
  }

  private renderPanel(): void {
    clear(this.panelHead);
    clear(this.panelBody);
    const title = { time: 'Time & weather', view: 'Camera', quality: 'Quality', places: 'Landmarks' }[this.open!];
    const close = el('button', { class: 'bh-btn', type: 'button', 'aria-label': 'Close' }, '×');
    close.addEventListener('click', () => this.closePanel());
    append(this.panelHead, [el('h2', {}, title), close]);

    if (this.open === 'time') this.renderTime();
    else if (this.open === 'view') this.renderView();
    else if (this.open === 'quality') this.renderQuality();
    else if (this.open === 'places') this.renderPlaces();
  }

  private renderTime(): void {
    const ctx = this.ctx;

    this.timeSlider = slider({
      label: 'Time of day', sky: true,
      min: 0, max: 24, step: 0.01, value: ctx.timeOfDay,
      format: clockLabel,
      onInput: (v) => {
        ctx.timeOfDay = v;
        ctx.emit('time-changed', v);
        this.paintClock();
      },
    });

    const play = toggle('Animate day cycle', this.playing, (v) => { this.playing = v; });
    const speed = slider({
      label: 'Cycle speed',
      min: 10, max: 1800, step: 10, value: this.daySpeed,
      format: (v) => `${Math.round(v)}\u00d7`,
      onInput: (v) => { this.daySpeed = v; },
    });

    const dayRow = slider({
      label: 'Date',
      min: 1, max: 365, step: 1, value: ctx.dayOfYear,
      format: dayLabel,
      onInput: (v) => {
        ctx.dayOfYear = Math.round(v);
        ctx.emit('time-changed', ctx.timeOfDay);
      },
    });

    const weather = segmented<'clear' | 'scattered' | 'overcast' | 'storm'>({
      label: 'Weather',
      options: [
        { id: 'clear', label: 'Clear' },
        { id: 'scattered', label: 'Scattered' },
        { id: 'overcast', label: 'Overcast' },
        { id: 'storm', label: 'Storm' },
      ],
      value: (ctx.stats['sky.weather'] as 'clear') ?? 'clear',
      onChange: (v) => { ctx.emit('weather', v); this.toast(`Weather: ${v}`); },
    });

    const t = sunTimes(ctx.dayOfYear);
    const sp = solarPosition(ctx.timeOfDay, ctx.dayOfYear);
    const readout = el(
      'div',
      { class: 'bh-readout bh-readout-rows' },
      el('div', {}, el('span', { class: 'bh-label' }, 'Sun elevation'), el('span', { class: 'bh-value' }, `${sp.elevation.toFixed(1)}°`)),
      el('div', {}, el('span', { class: 'bh-label' }, 'Azimuth'), el('span', { class: 'bh-value' }, `${sp.azimuth.toFixed(1)}°`)),
      el('div', {}, el('span', { class: 'bh-label' }, 'Sunrise'), el('span', { class: 'bh-value' }, t ? clockLabel(t.sunrise) : '—')),
      el('div', {}, el('span', { class: 'bh-label' }, 'Sunset'), el('span', { class: 'bh-value' }, t ? clockLabel(t.sunset) : '—')),
    );

    append(this.panelBody, [
      this.timeSlider.root, play.root, speed.root, dayRow.root,
      weather.root,
      readout,
      hint('Boston sits at 42.36°N, so the sun swings from 24° at the winter solstice to 71° at the summer one.'),
    ]);
  }

  private renderView(): void {
    const ctx = this.ctx;
    const mode = segmented<'orbit' | 'fly' | 'walk' | 'drive' | 'cinematic'>({
      label: 'Camera mode',
      options: [
        { id: 'orbit', label: 'Orbit' },
        { id: 'fly', label: 'Fly' },
        { id: 'walk', label: 'Walk' },
        { id: 'drive', label: 'Drive' },
        { id: 'cinematic', label: 'Tour' },
      ],
      value: 'orbit',
      onChange: (v) => { ctx.emit('camera:set-mode', v); this.toast(`${v} camera`); },
    });

    const tours = el('div', { class: 'bh-tour' });
    for (const [id, label] of [
      ['charles', 'Down the Charles'],
      ['harbor', 'Into the harbour'],
      ['freedom', 'The Freedom Trail'],
    ] as const) {
      const b = el('button', { class: 'bh-btn bh-tour-row', type: 'button' }, label);
      b.addEventListener('click', () => { ctx.emit('camera:play-tour', { id }); this.closePanel(); });
      tours.appendChild(b);
    }

    const photo = toggle('Photo mode', false, (v) => {
      ctx.emit('photo-mode', v);
      this.root.classList.toggle('bh-photo', v);
    });

    append(this.panelBody, [
      mode.root,
      row('Cinematic tours', tours).root,
      photo.root,
      hint('Drag to orbit, scroll to zoom. In fly mode use W A S D with Q and E for altitude; hold Shift to boost.'),
    ]);
  }

  private renderQuality(): void {
    const ctx = this.ctx;
    const app = (window as unknown as {
      __boston?: {
        setQuality(t: QualityTier): void;
        setResolution(s: number | null): void;
        detectedTier: QualityTier;
        gpu: string;
        resolutionState: { ratio: number; explicit: boolean; dpr: number };
      };
    }).__boston;

    const tier = segmented<QualityTier>({
      label: 'Quality preset',
      options: TIERS.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) })),
      value: ctx.tier,
      onChange: (v) => {
        app?.setQuality(v);
        this.toast(`Quality: ${v}`);
      },
    });
    // The tier can also move without a click — a URL override, or a future
    // automatic downgrade — so follow it rather than assume this panel is the
    // only thing that changes it.
    ctx.on('quality-changed', (v) => tier.set(v as QualityTier));

    const effects = el('div');
    for (const [key, label, def] of [
      ['bloom', 'Bloom', true],
      ['ssao', 'Ambient occlusion', true],
      ['ssr', 'Screen-space reflections', true],
      ['taa', 'Temporal antialiasing', true],
      ['motionBlur', 'Motion blur', true],
      ['dof', 'Depth of field', false],
      ['grain', 'Film grain', true],
    ] as const) {
      effects.appendChild(toggle(label, def, (v) => ctx.emit('post:set', { key, value: v })).root);
    }

    // Resolution is its own control, not a consequence of the preset. The tier
    // caps pixels per CSS pixel, and `low` caps it at 1 — so on a Retina panel
    // the frame was drawn at a quarter of the screen's pixels and stretched
    // over it. Plenty of machines that cannot afford four shadow cascades can
    // comfortably afford their own screen's resolution, and being unable to say
    // so is the single most visible thing a settings panel can get wrong.
    const dpr = app?.resolutionState.dpr ?? 1;
    const RES: Array<{ id: string; label: string; value: number | null }> = [
      { id: 'auto', label: 'Auto', value: null },
      { id: 'half', label: '50%', value: 0.5 },
      { id: 'one', label: '100%', value: 1 },
    ];
    if (dpr > 1.05) RES.push({ id: 'native', label: `Native ${dpr.toFixed(1)}x`, value: dpr });
    const state = app?.resolutionState;
    const current = !state || !state.explicit
      ? 'auto'
      : (RES.find((r) => r.value !== null && Math.abs(r.value - state.ratio) < 0.05)?.id ?? 'auto');

    const res = segmented<string>({
      label: 'Resolution',
      options: RES.map((r) => ({ id: r.id, label: r.label })),
      value: current,
      onChange: (v) => {
        const pick = RES.find((r) => r.id === v);
        app?.setResolution(pick ? pick.value : null);
        this.toast(`Resolution: ${pick?.label ?? 'auto'}`);
      },
    });

    append(this.panelBody, [
      tier.root,
      el('div', { class: 'bh-group-head' }, 'Resolution'),
      res.root,
      el('div', { class: 'bh-group-head' }, 'Effects'),
      effects,
      hint(
        `${app?.gpu ? `Reported GPU: ${app.gpu}. ` : 'Your browser masks the GPU name, so the tier was guessed from a capability probe. '}`
        + `Detected as ${app?.detectedTier ?? ctx.tier}; your choice is remembered across reloads. `
        + 'Append ?q=low / medium / high / ultra to force one from the URL.',
      ),
    ]);
  }

  private renderPlaces(): void {
    const ctx = this.ctx;
    const list = el('div', { class: 'bh-list', role: 'listbox' });
    const search = el('input', {
      class: 'bh-search', type: 'search', placeholder: 'Search landmarks…', 'aria-label': 'Search landmarks',
    }) as HTMLInputElement;

    const paint = (q: string): void => {
      clear(list);
      const needle = q.trim().toLowerCase();
      const hits = needle ? this.index.filter((e) => e.search.includes(needle)) : this.index;
      if (!hits.length) {
        list.appendChild(el('div', { class: 'bh-empty' }, 'Nothing matches that.'));
        return;
      }
      let group = '';
      for (const e of hits.slice(0, 80)) {
        if (e.group !== group) {
          group = e.group;
          list.appendChild(el('div', { class: 'bh-group-head' }, group));
        }
        const item = el('button', { class: 'bh-item', type: 'button', role: 'option' },
          el('span', {}, e.name));
        item.addEventListener('click', () => {
          const f = e.frame(ctx);
          if (f.hour !== undefined) { ctx.timeOfDay = f.hour; ctx.emit('time-changed', f.hour); }
          ctx.emit('camera:fly-to', { pos: f.pos, target: f.target, label: e.name });
          this.closePanel();
          this.toast(e.name);
        });
        list.appendChild(item);
      }
    };

    search.addEventListener('input', () => paint(search.value));
    paint('');
    append(this.panelBody, [el('div', { class: 'bh-search-wrap' }, search), list]);
    queueMicrotask(() => search.focus());
  }

  /* -------------------------------------------------------------- interaction */

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'h' || e.key === 'H') {
        this.hidden = !this.hidden;
        this.root.classList.toggle('bh-hidden', this.hidden);
        e.preventDefault();
      } else if (e.key === '`') {
        this.showStats = !this.showStats;
        this.statsEl.classList.toggle('bh-hidden', !this.showStats);
        e.preventDefault();
      } else if (e.key === 'Escape' && this.open) {
        this.closePanel();
        e.preventDefault();
      }
    });
  }

  private maybeOnboard(): void {
    if (safeRead('bh-onboarded') === '1') return;
    const scrim = el('div', { class: 'bh-onboard-scrim' });
    const card = el(
      'div',
      { class: 'bh-onboard bh-glass' },
      el('h2', {}, 'Boston'),
      el('p', {}, 'Every building, road and shoreline here is real geographic data from OpenStreetMap, on USGS terrain.'),
      keyList([
        [['Drag'], 'Orbit the city'],
        [['Scroll'], 'Zoom toward the cursor'],
        [['W', 'A', 'S', 'D'], 'Fly, with Q and E for altitude'],
        [['H'], 'Hide the interface'],
        [['`'], 'Performance overlay'],
      ]),
    );
    const go = el('button', { class: 'bh-btn bh-accent', type: 'button' }, 'Explore');
    go.addEventListener('click', () => {
      safeStore('bh-onboarded', '1');
      scrim.remove();
    });
    card.appendChild(go);
    scrim.appendChild(card);
    this.root.appendChild(scrim);
    queueMicrotask(() => go.focus());
  }

  toast(message: string, ms = 1900): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('bh-hidden');
    window.clearTimeout((this.toastEl as unknown as { _t?: number })._t);
    (this.toastEl as unknown as { _t?: number })._t = window.setTimeout(
      () => this.toastEl.classList.add('bh-hidden'), ms,
    );
  }

  /* ------------------------------------------------------------------ per-frame */

  private paintClock(): void {
    const sp = solarPosition(this.ctx.timeOfDay, this.ctx.dayOfYear);
    this.clockEl.textContent = clockLabel(this.ctx.timeOfDay);
    this.clockEl.title = `Sun ${sp.elevation.toFixed(0)}° above the horizon`;
  }

  update(dt: number, ctx: Ctx): void {
    if (!this.root) return;

    if (this.playing) {
      ctx.timeOfDay = (ctx.timeOfDay + (dt * this.daySpeed) / 3600) % 24;
      ctx.emit('time-changed', ctx.timeOfDay);
      this.timeSlider?.set(ctx.timeOfDay);
    }
    this.paintClock();

    // Compass needle follows the camera's heading.
    const dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
    this.compass.style.transform = `rotate(${-heading}deg)`;

    if (!this.showStats) return;
    this.fpsHistory.push(Number(ctx.stats.fps) || 0);
    if (this.fpsHistory.length > 90) this.fpsHistory.shift();
    // Repaint at 6 Hz; a per-frame DOM write is its own performance problem.
    if (ctx.elapsed - this.lastStatsPaint < 0.16) return;
    this.lastStatsPaint = ctx.elapsed;
    this.paintStats(ctx);
  }

  private paintStats(ctx: Ctx): void {
    const avg = this.fpsHistory.reduce((a, b) => a + b, 0) / Math.max(this.fpsHistory.length, 1);
    const low = Math.min(...this.fpsHistory);
    const rows: [string, string][] = [
      ['fps', `${Math.round(avg)} (min ${Math.round(low)})`],
      ['frame', `${(1000 / Math.max(avg, 1)).toFixed(1)} ms`],
      ['draw calls', String(ctx.stats.calls ?? 0)],
      ['triangles', compactNumber(Number(ctx.stats.tris) || 0)],
    ];
    for (const [k, v] of Object.entries(ctx.stats)) {
      if (['fps', 'calls', 'tris'].includes(k)) continue;
      rows.push([k, typeof v === 'number' ? compactNumber(v) : String(v)]);
    }
    clear(this.statsEl);
    const grid = el('div', { class: 'bh-stat-grid' });
    for (const [k, v] of rows) {
      grid.append(el('span', { class: 'bh-label' }, k), el('span', { class: 'bh-value' }, v));
    }
    this.statsEl.appendChild(grid);
  }

  dispose(): void {
    this.root?.remove();
  }
}
