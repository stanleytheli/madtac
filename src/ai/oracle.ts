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
import type { Skin } from "../entities/character.ts";
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
const SWITCH_MARGIN = 80; // keep the committed hop unless a fresh plan is this much cheaper (px)
const AIM_HOLD_TICKS = 45; // keep the last combat aim this long after losing sight
const FACE_NEXT_DISTANCE = 650; // this close to the waypoint, aim at the hop after it

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
   *  state in which beelining at the target itself is allowed. */
  private atGoalNode = false;
  /** The goal node of the last plan (nearest node that sees the chase), or
   *  -1. Kept so blind facing can look up the hop after the waypoint. */
  private goal = -1;
  private replanIn = 0;

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
    const chase = this.lastTarget && this.lastTarget.hp > 0 ? this.lastTarget : null;
    if (this.atGoalNode) {
      if (chase) {
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
    const next = add(this.pos, scale(norm(sub(dest, this.pos)), Math.min(this.stepSpeed(), d)));
    if (direct && zAt(ai.world, next, this.z) !== this.z) return; // beeline never flips z
    this.vel = sub(next, this.pos);
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
      this.updatePlan(ai.nav, ai.world, chase);
      if (this.atGoalNode && (target || this.z === chase.z)) {
        // Same node as the target: close-quarters chase on the target itself.
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
    const next = add(this.pos, scale(dir, Math.min(this.stepSpeed(), d)));
    // A direct step never crosses a stair midpoint: flipping z would drop the
    // target from sight and re-route — the rapid-flicker failure mode. Hold
    // the line and keep shooting; only waypoint legs change level.
    if (direct && zAt(ai.world, next, this.z) !== this.z) return;
    this.vel = sub(next, this.pos);
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
      const step = nav.route(curr, this.goal);
      if (!step) break;
      const edge = dist(nav.nodes[curr].pos, nav.nodes[step.next].pos);
      if (edge > remaining) break; // the next node is past the look distance
      remaining -= edge;
      curr = step.next;
    }
    return nav.nodes[curr].pos;
  }

  /** Keep the committed waypoint fresh: advance on arrival at intermediate
   *  hops, and re-plan on a short timer so a moving target keeps redirecting
   *  the chase (ARRIVE_EPS never gates a goal-node plan — see atGoalNode). */
  private updatePlan(nav: NavGraph, world: World, chase: Character): void {
    this.replanIn -= 1;
    if (this.waypoint >= nav.nodes.length) this.waypoint = -1; // stale id safety
    if (
      this.waypoint >= 0 &&
      !this.atGoalNode &&
      dist(this.pos, nav.nodes[this.waypoint].pos) <= ARRIVE_EPS
    ) {
      this.waypoint = -1; // reached an intermediate hop: pick the next one now
    }
    if (this.waypoint < 0 || this.replanIn <= 0) {
      this.plan(nav, world, chase);
      this.replanIn = REPLAN_TICKS;
    }
  }

  /** One path query, committing `waypoint` + `atGoalNode`. My node is the
   *  nearest *walkable* node; the target's is the nearest that *sees* it. */
  private plan(nav: NavGraph, world: World, chase: Character): void {
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
    const step = nav.route(curr, goal);
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
        const r = nav.route(w, goal);
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
