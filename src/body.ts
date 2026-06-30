import type { Character } from "./actor.ts";
import { BODY_RADIUS, drawCharacter, type Skin } from "./character.ts";
import { resolveCircleVsBox } from "./collision.ts";
import { UNARMED } from "./guns.ts";
import { add, angleOf, fromAngle, perp, scale, type Vec2 } from "./vec.ts";
import type { Obstacle } from "./world.ts";

const LIN_FRICTION = 0.9; // per-tick velocity retention as the corpse slides to rest
const ANG_FRICTION = 0.92; // ...and for its spin
const DARKEN = 0.45; // multiply skin colors by this to read as "dead"

// Initial death "pop": small but clearly visible launch + tumble.
const SPAWN_SPEED_MIN = 5.5;
const SPAWN_SPEED_MAX = 6.0;
const SPAWN_SPIN_MIN = 0.02; // rad/tick
const SPAWN_SPIN_MAX = 0.07;

/** Multiply one #rrggbb color by `f`, clamped. */
function darkenHex(hex: string, f: number): string {
  const h = hex.replace("#", "");
  const ch = (i: number) => {
    const v = Math.round(parseInt(h.slice(i, i + 2), 16) * f);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

function darkenSkin(skin: Skin, f: number): Skin {
  return {
    head: darkenHex(skin.head, f),
    rightShoulder: darkenHex(skin.rightShoulder, f),
    leftShoulder: darkenHex(skin.leftShoulder, f),
    rightUpperarm: darkenHex(skin.rightUpperarm, f),
    leftUpperarm: darkenHex(skin.leftUpperarm, f),
    rightForearm: darkenHex(skin.rightForearm, f),
    leftForearm: darkenHex(skin.leftForearm, f),
    rightHand: darkenHex(skin.rightHand, f),
    leftHand: darkenHex(skin.leftHand, f),
    outline: skin.outline, // already black; keep it
  };
}

/**
 * A dead character: rendered like a character (darkened, in the unarmed pose, no
 * gun) but inert. It gets a small random launch + spin on spawn as a death cue,
 * slides to a stop, and collides only with map objects. Bullets ignore bodies
 * because bodies are never added to the bullet target list.
 */
export class Body {
  pos: Vec2;
  vel: Vec2;
  angle: number; // facing, radians
  angularVel: number;
  readonly skin: Skin;

  private constructor(pos: Vec2, angle: number, vel: Vec2, angularVel: number, skin: Skin) {
    this.pos = pos;
    this.angle = angle;
    this.vel = vel;
    this.angularVel = angularVel;
    this.skin = skin;
  }

  /** Spawn a body where a character just died, inheriting its position & facing.
   *  It's flung in the direction of the killing bullet (random if unknown). */
  static fromCharacter(c: Character): Body {
    const speed = SPAWN_SPEED_MIN + Math.random() * (SPAWN_SPEED_MAX - SPAWN_SPEED_MIN);
    const launchDir = c.lastHitDir ?? fromAngle(Math.random() * Math.PI * 2);
    const spin =
      (Math.random() < 0.5 ? -1 : 1) *
      (SPAWN_SPIN_MIN + Math.random() * (SPAWN_SPIN_MAX - SPAWN_SPIN_MIN));
    return new Body(
      { x: c.pos.x, y: c.pos.y },
      angleOf(c.forward),
      scale(launchDir, speed),
      spin,
      darkenSkin(c.skin, DARKEN),
    );
  }

  /** Slide + spin toward rest, pushing out of any solid obstacles. */
  update(obstacles: readonly Obstacle[]): void {
    this.pos = add(this.pos, this.vel);
    this.vel = scale(this.vel, LIN_FRICTION);
    this.angle += this.angularVel;
    this.angularVel *= ANG_FRICTION;
    for (const o of obstacles) this.pos = resolveCircleVsBox(this.pos, BODY_RADIUS, o);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const forward = fromAngle(this.angle);
    const side = perp(forward);
    const grip = (g: { f: number; l: number }): Vec2 =>
      add(this.pos, add(scale(forward, g.f), scale(side, g.l)));
    const right = grip(UNARMED.rightGrip);
    const left = grip(UNARMED.leftGrip);
    // No gun on a corpse: pass a no-op gun drawer.
    drawCharacter(ctx, this.pos, forward, right, left, this.skin, () => {});
  }
}
