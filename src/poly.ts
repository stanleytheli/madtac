/**
 * Convex-polygon geometry for the render masks (main.ts). Everything here
 * traffics in convex polys with positive shoelace winding — which is what
 * rectCorners produces and what half-plane clipping preserves — so callers
 * never think about orientation. Kept DOM-free (no Path2D) so it's testable
 * headless; main.ts owns turning polys into canvas paths.
 */
import { add, rotate, vec, type Vec2 } from "./vec.ts";

/** A convex polygon, positive shoelace winding. */
export type Poly = Vec2[];

/** The four corners of a centered (possibly rotated) rect, inflated by `pad`
 *  on every side. Positive winding by construction. */
export function rectCorners(pos: Vec2, w: number, h: number, angle = 0, pad = 0): Poly {
  const hw = w / 2 + pad;
  const hh = h / 2 + pad;
  const local = [vec(-hw, -hh), vec(hw, -hh), vec(hw, hh), vec(-hw, hh)];
  return local.map((c) => add(pos, angle ? rotate(c, angle) : c));
}

/** Twice the signed area (shoelace). Positive for this module's winding. */
export function area2(p: Poly): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/** Split a convex poly by the directed line a->b (one Sutherland–Hodgman
 *  plane, both halves kept). "Inside" is the positive-cross side — where a
 *  positively-wound polygon's interior lies relative to its own edges. */
function splitConvex(poly: Poly, a: Vec2, b: Vec2): { inside: Poly; outside: Poly } {
  const inside: Poly = [];
  const outside: Poly = [];
  const side = (p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) inside.push(p);
    if (sp <= 0) outside.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      const x = vec(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
      inside.push(x);
      outside.push(x);
    }
  }
  return { inside, outside };
}

/** Do two convex polys (positive winding) overlap with nonzero area?
 *  Separating-axis test over both polys' edges; edge-to-edge touching counts
 *  as NOT overlapping (mirrors the old subtractRect's >= early-out). */
export function convexOverlap(a: Poly, b: Poly): boolean {
  const separated = (edges: Poly, pts: Poly): boolean => {
    for (let i = 0; i < edges.length; i++) {
      const p = edges[i];
      const q = edges[(i + 1) % edges.length];
      // All of `pts` on/outside this edge's interior half-plane -> separated.
      if (pts.every((v) => (q.x - p.x) * (v.y - p.y) - (q.y - p.y) * (v.x - p.x) <= 0)) return true;
    }
    return false;
  };
  return !separated(a, b) && !separated(b, a);
}

/** Pieces of convex `a` not covered by convex `b`: clip `a` against each of
 *  b's edge half-planes, collecting the outside fragments (all convex, at most
 *  one per edge). No overlap -> [a]; fully covered -> []. The overlap
 *  early-out is load-bearing, not an optimization: without it a poly gets
 *  split along the infinite edge LINES of shapes it never touches, and
 *  disjointPolys' piece count explodes combinatorially. */
export function subtractConvex(a: Poly, b: Poly): Poly[] {
  if (area2(b) < 0) b = [...b].reverse(); // tolerate a mis-wound subtrahend
  if (!convexOverlap(a, b)) return [a];
  const out: Poly[] = [];
  let rest = a;
  for (let i = 0; i < b.length && rest.length >= 3; i++) {
    const { inside, outside } = splitConvex(rest, b[i], b[(i + 1) % b.length]);
    // Zero-area slivers (grazing/collinear cuts) fill nothing — drop them so
    // they can't accumulate across a chain of subtractions.
    if (outside.length >= 3 && area2(outside) > 1e-6) out.push(outside);
    rest = inside;
  }
  return out;
}

/**
 * Rewrite `polys` as a disjoint set of convex pieces covering the same union.
 * The render's subtractive mask uses an even-odd fill, where overlapping
 * shapes would cancel each other out — this makes any overlap (tiled floors,
 * the MASK_EPS inflation, rotated surfaces crossing) safe. The convex
 * generalization of the old axis-aligned disjointRects.
 */
export function disjointPolys(polys: readonly Poly[]): Poly[] {
  const out: Poly[] = [];
  for (const p of polys) {
    let pieces: Poly[] = [p];
    for (const d of out) {
      pieces = pieces.flatMap((x) => subtractConvex(x, d));
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
  }
  return out;
}

/** Is the point strictly inside (or on the boundary of) a positively-wound
 *  convex poly? Used by tests; the render itself fills paths instead. */
export function pointInConvex(p: Vec2, poly: Poly): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) return false;
  }
  return true;
}
