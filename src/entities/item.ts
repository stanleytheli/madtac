import { nextEntityId } from "../engine/ids.ts";
import type { Armor, ArmorSpec } from "./armor.ts";
import { resolveCircleVsObstacle } from "../engine/collision.ts";
import type { UtilitySpec } from "./consumable.ts";
import type { Gun } from "./gun.ts";
import type { GunSpec } from "./guns.ts";
import { add, len, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import type { Obstacle } from "../world/world.ts";

/**
 * Something lying on the ground that the player can walk up to and grab with E.
 * Kept deliberately generic (pos + label + draw + update) so future pickups
 * (ammo, armor, meds, ...) implement the same shape. The specific pickup *effect*
 * is decided by whoever owns the item list, by switching on the concrete subtype.
 */
export interface GroundItem {
  /** Entity id (see engine/ids.ts). Writable so a client mirror can take the server's. */
  id: number;
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
  /** Draw the pickup. `highlighted` (the current E-pickup target) rings it between
   *  its backdrop disc and its sprite. */
  draw(ctx: CanvasRenderingContext2D, highlighted?: boolean): void;
}

/**
 * Something a character carries that can be put on the ground: a gun, a worn
 * armor, or a stack of a utility (see Gun / Armor / UtilityStack). Each droppable
 * knows how to wrap itself as the matching `GroundItem` — the single drop API
 * used by every drop path (pickup swap, manual drop, death). `getGroundItem` also
 * resets any carry-only state as the gear leaves the hand (e.g. a gun clears its
 * reload/recoil/cooldown timers). The caller stamps a despawn `lifetime` on the
 * result if its gamemode wants one.
 */
export interface Droppable {
  getGroundItem(pos: Vec2, vel: Vec2, z: number): GroundItem;
}

const ITEM_RADIUS = 35; // collision radius vs walls/crates
const ITEM_FRICTION = 0.85; // per-tick velocity retention as it slides to rest
const SEPARATION_RATE = 0.25; // fraction of overlap resolved per tick (soft, gradual)
const FLASH_TICKS = 120; // an item blinks over this many ticks before it despawns
const BLINK = 6; // ticks per on/off half-cycle of the despawn flash

/** Opacity for a timed item: solid until its final FLASH_TICKS, then blinking
 *  toward despawn (always 1 if immortal). */
function flashAlpha(age: number, lifetime: number | null): number {
  if (lifetime === null) return 1;
  const left = lifetime - age;
  if (left >= FLASH_TICKS) return 1;
  return Math.floor(left / BLINK) % 2 === 0 ? 0 : 1;
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

/** The decoded icon for a utility spec, or null if it hasn't loaded yet. The
 *  utility icon field carries its own extension (svg/png), unlike gun/armor. */
export function utilityIcon(spec: UtilitySpec): HTMLImageElement | null {
  return assetImage(spec.icon);
}

/** A decoded /assets image by full filename (incl. extension), or null until it
 *  loads. For icons that aren't tied to a spec (e.g. the fists/melee glyph). */
export function assetImage(file: string): HTMLImageElement | null {
  const img = getImage(`/assets/${file}`);
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

/** Thickness of the white keyline around a sprite, in the units it's DRAWN in
 *  (world px on the ground, logical HUD px in a slot). Matches the respawn
 *  menu's ICON_OUTLINE_PX so every icon in the game reads the same. */
export const OUTLINE_PX = 3;

// Keylined sprites, per source image and dilation radius. The outline is baked
// once per (sprite, radius) and then drawn like any other image, so the per-frame
// cost is the same single drawImage it always was. Keyed off the image object
// rather than its URL: this is on the ground-item draw path, and reading `.src`
// serializes the whole URL every call.
const outlineCache = new WeakMap<HTMLImageElement, Map<number, HTMLCanvasElement>>();

/**
 * A copy of `img` ringed in white, for drawing at `scale` (output px per source
 * px). The dilation happens in SOURCE pixels — `OUTLINE_PX / scale` of them — so
 * the ring lands at OUTLINE_PX once the caller scales it down.
 *
 * The result is padded symmetrically by that radius, so a centered draw needs no
 * repositioning: swap `naturalWidth`/`naturalHeight` for the returned canvas's
 * `width`/`height` and the sprite core stays put while the outline grows outward.
 * Returns null until the image has decoded.
 *
 * Deliberately NOT folded into gunIcon/armorIcon/utilityIcon: those also feed the
 * in-world character rendering (a slung rifle on someone's back, a held bandage),
 * which stays un-outlined.
 */
export function outlinedIcon(img: HTMLImageElement, scale: number): HTMLCanvasElement | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  const r = Math.max(1, Math.round(OUTLINE_PX / Math.max(scale, 1e-6)));
  let byRadius = outlineCache.get(img);
  if (!byRadius) {
    byRadius = new Map();
    outlineCache.set(img, byRadius);
  }
  const hit = byRadius.get(r);
  if (hit) return hit;

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // The sprite's alpha, filled flat white: 'source-in' keeps only the pixels the
  // sprite already covers, so the silhouette carries its exact shape.
  const sil = document.createElement("canvas");
  sil.width = w;
  sil.height = h;
  const sc = sil.getContext("2d")!;
  sc.drawImage(img, 0, 0);
  sc.globalCompositeOperation = "source-in";
  sc.fillStyle = "#fff";
  sc.fillRect(0, 0, w, h);

  // Dilate by a (2r+1)² square — the same gap-free ring the menu builds from
  // repeated drop-shadow quads. Done separably (a horizontal smear, then a
  // vertical one), which is 2(2r+1) stamps instead of the square's (2r+1)².
  const rowC = document.createElement("canvas");
  rowC.width = w + r * 2;
  rowC.height = h;
  const rc = rowC.getContext("2d")!;
  for (let dx = -r; dx <= r; dx++) rc.drawImage(sil, r + dx, 0);

  const out = document.createElement("canvas");
  out.width = w + r * 2;
  out.height = h + r * 2;
  const oc = out.getContext("2d")!;
  for (let dy = -r; dy <= r; dy++) oc.drawImage(rowC, 0, r + dy);
  oc.drawImage(img, r, r); // original colors on top of the ring

  byRadius.set(r, out);
  return out;
}

// Flat-white silhouettes, cached per source image. The kill feed draws a gun's
// icon as a monochrome glyph — same alpha-keyed 'source-in' fill outlinedIcon
// uses for its ring, minus the ring and the colored sprite on top.
const whiteCache = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

/**
 * A copy of `img` filled flat white over the sprite's exact alpha shape — its
 * silhouette. Returns null until the image has decoded. Cached, so repeated HUD
 * draws are a single blit.
 */
export function whiteIcon(img: HTMLImageElement): HTMLCanvasElement | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  const hit = whiteCache.get(img);
  if (hit) return hit;

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const oc = out.getContext("2d")!;
  oc.drawImage(img, 0, 0);
  oc.globalCompositeOperation = "source-in";
  oc.fillStyle = "#fff";
  oc.fillRect(0, 0, w, h);

  whiteCache.set(img, out);
  return out;
}

const ICON_SIZE = 72; // world px for the icon's longer side
const ICON_ROT = -Math.PI / 4; // drawn rotated 45° counter-clockwise
const ICON_SCALE = 0.5; // sprite -> world px scale for ground icons
const GUN_BACKDROP = ICON_SIZE * 0.5; // soft shadow radius under a gun icon
const ARMOR_BACKDROP = ICON_SIZE * 0.6; // armor sprites are a bit larger

// Pickup-target highlight: a cyan rim just outside the backdrop disc, drawn under
// the sprite. World px (part of the item's footprint, so it scales with zoom).
const HIGHLIGHT_COLOR = "#3ddcff";
const HIGHLIGHT_GAP = 0; // rim sits this far outside the backdrop radius
const HIGHLIGHT_WIDTH = 4;

/** The pickup-target rim: a cyan ring just outside the backdrop disc. Drawn
 *  after the backdrop and before the sprite, so the item sits on top of it. */
function drawHighlightRing(ctx: CanvasRenderingContext2D, pos: Vec2, backdropRadius: number): void {
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = HIGHLIGHT_WIDTH;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, backdropRadius + HIGHLIGHT_GAP, 0, Math.PI * 2);
  ctx.stroke();
}

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
  highlight = false,
): void {
  ctx.save();
  ctx.globalAlpha = alpha; // dropped items fade out over their last few ticks
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, backdropRadius, 0, Math.PI * 2);
  ctx.fill();

  if (highlight) drawHighlightRing(ctx, pos, backdropRadius);

  const img = iconSrc ? getImage(iconSrc) : null;
  const sprite = img ? outlinedIcon(img, scale) : null;
  if (sprite) {
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    ctx.translate(pos.x, pos.y);
    ctx.rotate(rotation);
    ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

/**
 * Like drawGroundIcon, but scales the sprite so its longer side is `targetPx`
 * world px (rather than a fixed sprite-scale). Used for icons whose source size
 * we don't hand-tune per asset (utilities: mixed svg/png).
 */
function drawGroundIconFit(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  iconSrc: string,
  backdropRadius: number,
  targetPx: number,
  rotation: number,
  alpha = 1,
  highlight = false,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, backdropRadius, 0, Math.PI * 2);
  ctx.fill();

  if (highlight) drawHighlightRing(ctx, pos, backdropRadius);

  const img = iconSrc ? getImage(iconSrc) : null;
  if (img && img.complete && img.naturalWidth > 0) {
    // Fit from the ORIGINAL dimensions, so the sprite core still lands at
    // `targetPx` and only the keyline reaches past it.
    const k = targetPx / Math.max(img.naturalWidth, img.naturalHeight);
    const sprite = outlinedIcon(img, k);
    if (sprite) {
      const w = sprite.width * k;
      const h = sprite.height * k;
      ctx.translate(pos.x, pos.y);
      ctx.rotate(rotation);
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
    }
  }
  ctx.restore();
}

/** A gun lying on the ground, tied to its Gun instance (so it keeps its ammo). */
export class GunItem implements GroundItem {
  id = nextEntityId();
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
      this.pos = resolveCircleVsObstacle(this.pos, ITEM_RADIUS, o);
    }
  }

  draw(ctx: CanvasRenderingContext2D, highlighted = false): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, GUN_BACKDROP, ICON_SCALE, ICON_ROT, flashAlpha(this.age, this.lifetime), highlighted);
  }
}

const ARMOR_ICON_SCALE = 0.35;
const ARMOR_ITEM_RADIUS = 45; // larger footprint than a gun (bigger sprite)

/** A piece of armor lying on the ground, tied to its Armor instance (keeps its HP). */
export class ArmorItem implements GroundItem {
  id = nextEntityId();
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
      this.pos = resolveCircleVsObstacle(this.pos, ARMOR_ITEM_RADIUS, o);
    }
  }

  draw(ctx: CanvasRenderingContext2D, highlighted = false): void {
    drawGroundIcon(ctx, this.pos, this.iconSrc, ARMOR_BACKDROP, ARMOR_ICON_SCALE, 0, flashAlpha(this.age, this.lifetime), highlighted);
  }
}

const UTILITY_ITEM_RADIUS = 28; // smaller footprint than a gun/armor
const UTILITY_BACKDROP = ICON_SIZE * 0.4;
const UTILITY_TARGET = 46; // longest-side world px on the ground

/** A stack of a utility consumable lying on the ground (a death drop or a manual
 *  drop). Carries its spec and how many are in the pile. */
export class UtilityItem implements GroundItem {
  id = nextEntityId();
  pos: Vec2;
  vel: Vec2;
  z: number;
  readonly radius = UTILITY_ITEM_RADIUS;
  age = 0;
  lifetime: number | null = null;
  spec: UtilitySpec;
  count: number;
  private iconSrc: string;

  constructor(pos: Vec2, spec: UtilitySpec, count = 1, vel: Vec2 = vec(0, 0), z = 0) {
    this.pos = pos;
    this.spec = spec;
    this.count = count;
    this.vel = vel;
    this.z = z;
    this.iconSrc = `/assets/${spec.icon}`;
  }

  get label(): string {
    return this.count > 1 ? `${this.spec.name} (${this.count})` : this.spec.name;
  }

  /** Slide toward rest, pushing out of solid obstacles on its own level. */
  update(obstacles: readonly Obstacle[]): void {
    this.age += 1;
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, ITEM_FRICTION);
    for (const o of obstacles) {
      if (o.z !== this.z) continue;
      this.pos = resolveCircleVsObstacle(this.pos, UTILITY_ITEM_RADIUS, o);
    }
  }

  draw(ctx: CanvasRenderingContext2D, highlighted = false): void {
    // Upright (no 45° tilt): these icons read best axis-aligned.
    drawGroundIconFit(ctx, this.pos, this.iconSrc, UTILITY_BACKDROP, UTILITY_TARGET, 0, flashAlpha(this.age, this.lifetime), highlighted);
  }
}

