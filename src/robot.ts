import { Character } from "./actor.ts";
import { BODY_RADIUS, type Skin } from "./character.ts";
import { hasLineOfSight } from "./collision.ts";
import { EnemyGun, Gun } from "./gun.ts";
import { M16, UNARMED, type GunSpec } from "./guns.ts";
import type { NavGraph } from "./nav.ts";
import { areHostile, type TeamId } from "./team.ts";
import { angleOf, deg2rad, dist, fromAngle, sub, vec, type Vec2 } from "./vec.ts";
import type { World } from "./world.ts";

/** Everything an AI gets to look at each tick. Built once per tick by main.ts
 *  and shared by every thinking character. */
export interface AiContext {
  world: World;
  characters: readonly Character[];
  /** The level's baked path cache, or null if the level has no nodes. */
  nav: NavGraph | null;
}

/** Flat gray placeholder enemy. */
export const ROBOT_SKIN: Skin = {
  head: "#9aa0a6",
  rightShoulder: "#5f6368",
  leftShoulder: "#5f6368",
  rightUpperarm: "#608dd0",
  leftUpperarm: "#9aa0a6",
  rightForearm: "#9aa0a6",
  leftForearm: "#9aa0a6",
  rightHand: "#5f6368",
  leftHand: "#5f6368",
  outline: "#000000",
};

/** Placeholder "elite" variant — darker, with a red tint. Tweak freely. */
export const ELITE_ROBOT_SKIN: Skin = {
  head: "#6b4a4a",
  rightShoulder: "#3a2a2a",
  leftShoulder: "#3a2a2a",

  rightUpperarm: "#6b4a4a",
  leftUpperarm: "#6b4a4a",
  rightForearm: "#6b4a4a",
  leftForearm: "#6b4a4a",

  rightHand: "#3a2a2a",
  leftHand: "#3a2a2a",
  outline: "#000000",
};

const TURN_GAIN = 0.05; // step grows with angular distance (spec: distance * 0.05)
const TURN_FLOOR_DEG = 2; // ...plus a 1-degree floor so it always closes the gap
const WANDER_MIN = 60; // ticks between idle random turns (~1s)
const WANDER_MAX = 180; // ...up to ~3s

/**
 * Rotate angle `a` toward angle `b` (both radians) the short way around, taking a
 * step that eases down as it closes (so it doesn't snap instantly to target).
 */
export function turnToward(a: number, b: number): number {
  // Signed shortest delta in [-pi, pi]; its sign is sgn(sin(b - a)).
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const distDeg = Math.abs(delta) * (180 / Math.PI);
  const stepDeg = distDeg * TURN_GAIN + TURN_FLOOR_DEG;
  const step = deg2rad(stepDeg) * Math.sign(delta || 1);
  if (Math.abs(step) >= Math.abs(delta)) return b; // clamp: no overshoot / jitter
  return a + step;
}

/** Everything that varies between flavours of Robot. All optional with defaults. */
export interface RobotOptions {
  /** Starting & max health. */
  health?: number;
  /** Flat damage per shot. */
  damage?: number;
  /** Body skin (e.g. ROBOT_SKIN vs ELITE_ROBOT_SKIN). */
  skin?: Skin;
  /** Uniform fire spread, +/- degrees. */
  spreadDeg?: number;
  /** fire rate */
  delay? :number;
  /** Which gun it visibly holds (drives cosmetics; damage/spread/firerate are overridden). */
  gun?: GunSpec;
  /** The z level it stands on (e.g. 1 for a balcony guard, -1 in a bunker). */
  z?: number;
  /** Team allegiance (see team.ts). Decides who it attacks. */
  team?: TeamId;
  /** Wield the gun for real — the spec's damage, a finite magazine with
   *  hardcore reloads, and the skill-based recoil pattern — instead of the
   *  flat-spread, infinite-ammo EnemyGun wrapper. `damage`/`spreadDeg`/`delay`
   *  are ignored. For AIs that manage recoil and ammo themselves (tacoracle.ts). */
  realGun?: boolean;
  /** How slick this AI is, in ticks (60/s): a hostile must stay in view this
   *  long before it's reacted to, and (TacOracle) state changes like "recoil
   *  settled" or "reload done" are acted on this late. 0 = inhumanly instant. */
  reactionTime?: number;
}

const ROBOT_DEFAULTS: Required<RobotOptions> = {
  health: 100,
  damage: 10,
  skin: ROBOT_SKIN,
  spreadDeg: 15,
  delay: 10,
  gun: M16,
  z: 0,
  team: "enemy",
  realGun: false,
  reactionTime: 0,
};

/**
 * A minimal hostile NPC: stands in place, sweeps its aim, and opens fire with a
 * sloppy spread the instant it can see any part of a character on a team it's
 * hostile to. It turns smoothly (never instantly) toward whatever it's tracking.
 * Parametrized so we can build all kinds of robots (tanky/elite/different
 * guns/etc.), and subclassed for mobile AIs (see oracle.ts) via the `act` hook.
 */
export class Robot extends Character {
  protected angle: number;
  /** Ticks since a hostile was last in sight (Infinity = never). Subclasses use
   *  it to decide how long to hold the last combat aim after losing sight. */
  protected ticksSinceTarget = Infinity;
  /** See RobotOptions.reactionTime. */
  protected readonly reactionTime: number;
  /** Sight-acquisition clock: counts up (to reactionTime) while a hostile is
   *  in view, and decays — rather than resetting — while none is, so a
   *  one-tick blink around a corner doesn't restart the clock but a
   *  long-hidden target must be re-acquired from scratch. */
  private seenFor = 0;
  private alerted = false;
  private wanderTarget: number;
  private wanderTimer = 0;

  constructor(pos: Vec2, options: RobotOptions = {}) {
    const opts = { ...ROBOT_DEFAULTS, ...options };
    super(pos, opts.skin, {
      primary: opts.realGun
        ? new Gun(opts.gun)
        : new EnemyGun(opts.gun, { damage: opts.damage, spreadDeg: opts.spreadDeg, delay: opts.delay }),
      hand: new Gun(UNARMED),
    });
    this.maxHp = opts.health;
    this.hp = opts.health;
    this.z = opts.z;
    this.team = opts.team;
    this.reactionTime = opts.reactionTime;
    this.angle = Math.random() * Math.PI * 2;
    this.wanderTarget = this.angle;
    this.forward = fromAngle(this.angle);
  }

  /** Per-tick AI. Call after `tickWeapon()` so the fire cooldown is up to date. */
  think(ai: AiContext): void {
    // Sight is per-level: a balcony guard ignores (and can't hit) a ground-level
    // target, and vice versa, until they share a z.
    const spotted = this.nearestVisibleHostile(ai);
    // ...and reaction-gated: a hostile only becomes the target after staying
    // in view for reactionTime ticks (see seenFor).
    this.seenFor = spotted
      ? Math.min(this.seenFor + 1, this.reactionTime)
      : Math.max(this.seenFor - 1, 0);
    const target = spotted && this.seenFor >= this.reactionTime ? spotted : null;

    if (target) {
      // Track and shoot.
      this.alerted = true;
      this.ticksSinceTarget = 0;
      this.angle = turnToward(this.angle, angleOf(sub(target.pos, this.pos)));
    } else if (!this.alerted) {
      // Never spotted anyone: idly turn to a new random heading now and then.
      if (this.wanderTimer <= 0) {
        this.wanderTarget = Math.random() * Math.PI * 2;
        this.wanderTimer = WANDER_MIN + Math.floor(Math.random() * (WANDER_MAX - WANDER_MIN));
      }
      this.wanderTimer -= 1;
      this.angle = turnToward(this.angle, this.wanderTarget);
    }
    // else: has seen a target but lost sight -> hold angle, "on alert".

    if (!target) this.ticksSinceTarget += 1; // Infinity stays Infinity

    this.act(ai, target);

    this.forward = fromAngle(this.angle);

    if (this.shouldFire(ai, target) && this.fire(ai.world)) this.onFired();
  }

  /** Subclass hook: hold the trigger this tick? The base Robot fires whenever
   *  a target is in sight; burst-firing AIs (TacOracle) override. */
  protected shouldFire(_ai: AiContext, target: Character | null): boolean {
    return target !== null;
  }

  /** Subclass hook: a shot actually went out this tick (the trigger pull beat
   *  the cooldown). Trigger-cadence AIs (TacOracle's semi-auto clicking) use it. */
  protected onFired(): void {}

  /** Subclass hook, called every think tick after aiming and before firing.
   *  `target` is the hostile currently in sight (null = none). The base Robot
   *  stands still; movers (Oracle) override this. */
  protected act(_ai: AiContext, _target: Character | null): void {}

  /** The living hostiles this character wants dead, per the team registry. */
  protected hostiles(ai: AiContext): Character[] {
    return ai.characters.filter(
      (c) => c !== this && c.hp > 0 && areHostile(this.team, c.team),
    );
  }

  /** The closest hostile on this character's own z that it can actually see. */
  protected nearestVisibleHostile(ai: AiContext): Character | null {
    let best: Character | null = null;
    let bestD = Infinity;
    for (const c of this.hostiles(ai)) {
      if (c.z !== this.z) continue;
      const d = dist(this.pos, c.pos);
      if (d >= bestD) continue;
      if (!this.canSee(ai.world, c)) continue;
      best = c;
      bestD = d;
    }
    return best;
  }

  /** The closest hostile anywhere — any z, seen or not (for chasing AIs). */
  protected nearestHostile(ai: AiContext): Character | null {
    let best: Character | null = null;
    let bestD = Infinity;
    for (const c of this.hostiles(ai)) {
      const d = dist(this.pos, c.pos);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  /** Sees the target if any of its sample points has a clear ray. */
  protected canSee(world: World, target: Character): boolean {
    return this.visibility(world, target) > 0;
  }

  /** How exposed the target is from here: the number of its sample points
   *  (0..5, see targetPoints) with an unobstructed ray on this character's
   *  level. 0 = fully hidden, 5 = fully in the open. */
  protected visibility(world: World, target: Character): number {
    let seen = 0;
    for (const pt of targetPoints(target)) {
      if (hasLineOfSight(this.pos, pt, world.obstacles, this.z)) seen += 1;
    }
    return seen;
  }
}

/** The sample points sight and exposure checks ray against: the target's
 *  center plus the four corners of its bounding box. Seeing any one of them
 *  means seeing the target; how many are seen measures partial cover. */
export function targetPoints(target: Character): Vec2[] {
  const r = BODY_RADIUS;
  const p = target.pos;
  return [
    p,
    vec(p.x - r, p.y - r),
    vec(p.x + r, p.y - r),
    vec(p.x - r, p.y + r),
    vec(p.x + r, p.y + r),
  ];
}
