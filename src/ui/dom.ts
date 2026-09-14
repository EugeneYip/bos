/** Tiny DOM helpers. No framework — the project doesn't have one and shouldn't. */

type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  style?: string;
  [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'style') node.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2), v as EventListener);
      } else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Inline SVG from a 16×16 stroke path. */
export function icon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.35');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}

/** Two-digit zero pad. */
export function pad2(n: number): string {
  return n < 10 ? `0${Math.floor(n)}` : String(Math.floor(n));
}

/** 0–24 decimal hours -> "7:42 pm". */
export function clockLabel(hours: number): string {
  const h24 = ((hours % 24) + 24) % 24;
  const h = Math.floor(h24);
  const m = Math.floor((h24 - h) * 60);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${suffix}`;
}

/** Day-of-year (1–365) -> "14 Sep". */
export function dayLabel(doy: number): string {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(Math.max(1, Math.min(365, Math.round(doy))));
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

export function metres(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)} km`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} km`;
  return `${Math.round(v)} m`;
}

export function compactNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Reads + tracks `prefers-reduced-motion`. */
export function reducedMotion(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
}

export function safeStore(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function safeRead(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
