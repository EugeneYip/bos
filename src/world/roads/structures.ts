/**
 * Structures: bridge decks, tunnel portals and railway track.
 *
 * A bridge drawn as a floating ribbon is the single most obvious tell that a
 * city model was generated rather than built, so every `bridge`/`layer > 0`
 * way gets a deck of real depth, a fascia, parapets, and piers that go down
 * to whatever is underneath.
 *
 * Tunnels are the mirror image: nothing is drawn on the surface at all (the
 * Big Dig put I-93 under downtown; drawing it would put a motorway through
 * the middle of Boston), and each mouth gets a trench, retaining walls, a
 * headwall and a bore that actually looks dark.
 */
import type { MeshBuilder } from './builder';
import { rgba } from './builder';
import { emitBox, emitQuad, emitWall } from './geom';
import { type V2, dist, hash01, norm, perp, resample, sub } from './math2';
import type { PreparedRoad } from './network';
import { type Ribbon, wave } from './carriage';
import { type Row, buildFrame, emitStrip, offsetAt, sampleAt } from './ribbon';
import { TUNE, crownDy } from './spec';

export type Sample = (x: number, z: number) => number;

/* ------------------------------------------------------------------ bridge */

/**
 * Deck, parapets and piers for one bridge chunk. The carriageway itself is
 * emitted by the normal ribbon path; this adds everything that makes it a
 * structure instead of a painted stripe in mid air.
 */
export function emitBridge(
  out: MeshBuilder, rib: Ribbon, tile: number, sample: Sample,
): void {
  const { hw, rungs, seed } = rib;
  if (rungs.length < 2) return;
  const gY = crownDy(hw, hw, false);
  const walkY = gY + 0.17;           // raised safety walk either side
  const inner = hw + 0.62;           // face of the parapet
  const outer = hw + 0.99;           // fascia line
  const capY = walkY + TUNE.parapetHeight;
  const soffit = gY - TUNE.deckThickness;

  const deckC = rgba(0xffffff, 1, 1);
  const shadeC = rgba(0xffffff, 0.62, 1);
  const soffitC = rgba(0xffffff, 0.44, 1);
  const tint = (r: { s: number }): number => 0.92 + wave(seed + 401, r.s * 0.07) * 0.17;

  for (const s of [1, -1] as const) {
    // Upstand between the carriageway and the safety walk.
    const face: Row[] = s === 1
      ? [{ a: hw * s, dy: walkY, c: deckC }, { a: hw * s, dy: gY, c: shadeC }]
      : [{ a: hw * s, dy: gY, c: shadeC }, { a: hw * s, dy: walkY, c: deckC }];
    emitStrip(out, rungs, face, {
      uv: 'local', tile, lift: TUNE.surfaceLift, nrm: s === 1 ? 'right' : 'left', tintAt: tint,
    });

    // Safety walk.
    const walk: Row[] = s === 1
      ? [{ a: inner * s, dy: walkY, c: deckC }, { a: hw * s, dy: walkY, c: deckC }]
      : [{ a: hw * s, dy: walkY, c: deckC }, { a: inner * s, dy: walkY, c: deckC }];
    emitStrip(out, rungs, walk, {
      uv: 'world', tile, lift: TUNE.surfaceLift, nrm: 'grade', tintAt: tint,
    });

    // Parapet: inner face, coping, outer face all the way down to the soffit.
    const innerFace: Row[] = s === 1
      ? [{ a: inner * s, dy: capY, c: deckC }, { a: inner * s, dy: walkY, c: shadeC }]
      : [{ a: inner * s, dy: walkY, c: shadeC }, { a: inner * s, dy: capY, c: deckC }];
    emitStrip(out, rungs, innerFace, {
      uv: 'local', tile, lift: TUNE.surfaceLift, nrm: s === 1 ? 'right' : 'left', tintAt: tint,
    });

    const coping: Row[] = s === 1
      ? [{ a: outer * s, dy: capY, c: deckC }, { a: inner * s, dy: capY, c: deckC }]
      : [{ a: inner * s, dy: capY, c: deckC }, { a: outer * s, dy: capY, c: deckC }];
    emitStrip(out, rungs, coping, {
      uv: 'local', tile, lift: TUNE.surfaceLift, nrm: 'up', tintAt: tint,
    });

    const outerFace: Row[] = s === 1
      ? [{ a: outer * s, dy: soffit, c: soffitC }, { a: outer * s, dy: capY, c: deckC }]
      : [{ a: outer * s, dy: capY, c: deckC }, { a: outer * s, dy: soffit, c: soffitC }];
    emitStrip(out, rungs, outerFace, {
      uv: 'local', tile, lift: TUNE.surfaceLift, nrm: s === 1 ? 'left' : 'right', tintAt: tint,
    });
  }

  // Soffit, seen from the river or the road below.
  emitStrip(out, rungs, [
    { a: -outer, dy: soffit, c: soffitC },
    { a: outer, dy: soffit, c: soffitC },
  ], { uv: 'world', tile, lift: TUNE.surfaceLift, nrm: 'down' });

  // --- piers ---------------------------------------------------------------
  const len = rib.len;
  const spacing = TUNE.pierSpacing;
  const n = Math.floor(len / spacing);
  for (let k = 0; k <= n; k++) {
    const s = n === 0 ? len * 0.5 : (k + 0.5) * (len / (n + 1));
    if (s < 4 || s > len - 4) continue;
    const sm = sampleAt(rungs, s);
    const ground = sample(sm.p.x, sm.p.z);
    const top = sm.y + soffit + TUNE.surfaceLift;
    const drop = top - ground;
    // A 1 m clearance is an underpass lintel, not a pier; leave it alone.
    if (!Number.isFinite(ground) || drop < 1.6) continue;

    const across = Math.min(hw * 1.25, 5.4);
    const stemW = Math.max(1.15, Math.min(2.1, hw * 0.34));
    // Pier cap spreads the deck load, then a stem down to the footing.
    emitBox(out, sm.p.x, sm.p.z, sm.t, 1.9, across, top - 0.85, top, shadeC, tile);
    emitBox(
      out, sm.p.x, sm.p.z, sm.t, stemW, Math.min(across * 0.62, 3.2),
      ground - 0.7, top - 0.8, rgba(0xffffff, 0.55, 1), tile,
    );
  }
}

/* ------------------------------------------------------------------ portal */

export interface Portal {
  p: V2;
  y: number;
  dir: V2;
  width: number;
  road: PreparedRoad;
}

/**
 * A tunnel mouth: an approach trench cut down from the surface, retaining
 * walls that grow with the cut, a headwall, and a bore behind it that is
 * genuinely dark rather than a black-painted wall.
 */
export function emitPortal(
  struct: MeshBuilder, dark: MeshBuilder, road: PreparedRoad, end: 0 | 1,
  surfaceY: number, tile: number, sample: Sample,
): void {
  const src = end === 0 ? road.pts : road.pts.slice().reverse();
  const srcY = end === 0 ? road.ys : road.ys.slice().reverse();
  if (src.length < 2) return;

  const hw = Math.max(3, road.halfWidth);
  const head = Math.max(4.9, Math.min(6.6, hw * 0.85));   // clear bore height
  const cut = head + 0.9;                                  // depth at the face
  const maxRun = Math.min(58, Math.max(16, road.length * 0.55));

  // Walk the tunnel alignment for `maxRun` metres, ramping down as we go.
  const pts: V2[] = [src[0]];
  const ys: number[] = [surfaceY];
  let run = 0;
  for (let i = 1; i < src.length && run < maxRun; i++) {
    const d = dist(src[i - 1], src[i]);
    if (d < 1e-4) continue;
    const next = Math.min(run + d, maxRun);
    const t = next / maxRun;
    const e = t * t * (3 - 2 * t);
    pts.push(next < run + d ? lerpTo(src[i - 1], src[i], (next - run) / d) : src[i]);
    ys.push(surfaceY - cut * e);
    run = next;
    if (run >= maxRun) break;
  }
  void srcY;
  if (pts.length < 2 || run < 10) return;

  const rs = resample(pts, ys, 9, 5);
  const rungs = buildFrame(rs.pts, rs.ys, hw + 1.4);
  if (rungs.length < 2) return;
  const len = rungs[rungs.length - 1].s;

  const roadC = rgba(0xffffff, 0.9, 1);
  const wallC = rgba(0xffffff, 0.72, 1);
  const capC = rgba(0xffffff, 0.95, 1);

  // Trench floor.
  emitStrip(struct, rungs, [
    { a: hw, dy: 0, c: roadC },
    { a: 0, dy: 0.02, c: roadC },
    { a: -hw, dy: 0, c: roadC },
  ], { uv: 'world', tile, lift: 0, nrm: 'grade' });

  // Retaining walls, growing out of the ground as the road drops away.
  for (const s of [1, -1] as const) {
    const a = (hw + 0.42) * s;
    const topDy = (r: { p: V2; y: number }): number => {
      const g = sample(r.p.x, r.p.z);
      const crest = (Number.isFinite(g) ? Math.max(g, surfaceY - 0.4) : surfaceY) + 0.32;
      return Math.max(0.35, crest - r.y);
    };
    const rows: Row[] = s === 1
      ? [{ a, dy: 0, c: capC }, { a, dy: 0, c: wallC }]
      : [{ a, dy: 0, c: wallC }, { a, dy: 0, c: capC }];
    emitStrip(struct, rungs, rows, {
      uv: 'local',
      tile,
      lift: 0,
      nrm: s === 1 ? 'right' : 'left',
      dyAt: (r, row) => ((s === 1 ? row === 0 : row === 1) ? topDy(r) : -0.3),
    });
  }

  // --- headwall and bore ---------------------------------------------------
  const endR = rungs[rungs.length - 1];
  const floorY = endR.y;
  const crown = floorY + head;
  const capTop = Math.max(crown + 0.85, surfaceY - cut + head + 0.85);
  const wing = hw + 1.65;
  const l = (a: number): V2 => offsetAt(endR, a);
  const t = endR.t;

  // Face: two cheeks and a lintel, leaving the bore open.
  emitWall(struct, l(wing), l(hw + 0.1), floorY - 0.4, capTop, floorY - 0.4, capTop, wallC, tile, true);
  emitWall(struct, l(-(hw + 0.1)), l(-wing), floorY - 0.4, capTop, floorY - 0.4, capTop, wallC, tile, true);
  emitWall(struct, l(hw + 0.1), l(-(hw + 0.1)), crown, capTop, crown, capTop, capC, tile, true);
  // Coping along the top of the face.
  emitQuad(
    struct,
    l(wing), { x: l(wing).x + t.x * 0.5, z: l(wing).z + t.z * 0.5 },
    { x: l(-wing).x + t.x * 0.5, z: l(-wing).z + t.z * 0.5 }, l(-wing),
    capTop, capTop, capTop, capTop, capC, tile,
  );

  // Bore: a recessed box so the mouth reads as depth, not as a black decal.
  const depth = 16;
  const back = (a: number): V2 => ({ x: l(a).x + t.x * depth, z: l(a).z + t.z * depth });
  const voidC = rgba(0xffffff, 1, 1);
  const bw = hw + 0.08;
  emitWall(dark, back(bw), back(-bw), floorY - 0.2, crown, floorY - 0.2, crown, voidC, 1, true);
  emitWall(dark, l(bw), back(bw), floorY - 0.2, crown, floorY - 0.2, crown, voidC, 1, true);
  emitWall(dark, back(-bw), l(-bw), floorY - 0.2, crown, floorY - 0.2, crown, voidC, 1, true);
  emitQuad(dark, l(bw), back(bw), back(-bw), l(-bw), crown, crown, crown, crown, voidC, 1);
  emitQuad(
    dark, l(-bw), back(-bw), back(bw), l(bw),
    floorY - 0.12, floorY - 0.12, floorY - 0.12, floorY - 0.12, voidC, 1,
  );
}

function lerpTo(a: V2, b: V2, t: number): V2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/* -------------------------------------------------------------------- rail */

const GAUGE = 0.7175; // half of 1435 mm standard gauge

/** Ballast shoulder and running rails. */
export function emitTrack(
  ballastOut: MeshBuilder, steelOut: MeshBuilder, rib: Ribbon,
  ballastTile: number, steelTile: number,
): void {
  const { rungs, seed } = rib;
  if (rungs.length < 2) return;
  const shoulder = Math.max(2.5, rib.hw * 0.78);
  const bc = rgba(0xffffff, 1, 1);
  const bcDark = rgba(0xffffff, 0.68, 1);

  emitStrip(ballastOut, rungs, [
    { a: shoulder + 0.95, dy: -0.78, c: bcDark },
    { a: shoulder, dy: -0.30, c: bc },
    { a: -shoulder, dy: -0.30, c: bc },
    { a: -(shoulder + 0.95), dy: -0.78, c: bcDark },
  ], {
    uv: 'world',
    tile: ballastTile,
    lift: TUNE.surfaceLift,
    nrm: 'grade',
    tintAt: (r) => 0.88 + wave(seed + 71, r.s * 0.1) * 0.22,
  });

  // Rail heads: thin, bright and continuous — they read from a long way off.
  const railC = rgba(0xffffff, 1.45, 1);
  const webC = rgba(0xffffff, 0.5, 1);
  for (const c of [GAUGE, -GAUGE]) {
    const w = 0.038;
    emitStrip(steelOut, rungs, [
      { a: c + w, dy: -0.15, c: webC },
      { a: c + w, dy: -0.005, c: railC },
      { a: c - w, dy: -0.005, c: railC },
      { a: c - w, dy: -0.15, c: webC },
    ], { uv: 'local', tile: steelTile, lift: TUNE.surfaceLift, nrm: 'up' });
  }
}

/** Sleepers — near-field only; there are half a million of them city-wide. */
export function emitSleepers(out: MeshBuilder, rib: Ribbon, tile: number): void {
  const { rungs, seed, len } = rib;
  const step = 0.68;
  const c = rgba(0xffffff, 0.62, 1);
  for (let s = 0.3; s < len; s += step) {
    const sm = sampleAt(rungs, s);
    const j = hash01(seed + Math.round(s * 37)) - 0.5;
    emitBox(
      out, sm.p.x, sm.p.z, sm.t, 0.26, 2.55,
      sm.y - 0.3 + TUNE.surfaceLift, sm.y - 0.15 + TUNE.surfaceLift + j * 0.012,
      c, tile,
    );
  }
}

export { norm, perp, sub };
