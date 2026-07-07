/**
 * The TacOracle: an Oracle that fights like a trained soldier instead of a
 * turret on legs. Unlike every other robot it wields its gun *for real* — the
 * spec's damage, a finite magazine with hardcore reloads, and the player's
 * deterministic recoil pattern (no flat-spread EnemyGun wrapper) — and its
 * whole behaviour is about managing that gun:
 *
 *  - Bursts: the trigger stays down only while the spray envelope
 *    `recoilCoef^2 * sqrt(currentRecoil)` — the radian upper bound of the
 *    pattern offset — stays inside the target's angular width at its range,
 *    `lambda * BODY_RADIUS / (pi * distance)`. Approximating the pattern's
 *    sin() as uniform on [-1, 1], 1/lambda is the per-shot hit probability at
 *    the cutoff, so bursts are naturally range-dependent: long dumps up
 *    close, disciplined taps at distance.
 *  - Guns that punish moving (movePenalty >= 2, e.g. rifles) are fired from a
 *    stand: while actively mid-burst it holds position, and repositioning
 *    (strafes, approaches) happens between bursts — accuracy outranks motion.
 *    Low-penalty guns keep shooting on the move.
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
 *  - Targeting is cost-based, not distance-based: among visible hostiles it
 *    locks the one it could shoot *soonest* — the walk to the nearest strafe
 *    point with a clear friendly-free lane (selectTarget/shootCost) — and when
 *    nobody is in sight it chases whoever is cheapest to reach over the nav
 *    graph, not whoever is nearest through a wall (bestChase).
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
import type { Character } from "../entities/actor.ts";
import { BODY_RADIUS, type Skin } from "../entities/character.ts";
import { walkable, zAt } from "../world/nav.ts";
import { Oracle, type OracleOptions } from "./oracle.ts";
import { profiler } from "../engine/profiler.ts";
import { targetPoints, type AiContext } from "./robot.ts";
import { areHostile } from "../entities/team.ts";
import { add, angleOf, deg2rad, dist, norm, perp, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import { losClear } from "../world/world.ts";

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

/** Burst-discipline aim budget: keep the spray envelope inside lambda x the
 *  target's angular width — i.e. ~1/lambda per-shot hit odds at the cutoff
 *  (see the header). Bigger lambda = longer, braver bursts. */
const DEFAULT_LAMBDA = 5;
/** Guns whose movePenalty is at least this are fired standing still. */
const STAND_TO_SHOOT_PENALTY = 2.0;
/** Aim-settle floor: the trigger waits until the muzzle is within the aim
 *  budget of the target (or this, whichever is looser) — no spraying while
 *  the turn-toward swing is still carrying the gun onto them. */
const MIN_AIM_TOLERANCE = deg2rad(15);
/** Default reaction time, ticks (~250ms — a decent human). See
 *  RobotOptions.reactionTime; 0 restores the launch-day inhuman slickness. */
const DEFAULT_REACTION_TIME = 15;
/** Default plan cadence (ticks between full re-plans; see RobotOptions.stagger).
 *  5 ≈ 12 plans/s — cheap, and firing/aiming/movement still run every tick. */
const DEFAULT_STAGGER = 5;
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
/** Forward/back candidate distances along the opponent line. Stepping toward or
 *  away can cross a stair midpoint and drop z — valid cover (breaks LoS) even
 *  when there's nothing lateral to hide behind. Used for cover, not firing. */
const AXIAL_OFFSETS = [40, 90];
/** Re-score the candidate spots this often while committed to one. */
const EVAL_TICKS = 10;
/** Dodge rhythm: flip strafing direction every this many ticks (~0.5s). */
const DODGE_TICKS = 30;
/** "Reached the strafe spot" slop, world px. */
const ARRIVE = 2;
/** Re-run target selection this often while the current pick stays valid. */
const TARGET_EVAL_TICKS = 10;
/** shootCost surcharge for a lane that's shootable but poor (1-2 points):
 *  as bad as walking half the strafe fan to a clean one. */
const LOW_VIS_PENALTY = 60;
/** shootCost for a hostile with no lane from any local point: worse than any
 *  amount of strafing (max 120 + 60), so anyone shootable in place wins. */
const NO_LANE_COST = 400;
/** Weight on raw distance-to-target in target selection, added to shootCost
 *  (which measures cost-to-first-shot). Breaks ties toward the closer enemy so
 *  the AI doesn't fixate on a far but easily-shot one. */
const BETA_DIST = 0.35;
/** Cost edge a challenger needs over the current focus — don't flip-flop
 *  between two near-equal targets every re-evaluation. */
const FOCUS_STICKINESS = 30;
/** Ticks without sight of anyone before the remembered focus is dropped and
 *  navigation goes back to "whoever is quickest to reach". */
const FOCUS_MEMORY = 120;
/** Re-run the blind-chase pick this often (matches the Oracle's replan beat). */
const CHASE_EVAL_TICKS = 30;
/** How wide a berth a firing lane gives teammates. Twice the body: bursts
 *  spray several degrees off the aim line, so grazing a friend's silhouette
 *  with the center line isn't good enough. */
const FRIENDLY_MARGIN = BODY_RADIUS * 2;
/** Anti-conga: how far ahead to look for a tailgated teammate while routing, and
 *  how close to the travel line counts as "in front". */
const CROWD_DIST = BODY_RADIUS * 2.2;
const CROWD_MARGIN = BODY_RADIUS * 1.3;

/** Is teammate `mate` downrange of a shot from `from` at `to` — in front of the
 *  muzzle (not behind it) and within `margin` of the line? Unlike a capsule test
 *  (segmentIntersectsCircle, which caps at the endpoints) this ignores anyone
 *  behind the shooter, so a squadmate hugging your back never vetoes the shot —
 *  the bug that stalled stacked teammates into a mutual "no one fires" standoff. */
function friendInLine(from: Vec2, to: Vec2, mate: Vec2, margin: number): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return false;
  const t = ((mate.x - from.x) * dx + (mate.y - from.y) * dy) / len2;
  if (t <= 0 || t >= 1) return false; // behind the muzzle, or beyond the target
  const ex = mate.x - (from.x + dx * t);
  const ey = mate.y - (from.y + dy * t);
  return ex * ex + ey * ey < margin * margin;
}

export interface TacOracleOptions extends OracleOptions {
  /** Burst-discipline aim budget (see DEFAULT_LAMBDA). */
  lambda?: number;
  /** Stop closing on a visible target once within this distance. */
  engageRange?: number;
  /** Extra ticks between shots on semi-auto guns, on top of the gun's fire
   *  delay (simulated trigger clicking). Ignored by full-auto guns. */
  semiAutoDelay?: number;
  /** Lateral strafe/cover candidate offsets (see STRAFE_OFFSETS). A richer set
   *  = more thorough lane exploration; used to scale the AI's skill. */
  strafeOffsets?: number[];
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
  /** The level this spot resolves to (a fwd/back step may cross a stair). A
   *  cross-z spot is cover but not a firing spot — strafeMove ignores it. */
  z: number;
}

export class TacOracle extends Oracle {
  private readonly lambda: number;
  private readonly engageRange: number;
  private readonly semiAutoDelay: number;
  private readonly strafeOffsets: number[];
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
  /** The hostile it's currently locked onto (kept across short sight losses —
   *  see FOCUS_MEMORY), and the reselection timer. */
  private focus: Character | null = null;
  private targetEvalIn = 0;
  /** Cached route-nearest hostile for blind navigation (see bestChase). */
  private chaseCache: Character | null = null;
  private chaseEvalIn = 0;
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
      stagger: DEFAULT_STAGGER,
      ...options,
    });
    this.lambda = options.lambda ?? DEFAULT_LAMBDA;
    this.engageRange = options.engageRange ?? DEFAULT_ENGAGE_RANGE;
    this.semiAutoDelay = options.semiAutoDelay ?? DEFAULT_SEMI_AUTO_DELAY;
    this.strafeOffsets = options.strafeOffsets ?? STRAFE_OFFSETS;
  }

  protected override act(ai: AiContext, target: Character | null): void {
    this.vel = vec(0, 0);
    if (this.focus && (this.focus.hp <= 0 || this.ticksSinceTarget > FOCUS_MEMORY)) {
      this.focus = null;
    }
    this.updateMode(target ?? this.focus);
    // Out of sight, the last engaged enemy stays the concern (cover is scored
    // against them, the chase heads back at them) until memory lapses.
    const chase = target ?? this.focus ?? this.bestChase(ai);
    if (!chase) return;

    // Heavy-penalty guns are fired from a stand: while actively mid-burst
    // (would fire now or is between semi-auto clicks), hold position and let
    // strafes/approaches happen between bursts. vel is already zeroed.
    if (
      target &&
      this.mode === "shoot" &&
      this.fireOk &&
      !this.burstDone &&
      this.gun.spec.movePenalty >= STAND_TO_SHOOT_PENALTY &&
      this.laneClear(ai, target)
    ) {
      return;
    }

    if (this.mode === "cover") {
      this.coverMove(ai, chase);
    } else if (target && dist(this.pos, target.pos) <= this.engageRange) {
      this.strafeMove(ai, target);
    } else {
      // Out of sight (or too far to trade): Oracle graph-chase into range —
      // but peel aside first if tailgating a squadmate (breaks conga lines).
      this.strafeTarget = null;
      const blocker = this.blockingMate(ai, chase);
      if (blocker) this.sidestep(ai, chase, blocker);
      else this.navChase(ai, chase, target);
    }
  }

  /** Between plan ticks (stagger): keep the gun's burst/reload/click bookkeeping
   *  live every tick — otherwise firing would stall — and continue the committed
   *  move (walk toward the strafe/cover spot, or coast the graph chase) without
   *  any candidate rescoring or path query. */
  protected override coast(ai: AiContext): void {
    this.vel = vec(0, 0);
    const target = this.lastTarget && this.lastTarget.hp > 0 ? this.lastTarget : null;
    this.updateMode(target ?? this.focus);
    // Mirror act's stand-to-shoot hold so a heavy gunner doesn't creep mid-burst.
    if (
      target &&
      this.mode === "shoot" &&
      this.fireOk &&
      !this.burstDone &&
      this.gun.spec.movePenalty >= STAND_TO_SHOOT_PENALTY &&
      this.laneClear(ai, target)
    ) {
      return;
    }
    if (this.strafeTarget) {
      this.stepToward(this.strafeTarget);
      return;
    }
    // Keep spacing between plan ticks too: peel aside if tailgating.
    const chase = target ?? this.focus;
    const blocker = chase ? this.blockingMate(ai, chase) : null;
    if (chase && blocker) this.sidestep(ai, chase, blocker);
    else this.coastStep(ai); // continue the committed graph chase
  }

  /** Burst / reload bookkeeping -> which mode this tick is fought in, with
   *  readiness changes acknowledged reactionTime late (see fireOk). `ref` is
   *  whoever the spray is being judged against (target, or remembered focus). */
  private updateMode(ref: Character | null): void {
    const gun = this.gun;
    if (gun.currentRecoil === 0) this.burstDone = false;
    else if (ref) {
      // Spray envelope (radians) vs the body's angular width at this range:
      // past that, the expected per-shot hit odds drop under 1/lambda.
      const envelope = gun.spec.recoilCoef ** 2 * Math.sqrt(gun.currentRecoil);
      if (envelope > this.aimWidth(dist(this.pos, ref.pos))) this.burstDone = true;
    }
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

  /** The angular width a body at range `d` subtends for burst discipline,
   *  scaled by lambda (see DEFAULT_LAMBDA). */
  private aimWidth(d: number): number {
    return (this.lambda * BODY_RADIUS) / (Math.PI * Math.max(d, 1));
  }

  /** No teammate downrange within FRIENDLY_MARGIN of the line of fire at `target`
   *  (teammates behind the muzzle don't count — see friendInLine). */
  private laneClear(ai: AiContext, target: Character): boolean {
    return !this.teammates(ai, target).some((m) =>
      friendInLine(this.pos, target.pos, m.pos, FRIENDLY_MARGIN),
    );
  }

  /** Fire only mid-burst in SHOOT mode, with the muzzle settled on the target
   *  — never near a teammate's line, and on semi-auto guns only as fast as a
   *  trigger finger clicks. */
  protected override shouldFire(ai: AiContext, target: Character | null): boolean {
    if (this.mode !== "shoot" || !this.fireOk || !target) return false;
    if (this.clickIn > 0) return false;
    // Gate against the jittered aim point (where the muzzle actually points), so
    // the trigger agrees with the aim — otherwise it'd fire the instant it's dead
    // on the true target while the muzzle is off by aimError.
    const aim = add(target.pos, this.aimError);
    const d = dist(this.pos, aim);
    let aimErr = Math.abs(angleOf(this.forward) - angleOf(sub(aim, this.pos)));
    if (aimErr > Math.PI) aimErr = 2 * Math.PI - aimErr;
    if (aimErr > Math.max(this.aimWidth(d), MIN_AIM_TOLERANCE)) return false;
    return this.laneClear(ai, target);
  }

  /** Semi-auto guns are clicked, not held: each shot re-arms the trigger only
   *  after the fire delay plus the AI's clicking cadence. */
  protected override onFired(): void {
    const f = this.gun.spec.fire;
    if (f && !f.auto) this.clickIn = f.delay + this.semiAutoDelay;
  }

  /** Not the physically closest hostile — the one that can be shot soonest:
   *  each visible hostile is costed by the walk to the nearest of its strafe
   *  points with a shootable lane (see shootCost), with hysteresis so two
   *  near-equal targets don't trade the lock every re-evaluation. */
  protected override selectTarget(ai: AiContext): Character | null {
    this.targetEvalIn -= 1;
    const valid =
      this.focus !== null &&
      this.focus.hp > 0 &&
      this.focus.z === this.z &&
      this.canSee(ai.world, this.focus);
    if (valid && this.targetEvalIn > 0) return this.focus;
    this.targetEvalIn = TARGET_EVAL_TICKS;

    let best: Character | null = null;
    let bestCost = Infinity;
    for (const h of this.hostiles(ai)) {
      if (h.z !== this.z || !this.canSee(ai.world, h)) continue;
      let cost = this.shootCost(ai, h) + BETA_DIST * dist(this.pos, h.pos);
      if (h === this.focus) cost -= FOCUS_STICKINESS;
      if (cost < bestCost) {
        best = h;
        bestCost = cost;
      }
    }
    if (best) this.focus = best; // keep remembering the old focus while blind
    return best;
  }

  /** How quickly `h` could be shot from here, as a distance: the nearest local
   *  movement point (current spot or a strafe candidate) whose lane onto `h`
   *  is clear of friends, plus a surcharge if that lane is poor. No lane from
   *  anywhere local -> a big constant + range, so it sorts behind every
   *  shootable-in-place hostile but still orders the hopeless ones by range. */
  private shootCost(ai: AiContext, h: Character): number {
    let cost = Infinity;
    for (const c of this.candidates(ai, h)) {
      if (c.clear === 0 || c.score < c.clear) continue; // hidden, or a friend in the lane
      const poorLane = c.clear <= LOW_VISIBILITY ? LOW_VIS_PENALTY : 0;
      cost = Math.min(cost, Math.abs(c.offset) + poorLane);
    }
    return cost === Infinity ? NO_LANE_COST + dist(this.pos, h.pos) : cost;
  }

  /** Blind navigation target: the hostile reachable-and-shootable soonest by
   *  the graph — route distance to the node that sees them — instead of raw
   *  straight-line distance (which happily picks someone behind a wall on
   *  another floor). Cached: routes are table lookups but nearestInSight isn't. */
  private bestChase(ai: AiContext): Character | null {
    this.chaseEvalIn -= 1;
    if (this.chaseCache && this.chaseCache.hp > 0 && this.chaseEvalIn > 0) return this.chaseCache;
    this.chaseEvalIn = CHASE_EVAL_TICKS;

    const nav = ai.nav;
    const curr = nav && nav.nodes.length > 0 ? nav.nearestWalkable(ai.world, this.pos, this.z) : -1;
    let best: Character | null = null;
    let bestCost = Infinity;
    for (const h of this.hostiles(ai)) {
      let cost: number;
      if (h.z === this.z && this.canSee(ai.world, h)) {
        cost = dist(this.pos, h.pos); // already in sight: cost is just range
      } else if (nav && curr >= 0) {
        const goal = nav.nearestInSight(ai.world, h.pos, h.z);
        const step = goal >= 0 ? nav.route(curr, goal) : null;
        cost = step
          ? dist(this.pos, nav.nodes[curr].pos) + step.dist + dist(nav.nodes[goal].pos, h.pos)
          : Infinity;
      } else {
        cost = dist(this.pos, h.pos); // no graph: straight line is all there is
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = h;
      }
    }
    this.chaseCache = best ?? this.nearestHostile(ai); // everyone unreachable: walk at the closest
    return this.chaseCache;
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
        // Firing spots only: a cross-z (cover) candidate can't shoot from there.
        let best = cur;
        for (const c of cands) {
          if (c.z !== this.z) continue;
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

  /** The nearest squadmate directly ahead on the way to `chase` (within a short
   *  lookahead of the travel line), or null. Reuses the anti-friendly-fire lane
   *  test so followers don't tailgate into conga lines while routing. */
  private blockingMate(ai: AiContext, chase: Character): Character | null {
    const to = sub(chase.pos, this.pos);
    const len = Math.hypot(to.x, to.y);
    if (len < 1e-3) return null;
    const probe = add(this.pos, scale(to, CROWD_DIST / len));
    let best: Character | null = null;
    let bestD = Infinity;
    for (const m of this.teammates(ai, chase)) {
      if (!friendInLine(this.pos, probe, m.pos, CROWD_MARGIN)) continue;
      const d = dist(this.pos, m.pos);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** One lateral tick around `blocker` (toward the side it isn't on) instead of
   *  tailgating it toward `chase`. Falls back to the other side if walled in. */
  private sidestep(ai: AiContext, chase: Character, blocker: Character): void {
    const to = sub(chase.pos, this.pos);
    const dir = dist(this.pos, chase.pos) > 1e-3 ? norm(to) : vec(1, 0);
    const side = perp(dir);
    const rel = sub(blocker.pos, this.pos);
    const away = dir.x * rel.y - dir.y * rel.x > 0 ? -1 : 1; // step off the blocker's side
    for (const s of [away, -away]) {
      const step = add(this.pos, scale(side, s * this.moveSpeed));
      if (walkable(ai.world, this.pos, this.z, step, this.z)) {
        this.vel = sub(step, this.pos);
        this.pos = step;
        return;
      }
    }
  }

  /** The lateral spots to consider — here (always cands[0]) plus offsets to
   *  both sides — walkability-filtered on this z, each scored vs `opponent`. */
  private candidates(ai: AiContext, opponent: Character): Candidate[] {
    return profiler.measure("ai.candidates", () => {
      const side = this.sideAxis(opponent);
      const out: Candidate[] = [this.scoreAt(ai, this.pos, 0, opponent, this.z)];
      // Lateral strafe/cover spots (same level — firing lanes).
      for (const off of this.strafeOffsets) {
        for (const s of [-1, 1]) {
          const point = add(this.pos, scale(side, off * s));
          if (!walkable(ai.world, this.pos, this.z, point, this.z)) continue;
          out.push(this.scoreAt(ai, point, off * s, opponent, this.z));
        }
      }
      // Forward/back spots along the opponent line — may cross a stair and drop
      // z, giving cover that breaks line of sight. Each resolves its own level.
      const toOpp = dist(this.pos, opponent.pos) > 1e-3 ? norm(sub(opponent.pos, this.pos)) : vec(1, 0);
      for (const off of AXIAL_OFFSETS) {
        for (const s of [-1, 1]) {
          const point = add(this.pos, scale(toOpp, off * s));
          const cz = zAt(ai.world, point, this.z);
          if (!walkable(ai.world, this.pos, this.z, point, cz)) continue;
          out.push(this.scoreAt(ai, point, off * s, opponent, cz));
        }
      }
      return out;
    });
  }

  /** Score one spot's firing lane onto the opponent, one ray per target point:
   *  obstacle-blocked 0, teammate in the ray -1, clear +1. All rays live on
   *  this.z, so an opponent on another level scores 0 everywhere. */
  private scoreAt(ai: AiContext, from: Vec2, offset: number, opponent: Character, fromZ: number): Candidate {
    let exposed = 0;
    let clear = 0;
    let score = 0;
    // On another level the opponent can't see (or be shot from) this spot: 0
    // everywhere — pure cover, never a firing spot.
    if (opponent.z === fromZ) {
      const mates = this.teammates(ai, opponent, fromZ);
      for (const pt of targetPoints(opponent)) {
        if (!losClear(ai.world, from, pt, fromZ)) continue; // geometry: 0
        exposed += 1; // a friend in the ray is a bad lane, but never cover
        if (mates.some((m) => friendInLine(from, pt, m.pos, FRIENDLY_MARGIN))) {
          score -= 1;
        } else {
          clear += 1;
          score += 1;
        }
      }
    }
    return { point: from, offset, exposed, clear, score, z: fromZ };
  }

  /** Everyone on level `z` it must not shoot through (any non-hostile body). */
  private teammates(ai: AiContext, opponent: Character, z = this.z): Character[] {
    return ai.characters.filter(
      (c) =>
        c !== this &&
        c !== opponent &&
        c.hp > 0 &&
        c.z === z &&
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
