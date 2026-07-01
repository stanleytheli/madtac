/**
 * Body armor. Like a gun, it's split into immutable data (`ArmorSpec`) and a
 * stateful per-instance object (`Armor`, which tracks current HP). Kept general
 * on purpose: today an armor is "a colored ring around the head, optionally with
 * a helmet cap on top," but a future "armor skin" can override `drawWorn*` to
 * render however it likes.
 *
 * Damage model (see Character.registerHit): when a hit lands on an armored
 * character, the armor soaks the full bullet damage while the body only takes the
 * fraction that penetrates — `gun.armorPen[l{level}]`. When the armor's HP hits 0
 * it's destroyed and removed.
 */
import { add, scale, type Vec2 } from "./vec.ts";

/** Filled circle helper (no outline). */
function circle(ctx: CanvasRenderingContext2D, c: Vec2, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** A colored ring worn around the head (replaces the head's old black outline). */
export interface ArmorBorder {
  color: string;
  /** Ring thickness in world px (how far past the head radius it extends). */
  width: number;
}

/** An optional helmet: a borderless cap drawn on top of the head, shifted back. */
export interface ArmorHelmet {
  color: string;
  /** Helmet circle radius in world px. */
  radius: number;
  /** How far back (opposite the aim direction) the cap sits, in world px. */
  back: number;
}

export interface ArmorSpec {
  name: string;
  /** 1..4 — indexes the firing gun's `armorPen` (l1..l4) to decide penetration. */
  level: 1 | 2 | 3 | 4;
  /** Ground-sprite basename in /assets (e.g. "armor_l1" -> /assets/armor_l1.png). */
  icon: string;
  /** Starting & maximum armor HP. */
  maxHp: number;
  /** The ring drawn around the head while worn. */
  border: ArmorBorder;
  /** The helmet cap, if this armor has one. */
  helmet?: ArmorHelmet;
  speed: number;
}

/**
 * A worn/ownable armor instance: an immutable spec plus its current HP. Exists in
 * the world so it can be dropped and picked up while keeping its damage state.
 */
export class Armor {
  readonly spec: ArmorSpec;
  hp: number;

  constructor(spec: ArmorSpec) {
    this.spec = spec;
    this.hp = spec.maxHp;
  }

  get level(): 1 | 2 | 3 | 4 {
    return this.spec.level;
  }

  get destroyed(): boolean {
    return this.hp <= 0;
  }

  /** Soak `damage` (the bullet's raw damage). Returns true if this destroyed the armor. */
  absorb(damage: number): boolean {
    this.hp = Math.max(0, this.hp - damage);
    return this.hp <= 0;
  }

  /**
   * Draw the border as an *inner* ring on top of the head: a `width`-thick band
   * hugging the inside of the head's edge, so the character's silhouette stays the
   * same size (the color doesn't spill outside the head). Borderless — no black
   * outline — to match the helmet. Drawn after the head by the caller.
   */
  drawBorderOverHead(
    ctx: CanvasRenderingContext2D,
    headCenter: Vec2,
    headRadius: number,
    _outlineWidth: number,
    _outlineColor: string,
  ): void {
    const { color, width } = this.spec.border;
    // Stroke centered at (headRadius - width/2) => outer edge on the head's edge,
    // inner edge width px inside it.
    ctx.beginPath();
    ctx.arc(headCenter.x, headCenter.y, headRadius, 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  /** Draw the helmet cap (if any) on top of the head, shifted back along -forward. */
  drawHelmetOverHead(
    ctx: CanvasRenderingContext2D,
    headCenter: Vec2,
    forward: Vec2,
    _headRadius: number,
    _outlineWidth: number,
    _outlineColor: string,
  ): void {
    const h = this.spec.helmet;
    if (!h) return;
    const c = add(headCenter, scale(forward, -h.back));
    circle(ctx, c, h.radius, h.color); // borderless, per the intended look
  }
}

// --- concrete armors -------------------------------------------------------
// Level drives protection (via the gun's armorPen table) and roughly HP. Lower
// tiers are just a ring; higher tiers add a helmet cap for readability.

export const ARMOR_L1: ArmorSpec = {
  name: "Level I Armor",
  level: 1,
  icon: "armor_l1",
  maxHp: 150,
  speed: 1.0,
  border: { color: "#9aa0a6", width: 5 }, // light gray
};

export const ARMOR_L2: ArmorSpec = {
  name: "Level II Armor",
  level: 2,
  icon: "armor_l2",
  maxHp: 150,
  speed: 1.0,
  border: { color: "#2c2c2c", width: 5 }, // green
};

export const ARMOR_L3: ArmorSpec = {
  name: "Level III Armor",
  level: 3,
  icon: "armor_l3",
  maxHp: 150,
  speed: 1.0,
  border: { color: "#2c2c2c", width: 5 }, // blue
  helmet: { color: "#005a0c", radius: 17, back: 8},
};

export const ARMOR_L4: ArmorSpec = {
  name: "Level IV Armor",
  level: 4,
  icon: "armor_l4",
  maxHp: 200,
  speed: 0.75,
  border: { color: "#000000", width: 7 }, // purple
  helmet: { color: "#182819", radius: 17, back: 8 },
};
