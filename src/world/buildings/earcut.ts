/**
 * Ear-clipping polygon triangulation with hole support.
 *
 * A self-contained implementation so the whole meshing pipeline can run inside
 * a Web Worker without pulling three.js (and ~1 MB of unrelated code) into the
 * worker bundle. Footprints are tiny — 4 to 40 vertices — so the plain O(n²)
 * ear scan is comfortably fast, and it has far fewer ways to go wrong on dirty
 * OpenStreetMap geometry than anything cleverer.
 *
 * Input is a flat `[x0,y0, x1,y1, ...]` list: the outer ring first, then each
 * hole, with `holeIndices` giving the *vertex* index where each hole starts.
 * Winding is normalised internally (outer counter-clockwise, holes clockwise),
 * so callers may pass rings either way round.
 *
 * Every path is total: degenerate input yields an empty list, never an
 * exception, because one bad footprint must never abort a city-wide load.
 */

interface Node {
  /** Index into the source coordinate array (always even). */
  i: number;
  x: number;
  y: number;
  prev: Node;
  next: Node;
}

function makeNode(i: number, x: number, y: number): Node {
  const n = { i, x, y } as Node;
  n.prev = n;
  n.next = n;
  return n;
}

function insertAfter(tail: Node | null, node: Node): Node {
  if (!tail) return node;
  node.next = tail.next;
  node.prev = tail;
  tail.next.prev = node;
  tail.next = node;
  return node;
}

function removeNode(n: Node): void {
  n.next.prev = n.prev;
  n.prev.next = n.next;
}

/** Twice the signed area of the triangle, negative for a convex (CCW) corner. */
const turn = (a: Node, b: Node, c: Node): number => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);

const same = (a: Node, b: Node): boolean => a.x === b.x && a.y === b.y;

/** Shoelace over a slice of the coordinate array; positive means CCW. */
function ringArea(data: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
  }
  return sum;
}

/** Circular doubly-linked list for one ring, forced to the requested winding. */
function buildRing(data: number[], start: number, end: number, ccw: boolean): Node | null {
  let last: Node | null = null;
  if (ringArea(data, start, end) > 0 === ccw) {
    for (let i = start; i < end; i += 2) last = insertAfter(last, makeNode(i, data[i], data[i + 1]));
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertAfter(last, makeNode(i, data[i], data[i + 1]));
  }
  if (!last || last.next === last) return null;
  return filterPoints(last, last);
}

/** Drop duplicate and exactly-collinear vertices; they can never form an ear. */
function filterPoints(start: Node | null, end?: Node | null): Node | null {
  if (!start) return null;
  let e = end ?? start;
  let p = start;
  let again: boolean;
  let guard = 1 << 20;
  do {
    again = false;
    if (guard-- < 0) return e;
    if (same(p, p.next) || turn(p.prev, p, p.next) === 0) {
      removeNode(p);
      p = e = p.prev;
      if (p === p.next) return null;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== e);
  return e;
}

function pointInTriangle(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

/** A convex corner whose triangle holds no reflex vertex of the rest of the ring. */
function isEar(ear: Node): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (turn(a, b, c) >= 0) return false; // reflex or degenerate

  let p = c.next;
  while (p !== a) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && turn(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(turn(p1, q1, p2));
  const o2 = sign(turn(p1, q1, q2));
  const o3 = sign(turn(p2, q2, p1));
  const o4 = sign(turn(p2, q2, q1));
  return o1 !== o2 && o3 !== o4;
}

/** Does the ray a->b leave `a` into the polygon interior? */
function locallyInside(a: Node, b: Node): boolean {
  return turn(a.prev, a, a.next) < 0
    ? turn(a, b, a.next) >= 0 && turn(a, a.prev, b) >= 0
    : turn(a, b, a.prev) < 0 || turn(a, a.next, b) < 0;
}

function middleInside(a: Node, b: Node): boolean {
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  let p = a;
  let inside = false;
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y) {
      if (px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) inside = !inside;
    }
    p = p.next;
  } while (p !== a);
  return inside;
}

function crossesPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) {
      return true;
    }
    p = p.next;
  } while (p !== a);
  return false;
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !crossesPolygon(a, b) &&
    locallyInside(a, b) &&
    locallyInside(b, a) &&
    middleInside(a, b)
  );
}

/** Rewire one polygon into two that share the diagonal a-b. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = makeNode(a.i, a.x, a.y);
  const b2 = makeNode(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

/** Snip zero-area slivers and self-touching pinches so clipping can resume. */
function cureLocalIntersections(start: Node, out: number[]): Node | null {
  let p = start;
  let s = start;
  do {
    const a = p.prev;
    const b = p.next.next;
    if (!same(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      out.push(a.i >> 1, p.i >> 1, b.i >> 1);
      removeNode(p);
      removeNode(p.next);
      p = s = b;
    }
    p = p.next;
  } while (p !== s);
  return filterPoints(p, p);
}

function splitEarcut(start: Node, out: number[], depth: number): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        const c = splitPolygon(a, b);
        earcutLinked(filterPoints(a, a), out, depth + 1);
        earcutLinked(filterPoints(c, c), out, depth + 1);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function earcutLinked(ear: Node | null, out: number[], depth = 0): void {
  if (!ear || depth > 10) return;

  let node: Node = ear;
  let stop: Node = ear;
  let pass = 0;
  let guard = 1 << 20;

  while (node.prev !== node.next) {
    if (guard-- < 0) return;
    const prev = node.prev;
    const next = node.next;

    if (isEar(node)) {
      out.push(prev.i >> 1, node.i >> 1, next.i >> 1);
      removeNode(node);
      node = next.next;
      stop = next.next;
      pass = 0;
      continue;
    }

    node = next;
    if (node !== stop) continue;

    pass++;
    if (pass === 1) {
      const cured = cureLocalIntersections(node, out);
      if (!cured) return;
      node = cured;
      stop = cured;
    } else if (pass === 2) {
      splitEarcut(node, out, depth);
      return;
    } else {
      return;
    }
  }
}

/** Nearest outer-ring vertex visible from the hole's leftmost point. */
function findHoleBridge(hole: Node, outer: Node): Node | null {
  const hx = hole.x;
  const hy = hole.y;
  let qx = -Infinity;
  let m: Node | null = null;

  // Cast a ray toward -x and keep the closest outer edge it crosses.
  let p = outer;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m; // the hole touches the outer ring exactly
      }
    }
    p = p.next;
  } while (p !== outer);

  if (!m) return null;

  // Reflex vertices inside the sector can block the bridge; pick the one with
  // the shallowest angle to the ray instead.
  let best: Node = m;
  const stop = m;
  const mx = m.x;
  const my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (
      hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
    ) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (
        locallyInside(p, hole) &&
        (tan < tanMin ||
          (tan === tanMin && (p.x > best.x || (p.x === best.x && sectorContainsSector(best, p)))))
      ) {
        best = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);

  return best;
}

const sectorContainsSector = (m: Node, p: Node): boolean =>
  turn(m.prev, m, p.prev) < 0 && turn(p.next, m, m.next) < 0;

function leftmost(ring: Node): Node {
  let m = ring;
  let p = ring.next;
  while (p !== ring) {
    if (p.x < m.x || (p.x === m.x && p.y < m.y)) m = p;
    p = p.next;
  }
  return m;
}

/**
 * Triangulate `data` (flat x,y pairs). `holeIndices` are vertex offsets where
 * each hole ring begins. Returns triangle indices into the vertex list.
 */
export function earcut(data: number[], holeIndices?: number[] | null): number[] {
  const out: number[] = [];
  const holes = holeIndices && holeIndices.length ? holeIndices : null;
  const outerEnd = holes ? holes[0] * 2 : data.length;
  if (outerEnd < 6 || outerEnd > data.length) return out;

  let outer = buildRing(data, 0, outerEnd, true);
  if (!outer) return out;

  if (holes) {
    const queue: Node[] = [];
    for (let i = 0; i < holes.length; i++) {
      const start = holes[i] * 2;
      const end = i < holes.length - 1 ? holes[i + 1] * 2 : data.length;
      if (end - start < 6) continue;
      const ring = buildRing(data, start, end, false);
      if (ring) queue.push(leftmost(ring));
    }
    // Left to right, so bridges never cross one another.
    queue.sort((a, b) => a.x - b.x);
    for (const h of queue) {
      const bridge = findHoleBridge(h, outer);
      if (!bridge) continue;
      const rev = splitPolygon(bridge, h);
      filterPoints(rev, rev.next);
      outer = filterPoints(bridge, bridge.next) ?? outer;
    }
  }

  earcutLinked(outer, out);
  return out;
}
