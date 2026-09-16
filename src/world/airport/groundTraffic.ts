/**
 * Ground movement for a small "featured" fleet: pushback, taxi-out on the
 * real derived taxiway route, hold short, line up, takeoff roll with
 * rotation at a real speed, a climb-and-turn-back flight loop, approach,
 * flare, rollout, turn-off, and taxi back in — closing the circuit so an
 * aircraft that lands actually rolls out and taxis rather than vanishing.
 *
 * This is deliberately a separate small fleet from the six ambient loop
 * tracks in `aircraft.ts` (which stay exactly as they were): retrofitting the
 * shared, already-tuned loop-and-wrap system to grow a ground phase risked
 * the good work already there for a two-mile detour, whereas a dedicated
 * fleet gets the full gate-to-air-and-back story and, with more than one
 * aircraft sharing the one derived runway/taxi route, a natural queue at
 * hold-short for free.
 *
 * Positions are plain [x,z] tuples and altitude is carried separately, same
 * spirit as `layout.ts` — no THREE types needed until `aircraft.ts` turns a
 * `Pose` into a matrix.
 */
import type { Ctx } from '../../core/Context';
import type { LoganLayout, RunwaySpec } from './layout';
import type { GateStand } from './gates';

type Phase =
  | 'gate' | 'pushback' | 'taxiOut' | 'holdShort' | 'lineup'
  | 'roll' | 'airborne' | 'rollout' | 'taxiIn';

interface TypePerf {
  /** Rotation speed, m/s — reuses aircraft.ts's own threshold speeds. */
  vr: number;
  climbSpeed: number;
  climbGrad: number;
  approachSpeed: number;
  accel: number;
  decel: number;
}

/** Narrowbody and widebody, matching the speeds already in aircraft.ts's tracks(). */
const PERF: TypePerf[] = [
  { vr: 72, climbSpeed: 86, climbGrad: 0.079, approachSpeed: 72, accel: 2.35, decel: 2.6 },
  { vr: 78, climbSpeed: 84, climbGrad: 0.075, approachSpeed: 78, accel: 1.85, decel: 2.2 },
];

const PUSHBACK_TIME = 7;
const TAXI_SPEED = 9.5;
const HOLD_MIN = 6;
const LINEUP_TIME = 4;
const BASE_ALT = 6;

export interface Pose {
  x: number; y: number; z: number;
  heading: number; pitch: number; bank: number; gear: number;
}

interface AirPath {
  pts: [number, number, number][];
  segLen: number[];
  total: number;
}

class GroundAircraft {
  phase: Phase = 'gate';
  t = 0;
  dwell = 14;
  holdTimer = 0;
  routeDist = 0;
  s = 0;
  speed = 0;
  air: AirPath | null = null;
  airS = 0;
  turnSign: 1 | -1 = 1;
  pose: Pose = { x: 0, y: BASE_ALT, z: 0, heading: 0, pitch: 0, bank: 0, gear: 1 };

  constructor(readonly type: number, readonly gateXZ: [number, number]) {
    this.pose.x = gateXZ[0];
    this.pose.z = gateXZ[1];
  }
}

function dist2(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Position + heading at arc-length `d` along a polyline (clamped at the ends). */
function marchXZ(route: readonly [number, number][], d: number): { x: number; z: number; heading: number; done: boolean; total: number } {
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < route.length; i++) { const l = dist2(route[i - 1], route[i]); lens.push(l); total += l; }
  if (!route.length) return { x: 0, z: 0, heading: 0, done: true, total: 0 };
  if (d <= 0) {
    const a = route[0], b = route[1] ?? route[0];
    return { x: a[0], z: a[1], heading: Math.atan2(b[0] - a[0], -(b[1] - a[1])), done: false, total };
  }
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= d || i === lens.length - 1) {
      const a = route[i], b = route[i + 1];
      const t = lens[i] > 1e-6 ? Math.min(1, (d - acc) / lens[i]) : 1;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const heading = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
      return { x, z, heading, done: d >= total, total };
    }
    acc += lens[i];
  }
  const last = route[route.length - 1];
  return { x: last[0], z: last[1], heading: 0, done: true, total };
}

/**
 * The airborne loop: climb straight out past the far threshold, a levelled
 * semicircle back the other way (a real racetrack necessarily lands the
 * reverse leg offset from the outbound one — closing that gap in one more
 * straight leg is a small liberty, taken to keep an already-long derivation
 * to fully closed-form legs, and it happens far out over the harbour at
 * altitude, not at the airport itself), then a 3-degree final back to the
 * *other* threshold.
 */
function buildAirPath(rw: RunwaySpec, perf: TypePerf, turnSign: 1 | -1): AirPath {
  const [ax, az] = rw.axis;
  const px = -az * turnSign, pz = ax * turnSign;
  const liftAlt = BASE_ALT + rw.length * 0.35 * perf.climbGrad;
  const pts: [number, number, number][] = [];

  // Climb straight out past thresholdB.
  pts.push([rw.thresholdB[0], BASE_ALT, rw.thresholdB[1]]);
  const climbOut = 2600;
  const p1x = rw.thresholdB[0] + ax * climbOut, p1z = rw.thresholdB[1] + az * climbOut;
  const p1alt = BASE_ALT + climbOut * perf.climbGrad;
  pts.push([p1x, p1alt, p1z]);

  // Levelled semicircle of radius R, offsetting the return leg by 2R.
  const R = 950;
  const cx = p1x + px * R, cz = p1z + pz * R;
  const arcAlt = p1alt;
  const steps = 7;
  for (let i = 1; i <= steps; i++) {
    const theta = (Math.PI * i) / steps;
    const x = cx - R * Math.cos(theta) * px + R * Math.sin(theta) * ax;
    const z = cz - R * Math.cos(theta) * pz + R * Math.sin(theta) * az;
    pts.push([x, arcAlt, z]);
  }

  // Brief level leg heading back, then a diagonal intercept onto the real
  // extended centreline for thresholdA's approach corridor.
  const backX = p1x + px * 2 * R - ax * 900, backZ = p1z + pz * 2 * R - az * 900;
  pts.push([backX, arcAlt, backZ]);

  const outDist = 4400;
  const appX = rw.thresholdA[0] - ax * outDist, appZ = rw.thresholdA[1] - az * outDist;
  const appAlt = BASE_ALT + outDist * 0.0524;
  pts.push([appX, appAlt, appZ]);

  // Standard 3-degree final into thresholdA.
  const mid = outDist * 0.5;
  pts.push([rw.thresholdA[0] - ax * mid, BASE_ALT + mid * 0.0524, rw.thresholdA[1] - az * mid]);
  pts.push([rw.thresholdA[0], BASE_ALT, rw.thresholdA[1]]);
  // Touch down and roll a short distance past the threshold before the
  // dedicated rollout phase (which uses the runway's own `s` coordinate)
  // takes over — this just keeps the flare visually on the pavement.
  pts.push([rw.thresholdA[0] + ax * 60, BASE_ALT, rw.thresholdA[1] + az * 60]);

  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    segLen.push(l);
    total += l;
  }
  return { pts, segLen, total };
}

function marchAir(air: AirPath, d: number): { x: number; y: number; z: number; heading: number; rise: number; done: boolean } {
  let acc = 0;
  for (let i = 0; i < air.segLen.length; i++) {
    const l = air.segLen[i];
    if (acc + l >= d || i === air.segLen.length - 1) {
      const a = air.pts[i], b = air.pts[i + 1];
      const t = l > 1e-6 ? Math.min(1, (d - acc) / l) : 1;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      const heading = Math.atan2(b[0] - a[0], -(b[2] - a[2]));
      const rise = l > 1e-6 ? (b[1] - a[1]) / l : 0;
      return { x, y, z, heading, rise, done: d >= air.total };
    }
    acc += l;
  }
  const last = air.pts[air.pts.length - 1];
  return { x: last[0], y: last[1], z: last[2], heading: 0, rise: 0, done: true };
}

/** Distance of `hold`/threshold along the runway axis from thresholdA, signed. */
function alongAxis(rw: RunwaySpec, p: readonly [number, number]): number {
  return (p[0] - rw.thresholdA[0]) * rw.axis[0] + (p[1] - rw.thresholdA[1]) * rw.axis[1];
}

export class GroundFleet {
  readonly list: GroundAircraft[] = [];
  private runwayHolder: GroundAircraft | null = null;
  private readonly holdAt: number;

  constructor(private readonly layout: LoganLayout, stands: GateStand[], counts: readonly [number, number]) {
    this.holdAt = alongAxis(layout.primary, layout.holdShort);
    let n = 0;
    for (let type = 0; type < counts.length; type++) {
      for (let i = 0; i < counts[type]; i++) {
        const gate = stands[n % Math.max(1, stands.length)]?.position ?? layout.gate;
        const a = new GroundAircraft(type, gate);
        a.turnSign = n % 2 === 0 ? 1 : -1;
        // Stagger starting phases so the fleet is never all in 'gate' at
        // once — see aircraft.ts's report for why this matters for QA.
        this.seed(a, n);
        this.list.push(a);
        n++;
      }
    }
  }

  /** Places aircraft `n` partway into a distinct phase at construction time. */
  private seed(a: GroundAircraft, n: number): void {
    const rw = this.layout.primary;
    const route = this.layout.taxiRoute;
    switch (n % 4) {
      case 0:
        a.phase = 'gate'; a.dwell = 6;
        break;
      case 1: {
        a.phase = 'taxiOut';
        a.routeDist = routeLength(route) * 0.4;
        break;
      }
      case 2: {
        a.phase = 'holdShort';
        a.holdTimer = 0;
        a.pose.heading = Math.atan2(rw.axis[0], -rw.axis[1]);
        a.pose.x = this.layout.holdShort[0]; a.pose.z = this.layout.holdShort[1];
        break;
      }
      default: {
        a.phase = 'airborne';
        a.air = buildAirPath(rw, PERF[a.type], a.turnSign);
        a.airS = a.air.total * 0.5;
        break;
      }
    }
  }

  step(dt: number, ctx: Ctx): void {
    for (const a of this.list) this.stepOne(a, dt, ctx);
  }

  private stepOne(a: GroundAircraft, dt: number, ctx: Ctx): void {
    const layout = this.layout;
    const rw = layout.primary;
    const perf = PERF[a.type];
    const p = a.pose;

    switch (a.phase) {
      case 'gate': {
        a.dwell -= dt;
        p.gear = 1; p.pitch = 0; p.bank = 0;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        if (a.dwell <= 0) { a.phase = 'pushback'; a.t = 0; }
        break;
      }
      case 'pushback': {
        a.t += dt;
        const k = Math.min(1, a.t / PUSHBACK_TIME);
        const target = layout.taxiRoute[1] ?? layout.taxiRoute[0];
        p.x = a.gateXZ[0] + (target[0] - a.gateXZ[0]) * k;
        p.z = a.gateXZ[1] + (target[1] - a.gateXZ[1]) * k;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        p.heading = Math.atan2(target[0] - a.gateXZ[0], -(target[1] - a.gateXZ[1]));
        if (k >= 1) { a.phase = 'taxiOut'; a.routeDist = dist2(layout.taxiRoute[0], layout.taxiRoute[1] ?? layout.taxiRoute[0]); }
        break;
      }
      case 'taxiOut': {
        a.routeDist += TAXI_SPEED * dt;
        const m = marchXZ(layout.taxiRoute, a.routeDist);
        p.x = m.x; p.z = m.z; p.heading = m.heading;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        if (m.done) {
          a.phase = 'holdShort'; a.holdTimer = 0;
          p.x = layout.holdShort[0]; p.z = layout.holdShort[1];
          p.heading = Math.atan2(rw.axis[0], -rw.axis[1]);
        }
        break;
      }
      case 'holdShort': {
        a.holdTimer += dt;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        if (a.holdTimer >= HOLD_MIN && (this.runwayHolder === null || this.runwayHolder === a)) {
          this.runwayHolder = a;
          a.phase = 'lineup'; a.t = 0;
        }
        break;
      }
      case 'lineup': {
        a.t += dt;
        const k = Math.min(1, a.t / LINEUP_TIME);
        p.x = layout.holdShort[0] + (rw.thresholdA[0] - layout.holdShort[0]) * k;
        p.z = layout.holdShort[1] + (rw.thresholdA[1] - layout.holdShort[1]) * k;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        p.heading = Math.atan2(rw.axis[0], -rw.axis[1]);
        if (k >= 1) { a.phase = 'roll'; a.s = 0; a.speed = 0; }
        break;
      }
      case 'roll': {
        a.speed = Math.min(perf.vr, a.speed + perf.accel * dt);
        a.s += a.speed * dt;
        p.x = rw.thresholdA[0] + rw.axis[0] * a.s;
        p.z = rw.thresholdA[1] + rw.axis[1] * a.s;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        p.heading = Math.atan2(rw.axis[0], -rw.axis[1]);
        p.gear = 1; p.bank = 0;
        p.pitch = a.speed >= perf.vr * 0.96 ? 0.09 : 0;
        if (a.s >= rw.length * 0.62 && a.speed >= perf.vr * 0.96) {
          a.phase = 'airborne';
          a.air = buildAirPath(rw, perf, a.turnSign);
          a.airS = 0;
        }
        break;
      }
      case 'airborne': {
        const air = a.air!;
        const speed = air.total > 0 && a.airS < air.total * 0.55 ? perf.climbSpeed
          : lerp(perf.climbSpeed, perf.approachSpeed, easeInOut(clamp01((a.airS - air.total * 0.55) / (air.total * 0.4))));
        a.airS += speed * dt;
        const m = marchAir(air, a.airS);
        p.x = m.x; p.y = m.y; p.z = m.z; p.heading = m.heading;
        const tailK = clamp01((a.airS - air.total * 0.985) / (air.total * 0.015 + 1e-3));
        p.pitch = (1 - tailK) * Math.asin(clamp(-1, 1, m.rise)) * 0.85;
        p.gear = a.airS < air.total * 0.05 ? lerp(1, 0, clamp01(a.airS / (air.total * 0.05)))
          : a.airS > air.total * 0.93 ? lerp(0, 1, clamp01((a.airS - air.total * 0.93) / (air.total * 0.07)))
          : (a.airS < air.total * 0.5 ? 0 : 0);
        // Bank into and out of the turn only (roughly the middle third).
        const turnT = clamp01((a.airS - air.total * 0.18) / (air.total * 0.45));
        const bankShape = Math.sin(Math.PI * turnT) * (turnT > 0 && turnT < 1 ? 1 : 0);
        p.bank = a.turnSign * 0.22 * bankShape;
        if (m.done) {
          a.phase = 'rollout';
          a.s = rw.length;
          a.speed = perf.approachSpeed;
          p.gear = 1;
          if (this.runwayHolder === a) this.runwayHolder = null;
        }
        break;
      }
      case 'rollout': {
        a.speed = Math.max(TAXI_SPEED, a.speed - perf.decel * dt);
        a.s -= a.speed * dt;
        p.x = rw.thresholdA[0] + rw.axis[0] * a.s;
        p.z = rw.thresholdA[1] + rw.axis[1] * a.s;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        p.heading = Math.atan2(-rw.axis[0], rw.axis[1]);
        p.gear = 1; p.pitch = 0; p.bank = 0;
        if (this.runwayHolder === a && a.speed <= TAXI_SPEED * 1.4) this.runwayHolder = null;
        if (a.s <= this.holdAt) {
          a.phase = 'taxiIn';
          a.routeDist = routeLength(layout.taxiRoute);
          if (this.runwayHolder === a) this.runwayHolder = null;
        }
        break;
      }
      case 'taxiIn': {
        a.routeDist -= TAXI_SPEED * dt;
        const m = marchXZ(layout.taxiRoute, Math.max(0, a.routeDist));
        p.x = m.x; p.z = m.z;
        p.heading = m.heading + Math.PI;
        p.y = ctx.sampleHeight(p.x, p.z) + 0.05;
        if (a.routeDist <= 0) {
          a.phase = 'gate'; a.dwell = 16 + (a.type + 1) * 6;
          p.x = a.gateXZ[0]; p.z = a.gateXZ[1];
        }
        break;
      }
    }
  }
}

function routeLength(route: readonly [number, number][]): number {
  let d = 0;
  for (let i = 1; i < route.length; i++) d += dist2(route[i - 1], route[i]);
  return d;
}
function clamp(min: number, max: number, v: number): number { return Math.max(min, Math.min(max, v)); }
function clamp01(v: number): number { return clamp(0, 1, v); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function easeInOut(t: number): number { return t * t * (3 - 2 * t); }
