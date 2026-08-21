import { Character } from "../entities/actor.ts";
import { BODY_RADIUS, type Skin } from "../entities/character.ts";
import { EnemyGun, Gun } from "../entities/gun.ts";
import { M16, UNARMED, type GunSpec } from "../entities/guns.ts";
import type { NavGraph } from "../world/nav.ts";
import { profiler } from "../engine/profiler.ts";
import { areHostile, type TeamId } from "../entities/team.ts";
import { add, angleOf, deg2rad, dist, fromAngle, sub, vec, type Vec2 } from "../engine/vec.ts";
import { losClear, shotClear, wallbangSightBudget, type World } from "../world/world.ts";

/** A gamemode objective an AI can be steered toward (a domination capture point):
 *  its location + who controls it ("gray" = neutral) so AIs prefer un-held ones. */
export interface ObjectivePoint {
  pos: Vec2;
  z: number;
  radius: number;
  /** Controlling team ("gray" if progress < 1) — objective AIs prefer un-held. */
  owner: string;
  /** Progress in [0,2] (2 = fully locked in) — used to tell "ours but not yet
   *  fully strengthened" (still worth standing on) from "done". */
  progress: number;
}

/** Everything an AI gets to look at each tick. Built once per tick by main.ts
 *  and shared by every thinking character. */
export interface AiContext {
  world: World;
  characters: readonly Character[];
  /** The level's baked path cache, or null if the level has no nodes. */
  nav: NavGraph | null;
  /** The current sim tick — AIs use it to stagger their planning (see stagger). */
  tick: number;
  /** Gamemode objectives (domination points), or undefined for modes without
   *  them; objective-seeking AIs (DominationOracle) steer toward these. */
  objectives?: readonly ObjectivePoint[];
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
/** How often the aim jitter offset is re-drawn while tracking one opponent
 *  (ticks). Switching targets re-draws immediately (a fresh flick). */
const AIM_RESAMPLE_TICKS = 20;

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
  /** Re-plan (the expensive target scan + movement decision) only once every
   *  this many ticks, phase-offset per instance so a squad spreads its thinking
   *  across ticks instead of all recomputing the same frame. Aiming, movement
   *  continuation, and firing still run every tick, so combat stays smooth.
   *  1 = plan every tick. */
  stagger?: number;
  /** Aim jitter: the AI aims at a point drawn from N(target, aimSigma^2 * I) in
   *  world px (resampled per plan tick), so it misses more up close than far —
   *  like mouse wobble. 0 = pixel-perfect (the default for plain robots). */
  aimSigma?: number;
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
  stagger: 1,
  aimSigma: 0,
};

/**
 * A minimal hostile NPC: stands in place, sweeps its aim, and opens fire with a
 * sloppy spread the instant it can see any part of a character on a team it's
 * hostile to. It turns smoothly (never instantly) toward whatever it's tracking.
 * Parametrized so we can build all kinds of robots (tanky/elite/different
 * guns/etc.), and subclassed for mobile AIs (see oracle.ts) via the `act` hook.
 */
export class Robot extends Character {
  /** Monotonic source of round-robin plan-tick phases (see thinkPhase). */
  private static nextPhase = 0;
  /** Actual heading (radians), eased toward `aimAngle` every tick in think(). */
  protected angle: number;
  /** Desired heading, chosen during planning (target dir / wander / nav facing);
   *  think() interpolates `angle` toward it so turning is smooth between plans. */
  protected aimAngle: number;
  /** Ticks since a hostile was last in sight (Infinity = never). Subclasses use
   *  it to decide how long to hold the last combat aim after losing sight. */
  protected ticksSinceTarget = Infinity;
  /** See RobotOptions.reactionTime. */
  protected readonly reactionTime: number;
  /** See RobotOptions.stagger (>= 1). */
  protected readonly stagger: number;
  /** Per-instance plan-tick phase. Assigned round-robin from a global counter
   *  (not random) so successive robots land in successive stagger slots — the
   *  plan load spreads evenly across ticks instead of clumping. */
  private readonly thinkPhase = Robot.nextPhase++;
  /** The target from the last plan tick, aimed at + fired on between plans. */
  protected lastTarget: Character | null = null;
  /** Gaussian aim offset in world px (see RobotOptions.aimSigma), held between
   *  re-draws; `aimResampleAt` is the tick the next re-draw is due. */
  protected aimError: Vec2 = vec(0, 0);
  private aimResampleAt = 0;
  private readonly aimSigma: number;
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
    this.stagger = Math.max(1, Math.floor(opts.stagger));
    this.aimSigma = opts.aimSigma;
    this.angle = Math.random() * Math.PI * 2;
    this.aimAngle = this.angle;
    this.wanderTarget = this.angle;
    this.forward = fromAngle(this.angle);
  }

  /** Per-tick AI. Call after `tickWeapon()` so the fire cooldown is up to date. */
  think(ai: AiContext): void {
    // Expensive planning (target scan + movement decision) runs only on this
    // AI's plan ticks; between them it coasts (cheap continuation). Aiming and
    // firing below run every tick regardless, so DPS and tracking stay smooth.
    if (this.stagger <= 1 || (ai.tick + this.thinkPhase) % this.stagger === 0) {
      this.decide(ai);
    } else {
      this.coast(ai);
    }

    // Continuous steering applied every tick on top of the planned move (e.g.
    // crowd separation), so it runs regardless of which movement branch ran.
    this.postMove(ai);

    // Staircase climb slowdown for the step just taken (no-op off stairs). Before
    // aiming/firing, so the recoil speed reads the scaled velocity — same order
    // the player gets (move() then fire). onStairs is set by the session.
    this.applyStairMove();
    this.applyStaggerMove(); // movement stagger from a staggering hit (no-op otherwise)

    // Aim & fire run EVERY tick (not just plan ticks). Planning only picks the
    // *desired* heading (aimAngle); the actual heading eases toward it here, so
    // turning stays smooth at 60 Hz regardless of stagger — no thinking, just
    // interpolation. A live target is tracked directly (pure geometry).
    const target = this.lastTarget && this.lastTarget.hp > 0 ? this.lastTarget : null;
    // Aim at the (jittered) point, not the exact target — aimError is a per-plan
    // Gaussian offset in world units, so the miss is bigger up close than far.
    if (target) this.aimAngle = angleOf(sub(add(target.pos, this.aimError), this.pos));
    this.angle = turnToward(this.angle, this.aimAngle);
    this.forward = fromAngle(this.angle);

    if (this.shouldFire(ai, target) && this.fire(ai.world)) this.onFired();
  }

  /** The full, expensive decision — acquire a target, aim at it, and act. Runs
   *  on plan ticks only; the sight/alert clocks advance by `stagger` so their
   *  tick-denominated tuning (reactionTime, aim hold, focus memory) still tracks
   *  real time. */
  private decide(ai: AiContext): void {
    const gain = this.stagger;
    // Sight is per-level: a balcony guard ignores (and can't hit) a ground-level
    // target, and vice versa, until they share a z.
    const spotted = profiler.measure("ai.select", () => this.selectTarget(ai));
    // ...and reaction-gated: a hostile only becomes the target after staying
    // in view for reactionTime ticks (see seenFor).
    this.seenFor = spotted
      ? Math.min(this.seenFor + gain, this.reactionTime)
      : Math.max(this.seenFor - gain, 0);
    const target = spotted && this.seenFor >= this.reactionTime ? spotted : null;

    // Aim jitter: hold a fixed offset, re-drawing only on a slow timer or the
    // moment we switch which opponent we're aiming at (a fresh flick). Zero it
    // with no target so a held/lost-sight aim doesn't drift.
    if (!target || this.aimSigma <= 0) {
      this.aimError = vec(0, 0);
    } else if (target !== this.lastTarget || ai.tick >= this.aimResampleAt) {
      this.aimError = this.sampleAimError();
      this.aimResampleAt = ai.tick + AIM_RESAMPLE_TICKS;
    }

    if (target) {
      // Track and shoot — think() eases the heading toward the target each tick.
      this.alerted = true;
      this.ticksSinceTarget = 0;
    } else if (!this.alerted && this.speed < 1e-3) {
      // Never spotted anyone and standing still: idly turn to a new random
      // heading now and then. (While walking, movement owns the facing — see
      // Oracle.navChase — and wander would fight it tug-of-war.)
      if (this.wanderTimer <= 0) {
        this.wanderTarget = Math.random() * Math.PI * 2;
        this.wanderTimer = WANDER_MIN + Math.floor(Math.random() * (WANDER_MAX - WANDER_MIN));
      }
      this.wanderTimer -= 1;
      this.aimAngle = this.wanderTarget;
    }
    // else: has seen a target but lost sight -> hold aimAngle, "on alert".

    if (!target) this.ticksSinceTarget += gain; // Infinity stays Infinity

    profiler.measure("ai.act", () => this.act(ai, target));
    this.lastTarget = target;
  }

  /** Between plan ticks: cheap continuation of the last plan. The base Robot is
   *  stationary so there's nothing to do; movers override this to keep walking. */
  protected coast(_ai: AiContext): void {}

  /** Called every tick after act/coast, before aiming — for continuous steering
   *  applied on top of the planned move (crowd separation, etc.). No-op by default. */
  protected postMove(_ai: AiContext): void {}

  /** An isotropic 2D Gaussian offset with stddev `aimSigma` (Box–Muller). */
  private sampleAimError(): Vec2 {
    const r = this.aimSigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, Math.random())));
    const a = 2 * Math.PI * Math.random();
    return vec(r * Math.cos(a), r * Math.sin(a));
  }

  /** Subclass hook: which visible hostile to engage. The base Robot takes the
   *  physically closest; smarter AIs (TacOracle) weigh how quickly each could
   *  actually be shot. */
  protected selectTarget(ai: AiContext): Character | null {
    return this.nearestVisibleHostile(ai);
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

  /**
   * How exposed the target is from here: the number of its sample points
   * (0..5, see targetPoints) this character can put a round through, on its own
   * level. 0 = fully hidden, 5 = fully in the open.
   *
   * "Can put a round through", not "can see": a weapon with a penetration budget
   * counts a point it could shoot through a thin wall (see shotClear), because a
   * bot that refuses to engage what its own bullets would go through is reading
   * the map differently from the way the sim resolves it. A weapon with no budget
   * — every gun until one is given a rating, and the shotguns and fists forever —
   * asks the plain sight question, unchanged.
   */
  protected visibility(world: World, target: Character): number {
    const budget = this.wallbangBudget;
    let seen = 0;
    for (const pt of targetPoints(target)) {
      if (budget > 0
        ? shotClear(world, this.pos, pt, this.z, budget)
        : losClear(world, this.pos, pt, this.z)) seen += 1;
    }
    return seen;
  }

  /** px of wall the weapon in hand can punch through and still be WORTH shooting
   *  through — the gun's rating, cut down to what leaves the round enough damage
   *  to matter (see wallbangSightBudget). 0 for anything that can't penetrate,
   *  which is the pre-wallbang behaviour exactly. */
  protected get wallbangBudget(): number {
    return wallbangSightBudget(this.gun.spec.penetration ?? 0);
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
