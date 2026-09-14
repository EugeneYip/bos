/**
 * The Citgo Sign, 660 Beacon Street, Kenmore Square. Installed 1965,
 * rebuilt with LEDs in 2005 and again in 2010.
 *
 * Real-world dimensions used
 * --------------------------
 *  sign        60 x 60 ft = 18.29 m square, double-sided
 *  host        660 Beacon St, a nine-storey brick block; the sign's base sits
 *              at roughly 34 m above grade
 *  artwork     white field, a red inverted triangle ("trimark") with a blue
 *              horizontal band carrying CITGO in white
 *
 * Visible over the Green Monster from inside Fenway Park, which is the only
 * reason a petrol advertisement is a protected landmark. It must glow, and it
 * must pulse the way the LED version does — the sign ripples on and off rather
 * than sitting at a constant brightness.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, prism, box, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { makeLOD } from '../lib/lod';
import { ft, rect } from '../lib/util';

const SIGN = ft(60); // 18.29 m
const BASE_Y = 34.0; // top of 660 Beacon St
const HOST_W = 34.0;
const HOST_D = 24.0;

/** The trimark artwork, drawn into a canvas so the emissive map is crisp. */
function signTexture(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f3f5';
  g.fillRect(0, 0, S, S);

  // Red inverted triangle, inset from the square.
  const m = S * 0.085;
  g.fillStyle = '#e8232a';
  g.beginPath();
  g.moveTo(m, m);
  g.lineTo(S - m, m);
  g.lineTo(S / 2, S - m);
  g.closePath();
  g.fill();

  // Blue band across the triangle's upper third.
  g.fillStyle = '#1b3f97';
  g.fillRect(m, S * 0.30, S - 2 * m, S * 0.175);

  g.fillStyle = '#ffffff';
  g.font = `bold ${Math.round(S * 0.135)}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = `${Math.round(S * 0.012)}px`;
  g.fillText('CITGO', S / 2, S * 0.388);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function buildCS(ctx: Ctx, detail: boolean): THREE.Group {
  const M = materialsFor(ctx);
  const b = new Builder();
  const brick = M.surface('brick', { color: 0x7d5344, roughness: 0.93, tile: 2.4 });
  const steel = M.surface('darkmetal', { color: 0x33383d, roughness: 0.52, metalness: 0.8 });

  // 660 Beacon Street itself, so the sign isn't floating.
  b.add(prism(rect(HOST_W, HOST_D), 0, BASE_Y, { cap: true }), brick);

  // Steel support frame.
  const legs = 4;
  for (let i = 0; i < legs; i++) {
    const x = -SIGN / 2 + (i / (legs - 1)) * SIGN;
    b.add(strut(new THREE.Vector3(x, BASE_Y - 0.5, 0), new THREE.Vector3(x, BASE_Y + SIGN + 1.2, 0), 0.28, 6), steel);
  }
  for (const y of [BASE_Y + 0.4, BASE_Y + SIGN * 0.5, BASE_Y + SIGN + 1.0]) {
    b.addAt(box(SIGN + 1.6, 0.3, 0.3), steel, [0, y, 0]);
  }
  if (detail) {
    // Diagonal bracing, which is very visible against the sky.
    for (let i = 0; i < legs - 1; i++) {
      const x0 = -SIGN / 2 + (i / (legs - 1)) * SIGN;
      const x1 = -SIGN / 2 + ((i + 1) / (legs - 1)) * SIGN;
      b.add(strut(new THREE.Vector3(x0, BASE_Y + 0.4, 0), new THREE.Vector3(x1, BASE_Y + SIGN + 1.0, 0), 0.1, 5), steel);
      b.add(strut(new THREE.Vector3(x1, BASE_Y + 0.4, 0), new THREE.Vector3(x0, BASE_Y + SIGN + 1.0, 0), 0.1, 5), steel);
    }
  }

  // The sign itself: double-sided, emissive, and self-illuminated at night.
  const tex = signTexture();
  const face = new THREE.MeshStandardMaterial({
    name: 'citgo-face',
    map: tex,
    emissiveMap: tex,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1.2,
    roughness: 0.42,
    metalness: 0,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  // Let the day/night driver in LandmarkMaterials pick this up.
  face.userData.nightPeak = 5.5;
  face.userData.dayPeak = 0.25;
  M.registerNightLit(face);

  const panel = new THREE.PlaneGeometry(SIGN, SIGN);
  panel.translate(0, BASE_Y + SIGN / 2 + 0.8, 0.16);
  b.add(panel, face);
  const back = new THREE.PlaneGeometry(SIGN, SIGN);
  back.rotateY(Math.PI);
  back.translate(0, BASE_Y + SIGN / 2 + 0.8, -0.16);
  b.add(back, face);

  return b.build('citgo-sign');
}

export function buildCitgo(ctx: Ctx): THREE.Object3D {
  return makeLOD('citgo-sign', [
    { object: buildCS(ctx, true), distance: 0 },
    { object: buildCS(ctx, false), distance: 1200 },
  ]);
}
