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
 *  - RUN mode: when contact is far off — min over all hostiles of our reach to
 *    see them AND their reach to see us (the soonest a fight could start) exceeds
 *    RUN_DISTANCE — it
 *    holsters to the fists and sprints there at RUN_SPEED_MUL x speed, re-arming
 *    (draw time and all) once it closes in. Committed a priori: that distance must
 *    hold for RUN_COMMIT_TICKS before it starts, so a peeking opponent (who keeps
 *    resetting the dwell) never gets it to holster.
 *  - HEAL mode: a committed heal — hurt (< HEAL_HP) and safe, a soldier carrying
 *    meds backs away to grow its safety, then holds cover burning healing items
 *    back-to-back. "Safe" is the ENEMY's distance-until-visibility to US —
 *    minimised over ALL hostiles (the soonest anyone could see us), the same pass
 *    that finds our own min reach for RUN (contactScan): it stays long while we're
 *    tucked behind cover, so a peeking opponent doesn't flip the heal like our own
 *    visDist would. While healing it retreats from the nearest threat until that
 *    reach hits HEAL_SEEK_DISTANCE, then just holds cover. Enter at
 *    HEAL_SAFE_DISTANCE (held for HEAL_COMMIT_TICKS — an a-priori dwell, so a
 *    dip-and-recover in that reach keeps resetting it and never turtles), drop the
 *    item and re-arm at HEAL_ALARM_DISTANCE (or once topped off / out of items).
 *    Entry is committed; the abort stays instant (safety).
 *  - Targeting is cost-based, not distance-based: among visible hostiles it
 *    locks the one it could shoot *soonest* — the walk to the nearest strafe
 *    point with a clear friendly-free lane (selectTarget/shootCost) — and when
 *    nobody is in sight it chases whoever is cheapest to reach over the nav
 *    graph, not whoever is nearest through a wall (bestChase).
 *  - Reaction time keeps all of it human: a hostile must stay in view
 *    reactionTime ticks before it's engaged (Robot.seenFor), and readiness
 *    changes — burst spent, recoil settled, reload started/finished — steer
 *    the mode and the trigger reactionTime late. Two things are reflexive
 *    (acted on at once, not reaction-gated): the burst cutoff — fire stops the
 *    instant the envelope is spent, spray control being trained not decided —
 *    and starting a reload, a self-known event that drops it straight into
 *    cover rather than holding a lane through the mag swap. Semi-auto guns add
 *    a per-shot clicking delay on top of their mechanical fire delay.
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
/** Objective bias: a flat, huge reward for a combat spot standing ON the bias
 *  point (see biasObjective / objReward). Dwarfs the by-distance term, so any
 *  on-point firing spot outranks every off-point one — the bot fights on the
 *  point whenever a spot there can still shoot. */
const ON_POINT_REWARD = 1e6;
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
 *  amount of strafing (max 120 + 60), so anyone shootable in place wins. A flat
 *  constant, not distance-scaled — range ordering is selectTarget's BETA_DIST
 *  term alone, applied uniformly to lane-blocked and shootable hostiles. */
const NO_LANE_COST = 400;
/** Weight on raw distance-to-target in target selection, added to shootCost
 *  (which measures cost-to-first-shot). Breaks ties toward the closer enemy so
 *  the AI doesn't fixate on a far but easily-shot one. */
const BETA_DIST = 0.75;
/** Cost edge a challenger needs over the current focus — don't flip-flop
 *  between two near-equal targets every re-evaluation. */
const FOCUS_STICKINESS = 30;
/** Target-selection penalty for a hostile beyond the weapon's feasible range:
 *  large enough that any in-range hostile outranks any out-of-range one, while
 *  out-of-range hostiles keep their relative order among themselves (so the best
 *  of a bad lot is still picked when nothing is reachable). */
const OUT_OF_RANGE_PENALTY = 1e5;
/** Ticks without sight of anyone before the remembered focus is dropped and
 *  navigation goes back to "whoever is quickest to reach". */
const FOCUS_MEMORY = 120;
/** Re-run the blind-chase pick this often (matches the Oracle's replan beat). */
const CHASE_EVAL_TICKS = 30;
/** How wide a berth a firing lane gives teammates. Twice the body: bursts
 *  spray several degrees off the aim line, so grazing a friend's silhouette
 *  with the center line isn't good enough. */
const FRIENDLY_MARGIN = BODY_RADIUS * 2;
/** Anti-flag (`blockingMate`/`sidestep`): while approaching with the gun out, if
 *  a teammate is within CROWD_DIST ahead and within CROWD_MARGIN of the travel/
 *  aim line (the same downrange test as the friendly-fire lane check), veer
 *  laterally out instead of marching behind them — so they don't flag each other
 *  and can both shoot. CROWD_DIST reaches past SEPARATE_RADIUS, or separation
 *  would just park the mate ahead just out of detection. CROWD_MARGIN matches
 *  FRIENDLY_MARGIN (the flag half-width) so it fires only for a genuine in-lane
 *  mate, not one merely abreast. */
const CROWD_DIST = BODY_RADIUS * 6; // ~180px, > SEPARATE_RADIUS
const CROWD_MARGIN = BODY_RADIUS * 2; // = FRIENDLY_MARGIN

// --- RUN / HEAL postures (distance-until-visibility driven) ------------------
/** "Distance until visibility": the nav-route distance to the nearest spot that
 *  can see the quarry (0 while it's already in sight). It gates the two
 *  out-of-contact postures below. */
/** Sprint speed (fists out) as a multiple of the normal move speed. */
const RUN_SPEED_MUL = 1.4;
/** Distance-until-visibility above which to holster and sprint to contact. */
const RUN_DISTANCE = 1000;
/** Contact must stay this far off for this long (ticks, ~1.5s) before RUN is
 *  committed — an a-priori dwell, not a reactive lockout. A peeking opponent
 *  whipsaws the distance, so the dwell keeps resetting and never commits: the
 *  bot only holsters to sprint once the enemy has truly stayed away a beat. */
const RUN_COMMIT_TICKS = 90;
/** Below this HP, look for a safe moment to heal. */
const HEAL_HP = 75;
/** Distance-until-visibility needed to START healing (a safe buffer). */
const HEAL_SAFE_DISTANCE = 700;
/** While healing, keep backing off to grow the enemy's reach-to-us up to this —
 *  a "reasonable" safe cushion. Past it, just hold cover and use items (don't
 *  keep fleeing across the map). */
const HEAL_SEEK_DISTANCE = 1200;
/** How many nearest hostiles (by straight-line) the contact scan routes over.
 *  The min distance-until-visibility is dominated by the closest enemies, so a
 *  small K keeps the O(nodes) nav scans bounded regardless of the roster size. */
const CONTACT_SCAN_K = 3;
/** Recompute the (expensive, nav-scan-heavy) contact scan only this often;
 *  distance-until-visibility drifts slowly, so it's cached between. */
const CONTACT_EVAL_TICKS = 15;
/** Distance-until-visibility at which an in-progress heal is aborted and the
 *  weapon comes back out (the enemy is getting close). Below HEAL_SAFE_DISTANCE
 *  so the two thresholds hysteresis instead of chattering. */
const HEAL_ALARM_DISTANCE = 400;
/** The enemy's reach must stay past HEAL_SAFE_DISTANCE for this long (ticks, ~1.5s)
 *  before a heal is committed — an a-priori dwell. The abort stays instant
 *  (safety); this only gates entry, so a reach that dips-and-recovers (peeking,
 *  or the route metric snapping across nav nodes) keeps resetting the dwell and
 *  never turtles, instead of a lockout that expires and re-triggers. */
const HEAL_COMMIT_TICKS = 90;

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
  /** Gun-readiness mode from updateMode (shoot when the burst/reload is ready,
   *  else cover). The acting posture (`mode`) equals this in combat, but RUN and
   *  HEAL override it (see updatePosture). */
  private combatMode: "shoot" | "cover" = "shoot";
  /** The posture actually fought this tick: normal combat (shoot/cover), RUN
   *  (holstered sprint to contact), or HEAL (a committed heal — moves exactly
   *  like cover, but stays put using items instead of re-engaging). */
  private mode: "shoot" | "cover" | "run" | "heal" = "shoot";
  /** OUR distance-until-visibility to the quarry (route to a spot that sees it),
   *  refreshed each plan tick; drives RUN. */
  private visDist = Infinity;
  /** The ENEMY's distance-until-visibility to US, minimised over ALL hostiles
   *  (the soonest ANYONE could see us) — what gates healing: it stays long while
   *  we're tucked in cover, whereas our own visDist snaps to 0 the instant they
   *  peek a lane we can see. */
  private enemyVisDist = Infinity;
  /** The hostile that owns `enemyVisDist` (can see us soonest) — the one a heal
   *  retreat backs away from. Null when out of the scan. */
  private threat: Character | null = null;
  /** Ticks until the (expensive) contact scan is recomputed (else cached). */
  private contactEvalIn = 0;
  /** Consecutive ticks the RUN entry condition has held (a-priori dwell — RUN is
   *  committed only once this reaches RUN_COMMIT_TICKS; resets the moment it fails). */
  private runDwell = 0;
  /** Consecutive ticks the HEAL entry condition has held (see HEAL_COMMIT_TICKS). */
  private healDwell = 0;
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
  /** The capture point (centre + radius) combat movement is pulled toward this
   *  plan tick, or null — set from biasObjective() in act(). */
  private biasObj: { pos: Vec2; radius: number } | null = null;

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
    // Out of sight, the last engaged enemy stays the concern (cover is scored
    // against them, the chase heads back at them) until memory lapses.
    const chase = target ?? this.focus ?? this.bestChase(ai);
    // Contact metrics, minimised over ALL hostiles. In an active fight (in visual
    // contact with the chased enemy) we're exposed and close, so both are ~0 —
    // skip the full scan; only pay for it when out of contact (approaching /
    // running / healing), which is exactly when RUN/HEAL care.
    if (chase && this.inContact(ai, chase)) {
      this.visDist = 0;
      this.enemyVisDist = 0;
      this.threat = chase;
      this.contactEvalIn = 0; // recompute the moment we lose sight
    } else if (chase) {
      // The scan is nav-scan-heavy; cache it (distance-until-visibility drifts
      // slowly). A fresh entry into the scan branch (contactEvalIn reset to 0
      // whenever we were seeing the chase) recomputes immediately.
      this.contactEvalIn -= 1;
      if (this.contactEvalIn <= 0) {
        const scan = this.contactScan(ai);
        this.visDist = scan.myMin;
        this.enemyVisDist = scan.enemyMin;
        this.threat = scan.threat ?? chase;
        this.contactEvalIn = CONTACT_EVAL_TICKS;
      }
    } else {
      this.visDist = Infinity;
      this.enemyVisDist = Infinity;
      this.threat = null;
      this.contactEvalIn = 0;
    }
    this.updateMode(target ?? this.focus);
    this.updatePosture(); // may override the combat mode with RUN / HEAL
    // What capture point (if any) should pull our combat maneuvering this tick —
    // read only by strafe/cover below, so it steers fighting without touching
    // run/heal or target selection.
    this.biasObj = this.biasObjective(ai);
    if (!chase) return;

    // Heavy-penalty guns are fired from a stand: while a shot is on, hold
    // position and let strafes/approaches happen between bursts. vel is already
    // zeroed. Only holds when the target is actually in reach (see standToShoot),
    // else it'd freeze planted on an enemy it can't hit.
    if (this.standToShoot(ai, target)) return;

    if (this.mode === "heal") {
      this.healMove(ai, chase); // back off to grow the enemy's reach, then hold cover
    } else if (this.mode === "cover") {
      this.coverMove(ai, chase);
    } else if (target && dist(this.pos, target.pos) <= this.engageRange) {
      this.strafeMove(ai, target);
    } else {
      // Approach: graph-chase into range (SHOOT out of sight / too far to trade)
      // or sprint to the objective (RUN) — one path, differing only in speed
      // (stepSpeed) and facing (facesTravel), both keyed off the mode. Veer out
      // of a teammate's lane first so we don't march in behind (and flag) them,
      // or wedge front-to-front converging on the same spot. General spacing is
      // postMove's job; this is path-specific.
      this.strafeTarget = null;
      const blocker = this.blockingMate(ai, chase);
      // Veer around a mate in the lane if there's room; if boxed in, drive
      // straight and let the squishy body collision phase us through.
      if (!blocker || !this.sidestep(ai, chase, blocker)) this.navChase(ai, chase, target);
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
    this.updatePosture(); // keep the posture (and heal use) live between plans
    // HEAL: follow the committed retreat/cover spot, or hold — never coast toward
    // the enemy (that's the opposite of taking cover to heal).
    if (this.mode === "heal") {
      if (this.strafeTarget) this.stepToward(this.strafeTarget);
      return;
    }
    // Mirror act's stand-to-shoot hold so a heavy gunner doesn't creep mid-burst.
    if (this.standToShoot(ai, target)) return;
    if (this.strafeTarget) {
      this.stepToward(this.strafeTarget);
      return;
    }
    // Keep clearing a teammate's firing lane between plan ticks too (drive
    // straight if boxed — squishy collision phases through rather than freezing).
    const chase = target ?? this.focus;
    const blocker = chase ? this.blockingMate(ai, chase) : null;
    if (!chase || !blocker || !this.sidestep(ai, chase, blocker)) this.coastStep(ai);
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
      if (mode !== this.combatMode) {
        this.combatMode = mode;
        this.strafeTarget = null; // the two modes want opposite spots
        this.evalIn = 0;
      }
    }
  }

  /** Resolve the acting posture from the combat mode, HP, and
   *  distance-until-visibility, and keep the held slot in step with it:
   *   - HEAL (cover + use items): hurt (< HEAL_HP), carrying a healing item,
   *     and safely far (>= HEAL_SAFE_DISTANCE). Aborts — re-arming — the moment
   *     the enemy could see us within HEAL_ALARM_DISTANCE, we top off, or we run
   *     out of items.
   *   - RUN (holstered sprint): no heal wanted, but contact is far off
   *     (>= RUN_DISTANCE).
   *   - otherwise the combat mode (shoot / cover). */
  private updatePosture(): void {
    // Entry conditions, and how long each has held continuously (a-priori dwell):
    // the distance must stay safe for the commit period before we hand over to
    // RUN / HEAL, so a peeker whipsawing the distance keeps resetting the dwell
    // and never triggers either — no reactive lockout needed.
    const fightDist = Math.min(this.visDist, this.enemyVisDist); // soonest a fight can start
    const runSafe = fightDist >= RUN_DISTANCE;
    const healSafe = this.hp < HEAL_HP && this.canHeal() && this.enemyVisDist >= HEAL_SAFE_DISTANCE;
    this.runDwell = runSafe ? this.runDwell + 1 : 0;
    this.healDwell = healSafe ? this.healDwell + 1 : 0;

    // HEAL is a committed mode: enter only after the dwell, exit instantly on the
    // alarm (safety) / topped off / out of items. The 700>400 gap is the stay
    // hysteresis; the dwell is the entry commitment.
    const healing =
      this.mode === "heal"
        ? this.enemyVisDist >= HEAL_ALARM_DISTANCE && this.hp < this.maxHp && this.canHeal()
        : healSafe && this.healDwell >= HEAL_COMMIT_TICKS;

    // RUN: stay while still safe; enter only after the dwell.
    const wantRun = !healing && runSafe && (this.mode === "run" || this.runDwell >= RUN_COMMIT_TICKS);
    // Reloading is a self-known, vulnerable moment: drop to cover at once
    // (reflexively, like the burst cutoff) instead of holding a firing lane while
    // the mag swaps — don't wait out the reaction delay that gates the normal
    // shoot<->cover flip. combatMode still catches up on its own timer underneath.
    const combat = this.gun.reloading ? "cover" : this.combatMode;
    const mode: "shoot" | "cover" | "run" | "heal" = healing ? "heal" : wantRun ? "run" : combat;

    if (mode !== this.mode) {
      if (this.mode === "heal") this.cancelUse(); // leaving a heal drops a half-finished use
      this.mode = mode;
      this.strafeTarget = null;
      this.evalIn = 0;
    }
    this.applyPostureSlot();
  }

  /** Hold the slot the posture wants: the healing item (and keep using it) while
   *  healing, the fists while running, else the weapon. equip() is a no-op when
   *  already on the slot, so this is cheap to call every tick. */
  private applyPostureSlot(): void {
    if (this.mode === "heal") {
      this.equipUtility();
      if (!this.usingUtility) this.startUse(); // chain items until healed / out
    } else if (this.mode === "run") {
      this.equip("hand"); // holster: fists out for the sprint
    } else {
      this.equipWeapon();
    }
  }

  /** Re-equip the best available weapon (primary, else secondary, else fists). */
  private equipWeapon(): void {
    if (this.slots.primary) this.equip("primary");
    else if (this.slots.secondary) this.equip("secondary");
    else this.equip("hand");
  }

  /** Carrying at least one (healing) utility to use. */
  private canHeal(): boolean {
    return this.utilities.length > 0;
  }

  /** HEAL movement: while the threat could still reach us within
   *  HEAL_SEEK_DISTANCE, back away to grow that reach; once past it, just hold
   *  cover (hug the least-exposed spot / dodge) and keep burning items. The
   *  retreat commits a spot as `strafeTarget` so coast follows it between plans. */
  private healMove(ai: AiContext, chase: Character): void {
    const threat = this.threat ?? chase;
    if (this.enemyVisDist >= HEAL_SEEK_DISTANCE) {
      this.coverMove(ai, threat); // safe enough — hold cover, don't flee further
      return;
    }
    this.evalIn -= 1;
    if (this.strafeTarget && dist(this.pos, this.strafeTarget) <= ARRIVE) this.strafeTarget = null;
    if (!this.strafeTarget || this.evalIn <= 0) {
      this.evalIn = EVAL_TICKS;
      this.strafeTarget = this.retreatSpot(ai, threat);
    }
    if (this.strafeTarget) this.stepToward(this.strafeTarget);
  }

  /** A walkable lookahead point that backs away from `threat`, preferring one
   *  that breaks its line of sight (so the retreat genuinely grows the threat's
   *  reach-to-us instead of wandering into an open lane). Null if walled in. */
  private retreatSpot(ai: AiContext, threat: Character): Vec2 | null {
    const LOOK = 90;
    const away = dist(this.pos, threat.pos) > 1e-3 ? norm(sub(this.pos, threat.pos)) : vec(1, 0);
    const side = perp(away);
    const dirs = [
      away,
      norm(add(away, scale(side, 0.6))),
      norm(add(away, scale(side, -0.6))),
      side,
      scale(side, -1),
    ];
    let fallback: Vec2 | null = null;
    for (const d of dirs) {
      const pt = add(this.pos, scale(d, LOOK));
      if (!walkable(ai.world, this.pos, this.z, pt, this.z)) continue;
      fallback = fallback ?? pt;
      if (!losClear(ai.world, pt, threat.pos, this.z)) return pt; // hidden: best retreat
    }
    return fallback; // nothing hidden reachable — take the most open-but-walkable back-step
  }

  /** Sprint while running; normal speed otherwise. */
  protected override stepSpeed(): number {
    return this.mode === "run" ? this.moveSpeed * RUN_SPEED_MUL : this.moveSpeed;
  }

  /** Running faces straight ahead (gun down, no corner-clearing). */
  protected override facesTravel(): boolean {
    return this.mode === "run";
  }

  /** Distance-until-contact: the distance a mover at (fromPos, fromZ) with weapon
   *  reach `range` must travel before it can both SEE `tgt` and be within `range`
   *  of it — 0 if already so. Already seeing it (but out of range) → the straight
   *  gap left to close; can't see it yet → the walk to the nearest node that sees
   *  `tgt`, plus any gap still left from there (usually 0 — a sighting node sits
   *  near what it sees). `fromNode` (the mover's nearest walkable node) and
   *  `tgtGoal` (nearest node that sees `tgt`) can be passed precomputed to hoist
   *  those node scans out of a loop (see contactScan). Adds only dist() arithmetic
   *  over the old sight-only scan. No graph / unreachable falls back to
   *  straight-line / Infinity. */
  private routeUntilSight(
    ai: AiContext,
    fromPos: Vec2,
    fromZ: number,
    tgt: Character,
    range: number,
    fromNode?: number,
    tgtGoal?: number,
  ): number {
    const sees = fromZ === tgt.z && targetPoints(tgt).some((pt) => losClear(ai.world, fromPos, pt, fromZ));
    if (sees) return Math.max(0, dist(fromPos, tgt.pos) - range); // 0 if also in range
    const nav = ai.nav;
    if (!nav || nav.nodes.length === 0) return dist(fromPos, tgt.pos);
    const curr = fromNode ?? nav.nearestWalkable(ai.world, fromPos, fromZ);
    const goal = tgtGoal ?? nav.nearestInSight(ai.world, tgt.pos, tgt.z);
    if (curr < 0 || goal < 0) return dist(fromPos, tgt.pos);
    // Reach a sighting node, then close any straight gap from it to within range.
    const gapFrom = (n: number): number => Math.max(0, dist(nav.nodes[n].pos, tgt.pos) - range);
    if (curr === goal) return dist(fromPos, nav.nodes[curr].pos) + gapFrom(curr);
    const step = nav.route(curr, goal);
    return step ? dist(fromPos, nav.nodes[curr].pos) + step.dist + gapFrom(goal) : Infinity;
  }

  /** Both contact metrics: `myMin` = the soonest WE could see anyone (drives RUN),
   *  `enemyMin` = the soonest ANYONE could see US with `threat` the enemy that owns
   *  it (gates HEAL, and the retreat backs away from `threat`).
   *
   *  Cost matters — a nav route needs two O(nodes) closest-node scans, so routing
   *  every hostile every plan tick is an O(N·nodes) blowup. Both minima are
   *  dominated by the CLOSEST enemies, so we route only the `CONTACT_SCAN_K`
   *  nearest by straight-line distance (a cheap sort) and hoist our own two node
   *  scans out of the loop — bounding the expensive scans to a constant. */
  private contactScan(ai: AiContext): { myMin: number; enemyMin: number; threat: Character | null } {
    const hostiles = this.hostiles(ai);
    if (hostiles.length === 0) return { myMin: Infinity, enemyMin: Infinity, threat: null };
    const near =
      hostiles.length <= CONTACT_SCAN_K
        ? hostiles
        : hostiles
            .map((h) => ({ h, d: dist(this.pos, h.pos) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, CONTACT_SCAN_K)
            .map((e) => e.h);

    const nav = ai.nav;
    const haveNav = !!nav && nav.nodes.length > 0;
    const myNode = haveNav ? nav!.nearestWalkable(ai.world, this.pos, this.z) : -1;
    const mySightGoal = haveNav ? nav!.nearestInSight(ai.world, this.pos, this.z) : -1;
    let myMin = Infinity;
    let enemyMin = Infinity;
    let threat: Character | null = null;
    const myRange = this.gun.feasibleRange;
    for (const h of near) {
      const my = this.routeUntilSight(ai, this.pos, this.z, h, myRange, myNode, undefined);
      if (my < myMin) myMin = my;
      // The enemy shoots us with ITS weapon, so its reach gates its contact.
      const en = this.routeUntilSight(ai, h.pos, h.z, this, h.gun.feasibleRange, undefined, mySightGoal);
      if (en < enemyMin) {
        enemyMin = en;
        threat = h;
      }
      if (myMin === 0 && enemyMin === 0) break; // can't drop lower
    }
    return { myMin, enemyMin, threat };
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

  /** Heavy-recoil guns fire from a planted stance: while a shot is genuinely on
   *  — ready, mid-burst, target in reach, lane clear — hold position, so a
   *  strafe/approach doesn't drag the muzzle off mid-burst; repositioning happens
   *  between bursts instead. The `feasibleRange` gate matches shouldFire: without
   *  it a shotgun would plant on a target it can't actually shoot and never close
   *  — frozen with the gun raised at a faraway enemy. */
  private standToShoot(ai: AiContext, target: Character | null): boolean {
    return (
      target !== null &&
      this.mode === "shoot" &&
      this.fireOk &&
      !this.burstDone &&
      this.gun.spec.movePenalty >= STAND_TO_SHOOT_PENALTY &&
      dist(this.pos, target.pos) <= this.gun.feasibleRange &&
      this.laneClear(ai, target)
    );
  }

  /** Fire only mid-burst in SHOOT mode, with the muzzle settled on the target
   *  — never near a teammate's line, and on semi-auto guns only as fast as a
   *  trigger finger clicks. */
  protected override shouldFire(ai: AiContext, target: Character | null): boolean {
    if (this.mode !== "shoot" || !this.fireOk || !target) return false;
    if (this.clickIn > 0) return false;
    // Don't spend rounds past the weapon's reach — the bullet would die short.
    if (dist(this.pos, target.pos) > this.gun.feasibleRange) return false;
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
    const range = this.gun.feasibleRange;
    for (const h of this.hostiles(ai)) {
      if (h.z !== this.z || !this.canSee(ai.world, h)) continue;
      const d = dist(this.pos, h.pos);
      let cost = this.shootCost(ai, h) + BETA_DIST * d;
      if (d > range) cost += OUT_OF_RANGE_PENALTY; // prefer anyone we can actually reach
      if (h === this.focus) cost -= FOCUS_STICKINESS;
      if (cost < bestCost) {
        best = h;
        bestCost = cost;
      }
    }
    if (best) this.focus = best; // keep remembering the old focus while blind
    return best;
  }

  /** How quickly `h` could be shot from here, as a *repositioning* distance: the
   *  nearest local movement point (current spot or a strafe candidate) whose lane
   *  onto `h` is clear of friends, plus a surcharge if that lane is poor. No lane
   *  from anywhere local -> a flat NO_LANE_COST, larger than any in-lane result so
   *  it sorts behind every shootable-in-place hostile. Deliberately NOT scaled by
   *  range: selectTarget adds the sole BETA_DIST*range term, so folding raw
   *  distance in here too would double-count it (at weight ~1.0 vs the intended
   *  0.35) and let a clear far enemy outrank a merely lane-blocked near one. */
  private shootCost(ai: AiContext, h: Character): number {
    let cost = Infinity;
    for (const c of this.candidates(ai, h)) {
      if (c.clear === 0 || c.score < c.clear) continue; // hidden, or a friend in the lane
      const poorLane = c.clear <= LOW_VISIBILITY ? LOW_VIS_PENALTY : 0;
      cost = Math.min(cost, Math.abs(c.offset) + poorLane);
    }
    return cost === Infinity ? NO_LANE_COST : cost;
  }

  /** Blind navigation target: the hostile reachable-and-shootable soonest by
   *  the graph — route distance to the node that sees them — instead of raw
   *  straight-line distance (which happily picks someone behind a wall on
   *  another floor). Cached: routes are table lookups but nearestInSight isn't. */
  /** Are we in visual contact with `chase` (an enemy) AND within our weapon's
   *  reach of it right now — i.e. actually able to trade, so the contact metrics
   *  are ~0 and the expensive scan can be skipped? A target seen but beyond
   *  feasible range isn't contact yet (we'd have to close first), so it falls
   *  through to the full scan — which measures the distance left to close. Kept
   *  overridable so an objective-seeking subclass can exempt a non-enemy chase
   *  (a domination point marker) from being mistaken for a live fight. */
  protected inContact(ai: AiContext, chase: Character): boolean {
    return (
      chase.z === this.z &&
      dist(this.pos, chase.pos) <= this.gun.feasibleRange &&
      this.canSee(ai.world, chase)
    );
  }

  protected bestChase(ai: AiContext): Character | null {
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

  /** SHOOT, engaged and in sight. Normally: hold ground unless the lane is bad
   *  (teammate in the line, or too few target points visible), then slide to the
   *  best-scoring lateral spot. When biased toward a capture point: among spots
   *  that can still shoot, take the one that most rewards the objective (on the
   *  point ≫ nearer to it) — so it fights ON the point when possible — and only
   *  fall back to the plain best-lane search if nothing there can shoot. */
  private strafeMove(ai: AiContext, target: Character): void {
    this.evalIn -= 1;
    if (this.strafeTarget && dist(this.pos, this.strafeTarget) <= ARRIVE) this.strafeTarget = null;
    if (!this.strafeTarget || this.evalIn <= 0) {
      this.evalIn = EVAL_TICKS;
      const cands = [...this.candidates(ai, target), ...this.objectiveCandidates(ai, target)];
      const objBest = this.biasObj ? this.bestFiringToward(cands) : null;
      if (objBest) {
        this.strafeTarget = objBest.offset === 0 ? null : objBest.point;
      } else {
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
    }
    if (this.strafeTarget) this.stepToward(this.strafeTarget);
  }

  /** The best objective-ward firing spot among `cands`, or null if none can
   *  shoot. "Can shoot" = same level, at least one clear target point, no friend
   *  flagged. Ranked by objReward (on-point ≫ nearer), then lane quality, then
   *  least travel — so being on the point wins even over a somewhat cleaner lane
   *  elsewhere, but a spot that can't shoot at all is never chosen. */
  private bestFiringToward(cands: Candidate[]): Candidate | null {
    let best: Candidate | null = null;
    for (const c of cands) {
      if (c.z !== this.z || c.clear < 1 || c.score !== c.clear) continue;
      if (best === null) {
        best = c;
        continue;
      }
      const rc = this.objReward(c.point);
      const rb = this.objReward(best.point);
      if (rc > rb) best = c;
      else if (rc === rb && (c.score > best.score || (c.score === best.score && Math.abs(c.offset) < Math.abs(best.offset)))) best = c;
    }
    return best;
  }

  /** The capture point (centre + radius) combat movement should gravitate toward
   *  this tick, or null. Base TacOracle never biases (plain combat); objective-
   *  seeking subclasses (DominationOracle) override it. */
  protected biasObjective(_ai: AiContext): { pos: Vec2; radius: number } | null {
    return null;
  }

  /** Objective reward for a spot: a huge flat bonus for standing on the point
   *  (inside its radius), else the negative distance to it (nearer = better). 0
   *  with no active bias, so it drops out of the ranking. */
  private objReward(p: Vec2): number {
    const b = this.biasObj;
    if (!b) return 0;
    const d = dist(p, b.pos);
    return d <= b.radius ? ON_POINT_REWARD : -d;
  }

  /** Extra candidate spots stepped straight toward the bias point at the strafe
   *  offsets (capped so as not to overshoot its centre), so combat maneuvering
   *  has a DIRECT on-point option rather than only the enemy-relative fan. Scored
   *  like any spot — a step onto the point is taken only if it can still shoot /
   *  cover. Empty when unbiased, so plain combat is untouched. */
  private objectiveCandidates(ai: AiContext, opponent: Character): Candidate[] {
    const b = this.biasObj;
    if (!b) return [];
    const to = sub(b.pos, this.pos);
    const len = Math.hypot(to.x, to.y);
    if (len < 1e-3) return [];
    const dir = vec(to.x / len, to.y / len);
    const out: Candidate[] = [];
    for (const off of this.strafeOffsets) {
      const point = add(this.pos, scale(dir, Math.min(off, len)));
      const cz = zAt(ai.world, point, this.z);
      if (!walkable(ai.world, this.pos, this.z, point, cz)) continue;
      out.push(this.scoreAt(ai, point, off, opponent, cz));
    }
    return out;
  }

  /** COVER: get to the lateral spot the opponent sees the least of. When no
   *  spot beats standing here but here is no cover either (an all-tied board),
   *  dodge side to side instead of eating shots flat-footed. */
  private coverMove(ai: AiContext, chase: Character): void {
    this.evalIn -= 1;
    if (this.strafeTarget && dist(this.pos, this.strafeTarget) <= ARRIVE) this.strafeTarget = null;
    if (!this.strafeTarget || this.evalIn <= 0) {
      this.evalIn = EVAL_TICKS;
      const base = this.candidates(ai, chase);
      const cur = base[0];
      const cands = [...base, ...this.objectiveCandidates(ai, chase)];
      // Least exposure stays the primary — cover mustn't step onto an exposed
      // point mid-reload — but among equally-safe spots, drift toward the
      // objective (then least travel), so the bot covers on/near the point.
      let best = cur;
      for (const c of cands) {
        if (c.exposed < best.exposed) best = c;
        else if (c.exposed === best.exposed) {
          const rc = this.objReward(c.point);
          const rb = this.objReward(best.point);
          if (rc > rb || (rc === rb && Math.abs(c.offset) < Math.abs(best.offset))) best = c;
        }
      }
      // "Nowhere to hide" is judged on the real cover fan only (objective-ward
      // spots don't count), so an exposed point can't suppress the dodge.
      this.dodging = base.every((c) => c.exposed === cur.exposed);
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

  /** The nearest teammate downrange in our travel/aim lane toward `chase` (within
   *  CROWD_DIST ahead, CROWD_MARGIN of the line), or null — i.e. someone we'd be
   *  flagging (and marching behind) if we kept going straight. Reuses the
   *  anti-friendly-fire lane test so "in the lane" means the same thing here as
   *  for holding fire. */
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

  /** One tick veering off `blocker`'s side instead of marching straight into its
   *  back (which would flag it): a diagonal that still advances toward `chase`,
   *  falling back to a shallower veer / the other side / pure lateral as walls
   *  allow. Clears our firing lane so both can shoot. Returns whether it found an
   *  opening; if not, the caller drives straight (and the squishy body collision
   *  lets it phase through the mate rather than freeze against it). */
  private sidestep(ai: AiContext, chase: Character, blocker: Character): boolean {
    const to = sub(chase.pos, this.pos);
    const dir = dist(this.pos, chase.pos) > 1e-3 ? norm(to) : vec(1, 0);
    const side = perp(dir);
    const rel = sub(blocker.pos, this.pos);
    const away = dir.x * rel.y - dir.y * rel.x > 0 ? -1 : 1; // step off the blocker's side
    const openL = scale(side, away);
    const openR = scale(side, -away);
    const dirs = [
      add(dir, openL), // 45° to the open side: clear the lane AND keep advancing
      add(scale(dir, 2), openL), // shallower veer (more forward) if that's walled
      add(dir, openR), // veer the other way instead
      openL, // pure lateral: a tight spot with no room to advance
      openR,
    ];
    for (const d of dirs) {
      const step = add(this.pos, scale(norm(d), this.moveSpeed));
      if (walkable(ai.world, this.pos, this.z, step, this.z)) {
        this.vel = sub(step, this.pos);
        this.pos = step;
        return true;
      }
    }
    return false; // boxed in — no lateral opening
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
