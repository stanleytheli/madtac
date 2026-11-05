import { worldAabb } from "./collision.ts";
import { rectCorners } from "./poly.ts";
import type { Vec2 } from "./vec.ts";
import type { Floor, Stairs } from "../world/world.ts";

/**
 * Where a mark painted ON the floor — a blast's scorch, a hit's blood — may land.
 * The mark only exists where there is floor to paint: it is clipped to the union
 * of the surfaces at its level that it overlaps, so a mark at a balcony lip stops
 * at the edge instead of hanging in the air, and one on the seam between two
 * slabs paints across both. A level with a visible infinite floor (the ground)
 * backs the mark everywhere, so it isn't clipped.
 *
 * A flight of stairs is a surface of BOTH levels it joins (the render masks treat
 * it the same way), so a mark at either end can land on it. The flight is drawn in
 * its lower level's pass whichever end the mark was made at, so that is where the
 * mark's stair part draws too: on the steps, under whatever stands on them, and
 * darkened by the sight mask exactly as the steps beneath it are.
 */
export interface MarkSurfaces {
  /** The surfaces it may paint on (the draw clips to their union), fixed at the
   *  moment it was stamped. Null = an infinite floor backs it: no clip. */
  floors: readonly Floor[] | null;
  /** The flights it may paint on, each drawn in its lower level's pass. Empty
   *  when `floors` is null: the unclipped mark already covers them. */
  stairs: readonly Stairs[];
}

/**
 * What a `size`-wide mark at `pos` on level `z` lands on: the drawn floors of
 * that level, and the flights touching it, that it overlaps. Null = nothing to
 * land on (mid-air off the edge of a deck), so no mark.
 */
export function markSurfaces(
  floors: readonly Floor[],
  stairs: readonly Stairs[],
  pos: Vec2,
  z: number,
  size: number,
): MarkSurfaces | null {
  const r = size / 2;
  const overlaps = (b: Floor | Stairs): boolean => {
    const a = worldAabb(b);
    return !(a.maxx < pos.x - r || a.minx > pos.x + r || a.maxy < pos.y - r || a.miny > pos.y + r);
  };
  let under: Floor[] | null = [];
  for (const f of floors) {
    if (f.level !== z || f.invisible) continue; // an undrawn surface takes no mark
    if (f.infinite) {
      under = null;
      break;
    }
    if (overlaps(f)) under.push(f);
  }
  const flights: Stairs[] = [];
  if (under) {
    for (const s of stairs) if ((s.zAtMin === z || s.zAtMax === z) && overlaps(s)) flights.push(s);
    if (under.length === 0 && flights.length === 0) return null;
  }
  return { floors: under, stairs: flights };
}

/**
 * Start level `z`'s pass of a mark stamped at `m.z`: save the context and clip it
 * to what this pass may paint — the mark's floors if it was stamped at `z`, plus
 * any of its flights whose lower level is `z` (see MarkSurfaces). Returns false,
 * with nothing saved, when this pass has none of it to paint; otherwise the
 * caller draws and restores. The rects all wind the same way, so the nonzero clip
 * is their union: where two slabs overlap the mark is painted once, not twice.
 */
export function beginMarkPass(
  ctx: CanvasRenderingContext2D,
  m: MarkSurfaces & { z: number },
  z: number,
): boolean {
  // A mark stamped on nothing but stairs has no floor part to paint here.
  const own = m.z === z && (m.floors === null || m.floors.length > 0);
  // Only the flights this pass actually draws (see drawLevel in main.ts).
  const flights = m.stairs.filter((f) => Math.min(f.zAtMin, f.zAtMax) === z && f.alpha > 0.01);
  if (!own && flights.length === 0) return false;
  ctx.save();
  if (!own || m.floors) {
    const clip = new Path2D();
    for (const f of [...(own ? m.floors! : []), ...flights]) {
      const c = rectCorners(f.pos, f.w, f.h, f.angle);
      clip.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < c.length; i++) clip.lineTo(c[i].x, c[i].y);
      clip.closePath();
    }
    ctx.clip(clip);
  }
  return true;
}
