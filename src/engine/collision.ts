import { add, rotate, sub, vec, type Vec2 } from "./vec.ts";
import type { Obstacle } from "../world/world.ts";

/** The centered-rect shape every box test takes: obstacles, floors, stairs,
 *  regions. `angle` (radians, absent/0 = axis-aligned) rotates it about `pos` —
 *  each test transforms the query into the box's local frame and runs the
 *  original axis-aligned math there, so rotation costs nothing when unset. */
export interface Box {
  pos: Vec2;
  w: number;
  h: number;
  angle?: number;
}

export interface AABB {
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

/** The box's own-frame AABB — only meaningful against points fed through
 *  toLocal (for a rotated box it is NOT its world-space bounding box). */
export const boxAabb = (o: Box): AABB => ({
  minx: o.pos.x - o.w / 2,
  maxx: o.pos.x + o.w / 2,
  miny: o.pos.y - o.h / 2,
  maxy: o.pos.y + o.h / 2,
});

/** World point -> the box's local frame (where it's axis-aligned, still
 *  centered on o.pos). Identity for unrotated boxes. */
const toLocal = (p: Vec2, o: Box): Vec2 =>
  o.angle ? add(o.pos, rotate(sub(p, o.pos), -o.angle)) : p;

/** Local-frame point -> world (the inverse of toLocal). */
const fromLocal = (p: Vec2, o: Box): Vec2 =>
  o.angle ? add(o.pos, rotate(sub(p, o.pos), o.angle)) : p;

/** Push a circle out of a box if overlapping. Returns the corrected center.
 *  Takes any `Box` (obstacles, but also a vehicle part's world-frame rect). */
export function resolveCircleVsBox(pos: Vec2, r: number, o: Box): Vec2 {
  // Resolve in the box's local frame (a circle is rotation-invariant), then
  // map the corrected center back to world space.
  const lp = toLocal(pos, o);
  const b = boxAabb(o);
  const cx = Math.max(b.minx, Math.min(lp.x, b.maxx));
  const cy = Math.max(b.miny, Math.min(lp.y, b.maxy));
  const dx = lp.x - cx;
  const dy = lp.y - cy;
  const d2 = dx * dx + dy * dy;

  if (d2 >= r * r) return pos; // no overlap

  if (d2 > 1e-6) {
    // Closest point is on an edge/corner: push straight out along the normal.
    const d = Math.sqrt(d2);
    const push = r - d;
    return fromLocal(vec(lp.x + (dx / d) * push, lp.y + (dy / d) * push), o);
  }

  // Center is inside the box: eject along the shallowest axis.
  const left = lp.x - b.minx;
  const right = b.maxx - lp.x;
  const top = lp.y - b.miny;
  const bottom = b.maxy - lp.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return fromLocal(vec(b.minx - r, lp.y), o);
  if (m === right) return fromLocal(vec(b.maxx + r, lp.y), o);
  if (m === top) return fromLocal(vec(lp.x, b.miny - r), o);
  return fromLocal(vec(lp.x, b.maxy + r), o);
}

/** Outward unit normal from the nearest surface of box `o` toward `pos`, plus
 *  the distance from `pos` to that surface. This is the *true* surface normal at
 *  `pos` (pointing away from the closest feature — a face or a corner vertex), so
 *  sliding perpendicular to it follows the box's rounded outline and rounds
 *  convex corners cleanly. When `pos` is inside the box, dist is 0 and the normal
 *  is the shallowest-axis escape. Computed in the box's local frame, mapped back. */
export function boxSurfaceNormal(pos: Vec2, o: Box): { n: Vec2; dist: number } {
  const lp = toLocal(pos, o);
  const b = boxAabb(o);
  const cx = Math.max(b.minx, Math.min(lp.x, b.maxx));
  const cy = Math.max(b.miny, Math.min(lp.y, b.maxy));
  const dx = lp.x - cx;
  const dy = lp.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const ln = vec(dx / d, dy / d); // local-frame outward normal (toward the corner/edge)
    return { n: o.angle ? rotate(ln, o.angle) : ln, dist: d };
  }
  // Center is inside the box: escape along the shallowest axis.
  const left = lp.x - b.minx;
  const right = b.maxx - lp.x;
  const top = lp.y - b.miny;
  const bottom = b.maxy - lp.y;
  const m = Math.min(left, right, top, bottom);
  const ln = m === left ? vec(-1, 0) : m === right ? vec(1, 0) : m === top ? vec(0, -1) : vec(0, 1);
  return { n: o.angle ? rotate(ln, o.angle) : ln, dist: 0 };
}

/** Push a circle out of another circle if overlapping. Returns the corrected center. */
export function resolveCircleVsCircle(pos: Vec2, r: number, other: Vec2, otherR: number): Vec2 {
  const dx = pos.x - other.x;
  const dy = pos.y - other.y;
  const d2 = dx * dx + dy * dy;
  const rr = r + otherR;
  if (d2 >= rr * rr || d2 < 1e-6) return pos;
  const d = Math.sqrt(d2);
  const push = rr - d;
  return vec(pos.x + (dx / d) * push, pos.y + (dy / d) * push);
}

/** Does a circle at `pos` with radius `r` overlap the box? Strict: touching at
 *  exactly `r` doesn't count, matching resolveCircleVsBox (which pushes only on
 *  real overlap) — a body can slide along a wall at exactly its radius. Unlike
 *  a point-in-inflated-box test, corners stay round: a diagonal that clears a
 *  corner by `r` is free. */
export function circleIntersectsBox(pos: Vec2, r: number, o: Box): boolean {
  const lp = toLocal(pos, o);
  const b = boxAabb(o);
  const dx = lp.x - Math.max(b.minx, Math.min(lp.x, b.maxx));
  const dy = lp.y - Math.max(b.miny, Math.min(lp.y, b.maxy));
  return dx * dx + dy * dy < r * r;
}

/** Does the segment a->b pass within `r` of the point `c`? Closest-point-on-
 *  segment distance test; strict like circleIntersectsBox, so a ray grazing a
 *  body at exactly its radius doesn't count as hitting it. */
export function segmentIntersectsCircle(a: Vec2, b: Vec2, c: Vec2, r: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby) / l2)) : 0;
  const dx = c.x - (a.x + abx * t);
  const dy = c.y - (a.y + aby * t);
  return dx * dx + dy * dy < r * r;
}

// --- obstacle-shape dispatch -------------------------------------------------
// An obstacle is a box UNLESS it is `round` (a barrel), in which case its
// footprint is a circle centered on `pos` with radius = half its smaller extent
// (the factories keep w === h, so this is just w/2). These wrappers pick the box
// or circle test per obstacle; every obstacle geometry query in the game routes
// through them, so nothing else has to know a barrel from a wall.

/** A round obstacle's collision radius. */
export const obstacleRadius = (o: Obstacle): number => Math.min(o.w, o.h) / 2;

/**
 * How to draw a border so it paints INSIDE this collider rather than straddling
 * it: the width to stroke with, and how far in from the edge to put the path.
 *
 * Canvas centers a stroke on its path, so a border drawn on an obstacle's own
 * edge spends half its width outside the box — which reads as the thing being
 * `strokeWidth / 2` bigger than it is, and is exactly the margin a player
 * misjudges when they clip a corner they thought they had cleared.
 *
 * Two clamps, and both are load-bearing. The width can't exceed the shape, or a
 * border thicker than the thing it outlines paints most of itself outside no
 * matter where the path goes; and the inset can't exceed half the extent, or the
 * path turns inside out. Between them, a border on something thinner than itself
 * simply fills it. The half is rounded UP so a fractional one never leaves a
 * sliver of paint outside — the cost is that a border can sit up to half a px
 * inside the true edge, which is the right way to be wrong.
 *
 * Lives here, with the collider geometry it has to agree with, because both the
 * game renderer and the editor draw obstacle edges and must say the same thing.
 */
export function borderFit(strokeWidth: number, extent: number): { width: number; inset: number } {
  const width = Math.min(strokeWidth, extent);
  return { width, inset: Math.min(Math.ceil(width / 2), extent / 2) };
}

/** Push a body-circle out of an obstacle (box or barrel). */
export function resolveCircleVsObstacle(pos: Vec2, r: number, o: Obstacle): Vec2 {
  return o.round ? resolveCircleVsCircle(pos, r, o.pos, obstacleRadius(o)) : resolveCircleVsBox(pos, r, o);
}

/** Does a body-circle overlap an obstacle (box or barrel)? Strict, like the box
 *  and circle primitives it delegates to. */
export function circleIntersectsObstacle(pos: Vec2, r: number, o: Obstacle): boolean {
  if (!o.round) return circleIntersectsBox(pos, r, o);
  const rr = r + obstacleRadius(o);
  const dx = pos.x - o.pos.x;
  const dy = pos.y - o.pos.y;
  return dx * dx + dy * dy < rr * rr;
}

/** Is a point inside an obstacle (box or barrel)? */
export function pointInObstacle(p: Vec2, o: Obstacle): boolean {
  if (!o.round) return pointInBox(p, o);
  const r = obstacleRadius(o);
  const dx = p.x - o.pos.x;
  const dy = p.y - o.pos.y;
  return dx * dx + dy * dy <= r * r;
}

/** Does the segment a->b cross an obstacle (box or barrel)? */
export function segmentIntersectsObstacle(a: Vec2, b: Vec2, o: Obstacle): boolean {
  return o.round ? segmentIntersectsCircle(a, b, o.pos, obstacleRadius(o)) : segmentIntersectsBox(a, b, o);
}

/**
 * The stretch of the segment a->b that lies INSIDE `o`, as a [t0, t1] slice of
 * the segment (0 = a, 1 = b), or null if it misses. Closed-form — a slab clip in
 * the box's local frame, or the chord of a circle — because the alternative is
 * stepping along the ray, and the callers that need this (every AI sight query,
 * every wallbang) ask far too often to pay for stepping. See penetrationCost.
 */
export function segmentSpanInObstacle(a: Vec2, b: Vec2, o: Obstacle): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (o.round) {
    // |a + t*d - c|^2 = r^2, clipped to the segment.
    const r = obstacleRadius(o);
    const fx = a.x - o.pos.x;
    const fy = a.y - o.pos.y;
    const qa = dx * dx + dy * dy;
    if (qa < 1e-12) return null;
    const qb = 2 * (fx * dx + fy * dy);
    const qc = fx * fx + fy * fy - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (disc <= 0) return null; // miss, or a tangent that crosses no material
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-qb - sq) / (2 * qa));
    const t1 = Math.min(1, (-qb + sq) / (2 * qa));
    return t1 > t0 ? [t0, t1] : null;
  }
  // Box: clip in the frame where it is axis-aligned. The DIRECTION rotates with
  // the endpoints, so the slab math is the same as for an unrotated box.
  const la = toLocal(a, o);
  const lb = toLocal(b, o);
  const box = boxAabb(o);
  let t0 = 0;
  let t1 = 1;
  const ld = [lb.x - la.x, lb.y - la.y];
  const lo = [la.x, la.y];
  const min = [box.minx, box.miny];
  const max = [box.maxx, box.maxy];
  for (let i = 0; i < 2; i++) {
    if (Math.abs(ld[i]) < 1e-9) {
      if (lo[i] < min[i] || lo[i] > max[i]) return null; // parallel and outside
      continue;
    }
    let lo1 = (min[i] - lo[i]) / ld[i];
    let hi = (max[i] - lo[i]) / ld[i];
    if (lo1 > hi) [lo1, hi] = [hi, lo1];
    t0 = Math.max(t0, lo1);
    t1 = Math.min(t1, hi);
    if (t0 >= t1) return null;
  }
  return t1 > t0 ? [t0, t1] : null;
}

/** Point-in-centered-rect test. Works for any Box shape (obstacles, floors). */
export function pointInBox(p: Vec2, o: Box): boolean {
  const lp = toLocal(p, o);
  const b = boxAabb(o);
  return lp.x >= b.minx && lp.x <= b.maxx && lp.y >= b.miny && lp.y <= b.maxy;
}

/** Slab test: does the segment a->b intersect the axis-aligned box? */
function segmentIntersectsAabb(a: Vec2, b: Vec2, box: AABB): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (a.x < box.minx || a.x > box.maxx) return false;
  } else {
    let lo = (box.minx - a.x) / dx;
    let hi = (box.maxx - a.x) / dx;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }

  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (a.y < box.miny || a.y > box.maxy) return false;
  } else {
    let lo = (box.miny - a.y) / dy;
    let hi = (box.maxy - a.y) / dy;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }

  return true;
}

/** Does the segment a->b intersect the (possibly rotated) box `o`? Runs the slab
 *  test in the box's own frame, so a straight line stays straight. The public
 *  segment-vs-rect test (used for vehicle hulls blocking rounds / blasts). */
export function segmentIntersectsBox(a: Vec2, b: Vec2, o: Box): boolean {
  return segmentIntersectsAabb(toLocal(a, o), toLocal(b, o), boxAabb(o));
}

/** True if no obstacle blocks the straight line from `a` to `b` (clear line of
 *  sight). Pass `z` to only test obstacles on that level (sight is per-level). */
export function hasLineOfSight(
  a: Vec2,
  b: Vec2,
  obstacles: readonly Obstacle[],
  z?: number,
): boolean {
  for (const o of obstacles) {
    if (z !== undefined && o.z !== z) continue;
    if (o.permeable) continue; // fences don't block sight
    // Rotated walls: run the slab test in the wall's own frame (both segment
    // endpoints rotate with it — a straight line stays straight). Barrels test
    // as a circle instead.
    if (segmentIntersectsObstacle(a, b, o)) return false;
  }
  return true;
}

/** World-space bounding box of a (possibly rotated) centered rect. Unlike
 *  boxAabb this is the true axis-aligned extent in world space — for spatial
 *  binning and viewport culling. */
export function worldAabb(o: Box): AABB {
  const a = o.angle ?? 0;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const hx = (o.w / 2) * c + (o.h / 2) * s;
  const hy = (o.w / 2) * s + (o.h / 2) * c;
  return { minx: o.pos.x - hx, maxx: o.pos.x + hx, miny: o.pos.y - hy, maxy: o.pos.y + hy };
}

// Pack signed cell coords into one non-negative int key (world spans a few
// thousand px; /CELL keeps |coord| well under the 32k offset).
const CELL_BITS = 16;
const CELL_OFFSET = 1 << (CELL_BITS - 1);
const cellKey = (cx: number, cy: number): number =>
  (((cx + CELL_OFFSET) & 0xffff) << CELL_BITS) | ((cy + CELL_OFFSET) & 0xffff);

/**
 * A uniform spatial index over the sight-blocking obstacles, partitioned first
 * by z level then by 2D grid cell. `blocked()` walks only the cells a segment
 * actually crosses on its level (Amanatides–Woo DDA) and tests each obstacle at
 * most once (a per-query stamp dedupes obstacles that straddle cells), turning
 * the old "scan every obstacle" line-of-sight test into "scan a handful."
 *
 * Static: built once from the level geometry (obstacles don't move mid-match).
 * Holds ALL obstacles (fences included): the sight/bullet queries (`blocked`,
 * `hit`) skip permeable ones per-test, while the movement query (`solidCircle`)
 * counts them — fences block walking but not sight or bullets.
 */
/**
 * Turn the spans a lane spends inside material into what it costs to cross, or
 * null if that exceeds `budget`. Overlapping spans are charged ONCE, at the
 * highest multiplier covering each stretch — the sim prices each px of material
 * once as well, so double-charging a doubled-up wall would have the AI believing
 * in cover the bullets don't respect.
 */
function priceSpans(
  lo: readonly number[],
  hi: readonly number[],
  mul: readonly number[],
  naive: number,
  len: number,
  budget: number,
): number | null {
  if (!lo.length) return 0; // nothing in the way at all
  // One obstacle can't overlap itself, so the running sum is already exact.
  if (lo.length === 1) return naive <= budget + PEN_EPS ? naive : null;

  // Sweep the distinct boundaries: between two of them the covering set is
  // constant, so the dearest multiplier there prices that whole stretch. O(k^2)
  // on a k of about three.
  const cuts = [...lo, ...hi].sort((x, y) => x - y);
  let cost = 0;
  for (let i = 1; i < cuts.length; i++) {
    const t0 = cuts[i - 1];
    const t1 = cuts[i];
    if (t1 <= t0) continue;
    const midT = (t0 + t1) / 2;
    let m = 0;
    for (let k = 0; k < lo.length; k++) {
      if (lo[k] <= midT && midT <= hi[k] && mul[k] > m) m = mul[k];
    }
    if (m <= 0) continue;
    cost += (t1 - t0) * len * m;
    if (cost > budget + PEN_EPS) return null; // can't afford the rest, whatever it holds
  }
  return cost <= budget + PEN_EPS ? cost : null;
}

/** One contiguous stretch of material along a lane, priced. `entryT`/`exitT` are
 *  positions along the segment the run was measured on (0 = a, 1 = b). */
export interface MaterialRun {
  entryT: number;
  exitT: number;
  cost: number;
  /** What the lane was inside when it came out the far side — not necessarily
   *  what it went into, since material that touches is one run. */
  exitOf: Obstacle;
}

/**
 * The contiguous run of material containing `atT`, priced the same way
 * penetrationCost prices a whole lane (union of overlaps, dearest multiplier per
 * stretch). Null if `atT` isn't inside anything, or if crossing costs more than
 * `budget`.
 *
 * This is what a bullet needs and a sight check doesn't: where the material it is
 * standing in starts and ends. Sharing the pricing with penetrationCost is the
 * point — a bot's idea of what it can shoot through and what its bullets actually
 * do then agree by construction rather than by two implementations staying in
 * step.
 */
function runFromSpans(
  lo: readonly number[],
  hi: readonly number[],
  mul: readonly number[],
  obs: readonly Obstacle[],
  atT: number,
  len: number,
  budget: number,
): MaterialRun | null {
  if (!lo.length) return null;
  const cuts = [...lo, ...hi].sort((x, y) => x - y);
  // Stretch k spans cuts[k]..cuts[k+1]; covered = something is there.
  const covered: boolean[] = [];
  const dearest: number[] = [];
  const owner: number[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const midT = (cuts[i - 1] + cuts[i]) / 2;
    let m = -1;
    let who = -1;
    for (let k = 0; k < lo.length; k++) {
      if (lo[k] <= midT && midT <= hi[k] && mul[k] > m) {
        m = mul[k];
        who = k;
      }
    }
    covered.push(who >= 0);
    dearest.push(m);
    owner.push(who);
  }
  // The stretch `atT` falls in, then out to both ends of its contiguous run.
  let at = -1;
  for (let i = 1; i < cuts.length; i++) {
    if (atT >= cuts[i - 1] && atT <= cuts[i] && covered[i - 1]) {
      at = i - 1;
      break;
    }
  }
  if (at < 0) return null; // not inside anything
  let first = at;
  while (first > 0 && covered[first - 1]) first--;
  let last = at;
  while (last + 1 < covered.length && covered[last + 1]) last++;

  let cost = 0;
  for (let i = first; i <= last; i++) {
    if (dearest[i] <= 0) continue; // free material: crossed, but not paid for
    cost += (cuts[i + 1] - cuts[i]) * len * dearest[i];
    if (cost > budget + PEN_EPS) return null; // can't afford the rest of the run
  }
  return { entryT: cuts[first], exitT: cuts[last + 1], cost, exitOf: obs[owner[last]] };
}

/** materialRun without a spatial index (editor / bare test worlds). */
export function materialRunScan(
  obstacles: readonly Obstacle[],
  a: Vec2,
  b: Vec2,
  z: number,
  atT: number,
  budget: number,
): MaterialRun | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const lo: number[] = [];
  const hi: number[] = [];
  const mul: number[] = [];
  const obs: Obstacle[] = [];
  for (const o of obstacles) {
    if (o.z !== z || o.permeable) continue;
    const span = segmentSpanInObstacle(a, b, o);
    if (!span) continue;
    lo.push(span[0]);
    hi.push(span[1]);
    mul.push(Math.max(0, o.thicknessMul ?? 1));
    obs.push(o);
  }
  return runFromSpans(lo, hi, mul, obs, atT, len, budget);
}

/** penetrationCost without a spatial index: scans every obstacle. The editor and
 *  bare test worlds have no grid; the game always does. */
export function penetrationCostScan(
  obstacles: readonly Obstacle[],
  a: Vec2,
  b: Vec2,
  z: number,
  budget: number,
): number | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const lo: number[] = [];
  const hi: number[] = [];
  const mul: number[] = [];
  let naive = 0;
  for (const o of obstacles) {
    if (o.z !== z || o.permeable) continue;
    const span = segmentSpanInObstacle(a, b, o);
    if (!span) continue;
    const m = Math.max(0, o.thicknessMul ?? 1);
    lo.push(span[0]);
    hi.push(span[1]);
    mul.push(m);
    naive += (span[1] - span[0]) * len * m;
  }
  return priceSpans(lo, hi, mul, naive, len, budget);
}

/** Slack on the "can this round afford it" comparison. A wall's cost comes out
 *  of parametric arithmetic, so a 40px wall priced against a 40px budget lands on
 *  40.000000000000006 as often as on 40 — without this, whether a round clears a
 *  wall exactly its own rating would come down to float noise. */
const PEN_EPS = 1e-6;

export class ObstacleGrid {
  private readonly cell: number;
  private readonly all: Obstacle[] = [];
  /** z -> (cellKey -> indices into `all`). */
  private readonly layers = new Map<number, Map<number, number[]>>();
  private readonly stamp: Int32Array;
  private query = 0;

  constructor(obstacles: readonly Obstacle[], cell = 256) {
    this.cell = cell;
    for (const o of obstacles) {
      const idx = this.all.length;
      this.all.push(o);
      let layer = this.layers.get(o.z);
      if (!layer) {
        layer = new Map();
        this.layers.set(o.z, layer);
      }
      const box = worldAabb(o);
      const cx0 = Math.floor(box.minx / cell);
      const cx1 = Math.floor(box.maxx / cell);
      const cy0 = Math.floor(box.miny / cell);
      const cy1 = Math.floor(box.maxy / cell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          let bucket = layer.get(key);
          if (!bucket) {
            bucket = [];
            layer.set(key, bucket);
          }
          bucket.push(idx);
        }
      }
    }
    this.stamp = new Int32Array(this.all.length);
  }

  /** The sight-blocking obstacle on level `z` containing point `p`, or null.
   *  Only the one grid cell `p` falls in is searched (an obstacle covering `p`
   *  is binned in that cell), so bullet↔wall hit tests cost O(cell occupancy),
   *  not O(all obstacles). Fences are skipped (they don't stop bullets). */
  hit(p: Vec2, z: number): Obstacle | null {
    const layer = this.layers.get(z);
    if (!layer) return null;
    const bucket = layer.get(cellKey(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    if (!bucket) return null;
    for (const idx of bucket) {
      const o = this.all[idx];
      if (o.permeable) continue;
      if (pointInObstacle(p, o)) return o;
    }
    return null;
  }

  /** Does any SOLID obstacle on level `z` (fences included — they block walking)
   *  overlap the circle at `p` of radius `r`? Searches the up-to-4 cells the
   *  circle's box touches; the per-query stamp dedupes obstacles across them.
   *  This is the movement/nav path (see nav.walkable). */
  solidCircle(p: Vec2, r: number, z: number): boolean {
    const layer = this.layers.get(z);
    if (!layer) return false;
    const cell = this.cell;
    const cx0 = Math.floor((p.x - r) / cell);
    const cx1 = Math.floor((p.x + r) / cell);
    const cy0 = Math.floor((p.y - r) / cell);
    const cy1 = Math.floor((p.y + r) / cell);
    const q = ++this.query;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = layer.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (this.stamp[idx] === q) continue;
          this.stamp[idx] = q;
          if (circleIntersectsObstacle(p, r, this.all[idx])) return true;
        }
      }
    }
    return false;
  }

  /** Call `cb` once for each SOLID obstacle on level `z` (fences included) whose
   *  cell the circle at (`p`, `r`) touches, deduped across the up-to-4 cells.
   *  The push-out analog of solidCircle: lets a caller resolve a body out of just
   *  its nearby walls instead of scanning every obstacle. */
  eachNear(p: Vec2, r: number, z: number, cb: (o: Obstacle) => void): void {
    const layer = this.layers.get(z);
    if (!layer) return;
    const cell = this.cell;
    const cx0 = Math.floor((p.x - r) / cell);
    const cx1 = Math.floor((p.x + r) / cell);
    const cy0 = Math.floor((p.y - r) / cell);
    const cy1 = Math.floor((p.y + r) / cell);
    const q = ++this.query;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = layer.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (this.stamp[idx] === q) continue;
          this.stamp[idx] = q;
          cb(this.all[idx]);
        }
      }
    }
  }

  /**
   * Walk every obstacle whose cell the segment a->b crosses on level `z`, once
   * each (the per-query stamp dedupes obstacles straddling cells), calling
   * `visit`. Stops the moment `visit` returns true.
   *
   * Amanatides-Woo cell stepping. The whole point of the grid is that a sight
   * query touches a handful of obstacles rather than all of them, and both the
   * plain blocking test and the penetration-cost query want that same walk.
   */
  private alongSegment(a: Vec2, b: Vec2, z: number, visit: (o: Obstacle) => boolean): boolean {
    const layer = this.layers.get(z);
    if (!layer) return false;
    const q = ++this.query;
    const cell = this.cell;

    const test = (key: number): boolean => {
      const bucket = layer.get(key);
      if (!bucket) return false;
      for (const idx of bucket) {
        if (this.stamp[idx] === q) continue;
        this.stamp[idx] = q;
        const o = this.all[idx];
        if (o.permeable) continue; // fences stop neither sight nor bullets
        if (visit(o)) return true;
      }
      return false;
    };

    let cx = Math.floor(a.x / cell);
    let cy = Math.floor(a.y / cell);
    const ex = Math.floor(b.x / cell);
    const ey = Math.floor(b.y / cell);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const invx = dx !== 0 ? 1 / dx : Infinity;
    const invy = dy !== 0 ? 1 / dy : Infinity;
    let tMaxX = stepX !== 0 ? ((stepX > 0 ? cx + 1 : cx) * cell - a.x) * invx : Infinity;
    let tMaxY = stepY !== 0 ? ((stepY > 0 ? cy + 1 : cy) * cell - a.y) * invy : Infinity;
    const tDeltaX = stepX !== 0 ? Math.abs(cell * invx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(cell * invy) : Infinity;

    // Bounded by the Manhattan cell span plus slack, so float error can't loop.
    const maxSteps = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
    for (let i = 0; i <= maxSteps; i++) {
      if (test(cellKey(cx, cy))) return true;
      if (cx === ex && cy === ey) break;
      if (tMaxX < tMaxY) {
        if (tMaxX > 1) break;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        if (tMaxY > 1) break;
        cy += stepY;
        tMaxY += tDeltaY;
      }
    }
    return false;
  }

  /** Does any obstacle on level `z` block the segment a->b? */
  blocked(a: Vec2, b: Vec2, z: number): boolean {
    return this.alongSegment(a, b, z, (o) => segmentIntersectsObstacle(a, b, o));
  }

  /**
   * What it costs, in px of penetration budget, to send a round from a to b on
   * level `z` — or null if that is more than `budget`, i.e. the round doesn't get
   * there. A `budget` of 0 answers the plain question ("is this lane clear?"),
   * since any material at all then costs more than nothing.
   *
   * Each obstacle contributes the length of segment inside it times its
   * thicknessMul, in closed form (see segmentSpanInObstacle) rather than by
   * stepping — this runs on every AI sight query, and stepping a 1500px ray is
   * four orders of magnitude too slow for that.
   *
   * Overlapping obstacles are charged ONCE, at the highest multiplier covering
   * each stretch. The sim prices each px of material once as well, so
   * double-charging a doubled-up wall here would have the AI believing in cover
   * the bullets don't respect.
   */
  /** The contiguous run of material at `atT` along a->b, priced — see
   *  MaterialRun. The bullet-side counterpart to penetrationCost, on the same
   *  traversal and the same pricing. */
  materialRun(a: Vec2, b: Vec2, z: number, atT: number, budget: number): MaterialRun | null {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const lo: number[] = [];
    const hi: number[] = [];
    const mul: number[] = [];
    const obs: Obstacle[] = [];
    this.alongSegment(a, b, z, (o) => {
      const span = segmentSpanInObstacle(a, b, o);
      if (!span) return false;
      lo.push(span[0]);
      hi.push(span[1]);
      mul.push(Math.max(0, o.thicknessMul ?? 1));
      obs.push(o);
      return false;
    });
    return runFromSpans(lo, hi, mul, obs, atT, len, budget);
  }

  penetrationCost(a: Vec2, b: Vec2, z: number, budget: number): number | null {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // t0/t1/mul per obstacle crossed, in flat arrays: hot path, tiny counts.
    const lo: number[] = [];
    const hi: number[] = [];
    const mul: number[] = [];
    let naive = 0;
    this.alongSegment(a, b, z, (o) => {
      const span = segmentSpanInObstacle(a, b, o);
      if (!span) return false;
      const m = Math.max(0, o.thicknessMul ?? 1);
      lo.push(span[0]);
      hi.push(span[1]);
      mul.push(m);
      naive += (span[1] - span[0]) * len * m;
      return false; // no early-out: the whole lane has to be priced
    });
    return priceSpans(lo, hi, mul, naive, len, budget);
  }
}
