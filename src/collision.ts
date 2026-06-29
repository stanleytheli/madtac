import { vec, type Vec2 } from "./vec.ts";
import type { Obstacle } from "./world.ts";

interface AABB {
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

export const boxAabb = (o: Obstacle): AABB => ({
  minx: o.pos.x - o.w / 2,
  maxx: o.pos.x + o.w / 2,
  miny: o.pos.y - o.h / 2,
  maxy: o.pos.y + o.h / 2,
});

/** Push a circle out of a box (axis-aligned obstacle) if overlapping. Returns the corrected center. */
export function resolveCircleVsBox(pos: Vec2, r: number, o: Obstacle): Vec2 {
  const b = boxAabb(o);
  const cx = Math.max(b.minx, Math.min(pos.x, b.maxx));
  const cy = Math.max(b.miny, Math.min(pos.y, b.maxy));
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const d2 = dx * dx + dy * dy;

  if (d2 >= r * r) return pos; // no overlap

  if (d2 > 1e-6) {
    // Closest point is on an edge/corner: push straight out along the normal.
    const d = Math.sqrt(d2);
    const push = r - d;
    return vec(pos.x + (dx / d) * push, pos.y + (dy / d) * push);
  }

  // Center is inside the box: eject along the shallowest axis.
  const left = pos.x - b.minx;
  const right = b.maxx - pos.x;
  const top = pos.y - b.miny;
  const bottom = b.maxy - pos.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return vec(b.minx - r, pos.y);
  if (m === right) return vec(b.maxx + r, pos.y);
  if (m === top) return vec(pos.x, b.miny - r);
  return vec(pos.x, b.maxy + r);
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

export function pointInBox(p: Vec2, o: Obstacle): boolean {
  const b = boxAabb(o);
  return p.x >= b.minx && p.x <= b.maxx && p.y >= b.miny && p.y <= b.maxy;
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

/** True if no obstacle blocks the straight line from `a` to `b` (clear line of sight). */
export function hasLineOfSight(a: Vec2, b: Vec2, obstacles: readonly Obstacle[]): boolean {
  for (const o of obstacles) {
    if (segmentIntersectsAabb(a, b, boxAabb(o))) return false;
  }
  return true;
}
