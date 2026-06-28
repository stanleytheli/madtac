import { vec, type Vec2 } from "./vec.ts";
import type { Crate } from "./world.ts";

interface AABB {
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

export const crateAabb = (c: Crate): AABB => ({
  minx: c.pos.x - c.w / 2,
  maxx: c.pos.x + c.w / 2,
  miny: c.pos.y - c.h / 2,
  maxy: c.pos.y + c.h / 2,
});

/** Push a circle out of a crate (axis-aligned box) if overlapping. Returns the corrected center. */
export function resolveCircleVsCrate(pos: Vec2, r: number, c: Crate): Vec2 {
  const b = crateAabb(c);
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

export function pointInCrate(p: Vec2, c: Crate): boolean {
  const b = crateAabb(c);
  return p.x >= b.minx && p.x <= b.maxx && p.y >= b.miny && p.y <= b.maxy;
}
