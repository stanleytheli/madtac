import { worldAabb } from "./collision.ts";
import { rectCorners } from "./poly.ts";
import type { Vec2 } from "./vec.ts";
import type { Floor, Stairs } from "../world/world.ts";

/**
 * An explosion's scorch mark: a static burn painted ON the floor where a blast
 * went off — over the floors, under everything standing on them (walls, crates,
 * bodies). Pure eye-candy, like a bullet hole: no gameplay state, and client-owned
 * (the sim emits a "scorch" event; see engine/effects.ts).
 *
 * The mark only exists where there is floor to burn: it is clipped to the union
 * of the surfaces at its level that it overlaps, so a blast at a balcony lip
 * scorches the deck and stops at the edge instead of hanging in the air, and one
 * on the seam between two slabs paints across both. A level with a visible
 * infinite floor (the ground) backs the mark everywhere, so it isn't clipped.
 *
 * A flight of stairs is a surface of BOTH levels it joins (the render masks treat
 * it the same way), so a blast at either end can burn it. The flight is drawn in
 * its lower level's pass whichever end the blast was at, so that is where the mark's
 * stair part draws too: on the steps, under whatever stands on them, and darkened
 * by the sight mask exactly as the steps beneath it are.
 */
export interface Scorch {
  pos: Vec2; // blast centre
  z: number; // the blast's level (renders with that level)
  size: number; // drawn width = height of the sprite, world px
  opacity: number; // 0..1, before the fade-out
  angle: number; // random spin, for variety between marks
  /** The surfaces it may paint on (the draw clips to their union), fixed at the
   *  moment it was stamped. Null = an infinite floor backs it: no clip. */
  floors: readonly Floor[] | null;
  /** The flights it may paint on, each drawn in its lower level's pass. Empty
   *  when `floors` is null: the unclipped mark already covers them. */
  stairs: readonly Stairs[];
  life: number; // ticks remaining
}

/** The scorch art in /assets (a dark star-burst on transparent). */
export const SCORCH_IMAGE = "map-barrel-res.svg";
/** How long a mark stays: 20 s at 60 ticks/s — longer than a bullet hole, since
 *  blasts are rare — then it's gone so the ground doesn't blacken over a match. */
export const SCORCH_LIFE = 1200;
/** The last stretch of that life fades out instead of blinking away. */
const SCORCH_FADE = 120;
/** Most marks kept at once; past this the oldest go first, whatever their age. */
const MAX_SCORCHES = 64;

/**
 * Stamp a `size`-wide scorch at `pos` on level `z`, onto whichever drawn floors
 * of that level, and flights touching it, it overlaps (see Scorch.floors and
 * Scorch.stairs). Nothing to land on — a blast in mid-air off the edge of a deck
 * — leaves no mark. `size <= 0` or `opacity <= 0` = no mark.
 */
export function stampScorch(
  out: Scorch[],
  floors: readonly Floor[],
  stairs: readonly Stairs[],
  pos: Vec2,
  z: number,
  size: number,
  opacity = 1,
): void {
  if (size <= 0 || opacity <= 0) return;
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
    if (under.length === 0 && flights.length === 0) return;
  }
  if (out.length >= MAX_SCORCHES) out.splice(0, out.length - MAX_SCORCHES + 1);
  out.push({ pos, z, size, opacity: Math.min(1, opacity), angle: Math.random() * Math.PI * 2, floors: under, stairs: flights, life: SCORCH_LIFE });
}

/** Age all scorches one tick; drop the expired ones. */
export function updateScorches(scorches: Scorch[]): Scorch[] {
  const alive: Scorch[] = [];
  for (const s of scorches) {
    s.life -= 1;
    if (s.life > 0) alive.push(s);
  }
  return alive;
}

/**
 * Draw level `z`'s pass of the scorches with `img`, the decoded scorch sprite:
 * the marks stamped at `z`, clipped to the union of their floors, plus the stair
 * part of any mark on a flight whose lower level is `z` (see Scorch). The rects
 * all wind the same way, so the nonzero clip is their union: where two slabs
 * overlap the mark is painted once, not darkened twice.
 */
export function drawScorches(
  ctx: CanvasRenderingContext2D,
  scorches: readonly Scorch[],
  img: CanvasImageSource,
  z: number,
  inView: (p: Vec2, r: number) => boolean,
): void {
  for (const s of scorches) {
    if (!inView(s.pos, s.size / 2)) continue;
    // A mark stamped on nothing but stairs has no floor part to paint here.
    const own = s.z === z && (s.floors === null || s.floors.length > 0);
    // Only the flights this pass actually draws (see drawLevel in main.ts).
    const flights = s.stairs.filter((f) => Math.min(f.zAtMin, f.zAtMax) === z && f.alpha > 0.01);
    if (!own && flights.length === 0) continue;
    ctx.save();
    ctx.globalAlpha = s.opacity * (s.life >= SCORCH_FADE ? 1 : s.life / SCORCH_FADE);
    if (!own || s.floors) {
      const clip = new Path2D();
      for (const f of [...(own ? s.floors! : []), ...flights]) {
        const c = rectCorners(f.pos, f.w, f.h, f.angle);
        clip.moveTo(c[0].x, c[0].y);
        for (let i = 1; i < c.length; i++) clip.lineTo(c[i].x, c[i].y);
        clip.closePath();
      }
      ctx.clip(clip);
    }
    ctx.translate(s.pos.x, s.pos.y);
    ctx.rotate(s.angle);
    ctx.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
    ctx.restore();
  }
}
