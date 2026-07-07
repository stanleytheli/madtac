/**
 * Pathfinding over the level's hand-placed nodes (World.nodes).
 *
 * Each node gets two link sets (stored on the node, see PathNode in world.ts):
 *   - visible: same-z nodes with clear line of sight (fences don't block sight).
 *   - movable: nodes a body can walk straight to within MOVE_RADIUS. Walkability
 *     is a marched test: the body sweeps as a BODY_RADIUS circle against
 *     obstacles (fences DO block movement), and the walker's z is tracked
 *     across staircases — which is how the graph climbs between levels: a link
 *     whose straight line crosses a stair midpoint connects nodes on different
 *     z's.
 *
 * NavGraph then runs Dijkstra from every node over the movable links and caches
 * an n x n (from, to) -> (next hop, total path distance) table, so runtime path
 * queries are O(1). Build it once per level load; rebuild if nodes/walls change.
 */
import { BODY_RADIUS } from "../entities/character.ts";
import { circleIntersectsBox } from "../engine/collision.ts";
import { profiler } from "../engine/profiler.ts";
import { dist, vec, type Vec2 } from "../engine/vec.ts";
import { losClear, stairZ, type PathNode, type World } from "./world.ts";

/** Max straight-line distance of a movable link. */
export const MOVE_RADIUS = 350;

/** Sample spacing of the walkability march. The body circle (BODY_RADIUS >= 30)
 *  overlaps consecutive samples heavily, so even at 8 the deepest graze that
 *  could slip between two samples is under a third of a pixel. */
const MARCH_STEP = 8;

/** The z a walker at `currentZ` ends up on while standing at `p`: staircases
 *  dictate it sharply by their half; anywhere else it's unchanged. The same
 *  rule the game's stair-transition loop applies to characters. */
export function zAt(world: World, p: Vec2, currentZ: number): number {
  let z = currentZ;
  for (const s of world.stairs) {
    const sz = stairZ(s, p);
    if (sz !== null) z = sz;
  }
  return z;
}

/**
 * Can a body walk the straight line from `from` (at z `fromZ`) to `to`, ending
 * up at z `toZ`? Marches the segment: staircases flip the walker's z at their
 * midpoint exactly like the game's stair transition, and any obstacle on the
 * walker's current z that the body's circle would overlap — fences included —
 * blocks. The circle test keeps clearance honest at corners (an inflated-box
 * test squares them off, rejecting diagonals a round body actually clears).
 */
export function walkable(world: World, from: Vec2, fromZ: number, to: Vec2, toZ: number): boolean {
  return profiler.measure("ai.walkable", () => {
    const steps = Math.max(1, Math.ceil(dist(from, to) / MARCH_STEP));
    let z = fromZ;
    const grid = world.grid;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = vec(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      z = zAt(world, p, z);
      // Fences ARE solid to movement (unlike sight/bullets), so this uses the
      // grid's all-obstacle circle query — not the permeable-skipping LOS path.
      if (grid) {
        if (grid.solidCircle(p, BODY_RADIUS, z)) return false;
      } else {
        for (const o of world.obstacles) {
          if (o.z !== z) continue;
          if (circleIntersectsBox(p, BODY_RADIUS, o)) return false;
        }
      }
    }
    return z === toZ;
  });
}

/** Classify the link between two nodes (also used by the editor's node overlay). */
export function nodeEdge(
  world: World,
  a: PathNode,
  b: PathNode,
): { visible: boolean; movable: boolean } {
  const visible = a.z === b.z && losClear(world, a.pos, b.pos, a.z);
  const movable =
    dist(a.pos, b.pos) <= MOVE_RADIUS &&
    walkable(world, a.pos, a.z, b.pos, b.z) &&
    walkable(world, b.pos, b.z, a.pos, a.z);
  return { visible, movable };
}

/** Assign node ids (their array index) and fill every node's visible/movable
 *  sets from the current world geometry. */
export function buildNodeSets(world: World): void {
  const nodes = world.nodes;
  nodes.forEach((nd, i) => {
    nd.id = i;
    nd.visible.clear();
    nd.movable.clear();
  });
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const d = dist(a.pos, b.pos);
      const e = nodeEdge(world, a, b);
      if (e.visible) {
        a.visible.set(j, d);
        b.visible.set(i, d);
      }
      if (e.movable) {
        a.movable.set(j, d);
        b.movable.set(i, d);
      }
    }
  }
}

export class NavGraph {
  readonly nodes: PathNode[];
  private readonly n: number;
  /** hop[from * n + to] = first node to walk toward, or -1 if unreachable. */
  private readonly hop: Int32Array;
  /** len[from * n + to] = total path distance (Infinity if unreachable). */
  private readonly len: Float64Array;

  constructor(world: World) {
    buildNodeSets(world);
    this.nodes = world.nodes;
    const n = (this.n = this.nodes.length);
    this.hop = new Int32Array(n * n).fill(-1);
    this.len = new Float64Array(n * n).fill(Infinity);
    for (let src = 0; src < n; src++) this.runDijkstra(src);
  }

  /** Dijkstra over the movable links, then bake first hops by walking each
   *  target's parent chain back to the source. (Plain O(n^2) scan — node counts
   *  are small and this runs once per level load.) */
  private runDijkstra(src: number): void {
    const n = this.n;
    const d = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    d[src] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && d[i] < best) {
          best = d[i];
          u = i;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of this.nodes[u].movable) {
        if (d[u] + w < d[v]) {
          d[v] = d[u] + w;
          parent[v] = u;
        }
      }
    }
    const base = src * n;
    this.hop[base + src] = src;
    this.len[base + src] = 0;
    for (let v = 0; v < n; v++) {
      if (v === src || parent[v] < 0) continue;
      let first = v;
      while (parent[first] !== src) first = parent[first];
      this.hop[base + v] = first;
      this.len[base + v] = d[v];
    }
  }

  /** The cached route step: the next node to walk toward and the total path
   *  distance from `from` to `to`, or null if `to` is unreachable. */
  route(from: number, to: number): { next: number; dist: number } | null {
    if (from < 0 || to < 0 || from >= this.n || to >= this.n) return null;
    const next = this.hop[from * this.n + to];
    return next < 0 ? null : { next, dist: this.len[from * this.n + to] };
  }

  /** The nearest node a body at `pos` (on `z`) could walk straight to — the
   *  marched, body-inflated test, so it may sit up an adjacent staircase — or
   *  -1. This is "which node am I at" for AI path queries: sight isn't enough
   *  (a fence is see-through but solid, and a node peeking past a wall corner
   *  can be visible yet unreachable). */
  nearestWalkable(world: World, pos: Vec2, z: number): number {
    let best = -1;
    let bd = Infinity;
    for (const nd of this.nodes) {
      const d = dist(pos, nd.pos);
      if (d >= bd) continue;
      if (!walkable(world, pos, z, nd.pos, nd.z)) continue;
      best = nd.id;
      bd = d;
    }
    return best;
  }

  /** The nearest node on `z` with clear line of sight to `pos`, or -1. This is
   *  "which node counts as the target's position" for AI path queries. */
  nearestInSight(world: World, pos: Vec2, z: number): number {
    let best = -1;
    let bd = Infinity;
    for (const nd of this.nodes) {
      if (nd.z !== z) continue;
      const d = dist(pos, nd.pos);
      if (d >= bd) continue;
      if (!losClear(world, pos, nd.pos, z)) continue;
      best = nd.id;
      bd = d;
    }
    return best;
  }
}
