import { beginMarkPass, markSurfaces, type MarkSurfaces } from "./floormark.ts";
import { add, fromAngle, len, scale, sub, vec, type Vec2 } from "./vec.ts";
import type { Floor, Stairs } from "../world/world.ts";

/**
 * Blood splattered onto the ground by a hit, left behind so you can tell a fight
 * happened there after it's over. Pure eye-candy, like a scorch: no gameplay
 * state, and client-owned (the sim emits a "blood" event; see engine/effects.ts).
 * It lands only where there is floor (or a flight of stairs) to stain — see
 * MarkSurfaces.
 *
 * One hit throws a short trail of these along the spray (see
 * stampBloodSplatter): the first where the hit landed, each next one further
 * along the way the round was going, as if the blood were flung back off the
 * victim.
 */
export interface BloodSplat extends MarkSurfaces {
  pos: Vec2; // centre
  z: number; // the level it landed on (renders with that level)
  size: number; // drawn width = height of the sprite, world px
  angle: number; // random spin, for variety between marks
  image: number; // index into BLOOD_SPLAT_IMAGES
  life: number | null; // ticks remaining; null = stays until the cap clears it
}

/** The splatter art in /assets (round red stains on transparent). */
export const BLOOD_SPLAT_IMAGES = [
  "blood_splatter_round_1.png",
  "blood_splatter_round_2.png",
  "blood_splatter_round_3.png",
  "blood_splatter_round_4.png",
  "blood_splatter_round_5.png",
];
/* How long a splatter stays is the gamemode's (Gamemode.bloodTtl, read off
 * World.bloodTtl), like a corpse's or a dropped gun's: ~12 s in the team modes,
 * with the bodies; for good in the sandbox, where the bodies stay too. */
/** The last stretch of a splatter's life fades out instead of blinking away. */
const BLOOD_SPLAT_FADE = 120;
/** Most splatters kept at once; past this the oldest go first, whatever their age. */
const MAX_BLOOD_SPLATS = 256;

/** Most splatters one hit throws; the least is one. */
export const MAX_SPLATS_PER_HIT = 3;
/** Damage taken (after armour) that fills one splatter to SPLAT_MAX_SIZE. A
 *  heavier hit spills the rest into the next splatter along, up to
 *  MAX_SPLATS_PER_HIT. */
export const SPLAT_FULL_DAMAGE = 35;
/** A full splatter's width, world px (about a body across). */
export const SPLAT_MAX_SIZE = 110;
/** The narrowest any splatter is drawn, world px, however small its share of
 *  the damage — a graze or a hit's last drop of spill-over still shows. */
export const SPLAT_MIN_SIZE = 65;
/** How far each next splatter lands past the one before, along the spray, world px. */
export const SPLAT_STEP = 50;
/** Each next splatter is also knocked up to this far off the line, world px. */
export const SPLAT_JITTER = 25;
/** How opaque a splatter is drawn, 0..1, before its fade-out. */
export const SPLAT_OPACITY = 0.4;
/** A splatter about to land closer than this fraction of its and an older one's
 *  mean width to that older one is nudged away from it, so hits on one spot
 *  spread into a wider stain instead of piling onto one blot (see spreadOut). */
export const SPLAT_SPREAD = 0.5;
/** The furthest that nudge moves a splatter, world px. */
export const SPLAT_MAX_NUDGE = 30;

/**
 * The widths of the splatters a hit that cost the body `damage` (what got past
 * the armour: see Character.bodyDamage) throws, in
 * order. The first fills toward SPLAT_MAX_SIZE as the damage grows to
 * SPLAT_FULL_DAMAGE; whatever is left over starts the next, and so on. Width goes
 * as the square root of a splatter's share, so the AREA stained tracks the damage,
 * floored at SPLAT_MIN_SIZE.
 */
export function splatterSizes(damage: number): number[] {
  const sizes: number[] = [];
  let left = damage;
  while (left > 1e-9 && sizes.length < MAX_SPLATS_PER_HIT) {
    const share = Math.min(left, SPLAT_FULL_DAMAGE);
    sizes.push(Math.max(SPLAT_MIN_SIZE, SPLAT_MAX_SIZE * Math.sqrt(share / SPLAT_FULL_DAMAGE)));
    left -= share;
  }
  return sizes;
}

/**
 * Where a `size`-wide splatter aimed at `pos` on level `z` actually lands: pushed
 * off each older splatter it would land almost on top of (see SPLAT_SPREAD) by
 * as much as it overlaps it, once — no settling, just the one nudge, capped at
 * SPLAT_MAX_NUDGE. Dead centre on one, it goes off in a random direction —
 * any fixed choice (say, along the spray) would line every push on one spot up
 * on one axis, where they cancel and the pile restacks. Splatters in `own` (this
 * hit's trail so far) don't push: they keep their SPLAT_STEP spacing.
 */
function spreadOut(
  splats: readonly BloodSplat[],
  own: readonly BloodSplat[],
  pos: Vec2,
  z: number,
  size: number,
): Vec2 {
  let push = vec(0, 0);
  for (const s of splats) {
    if (s.z !== z || own.includes(s)) continue;
    const reach = (SPLAT_SPREAD * (size + s.size)) / 2;
    const away = sub(pos, s.pos);
    const d = len(away);
    if (d >= reach) continue;
    push = add(push, scale(d > 1e-6 ? scale(away, 1 / d) : fromAngle(Math.random() * Math.PI * 2), reach - d));
  }
  const n = len(push);
  return add(pos, n > SPLAT_MAX_NUDGE ? scale(push, SPLAT_MAX_NUDGE / n) : push);
}

/**
 * Splatter blood for a hit of `damage` that landed at `at` on level `z`, sprayed
 * along `dir` (unit): the round's travel for a bullet, outward from the centre for
 * a blast. Each splatter lasts `life` ticks (the gamemode's bloodTtl), or for
 * good when that's null. Each splatter picks its art at random — never the same as the one
 * stamped just before it — and its own spin, and is nudged off any older one it
 * would land right on top of (see spreadOut). A splatter with no floor under it
 * (flung off a deck) is dropped; the rest of the trail still lands.
 */
export function stampBloodSplatter(
  out: BloodSplat[],
  floors: readonly Floor[],
  stairs: readonly Stairs[],
  at: Vec2,
  dir: Vec2,
  z: number,
  damage: number,
  life: number | null,
): void {
  let pos = at;
  const own: BloodSplat[] = [];
  splatterSizes(damage).forEach((size, i) => {
    if (i > 0) {
      const jitter = fromAngle(Math.random() * Math.PI * 2, SPLAT_JITTER * Math.sqrt(Math.random()));
      pos = add(add(pos, scale(dir, SPLAT_STEP)), jitter);
    }
    pos = spreadOut(out, own, pos, z, size); // the rest of the trail follows it
    const under = markSurfaces(floors, stairs, pos, z, size);
    if (!under) return;
    const prev = out.length ? out[out.length - 1].image : -1;
    let image = Math.floor(Math.random() * (BLOOD_SPLAT_IMAGES.length - (prev >= 0 ? 1 : 0)));
    if (prev >= 0 && image >= prev) image++; // skip the last one's art
    if (out.length >= MAX_BLOOD_SPLATS) out.splice(0, out.length - MAX_BLOOD_SPLATS + 1);
    const splat: BloodSplat = { pos, z, size, angle: Math.random() * Math.PI * 2, image, ...under, life };
    out.push(splat);
    own.push(splat);
  });
}

/** Age all splatters one tick; drop the expired ones (a null life never ages). */
export function updateBloodSplats(splats: BloodSplat[]): BloodSplat[] {
  const alive: BloodSplat[] = [];
  for (const s of splats) {
    if (s.life !== null) s.life -= 1;
    if (s.life === null || s.life > 0) alive.push(s);
  }
  return alive;
}

/** Draw level `z`'s pass of the splatters (see beginMarkPass for what each pass
 *  paints). `imgs` are the decoded BLOOD_SPLAT_IMAGES, null while one loads. */
export function drawBloodSplats(
  ctx: CanvasRenderingContext2D,
  splats: readonly BloodSplat[],
  imgs: readonly (CanvasImageSource | null)[],
  z: number,
  inView: (p: Vec2, r: number) => boolean,
): void {
  for (const s of splats) {
    const img = imgs[s.image];
    if (!img || !inView(s.pos, s.size / 2) || !beginMarkPass(ctx, s, z)) continue;
    ctx.globalAlpha = SPLAT_OPACITY * (s.life === null || s.life >= BLOOD_SPLAT_FADE ? 1 : s.life / BLOOD_SPLAT_FADE);
    ctx.translate(s.pos.x, s.pos.y);
    ctx.rotate(s.angle);
    ctx.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
    ctx.restore();
  }
}
