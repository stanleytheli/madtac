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
  /** The z level it's lying on (dropped items inherit the dropper's level). */
  z: number;
  /** Footprint radius, used for soft separation between items (see separateItems). */
  readonly radius: number;
  /** Text shown in the interaction prompt (e.g. the weapon's name). */
  readonly label: string;
  /** Ticks this item has existed (for timed despawn — see lifetime). */
  age: number;
  /** Ticks until it despawns, or null to linger forever. Set by the session per
   *  gamemode (TDM clears death-drops); authored pickups keep null. */
  lifetime: number | null;
  /** Advance one tick (slide to rest, collide with obstacles). No-op for static items. */
  update(obstacles: readonly Obstacle[]): void;
  draw(ctx: CanvasRenderingContext2D): void;
}

const ITEM_RADIUS = 35; // collision radius vs walls/crates
const ITEM_FRICTION = 0.85; // per-tick velocity retention as it slides to rest
const SEPARATION_RATE = 0.25; // fraction of overlap resolved per tick (soft, gradual)
const FLASH_TICKS = 60; // an item blinks over this many ticks before it despawns
const BLINK = 6; // ticks per on/off half-cycle of the despawn flash

/** Opacity for a timed item: solid until its final FLASH_TICKS, then blinking
 *  toward despawn (always 1 if immortal). */
function flashAlpha(age: number, lifetime: number | null): number {
  if (lifetime === null) return 1;
  const left = lifetime - age;
  if (left >= FLASH_TICKS) return 1;
  return Math.floor(left / BLINK) % 2 === 0 ? 0.2 : 1;
}

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
      if (a.z !== b.z) continue; // items on different levels never touch
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
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha; // dropped items fade out over their last few ticks
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, backdropRadius, 0, Math.PI * 2);
  ctx.fill();

  const img = iconSrc ? getImage(iconSrc) : null;
  if (img && img.complete && img.naturalWidth > 0) {
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.translate(pos.x, pos.y);
    ctx.rotate(rotation);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

/** A gun lying on the ground, tied to its Gun instance (so it keeps its ammo). */
export class GunItem implements GroundItem {
  pos: Vec2;
  vel: Vec2;
  z: number;
  readonly radius = ITEM_RADIUS;
  age = 0;
  lifetime: number | null = null;
  gun: Gun;
  private iconSrc: string;

  constructor(pos: Vec2, gun: Gun, vel: Vec2 = vec(0, 0), z = 0) {
    this.pos = pos;
    this.vel = vel;
    this.z = z;
    this.gun = gun;
    this.iconSrc = gun.spec.icon ? `/assets/${gun.spec.icon}.png` : "";
  }

  /** Swap which gun this pickup holds (used by the level editor's inspector). */
  setGun(gun: Gun): void {
    this.gun = gun;
    this.iconSrc = gun.spec.icon ? `/assets/${gun.spec.icon}.png` : "";
  }

  get label(): string {
    return this.gun.spec.name;
  }

  /** Slide toward rest, pushing out of solid obstacles on its own level. */
  update(obstacles: readonly Obstacle[]): void {
    this.age += 1;
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, ITEM_FRICTION);
    for (const o of obstacles) {
      if (o.z !== this.z) continue;
      this.pos = resolveCircleVsBox(this.pos, ITEM_RADIUS, o);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, GUN_BACKDROP, ICON_SCALE, ICON_ROT, flashAlpha(this.age, this.lifetime));
  }
}

const ARMOR_ICON_SCALE = 0.35;
const ARMOR_ITEM_RADIUS = 45; // larger footprint than a gun (bigger sprite)

/** A piece of armor lying on the ground, tied to its Armor instance (keeps its HP). */
export class ArmorItem implements GroundItem {
  pos: Vec2;
  vel: Vec2;
  z: number;
  readonly radius = ARMOR_ITEM_RADIUS;
  age = 0;
  lifetime: number | null = null;
  armor: Armor;
  private iconSrc: string;

  constructor(pos: Vec2, armor: Armor, vel: Vec2 = vec(0, 0), z = 0) {
    this.pos = pos;
    this.vel = vel;
    this.z = z;
    this.armor = armor;
    this.iconSrc = `/assets/${armor.spec.icon}.png`;
  }

  /** Swap which armor this pickup holds (used by the level editor's inspector). */
  setArmor(armor: Armor): void {
    this.armor = armor;
    this.iconSrc = `/assets/${armor.spec.icon}.png`;
  }

  get label(): string {
    return this.armor.spec.name;
  }

  /** Slide toward rest, pushing out of solid obstacles on its own level. */
  update(obstacles: readonly Obstacle[]): void {
    this.age += 1;
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, ITEM_FRICTION);
    for (const o of obstacles) {
      if (o.z !== this.z) continue;
      this.pos = resolveCircleVsBox(this.pos, ARMOR_ITEM_RADIUS, o);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, ARMOR_BACKDROP, ARMOR_ICON_SCALE, 0, flashAlpha(this.age, this.lifetime));
  }
}
