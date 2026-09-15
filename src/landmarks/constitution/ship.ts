/**
 * USS Constitution — hull, spars and standing rigging.
 *
 * Launched at Hartt's shipyard in the North End on 21 October 1797, one of the
 * six original frigates authorised by the Naval Act of 1794. Still a
 * commissioned warship of the United States Navy and the oldest one afloat
 * anywhere. Berthed at Pier 1 of the Charlestown Navy Yard, which is where this
 * model puts her.
 *
 * Dimensions used (Joshua Humphreys' draught, as restored)
 * -------------------------------------------------------
 *   length on deck        204 ft   62.2 m
 *   length at waterline   175 ft   53.3 m
 *   extreme beam           44.5 ft 13.6 m
 *   draught                22.5 ft  6.9 m
 *   mainmast above water  220 ft   67.1 m
 *   foremast              198 ft   60.4 m
 *   mizzenmast            172.5 ft 52.6 m
 *   main yard              95 ft   28.9 m
 *   gun-deck ports         15 a side, 24-pounder long guns
 *
 * She carries a plain billet head, not a figurehead: the Jackson figurehead of
 * 1834 caused a small riot and was sawn off, and she has been billet-headed
 * since 1876.
 *
 * Triangle policy: the hull and spars are merged per material by `Builder`; the
 * rig is three-sided tubes (six triangles a segment), so every shroud, ratline,
 * stay and footrope in the model is real geometry for about 6k triangles total.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { Builder, box, cyl, revolve, strut } from '../lib/geom';
import { materialsFor } from '../lib/materials';
import { rect } from '../lib/util';
import { deckPlanks, ensignTexture, jackTexture } from './tex';
import {
  BEAM,
  COPPER_Y,
  HALF_BEAM,
  HALF_LEN,
  HULL_LEN,
  KEEL_Y,
  LEVELS,
  L_COPPER,
  L_PLANKSHEER,
  L_RAIL,
  L_STRAKE_HI,
  L_STRAKE_LO,
  PLANKSHEER_Y,
  RAIL_Y,
  STRAKE_HI,
  STRAKE_LO,
  V,
  gridGeometry,
  hullAt,
  hullNormal,
  hullPoint,
  keelAt,
  levelHalf,
  levelX,
  levelY,
  polyFan,
  pole,
  quad,
  rope,
  sheerAt,
  sheeredY,
  spar,
} from './geom';

/* ------------------------------------------------------------- materials */

interface Mats {
  black: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  buff: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  rig: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  canvas: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
}

function makeMats(ctx: Ctx): Mats {
  const M = materialsFor(ctx);
  const deck = M.surface('paint', { color: 0xffffff, roughness: 0.78, tile: 2.0 });
  // The shared library has no planking family, so drive the deck locally.
  if (!deck.map) {
    deck.map = deckPlanks();
    deck.map.repeat.set(0.5, 0.5);
    deck.color.set(0xffffff);
    deck.needsUpdate = true;
  }
  return {
    // Topsides are oil-painted black over a smooth planked surface: fairly
    // glossy, and the specular streak down her side is most of what reads at
    // 500 m, so do not roughen it away.
    black: M.surface('paint', { color: 0x14161a, roughness: 0.38, envMapIntensity: 1.15 }),
    white: M.surface('paint', { color: 0xe6e1d2, roughness: 0.5 }),
    // Copper sheathing, weathered to a dull brown. Keep metalness low: a high
    // metalness here renders the boot top black, because a metal with nothing
    // to reflect has no diffuse term to fall back on.
    copper: M.surface('metal', { color: 0x9c6142, roughness: 0.62, metalness: 0.25, envMapIntensity: 0.9 }),
    deck,
    buff: M.surface('paint', { color: 0xc6a469, roughness: 0.62 }),
    wood: M.surface('paint', { color: 0x6d5334, roughness: 0.72 }),
    rig: M.surface('paint', { color: 0x22201d, roughness: 0.92 }),
    dark: M.surface('paint', { color: 0x0a0907, roughness: 0.95 }),
    red: M.surface('paint', { color: 0x74302a, roughness: 0.8 }),
    gold: M.gold({ roughness: 0.34 }),
    glass: M.litGlass(1797, { color: 0x1b2630, roughness: 0.16, metalness: 0.2 }, 0.35),
    canvas: M.surface('paint', { color: 0xcfc6b0, roughness: 0.86 }),
    iron: M.surface('darkmetal', { color: 0x2b2d30, roughness: 0.55, metalness: 0.7 }),
  };
}

/* ------------------------------------------------------------- deck plane */

const DECK_Y = 5.84;

/** Spar-deck height at a station, riding the same sheer as the rail. */
function deckY(t: number): number {
  return DECK_Y + sheerAt(t) * Math.sqrt(DECK_Y / RAIL_Y);
}

/** Inboard face of the bulwark: the topside inset by its own thickness. */
function inboardHalf(t: number, y: number): number {
  const u = THREE.MathUtils.clamp((y - PLANKSHEER_Y) / (RAIL_Y - PLANKSHEER_Y), 0, 1);
  return Math.max(0.05, levelHalf(t, L_PLANKSHEER) * (1 - u) + levelHalf(t, L_RAIL) * u - (0.32 - 0.06 * u));
}

/* ----------------------------------------------------------------- stations */

/** Station list, clustered toward the ends where the curvature lives. */
function stations(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * 2 - 1;
    // Cubic ease pushes samples toward |t| = 1.
    out.push(Math.sign(u) * (0.35 * Math.abs(u) + 0.65 * Math.abs(u) ** 0.62) * 0.999);
  }
  return out;
}

/* -------------------------------------------------------------------- hull */

function hullBands(b: Builder, m: Mats, detail: boolean): void {
  const ts = stations(detail ? 56 : 30);
  const bands: { lo: number; hi: number; mat: THREE.MeshStandardMaterial }[] = [
    { lo: 0, hi: L_COPPER, mat: m.copper },
    { lo: L_COPPER, hi: L_STRAKE_LO, mat: m.black },
    { lo: L_STRAKE_LO, hi: L_STRAKE_HI, mat: m.white },
    { lo: L_STRAKE_HI, hi: L_RAIL, mat: m.black },
  ];
  for (const side of [1, -1]) {
    for (const band of bands) {
      const rows: THREE.Vector3[][] = [];
      for (let j = band.lo; j <= band.hi; j++) {
        rows.push(ts.map((t) => hullPoint(t, j, side)));
      }
      b.add(gridGeometry(rows, side > 0), band.mat);
    }
    // Keel, sternpost and stem shown as a plate on the centreline so the
    // pinched bottom of the loft has something solid inside it.
    const keelRows: THREE.Vector3[][] = [
      ts.map((t) => V(levelX(t, keelAt(t)), keelAt(t), side * 0.16)),
      ts.map((t) => V(levelX(t, keelAt(t) + 0.5), keelAt(t) + 0.52, side * 0.2)),
    ];
    b.add(gridGeometry(keelRows, side > 0), m.copper);
  }
}

/**
 * Sole of the keel: a narrow strip closing the 0.32 m gap the two keel plates
 * leave between them, so a camera under the counter does not look up into the
 * inside of the hull.
 */
function hullBottom(b: Builder, m: Mats): void {
  const ts = stations(30);
  const rows: THREE.Vector3[][] = [
    ts.map((t) => V(levelX(t, keelAt(t)), keelAt(t) - 0.02, 0.17)),
    ts.map((t) => V(levelX(t, keelAt(t)), keelAt(t) - 0.02, -0.17)),
  ];
  // i = forward, j = to port: x cross -z is +Y, so `flip = false` faces down.
  b.add(gridGeometry(rows, false), m.copper);
}

/* --------------------------------------------------------------- gun ports */

const GUN_PORTS = 15;
const PORT_W = 1.14;
const PORT_LO = STRAKE_LO + 0.16;
const PORT_HI = STRAKE_HI - 0.2;

/** Station centres of the gun-deck ports. */
function portStations(): number[] {
  const out: number[] = [];
  for (let i = 0; i < GUN_PORTS; i++) {
    out.push(-0.715 + (i / (GUN_PORTS - 1)) * (0.66 + 0.715));
  }
  return out;
}

/**
 * The white strake, rebuilt as wall spans with real recesses between them. A
 * painted-on port reads as a sticker the moment there is any sun on the side of
 * the ship, so each one is a 0.42 m box sunk into the planking with its own lid
 * hinged up against the topside.
 */
function gunPorts(b: Builder, m: Mats, detail: boolean): void {
  const ht = PORT_W / 2 / HULL_LEN;
  const centres = portStations();
  const n = new THREE.Vector3();

  for (const side of [1, -1]) {
    for (let k = 0; k < centres.length; k++) {
      const tc = centres[k];
      const t0 = tc - ht;
      const t1 = tc + ht;
      // Rim, then the same rectangle pushed in along the surface normal.
      const rim = [
        hullAt(t0, PORT_LO, side),
        hullAt(t1, PORT_LO, side),
        hullAt(t1, PORT_HI, side),
        hullAt(t0, PORT_HI, side),
      ];
      hullNormal(tc, (PORT_LO + PORT_HI) / 2, side, n);
      const inner = rim.map((p) => p.clone().addScaledVector(n, -0.44));
      // Shrink the inner rectangle so the reveal reads as a splayed port.
      const ic = new THREE.Vector3();
      for (const p of inner) ic.add(p);
      ic.multiplyScalar(0.25);
      for (const p of inner) p.lerp(ic, 0.1);

      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const g = side > 0
          ? quad(rim[i], rim[j], inner[j], inner[i])
          : quad(rim[j], rim[i], inner[i], inner[j]);
        b.add(g, m.red);
      }
      const back = side > 0
        ? quad(inner[0], inner[1], inner[2], inner[3])
        : quad(inner[1], inner[0], inner[3], inner[2]);
      b.add(back, m.dark);

      if (!detail) continue;

      // Port lid, hinged at the head and swung up flat against the side.
      const hingeA = rim[3].clone();
      const hingeB = rim[2].clone();
      const lift = 0.94;
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, 0.55).normalize();
      const tipA = hingeA.clone().addScaledVector(up, lift * 1.02).addScaledVector(n, 0.1);
      const tipB = hingeB.clone().addScaledVector(up, lift * 1.02).addScaledVector(n, 0.1);
      b.add(side > 0 ? quad(hingeA, hingeB, tipB, tipA) : quad(hingeB, hingeA, tipA, tipB), m.black);
      b.add(side > 0 ? quad(tipA, tipB, hingeB, hingeA) : quad(tipB, tipA, hingeA, hingeB), m.white);

      // Half the battery is run out; the rest sits inboard behind a dark port.
      if (k % 2 === 0) {
        const mid = new THREE.Vector3().addVectors(rim[0], rim[2]).multiplyScalar(0.5);
        const muzzle = mid.clone().addScaledVector(n, 0.92);
        const breech = mid.clone().addScaledVector(n, -0.55);
        const g = strut(breech, muzzle, 0.115, 8);
        b.add(g, m.iron);
      }
    }
  }
}

/** Spar-deck ports in the bulwark, for the 32-pounder carronades. */
function sparPorts(b: Builder, m: Mats): void {
  const n = new THREE.Vector3();
  const yLo = PLANKSHEER_Y + 0.34;
  const yHi = RAIL_Y - 0.38;
  for (const side of [1, -1]) {
    for (let i = 0; i < 12; i++) {
      const tc = -0.66 + (i / 11) * 1.3;
      const ht = 0.78 / 2 / HULL_LEN;
      const rim = [
        hullAt(tc - ht, yLo, side),
        hullAt(tc + ht, yLo, side),
        hullAt(tc + ht, yHi, side),
        hullAt(tc - ht, yHi, side),
      ];
      hullNormal(tc, (yLo + yHi) / 2, side, n);
      const inner = rim.map((p) => p.clone().addScaledVector(n, -0.3));
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4;
        b.add(
          side > 0 ? quad(rim[j], rim[k], inner[k], inner[j]) : quad(rim[k], rim[j], inner[j], inner[k]),
          m.red,
        );
      }
      b.add(
        side > 0 ? quad(inner[0], inner[1], inner[2], inner[3]) : quad(inner[1], inner[0], inner[3], inner[2]),
        m.dark,
      );
    }
  }
}

/* ------------------------------------------------------- deck and bulwarks */

function sparDeck(b: Builder, m: Mats, detail: boolean): void {
  const ts = stations(detail ? 42 : 24).filter((t) => t > -0.95 && t < 0.945);
  const NZ = 9;
  const rows: THREE.Vector3[][] = [];
  for (let j = 0; j <= NZ; j++) {
    const f = (j / NZ) * 2 - 1;
    rows.push(
      ts.map((t) => {
        const hw = inboardHalf(t, deckY(t) + 0.1);
        const camber = 0.17 * (1 - f * f);
        return V(levelX(t, deckY(t)), deckY(t) + camber, f * hw);
      }),
    );
  }
  b.add(gridGeometry(rows, false), m.deck);

  // Inboard face of the bulwark plus the capping rail.
  for (const side of [1, -1]) {
    const inner: THREE.Vector3[][] = [
      ts.map((t) => V(levelX(t, deckY(t)), deckY(t), side * inboardHalf(t, deckY(t)))),
      ts.map((t) => V(levelX(t, RAIL_Y - 0.18), sheeredY(t, RAIL_Y - 0.18), side * inboardHalf(t, RAIL_Y - 0.18))),
    ];
    b.add(gridGeometry(inner, side < 0), m.buff);

    // Cap rail: a flat board bridging the outer and inner faces.
    const capOuter = ts.map((t) => hullPoint(t, L_RAIL, side));
    const capInner = ts.map((t) => V(levelX(t, RAIL_Y), sheeredY(t, RAIL_Y), side * inboardHalf(t, RAIL_Y)));
    b.add(gridGeometry([capOuter, capInner], side > 0), m.black);
  }
}

/* ------------------------------------------------------------------- stern */

/**
 * Transom, stern gallery and quarter badges. The `constitution` viewpoint looks
 * at her from almost dead astern, so this face carries the whole shot.
 */
function stern(b: Builder, m: Mats, detail: boolean): void {
  const tT = -0.999;
  // Transom face, level by level, closed across the centreline.
  const rows: THREE.Vector3[][] = [];
  for (let j = 0; j < LEVELS.length; j++) {
    const y = levelY(tT, j);
    const h = levelHalf(tT, j);
    const x = levelX(tT, y);
    const row: THREE.Vector3[] = [];
    const N = 7;
    for (let i = 0; i <= N; i++) {
      const f = (i / N) * 2 - 1;
      // Round the transom slightly in plan so it catches a highlight.
      row.push(V(x + (1 - f * f) * -0.34, y, f * h));
    }
    rows.push(row);
  }
  b.add(gridGeometry(rows, true), m.black);

  const taffY = RAIL_Y + sheerAt(tT);
  const xAt = (y: number): number => levelX(tT, y) - 0.2;

  if (!detail) return;

  // Two tiers of windows: the captain's cabin above, dummy lights below.
  const tiers: { y: number; h: number; n: number; w: number }[] = [
    { y: taffY - 2.25, h: 1.5, n: 6, w: 0.86 },
    { y: taffY - 4.05, h: 1.05, n: 5, w: 0.76 },
  ];
  for (const tier of tiers) {
    const half = levelHalf(tT, L_PLANKSHEER) * 0.88;
    for (let i = 0; i < tier.n; i++) {
      const z = ((i + 0.5) / tier.n - 0.5) * 2 * half;
      const x = xAt(tier.y) - 0.1;
      const g = box(0.16, tier.h, tier.w);
      g.translate(x, tier.y - tier.h / 2, z);
      b.add(g, m.glass);
      // Sash bar and a white architrave.
      const f = box(0.1, tier.h + 0.22, tier.w + 0.2);
      f.translate(x + 0.1, tier.y - tier.h / 2 - 0.11, z);
      b.add(f, m.white);
    }
    // Moulding under each tier.
    const band = box(0.3, 0.2, levelHalf(tT, L_PLANKSHEER) * 2.1);
    band.translate(xAt(tier.y) + 0.06, tier.y - tier.h - 0.2, 0);
    b.add(band, m.gold);
  }

  // Taffrail moulding and the stern lantern.
  const cap = box(0.5, 0.3, levelHalf(tT, L_RAIL) * 2.06);
  cap.translate(xAt(taffY) + 0.1, taffY - 0.15, 0);
  b.add(cap, m.gold);
  const lampY = taffY + 0.2;
  b.addAt(cyl(0.22, 0.18, 0.7, 8), m.gold, [xAt(taffY) + 0.6, lampY, 0]);
  b.addAt(cyl(0.3, 0.02, 0.45, 8), m.gold, [xAt(taffY) + 0.6, lampY + 0.7, 0]);

  // Quarter badges: a small gallery bracketed on each side of the counter.
  for (const side of [1, -1]) {
    const t = -0.94;
    const y = sheeredY(t, 6.3);
    const p = hullAt(t, y, side);
    const nrm = hullNormal(t, y, side);
    const g = box(1.9, 1.7, 0.9);
    g.translate(0, -0.85, 0);
    const mat = new THREE.Matrix4().makeTranslation(
      p.x + nrm.x * 0.3,
      y + 0.4,
      p.z + nrm.z * 0.3,
    );
    b.add(g.clone().applyMatrix4(mat), m.white);
    g.dispose();
    const w = box(0.9, 0.95, 0.12);
    w.translate(0, -0.5, 0);
    b.add(
      w.clone().applyMatrix4(
        new THREE.Matrix4().makeTranslation(p.x + nrm.x * 0.78, y + 0.35, p.z + nrm.z * 0.78),
      ),
      m.glass,
    );
    w.dispose();
  }

  // Rudder and tiller head, hung on the sternpost.
  const rp = 0.885;
  const top = levelY(-rp, L_COPPER);
  const rud = new THREE.Shape();
  rud.moveTo(0, 0);
  rud.lineTo(1.7, -0.5);
  rud.lineTo(2.3, -6.3);
  rud.lineTo(0.15, -6.0);
  const rg = new THREE.ExtrudeGeometry(rud, { depth: 0.36, bevelEnabled: false });
  rg.translate(0, 0, -0.18);
  rg.rotateY(Math.PI / 2);
  rg.translate(levelX(-rp, top) - 0.5, top + 0.4, 0);
  b.add(rg, m.copper);
}

/* --------------------------------------------------------- head / beakhead */

/**
 * The head: a billet-headed cutwater, two pairs of head rails, the knee, and
 * the catheads. Her beakhead is the second-most photographed thing about her
 * after the stern, and it is what stops the bow looking like a wedge.
 */
function head(b: Builder, m: Mats, detail: boolean): void {
  const tS = 0.985;
  const stemY = levelY(tS, L_RAIL);
  const stemX = levelX(tS, stemY);

  // Cutwater / knee of the head: a thin vertical plate reaching forward.
  const prof = new THREE.Shape();
  prof.moveTo(0, -1.2);
  prof.lineTo(3.0, 4.2);
  prof.lineTo(4.5, 6.6);
  prof.lineTo(4.2, 7.5);
  prof.lineTo(2.2, 6.0);
  prof.lineTo(0.0, 3.0);
  const kg = new THREE.ExtrudeGeometry(prof, { depth: 0.5, bevelEnabled: false });
  kg.translate(0, 0, -0.25);
  kg.rotateY(Math.PI / 2);
  kg.scale(-1, 1, 1);
  kg.translate(stemX - 0.3, 2.6, 0);
  b.add(kg, m.black);

  // Billet head: a scroll finishing the cutwater, gilded.
  b.addAt(revolve([[0, 0], [0.34, 0.12], [0.42, 0.42], [0.2, 0.66], [0, 0.72]], 10), m.gold,
    [stemX + 3.9, 9.6, 0]);

  if (!detail) return;

  // Head rails sweeping from the bow up to the bowsprit, two a side.
  for (const side of [1, -1]) {
    for (const [y0, y1, dz] of [[6.4, 9.9, 1.0], [5.1, 8.9, 1.55]] as const) {
      const a = hullAt(0.9, y0, side).addScaledVector(V(0, 0, side), 0.1);
      const mid = V(stemX + 1.4, (y0 + y1) / 2 + 1.0, side * dz);
      const c = V(stemX + 3.6, y1, side * 0.28);
      rope(b, m.black, a, mid, 0.1);
      rope(b, m.black, mid, c, 0.1);
    }
    // Head timbers between the rails.
    for (let i = 0; i < 3; i++) {
      const u = (i + 1) / 4;
      const p0 = V(stemX + 0.4 + u * 2.6, 5.4 + u * 2.6, side * (1.5 - u * 1.1));
      const p1 = V(stemX + 0.4 + u * 2.6, 8.4 + u * 1.3, side * (1.1 - u * 0.8));
      rope(b, m.black, p0, p1, 0.075);
    }
    // Cathead: the timber the anchor hangs from.
    const cp = hullAt(0.86, RAIL_Y + 0.3, side);
    const co = cp.clone();
    co.z += side * 1.5;
    co.x += 0.7;
    co.y += 0.15;
    b.add(strut(cp, co, 0.21, 4), m.black);
  }

  // Bow seats / grating platform inside the head.
  const gp: THREE.Vector3[] = [
    hullAt(0.93, 7.6, 1),
    V(stemX + 2.0, 9.0, 0.7),
    V(stemX + 2.0, 9.0, -0.7),
    hullAt(0.93, 7.6, -1),
  ];
  b.add(polyFan(gp, false), m.wood);
}

/* --------------------------------------------------------------- channels */

interface MastSpec {
  x: number;
  /** Lower masthead: top platform height. */
  top: number;
  /** Top of the lower mast cap. */
  cap: number;
  /** Topmast head / crosstrees. */
  cross: number;
  /** Truck. */
  truck: number;
  r0: number;
  r1: number;
  r2: number;
  /** Lower shrouds per side. */
  shrouds: number;
  /** Topmast shrouds per side. */
  tShrouds: number;
  /** Channel extent, in stations. */
  ch: [number, number];
  /** Platform half-width, half-length. */
  topW: number;
  topL: number;
  /** [length, height] of each yard, lowest first. */
  yards: [number, number][];
}

const FORE: MastSpec = {
  x: 18.6, top: 27.6, cap: 29.6, cross: 44.0, truck: 60.4,
  r0: 0.44, r1: 0.26, r2: 0.145, shrouds: 9, tShrouds: 6,
  ch: [0.5, 0.71], topW: 2.5, topL: 1.7,
  yards: [[25.9, 26.2], [20.1, 36.4], [14.3, 47.0], [10.4, 54.6]],
};
const MAIN: MastSpec = {
  x: -0.6, top: 30.5, cap: 32.7, cross: 49.0, truck: 67.1,
  r0: 0.47, r1: 0.285, r2: 0.155, shrouds: 10, tShrouds: 7,
  ch: [-0.13, 0.11], topW: 2.75, topL: 1.85,
  yards: [[28.9, 29.0], [22.6, 40.2], [16.2, 52.2], [11.6, 60.4]],
};
const MIZZEN: MastSpec = {
  x: -17.4, top: 24.4, cap: 26.2, cross: 38.0, truck: 52.6,
  r0: 0.36, r1: 0.215, r2: 0.12, shrouds: 7, tShrouds: 5,
  ch: [-0.65, -0.49], topW: 2.0, topL: 1.4,
  yards: [[19.8, 23.2], [15.5, 32.4], [11.3, 42.0]],
};
const MASTS = [FORE, MAIN, MIZZEN];

/** Station of a given local x, inverted from `levelX` at rail height. */
function tOfX(x: number): number {
  return THREE.MathUtils.clamp(x / HALF_LEN, -0.99, 0.99);
}

/** Outboard point of a channel at a station, where a shroud is set up. */
function channelPoint(t: number, side: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = sheeredY(t, PLANKSHEER_Y + 0.15);
  const p = hullAt(t, y, side, out);
  const n = hullNormal(t, y, side);
  return p.addScaledVector(n, 1.02);
}

function channels(b: Builder, m: Mats): void {
  for (const spec of MASTS) {
    for (const side of [1, -1]) {
      const [t0, t1] = spec.ch;
      const N = 4;
      const outer: THREE.Vector3[] = [];
      const innerRow: THREE.Vector3[] = [];
      for (let i = 0; i <= N; i++) {
        const t = t0 + ((t1 - t0) * i) / N;
        const y = sheeredY(t, PLANKSHEER_Y + 0.12);
        outer.push(channelPoint(t, side));
        innerRow.push(hullAt(t, y, side));
      }
      b.add(gridGeometry([innerRow, outer], side < 0), m.black);
      const under = outer.map((p) => p.clone().setY(p.y - 0.22));
      b.add(gridGeometry([outer, under], side < 0), m.black);
      b.add(gridGeometry([under, innerRow.map((p) => p.clone().setY(p.y - 0.22))], side < 0), m.black);

      // Deadeyes and chain plates: the little vertical ticks under a channel
      // are most of what makes a hull read as rigged from a distance.
      for (let i = 0; i < spec.shrouds; i++) {
        const t = t0 + ((t1 - t0) * (i + 0.5)) / spec.shrouds;
        const top = channelPoint(t, side);
        const y2 = sheeredY(t, STRAKE_HI + 0.1);
        const anchor = hullAt(t, y2, side);
        const nrm = hullNormal(t, y2, side);
        anchor.addScaledVector(nrm, 0.07);
        rope(b, m.iron, top, anchor, 0.045);
        b.addAt(cyl(0.16, 0.16, 0.12, 6), m.wood, [top.x, top.y + 0.02, top.z]);
      }
    }
  }
}

/* ------------------------------------------------------------------- masts */

function mastStack(b: Builder, m: Mats, s: MastSpec, detail: boolean): void {
  const heel = deckY(tOfX(s.x)) - 5.6; // stepped on the keelson, well below
  const x = s.x;

  // Lower mast, with the hounded masthead above the top.
  b.addAt(pole(heel, s.cap, s.r0 * 1.06, s.r0 * 0.78, detail ? 10 : 7), m.buff, [x, 0, 0]);
  // Doubling: the masthead itself is painted black on her.
  b.addAt(pole(s.top - 0.3, s.cap, s.r0 * 0.8, s.r0 * 0.74, 8), m.black, [x, 0, 0]);
  // Cap.
  const capG = box(1.5, 0.34, s.r0 * 2.6);
  capG.translate(x - 0.25, s.cap, 0);
  b.add(capG, m.black);

  // Top platform: trestletrees, crosstrees and the planked top.
  const tw = s.topW;
  const tl = s.topL;
  const plat = box(tl * 2, 0.16, tw * 2);
  plat.translate(x - 0.2, s.top, 0);
  b.add(plat, m.wood);
  if (detail) {
    // Rim and futtock staves round the top.
    for (const side of [1, -1]) {
      const a = V(x - 0.2 - tl, s.top + 0.16, side * tw);
      const c = V(x - 0.2 + tl, s.top + 0.16, side * tw);
      rope(b, m.wood, a, c, 0.07);
    }
    rope(b, m.wood, V(x - 0.2 - tl, s.top + 0.16, -tw), V(x - 0.2 - tl, s.top + 0.16, tw), 0.07);
  }

  // Topmast, stepped just abaft the lower masthead.
  const tx = x - 0.34;
  b.addAt(pole(s.top - 1.9, s.cross + 1.1, s.r1 * 1.05, s.r1 * 0.72, detail ? 9 : 6), m.buff, [tx, 0, 0]);
  b.addAt(pole(s.cross - 1.4, s.cross + 1.1, s.r1 * 0.78, s.r1 * 0.72, 7), m.black, [tx, 0, 0]);
  const cross = box(1.1, 0.2, tw * 1.35);
  cross.translate(tx - 0.2, s.cross, 0);
  b.add(cross, m.wood);
  const capG2 = box(0.95, 0.24, s.r1 * 2.6);
  capG2.translate(tx - 0.2, s.cross + 1.1, 0);
  b.add(capG2, m.black);

  // Topgallant mast and royal pole, finished with the truck.
  const gx = tx - 0.24;
  b.addAt(pole(s.cross - 1.0, s.truck, s.r2 * 1.05, s.r2 * 0.4, detail ? 8 : 5), m.buff, [gx, 0, 0]);
  b.addAt(cyl(0.2, 0.2, 0.12, 8), m.black, [gx, s.truck, 0]);
}

/* ------------------------------------------------------------------- yards */

function yards(b: Builder, m: Mats, s: MastSpec, detail: boolean): void {
  for (let i = 0; i < s.yards.length; i++) {
    const [len, y] = s.yards[i];
    // Yards hang on the fore side of their mast; upper ones follow the offsets.
    const x = s.x - (i === 0 ? 0 : i === 1 ? 0.34 : 0.58) + (i === 0 ? s.r0 + 0.2 : 0.3);
    const rMid = i === 0 ? 0.27 : i === 1 ? 0.2 : 0.13;
    b.addAt(spar(len, rMid, rMid * 0.4, detail ? 7 : 5), m.black, [x, y, 0]);
    // Sling and truss at the centre.
    b.addAt(cyl(rMid * 1.5, rMid * 1.5, 0.5, 6), m.iron, [x, y - 0.25, 0]);

    if (!detail) continue;
    // Footropes: a catenary under each arm, and the stirrups that hold them.
    for (const side of [1, -1]) {
      const tip = V(x, y - 0.12, (side * len) / 2);
      const hub = V(x, y - 0.35, side * 0.5);
      const sag = V(x, y - 1.15, (side * len) / 4);
      rope(b, m.rig, hub, sag, 0.03);
      rope(b, m.rig, sag, tip, 0.03);
      for (let k = 1; k <= 2; k++) {
        const f = k / 3;
        const z = side * (len / 2) * f;
        rope(b, m.rig, V(x, y - 0.1, z), V(x, y - 0.95 * (1 - Math.abs(f - 0.5)), z), 0.025);
      }
      // Lifts to the mast cap above, and braces leading aft.
      const capY = i === 0 ? s.cap : i === 1 ? s.cross + 1.0 : s.truck - 2.2;
      rope(b, m.rig, tip, V(s.x - 0.3, capY, 0), 0.028);
    }
  }
}

/* ------------------------------------------------------------------ rigging */

function shroudGang(
  b: Builder,
  m: Mats,
  n: number,
  foot: (i: number) => THREE.Vector3,
  head: (i: number) => THREE.Vector3,
  ratlineFrom: number,
  ratlineTo: number,
  r: number,
  detail: boolean,
): void {
  const feet: THREE.Vector3[] = [];
  const heads: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    feet.push(foot(i));
    heads.push(head(i));
    rope(b, m.rig, feet[i], heads[i], r);
  }
  if (!detail || n < 2) return;
  // Ratlines across the gang: seized to every shroud but the aftermost.
  const a0 = feet[0];
  const a1 = heads[0];
  const b0 = feet[n - 1];
  const b1 = heads[n - 1];
  const span = a1.distanceTo(a0);
  const steps = Math.max(2, Math.floor((span * (ratlineTo - ratlineFrom)) / 0.42));
  for (let k = 0; k <= steps; k++) {
    const u = ratlineFrom + ((ratlineTo - ratlineFrom) * k) / steps;
    const p = a0.clone().lerp(a1, u);
    const q = b0.clone().lerp(b1, u);
    rope(b, m.rig, p, q, 0.018);
  }
}

function standingRig(b: Builder, m: Mats, detail: boolean): void {
  for (const s of MASTS) {
    for (const side of [1, -1]) {
      const [t0, t1] = s.ch;
      // Lower shrouds, channel to masthead.
      shroudGang(
        b, m, s.shrouds,
        (i) => channelPoint(t0 + ((t1 - t0) * (i + 0.5)) / s.shrouds, side),
        (i) => V(
          s.x + 0.1 - (i / Math.max(1, s.shrouds - 1)) * 0.45,
          s.top - 0.4 - (i / Math.max(1, s.shrouds - 1)) * 1.4,
          side * (s.r0 * 0.95),
        ),
        0.02, 0.93, 0.045, detail,
      );

      // Futtock shrouds: lower gang out to the rim of the top.
      const futA = V(s.x + 0.1, s.top - 3.4, side * s.r0 * 1.1);
      const futB = V(s.x - 0.2, s.top + 0.1, side * s.topW);
      rope(b, m.rig, futA, futB, 0.04);
      if (detail) {
        for (let i = 1; i < 4; i++) {
          const u = i / 4;
          const p = futA.clone().lerp(futB, u);
          const q = p.clone();
          q.x += 0.55;
          rope(b, m.rig, p, q, 0.02);
        }
      }

      // Topmast shrouds, from the rim of the top to the topmast head.
      shroudGang(
        b, m, s.tShrouds,
        (i) => V(
          s.x - 0.2 - s.topL * 0.4 + (i / Math.max(1, s.tShrouds - 1)) * s.topL * 1.2,
          s.top + 0.2,
          side * s.topW * 0.95,
        ),
        (i) => V(
          s.x - 0.34,
          s.cross - 0.4 - (i / Math.max(1, s.tShrouds - 1)) * 1.1,
          side * s.r1 * 0.95,
        ),
        0.04, 0.94, 0.033, detail,
      );

      // Topgallant shrouds.
      for (let i = 0; i < 3; i++) {
        rope(
          b, m.rig,
          V(s.x - 0.34 - 0.4 + i * 0.4, s.cross + 0.1, side * s.topW * 0.65),
          V(s.x - 0.58, s.truck - 6.4 - i * 0.5, side * s.r2),
          0.025,
        );
      }

      // Backstays: topmast and topgallant, set up well aft of the channels.
      const bt = Math.max(-0.93, t1 - 0.14);
      rope(b, m.rig, channelPoint(bt, side), V(s.x - 0.34, s.cross + 0.5, side * s.r1), 0.04);
      rope(b, m.rig, channelPoint(Math.max(-0.95, bt - 0.05), side), V(s.x - 0.58, s.truck - 5.0, side * s.r2), 0.033);
    }
  }

  // Fore-and-aft stays. Each one is doubled by a preventer on the real ship;
  // one line apiece is enough to make the triangles close.
  const bowsA = V(HALF_LEN + 1.0, 8.4, 0);
  const bowsB = V(HALF_LEN + 12.0, 11.7, 0);
  const bowsC = V(HALF_LEN + 21.5, 14.5, 0);
  const bowsD = V(HALF_LEN + 27.4, 16.3, 0);

  rope(b, m.rig, V(FORE.x + 0.3, FORE.top - 0.9, 0), bowsA.clone().lerp(bowsB, 0.35), 0.06);
  rope(b, m.rig, V(FORE.x + 0.3, FORE.top - 1.8, 0.4), bowsA.clone().lerp(bowsB, 0.15), 0.055);
  rope(b, m.rig, V(FORE.x - 0.1, FORE.cross - 0.7, 0), bowsB.clone().lerp(bowsC, 0.55), 0.045);
  rope(b, m.rig, V(FORE.x - 0.5, FORE.truck - 6.2, 0), bowsC.clone().lerp(bowsD, 0.75), 0.035);

  rope(b, m.rig, V(MAIN.x + 0.3, MAIN.top - 1.0, 0), V(FORE.x + 1.6, 7.0, 0), 0.06);
  rope(b, m.rig, V(MAIN.x + 0.3, MAIN.top - 2.0, 0.45), V(FORE.x + 1.2, 7.0, 0.9), 0.055);
  rope(b, m.rig, V(MAIN.x - 0.1, MAIN.cross - 0.8, 0), V(FORE.x - 0.3, FORE.top + 0.3, 0), 0.045);
  rope(b, m.rig, V(MAIN.x - 0.5, MAIN.truck - 6.4, 0), V(FORE.x - 0.4, FORE.cross + 0.2, 0), 0.035);

  rope(b, m.rig, V(MIZZEN.x + 0.3, MIZZEN.top - 0.8, 0), V(MAIN.x + 2.4, 7.2, 0), 0.05);
  rope(b, m.rig, V(MIZZEN.x - 0.1, MIZZEN.cross - 0.7, 0), V(MAIN.x - 0.3, MAIN.top + 0.3, 0), 0.04);
  rope(b, m.rig, V(MIZZEN.x - 0.5, MIZZEN.truck - 5.2, 0), V(MAIN.x - 0.4, MAIN.cross + 0.2, 0), 0.03);

  if (!detail) return;

  // Spanker gaff and boom, and the driver's standing gear.
  const gaffTip = V(MIZZEN.x - 13.6, 20.6, 0);
  b.add(strut(V(MIZZEN.x - 0.5, 12.2, 0), gaffTip, 0.16, 5), m.black);
  const boomTip = V(MIZZEN.x - 20.5, 9.4, 0);
  b.add(strut(V(MIZZEN.x - 0.6, 7.6, 0), boomTip, 0.2, 6), m.black);
  rope(b, m.rig, gaffTip, V(MIZZEN.x - 0.34, MIZZEN.cross - 1.0, 0), 0.03);
  for (const side of [1, -1]) {
    rope(b, m.rig, boomTip, channelPoint(-0.9, side), 0.028);
    rope(b, m.rig, gaffTip, channelPoint(-0.86, side), 0.026);
  }
}

/* ---------------------------------------------------------------- bowsprit */

function bowsprit(b: Builder, m: Mats, detail: boolean): void {
  const heel = V(HALF_LEN - 4.0, 6.6, 0);
  const capP = V(HALF_LEN + 10.4, 11.4, 0);
  const jib = V(HALF_LEN + 21.0, 14.6, 0);
  const fly = V(HALF_LEN + 28.0, 16.6, 0);

  b.add(strut(heel, capP, 0.46, 8), m.buff);
  b.add(strut(capP.clone().lerp(heel, 0.18), jib, 0.24, 7), m.buff);
  b.add(strut(jib.clone().lerp(capP, 0.22), fly, 0.13, 6), m.buff);
  // Bowsprit cap.
  b.addAt(box(0.4, 0.95, 1.0), m.black, [capP.x, capP.y - 0.45, 0]);

  if (!detail) return;

  // Spritsail yard across the bowsprit, and the jack staff at the stem.
  b.addAt(spar(11.0, 0.13, 0.05, 6), m.black, [HALF_LEN + 7.0, 10.4, 0]);

  // Dolphin striker under the cap, with the martingale stays.
  const strikerTip = V(capP.x + 0.6, capP.y - 3.5, 0);
  b.add(strut(V(capP.x + 0.4, capP.y - 0.4, 0), strikerTip, 0.11, 5), m.black);
  rope(b, m.rig, strikerTip, jib, 0.03);
  rope(b, m.rig, strikerTip, fly.clone().lerp(jib, 0.35), 0.026);
  rope(b, m.rig, strikerTip, hullAt(0.96, 4.4, 0.001), 0.03);

  // Bobstays down to the stem, and bowsprit shrouds out to the bows.
  rope(b, m.rig, capP, hullAt(0.975, 2.2, 0.001), 0.05);
  rope(b, m.rig, capP.clone().lerp(heel, 0.3), hullAt(0.972, 3.6, 0.001), 0.045);
  for (const side of [1, -1]) {
    rope(b, m.rig, capP, hullAt(0.9, 6.9, side), 0.04);
    rope(b, m.rig, jib, hullAt(0.93, 8.2, side), 0.03);
    // Foot ropes along the jibboom.
    rope(b, m.rig, V(capP.x, capP.y - 0.5, side * 0.6), V(jib.x - 1.0, jib.y - 1.1, side * 0.35), 0.022);
  }
}

/* --------------------------------------------------------- deck furniture */

function fittings(b: Builder, m: Mats, detail: boolean): void {
  const at = (x: number): number => deckY(tOfX(x)) + 0.15;

  // Hatches with gratings, fore to aft.
  for (const [x, w, d] of [[13.2, 3.0, 3.6], [4.4, 3.2, 4.0], [-9.0, 2.6, 3.2]] as const) {
    b.addAt(box(w, 0.5, d), m.wood, [x, at(x), 0]);
    if (detail) {
      const n = Math.round(d / 0.42);
      for (let i = 0; i < n; i++) {
        b.addAt(box(w - 0.3, 0.08, 0.1), m.dark, [x, at(x) + 0.52, -d / 2 + ((i + 0.5) * d) / n]);
      }
      const nx = Math.round(w / 0.42);
      for (let i = 0; i < nx; i++) {
        b.addAt(box(0.1, 0.08, d - 0.3), m.dark, [x - w / 2 + ((i + 0.5) * w) / nx, at(x) + 0.52, 0]);
      }
    }
  }

  // Two capstans.
  for (const x of [8.4, -12.6]) {
    b.addAt(revolve([[0.62, 0], [0.5, 0.35], [0.42, 0.9], [0.56, 1.05], [0.5, 1.2], [0, 1.25]], 10), m.wood,
      [x, at(x), 0]);
  }

  // Ship's wheel, binnacle and the helm platform right aft.
  const wx = -21.0;
  b.addAt(box(3.4, 0.28, 4.6), m.wood, [wx, at(wx), 0]);
  for (const side of [1, -1]) {
    const wheel = new THREE.TorusGeometry(0.72, 0.07, 4, 14);
    wheel.rotateY(Math.PI / 2);
    wheel.translate(wx + side * 0.4, at(wx) + 1.1, 0);
    b.add(wheel, m.wood);
  }
  b.addAt(box(0.5, 1.2, 1.5), m.wood, [wx + 1.6, at(wx) + 0.28, 0]);
  b.addAt(box(1.1, 0.95, 1.6), m.wood, [wx - 1.9, at(wx) + 0.28, 0]);

  // Galley funnel just abaft the foremast, and the belfry on the forecastle.
  b.addAt(cyl(0.3, 0.26, 2.2, 8), m.iron, [FORE.x - 2.6, at(FORE.x - 2.6), 1.6]);
  const bx = 23.5;
  b.addAt(box(1.5, 0.22, 0.24), m.wood, [bx, at(bx) + 1.5, 0]);
  for (const side of [1, -1]) b.addAt(box(0.18, 1.5, 0.18), m.wood, [bx, at(bx), side * 0.62]);
  b.addAt(revolve([[0, 0.34], [0.2, 0.3], [0.24, 0.05], [0.22, 0], [0, 0]], 8), m.gold, [bx, at(bx) + 1.1, 0]);

  if (!detail) return;

  // Skylights and companionways.
  for (const [x, w, d] of [[-4.6, 1.5, 2.2], [-16.0, 1.4, 1.9]] as const) {
    b.addAt(box(w, 0.75, d), m.white, [x, at(x), 0]);
    b.addAt(box(w + 0.2, 0.12, d + 0.2), m.glass, [x, at(x) + 0.75, 0]);
  }

  // Bitts and riding bitts, and the fife rails round each mast.
  for (const s of MASTS) {
    const y = at(s.x);
    b.addAt(cyl(s.r0 * 1.5, s.r0 * 1.35, 0.4, 10), m.black, [s.x, y - 0.1, 0]);
    for (const side of [1, -1]) {
      b.addAt(box(0.16, 1.0, 0.16), m.wood, [s.x + 1.3, y, side * 1.3]);
      b.addAt(box(0.16, 1.0, 0.16), m.wood, [s.x - 1.3, y, side * 1.3]);
      b.addAt(box(2.9, 0.14, 0.14), m.wood, [s.x, y + 1.0, side * 1.3]);
    }
  }

  // Boats: the launch and a cutter on skids over the main hatch, plus two
  // quarter boats hanging from davits.
  boat(b, m, 6.2, at(6.2) + 1.5, 0, 9.2, 2.5, 1.15);
  boat(b, m, -2.2, at(-2.2) + 1.5, 0, 8.0, 2.2, 1.0);
  for (const side of [1, -1]) {
    const t = -0.79;
    const p = channelPoint(t, side);
    for (const dx of [-2.6, 2.2]) {
      const a = V(p.x + dx, p.y - 0.3, p.z - side * 0.6);
      const c = V(p.x + dx, p.y + 3.1, p.z + side * 1.2);
      b.add(strut(a, c, 0.12, 5), m.iron);
    }
    boat(b, m, p.x - 0.2, p.y + 2.1, p.z + side * 0.9, 7.0, 1.9, 0.9);
  }

  // Anchors stowed against the bows, and the anchor cables.
  for (const side of [1, -1]) {
    const t = 0.845;
    const y = sheeredY(t, 6.2);
    const p = hullAt(t, y, side);
    const n = hullNormal(t, y, side);
    p.addScaledVector(n, 0.42);
    const shank = V(p.x - 2.7, p.y - 3.0, p.z + n.z * 0.3);
    b.add(strut(V(p.x + 0.9, p.y + 1.2, p.z), shank, 0.14, 5), m.iron);
    // Stock and arms.
    b.add(strut(V(p.x + 0.6, p.y + 0.6, p.z - side * 1.5), V(p.x + 0.9, p.y + 1.0, p.z + side * 1.4), 0.1, 4), m.wood);
    for (const f of [1, -1]) {
      const fluke = V(shank.x - 0.3, shank.y + 1.1, shank.z + f * 1.5);
      b.add(strut(shank, fluke, 0.12, 4), m.iron);
    }
  }

  // Hammock cranes: the netting stanchions along the rail.
  for (const side of [1, -1]) {
    for (let i = 0; i < 26; i++) {
      const t = -0.82 + (i / 25) * 1.62;
      const y = sheeredY(t, RAIL_Y);
      const p = hullAt(t, y, side);
      const iz = inboardHalf(t, RAIL_Y);
      b.addAt(box(0.1, 0.62, 0.1), m.black, [p.x, y, side * (iz + 0.04)]);
    }
    // Two rails through the stanchion heads.
    for (const dy of [0.36, 0.6]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = -0.82 + (i / 8) * 1.62;
        pts.push(V(levelX(t, RAIL_Y), sheeredY(t, RAIL_Y) + dy, side * (inboardHalf(t, RAIL_Y) + 0.04)));
      }
      for (let i = 0; i < pts.length - 1; i++) rope(b, m.rig, pts[i], pts[i + 1], 0.04);
    }
  }
}

/** A clinker-built ship's boat, roughly lofted. */
function boat(
  b: Builder,
  m: Mats,
  x: number,
  y: number,
  z: number,
  len: number,
  beam: number,
  depth: number,
): void {
  const rows: THREE.Vector3[][] = [];
  const LV = [
    [0.0, 0.05],
    [0.42, 0.3],
    [0.78, 0.62],
    [0.96, 1.0],
  ];
  const N = 10;
  for (const [r, h] of LV) {
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1;
      const taper = Math.sqrt(Math.max(0, 1 - Math.abs(u) ** 2.4));
      row.push(V(x + (u * len) / 2, y + h * depth, z));
      row[row.length - 1].z = z;
      row[row.length - 1].z = z;
      const half = (beam / 2) * r * taper;
      row[row.length - 1].z = z + half;
    }
    rows.push(row);
  }
  // Starboard then port halves, each as a grid, plus a gunwale.
  for (const side of [1, -1]) {
    const sided = rows.map((row) => row.map((p) => V(p.x, p.y, z + (p.z - z) * side)));
    b.add(gridGeometry(sided, side > 0), m.white);
  }
  b.addAt(box(len * 0.98, 0.1, beam * 0.99), m.wood, [x, y + depth, z]);
}

/* ------------------------------------------------------------------- flags */

function flags(b: Builder, m: Mats, ctx: Ctx): void {
  const M = materialsFor(ctx);
  const ensignMat = new THREE.MeshStandardMaterial({
    map: ensignTexture(),
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  ensignMat.name = 'landmark:ensign';
  M.registerNightLit(ensignMat);
  ensignMat.userData.nightPeak = 0;
  const jackMat = new THREE.MeshStandardMaterial({
    map: jackTexture(),
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  jackMat.name = 'landmark:jack';
  M.registerNightLit(jackMat);
  jackMat.userData.nightPeak = 0;

  // Ensign at the peak of the spanker gaff: 3.3 x 6.3 m, luff up the gaff.
  b.add(wave(V(MIZZEN.x - 13.2, 20.2, 0), 6.3, 3.3, -0.45, 0.9), ensignMat);
  // Jack at the bowsprit cap.
  b.add(wave(V(HALF_LEN + 10.6, 11.9, 0), 2.4, 1.6, -0.2, 0.7), jackMat);
  // Commission pennant at the main truck.
  b.addAt(box(0.06, 0.06, 0.06), m.white, [MAIN.x, MAIN.truck, 0]);
}

/**
 * A flag: a quad rippled in Z so it catches light on both faces. Hung from a
 * vertical luff at `p`, flying toward -X (she lies bow-to-the-north-west, so
 * the ensign blows aft over the counter).
 */
function wave(p: THREE.Vector3, len: number, hgt: number, dip: number, amp: number): THREE.BufferGeometry {
  const NU = 10;
  const NV = 3;
  const rows: THREE.Vector3[][] = [];
  for (let j = 0; j <= NV; j++) {
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const v = j / NV;
      row.push(
        V(
          p.x - u * len,
          p.y - v * hgt + dip * u + Math.sin(u * 5.0) * 0.12 * u,
          p.z + Math.sin(u * 4.2 + v * 1.1) * amp * u * u,
        ),
      );
    }
    rows.push(row);
  }
  const g = gridGeometry(rows, false);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      uv.setXY(j * (NU + 1) + i, i / NU, 1 - j / NV);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/* -------------------------------------------------------------- assembly */

export function buildShip(ctx: Ctx, detail: boolean): THREE.Group {
  const m = makeMats(ctx);
  const b = new Builder();

  hullBands(b, m, detail);
  hullBottom(b, m);
  gunPorts(b, m, detail);
  if (detail) sparPorts(b, m);
  sparDeck(b, m, detail);
  stern(b, m, detail);
  head(b, m, detail);
  channels(b, m);
  for (const s of MASTS) {
    mastStack(b, m, s, detail);
    yards(b, m, s, detail);
  }
  standingRig(b, m, detail);
  bowsprit(b, m, detail);
  fittings(b, m, detail);
  if (detail) flags(b, m, ctx);

  // Moored: fenders and mooring lines to the pier, which lies to starboard.
  if (detail) {
    for (const side of [1]) {
      for (const t of [-0.62, -0.2, 0.22, 0.6]) {
        const y = sheeredY(t, 3.0);
        const p = hullAt(t, y, side);
        const n = hullNormal(t, y, side);
        p.addScaledVector(n, 0.3);
        b.addAt(cyl(0.42, 0.42, 1.5, 8), m.dark, [p.x, p.y - 0.75, p.z]);
      }
    }
  }

  const g = b.build('uss-constitution');
  g.userData.triangles = b.triangles;
  void BEAM;
  void HALF_BEAM;
  void KEEL_Y;
  void COPPER_Y;
  void rect;
  return g;
}
