/**
 * The Oracle: a Robot that hunts. It aims and shoots exactly like the base
 * Robot, but every tick it also moves at constant speed toward the nearest
 * member of a team it's hostile to.
 *
 * The node graph is authoritative for movement — even with the target in
 * sight. Every plan asks: which node am I at (nearest *walkable* node — sight
 * isn't proof you can get there), and which node is the target at (nearest
 * node that *sees* it)? Only when those two are the SAME node does the Oracle
 * beeline at the target itself (down to a standoff range, so it fights at gun
 * length instead of hugging); otherwise it walks the cached Dijkstra route hop
 * by hop, committing to each hop until arrival so sight-blinking around
 * corners can't make it dither. Beelining at a merely-visible target was the
 * balcony bug: the dash crossed a stair midpoint, flipped z, lost the target,
 * re-routed, flipped back — rapid stair flicker. Two rules kill that for good:
 * beeline only within the shared node's cell, and a direct step never crosses
 * a stair midpoint (waypoint legs are the only sanctioned level changes).
 */
import type { Character } from "../entities/actor.ts";
import { type Skin } from "../entities/character.ts";
import { walkable, zAt, type NavGraph } from "../world/nav.ts";
import { Robot, type AiContext, type RobotOptions } from "./robot.ts";
import { add, angleOf, dist, norm, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import type { World } from "../world/world.ts";

/** Teal seer. */
export const ORACLE_SKIN: Skin = {
  head: "#6fc3b9",
  rightShoulder: "#2f6e66",
  leftShoulder: "#2f6e66",
  rightUpperarm: "#b473d6",
  leftUpperarm: "#6fc3b9",
  rightForearm: "#6fc3b9",
  leftForearm: "#6fc3b9",
  rightHand: "#2f6e66",
  leftHand: "#2f6e66",
  outline: "#000000",
};

const DEFAULT_MOVE_SPEED = 2.4; // world px per tick, constant (no accel model)
const DEFAULT_STANDOFF = 130; // stop closing once the chase is this near
const ARRIVE_EPS = 8; // "at the node" slop, so it doesn't orbit a waypoint
const REPLAN_TICKS = 30; // re-run the path query this often (~0.5s) to chase a moving goal
/** Extra forward jitter (0..this) on each replan timer, so bots whose timers
 *  landed on the same tick drift apart instead of re-planning together forever. */
const REPLAN_JITTER = 10;
const SWITCH_MARGIN = 80; // keep the committed hop unless a fresh plan is this much cheaper (px)
const MAX_SKIP = 4; // hops per tick the string-pull may cut when the line ahead is clear
/** How much ROUTE the string-pull may cut, in world px, on one commitment: the
 *  summed length of the hops it jumps past before the bot has to arrive
 *  somewhere (or commit to a different hop) to earn more. The per-tick MAX_SKIP
 *  alone bounds nothing — the pull runs every tick — so in a wide walkway every
 *  bot's waypoint slid to the same far corner node and they all walked one
 *  straight, off-graph line to it: single file, on ground the congestion field
 *  neither prices nor sees (a stamp starts at the waypoint). Capping the reach
 *  keeps each bot near the lane its congested route chose, and its stamp near
 *  where it is.
 *
 *  A length, not a node count, so the reach doesn't depend on how densely a
 *  level is noded. 600px fits two route hops on average (1.95 across arena /
 *  dust2 / harbor / house; route edges average ~245px), i.e. a waypoint about
 *  three nodes ahead of where the bot stands. */
const SKIP_AHEAD_DIST = 600;
const AIM_HOLD_TICKS = 45; // keep the last combat aim this long after losing sight
const FACE_NEXT_DISTANCE = 650; // this close to the waypoint, aim at the hop after it
/** How many hops of the committed route (from the waypoint on) are declared to
 *  the congestion field. Infinity = the whole route, which is what measures
 *  best once the string-pull is capped (SKIP_AHEAD_DIST): on dust2 10v10, single-file
 *  walking was 2.7% of moving bot-samples at 1 hop, 2.0% at 12, 1.5% for the
 *  whole route (harbor 1.9 / 2.1 / 1.6). A short stamp was tried on the theory
 *  that the far end of a route is stale by the time anyone gets there; it cut
 *  ordinary bumping slightly on an open arena but leaves teammates free to pile
 *  onto the same corridor further along. The stamp is built from ONE routePath
 *  query, so length costs arcs to customize, not extra searches — if plan()
 *  cost ever matters again at large bot counts, this is the dial. */
const ROUTE_STAMP_HOPS = Infinity;

export interface OracleOptions extends RobotOptions {
  /** Constant movement speed, world px/tick. */
  moveSpeed?: number;
  /** Stop distance against a target it can see. */
  standoff?: number;
}

export class Oracle extends Robot {
  protected readonly moveSpeed: number;
  protected readonly standoff: number;
  /** The node id it's committed to walking to, or -1. Committing until arrival
   *  (instead of re-deriving "my nearest node" every tick) is what prevents
   *  oscillation when line of sight to a nearer node blinks around a corner. */
  private waypoint = -1;
  /** True iff the last plan found my node == the target's node — the only
   *  state in which beelining at the target itself is allowed. It is a fact
   *  about ONE character, the one that plan was made for: see planFor. */
  private atGoalNode = false;
  /** Who the last plan was made for. atGoalNode (and the whole committed route)
   *  says nothing about anyone else, so a beeline is only ever taken at this
   *  character, and a different chase forces a fresh plan. Without it a bot
   *  standing on its capture node (plan for the objective marker, atGoalNode
   *  true) that picked up an enemy — a hidden one included — walked dead
   *  straight at it through whatever was in between, for as long as the stale
   *  plan lasted. */
  private planFor: Character | null = null;
  /** The goal node of the last plan (nearest node that sees the chase), or
   *  -1. Kept so blind facing can look up the hop after the waypoint. */
  private goal = -1;
  private replanIn = 0;
  /** Route length the string-pull may still cut on the current commitment (see
   *  SKIP_AHEAD_DIST). */
  private skipLeft = SKIP_AHEAD_DIST;

  constructor(pos: Vec2, options: OracleOptions = {}) {
    super(pos, { skin: ORACLE_SKIN, ...options });
    this.moveSpeed = options.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.standoff = options.standoff ?? DEFAULT_STANDOFF;
  }

  protected override act(ai: AiContext, target: Character | null): void {
    this.vel = vec(0, 0); // robots step pos directly; vel only reports the step
    const chase = target ?? this.nearestHostile(ai);
    if (!chase) return;
    this.navChase(ai, chase, target);
  }

  protected override coast(ai: AiContext): void {
    this.coastStep(ai);
  }

  /** Movement distance allowed this tick (world px). Overridable so subclasses
   *  can sprint or crawl; the base Oracle always walks at its constant speed. */
  protected stepSpeed(): number {
    return this.moveSpeed;
  }

  /** When true, blind movement faces straight down its travel direction instead
   *  of pre-aiming the next corner with lookahead. Off by default; a holstered
   *  sprint wants it (not clearing corners — see TacOracle run mode). */
  protected facesTravel(): boolean {
    return false;
  }

  /** How close the beeline closes on `chase` before holding — gun range for a
   *  combat target (so a shooter stops at fighting distance). Overridable so an
   *  objective-seeker can walk right onto its destination (a capture point)
   *  instead of stopping short and hovering just off it. */
  protected standoffFor(_chase: Character): number {
    return this.standoff;
  }

  /** Cheap between-plan movement: take one more step toward the destination the
   *  last plan already committed to (the beeline target when at the goal node,
   *  else the committed waypoint) — no path query, no line-of-sight work. */
  protected coastStep(ai: AiContext): void {
    this.vel = vec(0, 0);
    const nav = ai.nav;
    let dest: Vec2 | null = null;
    let direct = false;
    // Same rule as navChase: a beeline is a same-level manoeuvre. Between plans
    // this is the path that would otherwise coast into a staircase and stall.
    const chase =
      this.lastTarget && this.lastTarget.hp > 0 && this.lastTarget.z === this.z
        ? this.lastTarget
        : null;
    if (this.atGoalNode) {
      // Only at the character the plan found us sharing a node with (planFor);
      // lastTarget can be someone else entirely by now.
      if (chase && chase === this.planFor) {
        direct = true;
        dest = chase.pos;
      }
    } else if (nav && this.waypoint >= 0 && this.waypoint < nav.nodes.length) {
      dest = nav.nodes[this.waypoint].pos;
    }
    if (!dest) return;
    if (direct && chase && dist(this.pos, dest) <= this.standoffFor(chase)) return;
    const d = dist(this.pos, dest);
    if (d < 1e-3) return;
    const move = scale(norm(sub(dest, this.pos)), Math.min(this.stepSpeed(), d));
    const next = add(this.pos, move);
    if (direct && zAt(ai.world, next, this.z) !== this.z) return; // beeline never flips z
    this.vel = move;
    this.pos = next;
  }

  /** The Oracle's whole movement policy, reusable by subclasses: walk the
   *  graph toward `chase`, beelining only within the shared node cell. The
   *  step taken is recorded in `vel`, so anything reading speed (the real
   *  gun's movement penalty, for one) sees graph walking as movement. */
  protected navChase(ai: AiContext, chase: Character, target: Character | null): void {
    let dest: Vec2 | null = null;
    let direct = false; // beeline step (level-locked) vs waypoint leg

    if (ai.nav && ai.nav.nodes.length > 0) {
      this.updatePlan(ai.nav, ai.world, chase, ai.tick);
      if (this.atGoalNode && this.planFor === chase && this.z === chase.z) {
        // Same node as the target: close-quarters chase on the target itself.
        // Was `(target || this.z === chase.z)`. A target used to imply a shared
        // level — selectTarget refused anyone else — so the shorthand was safe.
        // Now that off-level hostiles are targets, it made a bot beeline at
        // someone a floor away and freeze on the stair boundary, where the guard
        // below refuses the level change. Only waypoint legs cross floors.
        // And only at the character the plan was made for: when the plan
        // budget defers a replan onto a new chase, the old plan's "same node"
        // must not be read as being about this one.
        direct = true;
        dest = chase.pos;
      } else if (this.waypoint >= 0) {
        // Otherwise the graph is authoritative, seen target or not.
        dest = ai.nav.nodes[this.waypoint].pos;
      }
    } else if (target) {
      direct = true; // no graph: nothing smarter than walking at what it sees
      dest = target.pos;
    }
    if (!dest) return;
    if (direct && dist(this.pos, chase.pos) <= this.standoffFor(chase)) return;

    const d = dist(this.pos, dest);
    if (d < 1e-3) return;
    const dir = norm(sub(dest, this.pos));
    const move = scale(dir, Math.min(this.stepSpeed(), d));
    const next = add(this.pos, move);
    // A direct step never crosses a stair midpoint: flipping z would drop the
    // target from sight and re-route — the rapid-flicker failure mode. Hold
    // the line and keep shooting; only waypoint legs change level.
    if (direct && zAt(ai.world, next, this.z) !== this.z) return;
    this.vel = move;
    this.pos = next;

    // Facing while walking blind — after holding the last combat aim for a
    // beat, so losing sight doesn't instantly swing the gun away. Blind aim
    // looks at the node being walked to and, once near it, at the hop after
    // it: the muzzle clears the corner before the body does. Direct steps
    // (beeline / no graph) just face the walk.
    if (!target && this.ticksSinceTarget > AIM_HOLD_TICKS) {
      // A sprint faces where it's going (dest = the waypoint it's stepping to);
      // otherwise pre-aim the corner ahead via lookahead.
      const look = direct || this.facesTravel() ? dest : this.lookahead(ai.nav, dest);
      // Set the desired heading; think() eases the actual heading toward it.
      if (dist(look, this.pos) > 1e-3) this.aimAngle = angleOf(sub(look, this.pos));
    }
  }

  /** Where blind movement points the gun: the farthest node within
   *  FACE_NEXT_DISTANCE of walking along the planned route — the leg to the
   *  committed waypoint spends budget first, then edge by edge toward the
   *  goal. NOTE route().dist is the TOTAL remaining path length, not a hop
   *  cost, so each edge is measured between its own two nodes. */
  private lookahead(nav: NavGraph | null, dest: Vec2): Vec2 {
    const MAX_HOPS = 5; // route() is O(1); this just bounds the walk per tick
    if (
      !nav ||
      this.waypoint < 0 ||
      this.goal < 0 ||
      this.goal >= nav.nodes.length ||
      this.waypoint === this.goal
    ) {
      return dest;
    }
    let remaining = FACE_NEXT_DISTANCE - dist(this.pos, dest);
    let curr = this.waypoint;
    for (let hops = 0; hops < MAX_HOPS && curr !== this.goal; hops++) {
      const step = nav.route(curr, this.goal, this.team);
      if (!step) break;
      const edge = dist(nav.nodes[curr].pos, nav.nodes[step.next].pos);
      if (edge > remaining) break; // the next node is past the look distance
      remaining -= edge;
      curr = step.next;
    }
    return nav.nodes[curr].pos;
  }

  // --- global replan budget -------------------------------------------------
  // A full plan() costs ~2–3ms of CCH congestion restamp (the setRoute pair),
  // so a handful landing on the same tick is a frame spike. The budget caps
  // plan() calls per tick ACROSS all Oracles; a bot over budget keeps its
  // committed route and retries next tick (navChase just holds a tick in the
  // rare no-waypoint case). Sized from last tick's population so steady-state
  // demand (population / REPLAN_TICKS) always fits with slack — the deferral
  // queue drains instead of growing.
  private static planTick = -1;
  private static popSeen = 0;
  private static plansLeft = 2;

  /** Roll the per-tick budget window; called once per updatePlan. */
  private static tickBudget(tick: number): void {
    if (tick === Oracle.planTick) {
      Oracle.popSeen += 1;
      return;
    }
    Oracle.planTick = tick;
    Oracle.plansLeft = Math.max(2, Math.ceil(Oracle.popSeen / REPLAN_TICKS) + 1);
    Oracle.popSeen = 1;
  }

  /** Keep the committed waypoint fresh: advance on arrival at intermediate
   *  hops, and re-plan on a short timer so a moving target keeps redirecting
   *  the chase (ARRIVE_EPS never gates a goal-node plan — see atGoalNode). */
  private updatePlan(nav: NavGraph, world: World, chase: Character, tick: number): void {
    Oracle.tickBudget(tick);
    this.replanIn -= 1;
    if (this.waypoint >= nav.nodes.length) this.waypoint = -1; // stale id safety
    if (
      this.waypoint >= 0 &&
      !this.atGoalNode &&
      dist(this.pos, nav.nodes[this.waypoint].pos) <= ARRIVE_EPS
    ) {
      this.waypoint = -1; // reached an intermediate hop: pick the next one now
    }
    // A different chase than the plan was made for is a different route: replan
    // now rather than walking the old one until the timer happens to fire.
    if (
      (this.waypoint < 0 || this.replanIn <= 0 || chase !== this.planFor) &&
      Oracle.plansLeft > 0
    ) {
      Oracle.plansLeft -= 1;
      this.plan(nav, world, chase);
      this.replanIn = REPLAN_TICKS + Math.floor(Math.random() * REPLAN_JITTER);
    }
    this.skipReachableHops(nav, world);
  }

  /** String-pull the committed route: while the hop AFTER the current waypoint
   *  (toward the goal) is already reachable in a straight clear line from here,
   *  skip the current waypoint and head for that hop instead — cutting the corner
   *  rather than first detouring out to a node we can already see past. Bounded
   *  per tick and, across ticks, by SKIP_AHEAD_DIST of route per commitment; runs forward
   *  only (toward the goal), so it can't oscillate. Stops at the goal node, where
   *  the existing arrival/atGoalNode flow takes over. */
  private skipReachableHops(nav: NavGraph, world: World): void {
    if (this.atGoalNode || this.goal < 0) return;
    for (let hop = 0; hop < MAX_SKIP && this.waypoint >= 0 && this.waypoint !== this.goal; hop++) {
      const step = nav.route(this.waypoint, this.goal, this.team);
      if (!step) return;
      const next = nav.nodes[step.next];
      const cut = dist(nav.nodes[this.waypoint].pos, next.pos); // route length this skip jumps past
      if (cut > this.skipLeft) return;
      if (!walkable(world, this.pos, this.z, next.pos, next.z)) return;
      this.waypoint = step.next;
      this.skipLeft -= cut;
    }
  }

  /** One path query, committing `waypoint` + `atGoalNode`. My node is the
   *  nearest *walkable* node; the target's is the nearest that *sees* it. */
  private plan(nav: NavGraph, world: World, chase: Character): void {
    // Take our own route off the congestion field first: every query below reads
    // the congested metric, and routing around yesterday's version of ourselves
    // is both wrong and unstable. It goes back on at the end, so between plans
    // everyone else still sees where we intend to walk.
    nav.setRoute(this, [], this.team);
    const committed = this.waypoint;
    this.planFor = chase;
    try {
      this.planInner(nav, world, chase);
    } finally {
      // A new commitment (arrived and moved on, or re-routed) earns a fresh
      // string-pull allowance; a replan that keeps the same hop does not, or the
      // waypoint would creep forward without limit one replan at a time.
      if (this.waypoint !== committed) this.skipLeft = SKIP_AHEAD_DIST;
      // Declare the new route whatever happened, including the early returns
      // that leave us with no waypoint at all (which declares nothing).
      nav.setRoute(this, this.routeNodes(nav), this.team);
    }
  }

  /** The committed route's nodes, for the congestion field — built in ONE query
   *  (not one per hop) and capped at ROUTE_STAMP_HOPS edges (currently no cap:
   *  the whole route — see ROUTE_STAMP_HOPS). */
  private routeNodes(nav: NavGraph): number[] {
    if (this.waypoint < 0 || this.goal < 0) return [];
    const rp = nav.routePath(this.waypoint, this.goal, this.team);
    if (!rp) return [this.waypoint];
    const path = rp.nodes;
    return path.length > ROUTE_STAMP_HOPS + 1 ? path.slice(0, ROUTE_STAMP_HOPS + 1) : path;
  }

  private planInner(nav: NavGraph, world: World, chase: Character): void {
    const prev = this.waypoint; // the hop committed before this replan, or -1
    this.waypoint = -1;
    this.atGoalNode = false;
    this.goal = -1;
    const goal = nav.nearestInSight(world, chase.pos, chase.z);
    const curr = nav.nearestWalkable(world, this.pos, this.z);
    if (goal < 0 || curr < 0) return;
    this.goal = goal;
    if (curr === goal) {
      this.waypoint = goal;
      this.atGoalNode = true;
      return;
    }
    const step = nav.route(curr, goal, this.team);
    if (!step) return;
    const next = nav.nodes[step.next];
    // Head straight for the next hop when it's walkable from right here (we're
    // rarely standing exactly on curr); otherwise detour via curr, which is
    // walkable by construction — grinding into the wall between us and the
    // next hop was the wall-by-the-stairs bug. Standing on curr already, trust
    // the graph edge.
    const fresh =
      dist(this.pos, nav.nodes[curr].pos) <= ARRIVE_EPS ||
      walkable(world, this.pos, this.z, next.pos, next.z)
        ? step.next
        : curr;
    // Sticky hop: standing near the boundary between two nodes' cells, each
    // timed replan can re-derive a different "my node" — and when the two
    // nodes' next hops toward the goal point in opposite directions (a hairpin
    // route around a wall-cut link), alternate replans reverse the walk every
    // REPLAN_TICKS forever. So a replan only overrides the committed hop when
    // the fresh plan is decisively cheaper (walk leg + remaining route, using
    // route().dist = total remaining path length) or the committed hop went
    // stale/unwalkable. Chasing a moving goal still redirects: as the goal
    // drifts, the fresh cost eventually undercuts the margin and we switch.
    if (prev >= 0 && prev < nav.nodes.length && prev !== fresh) {
      const cost = (w: number): number | null => {
        const leg = dist(this.pos, nav.nodes[w].pos);
        if (w === goal) return leg;
        const r = nav.route(w, goal, this.team);
        return r ? leg + r.dist : null;
      };
      const prevCost = cost(prev);
      const freshCost = cost(fresh);
      if (
        prevCost !== null &&
        freshCost !== null &&
        prevCost <= freshCost + SWITCH_MARGIN &&
        walkable(world, this.pos, this.z, nav.nodes[prev].pos, nav.nodes[prev].z)
      ) {
        this.waypoint = prev;
        return;
      }
    }
    this.waypoint = fresh;
  }
}
