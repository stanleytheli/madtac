import { beginMarkPass, markSurfaces, type MarkSurfaces } from "./floormark.ts";
import type { Vec2 } from "./vec.ts";
import type { Floor, Stairs } from "../world/world.ts";

/**
 * An explosion's scorch mark: a static burn painted ON the floor where a blast
 * went off — over the floors, under everything standing on them (walls, crates,
 * bodies). Pure eye-candy, like a bullet hole: no gameplay state, and client-owned
 * (the sim emits a "scorch" event; see engine/effects.ts). It lands only where
 * there is floor (or a flight of stairs) to burn — see MarkSurfaces.
 */
export interface Scorch extends MarkSurfaces {
  pos: Vec2; // blast centre
  z: number; // the blast's level (renders with that level)
  size: number; // drawn width = height of the sprite, world px
  opacity: number; // 0..1, before the fade-out
  angle: number; // random spin, for variety between marks
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
 * Stamp a `size`-wide scorch at `pos` on level `z`, onto whatever it overlaps
 * there (see markSurfaces). Nothing to land on — a blast in mid-air off the edge
 * of a deck — leaves no mark. `size <= 0` or `opacity <= 0` = no mark.
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
  const under = markSurfaces(floors, stairs, pos, z, size);
  if (!under) return;
  if (out.length >= MAX_SCORCHES) out.splice(0, out.length - MAX_SCORCHES + 1);
  out.push({ pos, z, size, opacity: Math.min(1, opacity), angle: Math.random() * Math.PI * 2, ...under, life: SCORCH_LIFE });
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

/** Draw level `z`'s pass of the scorches with `img`, the decoded scorch sprite
 *  (see beginMarkPass for what each pass paints). */
export function drawScorches(
  ctx: CanvasRenderingContext2D,
  scorches: readonly Scorch[],
  img: CanvasImageSource,
  z: number,
  inView: (p: Vec2, r: number) => boolean,
): void {
  for (const s of scorches) {
    if (!inView(s.pos, s.size / 2) || !beginMarkPass(ctx, s, z)) continue;
    ctx.globalAlpha = s.opacity * (s.life >= SCORCH_FADE ? 1 : s.life / SCORCH_FADE);
    ctx.translate(s.pos.x, s.pos.y);
    ctx.rotate(s.angle);
    ctx.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
    ctx.restore();
  }
}
