/** 16×16 stroke icon paths. Drawn on a 1.35px grid so they sit together. */
export const ICONS = {
  orbit:
    '<circle cx="8" cy="8" r="2.4"/><ellipse cx="8" cy="8" rx="6.6" ry="3" transform="rotate(-22 8 8)"/>',
  fly:
    '<path d="M1.6 8.4 14.4 2.2 9.7 14.1l-2-4.6z"/><path d="M7.7 9.5 14.4 2.2"/>',
  walk:
    '<circle cx="8.9" cy="2.6" r="1.35"/><path d="M9 5.3 6.9 7.6l.7 2.6L6 14.2"/><path d="M7.6 10.2 10 12l.6 2.2"/><path d="M6.9 7.6 4.6 8.6"/><path d="M9 5.3l2.3 1.5.9 2.1"/>',
  drive:
    '<path d="M2 10.2h12"/><path d="M3.2 10.2 4.5 6.3A1.4 1.4 0 0 1 5.8 5.4h4.4a1.4 1.4 0 0 1 1.3.9l1.3 3.9"/><path d="M2 10.2v2.1h1.9v-2.1"/><path d="M12.1 10.2v2.1H14v-2.1"/><circle cx="5" cy="10.2" r=".75"/><circle cx="11" cy="10.2" r=".75"/>',
  film:
    '<rect x="1.6" y="3.2" width="12.8" height="9.6" rx="1.3"/><path d="M5 3.2v9.6M11 3.2v9.6M1.6 8h12.8"/>',
  clock:
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.4V8l2.4 1.6"/>',
  cloud:
    '<path d="M4.6 12.2a3.1 3.1 0 0 1-.3-6.2 4 4 0 0 1 7.6-.6 2.9 2.9 0 0 1-.5 6.8z"/>',
  sliders:
    '<path d="M2.4 4.6h11.2M2.4 11.4h11.2"/><circle cx="6" cy="4.6" r="1.6"/><circle cx="10.4" cy="11.4" r="1.6"/>',
  pin:
    '<path d="M8 14.2s4.6-4.3 4.6-7.6a4.6 4.6 0 0 0-9.2 0C3.4 9.9 8 14.2 8 14.2z"/><circle cx="8" cy="6.5" r="1.7"/>',
  camera:
    '<path d="M1.8 5.6h2.6l1-1.7h5.2l1 1.7h2.6a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H1.8a1 1 0 0 1-1-1V6.6a1 1 0 0 1 1-1z"/><circle cx="8" cy="9.3" r="2.6"/>',
  help:
    '<circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.7-.8 1.3v.3"/><path d="M8 12.05v.01"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  play: '<path d="M5.2 3.4 12 8l-6.8 4.6z"/>',
  pause: '<path d="M5.8 3.6v8.8M10.2 3.6v8.8"/>',
  search: '<circle cx="7.1" cy="7.1" r="4.6"/><path d="M10.5 10.5 14 14"/>',
  chart: '<path d="M2 13.2h12"/><path d="M3.6 11V7.3M6.8 11V4.2M10 11V8.6M13.2 11V5.6"/>',
  download: '<path d="M8 2.4v7.6"/><path d="M5.1 7.3 8 10.2l2.9-2.9"/><path d="M2.6 12.4h10.8"/>',
  reset: '<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.7"/><path d="M2.4 2.6v3.2h3.2"/>',
  eye: '<path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8z"/><circle cx="8" cy="8" r="1.9"/>',
} as const;

export type IconName = keyof typeof ICONS;
