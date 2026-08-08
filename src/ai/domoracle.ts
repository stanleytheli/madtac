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

/** How often (ticks) bestChase re-runs the routed site ranking. bestChase is
 *  called every tick, but the nav queries behind the ranking are far too costly
 *  to pay per tick and the pick barely moves over a third of a second — so cache
 *  it this long, re-resolving the cached point against the rebuilt objective list
 *  in between (and re-ranking early the moment it's captured/gone). */
const SITE_EVAL_TICKS = 20;

export class DominationOracle extends TacOracle {
  /** A throwaway waypoint (never in the world/roster) parked on the target
   *  objective, so the base's navChase can steer toward a position. */
  private objMarker: Character | null = null;

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

  /** The site bestChase last committed to (pos+level), and the countdown to the
   *  next routed re-rank. bestChase runs every tick; the nav ranking behind it
   *  does not — see SITE_EVAL_TICKS. Between refreshes the cached point is
   *  re-resolved against the rebuilt objective list, so it stays a live point. */
  private siteChoice: { pos: Vec2; z: number } | null = null;
  private siteEvalIn = 0;

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
   *  cover anywhere is fair game. */
  protected override holdSpotOk(ai: AiContext, pos: Vec2, z: number): boolean {
    // The latched site, not "whatever ring I happen to stand in" — otherwise the
    // constraint evaporates the moment the walk to cover crosses the ring edge.
    const pt = (this.holdSite ? this.siteAt(ai, this.holdSite) : null) ?? this.pointUnderfoot(ai);
    if (!pt) return super.holdSpotOk(ai, pos, z);
    if (pt.owner === this.team && pt.progress >= 2) return true;
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

    // The nearest workable point BY TRAVEL DISTANCE — routed through the nav
    // graph, so a point a floor up behind a stair climb isn't judged "close" by a
    // straight line that ignores the detour. bestChase runs every tick but the
    // ranking's nav queries are far too costly to; the pick is cached
    // (SITE_EVAL_TICKS), re-resolved against this tick's rebuilt objective list in
    // between, and re-ranked early the moment the cached point is captured/gone.
    this.siteEvalIn -= 1;
    let best = this.resolveChoice(objs);
    if (!best || this.siteEvalIn <= 0) {
      best = this.rankNearestSite(ai, objs);
      this.siteChoice = best ? { pos: best.pos, z: best.z } : null;
      this.siteEvalIn = SITE_EVAL_TICKS;
    }
    if (!best) return super.bestChase(ai); // we own it all — go hunt/defend

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
    if (contester) return contester;

    // Clear point: walk onto it. The marker steers navChase to a spot, but the
    // base navigates by routing to the nearest graph node that can SEE the goal —
    // and a point's exact centre can sit in a wall with no node that sees or even
    // walks to it (a stranding freeze). So aim at the nearest nav node on the
    // point's level instead: standing there is inside the radius (so it captures)
    // and a real graph node always has a route.
    const spot = this.captureSpot(ai, best);
    const m = (this.objMarker ??= new Character(vec(0, 0), this.skin, { hand: new Gun(UNARMED) }));
    m.pos = vec(spot.x, spot.y);
    m.z = best.z;
    m.hp = 1; // kept "alive" so it's a valid chase target
    return m;
  }

  /** The workable point (not already ours at full strength) nearest by ACTUAL
   *  travel distance — `route().dist` through the nav graph, so walls and stair
   *  climbs to another z count, unlike a straight line. Ranks on this bot's own
   *  team-congested metric (the cost it will really pay). Falls back to
   *  straight-line only with no nav graph or a nodeless endpoint; unreachable
   *  points rank last. Null when every point is already locked down. */
  private rankNearestSite(ai: AiContext, objs: readonly ObjectivePoint[]): ObjectivePoint | null {
    const nav = ai.nav;
    const from = nav ? nav.nearestWalkable(ai.world, this.pos, this.z) : -1;
    let best: ObjectivePoint | null = null;
    let bestD = Infinity;
    for (const o of objs) {
      if (o.owner === this.team && o.progress >= 2) continue; // already ours, fully locked
      let d: number;
      if (nav && from >= 0) {
        const to = this.siteNode(ai, o);
        const r = to >= 0 ? nav.route(from, to, this.team) : null;
        d = r ? r.dist : Infinity; // unreachable: only picked if nothing else is
      } else {
        d = dist(this.pos, o.pos); // no graph / no start node: best effort
      }
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** Re-resolve the cached site pick against this tick's rebuilt objective list,
   *  or null if it's gone or has since been locked down (which forces a fresh
   *  routed rank in bestChase). */
  private resolveChoice(objs: readonly ObjectivePoint[]): ObjectivePoint | null {
    const c = this.siteChoice;
    if (!c) return null;
    for (const o of objs) {
      if (o.z === c.z && dist(o.pos, c.pos) < 1) {
        return o.owner === this.team && o.progress >= 2 ? null : o;
      }
    }
    return null;
  }

  /** The nav node id nearest `pt`'s centre on its level, or -1 if the graph has
   *  no node there. Routing needs a real graph node as an endpoint, and the point
   *  centre itself can sit in a wall with no node on it. */
  private siteNode(ai: AiContext, pt: ObjectivePoint): number {
    let bestId = -1;
    let bestD = Infinity;
    for (const n of ai.nav?.nodes ?? []) {
      if (n.z !== pt.z) continue;
      const d = dist(n.pos, pt.pos);
      if (d < bestD) {
        bestD = d;
        bestId = n.id;
      }
    }
    return bestId;
  }

  /** Where to stand to work `pt`: the nearest nav node on its level (navigation
   *  needs a real graph node as its goal), falling back to the centre only if the
   *  graph has no node on that level. */
  private captureSpot(ai: AiContext, pt: ObjectivePoint): Vec2 {
    const id = this.siteNode(ai, pt);
    return id >= 0 && ai.nav ? ai.nav.nodes[id].pos : pt.pos;
  }
}
