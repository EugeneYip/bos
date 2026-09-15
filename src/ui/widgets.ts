/** Reusable HUD controls. Every one is a real, focusable, labelled element. */
import type { Ctx } from '../core/Context';
import { el, icon } from './dom';
import { ICONS } from './icons';

export interface HudHost {
  ctx: Ctx;
  toast(message: string, ms?: number): void;
  closePanel(): void;
}

export interface Row {
  root: HTMLElement;
  value: HTMLElement;
}

/** Label on the left, live value on the right, control underneath. */
export function row(label: string, control: Node, initialValue = ''): Row {
  const value = el('span', { class: 'bh-value' }, initialValue);
  const root = el(
    'div',
    { class: 'bh-row' },
    el('div', { class: 'bh-row-head' }, el('span', { class: 'bh-label' }, label), value),
    control,
  );
  return { root, value };
}

export interface SliderOpts {
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  sky?: boolean;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export interface SliderHandle {
  root: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
  set(v: number, silent?: boolean): void;
}

export function slider(opts: SliderOpts): SliderHandle {
  const input = el('input', {
    type: 'range',
    class: `bh-slider${opts.sky ? ' bh-sky' : ''}`,
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
    'aria-label': opts.label,
  }) as HTMLInputElement;

  const fmt = opts.format ?? ((v: number) => String(v));
  const r = row(opts.label, input, fmt(opts.value));

  const paint = (v: number): void => {
    const p = ((v - opts.min) / (opts.max - opts.min)) * 100;
    input.style.setProperty('--p', `${p.toFixed(2)}%`);
    r.value.textContent = fmt(v);
  };
  paint(opts.value);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    opts.onInput(v);
  });

  return {
    root: r.root,
    input,
    value: r.value,
    set(v: number, silent = true) {
      input.value = String(v);
      paint(v);
      if (!silent) opts.onInput(v);
    },
  };
}

export interface SegmentedOpts<T extends string> {
  options: Array<{ id: T; label: string; title?: string; disabled?: boolean }>;
  value: T;
  label: string;
  onChange: (id: T) => void;
}

export interface SegmentedHandle<T extends string> {
  root: HTMLElement;
  set(v: T): void;
  setDisabled(id: T, disabled: boolean, title?: string): void;
}

/**
 * A radio group.
 *
 * Clicking a segment moves the selection *itself* before calling `onChange`.
 * That sounds too obvious to write down, but it was not the case here: the
 * handle exposed a `set()` that nobody called, so every one of these — quality
 * preset, weather, camera mode — fired its change and then kept the highlight
 * exactly where it was. The quality preset genuinely worked; it simply looked
 * like it did not, which is the same thing to whoever is clicking it.
 *
 * `set()` remains for the cases where something else owns the value and the
 * group has to follow it.
 */
export function segmented<T extends string>(opts: SegmentedOpts<T>): SegmentedHandle<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const group = el('div', { class: 'bh-seg', role: 'radiogroup', 'aria-label': opts.label });

  const select = (v: T): void => {
    for (const [id, b] of buttons) {
      const on = id === v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    }
  };

  for (const o of opts.options) {
    const b = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(o.id === opts.value),
      title: o.title ?? o.label,
      class: o.id === opts.value ? 'is-active' : '',
      disabled: o.disabled,
      onclick: () => { select(o.id); opts.onChange(o.id); },
    }, o.label) as HTMLButtonElement;
    buttons.set(o.id, b);
    group.appendChild(b);
  }
  return {
    root: group,
    set: select,
    setDisabled(id: T, disabled: boolean, title?: string) {
      const b = buttons.get(id);
      if (!b) return;
      b.disabled = disabled;
      if (title) b.title = title;
    },
  };
}

export interface ToggleHandle {
  root: HTMLButtonElement;
  set(on: boolean): void;
  setEnabled(on: boolean): void;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): ToggleHandle {
  let on = value;
  const knob = el('span', { class: 'bh-knob' });
  const root = el('button', {
    type: 'button',
    class: 'bh-toggle',
    'aria-pressed': String(on),
    onclick: () => {
      on = !on;
      root.setAttribute('aria-pressed', String(on));
      onChange(on);
    },
  }, el('span', {}, label), knob) as HTMLButtonElement;
  return {
    root,
    set(v: boolean) {
      on = v;
      root.setAttribute('aria-pressed', String(on));
    },
    setEnabled(enabled: boolean) {
      root.disabled = !enabled;
    },
  };
}

export function pill(
  label: string,
  onClick: () => void,
  opts: { primary?: boolean; iconName?: keyof typeof ICONS; title?: string } = {},
): HTMLButtonElement {
  const b = el('button', {
    type: 'button',
    class: `bh-pill${opts.primary ? ' is-primary' : ''}`,
    title: opts.title,
    onclick: onClick,
  }) as HTMLButtonElement;
  if (opts.iconName) b.appendChild(icon(ICONS[opts.iconName], 13));
  b.appendChild(document.createTextNode(label));
  return b;
}

export function hint(text: string): HTMLElement {
  return el('p', { class: 'bh-hint', style: 'margin:0' }, text);
}
