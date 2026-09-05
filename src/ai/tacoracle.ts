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
import { Character } from "../entities/actor.ts";
import { BODY_RADIUS, type Skin } from "../entities/character.ts";
import { Gun } from "../entities/gun.ts";
import { UNARMED } from "../entities/guns.ts";
import { GunItem } from "../entities/item.ts";
import { walkable, zAt } from "../world/nav.ts";
import { Oracle, type OracleOptions } from "./oracle.ts";
import { profiler } from "../engine/profiler.ts";
import { targetPoints, type AiContext } from "./robot.ts";
import { areHostile } from "../entities/team.ts";
import { add, angleOf, deg2rad, dist, norm, perp, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import { losClear, shotClear, shotCost, wallbangDamageFor, wallbangSightBudget, type HitMarks, type Hittable } from "../world/world.ts";
import type { ArmorPen, GunSpec } from "../entities/guns.ts";

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
/** A `careful` gun's aim floor (see MIN_AIM_TOLERANCE): a much tighter cone, so a
 *  launcher waits until the muzzle is genuinely settled on the (Gaussian-jittered)
 *  aim point instead of loosing a round while the turn-toward swing still carries
 *  it off-axis. Same aim error underneath — this only delays the trigger. */
const CAREFUL_AIM_TOLERANCE = deg2rad(4);
/**
 * A `careful` gun holds fire until the shooter has actually stopped.
 *
 * The clearance check vets `forward`, but the round leaves along
 * `rotate(forward, shoot(speedRatio))` — and a launcher's moving-first-shot
 * recoil throws that by ~10° at a tenth speed and ~20° at half, far outside any
 * corridor a raycast could widen to. Standing still is the only state in which
 * the vetted line and the fired line agree. Not zero: velocity decays
 * geometrically (see FRICTION), so "stopped" is a small band — this one is the
 * speed at which the RPG's own maxSpread() just fits inside CAREFUL_AIM_TOLERANCE.
 */
const CAREFUL_MAX_SPEED_RATIO = 0.01;
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
/** Target-splitting: extra selectTarget cost for a hostile that teammates are
 *  ALREADY focused on, so a squad spreads its fire instead of every gun locking
 *  the same man. Keyed by how many OTHER live teammates hold it as their focus:
 *  0-1 is free (someone has to shoot first, and a duo on one target is fine), 2
 *  is "pretty big" — on the NO_LANE_COST scale, enough to redirect toward any
 *  other reachable hostile that isn't already crowded — and 3+ is a near-forbid
 *  on the out-of-range scale, so a thrice-covered enemy is picked only when
 *  nothing else is visible. Read from teammates' committed focus, so it lags a
 *  tick and can't feed back on itself inside one re-evaluation. */
const TARGET_SHARE_BIG = 400;
const TARGET_SHARE_FORBID = OUT_OF_RANGE_PENALTY;
/** No share penalty for an enemy this close on our own level: spreading fire is
 *  a choice between comparable targets, and someone at point-blank is a
 *  personal threat, not a choice. Without this, a thrice-covered enemy 100px
 *  away scored 1e5 and the bot picked a cross-map candidate instead — "only
 *  when nothing else is visible" stopped existing once cross-z admission made
 *  everything always visible (measured: scripts/probe_ignore.mts, 10v10 dom). */
const SHARE_EXEMPT_DIST = 300;
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
/** Distance-until-visibility needed to START healing (a safe buffer).
 *
 *  Was 700, which almost never opened: measured over four maps, hurt bots spent
 *  85-93% of their hurt time not healing, and the single biggest reason (45-60%
 *  of it) was this gate. Not because 700 was slightly too far — because the
 *  distribution is bimodal. Of hurt-with-an-item ticks, 65-87% sat in the 0-100
 *  band, not just short of the bar: in a 5v5 somebody can nearly always see you,
 *  and enemyVisDist collapses to ~0 when they can. Only 3-15% of ticks lived in
 *  400-700, which is all a threshold move can recover.
 *
 *  Do not push it below HEAL_ALARM_DISTANCE. Entering under the abort threshold
 *  means the stay-condition fails on the next tick, and the bot flip-flops: at
 *  200 the measurement showed 411 "heals" restoring LESS HP than the 7 at 700.
 *  At 400 it now EQUALS the abort threshold, so there is no hysteresis margin
 *  left — the entry dwell is the only thing damping re-entry. Lowering the alarm
 *  to restore a gap is untested. */
const HEAL_SAFE_DISTANCE = 400;
/** While healing, keep backing off to grow the enemy's reach-to-us up to this —
 *  a "reasonable" safe cushion. Past it, just hold cover and use items (don't
 *  keep fleeing across the map). */
const HEAL_SEEK_DISTANCE = 1200;
/** Sampling stride (world px) for the first-sight march in routeUntilSight. The
 *  coarser cousin of HOLD_ENTRY_STEP: that one places a spot to aim at and wants
 *  precision, this one feeds distance BANDS hundreds of px wide, so a stride this
 *  size costs a fraction of the raycasts and lands well inside the tolerance. */
const SIGHT_MARCH_STEP = 40;
/** Hop cap on that march, mirroring HOLD_PATH_HOPS. The `ceiling` guard normally
 *  ends it far sooner; this just stops a pathological graph walking forever. */
const SIGHT_MARCH_HOPS = 24;
/** Recompute the (expensive, nav-scan-heavy) contact scan only this often;
 *  distance-until-visibility drifts slowly, so it's cached between. */
const CONTACT_EVAL_TICKS = 15;
/** Distance-until-visibility at which an in-progress heal is aborted and the
 *  weapon comes back out (the enemy is getting close). Was below
 *  HEAL_SAFE_DISTANCE so the two hysteresis instead of chattering; now EQUAL to
 *  it, so there is no gap left and the entry dwell is the only thing damping
 *  re-entry. Measured fine in practice (10-13 heals per run, not the flip-flop
 *  the 200 entry cell produced), but it is a margin that no longer exists.
 *
 *  Swept 400/300/250/200/150 over 8 maps x 8 seeds, paired, vs HP restored:
 *
 *      300  +5%  t=1.41      200   +8%  t=1.53
 *      250  +6%  t=1.55      150  +17%  t=3.00  (completion 64% -> 74%)
 *
 *  Monotone, and 150 is the first cell that clears noise. The safety cost never
 *  showed: deaths WHILE mid-heal went 0.00 -> 0.02 per run (about one across 64
 *  runs, and exactly zero on the domination maps), and total deaths went DOWN
 *  (-0.8) — a finished heal is worth more than the extra seconds of exposure.
 *  Left at 400 by choice, not by evidence; 150 is available and measured.
 *
 *  Do NOT expect this to fix domination heals being cut short. 54-77% of dom
 *  heals end here, but that is the alarm working: dom bots stand on contested
 *  ground, so enemyVisDist is chronically ~0, and it blows past any threshold in
 *  this range on its way there. 250 measured +4% on dom (t=0.69, 4/16 seeds).
 *  The untested idea for that case is gating on EXPOSURE rather than distance —
 *  a bot in real cover tolerating a nearer enemy than one in the open. */
const HEAL_ALARM_DISTANCE = 400;
/** The enemy's reach must stay past HEAL_SAFE_DISTANCE for this long (ticks, 1s)
 *  before a heal is committed — an a-priori dwell. The abort stays instant
 *  (safety); this only gates entry, so a reach that dips-and-recovers (peeking,
 *  or the route metric snapping across nav nodes) keeps resetting the dwell and
 *  never turtles, instead of a lockout that expires and re-triggers.
 *
 *  Was 90. With the 400 distance above, this measures +22% HP restored (t=2.76,
 *  CI [+5,+33], better in 45 of 64 paired runs) at no cost in damage dealt.
 *
 *  That figure is deliberately the 8-map one. Tuned on four maps it looked like
 *  +37%, and every candidate that looked strong there went NULL on four maps it
 *  had not been tuned on (700/60: +48% -> +0%). Re-tune on held-out maps or the
 *  number will flatter itself again.
 *
 *  Lower is NOT monotonically better and heal COUNT is a trap: 30 measured worse
 *  than both 60 and 10, and dropping HEAL_SAFE_DISTANCE to 200 produced 411
 *  "heals" that restored less HP than the 7 at 700. Judge a change on HP
 *  restored — scripts/probe_heal.mts reports it.
 *
 *  Use completion (86% -> 64% here) is worth watching but is NOT a cost in
 *  items: cancelUse aborts without consuming, only finishUse spends the charge.
 *  An interrupted heal costs a few seconds of walking to cover, which is why
 *  damage dealt does not move. */
const HEAL_COMMIT_TICKS = 60;

// --- HOLD posture (defend an angle from cover) ------------------------------
/** How far the covered-node search may wander from where we stand (px of walking
 *  distance). Cover across the map isn't cover we're holding — it's a relocation. */
const HOLD_COVER_DISTANCE = 500;
/** Nodes the covered-node search may settle before giving up. Bounds the one
 *  expensive part of the plan; it only runs on entering HOLD. */
const HOLD_SEARCH_NODES = 48;
/** Hops of the enemy's route walked while looking for the entry point. */
const HOLD_PATH_HOPS = 24;
/** Step size sliding back out of cover to expose a sliver of body (px). */
const HOLD_PEEK_STEP = 8;
/** Step size marching the leg into the entry node looking for the first point in
 *  view (see findEntry). Finer costs a raycast per step and buys sub-step
 *  precision on an angle that is itself a prediction. */
const HOLD_ENTRY_STEP = 10;
/** Once the peek's sight line to the entry point opens up, edge this much
 *  further out (px). The first step that clears the corner clears it by a hair,
 *  and a body-separation shove or the arrival slop can close it again — leaving
 *  a bot parked where it cannot see the very thing it is watching. Cheap
 *  insurance: well under a body radius, so it costs almost no cover. */
const HOLD_PEEK_MARGIN = 16;
/** "At the hold waypoint" slop, px (the route legs are node-to-node). */
const HOLD_ARRIVE = 8;
/** The hold conditions must stand this long before the posture commits — the
 *  same a-priori dwell RUN and HEAL use, so a hostile blinking in and out of
 *  sight can't flip the bot into cover and back every few ticks. */
const HOLD_COMMIT_TICKS = 30;
/** After a failed plan (no entry point, or no cover worth holding), don't retry
 *  for this long — the geometry won't have changed by next tick, and the search
 *  is the expensive one. */
const HOLD_RETRY_TICKS = 60;
/** Once parked, re-derive the threat and their entry point this often (~1s), so
 *  a hold doesn't keep guarding a corridor the enemy stopped using. Counted in
 *  REAL ticks (holdMove advances it by `stagger`). Deliberately gated on being
 *  parked: the entry point is derived from the route to where we STAND, so
 *  refreshing it mid-walk would chase its own tail — the plan moves us, which
 *  moves the plan. Standing still, that loop can't close. */
const HOLD_REPLAN_TICKS = 60;
/** How often the held angle is re-tested (ticks). Cheap — one lane query. */
const HOLD_LOS_CHECK_TICKS = 10;
/** Total ticks of a BROKEN angle before the hold is torn up and re-planned.
 *  Debounced on purpose: a teammate crossing the line is over in a few ticks
 *  and is not worth abandoning a good position for, while one who settles in
 *  it is. Three checks at HOLD_LOS_CHECK_TICKS. */
const HOLD_LOS_BROKEN_TICKS = 30;
/** A base soldier gives up a hold after this many ticks (60/s) without a fight
 *  ever starting — a hold is a bet that contact is coming, and if it doesn't pay
 *  off there's no point waiting on a dead angle. (DominationOracle opts out and
 *  runs its own objective vigil instead — see holdMaxTicks.) */
const HOLD_MAX_TICKS = 5 * 60;
/** ...and once it gives up, it won't re-dig-in for this long, so it actually
 *  goes and hunts rather than immediately re-entering the same fruitless hold. */
const HOLD_STALE_COOLDOWN = 4.5 * 60;

// --- REFLEX HOLD (principled, brief: watch after stepping out of cover) ------
/** The "asymmetry" a bot enjoys from a good angle: how much FARTHER the enemy is
 *  from seeing us (enemyVisDist) than we are from seeing anyone (visDist). High
 *  while peeking from cover — they must round the corner; we just lean out. When
 *  it drops by at least this many world px between contact scans, we just stepped
 *  out of that cover and gave the advantage away. */
const REFLEX_ASYM_DROP = 100;
/** ...and the drop only counts as "lost the cover" if what's LEFT is near parity
 *  (<= this). A 250px dip from a still-huge asymmetry isn't stepping out — it's
 *  still great cover — so gate on the residual, not the delta alone. */
const REFLEX_ASYM_KEEP = 50;
/** Only bother watching if contact is close: our own distance-until-sight must be
 *  under this (we can bring the angle back into view in a step). Past it, there's
 *  nothing imminent to watch for, so just keep moving. */
const REFLEX_VIS_MAX = 500;
/** The watch itself: hold the re-taken cover for ~2s, counted from ARRIVAL at the
 *  hold spot (the walk there doesn't burn the clock). If nobody shows by then,
 *  give it up and resume the fight. */
const REFLEX_HOLD_TICKS = 2 * 60;
/** Hard cap from the moment the reflex fires, so a bot that can't actually reach
 *  its cover doesn't watch forever while walking. Travel budget + the 2s watch. */
const REFLEX_MAX_TICKS = 2.5 * 60;
/** After a reflex hold ends (sighted, timed out, or bailed), it can't re-arm for
 *  this long — the bot stays in the fight. Longer than the watch, so a step-out /
 *  watch / step-out cycle can't run away with itself (the loop guard the plain
 *  anti-hold timer only approximates). */
const REFLEX_COOLDOWN = 1.5 * 60;

/** How close (world px) an out-of-ammo bot must get to a ground gun to grab it —
 *  its body touching the pickup's footprint (ITEM_RADIUS = 35). */
const PICKUP_RANGE = BODY_RADIUS + 35;

/** The reach of the gun `c` would FIGHT with — primary, else secondary, else
 *  whatever is in hand — independent of what it happens to be holding. A
 *  holstered sprinter (RUN equips the fists, whose reach is punching distance)
 *  must still be measured by the weapon it will draw, on both sides of a contact
 *  calculation: ours decides when we stop running, theirs decides how soon they
 *  could engage us. */
function fightingRangeOf(c: Character): number {
  const weapon = c.slots.primary ?? c.slots.secondary;
  return weapon ? weapon.feasibleRange : c.gun.feasibleRange;
}

/** px of wall `c` could punch through in a fight — the same "what it would fight
 *  with, not what's in its hands this instant" reading as fightingRangeOf, for
 *  the same reason: a hostile jogging up with its rifle holstered is still a
 *  rifle threat once it arrives. Its OWN sight checks use the gun in hand
 *  (Robot.wallbangBudget); this is for reasoning about somebody else. */
function fightingPenetrationOf(c: Character): number {
  return wallbangSightBudget(fightingRatingOf(c));
}

/** Reach of the weapon `c` is holding RIGHT NOW, and what it can shoot through.
 *  The counterpart to fightingRangeOf/fightingPenetrationOf, and the convention
 *  the reach cache uses on BOTH sides of a pair.
 *
 *  Why in-hand rather than "the weapon they'd draw": the cache's whole point is
 *  that a pair costs one query instead of two, and that only holds if my reading
 *  of your reach is the same number as your reading of your own. Your own sight
 *  checks use the gun in your hands (Robot.wallbangBudget), so that is the
 *  convention both ends have to speak. It also mixes less than what was here
 *  before, which asked for the FIGHTING range but the IN-HAND budget in the same
 *  call. The cost is a holstered sprinter reading as a weaker threat than the
 *  rifle on its back — acceptable because anyone in or near a fight has their
 *  weapon out, which is exactly when these numbers are consulted. */
function inHandRange(c: Character): number {
  return c.gun.feasibleRange;
}
function inHandBudget(c: Character): number {
  return wallbangSightBudget(c.gun.spec.penetration ?? 0);
}

/** A character's nearest walkable node, cached. `nearestWalkable` is an O(nodes)
 *  scan and the most expensive primitive in the AI (~24us measured), and the
 *  answer is a property of the CHARACTER, not of whoever is asking — so this is
 *  n entries shared by everyone rather than n^2. Deliberately used only by
 *  walkDist: plan() and contactScan derive their own, and retrofitting them
 *  would change routing decisions, not just their cost. */
interface NodeEntry {
  tick: number;
  node: number;
}
const nodeCache = new WeakMap<Character, NodeEntry>();
function nodeOf(ai: AiContext, c: Character): number {
  const nav = ai.nav;
  if (!nav || nav.nodes.length === 0) return -1;
  const hit = nodeCache.get(c);
  if (hit && ai.tick - hit.tick < REACH_CACHE_TICKS) return hit.node;
  const node = nav.nearestWalkable(ai.world, c.pos, c.z);
  nodeCache.set(c, { tick: ai.tick, node });
  return node;
}

/** Physical walking distance between two characters, cached BOTH ways: the graph
 *  is undirected on the plain metric, so one query answers for either end — a
 *  strictly better deal than the reach cache, which has to stay directional
 *  because the weapon differs by end. */
interface WalkEntry {
  tick: number;
  dist: number;
}
const walkCache = new WeakMap<Character, WeakMap<Character, WalkEntry>>();
function walkPut(a: Character, b: Character, tick: number, d: number): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    let row = walkCache.get(x);
    if (!row) {
      row = new WeakMap<Character, WalkEntry>();
      walkCache.set(x, row);
    }
    row.set(y, { tick, dist: d });
  }
}

/** One cached "distance until `from` could shoot `to`", stamped with the tick it
 *  was computed on. */
interface ReachEntry {
  tick: number;
  dist: number;
}
/** observer -> target -> entry. Weak on both axes so a dead or respawned
 *  character drops out on its own; nothing here is ever iterated. */
const reachCache = new WeakMap<Character, WeakMap<Character, ReachEntry>>();
/** How long a cached reach stays good. Matches CONTACT_EVAL_TICKS, which is the
 *  staleness contactScan already accepted for its own copy of this number. */
const REACH_CACHE_TICKS = CONTACT_EVAL_TICKS;

/** `c`'s raw penetration rating (what the damage curve is measured against),
 *  before the "worth shooting through" cut fightingPenetrationOf applies. */
function fightingRatingOf(c: Character): number {
  const weapon = c.slots.primary ?? c.slots.secondary;
  return (weapon ?? c.gun).spec.penetration ?? 0;
}

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
  protected readonly engageRange: number;
  private readonly semiAutoDelay: number;
  private readonly strafeOffsets: number[];
  /** Gun-readiness mode from updateMode (shoot when the burst/reload is ready,
   *  else cover). The acting posture (`mode`) equals this in combat, but RUN and
   *  HEAL override it (see updatePosture). */
  private combatMode: "shoot" | "cover" = "shoot";
  /** The posture actually fought this tick: normal combat (shoot/cover), RUN
   *  (holstered sprint to contact), HEAL (a committed heal — moves exactly like
   *  cover, but stays put using items instead of re-engaging), or HOLD (dug in
   *  on a pre-aimed angle, waiting for someone to walk into it). */
  protected mode: "shoot" | "cover" | "run" | "heal" | "hold" = "shoot";
  /** OUR distance-until-visibility to the quarry (route to a spot that sees it),
   *  refreshed each plan tick; drives RUN. */
  protected visDist = Infinity;
  /** The ENEMY's distance-until-visibility to US, minimised over ALL hostiles
   *  (the soonest ANYONE could see us) — what gates healing: it stays long while
   *  we're tucked in cover, whereas our own visDist snaps to 0 the instant they
   *  peek a lane we can see. Also gates the DominationOracle's HOLD_MAX vigil. */
  protected enemyVisDist = Infinity;
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
  /** Consecutive ticks the HOLD entry condition has held (see HOLD_COMMIT_TICKS). */
  private holdDwell = 0;
  /** Consecutive ticks spent dug in (mode === "hold"), for the give-up timeout
   *  (see holdMaxTicks). Resets whenever the posture isn't HOLD. */
  private holdTicks = 0;
  /** Ticks left before HOLD may be attempted again after a failed plan. */
  private holdRetryIn = 0;
  /** The frozen hold plan. `holdEntry` is where the enemy would step into view
   *  (the angle we're pre-aiming and the eye every exposure test rays from),
   *  `holdCover` the node it cannot see at all, `holdPeek` the spot just back
   *  out of that where only a sliver of us shows. Computed ONCE on entering the
   *  posture: the entry point is derived from the enemy's route to where we
   *  stand, so recomputing it as we move would chase its own tail. */
  private holdEntry: Vec2 | null = null;
  private holdCover: Vec2 | null = null;
  private holdPeek: Vec2 | null = null;
  /** Node id of `holdEntry`, so a refresh can tell "same angle, nothing to do"
   *  from "they're coming another way now". */
  private holdEntryNode = -1;
  /** Ticks until the held angle is re-tested (see HOLD_LOS_CHECK_TICKS). */
  private holdLosCheckIn = 0;
  /** Ticks the held angle has been broken for, across checks. Reset by any
   *  check that finds it clear, so only a SUSTAINED obstruction counts. */
  private holdLosBroken = 0;
  /** Ticks until the planted refresh (see HOLD_REPLAN_TICKS). */
  private holdReplanIn = HOLD_REPLAN_TICKS;
  /** Remaining node-to-node legs of the walk to `holdCover` (movable-linked, so
   *  each leg is a clear straight line). */
  private holdPath: Vec2[] = [];
  /** REFLEX HOLD state. `reflexAsym` is last tick's enemyVisDist - visDist, so a
   *  sharp drop can be detected; `reflexHold` marks the current hold as the brief
   *  principled watch (vs a strategic dig-in); `reflexArrived` latches once we're
   *  parked on the spot (the 2s clock only runs after that); `reflexWatchTicks`
   *  is that clock; `reflexAge` counts from the trigger (the travel+watch cap);
   *  `reflexCooldown` blocks re-arming so the watch can't loop. */
  private reflexAsym = Infinity;
  private reflexHold = false;
  private reflexArrived = false;
  private reflexWatchTicks = 0;
  private reflexAge = 0;
  private reflexCooldown = 0;
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
  protected focus: Character | null = null;
  private targetEvalIn = 0;
  /** Cached route-nearest hostile for blind navigation (see bestChase). */
  private chaseCache: Character | null = null;
  private chaseEvalIn = 0;
  /** A throwaway waypoint parked on the ground gun this bot is fetching while out
   *  of ammo (never in the world/roster), so navChase can steer toward it. */
  private rearmMarker: Character | null = null;
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
    // Out of bullets: everything else (fighting, holding, healing) is moot — go
    // fetch a loaded gun. Overrides the whole combat flow while it applies.
    if (this.rearm(ai)) return;
    if (this.focus && (this.focus.hp <= 0 || this.ticksSinceTarget > FOCUS_MEMORY)) {
      this.focus = null;
    }
    // Out of sight, the last engaged enemy stays the concern (cover is scored
    // against them, the chase heads back at them) until memory lapses.
    const chase = this.chaseOf(ai, target);
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
    this.updateMode(target ?? this.focus, target);
    this.updatePosture(ai, target); // may override the combat mode with HOLD / RUN / HEAL
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
    } else if (this.mode === "hold") {
      this.holdMove(ai);
    } else if (this.mode === "cover") {
      this.coverMove(ai, chase);
    } else if (target && target.z === this.z && dist(this.pos, target.pos) <= this.engageRange) {
      // Same level only. strafeMove ranks spots by the lane they give onto the
      // target, and scoreAt scores zero across levels — so an off-level target
      // left every candidate tied at nothing, strafeTarget null, and the bot
      // standing still admiring a floor. It belongs in the approach branch,
      // which routes over the graph and can actually use the stairs.
      this.strafeMove(ai, target);
    } else {
      // Approach: graph-chase into range (SHOOT out of sight / too far to trade)
      // or sprint to the objective (RUN) — one path, differing only in speed
      // (stepSpeed) and facing (facesTravel), both keyed off the mode. Veer out
      // of a teammate's lane first so we don't march in behind (and flag) them,
      // or wedge front-to-front converging on the same spot. General spacing is
      // postMove's job; this is path-specific.
      this.strafeTarget = null;
      // Same level only: the "lane" to an off-level chase is a straight line
      // through the floor — fiction. The walk there goes via stairs (usually
      // some other direction entirely), and there is no firing lane to keep
      // clear because the gun can't cross levels anyway. Sidestepping against
      // that phantom line marched pairs of bots away from their own waypoints
      // in lockstep at full speed, each "clearing" the other's nonexistent
      // lane, for hundreds of ticks (traced in scripts/probe_grind.mts).
      const blocker = chase.z === this.z ? this.blockingMate(ai, chase) : null;
      // Veer around a mate in the lane if there's room; if boxed in, drive
      // straight and let the squishy body collision phase us through.
      const engaging = target && target.z === this.z ? target : null;
      if (!blocker || !this.sidestep(ai, chase, blocker)) this.navChase(ai, chase, engaging);
    }
  }

  /** What to WALK toward this plan tick: the live target, else the remembered
   *  focus, else the best blind chase. Split from targeting so a subclass can
   *  keep shooting an enemy it refuses to walk after — see DominationOracle's
   *  pursuit leash, which redirects movement to the objective while the gun
   *  stays on a still-shootable runner. */
  protected chaseOf(ai: AiContext, target: Character | null): Character | null {
    return target ?? this.focus ?? this.bestChase(ai);
  }

  /** Between plan ticks (stagger): keep the gun's burst/reload/click bookkeeping
   *  live every tick — otherwise firing would stall — and continue the committed
   *  move (walk toward the strafe/cover spot, or coast the graph chase) without
   *  any candidate rescoring or path query. */
  protected override coast(ai: AiContext): void {
    this.vel = vec(0, 0);
    if (this.rearm(ai)) return; // keep walking to (or grabbing) the loaded gun between plans
    const target = this.lastTarget && this.lastTarget.hp > 0 ? this.lastTarget : null;
    this.updateMode(target ?? this.focus, target);
    this.updatePosture(ai, target); // keep the posture (and heal use) live between plans
    // HEAL: follow the committed retreat/cover spot, or hold — never coast toward
    // the enemy (that's the opposite of taking cover to heal).
    if (this.mode === "heal") {
      if (this.strafeTarget) this.stepToward(ai, this.strafeTarget);
      return;
    }
    // HOLD: keep walking the committed route (and keep the gun on the entry
    // point) between plans. Never re-plans here — the plan is frozen by design.
    if (this.mode === "hold") {
      if (this.holdEntry) {
        const ducked = this.reloadBlocksFire || !this.fireOk;
        this.followHold(ai, (ducked ? this.holdCover : this.holdPeek) ?? this.holdCover!);
        this.faceHold();
      }
      return;
    }
    // Mirror act's stand-to-shoot hold so a heavy gunner doesn't creep mid-burst.
    if (this.standToShoot(ai, target)) return;
    if (this.strafeTarget) {
      this.stepToward(ai, this.strafeTarget);
      return;
    }
    // Keep clearing a teammate's firing lane between plan ticks too (drive
    // straight if boxed — squishy collision phases through rather than freezing).
    // Same level only, as in act(): an off-level chase has no lane to clear.
    const chase = target ?? this.focus;
    const blocker = chase && chase.z === this.z ? this.blockingMate(ai, chase) : null;
    if (!chase || !blocker || !this.sidestep(ai, chase, blocker)) this.coastStep(ai);
  }

  /**
   * Is the gun genuinely out of action for reloading — i.e. is the reload a
   * commitment we'd have to abandon rather than simply interrupt?
   *
   * For a normal gun, yes: a mag swap is all-or-nothing and cancelling it wastes
   * the whole thing, so reloading means ducking. A `perBullet` gun inverts that.
   * Each cycle chambers one shell and banks it, and `Gun.fire` cancels an
   * in-progress cycle for free the moment there's something to shoot at — so as
   * long as a round IS chambered, topping off costs nothing and the gun is still
   * live. Only a dry one (mag 0, nothing to interrupt with) is really out.
   */
  private get reloadBlocksFire(): boolean {
    const g = this.gun;
    if (!g.reloading) return false;
    return !(g.spec.fire?.perBullet && g.mag > 0);
  }

  /** Burst / reload bookkeeping -> which mode this tick is fought in, with
   *  readiness changes acknowledged reactionTime late (see fireOk). `ref` is
   *  whoever the spray is being judged against (target, or remembered focus);
   *  `target` is the live, currently-visible one, which is what the top-off
   *  decision below turns on. */
  private updateMode(ref: Character | null, target: Character | null): void {
    const gun = this.gun;
    if (gun.currentRecoil === 0) this.burstDone = false;
    else if (ref) {
      // Spray envelope (radians) vs the body's angular width at this range:
      // past that, the expected per-shot hit odds drop under 1/lambda.
      const envelope = gun.spec.recoilCoef ** 2 * Math.sqrt(gun.currentRecoil);
      if (envelope > this.aimWidth(dist(this.pos, ref.pos))) this.burstDone = true;
    }
    // When to reload. Hardcore mag swaps bin whatever was left in the mag, so a
    // normal gun only ever swaps dry. A perBullet gun has the opposite economics
    // — a cycle banks one shell and firing interrupts it for free — so it tops off
    // at every lull instead, and walks into the next fight with a full tube rather
    // than whatever it happened to stop shooting on. Either way it still reloads
    // when it MUST (dry). All no-ops if the mag is full, spares are out, a reload
    // is already running, or the fire delay hasn't elapsed.
    const topsOff = gun.spec.fire?.perBullet === true;
    if (gun.mag === 0 || (topsOff && !target)) gun.startReload();
    if (this.clickIn > 0) this.clickIn -= 1;

    const ready = !this.burstDone && !this.reloadBlocksFire;
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
   *   - HOLD (dug in on an angle): nothing in sight but a fight is plausibly
   *     coming, and there is cover here worth waiting behind (see wantsHold).
   *     Above RUN so an objective-holder doesn't sprint off the thing it's
   *     guarding; for the base TacOracle the two are mutually exclusive anyway
   *     (HOLD wants contact nearer than RUN_DISTANCE, RUN wants it further).
   *   - RUN (holstered sprint): no heal wanted, but contact is far off
   *     (>= RUN_DISTANCE).
   *   - otherwise the combat mode (shoot / cover). */
  private updatePosture(ai: AiContext, target: Character | null): void {
    // Entry conditions, and how long each has held continuously (a-priori dwell):
    // the distance must stay safe for the commit period before we hand over to
    // RUN / HEAL, so a peeker whipsawing the distance keeps resetting the dwell
    // and never triggers either — no reactive lockout needed.
    const fightDist = Math.min(this.visDist, this.enemyVisDist); // soonest a fight can start
    const runSafe = fightDist >= RUN_DISTANCE;
    const healSafe = this.hp < HEAL_HP && this.canHeal() && this.enemyVisDist >= HEAL_SAFE_DISTANCE;
    // RUN's dwell does NOT charge while dug in. RUN and HOLD move in opposite
    // directions, so a HOLD that ends would otherwise hand straight over to a RUN
    // whose "a-priori commitment" was quietly filling the whole time it was dug in
    // — the dwell gated nothing between them and the pair ping-ponged: run in, dig
    // in, walk back to cover, run in again. Now leaving HOLD drops to combat and
    // RUN has to earn its 90 ticks afresh. (Not mirrored on holdDwell — see below.)
    this.runDwell = runSafe && this.mode !== "hold" ? this.runDwell + 1 : 0;
    this.healDwell = healSafe ? this.healDwell + 1 : 0;

    // HEAL is a committed mode: enter only after the dwell, exit instantly on the
    // alarm (safety) / topped off / out of items. The 700>400 gap is the stay
    // hysteresis; the dwell is the entry commitment.
    const healing =
      this.mode === "heal"
        ? this.enemyVisDist >= HEAL_ALARM_DISTANCE && this.hp < this.maxHp && this.canHeal()
        : healSafe && this.healDwell >= HEAL_COMMIT_TICKS;

    // HOLD: same dwell-to-enter / condition-to-stay shape. A failed plan parks
    // it for HOLD_RETRY_TICKS so we don't re-run the search every tick against
    // geometry that offers nothing.
    if (this.holdRetryIn > 0) this.holdRetryIn -= 1;
    // Give up a hold that's dragged on without a fight ever starting: it was a bet
    // that contact was coming, and it hasn't paid off. Park the posture (via the
    // retry cooldown) so the bot goes and hunts instead of re-digging-in on the
    // same dead angle. holdMaxTicks() is Infinity for DominationOracle, which runs
    // its own objective vigil instead.
    if (this.mode === "hold" && this.holdTicks >= this.holdMaxTicks()) {
      this.holdRetryIn = Math.max(this.holdRetryIn, HOLD_STALE_COOLDOWN);
    }
    // The brief principled watch after stepping out of cover — a combat reflex
    // orthogonal to the strategic hold below, so it's OR'd into wantHold and runs
    // for soldiers and objective bots alike (both share this updatePosture).
    const reflexHolding = this.reflexHoldWanted(ai, target);
    const holdSafe = !healing && this.holdRetryIn === 0 && this.wantsHold(ai, target);
    // NB: this one charges during RUN on purpose. RUN has no completion condition
    // — arriving doesn't change fightDist, so a bot that reaches its destination
    // just stands there holstered — and HOLD taking over is exactly what ends it.
    // Blocking that (the mirror of the runDwell rule below) deadlocks RUN.
    this.holdDwell = holdSafe ? this.holdDwell + 1 : 0;
    // Commit only once a plan actually EXISTS. Entering on the dwell alone and
    // discovering in holdMove that there is no cover here meant the posture was
    // taken, abandoned, and retaken on a ~90-tick cycle — the bot visibly running
    // in, stopping, and running off again. Building the plan at the transition
    // costs nothing extra: holdMove reuses it.
    const wantHold =
      reflexHolding ||
      (holdSafe &&
        (this.mode === "hold" || (this.holdDwell >= HOLD_COMMIT_TICKS && this.tryPlanHold(ai))));

    // RUN: stay while still safe; enter only after the dwell.
    const wantRun =
      !healing && !wantHold && runSafe && (this.mode === "run" || this.runDwell >= RUN_COMMIT_TICKS);
    // A committed reload is a self-known, vulnerable moment: drop to cover at once
    // (reflexively, like the burst cutoff) instead of holding a firing lane while
    // the mag swaps — don't wait out the reaction delay that gates the normal
    // shoot<->cover flip. combatMode still catches up on its own timer underneath.
    // A perBullet gun topping off with a shell up isn't committed to anything (see
    // reloadBlocksFire) and holds its lane, ready to interrupt and shoot.
    // HOLD does its own ducking (it falls back to full cover while the gun is
    // out of action), so it doesn't want the generic reload->cover override
    // dragging it off its angle.
    const combat = this.reloadBlocksFire ? "cover" : this.combatMode;
    const mode: "shoot" | "cover" | "run" | "heal" | "hold" = healing
      ? "heal"
      : wantHold
        ? "hold"
        : wantRun
          ? "run"
          : combat;

    if (mode !== this.mode) {
      if (this.mode === "heal") this.cancelUse(); // leaving a heal drops a half-finished use
      if (this.mode === "hold") this.clearHold(); // the plan is only valid for the spot it was made at
      this.mode = mode;
      this.strafeTarget = null;
      this.evalIn = 0;
    }
    // Track time dug in for the give-up timeout; any non-HOLD tick resets it.
    this.holdTicks = this.mode === "hold" ? this.holdTicks + 1 : 0;
    this.applyPostureSlot();
  }

  /** How many consecutive ticks the bot will wait in a hold before giving up and
   *  going to hunt. The base soldier bets a fight is coming; if it never does, it
   *  stops waiting. DominationOracle returns Infinity — it holds objectives on its
   *  own schedule (the HOLD_MAX vigil in its wantsHold), not this give-up timer. */
  protected holdMaxTicks(): number {
    return HOLD_MAX_TICKS;
  }

  /** Is there a hold to be had here? Builds the plan if there isn't one yet, and
   *  on failure parks the posture for HOLD_RETRY_TICKS instead of letting the
   *  caller commit to something it can't do. Called only at the moment of
   *  entering HOLD, so the search runs at most once per retry window. */
  private tryPlanHold(ai: AiContext): boolean {
    if (this.holdEntry) return true; // a plan is already standing
    const threat = this.holdThreat(ai);
    if (threat && this.planHold(ai, threat)) return true;
    this.holdRetryIn = HOLD_RETRY_TICKS;
    this.holdDwell = 0;
    return false;
  }

  /** Are we parked on the planted hold spot (either end of the cover<->peek
   *  slide, and not mid-walk)? Mirrors holdMove's own "parked" test; it's what
   *  starts the reflex watch clock — the 2s is measured from arrival, not entry. */
  private atHoldPoint(): boolean {
    if (this.holdEntry === null || this.holdPath.length !== 0) return false;
    return (
      (this.holdCover !== null && dist(this.pos, this.holdCover) <= HOLD_ARRIVE) ||
      (this.holdPeek !== null && dist(this.pos, this.holdPeek) <= HOLD_ARRIVE)
    );
  }

  /** The principled "reflex" hold. When asymmetry (enemyVisDist - visDist) drops
   *  sharply between contact scans, the bot just stepped out of a strong cover
   *  angle; if contact is still near and unseen, it ducks back to cover (reusing
   *  the strategic hold's cover/peek plan) and watches the sightline for ~2s from
   *  arrival. A sighting ends it into the fight; a timeout resumes combat; either
   *  way it can't re-arm for REFLEX_COOLDOWN, so the step-out/watch cycle can't
   *  loop. Returns whether this tick should be a reflex hold; also owns all the
   *  reflex bookkeeping (asymmetry sample, clocks, cooldown). */
  private reflexHoldWanted(ai: AiContext, target: Character | null): boolean {
    if (this.reflexCooldown > 0) this.reflexCooldown -= 1;

    // Roll the asymmetry sample forward. Infinity (no chase / in contact both 0's
    // cancel to 0, but then a target is usually up) simply can't produce a drop.
    const prev = this.reflexAsym;
    const asym = this.enemyVisDist - this.visDist;
    this.reflexAsym = Number.isFinite(asym) ? asym : Infinity;

    // Continue an in-progress watch: latch arrival, run the 2s clock from there,
    // and end on a sighting, timeout, the travel+watch cap, or being yanked into
    // another mode (heal, a forced combat drop). Ending arms the cooldown.
    if (this.reflexHold) {
      this.reflexAge += 1;
      if (!this.reflexArrived && this.atHoldPoint()) this.reflexArrived = true;
      if (this.reflexArrived) this.reflexWatchTicks += 1;
      const done =
        this.mode !== "hold" ||
        target !== null ||
        this.reflexWatchTicks >= REFLEX_HOLD_TICKS ||
        this.reflexAge >= REFLEX_MAX_TICKS;
      if (done) {
        this.reflexHold = false;
        this.reflexCooldown = REFLEX_COOLDOWN;
        return false;
      }
      return true;
    }

    // Fresh trigger: a sharp drop that leaves the advantage near parity, contact
    // close enough to watch, nobody in sight yet, off cooldown, not already dug
    // in — and cover actually available to duck into.
    if (
      target === null &&
      this.reflexCooldown === 0 &&
      this.mode !== "hold" &&
      Number.isFinite(prev) &&
      Number.isFinite(this.reflexAsym) &&
      prev - this.reflexAsym >= REFLEX_ASYM_DROP &&
      this.reflexAsym <= REFLEX_ASYM_KEEP &&
      this.visDist <= REFLEX_VIS_MAX &&
      this.tryPlanHold(ai)
    ) {
      this.reflexHold = true;
      this.reflexArrived = false;
      this.reflexWatchTicks = 0;
      this.reflexAge = 0;
      return true;
    }
    return false;
  }

  /** Should this tick be spent dug in on an angle? The base soldier holds when
   *  nothing is in sight but contact is near enough to be worth waiting for —
   *  nearer than the RUN threshold, which is what separates "they're coming"
   *  from "they're nowhere near, go find them". Whether there is actually cover
   *  to hold is settled by planHold; a failure parks the posture (holdRetryIn).
   *  DominationOracle overrides this to hold the point it's standing on. */
  protected wantsHold(_ai: AiContext, _target: Character | null): boolean {
    // The base soldier no longer digs in on a distance band. "An enemy is vaguely
    // near, so hold for a few seconds" was the random-feeling hold we're replacing:
    // soldiers now hold ONLY via the principled reflex watch (reflexHoldWanted),
    // which enters hold mode directly through wantHold. Returning false here also
    // closes the path by which a reflex hold could bleed into an open-ended
    // strategic one. DominationOracle overrides this with real point-defense holds.
    return false;
  }

  /** May a hold spot sit here? Unrestricted for a plain soldier; the objective
   *  AI uses it to refuse cover that would take it off a capture point. */
  protected holdSpotOk(_ai: AiContext, _pos: Vec2, _z: number): boolean {
    return true;
  }

  private clearHold(): void {
    this.holdEntry = null;
    this.holdCover = null;
    this.holdPeek = null;
    this.holdEntryNode = -1;
    this.holdPath = [];
    this.holdReplanIn = HOLD_REPLAN_TICKS;
    this.holdLosCheckIn = 0;
    this.holdLosBroken = 0;
  }

  /** Taking damage from an enemy while dug in breaks the hold into SHOOT: a hold
   *  is a bet on where they'd appear, and a round landing means they came in on
   *  an angle we weren't watching — keep fighting from a broken angle and the
   *  next rounds land too. The retry cooldown stops it re-digging into the same
   *  wrong angle while still under fire. Friendly fire / ownerless damage leaves
   *  the hold standing: neither says the angle failed. */
  override registerHit(
    dir: Vec2,
    point: Vec2,
    damage: number,
    armorPen: ArmorPen,
    attacker: Hittable | null = null,
    gun: GunSpec | null = null,
    marks: HitMarks = {},
    heading: Vec2 = dir,
  ): void {
    // Forward EVERYTHING: this override once passed six of seven arguments and
    // quietly dropped the wallbang flag for every bot victim in the game.
    super.registerHit(dir, point, damage, armorPen, attacker, gun, marks, heading);
    if (this.mode !== "hold" || damage <= 0) return;
    if (!(attacker instanceof Character) || !areHostile(this.team, attacker.team)) return;
    this.clearHold();
    this.mode = "shoot";
    this.holdDwell = 0;
    this.holdTicks = 0;
    this.holdRetryIn = Math.max(this.holdRetryIn, HOLD_RETRY_TICKS);
    this.strafeTarget = null;
    this.evalIn = 0;
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

  /** The reach of the gun this soldier would actually FIGHT with — the same slot
   *  equipWeapon picks — regardless of what happens to be in its hands right now.
   *
   *  The contact metrics have to use this, not `gun.feasibleRange`. RUN holsters
   *  to the fists, whose reach is punching distance (~138px), so measuring with
   *  the held weapon told a sprinting bot "you are not in contact until you can
   *  touch them" — its own distance-until-contact stayed enormous all the way in,
   *  and the only thing ending the sprint was the ENEMY's reach-to-us. That's why
   *  a runner got surprised: it re-armed on seeing someone rather than on being
   *  about to be in a fight, which is the entire point of the metric. */
  private get fightingRange(): number {
    return fightingRangeOf(this);
  }

  /** Re-equip the best available weapon: a LOADED gun first (primary over
   *  secondary), so a fresh pickup or a spare gets used instead of an empty slot;
   *  then any gun; then fists. */
  private equipWeapon(): void {
    if (TacOracle.loaded(this.slots.primary)) this.equip("primary");
    else if (TacOracle.loaded(this.slots.secondary)) this.equip("secondary");
    else if (this.slots.primary) this.equip("primary");
    else if (this.slots.secondary) this.equip("secondary");
    else this.equip("hand");
  }

  /** A gun with rounds left to fire (in the mag or a spare) — fists/empty are not. */
  private static loaded(g: Gun | null): boolean {
    return !!g && (g.mag > 0 || g.reserveMags > 0);
  }

  /** Out of bullets when neither the primary nor the secondary has ammo (only
   *  fists left). Melee doesn't count — that's the whole point of rearming. */
  private outOfAmmo(): boolean {
    return !TacOracle.loaded(this.slots.primary) && !TacOracle.loaded(this.slots.secondary);
  }

  /** Walk the currently-out-of-ammo bot to the nearest ground gun that still has
   *  rounds and pick it up. Returns true if this tick was spent rearming, so the
   *  caller skips the (weaponless) combat flow. Never routes to an empty gun, so
   *  bots don't loop picking up and dropping dry weapons. */
  private rearm(ai: AiContext): boolean {
    if (!this.outOfAmmo()) {
      this.rearmMarker = null;
      return false;
    }
    const gun = this.nearestLoadedGun(ai);
    if (!gun) return false; // nothing to fetch: fall through to the fists fallback
    if (gun.z === this.z && dist(this.pos, gun.pos) <= PICKUP_RANGE) {
      this.grabGun(ai, gun);
      this.rearmMarker = null;
      return true;
    }
    // Steer to it over the graph via a marker parked on the gun (standoff 0, so we
    // walk right onto it — see standoffFor).
    const m = (this.rearmMarker ??= new Character(vec(0, 0), this.skin, { hand: new Gun(UNARMED) }));
    m.pos = vec(gun.pos.x, gun.pos.y);
    m.z = gun.z;
    m.hp = 1;
    if (this.mode === "hold") this.clearHold(); // drop any stale hold plan
    this.navChase(ai, m, null);
    return true;
  }

  /** The nearest ground gun with ammo, by walk route (falling back to straight
   *  line on the bot's own level when there's no graph). Empty guns are skipped. */
  private nearestLoadedGun(ai: AiContext): GunItem | null {
    const nav = ai.nav;
    const myNode = nav ? nav.nearestWalkable(ai.world, this.pos, this.z) : -1;
    let best: GunItem | null = null;
    let bestCost = Infinity;
    for (const it of ai.world.items) {
      if (!(it instanceof GunItem) || !TacOracle.loaded(it.gun)) continue;
      let cost: number;
      if (nav && myNode >= 0) {
        const goal = nav.nearestWalkable(ai.world, it.pos, it.z);
        if (goal < 0) continue;
        if (goal === myNode) cost = dist(this.pos, it.pos);
        else {
          const r = nav.route(myNode, goal);
          if (!r) continue; // unreachable: don't pick a gun we can't get to
          cost = r.dist;
        }
      } else {
        if (it.z !== this.z) continue;
        cost = dist(this.pos, it.pos);
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = it;
      }
    }
    return best;
  }

  /** Take `gun` off the ground: pull it from the world, holster it (dropping the
   *  empty gun it replaces back onto the ground), and equip it so the bot fights
   *  with it immediately. */
  private grabGun(ai: AiContext, item: GunItem): void {
    const items = ai.world.items;
    const idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    const slot: "primary" | "secondary" = item.gun.spec.primary ? "primary" : "secondary";
    const dropped = this.holster(item.gun);
    if (dropped) items.push(dropped.getGroundItem(vec(this.pos.x, this.pos.y), vec(0, 0), this.z));
    this.equip(slot);
  }

  /** Walk right onto the ground gun being fetched (no combat standoff for the
   *  rearm marker); everything else keeps the base fighting standoff. */
  protected override standoffFor(chase: Character): number {
    return chase === this.rearmMarker ? 0 : super.standoffFor(chase);
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
    if (this.strafeTarget) this.stepToward(ai, this.strafeTarget);
  }

  /** HOLD movement: get to the committed spot and sit on it, gun already on the
   *  entry point. While the gun is out of action (reloading, or the burst is
   *  spent) it ducks all the way behind cover and slides back out to the peek
   *  once it's ready again — the same peek cycle COVER has, but rehearsed
   *  against a doorway instead of reacting to a body. */
  private holdMove(ai: AiContext): void {
    if (!this.holdEntry) {
      const threat = this.holdThreat(ai);
      if (!threat || !this.planHold(ai, threat)) {
        // Nothing here worth holding: park the posture and let the normal
        // approach take over next tick.
        this.holdRetryIn = HOLD_RETRY_TICKS;
        this.holdDwell = 0;
        return;
      }
    }
    const ducked = this.reloadBlocksFire || !this.fireOk;
    const dest = () => (ducked ? this.holdCover : this.holdPeek) ?? this.holdCover!;
    // On station? Then it's safe to re-check who's coming and from where. "On
    // station" means parked at EITHER end of the cover<->peek slide, not just at
    // whichever one the gun state currently wants: a reload flips `dest` under
    // us, and gating on that alone starved the timer.
    const parked =
      this.holdPath.length === 0 &&
      (dist(this.pos, this.holdCover!) <= HOLD_ARRIVE || dist(this.pos, this.holdPeek!) <= HOLD_ARRIVE);
    if (parked) {
      // Advance by `stagger`, not 1: holdMove only runs on plan ticks, so a raw
      // decrement makes the period stagger times longer than it reads (10s at the
      // default 5, which is why this looked like it never refreshed at all).
      // Same trick decide() uses to keep its tick-denominated clocks in real time.
      this.holdReplanIn -= this.stagger;
      if (this.holdReplanIn <= 0) {
        this.holdReplanIn = HOLD_REPLAN_TICKS;
        const threat = this.holdThreat(ai);
        if (threat) this.refreshHold(ai, threat);
      }
    }
    if (this.angleBroken(ai)) return; // hold torn up; nothing to walk to or face
    this.followHold(ai, dest());
    this.faceHold();
  }

  /** Is the angle we're dug in on still a real angle, and if it has stopped
   *  being one, tear the hold up. Returns whether the plan is now gone.
   *
   *  The plan is checked at the PEEK, not at wherever we happen to be standing.
   *  The cover spot cannot see the entry — that is what makes it cover — so
   *  testing from `this.pos` reports a break every time the bot ducks to reload.
   *  `shootingLaneClear` is the same predicate peekSpot used to accept the spot
   *  in the first place, so this asks exactly "would we still choose this?".
   *
   *  Debounced over HOLD_LOS_BROKEN_TICKS. A teammate crossing the line is gone
   *  in a few ticks and re-planning for them would throw away a good position
   *  for nothing; one who stops in it is worth moving for. Any clear check
   *  resets the count, so only a sustained break spends a rebuild.
   *
   *  On a confirmed break: rebuild past the same-node bail (the enemy still
   *  comes from the same door, so the entry node is usually unchanged — what
   *  needs re-deriving is the cover and peek around it). If nothing better
   *  exists, drop the hold entirely rather than keep watching a door we cannot
   *  see: the normal approach then takes over, and HOLD_RETRY_TICKS stops it
   *  from dug back into the same dead angle immediately. */
  private angleBroken(ai: AiContext): boolean {
    this.holdLosCheckIn -= this.stagger;
    if (this.holdLosCheckIn > 0) return false;
    this.holdLosCheckIn = HOLD_LOS_CHECK_TICKS;
    const peek = this.holdPeek;
    const clear =
      peek === null || this.holdEntry === null || this.shootingLaneClear(ai, peek, this.holdEntry);
    if (clear) {
      this.holdLosBroken = 0;
      return false;
    }
    this.holdLosBroken += HOLD_LOS_CHECK_TICKS;
    if (this.holdLosBroken < HOLD_LOS_BROKEN_TICKS) return false;
    this.holdLosBroken = 0;
    const threat = this.holdThreat(ai);
    if (threat && this.refreshHold(ai, threat, true)) return false; // re-planned in place
    this.clearHold();
    this.holdRetryIn = HOLD_RETRY_TICKS;
    this.holdDwell = 0;
    return true;
  }

  /** Planted refresh: re-derive where the nearest enemy would now enter view.
   *  If it's the same node the plan is already built around, nothing happens at
   *  all — so a settled soldier can't be jittered between two equally good spots
   *  by a timer. A genuinely different approach rebuilds cover and peek around
   *  it, and a rebuild that fails leaves the old plan untouched (planFromEntry
   *  only commits on success).
   *
   *  `force` skips the same-node bail, for the case where the approach hasn't
   *  changed but the plan built on it has gone bad anyway — see the broken-angle
   *  check in holdMove. Measured: dropping the bail for ALL refreshes (and
   *  halving the timer) moved the fouling rate not at all (-2.6%, t=-0.27 over
   *  70 paired runs) while adding 9% more walking during holds, because the
   *  extra rebuilds were re-deriving against the enemy, not the obstruction. */
  private refreshHold(ai: AiContext, threat: Character, force = false): boolean {
    const entry = this.findEntry(ai, threat);
    if (entry === null || (!force && entry.node === this.holdEntryNode)) return false;
    return this.planFromEntry(ai, entry);
  }

  /** Build the hold plan and freeze it. Three steps, in the order they depend on
   *  each other:
   *
   *   1. ENTRY POINT — walk the route the enemy would take to reach us and stop
   *      at the first node we can see. That's where they step into view, so
   *      it's the angle worth pre-aiming.
   *   2. COVERED POINT — the nearest node (by walking distance from our own,
   *      searched outward) that the entry point CANNOT see. Because the search
   *      settles nodes in distance order, every node reached before it was
   *      rejected for being visible from the entry — including its own
   *      predecessor on the route, which is what makes step 3 well-defined.
   *   3. PEEK SPOT — slide from the covered node back toward that predecessor
   *      until a sliver of us is exposed to the entry point.
   *
   *  Returns false when the level offers no such geometry (no graph, no route,
   *  no cover in range), leaving HOLD to lapse. */
  private planHold(ai: AiContext, threat: Character): boolean {
    const entry = this.findEntry(ai, threat);
    return entry !== null && this.planFromEntry(ai, entry);
  }

  /** STEP 1 — the entry point: where on their way in the enemy first comes into
   *  view. Walk the route from the threat's node toward ours and take the first
   *  node we can see; then refine, because they do not pop into view AT that node
   *  — they come round the corner somewhere along the leg before it, and a bot
   *  aimed at the node is aimed late by up to a whole hop.
   *
   *  So step along the leg from the node BEFORE the visible one (or, if the
   *  visible node is where they already stand, from the enemy themselves — they
   *  can walk straight at it) and stop at the first point that is in view. That
   *  point is the angle worth pre-aiming.
   *
   *  The node is kept alongside it as the plan's identity: the refined position
   *  wobbles as the enemy moves, and a refresh that compared positions would
   *  rebuild constantly, where comparing nodes only rebuilds on a real change of
   *  approach. Null if there's no graph, no route, or nothing on it in sight. */
  private findEntry(ai: AiContext, threat: Character): { node: number; pos: Vec2 } | null {
    return profiler.measure("ai.hold", () => {
      const nav = ai.nav;
      if (!nav || nav.nodes.length === 0) return null;
      const myNode = nav.nearestWalkable(ai.world, this.pos, this.z);
      const enemyNode = nav.nearestWalkable(ai.world, threat.pos, threat.z);
      if (myNode < 0 || enemyNode < 0) return null;
      let cur = enemyNode;
      let prev = -1;
      for (let hop = 0; hop <= HOLD_PATH_HOPS; hop++) {
        const nd = nav.nodes[cur];
        // A lane a teammate is stood in isn't an angle worth holding — walking on
        // to the next node picks the first spot we could actually engage them at.
        if (nd.z === this.z && this.shootingLaneClear(ai, this.pos, nd.pos)) {
          const from = prev >= 0 ? nav.nodes[prev].pos : threat.pos;
          return { node: cur, pos: this.firstVisibleAlong(ai, from, nd.pos) };
        }
        if (cur === myNode) break;
        const step = nav.route(cur, myNode);
        if (!step) break;
        prev = cur;
        cur = step.next;
      }
      return null;
    });
  }

  /** March `from` -> `to` and return the first point on it we can see. `to` is
   *  known to be visible, so the walk always terminates there at worst; anything
   *  earlier is a strictly better (earlier) sighting of someone walking in. */
  private firstVisibleAlong(ai: AiContext, from: Vec2, to: Vec2): Vec2 {
    const total = dist(from, to);
    if (total < 1e-3) return vec(to.x, to.y);
    const dir = norm(sub(to, from));
    for (let d = 0; d < total; d += HOLD_ENTRY_STEP) {
      const p = add(from, scale(dir, d));
      if (this.shootingLaneClear(ai, this.pos, p)) return p;
    }
    return vec(to.x, to.y);
  }

  /** STEPS 2 & 3 — given the entry point, find the cover that beats it and the
   *  peek back out of that cover, and commit the plan. Only mutates on success,
   *  so a failed refresh leaves the working plan in place. */
  private planFromEntry(ai: AiContext, entry: { node: number; pos: Vec2 }): boolean {
    return profiler.measure("ai.hold", () => {
      const nav = ai.nav;
      if (!nav || entry.node < 0 || entry.node >= nav.nodes.length) return false;
      const myNode = nav.nearestWalkable(ai.world, this.pos, this.z);
      if (myNode < 0) return false;
      const entryPos = entry.pos;

      // 2. Nearest node the entry point can't see, Dijkstra'd outward from ours
      //    over movable links. Two-stage test, because the baked `visible` set
      //    is centre-to-centre while what has to be hidden is a BODY: a node
      //    whose centre is behind the corner still hangs a shoulder out past it.
      //    So the map is only a cheap reject (centre visible => body certainly
      //    is), and a candidate that survives it pays 5 rays to confirm all five
      //    body points are hidden. The map is static geometry, so it can only
      //    under-report cover (a parked car it doesn't know about), never invent
      //    it — and the confirming rays are live, which covers that gap too.
      const distTo = new Map<number, number>([[myNode, 0]]);
      const prev = new Map<number, number>();
      const settled = new Set<number>();
      let covered = -1;
      let peek: Vec2 | null = null;
      for (let i = 0; i < HOLD_SEARCH_NODES; i++) {
        let pick = -1;
        let pickD = Infinity;
        for (const [id, d] of distTo) {
          if (!settled.has(id) && d < pickD) {
            pickD = d;
            pick = id;
          }
        }
        if (pick < 0 || pickD > HOLD_COVER_DISTANCE) break;
        settled.add(pick);
        const node = nav.nodes[pick];
        if (
          this.holdSpotOk(ai, node.pos, node.z) &&
          !this.mateHolding(ai, node.pos) &&
          // Raw geometry here, deliberately: a teammate blocks a FIRING lane but
          // is never cover (same rule scoreAt applies), so the shooting-lane test
          // used for the entry and the peek must not be used for hiding.
          // (The baked node `visible` set can't pre-reject any more — the entry is
          // a point on a leg now, not a node — so this is one live ray per
          // settled candidate, which is what makes the refinement affordable.)
          !losClear(ai.world, node.pos, entryPos, this.z)
        ) {
          // 3. Cover is only worth taking if there's a spot on the way in that
          //    still SEES the door. Scan the last leg — from the node we'd come
          //    in on (which can see it) toward this one (which can't) — and take
          //    the deepest spot before the line closes. If this cover can't
          //    produce one, keep searching rather than commit to a blind vigil.
          const back = prev.get(pick);
          const from = back !== undefined ? nav.nodes[back].pos : this.pos;
          const p = this.peekSpot(ai, from, node.pos, entryPos);
          if (p) {
            covered = pick;
            peek = p;
            break;
          }
        }
        for (const [nb, w] of node.movable) {
          if (nav.nodes[nb].z !== this.z) continue; // an angle is held on one level
          const alt = pickD + w;
          if (alt < (distTo.get(nb) ?? Infinity)) {
            distTo.set(nb, alt);
            prev.set(nb, pick);
          }
        }
      }
      if (covered < 0 || !peek) return false;

      // The legs from here to cover, in walking order — but ending at the PEEK,
      // not at the covered node. The peek sits on the final leg (between the node
      // we come in on and the cover), so walking all the way in and then back out
      // to it is a visible wasted trip. The cover itself is still where a reload
      // ducks to; it just isn't on the way in any more.
      const path: Vec2[] = [];
      for (let at = covered; at !== myNode; ) {
        path.push(nav.nodes[at].pos);
        const p = prev.get(at);
        if (p === undefined) break;
        at = p;
      }
      path.reverse();
      if (path.length > 0) path[path.length - 1] = peek;

      const coverPos = nav.nodes[covered].pos;
      this.holdEntry = vec(entryPos.x, entryPos.y);
      this.holdEntryNode = entry.node;
      this.holdCover = vec(coverPos.x, coverPos.y);
      this.holdPeek = peek;
      this.holdPath = path;
      return true;
    });
  }

  /** Is this cover spot already taken by a teammate — either standing on it, or
   *  committed to it and still walking there? One node fits one body, so without
   *  this two soldiers holding the same corridor both pick the same best node and
   *  spend the fight shoving each other off it (the squishy body separation keeps
   *  pushing them apart, and both keep walking back).
   *
   *  Checking only bodies wasn't enough: the spot is claimed the moment a mate
   *  PLANS it, and the walk there can take a second, so a bot planning in that
   *  window would pick the same node and both would arrive on top of each other.
   *  A hold's cover and peek are both reserved — the peek is where the body
   *  actually ends up. Claims are released by clearHold when the posture ends.
   *
   *  Cheap enough per candidate: it only runs for spots that already passed the
   *  visibility filters. */
  private mateHolding(ai: AiContext, spot: Vec2): boolean {
    const taken = (p: Vec2 | null): boolean => p !== null && dist(p, spot) < 2 * BODY_RADIUS;
    for (const c of ai.characters) {
      if (c === this || c.hp <= 0 || c.z !== this.z || areHostile(this.team, c.team)) continue;
      if (dist(c.pos, spot) < 2 * BODY_RADIUS) return true; // standing on it
      // `private` is class-scoped in TS, so a TacOracle may read another's plan.
      if (c instanceof TacOracle && c.mode === "hold" && (taken(c.holdCover) || taken(c.holdPeek))) {
        return true; // claimed by a mate already on their way
      }
    }
    return false;
  }

  /** Slide from full cover toward `toward` in small steps and stop where we can
   *  actually WATCH the entry point: a clear line from our centre to `eye`.
   *
   *  The centre specifically, not "any part of us exposed". Every sight and
   *  firing check this AI makes rays from `this.pos` — the centre is the eye — so
   *  a spot that only pokes a bounding-box corner past the corner of a wall is
   *  the worst of both worlds: they can see our shoulder and we can see nothing.
   *  That is a bot standing guard over a door it cannot see.
   *
   *  Partial cover still falls out of it: the first step whose centre clears the
   *  corner is by construction the least-exposed one that can see, so the body is
   *  typically still half behind the wall. Null if the whole way out stays blind,
   *  which disqualifies this cover entirely (see planFromEntry). */
  private peekSpot(ai: AiContext, from: Vec2, toward: Vec2, eye: Vec2): Vec2 | null {
    const total = dist(from, toward);
    if (total < 1e-3) return null;
    const dir = norm(sub(toward, from));
    // Advance INTO cover and stop the step before the sight line breaks. `from`
    // is always a spot that can see `eye` (the predecessor was rejected for being
    // visible, and our own position had to see the entry for it to be chosen), so
    // the scan starts seeing and ends blind — the last seeing step is the
    // deepest-in-cover spot that still watches the door. Scanning this way round
    // also guarantees the spot is contiguously visible from the side we approach
    // on, instead of one that happens to see past a blind stretch.
    let best: Vec2 | null = null;
    for (let d = 0; d <= total; d += HOLD_PEEK_STEP) {
      const p = add(from, scale(dir, d));
      if (!walkable(ai.world, from, this.z, p, this.z)) break;
      if (!this.holdSpotOk(ai, p, this.z)) break;
      if (!this.shootingLaneClear(ai, p, eye)) break; // line closed, or a mate stepped into it
      best = p;
    }
    if (!best) return null;
    // Give the line a little slack, back the way we came (toward more exposure),
    // so a body-separation shove doesn't close it again.
    const backOff = Math.min(HOLD_PEEK_MARGIN, dist(from, best));
    if (backOff < HOLD_PEEK_STEP) return best;
    const relaxed = add(best, scale(dir, -backOff));
    return walkable(ai.world, from, this.z, relaxed, this.z) &&
      this.holdSpotOk(ai, relaxed, this.z) &&
      this.shootingLaneClear(ai, relaxed, eye)
      ? relaxed
      : best;
  }

  /** Walk the committed hold route hop by hop, then onto `dest`. Consecutive
   *  nodes are movable-linked so each leg is a clear straight line; if a shove
   *  has pushed us somewhere that isn't true any more, drop the plan and rebuild
   *  from wherever we actually ended up. */
  private followHold(ai: AiContext, dest: Vec2): void {
    while (this.holdPath.length > 0 && dist(this.pos, this.holdPath[0]) <= HOLD_ARRIVE) {
      this.holdPath.shift();
    }
    const next = this.holdPath.length > 0 ? this.holdPath[0] : dest;
    const d = dist(this.pos, next);
    if (d <= (this.holdPath.length > 0 ? HOLD_ARRIVE : 1)) return; // there: sit still
    if (!walkable(ai.world, this.pos, this.z, next, this.z)) {
      this.clearHold();
      return;
    }
    this.stepToward(ai, next);
  }

  /** HOLD owns its facing outright — the gun sits on the entry point the whole
   *  time, including while still walking to cover (the approach's blind
   *  lookahead would otherwise point it down the travel direction). */
  private faceHold(): void {
    if (!this.holdEntry) return;
    const d = sub(this.holdEntry, this.pos);
    if (Math.hypot(d.x, d.y) > 1e-3) this.aimAngle = angleOf(d);
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

  /**
   * Distance-until-contact: the distance a mover at (fromPos, fromZ) with weapon
   * reach `range` must travel before it can both SEE `tgt` and be within `range`
   * of it — 0 if already so.
   *
   * The sight line opening IS the fight starting, so this walks the mover's route
   * and stops at the first point along it with a clear line to `tgt`, rather than
   * at `tgt`'s doorstep. The difference is the whole of corner geometry: someone
   * tucked behind a corner opens the angle with a short peek, while the enemy
   * coming down the corridor has to cross the entire corridor to open the same
   * line. Measuring both as "walk to where the other one is standing" reports
   * those as equal, and reports both as far — which is how a bot ends up
   * holstering its gun for a RUN one peek away from contact.
   *
   * `fromNode` (the mover's nearest walkable node) and `tgtGoal` (nearest node
   * that sees `tgt`) can be passed precomputed to hoist those node scans out of a
   * loop (see contactScan). No graph / unreachable falls back to straight-line /
   * Infinity.
   */
  /** Physical walking distance from `a` to `b`: the gap to a's node, the plain
   *  (uncongested) route between the two nodes, and the gap from b's node.
   *
   *  Target selection's distance term used to be the straight line. That is the
   *  wrong quantity the moment geometry is involved — an enemy 200px away
   *  through a wall is a 1500px walk, and ranking him as "near" is the same
   *  mistake that made CONTACT_SCAN_K wrong. This is the number that survives
   *  contact with the map.
   *
   *  NOT harvested from routeUntilSight, though it looks like it should be: that
   *  routes to `nearestInSight(target)`, the nearest node that can SEE them,
   *  which is a different node from the one nearest to them. Sharing the two
   *  would quietly mix "walk until I can shoot you" with "walk to you".
   *
   *  Plain metric on purpose — congestion surcharges are for choosing a path to
   *  walk, not for judging how far away somebody is. */
  private walkDist(ai: AiContext, a: Character, b: Character): number {
    const hit = walkCache.get(a)?.get(b);
    if (hit && ai.tick - hit.tick < REACH_CACHE_TICKS) return hit.dist;
    const nav = ai.nav;
    const na = nodeOf(ai, a);
    const nb = nodeOf(ai, b);
    let d: number;
    if (!nav || na < 0 || nb < 0 || na === nb) {
      d = dist(a.pos, b.pos); // no graph, or the same cell: the line is the walk
    } else {
      const r = nav.route(na, nb);
      // Unreachable ranks LAST, matching bestChase. Falling back to the straight
      // line here would be the worst possible answer now that off-level hostiles
      // are candidates: someone on a disconnected floor is metres away by line
      // and infinitely far on foot, and the line would make them look nearest.
      d = r ? dist(a.pos, nav.nodes[na].pos) + r.dist + dist(nav.nodes[nb].pos, b.pos) : Infinity;
    }
    walkPut(a, b, ai.tick, d);
    return d;
  }

  /** Distance until `from` could put a round on `to`, shared and cached.
   *
   *  This is the one number three different questions were each computing their
   *  own way: contactScan's `my` (when can I engage them), contactScan's `en`
   *  (when can they engage me), and holdThreat's pick of who to watch. With both
   *  sides on the in-hand convention they are literally the same query, so a
   *  pair now costs ONE march instead of two — my reading of your reach IS your
   *  reading of your own, and whichever of us asks first pays for both.
   *
   *  `fromNode` / `tgtGoal` are pure hints; routeUntilSight derives the same
   *  values when they are absent, so an entry is identical no matter who
   *  computed it or which hints they happened to have. That is what makes the
   *  entry shareable rather than merely similar.
   *
   *  Stale by up to REACH_CACHE_TICKS, and computed from where `from` stood at
   *  the time. contactScan already accepted exactly that for its own copy. */
  private reachTo(
    ai: AiContext,
    from: Character,
    to: Character,
    fromNode?: number,
    tgtGoal?: number,
  ): number {
    let row = reachCache.get(from);
    if (!row) {
      row = new WeakMap<Character, ReachEntry>();
      reachCache.set(from, row);
    }
    const hit = row.get(to);
    if (hit && ai.tick - hit.tick < REACH_CACHE_TICKS) return hit.dist;
    const d = this.routeUntilSight(
      ai, from.pos, from.z, to, inHandRange(from), inHandBudget(from), fromNode, tgtGoal);
    row.set(to, { tick: ai.tick, dist: d });
    return d;
  }

  private routeUntilSight(
    ai: AiContext,
    fromPos: Vec2,
    fromZ: number,
    tgt: Character,
    range: number,
    budget: number,
    fromNode?: number,
    tgtGoal?: number,
  ): number {
    // Only a mover on the target's own level can see it (bullets are z-bound).
    // "Sight" here means a lane the MOVER's weapon could actually put a round
    // down, so a rifle reaches contact through a thin partition a shotgun has to
    // walk around — the same reason `range` is the mover's and not ours.
    const seesFrom = (p: Vec2, z: number): boolean =>
      z === tgt.z &&
      targetPoints(tgt, p).some((pt) =>
        budget > 0 ? shotClear(ai.world, p, pt, z, budget) : losClear(ai.world, p, pt, z));
    /** Straight closing distance from a point that already has the line. */
    const gapAt = (p: Vec2): number => Math.max(0, dist(p, tgt.pos) - range);

    if (seesFrom(fromPos, fromZ)) return gapAt(fromPos);
    const nav = ai.nav;
    if (!nav || nav.nodes.length === 0) return dist(fromPos, tgt.pos);
    const curr = fromNode ?? nav.nearestWalkable(ai.world, fromPos, fromZ);
    const goal = tgtGoal ?? nav.nearestInSight(ai.world, tgt.pos, tgt.z);
    if (curr < 0 || goal < 0) return dist(fromPos, tgt.pos);

    // Build the whole route in ONE query, then walk the node list. This used to
    // call nav.route(cur, goal) once PER HOP — re-running a full CH search from
    // every node just to advance one step — which dominated the AI's cost. The
    // path is a single consistent snapshot; the march reads it, no re-querying.
    // `.dist` is exactly route().dist, so the ceiling is bit-identical to before.
    const rp = curr === goal ? { nodes: [curr], dist: 0 } : nav.routePath(curr, goal);
    if (rp === null) return Infinity; // curr !== goal and unreachable
    const path = rp.nodes;

    // The old doorstep answer, kept as the ceiling: the march can only ever
    // improve on it, and it bounds the work — once we've marched that far there is
    // nothing left to win.
    const ceiling = dist(fromPos, nav.nodes[curr].pos) + rp.dist + gapAt(nav.nodes[goal].pos);

    // March the path, sampling for the line at SIGHT_MARCH_STEP intervals, and
    // stop the instant it opens. Cost tracks the ANSWER (a line that opens in one
    // peek costs one or two samples), not the length of the route.
    let travelled = 0;
    let from = fromPos;
    let fromLevel = fromZ;
    for (let hop = 0; hop < path.length && hop < SIGHT_MARCH_HOPS && travelled < ceiling; hop++) {
      const nd = nav.nodes[path[hop]];
      const segLen = dist(from, nd.pos);
      // Samples along this hop carry the level they're walking on; a hop that
      // isn't on the target's level can't open a line, so it's just distance.
      if (fromLevel === tgt.z && segLen > 1e-3) {
        const dir = norm(sub(nd.pos, from));
        for (let d = SIGHT_MARCH_STEP; d <= segLen; d += SIGHT_MARCH_STEP) {
          const p = add(from, scale(dir, d));
          if (seesFrom(p, fromLevel)) return Math.min(ceiling, travelled + d + gapAt(p));
        }
      }
      travelled += segLen;
      from = nd.pos;
      fromLevel = nd.z;
    }
    return ceiling;
  }

  /** Both contact metrics: `myMin` = the soonest WE could see anyone (drives RUN),
   *  `enemyMin` = the soonest ANYONE could see US with `threat` the enemy that owns
   *  it (gates HEAL, and the retreat backs away from `threat`).
   *
   *  Cost matters — a nav route needs two O(nodes) closest-node scans — so our
   *  own two node scans are hoisted out of the loop, and every reach goes through
   *  the shared reachTo cache, where one query serves both directions of a pair.
   *
   *  This used to route only the `CONTACT_SCAN_K` (3) nearest hostiles by
   *  straight-line distance. That bound the cost but ranked a multi-storey map
   *  backwards — someone directly above you is 50px away by straight line, and
   *  the enemy round the corner who can actually reach you is "far" — so the
   *  genuinely soonest threat could be discarded before it was ever costed.
   *  Now every hostile is routed. Measured price: about +11% of AI think() time
   *  on a 5v5 (see scripts/prof_ai.mts). */
  private contactScan(ai: AiContext): { myMin: number; enemyMin: number; threat: Character | null } {
    const hostiles = this.hostiles(ai);
    if (hostiles.length === 0) return { myMin: Infinity, enemyMin: Infinity, threat: null };

    const nav = ai.nav;
    const haveNav = !!nav && nav.nodes.length > 0;
    const myNode = haveNav ? nav!.nearestWalkable(ai.world, this.pos, this.z) : -1;
    const mySightGoal = haveNav ? nav!.nearestInSight(ai.world, this.pos, this.z) : -1;
    let myMin = Infinity;
    let enemyMin = Infinity;
    let threat: Character | null = null;
    for (const h of hostiles) {
      const my = this.reachTo(ai, this, h, myNode, undefined);
      if (my < myMin) myMin = my;
      // The enemy shoots us with ITS weapon, so its reach gates its contact.
      // Same cache row `h` fills in for its own `my` against us — see reachTo.
      const en = this.reachTo(ai, h, this, undefined, mySightGoal);
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

  /** Can we not just SEE from `from` to `to`, but shoot it — geometry clear AND
   *  no teammate standing in the line? Used for the hold's angle, so a bot never
   *  digs in watching a door one of its own squad is stood in front of. Same
   *  friendly-lane rule the trigger uses (laneClear), against a position rather
   *  than a body.
   *
   *  NB teammates move and the hold plan is frozen between refreshes, so a mate
   *  wandering through at plan time can bias the angle for the ~1s until the next
   *  refresh. That's the same tradeoff `mateHolding` makes for cover, and far
   *  cheaper than re-planning whenever someone walks past. */
  private shootingLaneClear(ai: AiContext, from: Vec2, to: Vec2): boolean {
    const budget = this.wallbangBudget;
    if (!(budget > 0 ? shotClear(ai.world, from, to, this.z, budget) : losClear(ai.world, from, to, this.z))) {
      return false;
    }
    return !ai.characters.some(
      (c) =>
        c !== this &&
        c.hp > 0 &&
        c.z === this.z &&
        !areHostile(this.team, c.team) &&
        friendInLine(from, to, c.pos, FRIENDLY_MARGIN),
    );
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
    if (
      target === null ||
      target.z !== this.z || // can't hit them; planting would freeze us facing a floor
      this.mode !== "shoot" ||
      !this.fireOk ||
      this.burstDone ||
      this.gun.spec.movePenalty < STAND_TO_SHOOT_PENALTY ||
      dist(this.pos, target.pos) > this.gun.feasibleRange
    ) {
      return false;
    }
    // A careful gunner won't PLANT on a lane it can't safely fire down either —
    // if a wall or a mate is in the muzzle line, stay mobile and let strafeMove
    // hunt a clean angle instead of freezing raised at a shot it will never take.
    return this.gun.spec.careful ? this.muzzleLineClear(ai, target) : this.laneClear(ai, target);
  }

  /** The actual-muzzle clearance test a `careful` weapon fires through: cast from
   *  the shot origin (the head centre, where rounds spawn) along the TRUE heading
   *  — `this.forward`, where the round will really go, not the line to target.pos —
   *  out to the aim distance, and refuse the shot if that line hits a wall before
   *  the target or passes through a teammate. This is what the plain checks miss:
   *  `laneClear` tests the line to the target (ignoring the heading offset) and
   *  ignores geometry entirely, so it waves through a rocket that would clip the
   *  corner it is peeking or the squadmate its muzzle actually points at. Widened
   *  by the projectile's body radius on launchers so the round's hull can't graze
   *  the corner the centre ray clears by a hair. */
  private muzzleLineClear(ai: AiContext, target: Character): boolean {
    const d = dist(this.pos, add(target.pos, this.aimError));
    const end = add(this.pos, scale(this.forward, d));
    // Wall: the centre line, plus (for a bodied projectile) two rails offset by
    // its radius, must be clear of obstacles between muzzle and target.
    // A round that can punch through what's in the lane still gets there — the
    // budget is the same one updateBullets will spend when the trigger goes.
    const budget = this.wallbangBudget;
    const laneOk = (p: Vec2, q: Vec2): boolean =>
      budget > 0 ? shotClear(ai.world, p, q, this.z, budget) : losClear(ai.world, p, q, this.z);
    if (!laneOk(this.pos, end)) return false;
    const margin = this.gun.spec.projectile?.bodyRadius ?? 0;
    if (margin > 0) {
      const side = scale(perp(this.forward), margin);
      const a = add(this.pos, side);
      const b = sub(this.pos, side);
      if (!laneOk(a, add(a, scale(this.forward, d)))) return false;
      if (!laneOk(b, add(b, scale(this.forward, d)))) return false;
    }
    // Teammate anywhere along the true heading (within the friendly margin).
    return !this.teammates(ai, target).some((m) => friendInLine(this.pos, end, m.pos, FRIENDLY_MARGIN));
  }

  /** Fire only mid-burst in SHOOT mode, with the muzzle settled on the target
   *  — never near a teammate's line, and on semi-auto guns only as fast as a
   *  trigger finger clicks. */
  protected override shouldFire(ai: AiContext, target: Character | null): boolean {
    if (this.mode !== "shoot" || !this.fireOk || !target) return false;
    // Rounds are z-bound (updateBullets drops a bullet whose z differs), so a
    // shot at another floor is thrown away. Nothing else on this path checks:
    // visibility() rays on OUR z and never compares the target's, so canSee says
    // yes through a ceiling, and muzzleLineClear casts on our level too. The
    // candidate filter in selectTarget used to be the only thing standing
    // between an off-level enemy and an emptied magazine.
    if (target.z !== this.z) return false;
    if (this.clickIn > 0) return false;
    // Don't spend rounds past the weapon's reach — the bullet would die short.
    if (dist(this.pos, target.pos) > this.gun.feasibleRange) return false;
    // Gate against the jittered aim point (where the muzzle actually points), so
    // the trigger agrees with the aim — otherwise it'd fire the instant it's dead
    // on the true target while the muzzle is off by aimError. A careful gun uses a
    // much tighter cone (same jittered aim point — not a better shot, a more
    // committed one) so it never looses mid-swing.
    const careful = this.gun.spec.careful === true;
    const aim = add(target.pos, this.aimError);
    const d = dist(this.pos, aim);
    let aimErr = Math.abs(angleOf(this.forward) - angleOf(sub(aim, this.pos)));
    if (aimErr > Math.PI) aimErr = 2 * Math.PI - aimErr;
    const floor = careful ? CAREFUL_AIM_TOLERANCE : MIN_AIM_TOLERANCE;
    if (aimErr > Math.max(this.aimWidth(d), floor)) return false;
    // Settled means stopped, too: see CAREFUL_MAX_SPEED_RATIO. standToShoot has
    // already planted the gunner by now, so this only costs the few ticks the
    // velocity takes to bleed off.
    if (careful && this.speedRatio > CAREFUL_MAX_SPEED_RATIO) return false;
    // Careful weapons additionally veto on an actual raycast down the true heading
    // (walls + teammates); everything else keeps the cheap center-line lane check.
    return careful ? this.muzzleLineClear(ai, target) : this.laneClear(ai, target);
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
    // No z clause: our OWN z flips at a stair midpoint, and requiring a match
    // dropped the lock every time a bot walked onto a staircase — it then
    // reselected, usually onto whoever shared the level it had just left. The
    // enemy we are fighting does not stop being the enemy because we took a step
    // up. Whether we can SHOOT them is a separate question, asked at the trigger.
    const valid =
      this.focus !== null && this.focus.hp > 0 && this.canSee(ai.world, this.focus);
    if (valid && this.targetEvalIn > 0) return this.focus;
    this.targetEvalIn = TARGET_EVAL_TICKS;

    let best: Character | null = null;
    let bestCost = Infinity;
    const range = this.gun.feasibleRange;
    for (const h of this.hostiles(ai)) {
      // Off-level hostiles are candidates now, not exclusions. Nothing special
      // prices them: scoreAt scores zero for anything off our level, so shootCost
      // falls through to its "no local lane" sentinel — the same bucket a
      // same-floor enemy behind a wall lands in — and the walkDist term below
      // then charges the real distance round to them, up the stairs and all.
      // A floor is cover you have to walk further around, and that is all.
      if (!this.canSee(ai.world, h)) continue;
      // Range is ballistic — the bullet flies the straight line, so that is what
      // gates it. The proximity term is the straight line on our own level —
      // deliberately the pre-cross-z behaviour, bit for bit: measured on same-z
      // alone, walking distance changed the pick in only ~8-14% of contested
      // scans (walk/straight ratio 1.1-2.1x) while costing +9% AI time, so it
      // buys nothing there. Across floors the line is essentially wrong
      // (someone directly overhead is "50px away"), so off-level candidates pay
      // the real walk — which is also what lets a close-downstairs enemy beat a
      // far same-floor one without any penalty constant.
      const d = dist(this.pos, h.pos);
      const near = h.z === this.z ? d : this.walkDist(ai, this, h);
      let cost = this.shootCost(ai, h) + BETA_DIST * near;
      if (d > range) cost += OUT_OF_RANGE_PENALTY; // prefer anyone we can actually reach
      cost += this.targetShareCost(ai, h); // spread fire: shun a mate-crowded target
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

  /** Target-splitting penalty for focusing `h`: stepped by how many OTHER live
   *  teammates already have `h` as their committed focus (self excluded, so a
   *  bot never penalises its own sticky lock). 0-1 free, 2 "pretty big", 3+ a
   *  near-forbid — see TARGET_SHARE_BIG. Only TacOracle mates carry a focus; a
   *  human or other-AI ally simply doesn't count toward the crowd. */
  private targetShareCost(ai: AiContext, h: Character): number {
    // Point-blank on our level: always fair game, however crowded (see
    // SHARE_EXEMPT_DIST).
    const d = h.z === this.z ? dist(this.pos, h.pos) : Infinity;
    if (d <= SHARE_EXEMPT_DIST) return 0;
    let k = 0;
    for (const c of ai.characters) {
      if (c === this || c.hp <= 0 || areHostile(this.team, c.team)) continue;
      if (c instanceof TacOracle && c.focus === h) k++;
    }
    if (k <= 1) return 0;
    // Inside trading range crowding NUDGES (redirect if anyone comparable is
    // free) but never FORBIDS — the forbid was written when admission required
    // sight, so "picked only when nothing else is visible" was a real
    // fallback; with cross-z admission something else is ALWAYS visible, and a
    // forbidden enemy inside our own fight became permanently untouchable.
    if (k === 2 || d <= this.engageRange) return TARGET_SHARE_BIG;
    return TARGET_SHARE_FORBID;
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
      dist(this.pos, chase.pos) <= this.fightingRange && // the weapon we'd fight with
      this.canSee(ai.world, chase)
    );
  }

  /** Who a HOLD is dug in against: the hostile who could ENGAGE us soonest —
   *  their distance-until-visibility, `routeUntilSight` measured from their side
   *  with their weapon's reach (the same quantity contactScan calls `enemyMin`).
   *
   *  Not plain walk distance, which answers a different question: a sniper down a
   *  long sightline is a more urgent threat than someone closer behind three
   *  walls, and walking distance ranks those backwards. What a hold is choosing
   *  is an angle to watch, so the right ordering is who gets eyes and reach on us
   *  first.
   *
   *  This used to be the ONLY full scan: contactScan pre-filtered to the
   *  CONTACT_SCAN_K nearest hostiles BY STRAIGHT LINE, which on a multi-storey
   *  map threw away the genuinely closest enemy before it was ever costed, so
   *  this deliberately would not read its cached `threat`. That filter is gone —
   *  both scan everyone now, and both read the same reachTo cache, so the second
   *  scan in a window is close to free. It stays separate only because it wants
   *  the value fresh at plan time rather than whenever contactScan last ran.
   *  Still an approximation in the way routeUntilSight is (the route to the
   *  nearest node that sees us, plus any gap left to close), but the
   *  approximation is in the distance, not in which enemies get considered.
   *
   *  Only called when a plan is built or refreshed, so the per-hostile node scans
   *  are paid at most once per HOLD_REPLAN_TICKS. */
  private holdThreat(ai: AiContext): Character | null {
    const nav = ai.nav;
    if (!nav || nav.nodes.length === 0) return null;
    // The node that can see US is the same for every hostile — hoist it out.
    const mySightGoal = nav.nearestInSight(ai.world, this.pos, this.z);
    let best: Character | null = null;
    let bestReach = Infinity;
    for (const h of this.hostiles(ai)) {
      // Same quantity, same cache as contactScan's `en` — a hold plan built in
      // the same window as a contact scan now pays nothing for this.
      const reach = this.reachTo(ai, h, this, undefined, mySightGoal);
      if (reach < bestReach) {
        bestReach = reach;
        best = h;
      }
    }
    return best;
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
    if (this.strafeTarget) this.stepToward(ai, this.strafeTarget);
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
      this.stepToward(ai, this.strafeTarget);
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
    const move = scale(side, this.dodgeDir * this.moveSpeed);
    const step = add(this.pos, move);
    if (!walkable(ai.world, this.pos, this.z, step, this.z)) {
      this.dodgeDir = this.dodgeDir === 1 ? -1 : 1;
      this.dodgeIn = DODGE_TICKS;
      return;
    }
    this.vel = move;
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
      const move = scale(norm(d), this.moveSpeed);
      const step = add(this.pos, move);
      if (walkable(ai.world, this.pos, this.z, step, this.z)) {
        this.vel = move;
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
      // What a lane COSTS is a property of the geometry, not of the gun — only
      // whether it can be afforded, and what a shot down it is worth, differ by
      // weapon. So one query serves both halves: mine (can I shoot from here) and
      // theirs (how exposed am I standing here), each priced on its own weapon.
      const myBudget = this.wallbangBudget;
      const theirBudget = fightingPenetrationOf(opponent);
      const theirRating = fightingRatingOf(opponent);
      for (const pt of targetPoints(opponent, from)) {
        const cost = shotCost(ai.world, from, pt, fromZ, Math.max(myBudget, theirBudget));
        if (cost === null) continue; // neither of us can reach through this: 0
        // Cover is a matter of degree now: something they can shoot through is
        // PARTIAL cover, counted for as much of a shot as it would cost them.
        if (cost <= theirBudget) exposed += cost <= 0 ? 1 : wallbangDamageFor(cost, theirRating);
        if (cost > myBudget) continue; // they can reach me, I can't reach them
        const worth = this.laneWeight(cost); // a clean lane beats a wallbang
        if (mates.some((m) => friendInLine(from, pt, m.pos, FRIENDLY_MARGIN))) {
          score -= worth;
        } else {
          clear += worth;
          score += worth;
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

  /** One movement tick toward `dest`, recording the step in `vel`. Bodies are
   *  NOT filtered here — walkers push through each other and the squishy
   *  separation pass eases the overlap (see game.ts separateCharacters). A
   *  step-level contact projection ("unshove") was tried and reverted: it
   *  stopped the shoving but cost bots the ability to squeeze past each other,
   *  which is the worse trade. */
  private stepToward(_ai: AiContext, dest: Vec2): void {
    const d = dist(this.pos, dest);
    if (d < 1e-3) return;
    const step = scale(norm(sub(dest, this.pos)), Math.min(this.moveSpeed, d));
    this.vel = step;
    this.pos = add(this.pos, step);
  }
}
