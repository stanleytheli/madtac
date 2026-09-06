/**
 * The DominationOracle: a TacOracle that fights the same way but, with no enemy
 * currently in its sights, works the objective instead of hunting the nearest
 * hostile. It's a thin override — combat, run, heal, and crowd behaviour are all
 * inherited; only the out-of-combat destination changes.
 *
 * The loop it wants: walk to the nearest capture point that still needs work,
 * stand on it to capture/strengthen, then move to the next — fighting any enemy
 * it sees along the way (the base's selectTarget engages visible hostiles before
 * bestChase is ever consulted, so that's free). The one twist: if enemies are
 * on (or right around) the point it's headed for, they contest the capture, so
 * it hunts them down like a plain TacOracle (returns the enemy as the chase
 * target) instead of walking onto a point it can't hold. "Around" is the radius
 * plus a pad, so an enemy can't flip the behaviour by dancing across the edge.
 *
 * "Needs work" = any point we don't already own at full strength (gray,
 * enemy-held, or ours but not yet locked in). Once we own everything outright
 * there's nothing to capture, so it falls back to the base's hunt-the-nearest.
 *
 * The point destination is a throwaway marker Character parked on the objective,
 * so the base's navChase/RUN can steer toward a position; `inContact` is
 * overridden to never treat that marker as a live fight, so contact metrics keep
 * measuring real hostiles and the bot still heals when safe / re-arms when
 * enemies close on the way there.
 */
import { Character } from "../entities/actor.ts";
import { BODY_RADIUS } from "../entities/character.ts";
import { Gun } from "../entities/gun.ts";
import { UNARMED } from "../entities/guns.ts";
import { areHostile } from "../entities/team.ts";
import { TacOracle } from "./tacoracle.ts";
import type { AiContext, ObjectivePoint } from "./robot.ts";
import { dist, vec, type Vec2 } from "../engine/vec.ts";

/** An enemy counts as contesting a point out to its radius plus this pad, so a
 *  hostile can't flip the bot between capture/hunt by dancing across the exact
 *  edge — it has to actually clear the area. */
const CONTEST_PAD = 4 * BODY_RADIUS;

/** How far outside a point's radius the bot will still let it pull its COMBAT
 *  maneuvering toward it (so a firefight near a point drags onto the point).
 *  Deliberately generous — the pull only ever picks among spots that can still
 *  shoot/cover, so a large trigger just means "fight on the point when near it". */
const OBJ_PULL_MARGIN = 10 * BODY_RADIUS; // ~300px past the ring

/** How long (ticks, 60/s) a defender will keep vigil on a site that is fully
 *  ours AND quiet before releasing the hold so bestChase can send it to a point
 *  that still needs work. ~8s. Camping a won, uncontested point indefinitely
 *  wins nothing; the timer breaks that. */
const HOLD_MAX = 8 * 60;

/** "No enemy near enough to be worth defending this point against" for the
 *  HOLD_MAX vigil: no hostile is within this distance-until-they-see-us
 *  (enemyVisDist). Deliberately well BELOW RUN_DISTANCE (1000): RUN_DISTANCE
 *  answers "am I safe?", but this answers "am I doing anything useful by
 *  staying?" — and a defender stops earning its keep long before the point is
 *  provably safe. A threat inside this range resets the vigil (there's a contest
 *  brewing, hold); beyond it the bot is more useful working another point. */
const HOLD_MAX_SAFE_DIST = 500;

/** Once a bot commits to a target site it can't switch for at least this long
 *  (ticks, 60/s → 10s), unless the site is captured out from under it — see
 *  bestChase. Two comparably-distant workable points (e.g. house-3's B up the
 *  stairs vs. C across the map) otherwise sit near the routed-distance tie line,
 *  and the per-tick argmin chatters between them: the bot stalls at the boundary,
 *  reversing course every re-rank, never committing to either. A hard dwell ends
 *  that — pick one, go. Doubles as the re-rank cadence (routing runs only on
 *  (re)commit), so it's cheaper than the old fixed cadence too. */
const SITE_COMMIT_TICKS = 10 * 60;

/** Load-balancing smoothing (a pseudo-count, in team-fraction units). A site's
 *  routed distance is multiplied by (ourShare + a)/(enemyShare + a): > 1 where our
 *  team already crowds it (spread out), < 1 where the enemy presses and we're thin
 *  (go contest), ≈ 1 for a free or evenly-matched point. Small a → shares dominate
 *  (hard spread); large a → distance dominates. Shares are team-FRACTIONS and the
 *  weight is DIMENSIONLESS, so the pick is invariant to team size and to scaling
 *  every map distance by a constant. */
/** Load balancing: spread evenly across the not-yet-ours points instead of piling
 *  onto one. A point's routed distance is multiplied by `1 + this × (teammates
 *  already headed there)`, so each committed teammate makes it a little less
 *  attractive and the next bot peels off to an emptier point. No enemy term — pure
 *  even distribution. Counts (same at any team size) and dimensionless (the pick is
 *  unchanged if every map distance is scaled). */
const SPREAD_PENALTY = 1;

/** Longest an objective bot will chase/fight an enemy that ISN'T on or contesting
 *  a site (ticks, 60/s → 3s) before breaking off. Enemies on a point are always
 *  worth fighting; enemies loitering in open ground just drag the bot off the
 *  objective, so cap the pursuit. */
const PURSUE_MAX = 3 * 60;
/** After breaking off, ignore off-site enemies for this long (ticks → 4s) and
 *  commit to the objective, so a followed bot doesn't instantly re-lock the same
 *  runner and pursue it again. An enemy that steps onto a site is still engaged. */
const PURSUE_COOLDOWN = 4 * 60;

export class DominationOracle extends TacOracle {
  /** A throwaway waypoint (never in the world/roster) parked on the target
   *  objective, so the base's navChase can steer toward a position. */
  private objMarker: Character | null = null;
  /** The ring node the marker is parked on — this bot's CLAIM on it, read by
   *  teammates' captureSpot so they pick a different one (see nodeTaken). Set
   *  whenever the chase is the marker, cleared whenever it is anything else. */
  private captureGoal: { pos: Vec2; z: number } | null = null;

  /** The site this bot committed to holding (position + level, since the
   *  gamemode rebuilds the ObjectivePoint objects every tick). Latched on
   *  entering HOLD and consulted for the rest of it, so walking to cover a step
   *  outside the ring doesn't drop the posture. */
  private holdSite: { pos: Vec2; z: number } | null = null;

  /** Consecutive ticks the current hold has been "secure" — the site fully ours
   *  and no enemy near (see HOLD_MAX / HOLD_MAX_SAFE_DIST). At HOLD_MAX the hold
   *  is released so the bot goes to work another point; reset whenever security
   *  lapses or the bot leaves the ring. */
  private secureTicks = 0;

  /** The site bestChase committed to (pos+level), the ticks left on its 10s lock,
   *  and whether it was already ours when we committed. The last one distinguishes
   *  "went to capture a point and it flipped to us" (the early-release event) from
   *  "chose an already-ours point to reinforce" (no capture event to release on).
   *  See SITE_COMMIT_TICKS / bestChase / committedSite. */
  private siteChoice: { pos: Vec2; z: number } | null = null;
  private siteCommitIn = 0;
  private siteWasOurs = false;

  /** Pursuit leash (see selectTarget / PURSUE_MAX): consecutive ticks spent
   *  chasing an off-site enemy, and the cooldown after breaking one off during
   *  which off-site enemies are ignored so the bot commits back to the objective. */
  private pursueTicks = 0;
  private pursueCooldown = 0;
  /** Set by selectTarget each plan tick: the leash is holding, so chaseOf must
   *  send movement to the objective even if a shootable runner stayed target. */
  private leashed = false;

  /** Objective holds run on their own clock — the HOLD_MAX vigil in wantsHold,
   *  which only fires once the point is won AND quiet. A defender must NOT abandon
   *  a live point just because a fight is slow to arrive, so opt out of the base
   *  soldier's give-up timer entirely. */
  protected override holdMaxTicks(): number {
    return Infinity;
  }

  /** Never treat the objective marker as a live enemy contact (that would zero
   *  the contact metrics and stop the bot healing/running on the way there). */
  protected override inContact(ai: AiContext, chase: Character): boolean {
    if (chase === this.objMarker) return false;
    return super.inContact(ai, chase);
  }

  /** Walk right onto the capture point — no combat standoff for the objective
   *  marker, so the bot ends up inside the radius instead of stopping ~gun-range
   *  short and hovering just off the node. */
  protected override standoffFor(chase: Character): number {
    return chase === this.objMarker ? 0 : super.standoffFor(chase);
  }

  /** Leash the base's target picker to the objective: an enemy that's ON or
   *  contesting a site is always fair game, but one loitering in open ground is
   *  only WALKED AFTER for PURSUE_MAX before we break off (and then refuse to
   *  walk after off-site enemies for PURSUE_COOLDOWN, committing back to the
   *  point). Two things the leash never touches:
   *
   *  - A fight is not a chase. An enemy we can trade with right now — same
   *    level, inside engageRange — is fair game wherever they stand. The old
   *    leash ignored them purely for being off-site, and two cooled-down bots
   *    would walk past each other point-blank, mutually blind for 4s
   *    (scripts/probe_ignore.mts measured it as the cause of 15/16 long
   *    ignore episodes).
   *  - The trigger. A leashed runner who is still shootable (same level,
   *    inside the gun's feasibleRange) stays the TARGET — aim and fire keep
   *    working — and only the movement breaks off: chaseOf sends the walk back
   *    to the objective instead of after them. Only a runner the gun can't
   *    touch anyway (out of range, or another floor) is dropped outright,
   *    because a target like that is nothing BUT a movement goal. */
  protected override selectTarget(ai: AiContext): Character | null {
    const t = super.selectTarget(ai);
    this.leashed = false;
    // This runs on plan ticks only, so the clocks advance by the stagger (like
    // seenFor) to keep PURSUE_MAX / PURSUE_COOLDOWN in real ticks.
    if (this.pursueCooldown > 0) this.pursueCooldown -= this.stagger;
    if (t === null) {
      this.pursueTicks = 0;
      return null;
    }
    const engageable = t.z === this.z && dist(this.pos, t.pos) <= this.engageRange;
    if (engageable || this.nearAnySite(ai, t)) {
      this.pursueTicks = 0;
      return t;
    }
    // An enemy on another level and off every site is nothing but a movement
    // goal — the gun can't reach across floors — and the objective already IS
    // the movement goal. No budget, no chase: with cross-level sight there is
    // nearly always one of these somewhere, and chasing each for a few seconds
    // kept a whole team milling around its own site instead of attacking (a red
    // team committed to A spent half its ticks doing this on dust2-a-3p-dom).
    if (t.z !== this.z) {
      this.pursueTicks = 0;
      this.leashed = true;
      this.focus = null;
      return null;
    }
    // An off-site runner beyond trading range: chase on a budget.
    if (this.pursueCooldown <= 0) {
      this.pursueTicks += this.stagger;
      if (this.pursueTicks < PURSUE_MAX) return t;
      this.pursueTicks = 0;
      this.pursueCooldown = PURSUE_COOLDOWN;
    } else {
      this.pursueTicks = 0;
    }
    this.leashed = true;
    if (t.z === this.z && dist(this.pos, t.pos) <= this.gun.feasibleRange) return t;
    this.focus = null;
    return null;
  }

  /** While the leash holds, movement belongs to the objective — even though the
   *  gun may still be on the runner (see selectTarget). Without this the chase
   *  falls to `target ?? focus`, which is the runner, and the leash would stop
   *  nothing. */
  protected override chaseOf(ai: AiContext, target: Character | null): Character | null {
    const chase = this.leashed ? this.bestChase(ai) : super.chaseOf(ai, target);
    if (chase !== this.objMarker) this.captureGoal = null; // walking after something else: no claim
    return chase;
  }

  /** Is `e` on or contesting any capture point — within a ring plus the contest
   *  pad, the same reach the site logic uses? Off that, it's an open-ground runner
   *  the pursuit leash caps chasing. */
  private nearAnySite(ai: AiContext, e: Character): boolean {
    for (const o of ai.objectives ?? []) {
      if (o.z === e.z && dist(e.pos, o.pos) <= o.radius + CONTEST_PAD) return true;
    }
    return false;
  }

  /** Bias combat maneuvering toward the nearest point that still needs work when
   *  we're fighting near it — so an engagement on/around a capture point is waged
   *  FROM the point (capturing while shooting) rather than wherever the enemy
   *  happens to pull us. Null when the nearest workable point is too far, or we
   *  already hold it outright.
   *
   *  Straight-line distance is right HERE (unlike bestChase's routed pick): this
   *  is a local "is there a point right under this fight to drag it onto" test,
   *  gated to ~OBJ_PULL_MARGIN, not a cross-map destination choice — but it must
   *  stay on THIS bot's level, or a point a floor up/down reads as underfoot. */
  protected override biasObjective(ai: AiContext): { pos: Vec2; radius: number } | null {
    const objs = ai.objectives;
    if (!objs || objs.length === 0) return null;
    let best: ObjectivePoint | null = null;
    let bestD = Infinity;
    for (const o of objs) {
      if (o.z !== this.z) continue; // can't fight FROM a point on another level
      if (o.owner === this.team && o.progress >= 2) continue; // fully ours: nothing to gain
      const d = dist(this.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best || bestD > best.radius + OBJ_PULL_MARGIN) return null;
    return { pos: best.pos, radius: best.radius };
  }

  /** Standing on a site with nothing in sight and no enemy on it, there is
   *  nothing to do but wait — so wait from cover with the gun already on the
   *  approach instead of wandering off. Who owns the site doesn't matter: an
   *  uncaptured one keeps ticking over while we stand in it (holdSpotOk keeps the
   *  spot inside the ring until it's ours and reinforced), so digging in captures
   *  and defends in the same motion. An enemy on the site is the one exclusion —
   *  that's a contest to be fought, not a vigil to be kept.
   *
   *  Unlike the base soldier this mostly ignores how far off contact is — the
   *  site is worth holding whether or not anyone is nearby — and since HOLD
   *  outranks RUN in updatePosture it won't sprint away from it. The one time
   *  distance matters is the HOLD_MAX vigil: a fully-captured, quiet point is
   *  released after ~8s so the bot goes and works a point that still needs it,
   *  rather than camping a won objective forever. */
  protected override wantsHold(ai: AiContext, target: Character | null): boolean {
    if (target) {
      this.holdSite = null;
      this.secureTicks = 0;
      return false;
    }
    // Once dug in, stay committed to the site we dug in ON, rather than re-asking
    // "am I inside a ring" every tick. Cover is routinely a step outside the ring
    // (always so, once the site is ours and reinforced and off-ring cover is
    // allowed), and re-testing position meant: HOLD walks the bot out of the ring
    // -> underfoot goes null -> hold drops -> RUN drives it back across the ring
    // -> it digs in again. That bounce is the run<->hold loop; the latch ends it.
    const site = this.mode === "hold" && this.holdSite ? this.siteAt(ai, this.holdSite) : this.pointUnderfoot(ai);
    if (!site || this.contested(ai, site)) {
      this.holdSite = null;
      this.secureTicks = 0;
      return false;
    }

    // HOLD_MAX vigil: while the site is fully ours AND no enemy is near, there is
    // nothing to defend against, so count down and hand the bot back to bestChase
    // (which routes it to whatever point still needs work). Anything that makes
    // staying useful again — an enemy drawing near, or the point slipping below
    // full strength — resets the clock. Note we DON'T reset secureTicks when the
    // timer fires: it stays high so the bot keeps releasing on the walk out; only
    // physically leaving the ring (the !site branch above) rearms a fresh vigil.
    const secured = site.owner === this.team && site.progress >= 2 && this.enemyVisDist >= HOLD_MAX_SAFE_DIST;
    this.secureTicks = secured ? this.secureTicks + 1 : 0;
    if (this.secureTicks >= HOLD_MAX) {
      this.holdSite = null;
      return false;
    }

    this.holdSite = { pos: site.pos, z: site.z };
    return true;
  }

  /** Re-resolve a latched site against this tick's objective list, which the
   *  gamemode rebuilds each frame (so the objects can't be compared by identity). */
  private siteAt(ai: AiContext, ref: { pos: Vec2; z: number }): ObjectivePoint | null {
    for (const o of ai.objectives ?? []) {
      if (o.z === ref.z && dist(o.pos, ref.pos) < 1) return o;
    }
    return null;
  }

  /** Any live hostile on `pt` — out to the same radius + CONTEST_PAD bestChase
   *  uses, so an enemy can't toggle the posture by stepping across the exact
   *  edge of the ring. */
  private contested(ai: AiContext, pt: ObjectivePoint): boolean {
    const reach = pt.radius + CONTEST_PAD;
    return this.hostiles(ai).some((h) => h.z === pt.z && dist(h.pos, pt.pos) <= reach);
  }

  /** Never take cover that isn't on the point: a covered spot outside the ring
   *  stops the capture, which is the entire reason we're standing here. Once the
   *  point is ours AND fully reinforced there's no progress left to lose, so real
   *  cover anywhere is fair game. Same when every ring node is already taken by
   *  a teammate: the capture is covered, one more body on the ring only shoves,
   *  so this bot is freed to dig in outside and guard the approach. */
  protected override holdSpotOk(ai: AiContext, pos: Vec2, z: number): boolean {
    // The latched site, not "whatever ring I happen to stand in" — otherwise the
    // constraint evaporates the moment the walk to cover crosses the ring edge.
    const pt = (this.holdSite ? this.siteAt(ai, this.holdSite) : null) ?? this.pointUnderfoot(ai);
    if (!pt) return super.holdSpotOk(ai, pos, z);
    if (pt.owner === this.team && pt.progress >= 2) return true;
    if (this.freeRingNode(ai, pt) < 0) return true;
    return z === pt.z && dist(pos, pt.pos) <= pt.radius;
  }

  /** The capture point we're currently standing inside, or null. */
  private pointUnderfoot(ai: AiContext): ObjectivePoint | null {
    for (const o of ai.objectives ?? []) {
      if (o.z === this.z && dist(this.pos, o.pos) <= o.radius) return o;
    }
    return null;
  }

  /** Out-of-combat destination: the nearest capture point that still needs work.
   *  If enemies are contesting that point, hunt them down (plain TacOracle);
   *  otherwise walk onto the point to capture it. Everything owned outright →
   *  the base's nearest-enemy chase (defend). No objectives → same. */
  protected override bestChase(ai: AiContext): Character | null {
    const objs = ai.objectives;
    if (!objs || objs.length === 0) return super.bestChase(ai);

    // Stick with the committed site for its 10s lock, then re-rank. The pick is
    // the nearest workable point BY TRAVEL DISTANCE — routed through the nav graph
    // (so a point up a stair climb isn't judged "close" by a straight line that
    // ignores the detour). Committing hard past the routed-distance tie line is
    // what stops the boundary chatter (see SITE_COMMIT_TICKS); the lock also means
    // the costly ranking runs only on (re)commit, not every tick.
    this.siteCommitIn -= 1;
    const held = this.committedSite(objs);
    let best: ObjectivePoint | null;
    if (held && this.siteCommitIn > 0) {
      best = held; // locked in — no re-rank, no switching
    } else {
      best = this.rankNearestSite(ai, objs);
      this.siteChoice = best ? { pos: best.pos, z: best.z } : null;
      this.siteWasOurs = best ? best.owner === this.team : false;
      this.siteCommitIn = SITE_COMMIT_TICKS;
    }
    if (!best) {
      this.captureGoal = null;
      return super.bestChase(ai); // we own it all — go hunt/defend
    }

    // Enemies on (or right around) that point contest the capture: hunt the
    // nearest one down like a normal TacOracle rather than crowding onto a point
    // we can't hold. The pad past the radius stops an enemy from toggling us by
    // stepping across the exact edge.
    const contestRange = best.radius + CONTEST_PAD;
    let contester: Character | null = null;
    let contesterD = Infinity;
    for (const h of this.hostiles(ai)) {
      if (h.z !== best.z || dist(h.pos, best.pos) > contestRange) continue;
      const d = dist(this.pos, h.pos);
      if (d < contesterD) {
        contesterD = d;
        contester = h;
      }
    }
    if (contester) {
      this.captureGoal = null;
      return contester;
    }

    // Clear point: walk onto it. The marker steers navChase to a spot, but the
    // base navigates by routing to the nearest graph node that can SEE the goal —
    // and a point's exact centre can sit in a wall with no node that sees or even
    // walks to it (a stranding freeze). So aim at the nearest nav node on the
    // point's level instead: standing there is inside the radius (so it captures)
    // and a real graph node always has a route.
    const spot = this.captureSpot(ai, best);
    this.captureGoal = { pos: vec(spot.x, spot.y), z: best.z };
    const m = (this.objMarker ??= new Character(vec(0, 0), this.skin, { hand: new Gun(UNARMED) }));
    m.pos = vec(spot.x, spot.y);
    m.z = best.z;
    m.hp = 1; // kept "alive" so it's a valid chase target
    return m;
  }

  /** The best workable point (not already ours at full strength) to head for:
   *  routed travel distance × a load-balancing spread multiplier. Distance is
   *  `route().dist` through the nav graph on this bot's own team-congested metric
   *  (walls and stair climbs count, unlike a straight line); the multiplier (see
   *  siteSpreadMult) pushes the bot off points teammates are already headed for.
   *  Straight-line only as a no-graph fallback; unreachable points rank last. Null
   *  when every point is already locked down. */
  private rankNearestSite(ai: AiContext, objs: readonly ObjectivePoint[]): ObjectivePoint | null {
    const nav = ai.nav;
    const from = nav ? nav.nearestWalkable(ai.world, this.pos, this.z) : -1;
    const mult = this.siteSpreadMult(ai, objs);
    let best: ObjectivePoint | null = null;
    let bestCost = Infinity;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.owner === this.team && o.progress >= 2) continue; // already ours, fully locked
      let d: number;
      if (nav && from >= 0) {
        const to = this.siteNode(ai, o);
        const r = to >= 0 ? nav.route(from, to, this.team) : null;
        d = r ? r.dist : Infinity; // unreachable: only picked if nothing else is
      } else {
        d = dist(this.pos, o.pos); // no graph / no start node: best effort
      }
      const cost = d * mult[i];
      if (cost < bestCost) {
        bestCost = cost;
        best = o;
      }
    }
    return best;
  }

  /** Per-site distance multiplier for load balancing, indexed like `objs`:
   *  `1 + SPREAD_PENALTY · (teammates headed for it)`, so the team spreads across
   *  the not-yet-ours points instead of piling on one.
   *
   *  Teammates are counted by INTENT, not raw position: a body on a ring counts for
   *  that point; otherwise a bot counts for its committed target site (a body
   *  crossing mid toward C is a body on C, not on the B it passes through), and a
   *  human player counts for the point they're closest to. Self is excluded: we're
   *  re-deciding our own slot. Because bots think in a fixed order and a re-rank
   *  reads teammates' already-updated picks this same tick, bots released together
   *  fan out instead of herding onto one point. */
  private siteSpreadMult(ai: AiContext, objs: readonly ObjectivePoint[]): number[] {
    const n = objs.length;
    const ours = new Array<number>(n).fill(0);
    for (const c of ai.characters) {
      if (c === this || c.hp <= 0 || c.team !== this.team) continue;
      const ring = this.ringIndexAt(c.pos, c.z, objs);
      const idx =
        ring >= 0 ? ring
        : c instanceof DominationOracle ? this.choiceIndex(c.siteChoice, objs)
        : this.nearestSiteIndex(ai, c.pos, c.z, objs); // player: closest site
      if (idx >= 0) ours[idx]++;
    }
    const mult = new Array<number>(n);
    for (let i = 0; i < n; i++) mult[i] = 1 + SPREAD_PENALTY * ours[i];
    return mult;
  }

  /** Index in `objs` of the ring `(pos, z)` sits inside, or -1. */
  private ringIndexAt(pos: Vec2, z: number, objs: readonly ObjectivePoint[]): number {
    for (let i = 0; i < objs.length; i++) {
      if (objs[i].z === z && dist(pos, objs[i].pos) <= objs[i].radius) return i;
    }
    return -1;
  }

  /** Index in `objs` matching a committed site ref, or -1 (uncommitted / gone). */
  private choiceIndex(c: { pos: Vec2; z: number } | null, objs: readonly ObjectivePoint[]): number {
    if (!c) return -1;
    for (let i = 0; i < objs.length; i++) {
      if (objs[i].z === c.z && dist(objs[i].pos, c.pos) < 1) return i;
    }
    return -1;
  }

  /** Index in `objs` of the point nearest `(pos, z)` by route (plain metric — this
   *  estimates where an OTHER body is effectively headed, not our own cost), or -1.
   *  Uses the geometrically-nearest node as the start (cheap; no walkable march). */
  private nearestSiteIndex(ai: AiContext, pos: Vec2, z: number, objs: readonly ObjectivePoint[]): number {
    const nav = ai.nav;
    const from = nav ? this.nearestNodeId(ai, pos, z) : -1;
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < objs.length; i++) {
      let d: number;
      if (nav && from >= 0) {
        const to = this.siteNode(ai, objs[i]);
        const r = to >= 0 ? nav.route(from, to) : null;
        d = r ? r.dist : Infinity;
      } else {
        d = dist(pos, objs[i].pos);
      }
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  }

  /** The committed site re-resolved against this tick's rebuilt objective list, or
   *  null to release the lock and force a fresh routed rank. The lock is released
   *  early ONLY by the target being captured by our team — the one "something
   *  happened" event: `owner` flips to us on a point that wasn't ours when we
   *  committed (a point starts owned by whoever holds it, so owner === team ⇒ we
   *  control it). A point we deliberately chose while it was already ours has no
   *  such capture event, so it just serves out the dwell (until fully locked, when
   *  there's nothing left to do there either). Otherwise the lock holds — an enemy
   *  contesting or taking the point does NOT free us, we still want to go fight for
   *  it. */
  private committedSite(objs: readonly ObjectivePoint[]): ObjectivePoint | null {
    const c = this.siteChoice;
    if (!c) return null;
    for (const o of objs) {
      if (o.z !== c.z || dist(o.pos, c.pos) >= 1) continue;
      if (o.owner === this.team && !this.siteWasOurs) return null; // we captured it
      if (o.owner === this.team && o.progress >= 2) return null; // reinforced to fully locked
      return o;
    }
    return null; // vanished from the list (shouldn't happen mid-match)
  }

  /** The nav node id nearest `pt`'s centre on its level, or -1 if the graph has
   *  no node there. Routing needs a real graph node as an endpoint, and the point
   *  centre itself can sit in a wall with no node on it. */
  private siteNode(ai: AiContext, pt: ObjectivePoint): number {
    return this.nearestNodeId(ai, pt.pos, pt.z);
  }

  /** The nav node id nearest `(pos, z)` by straight line (no walkable march — this
   *  is just an endpoint for a route estimate), or -1 if the graph has no node on
   *  that level. */
  private nearestNodeId(ai: AiContext, pos: Vec2, z: number): number {
    let bestId = -1;
    let bestD = Infinity;
    for (const n of ai.nav?.nodes ?? []) {
      if (n.z !== z) continue;
      const d = dist(n.pos, pos);
      if (d < bestD) {
        bestD = d;
        bestId = n.id;
      }
    }
    return bestId;
  }

  /** Where to stand to work `pt`: a nav node inside its ring (navigation needs a
   *  real graph node as its goal, and any node inside the radius captures) that
   *  no teammate is standing on or heading for. Every bot used to aim at the ONE
   *  node nearest the centre, so a whole team arrived on the same spot and spent
   *  the capture shoving each other off it. Now the goal is the nearest free ring
   *  node, and it sticks: a goal we already hold is kept while no mate CLAIMS it
   *  (a mate merely walking across it doesn't re-route us), so the pick doesn't
   *  chatter as people move. With the ring full we still walk onto the nearest
   *  ring node — being inside the ring is what starts a hold — and holdSpotOk
   *  then lets the hold dig in outside it. Falls back to the centre only if the
   *  graph has no node on that level. */
  private captureSpot(ai: AiContext, pt: ObjectivePoint): Vec2 {
    const nav = ai.nav;
    if (!nav) return pt.pos;
    const ring = this.ringNodes(ai, pt);
    if (ring.length === 0) return pt.pos;
    const cur = this.captureGoal;
    if (
      cur &&
      cur.z === pt.z &&
      ring.some((id) => dist(nav.nodes[id].pos, cur.pos) < 1) &&
      !this.nodeTaken(ai, cur.pos, cur.z, false)
    ) {
      return cur.pos;
    }
    const free = this.freeRingNode(ai, pt);
    if (free >= 0) return nav.nodes[free].pos;
    let best = ring[0];
    let bestD = Infinity;
    for (const id of ring) {
      const d = dist(this.pos, nav.nodes[id].pos);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return nav.nodes[best].pos;
  }

  /** The nav nodes inside `pt`'s ring on its level — the spots standing on which
   *  captures it. If the graph puts none inside the radius, the single nearest
   *  node stands in (the old behaviour, and the best there is). */
  private ringNodes(ai: AiContext, pt: ObjectivePoint): number[] {
    const out: number[] = [];
    for (const n of ai.nav?.nodes ?? []) {
      if (n.z === pt.z && dist(n.pos, pt.pos) <= pt.radius) out.push(n.id);
    }
    if (out.length === 0) {
      const id = this.siteNode(ai, pt);
      if (id >= 0) out.push(id);
    }
    return out;
  }

  /** The ring node of `pt` nearest this bot that no teammate stands on or has
   *  claimed, or -1 when the ring is full. */
  private freeRingNode(ai: AiContext, pt: ObjectivePoint): number {
    const nav = ai.nav;
    if (!nav) return -1;
    let best = -1;
    let bestD = Infinity;
    for (const id of this.ringNodes(ai, pt)) {
      const p = nav.nodes[id].pos;
      if (this.nodeTaken(ai, p, pt.z, true)) continue;
      const d = dist(this.pos, p);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** Is `pos` on level `z` taken by a teammate: claimed as their capture goal
   *  (a bot on its way there), reserved by their hold plan (cover or peek), or —
   *  when `standing` — simply stood on right now? A holder's capture goal is
   *  ignored: its hold plan is the claim that counts, and the goal it walked in
   *  on may be a node it has since left. */
  private nodeTaken(ai: AiContext, pos: Vec2, z: number, standing: boolean): boolean {
    for (const c of ai.characters) {
      if (c === this || c.hp <= 0 || areHostile(this.team, c.team)) continue;
      if (standing && c.z === z && dist(c.pos, pos) < 2 * BODY_RADIUS) return true;
      if (!(c instanceof TacOracle)) continue;
      if (c.holdClaims(pos, z)) return true;
      if (c instanceof DominationOracle && c.mode !== "hold" && c.captureGoal) {
        const g = c.captureGoal;
        if (g.z === z && dist(g.pos, pos) < 2 * BODY_RADIUS) return true;
      }
    }
    return false;
  }
}
