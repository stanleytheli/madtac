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
 * NavGraph turns those links into a Customizable Contraction Hierarchy (CCH) and
 * answers shortest-path queries against it. See NavGraph's own doc comment for
 * why CCH rather than the old all-pairs Dijkstra table.
 */
import { BODY_RADIUS } from "../entities/character.ts";
import type { TeamId } from "../entities/team.ts";
import { circleIntersectsObstacle } from "../engine/collision.ts";
import { profiler } from "../engine/profiler.ts";
import { dist, vec, type Vec2 } from "../engine/vec.ts";
import { losClear, stairZ, type PathNode, type World } from "./world.ts";
import type { Vehicle } from "../entities/vehicle.ts";

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
          if (circleIntersectsObstacle(p, BODY_RADIUS, o)) return false;
        }
      }
      // Vehicle hulls are solid to bodies too, so a parked one blocks the march.
      // This is what lets updateWalkability's re-march see a vehicle — the CCH hook.
      if (world.vehicles.length) {
        for (const v of world.vehicles) {
          if (v.z === z && v.blocksCircle(p, BODY_RADIUS)) return false;
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

/**
 * Shortest-path index over the nav nodes, as a **Customizable Contraction
 * Hierarchy** (Dibbelt, Strasser & Wagner, 2016).
 *
 * The old index baked an n x n (first-hop, distance) table with an all-pairs
 * Dijkstra at load. O(1) queries, but the table is only valid while the graph
 * is frozen: the moment a car parks across a lane or a crate is blown open, the
 * whole n x n table (and the far pricier edge-walkability marches behind it)
 * has to be rebuilt. Cars and destructibles make that a per-frame cost.
 *
 * CCH splits the work into three stages so a graph change only pays for what
 * actually moved:
 *
 *   1. Topology (metric-independent, built once, survives every weight change).
 *      The candidate edge set is every node pair within MOVE_RADIUS — the links
 *      that *could* ever be walkable, since a body can't step farther than that
 *      in one hop. We pick a contraction order (min-degree) and contract nodes
 *      one at a time, adding a "shortcut" arc between the higher-ranked
 *      neighbours of each contracted node. The union of original candidate edges
 *      and these shortcuts is the CCH search graph — a chordal supergraph whose
 *      shape depends only on which nodes are near which, never on weights.
 *
 *   2. Customization (metric-dependent, cheap, re-runnable). Each arc gets a
 *      weight: a candidate edge that is currently walkable weighs its straight-
 *      line distance, one that is blocked weighs Infinity, and each shortcut
 *      weighs the shortest two-leg path through the node it bypasses. A single
 *      bottom-up pass over the hierarchy computes them all.
 *
 *   3. Query. A bidirectional up-only search (Dijkstra that only ever relaxes
 *      arcs to higher-ranked nodes) meets in the middle; the meeting node gives
 *      the exact distance, and unpacking the first shortcut on the source side
 *      recovers the first real hop.
 *
 * The point of stages 2-3 living apart from stage 1: when a car/crate toggles a
 * handful of edges, we recompute *only* the arc weights that transitively
 * depend on them (updateWalkability -> customizeDirty), in rank order, touching
 * a sparse neighbourhood of the hierarchy instead of the whole graph. The
 * topology never changes, because a blocked edge is just an Infinity weight on
 * an arc that still exists.
 */
/** One customized weighting of the shared CCH topology (see NavGraph.plain and
 *  the per-team congested metrics built by teamCong). */
interface Metric {
  w: Float64Array;
  mid: Int32Array;
  child0: Int32Array;
  child1: Int32Array;
  /** Per-arc surcharge on top of aBase, or null for the plain distance metric. */
  extra: Float64Array | null;
}

export class NavGraph {
  readonly nodes: PathNode[];
  private readonly n: number;

  /** Contraction order. rank[node] = when it was contracted (0 = first = least
   *  important); order[r] = the node with rank r. Higher rank = "more important",
   *  searched toward. */
  private readonly rank: Int32Array;
  private readonly order: Int32Array;

  // ---- CCH arcs (undirected, oriented lo->hi by rank). Parallel arrays keyed
  //      by arc id. `mid` is the bypassed node for a shortcut, or -1 for a real
  //      candidate edge; child0/child1 are the two legs a shortcut unpacks into
  //      (arc lo->mid and arc hi->mid), letting first-hop unpack without a map. --
  private aLo!: Int32Array;
  private aHi!: Int32Array;
  private aBase!: Float64Array; // straight-line dist if walkable now, else Infinity

  /** One customization of the hierarchy. The topology is shared; each metric
   *  carries its own weights and shortcut-unpacking pointers, which is the whole
   *  point of a CCH — a second metric costs a customization, not a rebuild.
   *  `extra` is a per-arc surcharge added to the walkable base distance (null for
   *  the plain metric). Infinity + surcharge is still Infinity, so a blocked edge
   *  stays blocked whatever the surcharge. */
  private plain!: Metric;
  /** Congestion is PER TEAM: a bot spreads out from its own teammates' committed
   *  routes, and ignores where enemies are walking (you don't detour around a foe
   *  you may want to intercept). Each team gets its own surcharge array + congested
   *  metric, built lazily on first use (teamCong). Same per-stamp / per-query cost
   *  as one shared field — just partitioned by team. */
  private readonly congByTeam = new Map<TeamId, { congestion: Float64Array; cong: Metric }>();
  /** Each owner's currently-stamped route arcs, so a re-stamp only pays for the
   *  difference (a bot re-planning to a similar route touches almost nothing). An
   *  owner never changes team, so the arcs always belong to that team's field. */
  private readonly stamped = new Map<object, number[]>();

  /** up[v] / down[v]: v's CCH neighbours of higher / lower rank, each with the
   *  arc id, so query and customization walk the hierarchy without map lookups. */
  private up!: { to: number; arc: number }[][];
  private down!: { to: number; arc: number }[][];
  /** loNode * n + hiNode -> arc id. Only touched at build/customize time. */
  private arcOf!: Map<number, number>;

  // ---- query scratch (reused across calls; a generation stamp avoids clearing
  //      the distance/parent arrays every query) ----
  private df!: Float64Array;
  private db!: Float64Array;
  private fpar!: Int32Array;
  private bpar!: Int32Array;
  private fparArc!: Int32Array;
  private bparArc!: Int32Array;
  private fstamp!: Int32Array;
  private bstamp!: Int32Array;
  private fseen!: Int32Array; // forward-settled node ids, for a tight meeting scan
  private fseenLen = 0;
  private gen = 0;
  private hNode!: Int32Array; // binary heap payload (node ids)
  private hKey!: Float64Array; // binary heap keys (distances)
  private hSize = 0;
  private hPopKey = 0; // key of the most recent heapPop, for stale-entry skipping

  constructor(world: World) {
    buildNodeSets(world);
    this.nodes = world.nodes;
    const n = (this.n = this.nodes.length);
    this.rank = new Int32Array(n);
    this.order = new Int32Array(n);
    this.buildTopology();
    this.allocScratch();
    this.customizeFull(this.plain);
    // Per-team congested metrics are built on demand (teamCong), so nothing to
    // customize here beyond the plain baseline.
  }

  // ============================================================ topology =======

  /** Stage 1: pick a contraction order and build the chordal CCH arc set from
   *  the proximity graph (every within-MOVE_RADIUS pair). Weight-independent —
   *  runs once and is never touched by edge changes. */
  private buildTopology(): void {
    const n = this.n;
    const nodes = this.nodes;
    // Working adjacency for the contraction simulation: every candidate (within
    // radius) pair, walkable or not. Blocked pairs still get an arc — they carry
    // an Infinity weight the customization can later relax to a real distance if
    // a crate is destroyed / a car pulls away.
    const nb: Set<number>[] = nodes.map(() => new Set<number>());
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (dist(nodes[i].pos, nodes[j].pos) <= MOVE_RADIUS) {
          nb[i].add(j);
          nb[j].add(i);
        }
      }
    }

    const contracted = new Uint8Array(n);
    const loNodes: number[] = [];
    const hiNodes: number[] = [];
    // Min-degree contraction: repeatedly contract the lowest-degree remaining
    // node. Cheap, and on these near-planar node layouts it keeps shortcut count
    // (and thus query fan-out) low. n is a few hundred, so the O(n^2) min scan is
    // nothing next to the walkability marches buildNodeSets already paid.
    for (let r = 0; r < n; r++) {
      let v = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!contracted[i] && nb[i].size < best) {
          best = nb[i].size;
          v = i;
        }
      }
      this.rank[v] = r;
      this.order[r] = v;
      contracted[v] = 1;
      const nbrs: number[] = [];
      for (const w of nb[v]) {
        if (!contracted[w]) {
          nbrs.push(w);
          nb[w].delete(v);
        }
      }
      // v is lower rank than every remaining neighbour, so each {v,w} is a CCH
      // arc oriented v->w. Recorded once, here, by its lower-rank endpoint.
      for (const w of nbrs) {
        loNodes.push(v);
        hiNodes.push(w);
      }
      // Fill: contracting v makes its remaining neighbours mutually adjacent.
      for (let a = 0; a < nbrs.length; a++) {
        for (let b = a + 1; b < nbrs.length; b++) {
          const p = nbrs[a];
          const q = nbrs[b];
          if (!nb[p].has(q)) {
            nb[p].add(q);
            nb[q].add(p);
          }
        }
      }
    }

    const m = loNodes.length;
    this.aLo = new Int32Array(loNodes);
    this.aHi = new Int32Array(hiNodes);
    this.aBase = new Float64Array(m);
    this.plain = this.makeMetric(null);
    this.up = nodes.map(() => []);
    this.down = nodes.map(() => []);
    this.arcOf = new Map();
    for (let a = 0; a < m; a++) {
      const lo = this.aLo[a];
      const hi = this.aHi[a];
      this.up[lo].push({ to: hi, arc: a });
      this.down[hi].push({ to: lo, arc: a });
      this.arcOf.set(lo * n + hi, a);
      // Base weight from the movable set buildNodeSets already computed: a
      // walkable candidate pair carries its distance, a blocked one Infinity.
      const d = nodes[lo].movable.get(hi);
      this.aBase[a] = d === undefined ? Infinity : d;
    }
  }

  private allocScratch(): void {
    const n = this.n;
    const m = this.aLo.length;
    this.df = new Float64Array(n);
    this.db = new Float64Array(n);
    this.fpar = new Int32Array(n);
    this.bpar = new Int32Array(n);
    this.fparArc = new Int32Array(n);
    this.bparArc = new Int32Array(n);
    this.fstamp = new Int32Array(n).fill(-1);
    this.bstamp = new Int32Array(n).fill(-1);
    this.fseen = new Int32Array(n);
    // Lazy-decrease-key heap: at most one push per arc relaxation per search.
    this.hNode = new Int32Array(m + n + 1);
    this.hKey = new Float64Array(m + n + 1);
  }

  // ======================================================== customization =====

  /** An arc's own cost under `m` before any shortcut relaxation: the walkable
   *  base distance plus this metric's surcharge (blocked stays Infinity). */
  private baseOf(m: Metric, a: number): number {
    return m.extra === null ? this.aBase[a] : this.aBase[a] + m.extra[a];
  }

  /** A fresh, uncustomized metric over the current arc set. `extra` is its per-arc
   *  surcharge (null for the plain distance metric). */
  private makeMetric(extra: Float64Array | null): Metric {
    const m = this.aBase.length;
    return {
      w: new Float64Array(m),
      mid: new Int32Array(m).fill(-1),
      child0: new Int32Array(m).fill(-1),
      child1: new Int32Array(m).fill(-1),
      extra,
    };
  }

  /** Stage 2 (full): weigh every arc of one metric. One bottom-up pass —
   *  process apex nodes in increasing rank; each apex relaxes the arc between
   *  every pair of its higher-ranked neighbours through itself. When an apex is
   *  reached, all arcs among lower-ranked nodes are already final, so a single
   *  pass suffices. */
  private customizeFull(mt: Metric): void {
    const m = this.aLo.length;
    for (let a = 0; a < m; a++) {
      mt.w[a] = this.baseOf(mt, a);
      mt.mid[a] = -1;
      mt.child0[a] = -1;
      mt.child1[a] = -1;
    }
    for (let r = 0; r < this.n; r++) {
      const x = this.order[r];
      const ups = this.up[x];
      for (let i = 0; i < ups.length; i++) {
        const wi = mt.w[ups[i].arc];
        if (wi === Infinity) continue;
        for (let j = i + 1; j < ups.length; j++) {
          const cand = wi + mt.w[ups[j].arc];
          const y = ups[i].to;
          const z = ups[j].to;
          const uarc = this.arc(y, z);
          if (uarc >= 0 && cand < mt.w[uarc]) {
            mt.w[uarc] = cand;
            mt.mid[uarc] = x;
            // legs: arc(lo(uarc), x) and arc(hi(uarc), x)
            mt.child0[uarc] = this.arc(this.aLo[uarc], x);
            mt.child1[uarc] = this.arc(this.aHi[uarc], x);
          }
        }
      }
    }
  }

  /** Recompute one arc's weight from scratch: its own base plus the best lower
   *  triangle (a common lower-ranked neighbour x, going lo->x->hi). Returns true
   *  if the weight or midpoint changed. Assumes every lower-ranked arc is
   *  already final — the rank-ordered queue in customizeDirty guarantees it. */
  private recomputeArc(mt: Metric, a: number): boolean {
    const lo = this.aLo[a];
    const hi = this.aHi[a];
    let w = this.baseOf(mt, a);
    let mid = -1;
    for (const dn of this.down[lo]) {
      const x = dn.to; // rank(x) < rank(lo) < rank(hi)
      const xhi = this.arc(x, hi);
      if (xhi < 0) continue;
      const cand = mt.w[dn.arc] + mt.w[xhi];
      if (cand < w) {
        w = cand;
        mid = x;
      }
    }
    if (w === mt.w[a] && mid === mt.mid[a]) return false;
    mt.w[a] = w;
    mt.mid[a] = mid;
    mt.child0[a] = mid < 0 ? -1 : this.arc(lo, mid);
    mt.child1[a] = mid < 0 ? -1 : this.arc(hi, mid);
    return true;
  }

  /** Stage 2 (partial): given arcs whose base weight just changed, recompute the
   *  weights that transitively depend on them and nothing else. Arcs are settled
   *  in increasing rank-of-lower-endpoint order (a heap keyed by that rank), the
   *  same order full customization uses, so each arc sees final lower-ranked
   *  legs. When an arc's weight changes it can only affect the upper arc of the
   *  triangles it sits in as a lower leg (apex = its lower endpoint), so we
   *  enqueue exactly those. Cost scales with the affected neighbourhood, not the
   *  graph. */
  private customizeDirty(mt: Metric, dirty: Iterable<number>): void {
    // Min-heap of arc ids keyed by rank of the arc's lower endpoint.
    const keys: number[] = [];
    const arcs: number[] = [];
    const queued = new Set<number>();
    const push = (a: number): void => {
      if (queued.has(a)) return;
      queued.add(a);
      const k = this.rank[this.aLo[a]];
      keys.push(k);
      arcs.push(a);
      let i = keys.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        [keys[p], keys[i]] = [keys[i], keys[p]];
        [arcs[p], arcs[i]] = [arcs[i], arcs[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = arcs[0];
      const last = keys.length - 1;
      keys[0] = keys[last];
      arcs[0] = arcs[last];
      keys.pop();
      arcs.pop();
      let i = 0;
      const sz = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let mn = i;
        if (l < sz && keys[l] < keys[mn]) mn = l;
        if (rr < sz && keys[rr] < keys[mn]) mn = rr;
        if (mn === i) break;
        [keys[mn], keys[i]] = [keys[i], keys[mn]];
        [arcs[mn], arcs[i]] = [arcs[i], arcs[mn]];
        i = mn;
      }
      return top;
    };

    for (const a of dirty) push(a);
    while (keys.length) {
      const a = pop();
      queued.delete(a);
      if (!this.recomputeArc(mt, a)) continue;
      // Changed arc {lo,hi} is a lower leg only in apex-lo triangles: pair it
      // with every other up-arc {lo,z} and re-examine the upper arc {hi,z}.
      const lo = this.aLo[a];
      const hi = this.aHi[a];
      for (const u of this.up[lo]) {
        if (u.to === hi) continue;
        const uarc = this.arc(hi, u.to);
        if (uarc >= 0) push(uarc);
      }
    }
  }

  /** Re-derive the walkability (and thus weight) of the given node pairs from
   *  the current world, then customize only what changed. This is the hook for
   *  cars / destructibles: pass the handful of node pairs a changed obstacle
   *  touches and the hierarchy updates sparsely. Pairs outside the proximity
   *  graph (beyond MOVE_RADIUS) have no arc and are ignored. */
  updateWalkability(world: World, pairs: Iterable<readonly [number, number]>): void {
    const dirty: number[] = [];
    for (const [a, b] of pairs) {
      const arc = this.arc(a, b);
      if (arc < 0) continue;
      const lo = this.aLo[arc];
      const hi = this.aHi[arc];
      const na = this.nodes[lo];
      const nb = this.nodes[hi];
      const ok =
        walkable(world, na.pos, na.z, nb.pos, nb.z) && walkable(world, nb.pos, nb.z, na.pos, na.z);
      const base = ok ? dist(na.pos, nb.pos) : Infinity;
      if (base !== this.aBase[arc]) {
        this.aBase[arc] = base;
        // Keep the movable sets (used elsewhere as the walkable adjacency) in step.
        if (ok) {
          na.movable.set(hi, base);
          nb.movable.set(lo, base);
        } else {
          na.movable.delete(hi);
          nb.movable.delete(lo);
        }
        dirty.push(arc);
      }
    }
    // A base change moves every metric; each surcharge rides on top of it. Rare
    // (a vehicle moved / a crate broke) and only a handful of arcs, so re-doing it
    // for each team's congested metric on top of plain is a couple extra passes.
    if (dirty.length) {
      this.customizeDirty(this.plain, dirty);
      for (const { cong } of this.congByTeam.values()) this.customizeDirty(cong, dirty);
    }
  }

  // ============================================================ congestion ====

  /** Per-edge surcharge (world px) applied to each hop of a route someone has
   *  committed to walking. Big enough that a second bot prefers a genuinely
   *  different corridor when one exists, small enough that it never invents a
   *  long detour around a short shared hop.
   *
   *  Tuned by measurement, and it is NOT monotone — 60/200/400 all behave much
   *  the same, and by 2500 spreading is back to no-congestion levels. A surcharge
   *  that large dwarfs the Oracle's SWITCH_MARGIN (80), so the sticky-hop rule
   *  stops damping waypoint churn and the routes thrash. Width, not magnitude, is
   *  the lever that separates bots (see ROUTE_SPREAD). */
  static readonly ROUTE_PENALTY = 200;

  /** Stamp every edge incident to a route node, not only the edges the route
   *  itself uses. Magnitude alone saturates — past a point it just destabilises
   *  waypoints — so width is the lever that actually separates two bots onto
   *  different corridors. */
  static readonly ROUTE_SPREAD = true;

  /** `team`'s congestion field + metric, built (and fully customized once) on
   *  first use. A new field starts all-zero, so its metric equals `plain` until
   *  the first route is stamped. */
  private teamCong(team: TeamId): { congestion: Float64Array; cong: Metric } {
    let tc = this.congByTeam.get(team);
    if (!tc) {
      const congestion = new Float64Array(this.aBase.length);
      const cong = this.makeMetric(congestion);
      this.customizeFull(cong);
      tc = { congestion, cong };
      this.congByTeam.set(team, tc);
    }
    return tc;
  }

  /** Declare `owner`'s committed route as the node sequence `nodes`, replacing
   *  whatever it declared before. Only `team`'s CONGESTED metric sees it — plain
   *  `route()` distances are untouched, which matters because several callers
   *  (contact scans, threat picks) use them as measurements rather than as a
   *  choice of walk — and enemy teams' fields are untouched, so a bot only ever
   *  spreads out from its own side.
   *
   *  Only the difference against the owner's previous stamp is re-customized, so
   *  a bot re-planning onto a similar route pays for the few hops that changed.
   *  Pass an empty array to withdraw (death, or no route). */
  setRoute(owner: object, nodes: readonly number[], team: TeamId): void {
    const { congestion, cong } = this.teamCong(team);
    const next: number[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = this.arc(nodes[i], nodes[i + 1]);
      if (a >= 0) next.push(a);
    }
    // Stamp the CORRIDOR, not just the thread: every real edge touching a route
    // node, so a second bot can't dodge the surcharge by taking a near-parallel
    // edge between the same two nodes and walking shoulder to shoulder anyway.
    // Route edges get stamped twice over (once per endpoint), so the thread still
    // costs more than merely being beside it — a gradient rather than a wall.
    if (NavGraph.ROUTE_SPREAD) {
      for (const nd of nodes) {
        for (const e of this.up[nd]) if (Number.isFinite(this.aBase[e.arc])) next.push(e.arc);
        for (const e of this.down[nd]) if (Number.isFinite(this.aBase[e.arc])) next.push(e.arc);
      }
    }
    const prev = this.stamped.get(owner);
    if (prev === undefined && next.length === 0) return;
    // Multiset difference: an arc used by both stamps keeps its surcharge and is
    // never dirtied, which is what makes a re-plan onto a similar route cheap.
    const delta = new Map<number, number>();
    if (prev) for (const a of prev) delta.set(a, (delta.get(a) ?? 0) - 1);
    for (const a of next) delta.set(a, (delta.get(a) ?? 0) + 1);
    const dirty: number[] = [];
    for (const [a, d] of delta) {
      if (d === 0) continue;
      congestion[a] = Math.max(0, congestion[a] + d * NavGraph.ROUTE_PENALTY);
      dirty.push(a);
    }
    if (next.length) this.stamped.set(owner, next);
    else this.stamped.delete(owner);
    if (dirty.length) this.customizeDirty(cong, dirty);
  }

  /** Withdraw every stamp (match reset / level reload) across all teams. */
  clearRoutes(): void {
    for (const { congestion, cong } of this.congByTeam.values()) {
      const dirty: number[] = [];
      for (let a = 0; a < congestion.length; a++) {
        if (congestion[a] !== 0) {
          congestion[a] = 0;
          dirty.push(a);
        }
      }
      if (dirty.length) this.customizeDirty(cong, dirty);
    }
    this.stamped.clear();
  }

  /** The nav edges the CCH should re-check for vehicle `v`: every real candidate
   *  edge (a within-MOVE_RADIUS proximity arc) with a node near the vehicle, on
   *  the vehicle's level, packed as `min*n + max`. Deliberately a *superset* of the
   *  truly-blocked edges — `updateWalkability` re-marches each and only dirties the
   *  ones whose walkability actually flipped, so over-selecting costs a few marches,
   *  never a wrong graph. `Vehicle.syncNav` diffs this against last tick and only
   *  re-checks the change, so a parked vehicle (stable set) costs nothing. */
  candidateEdges(v: Vehicle): Set<number> {
    const out = new Set<number>();
    const box = v.aabb();
    const extra = 0.5 * Math.hypot(box.maxx - box.minx, box.maxy - box.miny);
    const cx = (box.minx + box.maxx) / 2;
    const cy = (box.miny + box.maxy) / 2;
    const reach = MOVE_RADIUS + extra;
    const near: number[] = [];
    for (const nd of this.nodes) {
      const dx = nd.pos.x - cx;
      const dy = nd.pos.y - cy;
      if (dx * dx + dy * dy <= reach * reach) near.push(nd.id);
    }
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const a = near[i];
        const b = near[j];
        if (this.nodes[a].z !== v.z && this.nodes[b].z !== v.z) continue;
        if (dist(this.nodes[a].pos, this.nodes[b].pos) > MOVE_RADIUS) continue;
        if (this.arc(a, b) < 0) continue;
        out.add(a < b ? a * this.n + b : b * this.n + a);
      }
    }
    return out;
  }

  private arc(a: number, b: number): number {
    const lo = this.rank[a] < this.rank[b] ? a : b;
    const hi = lo === a ? b : a;
    const id = this.arcOf.get(lo * this.n + hi);
    return id === undefined ? -1 : id;
  }

  // ============================================================== query ========

  /** The cached route step: the next node to walk toward and the total path
   *  distance from `from` to `to`, or null if `to` is unreachable. Pass a team to
   *  route on THAT team's congestion field (spread out from its own routes); omit
   *  it for the plain distance metric (measurements, and enemy-blind pathing). */
  route(from: number, to: number, congest: TeamId | null = null): { next: number; dist: number } | null {
    if (from < 0 || to < 0 || from >= this.n || to >= this.n) return null;
    if (from === to) return { next: from, dist: 0 };
    const mt = congest !== null ? this.teamCong(congest).cong : this.plain;
    return profiler.measure("ai.route", () => this.query(mt, from, to));
  }

  private query(mt: Metric, s: number, t: number): { next: number; dist: number } | null {
    const gen = ++this.gen;
    this.fseenLen = 0;
    this.upSearch(mt, s, this.df, this.fpar, this.fparArc, this.fstamp, gen, true);
    this.upSearch(mt, t, this.db, this.bpar, this.bparArc, this.bstamp, gen, false);

    // Meet in the middle: the apex minimising forward + backward up-distance.
    // Every candidate apex is forward-reachable from s, so scanning only the
    // forward-settled set (typically a few dozen nodes) suffices.
    let meet = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.fseenLen; i++) {
      const v = this.fseen[i];
      if (this.bstamp[v] !== gen) continue;
      const d = this.df[v] + this.db[v];
      if (d < bestDist) {
        bestDist = d;
        meet = v;
      }
    }
    if (meet < 0 || bestDist === Infinity) return null;

    // First real hop. The s->t path is s..meet (forward, up) then meet..t
    // (backward). If it ascends first, take the forward arc leaving s; if the
    // meeting node IS s, the path descends immediately toward t via s's
    // backward-tree parent. Either way, unpack that arc's source-side leg.
    let firstArc: number;
    if (meet !== s) {
      let cur = meet;
      while (this.fpar[cur] !== s) cur = this.fpar[cur];
      firstArc = this.fparArc[cur];
    } else {
      firstArc = this.bparArc[s];
    }
    return { next: this.firstHop(mt, s, firstArc), dist: bestDist };
  }

  /** Dijkstra from `src` relaxing only upward arcs, writing dist/parent/parentArc
   *  for every node it settles and stamping them with `gen`. */
  private upSearch(
    mt: Metric,
    src: number,
    d: Float64Array,
    par: Int32Array,
    parArc: Int32Array,
    stamp: Int32Array,
    gen: number,
    record: boolean,
  ): void {
    this.hSize = 0;
    d[src] = 0;
    par[src] = src;
    parArc[src] = -1;
    stamp[src] = gen;
    this.heapPush(src, 0);
    while (this.hSize > 0) {
      const u = this.heapPop();
      if (this.hPopKey > d[u]) continue; // stale entry: a later push already lowered d[u]
      if (record) this.fseen[this.fseenLen++] = u;
      const du = d[u];
      for (const e of this.up[u]) {
        const w = mt.w[e.arc];
        if (w === Infinity) continue;
        const nd = du + w;
        if (stamp[e.to] !== gen || nd < d[e.to]) {
          stamp[e.to] = gen;
          d[e.to] = nd;
          par[e.to] = u;
          parArc[e.to] = e.arc;
          this.heapPush(e.to, nd);
        }
      }
    }
  }

  /** Unpack the source-side leg of `arc` down to a real candidate edge and
   *  return the first node reached from `from`. A shortcut lo<->hi bypasses
   *  aMid, so the path from either endpoint heads toward aMid first — follow the
   *  stored child leg on `from`'s side until an unshortcut arc remains. */
  private firstHop(mt: Metric, from: number, arc: number): number {
    for (;;) {
      if (mt.mid[arc] < 0) return this.aLo[arc] === from ? this.aHi[arc] : this.aLo[arc];
      arc = this.aLo[arc] === from ? mt.child0[arc] : mt.child1[arc];
    }
  }

  private heapPush(node: number, key: number): void {
    let i = this.hSize++;
    this.hNode[i] = node;
    this.hKey[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.hKey[p] <= this.hKey[i]) break;
      this.heapSwap(i, p);
      i = p;
    }
  }

  private heapPop(): number {
    const top = this.hNode[0];
    this.hPopKey = this.hKey[0];
    const last = --this.hSize;
    this.hNode[0] = this.hNode[last];
    this.hKey[0] = this.hKey[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.hSize && this.hKey[l] < this.hKey[m]) m = l;
      if (r < this.hSize && this.hKey[r] < this.hKey[m]) m = r;
      if (m === i) break;
      this.heapSwap(i, m);
      i = m;
    }
    return top;
  }

  private heapSwap(a: number, b: number): void {
    const tn = this.hNode[a];
    this.hNode[a] = this.hNode[b];
    this.hNode[b] = tn;
    const tk = this.hKey[a];
    this.hKey[a] = this.hKey[b];
    this.hKey[b] = tk;
  }

  // ====================================================== node localisation ====

  /** The nearest node a body at `pos` (on `z`) could walk straight to — the
   *  marched, body-inflated test, so it may sit up an adjacent staircase — or
   *  -1. This is "which node am I at" for AI path queries: sight isn't enough
   *  (a fence is see-through but solid, and a node peeking past a wall corner
   *  can be visible yet unreachable).
   *
   *  Visits nodes nearest-first and returns the first walkable one, so the
   *  expensive body-march only runs on nodes closer than the answer — a far node
   *  is tested only if every nearer node failed. */
  nearestWalkable(world: World, pos: Vec2, z: number): number {
    for (const nd of this.byDistance(pos, this.nodes)) {
      if (walkable(world, pos, z, nd.pos, nd.z)) return nd.id;
    }
    return -1;
  }

  /** The nearest node on `z` with clear line of sight to `pos`, or -1. This is
   *  "which node counts as the target's position" for AI path queries. Like
   *  nearestWalkable, it raycasts nodes nearest-first and stops at the first
   *  visible one, so far nodes are never tested unless all nearer ones are hidden. */
  nearestInSight(world: World, pos: Vec2, z: number): number {
    for (const nd of this.byDistance(pos, this.nodes.filter((n) => n.z === z))) {
      if (losClear(world, pos, nd.pos, z)) return nd.id;
    }
    return -1;
  }

  /** `nodes` ordered by straight-line distance to `pos` (ascending). The sort is
   *  distance-only (no raycasts/marches), so it's cheap next to the LOS/walk
   *  tests it lets the callers short-circuit. */
  private byDistance(pos: Vec2, nodes: PathNode[]): PathNode[] {
    return nodes
      .map((nd) => ({ nd, d: dist(pos, nd.pos) }))
      .sort((a, b) => a.d - b.d)
      .map((e) => e.nd);
  }
}
