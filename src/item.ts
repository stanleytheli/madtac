import type { Armor, ArmorSpec } from "./armor.ts";
import { resolveCircleVsBox } from "./collision.ts";
import type { Gun } from "./gun.ts";
import type { GunSpec } from "./guns.ts";
import { add, len, scale, sub, vec, type Vec2 } from "./vec.ts";
import type { Obstacle } from "./world.ts";

/**
 * Something lying on the ground that the player can walk up to and grab with E.
 * Kept deliberately generic (pos + label + draw + update) so future pickups
 * (ammo, armor, meds, ...) implement the same shape. The specific pickup *effect*
 * is decided by whoever owns the item list, by switching on the concrete subtype.
 */
export interface GroundItem {
  pos: Vec2;
  /** Footprint radius, used for soft separation between items (see separateItems). */
  readonly radius: number;
  /** Text shown in the interaction prompt (e.g. the weapon's name). */
  readonly label: string;
  /** Advance one tick (slide to rest, collide with obstacles). No-op for static items. */
  update(obstacles: readonly Obstacle[]): void;
  draw(ctx: CanvasRenderingContext2D): void;
}

const ITEM_RADIUS = 35; // collision radius vs walls/crates
const ITEM_FRICTION = 0.85; // per-tick velocity retention as it slides to rest
const SEPARATION_RATE = 0.25; // fraction of overlap resolved per tick (soft, gradual)

/**
 * Soft collision between ground items: any two whose footprints overlap drift
 * apart along the line between their centers, a little each tick, so a pile of
 * dropped guns spreads out instead of stacking. Intentionally gentle (not a hard
 * resolve) — it eases items apart rather than snapping them.
 */
export function separateItems(items: readonly GroundItem[]): void {
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const minDist = a.radius + b.radius;
      const delta = sub(b.pos, a.pos);
      const d = len(delta);
      if (d >= minDist) continue;
      // Unit push direction; if the centers coincide, pick a deterministic axis.
      const dir = d > 1e-6 ? scale(delta, 1 / d) : vec(Math.cos(i * 2.4), Math.sin(i * 2.4));
      const push = (minDist - d) * 0.5 * SEPARATION_RATE;
      a.pos = sub(a.pos, scale(dir, push));
      b.pos = add(b.pos, scale(dir, push));
    }
  }
}

/** The decoded icon for a gun spec, or null if it has none / hasn't loaded yet. */
export function gunIcon(spec: GunSpec): HTMLImageElement | null {
  if (!spec.icon) return null;
  const img = getImage(`/assets/${spec.icon}.png`);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** The decoded sprite for an armor spec, or null if it hasn't loaded yet. */
export function armorIcon(spec: ArmorSpec): HTMLImageElement | null {
  const img = getImage(`/assets/${spec.icon}.png`);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// Lazy, cached <img> loader. Drawing is skipped until the image has decoded.
const imageCache = new Map<string, HTMLImageElement>();
function getImage(src: string): HTMLImageElement {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  return img;
}

const ICON_SIZE = 72; // world px for the icon's longer side
const ICON_ROT = -Math.PI / 4; // drawn rotated 45° counter-clockwise
const ICON_SCALE = 0.5; // sprite -> world px scale for ground icons
const GUN_BACKDROP = ICON_SIZE * 0.5; // soft shadow radius under a gun icon
const ARMOR_BACKDROP = ICON_SIZE * 0.6; // armor sprites are a bit larger

/**
 * Draw a ground pickup: a soft dark backdrop (so the sprite reads on any floor)
 * with the rotated icon on top. Shared by every GroundItem so they look uniform.
 */
function drawGroundIcon(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  iconSrc: string,
  backdropRadius: number,
  scale: number,
  rotation: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, backdropRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const img = iconSrc ? getImage(iconSrc) : null;
  if (!img || !img.complete || img.naturalWidth === 0) return;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(rotation);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** A gun lying on the ground, tied to its Gun instance (so it keeps its ammo). */
export class GunItem implements GroundItem {
  pos: Vec2;
  vel: Vec2;
  readonly radius = ITEM_RADIUS;
  readonly gun: Gun;
  private readonly iconSrc: string;

  constructor(pos: Vec2, gun: Gun, vel: Vec2 = vec(0, 0)) {
    this.pos = pos;
    this.vel = vel;
    this.gun = gun;
    this.iconSrc = gun.spec.icon ? `/assets/${gun.spec.icon}.png` : "";
  }

  get label(): string {
    return this.gun.spec.name;
  }

  /** Slide toward rest, pushing out of any solid obstacles. */
  update(obstacles: readonly Obstacle[]): void {
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, ITEM_FRICTION);
    for (const o of obstacles) this.pos = resolveCircleVsBox(this.pos, ITEM_RADIUS, o);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, GUN_BACKDROP, ICON_SCALE, ICON_ROT);
  }
}

const ARMOR_ICON_SCALE = 0.35;
const ARMOR_ITEM_RADIUS = 45; // larger footprint than a gun (bigger sprite)

/** A piece of armor lying on the ground, tied to its Armor instance (keeps its HP). */
export class ArmorItem implements GroundItem {
  pos: Vec2;
  vel: Vec2;
  readonly radius = ARMOR_ITEM_RADIUS;
  readonly armor: Armor;
  private readonly iconSrc: string;

  constructor(pos: Vec2, armor: Armor, vel: Vec2 = vec(0, 0)) {
    this.pos = pos;
    this.vel = vel;
    this.armor = armor;
    this.iconSrc = `/assets/${armor.spec.icon}.png`;
  }

  get label(): string {
    return this.armor.spec.name;
  }

  /** Slide toward rest, pushing out of any solid obstacles. */
  update(obstacles: readonly Obstacle[]): void {
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, ITEM_FRICTION);
    for (const o of obstacles) this.pos = resolveCircleVsBox(this.pos, ARMOR_ITEM_RADIUS, o);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, ARMOR_BACKDROP, ARMOR_ICON_SCALE, 0);
  }
}
