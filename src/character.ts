import {
  add,
  angleOf,
  circleIntersect,
  deg2rad,
  dist,
  dot,
  mid,
  norm,
  rotate,
  scale,
  sub,
  type Vec2,
} from "./vec.ts";

export interface Skin {
  head: string;
  rightShoulder: string;
  leftShoulder: string;
  rightUpperarm: string;
  leftUpperarm: string;
  rightForearm: string;
  leftForearm: string;
  rightHand: string;
  leftHand: string;
  outline: string;
}

export const DEFAULT_SKIN: Skin = {
  head: "#e5d176",
  rightShoulder: "#2c2b2a",
  leftShoulder: "#2c2b2a",
  rightUpperarm: "#e5d176",
  leftUpperarm: "#e5d176",
  rightForearm: "#e5d176",
  leftForearm: "#e5d176",
  rightHand: "#e5d176",
  leftHand: "#e5d176",
  outline: "#000000",
};

export const ENEMY_SKIN: Skin = {
  head: "#e5d176", // blue, to read as "not the player"
  rightShoulder: "#2f6bd0",
  leftShoulder: "#2f6bd0",
  rightUpperarm: "#9cc0ff",
  leftUpperarm: "#9cc0ff",
  rightForearm: "#9cc0ff",
  leftForearm: "#9cc0ff",
  rightHand: "#e5d176",
  leftHand: "#e5d176",
  outline: "#000000",
};

/** Collision radius used for character-vs-world and bullet-vs-character checks. */
export const BODY_RADIUS = 30;

export interface CharParams {
  rHead: number;
  /** Semi-major / semi-minor of the (static) shoulder ellipse. */
  rShoulder: number;
  shoulderMinor: number;
  /** Length of the upper arm (shoulder -> elbow) bone. */
  upperArmLen: number;
  /** Length of the lower arm (elbow -> hand) bone. */
  lowerArmLen: number;
  /** Semi-minor (thickness) of the upper arm — wider than the forearm. */
  upperArmMinor: number;
  /** Semi-minor (thickness) of the lower arm / forearm. */
  lowerArmMinor: number;
  rHand: number;
  /** Angle of each shoulder away from the forward (aim) direction, in degrees. */
  shoulderAngleDeg: number;
  /** Hand forward-distance at which the shoulder sits at its neutral splay angle. */
  shoulderNeutralF: number;
  /** Degrees the shoulder tilts forward per world px the hand reaches past neutral. */
  shoulderTiltPerF: number;
  /** Where the shoulder ellipse centers, as a fraction of rHead from the head center. */
  shoulderInset: number;
  /** How far outboard of the shoulder center the upper arm attaches (world px). */
  armAttach: number;
  /** Extra length added to limb ellipses so parts overlap instead of just touching. */
  overlap: number;
  /** Thickness of the black sticker outline. */
  outline: number;
}

export const DEFAULT_PARAMS: CharParams = {
  rHead: 28,
  rShoulder: 20,
  shoulderMinor: 14,
  upperArmLen: 35,
  lowerArmLen: 40,
  upperArmMinor: 11,
  lowerArmMinor: 7,
  rHand: 8,
  shoulderAngleDeg: 90,
  shoulderNeutralF: 50,
  shoulderTiltPerF: 0.75,
  shoulderInset: 1.0,
  armAttach: 12, // arm attaches outboard of the shoulder center, toward its edge
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
  upperArm: Ellipse;
  lowerArm: Ellipse;
}

/**
 * Solve one arm given the head center, aim direction, which side the shoulder is
 * on, and the hand position. Two-bone IK with a static shoulder:
 *
 *   1. Place the shoulder center S on the side of the head (a fixed pivot).
 *   2. The elbow E is where a circle of radius `upperArmLen` around S meets a
 *      circle of radius `lowerArmLen` around the hand. Of the two intersections,
 *      take the one further from the head, so the elbow bows outward.
 *   3. The shoulder ellipse stays put, oriented with the body (not the elbow), so
 *      it doesn't swing as the hand moves. The upper arm spans S -> E, the lower
 *      arm spans E -> hand.
 */
function solveLimb(
  headCenter: Vec2,
  forward: Vec2,
  sideSign: number, // +1 right, -1 left
  hand: Vec2,
  p: CharParams,
): LimbSolution {
  // The shoulder tilts forward to "help" as the hand reaches forward: its splay
  // angle off `forward` shrinks below neutral the further the hand extends.
  const f = dot(sub(hand, headCenter), forward);
  const tiltDeg = (f - p.shoulderNeutralF) * p.shoulderTiltPerF;
  const dir = rotate(forward, sideSign * deg2rad(p.shoulderAngleDeg - tiltDeg));
  const S = add(headCenter, scale(dir, p.rHead * p.shoulderInset));
  // The arm attaches outboard of the shoulder center, toward the shoulder's edge.
  const armRoot = add(S, scale(dir, p.armAttach));

  const inter = circleIntersect(armRoot, p.upperArmLen, hand, p.lowerArmLen);
  let E: Vec2;
  if (inter) {
    // Outer intersection = the one further from the head center.
    E = dist(inter[0], headCenter) >= dist(inter[1], headCenter) ? inter[0] : inter[1];
  } else {
    // Hand out of reach (too far or too close): straighten the arm toward it.
    E = add(armRoot, scale(norm(sub(hand, armRoot)), p.upperArmLen));
  }

  // Static shoulder: oriented radially outward from the head (along the side
  // direction), not at the elbow — so it doesn't swing as the hand moves.
  const shoulder: Ellipse = {
    center: S,
    a: p.rShoulder,
    b: p.shoulderMinor,
    ang: angleOf(dir),
  };

  const upperArm: Ellipse = {
    center: mid(armRoot, E),
    a: dist(armRoot, E) / 2 + p.overlap,
    b: p.upperArmMinor,
    ang: angleOf(sub(E, armRoot)),
  };

  const lowerArm: Ellipse = {
    center: mid(E, hand),
    a: dist(E, hand) / 2 + p.overlap,
    b: p.lowerArmMinor,
    ang: angleOf(sub(hand, E)),
  };

  return { shoulder, upperArm, lowerArm };
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
  const outlineEllipse = (e: Ellipse) =>
    ellipse(ctx, { ...e, a: e.a + o, b: e.b + o }, skin.outline);
  const fillEllipse = (e: Ellipse, color: string) => ellipse(ctx, e, color);
  const drawCircle = (c: Vec2, r: number, color: string) => {
    circle(ctx, c, r + o, skin.outline);
    circle(ctx, c, r, color);
  };

  // Draw one limb: upper arm, then forearm, then the static shoulder cap — each
  // as its own outline+fill, so the elbow shows a sticker seam (the classic .io
  // look, consistent with the rest of the graphics).
  const drawPart = (e: Ellipse, color: string) => {
    outlineEllipse(e);
    fillEllipse(e, color);
  };

  drawPart(leftLimb.lowerArm, skin.leftForearm)
  drawPart(leftLimb.upperArm, skin.leftUpperarm)
  drawPart(leftLimb.shoulder, skin.leftShoulder)

  drawPart(rightLimb.lowerArm, skin.rightForearm)
  drawPart(rightLimb.upperArm, skin.rightUpperarm)
  drawPart(rightLimb.shoulder, skin.rightShoulder)

  drawGun();

  drawCircle(leftHand, p.rHand, skin.leftHand);
  drawCircle(rightHand, p.rHand, skin.rightHand);

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
