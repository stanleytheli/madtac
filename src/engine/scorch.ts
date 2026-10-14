import { worldAabb } from "./collision.ts";
import { rectCorners } from "./poly.ts";
import type { Vec2 } from "./vec.ts";
import type { Floor } from "../world/world.ts";

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
 * of that level it overlaps (see Scorch.floors). Nothing to land on — a blast in
 * mid-air off the edge of a deck — leaves no mark. `size <= 0` or `opacity <= 0`
 * = no mark.
 */
export function stampScorch(
  out: Scorch[],
  floors: readonly Floor[],
  pos: Vec2,
  z: number,
  size: number,
  opacity = 1,
): void {
  if (size <= 0 || opacity <= 0) return;
  const r = size / 2;
  let under: Floor[] | null = [];
  for (const f of floors) {
    if (f.level !== z || f.invisible) continue; // an undrawn surface takes no mark
    if (f.infinite) {
      under = null;
      break;
    }
    const a = worldAabb(f);
    if (a.maxx < pos.x - r || a.minx > pos.x + r || a.maxy < pos.y - r || a.miny > pos.y + r) continue;
    under.push(f);
  }
  if (under && under.length === 0) return;
  if (out.length >= MAX_SCORCHES) out.splice(0, out.length - MAX_SCORCHES + 1);
  out.push({ pos, z, size, opacity: Math.min(1, opacity), angle: Math.random() * Math.PI * 2, floors: under, life: SCORCH_LIFE });
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
 * Draw the scorches on level `z` with `img`, the decoded scorch sprite, each
 * clipped to the union of its floors. The rects all wind the same way, so the
 * nonzero clip is their union: where two slabs overlap the mark is painted once,
 * not darkened twice.
 */
export function drawScorches(
  ctx: CanvasRenderingContext2D,
  scorches: readonly Scorch[],
  img: CanvasImageSource,
  z: number,
  inView: (p: Vec2, r: number) => boolean,
): void {
  for (const s of scorches) {
    if (s.z !== z || !inView(s.pos, s.size / 2)) continue;
    ctx.save();
    ctx.globalAlpha = s.opacity * (s.life >= SCORCH_FADE ? 1 : s.life / SCORCH_FADE);
    if (s.floors) {
      const clip = new Path2D();
      for (const f of s.floors) {
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
