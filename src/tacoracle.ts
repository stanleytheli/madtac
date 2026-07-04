/**
 * The TacOracle: an Oracle that fights like a trained soldier instead of a
 * turret on legs. Unlike every other robot it wields its gun *for real* — the
 * spec's damage, a finite magazine with hardcore reloads, and the player's
 * deterministic recoil pattern (no flat-spread EnemyGun wrapper) — and its
 * whole behaviour is about managing that gun:
 *
 *  - Bursts: the trigger stays down only while the spray envelope
 *    `recoilCoef * sqrt(currentRecoil)` is under `burstLimit`. Past that the
 *    shots would be wild anyway, so it stops and lets the pattern reset.
 *  - SHOOT mode: approach over the nav graph exactly like an Oracle until the
 *    target is in sight and inside `engageRange`, then hold ground and fire —
 *    but strafe to a better lane whenever a teammate is in the line of fire
 *    or too little of the target is visible (1-2 of its 5 sample points).
 *  - COVER mode (burst spent, or reloading): strafe to the lateral spot the
 *    opponent can see least of; when everywhere is equally exposed (open
 *    ground, or the opponent is on another level), dodge side to side instead
 *    of standing still. Back to SHOOT once the recoil pattern has reset and
 *    any reload is done. A good cover spot breaks its own sight line, so
 *    walking back out to re-engage falls out of the Oracle graph-chase
 *    naturally: an emergent peek cycle.
 *  - Reaction time keeps all of it human: a hostile must stay in view
 *    reactionTime ticks before it's engaged (Robot.seenFor), and readiness
 *    changes — burst spent, recoil settled, reload started/finished — steer
 *    the mode and the trigger reactionTime late. The one reflex is the burst
 *    cutoff itself: fire stops the instant the envelope is spent, because
 *    spray control is trained, not decided. Semi-auto guns add a per-shot
 *    clicking delay on top of their mechanical fire delay.
 *
 * Strafe candidates sample perpendicular to the opponent line and score one
 * ray per target point: obstacle-blocked 0, teammate in the ray -1 (never
 * trade a friend for a shot — it also holds fire while one is in the line),
 * clear +1. Everything is z-aware: rays only test geometry on the TacOracle's
 * own level, and a candidate spot must be reachable without changing z (a
 * sidestep across a stair midpoint is a level change, not a strafe).
 */
import type { Character } from "./actor.ts";
import { BODY_RADIUS, type Skin } from "./character.ts";
import { hasLineOfSight, segmentIntersectsCircle } from "./collision.ts";
import { walkable } from "./nav.ts";
import { Oracle, type OracleOptions } from "./oracle.ts";
import { targetPoints, type AiContext } from "./robot.ts";
import { areHostile } from "./team.ts";
import { add, dist, norm, perp, scale, sub, vec, type Vec2 } from "./vec.ts";

/** Desert gold with the Oracle lineage's teal right arm. */
export const TAC_ORACLE_SKIN: Skin = {
  head: "#d9a441",
  rightShoulder: "#7a5a20",
  leftShoulder: "#7a5a20",
  rightUpperarm: "#6fc3b9",
  leftUpperarm: "#d9a441",
  rightForearm: "#d9a441",
  leftForearm: "#d9a441",
  rightHand: "#7a5a20",
  leftHand: "#7a5a20",
  outline: "#000000",
};

/** Stop bursting once recoilCoef * sqrt(currentRecoil) exceeds this. ~6 shots
 *  on an M-16 standing still; fewer on harder-kicking guns or while moving. */
const DEFAULT_BURST_LIMIT = 0.6;
/** Default reaction time, ticks (~250ms — a decent human). See
 *  RobotOptions.reactionTime; 0 restores the launch-day inhuman slickness. */
const DEFAULT_REACTION_TIME = 15;
/** Default extra trigger delay per shot on semi-auto guns (clicking, not
 *  holding: the mechanical fire delay alone is an inhuman trigger finger). */
const DEFAULT_SEMI_AUTO_DELAY = 5;
/** In sight and inside this range: stand and fight instead of closing further. */
const DEFAULT_ENGAGE_RANGE = 600;
/** Seeing only this many target points (or fewer) is a bad lane worth strafing out of. */
const LOW_VISIBILITY = 2;
/** Lateral candidate offsets, sampled to both sides of the facing line. Reach
 *  past FRIENDLY_MARGIN's shadow, or a teammate dead in the lane would leave
 *  every near candidate equally blocked and the tie-break saying "stand". */
const STRAFE_OFFSETS = [15, 30, 45, 60, 90, 120];
/** Re-score the candidate spots this often while committed to one. */
const EVAL_TICKS = 10;
/** Dodge rhythm: flip strafing direction every this many ticks (~0.5s). */
const DODGE_TICKS = 30;
/** "Reached the strafe spot" slop, world px. */
const ARRIVE = 2;
/** How wide a berth a firing lane gives teammates. Twice the body: bursts
 *  spray several degrees off the aim line, so grazing a friend's silhouette
 *  with the center line isn't good enough. */
const FRIENDLY_MARGIN = BODY_RADIUS * 2;

export interface TacOracleOptions extends OracleOptions {
  /** Spray-envelope value that ends a burst (see DEFAULT_BURST_LIMIT). */
  burstLimit?: number;
  /** Stop closing on a visible target once within this distance. */
  engageRange?: number;
  /** Extra ticks between shots on semi-auto guns, on top of the gun's fire
   *  delay (simulated trigger clicking). Ignored by full-auto guns. */
  semiAutoDelay?: number;
}

/** One scored lateral spot. `exposed` counts rays not blocked by geometry —
 *  the opponent's view of this spot (a teammate is NOT cover). `clear` counts
 *  rays clear of everything; `score` is firing-lane quality: +1 per clear ray,
 *  -1 per teammate in a ray, 0 per obstacle-blocked ray. */
interface Candidate {
  point: Vec2;
  offset: number;
  exposed: number;
  clear: number;
  score: number;
}

export class TacOracle extends Oracle {
  private readonly burstLimit: number;
  private readonly engageRange: number;
  private readonly semiAutoDelay: number;
  private mode: "shoot" | "cover" = "shoot";
  /** Latched when the envelope crosses burstLimit; cleared when the pattern resets. */
  private burstDone = false;
  /** Reaction-time gating of gun readiness (ready = pattern reset + not
   *  reloading). Stopping fire is reflex (spray control), so `fireOk` drops
   *  the instant readiness is lost — but *resuming* fire, and flipping the
   *  movement mode either way, happen reactionTime after the change. */
  private lastReady = true;
  private reactIn = -1;
  private fireOk = true;
  /** Semi-auto trigger cadence: ticks until the next allowed click. */
  private clickIn = 0;
  /** The lateral spot it's committed to (strafe lane or cover), or null. */
  private strafeTarget: Vec2 | null = null;
  private evalIn = 0;
  /** COVER with an all-tied board (no cover anywhere): dodge instead of hold. */
  private dodging = false;
  private dodgeDir: 1 | -1 = 1;
  private dodgeIn = 0;

  constructor(pos: Vec2, options: TacOracleOptions = {}) {
    super(pos, {
      skin: TAC_ORACLE_SKIN,
      realGun: true,
      reactionTime: DEFAULT_REACTION_TIME,
      ...options,
    });
    this.burstLimit = options.burstLimit ?? DEFAULT_BURST_LIMIT;
    this.engageRange = options.engageRange ?? DEFAULT_ENGAGE_RANGE;
    this.semiAutoDelay = options.semiAutoDelay ?? DEFAULT_SEMI_AUTO_DELAY;
  }

  protected override act(ai: AiContext, target: Character | null): void {
    this.vel = vec(0, 0);
    this.updateMode();
    const chase = target ?? this.nearestHostile(ai);
    if (!chase) return;

    if (this.mode === "cover") {
      this.coverMove(ai, chase);
    } else if (target && dist(this.pos, target.pos) <= this.engageRange) {
      this.strafeMove(ai, target);
    } else {
      // Out of sight (or too far to trade): Oracle graph-chase into range.
      this.strafeTarget = null;
      this.navChase(ai, chase, target);
    }
  }

  /** Burst / reload bookkeeping -> which mode this tick is fought in, with
   *  readiness changes acknowledged reactionTime late (see fireOk). */
  private updateMode(): void {
    const gun = this.gun;
    if (gun.currentRecoil === 0) this.burstDone = false;
    else if (gun.spec.recoilCoef * Math.sqrt(gun.currentRecoil) > this.burstLimit)
      this.burstDone = true;
    // Hardcore reloads bin whatever is left in the mag, so only swap when dry.
    if (gun.mag === 0) gun.startReload(); // no-op mid-reload or out of spares
    if (this.clickIn > 0) this.clickIn -= 1;

    const ready = !this.burstDone && !gun.reloading;
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.reactIn = this.reactionTime;
      if (!ready) this.fireOk = false; // the burst cutoff itself is reflexive
    }
    // A change is acted on only once it has stood for reactionTime (flips
    // faster than that — e.g. a recoil reset quicker than the AI notices —
    // simply never surface, and the countdown restarts above).
    if (this.reactIn >= 0 && --this.reactIn < 0) {
      this.fireOk = this.lastReady;
      const mode = this.lastReady ? "shoot" : "cover";
      if (mode !== this.mode) {
        this.mode = mode;
        this.strafeTarget = null; // the two modes want opposite spots
        this.evalIn = 0;
      }
    }
  }

  /** Fire only mid-burst in SHOOT mode — never near a teammate's line, and on
   *  semi-auto guns only as fast as a trigger finger clicks. */
  protected override shouldFire(ai: AiContext, target: Character | null): boolean {
    if (this.mode !== "shoot" || !this.fireOk || !target) return false;
    if (this.clickIn > 0) return false;
    return !this.teammates(ai, target).some((m) =>
      segmentIntersectsCircle(this.pos, target.pos, m.pos, FRIENDLY_MARGIN),
    );
  }

  /** Semi-auto guns are clicked, not held: each shot re-arms the trigger only
   *  after the fire delay plus the AI's clicking cadence. */
  protected override onFired(): void {
    const f = this.gun.spec.fire;
    if (f && !f.auto) this.clickIn = f.delay + this.semiAutoDelay;
  }

  /** SHOOT, engaged and in sight: hold ground unless the lane is bad — a
   *  teammate in the line of fire, or too few target points visible — then
   *  slide to the best-scoring lateral spot. */
  private strafeMove(ai: AiContext, target: Character): void {
    this.evalIn -= 1;
    if (this.strafeTarget && dist(this.pos, this.strafeTarget) <= ARRIVE) this.strafeTarget = null;
    if (!this.strafeTarget || this.evalIn <= 0) {
      this.evalIn = EVAL_TICKS;
      const cands = this.candidates(ai, target);
      const cur = cands[0];
      const friendInLane = cur.score < cur.clear; // some ray charged a teammate
      if (!friendInLane && cur.clear > LOW_VISIBILITY) {
        this.strafeTarget = null; // lane is good: stand and shoot
      } else {
        let best = cur;
        for (const c of cands) {
          if (c.score > best.score) best = c;
          else if (c.score === best.score && Math.abs(c.offset) < Math.abs(best.offset)) best = c;
        }
        this.strafeTarget = best.offset === 0 ? null : best.point;
      }
    }
    if (this.strafeTarget) this.stepToward(this.strafeTarget);
  }

  /** COVER: get to the lateral spot the opponent sees the least of. When no
   *  spot beats standing here but here is no cover either (an all-tied board),
   *  dodge side to side instead of eating shots flat-footed. */
  private coverMove(ai: AiContext, chase: Character): void {
    this.evalIn -= 1;
    if (this.strafeTarget && dist(this.pos, this.strafeTarget) <= ARRIVE) this.strafeTarget = null;
    if (!this.strafeTarget || this.evalIn <= 0) {
      this.evalIn = EVAL_TICKS;
      const cands = this.candidates(ai, chase);
      const cur = cands[0];
      let best = cur;
      for (const c of cands) {
        if (c.exposed < best.exposed) best = c;
        else if (c.exposed === best.exposed && Math.abs(c.offset) < Math.abs(best.offset)) best = c;
      }
      this.dodging = cands.every((c) => c.exposed === cur.exposed);
      this.strafeTarget = this.dodging || best.offset === 0 ? null : best.point;
    }
    if (this.strafeTarget) {
      this.stepToward(this.strafeTarget);
      return;
    }
    if (!this.dodging) return; // already at the least-exposed spot: hold it
    // Nothing to hide behind: dodge, flipping on the timer or when blocked.
    this.dodgeIn -= 1;
    if (this.dodgeIn <= 0) {
      this.dodgeDir = this.dodgeDir === 1 ? -1 : 1;
      this.dodgeIn = DODGE_TICKS;
    }
    const side = this.sideAxis(chase);
    const step = add(this.pos, scale(side, this.dodgeDir * this.moveSpeed));
    if (!walkable(ai.world, this.pos, this.z, step, this.z)) {
      this.dodgeDir = this.dodgeDir === 1 ? -1 : 1;
      this.dodgeIn = DODGE_TICKS;
      return;
    }
    this.vel = sub(step, this.pos);
    this.pos = step;
  }

  /** Unit vector perpendicular to the line at the opponent — the strafe axis. */
  private sideAxis(opponent: Character): Vec2 {
    const toOpp = sub(opponent.pos, this.pos);
    return dist(this.pos, opponent.pos) > 1e-3 ? perp(norm(toOpp)) : vec(1, 0);
  }

  /** The lateral spots to consider — here (always cands[0]) plus offsets to
   *  both sides — walkability-filtered on this z, each scored vs `opponent`. */
  private candidates(ai: AiContext, opponent: Character): Candidate[] {
    const side = this.sideAxis(opponent);
    const out: Candidate[] = [this.scoreAt(ai, this.pos, 0, opponent)];
    for (const off of STRAFE_OFFSETS) {
      for (const s of [-1, 1]) {
        const point = add(this.pos, scale(side, off * s));
        if (!walkable(ai.world, this.pos, this.z, point, this.z)) continue;
        out.push(this.scoreAt(ai, point, off * s, opponent));
      }
    }
    return out;
  }

  /** Score one spot's firing lane onto the opponent, one ray per target point:
   *  obstacle-blocked 0, teammate in the ray -1, clear +1. All rays live on
   *  this.z, so an opponent on another level scores 0 everywhere. */
  private scoreAt(ai: AiContext, from: Vec2, offset: number, opponent: Character): Candidate {
    let exposed = 0;
    let clear = 0;
    let score = 0;
    if (opponent.z === this.z) {
      const mates = this.teammates(ai, opponent);
      for (const pt of targetPoints(opponent)) {
        if (!hasLineOfSight(from, pt, ai.world.obstacles, this.z)) continue; // geometry: 0
        exposed += 1; // a friend in the ray is a bad lane, but never cover
        if (mates.some((m) => segmentIntersectsCircle(from, pt, m.pos, FRIENDLY_MARGIN))) {
          score -= 1;
        } else {
          clear += 1;
          score += 1;
        }
      }
    }
    return { point: from, offset, exposed, clear, score };
  }

  /** Everyone on this level it must not shoot through (any non-hostile body). */
  private teammates(ai: AiContext, opponent: Character): Character[] {
    return ai.characters.filter(
      (c) =>
        c !== this &&
        c !== opponent &&
        c.hp > 0 &&
        c.z === this.z &&
        !areHostile(this.team, c.team),
    );
  }

  /** One movement tick toward `dest`, recording the step in `vel`. */
  private stepToward(dest: Vec2): void {
    const d = dist(this.pos, dest);
    if (d < 1e-3) return;
    const step = scale(norm(sub(dest, this.pos)), Math.min(this.moveSpeed, d));
    this.vel = step;
    this.pos = add(this.pos, step);
  }
}
