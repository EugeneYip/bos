/**
 * Procedural geometry for Boston's street furniture.
 *
 * Everything is authored with its base at y=0 and at true real-world scale in
 * metres, so instances only need position, yaw and a small size jitter. Each
 * builder returns one or more parts tagged by material role, which the Props
 * module merges into a handful of instanced draw calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Role = 'metal' | 'darkmetal' | 'wood' | 'stone' | 'glass' | 'lamp' | 'signal';

export interface Part {
  geo: THREE.BufferGeometry;
  role: Role;
}

/** Merge-safe: three.js primitives disagree about indexing. */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  return out;
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(gs.map(flat), false)!;
}

const box = (w: number, h: number, d: number, y = 0, x = 0, z = 0): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
};

const tube = (r: number, h: number, y = 0, x = 0, z = 0, seg = 8): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
};

/**
 * The Boston "acorn" streetlamp — the cast-iron post with a fluted base and an
 * acorn-shaped luminaire that lines Beacon Hill, the Common and Back Bay.
 * 3.6 m to the light. Variant 1 is the taller twin-head Commonwealth Ave type,
 * variant 2 the plain modern cobra-head on arterials.
 */
export function streetlamp(variant: number): Part[] {
  const parts: Part[] = [];
  if (variant === 2) {
    // Cobra head: 9 m mast with a curved arm.
    const H = 9.0;
    parts.push({ geo: merge([tube(0.11, H, 0), tube(0.19, 0.6, 0)]), role: 'darkmetal' });
    const arm = new THREE.CylinderGeometry(0.07, 0.07, 2.4, 6);
    arm.rotateZ(Math.PI / 2.6);
    arm.translate(0.95, H - 0.5, 0);
    parts.push({ geo: arm, role: 'darkmetal' });
    const head = new THREE.BoxGeometry(0.9, 0.22, 0.42);
    head.translate(1.85, H - 1.35, 0);
    parts.push({ geo: head, role: 'lamp' });
    return parts;
  }

  const H = variant === 1 ? 4.6 : 3.6;
  // Fluted base, tapered shaft, collar.
  const base = merge([tube(0.2, 0.55, 0, 0, 0, 10), tube(0.14, 0.35, 0.55, 0, 0, 10)]);
  const shaft = new THREE.CylinderGeometry(0.055, 0.085, H - 0.9, 8);
  shaft.translate(0, 0.9 + (H - 0.9) / 2, 0);
  parts.push({ geo: merge([base, shaft]), role: 'darkmetal' });

  const heads = variant === 1 ? [-0.62, 0.62] : [0];
  for (const dx of heads) {
    if (variant === 1) {
      const arm = new THREE.CylinderGeometry(0.045, 0.045, 0.72, 6);
      arm.rotateZ(Math.PI / 2);
      arm.translate(dx * 0.5, H - 0.1, 0);
      parts.push({ geo: arm, role: 'darkmetal' });
    }
    // Acorn luminaire: a lathe profile, glowing.
    const prof: THREE.Vector2[] = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.17, 0.10), new THREE.Vector2(0.22, 0.30),
      new THREE.Vector2(0.19, 0.52), new THREE.Vector2(0.10, 0.66), new THREE.Vector2(0.001, 0.70),
    ];
    const acorn = new THREE.LatheGeometry(prof, 10);
    acorn.translate(dx, H - 0.1, 0);
    parts.push({ geo: acorn, role: 'lamp' });
    const finial = new THREE.ConeGeometry(0.06, 0.18, 6);
    finial.translate(dx, H + 0.66, 0);
    parts.push({ geo: finial, role: 'darkmetal' });
  }
  return parts;
}

/** Park bench: slatted wood on cast-iron ends, 1.8 m long. */
export function bench(variant: number): Part[] {
  const L = variant === 1 ? 2.1 : 1.75;
  const slats: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) slats.push(box(L, 0.045, 0.11, 0.44, 0, -0.18 + i * 0.13));
  for (let i = 0; i < 3; i++) {
    const b = box(L, 0.11, 0.045, 0.52 + i * 0.15, 0, 0.28);
    b.rotateX(-0.18);
    slats.push(b);
  }
  const ends: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    ends.push(box(0.06, 0.44, 0.55, 0, (sx * L) / 2 - sx * 0.06, 0.04));
    ends.push(box(0.06, 0.5, 0.07, 0.44, (sx * L) / 2 - sx * 0.06, 0.3));
  }
  return [
    { geo: merge(slats), role: 'wood' },
    { geo: merge(ends), role: 'darkmetal' },
  ];
}

/** Mast-arm traffic signal: 6 m pole, 4 m arm, three-aspect head. */
export function trafficSignal(): Part[] {
  const H = 6.0;
  const pole = merge([tube(0.09, H, 0), tube(0.16, 0.5, 0)]);
  const arm = new THREE.CylinderGeometry(0.07, 0.07, 4.0, 6);
  arm.rotateZ(Math.PI / 2);
  arm.translate(2.0, H - 0.35, 0);
  const housing = box(0.34, 0.95, 0.3, H - 1.75, 3.4, 0);
  const visors: THREE.BufferGeometry[] = [];
  const lenses: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const y = H - 1.05 - i * 0.3;
    const lens = new THREE.CylinderGeometry(0.1, 0.1, 0.05, 8);
    lens.rotateX(Math.PI / 2);
    lens.translate(3.4, y, 0.17);
    lenses.push(lens);
    visors.push(box(0.26, 0.06, 0.16, y + 0.1, 3.4, 0.22));
  }
  return [
    { geo: merge([pole, arm, housing, ...visors]), role: 'darkmetal' },
    { geo: merge(lenses), role: 'signal' },
  ];
}

/** Granite bollard, as around the Greenway and Faneuil Hall. */
export function bollard(variant: number): Part[] {
  if (variant === 1) {
    return [{ geo: merge([tube(0.11, 0.9, 0, 0, 0, 10), tube(0.14, 0.08, 0.9, 0, 0, 10)]), role: 'darkmetal' }];
  }
  const g = new THREE.CylinderGeometry(0.16, 0.19, 0.95, 8);
  g.translate(0, 0.475, 0);
  const cap = new THREE.SphereGeometry(0.16, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, 0.95, 0);
  return [{ geo: merge([g, cap]), role: 'stone' }];
}

/** Plinth-and-figure statue; deliberately abstract at this scale. */
export function statue(variant: number): Part[] {
  const plinthH = 1.3 + variant * 0.25;
  const plinth = merge([
    box(1.5, 0.22, 1.5, 0),
    box(1.2, plinthH, 1.2, 0.22),
    box(1.45, 0.16, 1.45, 0.22 + plinthH),
  ]);
  const top = 0.38 + plinthH;
  const figure: THREE.BufferGeometry[] = [];
  if (variant === 2) {
    // Equestrian.
    figure.push(box(0.55, 0.75, 1.7, top, 0, 0));
    for (const [dx, dz] of [[-0.2, -0.6], [0.2, -0.6], [-0.2, 0.6], [0.2, 0.6]] as const) {
      figure.push(box(0.14, 0.85, 0.14, top - 0.85, dx, dz));
    }
    figure.push(box(0.28, 0.5, 0.5, top + 0.6, 0, -0.75));
    figure.push(box(0.4, 0.95, 0.32, top + 0.7, 0, 0.1));
  } else {
    const body = new THREE.CylinderGeometry(0.22, 0.3, 1.5, 8);
    body.translate(0, top + 0.75, 0);
    figure.push(body);
    const head = new THREE.SphereGeometry(0.16, 8, 6);
    head.translate(0, top + 1.62, 0);
    figure.push(head);
    if (variant === 1) figure.push(box(0.12, 0.9, 0.12, top + 0.9, 0.3, 0));
  }
  return [
    { geo: plinth, role: 'stone' },
    { geo: merge(figure), role: 'metal' },
  ];
}

/** Tiered basin fountain. */
export function fountain(): Part[] {
  const stone: THREE.BufferGeometry[] = [];
  stone.push(tube(2.6, 0.45, 0, 0, 0, 20));
  stone.push(tube(2.35, 0.12, 0.45, 0, 0, 20));
  stone.push(tube(0.42, 1.1, 0.45, 0, 0, 12));
  stone.push(tube(1.15, 0.22, 1.55, 0, 0, 16));
  stone.push(tube(0.2, 0.75, 1.77, 0, 0, 10));
  const bowl = new THREE.SphereGeometry(0.45, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  bowl.translate(0, 2.52, 0);
  stone.push(bowl);
  const water = tube(2.3, 0.02, 0.5, 0, 0, 20);
  return [
    { geo: merge(stone), role: 'stone' },
    { geo: water, role: 'glass' },
  ];
}

export function flagpole(): Part[] {
  const pole = new THREE.CylinderGeometry(0.045, 0.09, 11.0, 8);
  pole.translate(0, 5.5, 0);
  const base = tube(0.3, 0.5, 0, 0, 0, 10);
  const ball = new THREE.SphereGeometry(0.1, 8, 6);
  ball.translate(0, 11.1, 0);
  const flag = new THREE.PlaneGeometry(1.6, 1.0);
  flag.translate(0.8, 9.9, 0);
  return [
    { geo: merge([pole, base, ball]), role: 'metal' },
    { geo: flag, role: 'metal' },
  ];
}

/** Radio / antenna mast with guy-wire-ish bracing. */
export function mast(): Part[] {
  const H = 26.0;
  const parts: THREE.BufferGeometry[] = [tube(0.16, H, 0, 0, 0, 6)];
  for (let i = 1; i < 5; i++) parts.push(tube(0.55, 0.1, (i * H) / 5, 0, 0, 6));
  const tip = new THREE.CylinderGeometry(0.02, 0.06, 3.0, 5);
  tip.translate(0, H + 1.5, 0);
  parts.push(tip);
  return [{ geo: merge(parts), role: 'darkmetal' }];
}

export function chimney(): Part[] {
  const H = 22.0;
  const g = new THREE.CylinderGeometry(1.15, 1.7, H, 12);
  g.translate(0, H / 2, 0);
  const band = tube(1.25, 0.4, H - 1.2, 0, 0, 12);
  return [{ geo: merge([g, band]), role: 'stone' }];
}

/** Tower crane — Boston's skyline always has several. */
export function crane(): Part[] {
  const H = 42.0;
  const steel: THREE.BufferGeometry[] = [];
  // Lattice mast, approximated by four legs and periodic collars.
  for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]] as const) {
    steel.push(tube(0.08, H, 0, dx, dz, 4));
  }
  for (let i = 0; i <= 12; i++) {
    const y = (i * H) / 12;
    steel.push(box(1.75, 0.08, 0.08, y, 0, -0.8));
    steel.push(box(1.75, 0.08, 0.08, y, 0, 0.8));
    steel.push(box(0.08, 0.08, 1.75, y, -0.8, 0));
    steel.push(box(0.08, 0.08, 1.75, y, 0.8, 0));
  }
  // Slewing platform, jib and counter-jib.
  steel.push(box(2.6, 1.4, 2.6, H, 0, 0));
  steel.push(box(34.0, 1.3, 1.3, H + 1.4, 13.0, 0));
  steel.push(box(11.0, 1.3, 1.6, H + 1.4, -5.5, 0));
  steel.push(box(2.2, 2.0, 2.2, H + 1.4, -9.5, 0));
  // A-frame and the hoist block.
  steel.push(box(0.5, 5.0, 0.5, H + 2.7, 0, 0));
  steel.push(box(0.7, 0.7, 0.7, H - 6.0, 18.0, 0));
  steel.push(box(0.1, 7.4, 0.1, H - 6.0, 18.0, 0));
  return [{ geo: merge(steel), role: 'metal' }];
}

export function buildKind(kind: string, variant: number): Part[] {
  switch (kind) {
    case 'streetlamp': return streetlamp(variant);
    case 'bench': return bench(variant);
    case 'traffic_signal': return trafficSignal();
    case 'bollard': return bollard(variant);
    case 'statue': return statue(variant);
    case 'fountain': return fountain();
    case 'flagpole': return flagpole();
    case 'mast': return mast();
    case 'chimney': return chimney();
    case 'crane': return crane();
    default: return [];
  }
}
