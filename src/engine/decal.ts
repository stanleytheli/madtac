import { obstacleRadius, obstacleSurfaceNormal } from "./collision.ts";
import { angleOf, scale, sub, type Vec2 } from "./vec.ts";
import type { Obstacle } from "../world/world.ts";

/**
 * A bullet hole: a static mark stamped on the face of an obstacle where a round
 * struck it. Pure eye-candy, like particles — no gameplay state, no collision.
 *
 * The art (assets/bullethole.png) is a black half-disc with cracks fanning away
 * from its flat edge. The flat edge sits ON the face at the impact point and the
 * disc + cracks bite INTO the material, so the sprite is oriented by the actual
 * surface normal where the round landed (see stampBulletHole) and clipped to the
 * obstacle's own outline when drawn, so a hole never pokes out the back of a
 * thin wall or past a barrel's rim (see drawDecals). A wallbang stamps one on
 * each face it crossed; a round that stops stamps one where it stopped.
 */
export interface Decal {
  /** The impact point, projected onto the obstacle's surface. */
  pos: Vec2;
  /** Angle of the outward surface normal at `pos` (rad). */
  normal: number;
  z: number; // the struck obstacle's level (renders with that level)
  /** The obstacle it's on: the draw clips to this outline. */
  on: Obstacle;
  /** Drawn width along the face / depth into it, world px. */
  w: number;
  h: number;
  /** Mirror the sprite along the face, for a little variety between holes. */
  flip: boolean;
  life: number; // ticks remaining
}

/** How long a hole stays on the wall: 5 s at 60 ticks/s, then it's gone so
 *  walls don't clutter up over a long match. */
export const DECAL_LIFE = 300;
/** The last stretch of that life fades out instead of blinking away. */
const DECAL_FADE = 60;
/** Most holes kept at once; past this the oldest go first, whatever their age. */
const MAX_DECALS = 400;

/** The sprite's native size in world px at heft 1 (the file is 40x20). Scaled by
 *  the round's heft the same way its debris is — see SHRAPNEL_TRACER_WIDTH. */
export const HOLE_W = 20;
export const HOLE_H = 10;

/**
 * Stamp a bullet hole on `o` for a round that reached `near` — any point at or
 * just outside the face it struck (a backed-out sample, or a face point from a
 * wallbang crossing). The hole lands exactly on the surface, on the outward
 * normal there, so it reads correctly on a rotated wall, a barrel, or a corner.
 * `heft` sizes it like the debris: 1 = the sprite's own size, 0 = no mark.
 *
 * A round landing on a hole that's already there (same obstacle, within half
 * the new hole's width) restarts that hole's clock instead of stacking a second
 * one on top — the existing hole stays exactly where it is, so a burst into one
 * patch of wall leaves a few holes that hold still, not one per round smeared
 * into a black blot (or one hole that jitters with every round).
 */
export function stampBulletHole(out: Decal[], near: Vec2, o: Obstacle, z: number, heft = 1): void {
  if (heft <= 0 || o.invisible) return; // an invisible barrier shows no holes
  const { n, dist } = obstacleSurfaceNormal(near, o);
  const pos = sub(near, scale(n, dist));
  const w = HOLE_W * heft;
  const h = HOLE_H * heft;
  const mergeR = w / 2;
  for (const d of out) {
    if (d.on !== o) continue;
    const dx = d.pos.x - pos.x;
    const dy = d.pos.y - pos.y;
    if (dx * dx + dy * dy > mergeR * mergeR) continue;
    d.life = DECAL_LIFE;
    return;
  }
  if (out.length >= MAX_DECALS) out.splice(0, out.length - MAX_DECALS + 1);
  out.push({
    pos,
    normal: angleOf(n),
    z,
    on: o,
    w,
    h,
    flip: Math.random() < 0.5,
    life: DECAL_LIFE,
  });
}

/** Age all decals one tick; drop the expired ones. */
export function updateDecals(decals: Decal[]): Decal[] {
  const alive: Decal[] = [];
  for (const d of decals) {
    d.life -= 1;
    if (d.life > 0) alive.push(d);
  }
  return alive;
}

/**
 * Draw the decals on level `z` (or all of them when omitted) with `img`, the
 * decoded bullet-hole sprite. Each is clipped to its obstacle's outline, then
 * placed with the sprite's bottom (flat) edge on the face and its body pointing
 * along the inward normal.
 */
export function drawDecals(
  ctx: CanvasRenderingContext2D,
  decals: readonly Decal[],
  img: CanvasImageSource,
  z?: number,
): void {
  for (const d of decals) {
    if (z !== undefined && d.z !== z) continue;
    const o = d.on;
    ctx.save();
    ctx.globalAlpha = d.life >= DECAL_FADE ? 1 : d.life / DECAL_FADE;
    // Clip to the obstacle, in its own frame.
    ctx.translate(o.pos.x, o.pos.y);
    ctx.rotate(o.angle ?? 0);
    ctx.beginPath();
    if (o.round) ctx.arc(0, 0, obstacleRadius(o), 0, Math.PI * 2);
    else ctx.rect(-o.w / 2, -o.h / 2, o.w, o.h);
    ctx.clip();
    ctx.rotate(-(o.angle ?? 0));
    ctx.translate(-o.pos.x, -o.pos.y);
    // The sprite's +y (its flat bottom edge) faces the outward normal, so the
    // half-disc and cracks above it extend into the material.
    ctx.translate(d.pos.x, d.pos.y);
    ctx.rotate(d.normal - Math.PI / 2);
    if (d.flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -d.w / 2, -d.h, d.w, d.h);
    ctx.restore();
  }
}
