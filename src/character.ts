import {
  add,
  angleOf,
  circleIntersect,
  deg2rad,
  dist,
  mid,
  norm,
  rotate,
  scale,
  sub,
  type Vec2,
} from "./vec.ts";

export interface Skin {
  head: string;
  shoulder: string;
  arm: string;
  hand: string;
  outline: string;
}

export const DEFAULT_SKIN: Skin = {
  head: "#e5d176",
  shoulder: "#2c2b2a",
  arm: "#e5d176",
  hand: "#e5d176",
  outline: "#000000",
};

export const ENEMY_SKIN: Skin = {
  head: "#e5d176", // blue, to read as "not the player"
  shoulder: "#2f6bd0",
  arm: "#9cc0ff",
  hand: "#e5d176",
  outline: "#000000",
};

/** Collision radius used for character-vs-world and bullet-vs-character checks. */
export const BODY_RADIUS = 30;

export interface CharParams {
  rHead: number;
  /** Circle radius projected from the side of the head = half the shoulder ellipse's major axis. */
  rShoulder: number;
  shoulderMinor: number;
  /** Circle radius projected from the hand = full major axis of the arm ellipse. */
  rArm: number;
  armMinor: number;
  rHand: number;
  /** Angle of each shoulder away from the forward (aim) direction, in degrees. */
  shoulderAngleDeg: number;
  /** Where the shoulder ellipse centers, as a fraction of rHead from the head center. */
  shoulderInset: number;
  /** Extra length added to limb ellipses so parts overlap instead of just touching. */
  overlap: number;
  /** Thickness of the black sticker outline. */
  outline: number;
}

export const DEFAULT_PARAMS: CharParams = {
  rHead: 28,
  rShoulder: 20,
  shoulderMinor: 14,
  rArm: 60,
  armMinor: 8,
  rHand: 8,
  shoulderAngleDeg: 90,
  shoulderInset: 1.0,
  overlap: 4,
  outline: 4,
};

interface Ellipse {
  center: Vec2;
  a: number; // semi-major
  b: number; // semi-minor
  ang: number;
}

interface LimbSolution {
  shoulder: Ellipse;
  arm: Ellipse;
}

/**
 * Solve one arm given the head center, aim direction, which side the shoulder is
 * on, and the hand position.
 *
 *   1. Place the shoulder center S on the side of the head.
 *   2. Project a circle of radius rShoulder from S and a circle of radius rArm
 *      from the hand. Their two intersections are candidate elbows; take the one
 *      further from the head (the arm bows outward).
 *   3. The shoulder ellipse is centered at S, pointing at the elbow E.
 *      The arm ellipse spans E -> hand.
 */
function solveLimb(
  headCenter: Vec2,
  forward: Vec2,
  sideSign: number, // +1 right, -1 left
  hand: Vec2,
  p: CharParams,
): LimbSolution {
  const dir = rotate(forward, sideSign * deg2rad(p.shoulderAngleDeg));
  const S = add(headCenter, scale(dir, p.rHead * p.shoulderInset));

  const inter = circleIntersect(S, p.rShoulder, hand, p.rArm);
  let E: Vec2;
  if (inter) {
    // Outer intersection = the one further from the head center.
    E = dist(inter[0], headCenter) >= dist(inter[1], headCenter) ? inter[0] : inter[1];
  } else {
    // Hand out of reach (too far or too close): aim the elbow straight at it.
    E = add(S, scale(norm(sub(hand, S)), p.rShoulder));
  }

  const shoulder: Ellipse = {
    center: S,
    a: p.rShoulder + p.overlap,
    b: p.shoulderMinor,
    ang: angleOf(sub(E, S)),
  };

  const arm: Ellipse = {
    center: mid(E, hand),
    a: dist(E, hand) / 2 + p.overlap,
    b: p.armMinor,
    ang: angleOf(sub(hand, E)),
  };

  return { shoulder, arm };
}

// --- low-level draw helpers (each shape draws as outline + fill) ---

function ellipse(ctx: CanvasRenderingContext2D, e: Ellipse, color: string): void {
  ctx.save();
  ctx.translate(e.center.x, e.center.y);
  ctx.rotate(e.ang);
  ctx.beginPath();
  ctx.ellipse(0, 0, e.a, e.b, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function circle(ctx: CanvasRenderingContext2D, c: Vec2, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Draw a character's body around its head, given the (already recoil-adjusted)
 * world-space hand positions. The arms/shoulders are solved from the hands, so
 * moving the hands re-poses the whole rig for free.
 *
 * The gun is drawn by `drawGun`, invoked at the gun's z-slot (above the head,
 * below the hands) — the Gun owns its own rendering; the Character only places
 * the hands. z-order: arms -> shoulders -> head -> gun -> hands.
 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  headCenter: Vec2,
  forward: Vec2,
  rightHand: Vec2,
  leftHand: Vec2,
  skin: Skin,
  drawGun: () => void,
  p: CharParams = DEFAULT_PARAMS,
): void {
  const rightLimb = solveLimb(headCenter, forward, +1, rightHand, p);
  const leftLimb = solveLimb(headCenter, forward, -1, leftHand, p);

  const o = p.outline;
  // Each part draws its enlarged black outline (over everything behind it) then
  // its colored fill, in z-order.
  const drawEllipse = (e: Ellipse, color: string) => {
    ellipse(ctx, { ...e, a: e.a + o, b: e.b + o }, skin.outline);
    ellipse(ctx, e, color);
  };
  const drawCircle = (c: Vec2, r: number, color: string) => {
    circle(ctx, c, r + o, skin.outline);
    circle(ctx, c, r, color);
  };

  
  drawEllipse(leftLimb.arm, skin.arm);
  drawEllipse(leftLimb.shoulder, skin.shoulder);
  
  drawEllipse(rightLimb.arm, skin.arm);
  drawEllipse(rightLimb.shoulder, skin.shoulder);

  drawGun();

  drawCircle(leftHand, p.rHand, skin.hand);
  drawCircle(rightHand, p.rHand, skin.hand);

  drawCircle(headCenter, p.rHead, skin.head);
}

/** Ticks a muzzle flash stays visible after a shot. */
export const FLASH_TICKS = 5;
const FLASH_LEN = 24; // semi-major along the barrel
const FLASH_WID = 14; // semi-minor

/**
 * Draw a muzzle flash at `pos`, pointing along `forward`. `t` is the remaining
 * life in [0, 1] (1 = just fired), used to scale and fade it out.
 */
export function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  forward: Vec2,
  t: number,
): void {
  const scaleK = 0.6 + 0.4 * t;
  const a = FLASH_LEN * scaleK;
  const b = FLASH_WID * scaleK;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(angleOf(forward));
  ctx.globalAlpha = 0.4 + 0.6 * t;
  // outer glow
  ctx.fillStyle = "#ffb01a";
  ctx.beginPath();
  ctx.ellipse(a * 0.4, 0, a, b, 0, 0, Math.PI * 2);
  ctx.fill();
  // bright core
  ctx.fillStyle = "#fff6c2";
  ctx.beginPath();
  ctx.ellipse(a * 0.4, 0, a * 0.55, b * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
