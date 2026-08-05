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
import { add, scale, type Vec2 } from "../engine/vec.ts";
import { ArmorItem, type Droppable, type GroundItem } from "./item.ts";

/** Filled circle helper (no outline). */
function circle(ctx: CanvasRenderingContext2D, c: Vec2, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Filled ellipse helper (no outline), centered at `c`, rotated by `ang`. */
function ellipse(
  ctx: CanvasRenderingContext2D,
  c: Vec2,
  a: number,
  b: number,
  ang: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.ellipse(0, 0, a, b, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
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

/**
 * One cosmetic shoulder pad: an ellipse drawn *over* the character's shoulder
 * cap (but under the head). Positioned relative to the shoulder the body rig
 * already solves, so it follows the arm's splay and the aim direction for free.
 * The armor spec owns all of the look.
 */
export interface ShoulderPad {
  color: string;
  /** Ellipse semi-axes in world px (a along the radial/outward direction). */
  a: number;
  b: number;
  /** Shift outward along the shoulder's radial direction, away from the head (world px). */
  out?: number;
  /** Shift backward, opposite the aim direction (world px). */
  back?: number;
  /** Extra rotation on top of the shoulder's outward orientation (radians). */
  tilt?: number;
}

/**
 * The pair of shoulder pads for an armor. Left and right are independent so a
 * spec can be asymmetric (one pad, mismatched sizes/colors, etc.). Omit a side
 * to leave that shoulder bare.
 */
export interface ArmorShoulderPads {
  left?: ShoulderPad;
  right?: ShoulderPad;
}

export interface ArmorSpec {
  name: string;
  /** 1..4 — indexes the firing gun's `armorPen` (l1..l4) to decide penetration. */
  level: 1 | 2 | 3 | 4 | 5;
  /** Ground-sprite basename in /assets (e.g. "armor_l1" -> /assets/armor_l1.png). */
  icon: string;
  /** Starting & maximum armor HP. */
  maxHp: number;
  /** The ring drawn around the head while worn. */
  border: ArmorBorder;
  /** The helmet cap, if this armor has one. */
  helmet?: ArmorHelmet;
  /** Cosmetic shoulder pads, if this armor has them (per-side, may be asymmetric). */
  shoulderPads?: ArmorShoulderPads;
  speed: number;
}

/**
 * A worn/ownable armor instance: an immutable spec plus its current HP. Exists in
 * the world so it can be dropped and picked up while keeping its damage state.
 */
export class Armor implements Droppable {
  readonly spec: ArmorSpec;
  hp: number;

  constructor(spec: ArmorSpec) {
    this.spec = spec;
    this.hp = spec.maxHp;
  }

  get level(): 1 | 2 | 3 | 4 | 5{
    return this.spec.level;
  }

  get destroyed(): boolean {
    return this.hp <= 0;
  }

  /** Put this armor on the ground as a pickup at (`pos`, `z`), tossed with `vel`
   *  (the Droppable API). Keeps its current HP — the whole point of a droppable
   *  armor instance. */
  getGroundItem(pos: Vec2, vel: Vec2, z: number): GroundItem {
    return new ArmorItem(pos, this, vel, z);
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

  /**
   * Draw the cosmetic shoulder pads (if any) *over* the body's shoulder caps but
   * under the head — the caller invokes this after the arms and before the head,
   * so each pad caps its shoulder without ever occluding the face. Each pad is
   * anchored to the shoulder the rig already solved (`center` + outward
   * orientation `ang`), so it tracks the arm splay and aim. Left/right are drawn
   * independently; either may be absent (asymmetry).
   */
  drawShoulderPadsOverBody(
    ctx: CanvasRenderingContext2D,
    forward: Vec2,
    left: { center: Vec2; ang: number },
    right: { center: Vec2; ang: number },
    outlineWidth: number,
    outlineColor: string,
  ): void {
    const pads = this.spec.shoulderPads;
    if (!pads) return;
    if (pads.left) this.drawPad(ctx, forward, left, pads.left, outlineWidth, outlineColor);
    if (pads.right) this.drawPad(ctx, forward, right, pads.right, outlineWidth, outlineColor);
  }

  /** Draw a single pad as an outline+fill sticker, matching the body's look. */
  private drawPad(
    ctx: CanvasRenderingContext2D,
    forward: Vec2,
    shoulder: { center: Vec2; ang: number },
    pad: ShoulderPad,
    outlineWidth: number,
    outlineColor: string,
  ): void {
    // The shoulder's `ang` already points radially outward from the head; slide
    // the pad along that direction (`out`) and back along -aim (`back`).
    const dir = { x: Math.cos(shoulder.ang), y: Math.sin(shoulder.ang) };
    let c = add(shoulder.center, scale(dir, pad.out ?? 0));
    c = add(c, scale(forward, -(pad.back ?? 0)));
    const ang = shoulder.ang + (pad.tilt ?? 0);
    ellipse(ctx, c, pad.a + outlineWidth, pad.b + outlineWidth, ang, outlineColor);
    ellipse(ctx, c, pad.a, pad.b, ang, pad.color);
  }
}

// --- concrete armors -------------------------------------------------------
// Level drives protection (via the gun's armorPen table) and roughly HP. Lower
// tiers are just a ring; higher tiers add a helmet cap for readability.

export const ARMOR_L1: ArmorSpec = {
  name: "Level I Armor",
  level: 1,
  icon: "armor_l1",
  maxHp: 225,
  speed: 1.0,
  border: { color: "#9aa0a6", width: 5 }, // light gray
};

export const ARMOR_L2: ArmorSpec = {
  name: "Level II Armor",
  level: 2,
  icon: "armor_l2",
  maxHp: 250,
  speed: 1.0,
  border: { color: "#2c2c2c", width: 5 }, // green
};

export const ARMOR_L3: ArmorSpec = {
  name: "Level III Armor",
  level: 3,
  icon: "armor_l3",
  maxHp: 275,
  speed: 1.0,
  border: { color: "#2c2c2c", width: 5 }, // blue
  helmet: { color: "#005a0c", radius: 17, back: 8},
};

export const ARMOR_L4: ArmorSpec = {
  name: "Level IV Armor",
  level: 4,
  icon: "armor_l4_in_small",
  maxHp: 350,
  speed: 0.85,
  border: { color: "#000000", width: 6 }, // purple
  helmet: { color: "#1d2d1d", radius: 17, back: 8},
  shoulderPads: {
    left: { color: "#2a3e2a", a: 19, b: 7, out: 5, back: 7, tilt: 0.3 },
    right: { color: "#2a3e2a", a: 19, b: 7, out: 5, back: 7, tilt: -0.3 },
  },
};
//    left: { color: "#0d3411", a: 12, b: 4, out: 12, back: 6, tilt: 0.3 },


export const ARMOR_L5: ArmorSpec = {
  name: "Level V Armor",
  level: 5,
  icon: "armor_l5",
  maxHp: 750,
  speed: 0.75,
  border: { color: "#000000", width: 7 }, // purple
  helmet: { color: "#182819", radius: 17, back: 8 },
  shoulderPads: {
    left: { color: "#1c1c1c", a: 19, b: 7, out: 5, back: 7, tilt: 0.3 },
    right: { color: "#1c1c1c", a: 19, b: 7, out: 5, back: 7, tilt: -0.3 },
  },
};
