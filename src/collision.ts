import { add, rotate, sub, vec, type Vec2 } from "./vec.ts";
import type { Obstacle } from "./world.ts";

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

interface AABB {
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

/** Push a circle out of a box if overlapping. Returns the corrected center. */
export function resolveCircleVsBox(pos: Vec2, r: number, o: Obstacle): Vec2 {
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
    // endpoints rotate with it — a straight line stays straight).
    if (segmentIntersectsAabb(toLocal(a, o), toLocal(b, o), boxAabb(o))) return false;
  }
  return true;
}
