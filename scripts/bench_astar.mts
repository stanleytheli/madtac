/**
 * A* (recompute-every-query) vs the cached all-pairs table, as a fraction of
 * total AI computation, on a real ~few-hundred-node level (dom-arena-big, 262
 * nodes).
 *
 * Why: today NavGraph bakes an n x n (hop, dist) table with Dijkstra once at load
 * and every runtime query is an O(1) array read. That cache is only valid while
 * the graph is static. Cars / destructible obstacles would mutate walkability, so
 * the cache would have to be rebuilt on every change (O(n^2) Dijkstra + the far
 * pricier all-pairs walkability march) OR abandoned in favour of computing each
 * shortest path on demand with A*. This measures that on-demand A* cost.
 *
 * Method:
 *   1. Run the actual Game headless with the profiler on, so "ai" is the real
 *      per-tick AI budget on this map with these bots.
 *   2. Wrap NavGraph.route to count queries/tick and sample real (from,to) pairs
 *      (the true query distribution: reachable, mid-range, chasing goals).
 *   3. Benchmark, over those same pairs: (a) the cached route(), (b) a tuned A*
 *      (binary heap, typed-array g-scores, admissible straight-line heuristic
 *      over the identical movable edge set).
 *   4. Report A*'s added cost per tick as a fraction of the "ai" span.
 *
 * Run: node_modules/.bin/esbuild scripts/bench_astar.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/bench.mjs && node <tmp>/bench.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import { NavGraph } from "../src/world/nav.ts";
import { profiler } from "../src/engine/profiler.ts";
import { dist, type Vec2 } from "../src/engine/vec.ts";
import type { PathNode } from "../src/world/world.ts";

// ------------------------------------------------------------------ A* --------
// Binary min-heap keyed by f-score; stores node ids. Lazy-deletion (push a node
// again on a better g, skip stale pops via the closed set) — standard and fast.
class MinHeap {
  private ks: number[] = []; // priorities (f)
  private vs: number[] = []; // node ids
  get size(): number {
    return this.ks.length;
  }
  push(v: number, k: number): void {
    this.ks.push(k);
    this.vs.push(v);
    let i = this.ks.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.ks[p] <= this.ks[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const v = this.vs[0];
    const last = this.ks.length - 1;
    this.swap(0, last);
    this.ks.pop();
    this.vs.pop();
    let i = 0;
    const n = this.ks.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.ks[l] < this.ks[m]) m = l;
      if (r < n && this.ks[r] < this.ks[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return v;
  }
  private swap(a: number, b: number): void {
    const tk = this.ks[a];
    this.ks[a] = this.ks[b];
    this.ks[b] = tk;
    const tv = this.vs[a];
    this.vs[a] = this.vs[b];
    this.vs[b] = tv;
  }
}

// Reusable scratch, sized once — mirrors how a real per-query A* would keep
// buffers around rather than allocate n Float64Arrays per call.
let g: Float64Array;
let parent: Int32Array;
let stamp: Int32Array; // visited-generation, avoids clearing g/parent each call
let gen = 0;

function astar(nodes: PathNode[], from: number, to: number): { next: number; dist: number } | null {
  if (from === to) return { next: from, dist: 0 };
  gen++;
  const goal = nodes[to].pos;
  const heap = new MinHeap();
  g[from] = 0;
  parent[from] = from;
  stamp[from] = gen;
  heap.push(from, dist(nodes[from].pos, goal));
  while (heap.size) {
    const u = heap.pop();
    if (u === to) break;
    const gu = g[u];
    for (const [v, w] of nodes[u].movable) {
      const ng = gu + w;
      if (stamp[v] !== gen || ng < g[v]) {
        stamp[v] = gen;
        g[v] = ng;
        parent[v] = u;
        heap.push(v, ng + dist(nodes[v].pos, goal));
      }
    }
  }
  if (stamp[to] !== gen) return null; // unreachable
  let first = to;
  while (parent[first] !== from) first = parent[first];
  return { next: first, dist: g[to] };
}

// ---------------------------------------------------- all-pairs Dijkstra ------
// Isolates the "rebuild the cache" cost (graph search only; NOT the edge
// walkability marches, which are far pricier). This is what you'd pay per
// obstacle change if you kept the cache instead of going on-demand.
function allPairsDijkstra(nodes: PathNode[]): void {
  const n = nodes.length;
  const hop = new Int32Array(n * n).fill(-1);
  const len = new Float64Array(n * n).fill(Infinity);
  const d = new Float64Array(n);
  const par = new Int32Array(n);
  const done = new Uint8Array(n);
  for (let src = 0; src < n; src++) {
    d.fill(Infinity);
    par.fill(-1);
    done.fill(0);
    d[src] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && d[i] < best) ((best = d[i]), (u = i));
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of nodes[u].movable) {
        if (d[u] + w < d[v]) ((d[v] = d[u] + w), (par[v] = u));
      }
    }
    const base = src * n;
    hop[base + src] = src;
    len[base + src] = 0;
    for (let v = 0; v < n; v++) {
      if (v === src || par[v] < 0) continue;
      let first = v;
      while (par[first] !== src) first = par[first];
      hop[base + v] = first;
      len[base + v] = d[v];
    }
  }
  // touch the tables so nothing is optimized away
  if (hop[0] === 1234567) console.log(len[0]);
}

// -------------------------------------------------------------- harness -------
const LEVEL = "src/world/levels/dom-arena-big.json";
const text = readFileSync(LEVEL, "utf8");
const WARMUP = 400;
const MEASURE = 3000;

// Instrument route(): count calls, sample (from,to) pairs. Wrap the prototype so
// every oracle query flows through the counter.
const realRoute = NavGraph.prototype.route;
let routeCalls = 0;
let sampling = false;
const pairs: { from: number; to: number }[] = [];
NavGraph.prototype.route = function (this: NavGraph, from: number, to: number) {
  if (sampling) {
    routeCalls++;
    if (pairs.length < 200_000 && from >= 0 && to >= 0) pairs.push({ from, to });
  }
  return realRoute.call(this, from, to);
};

const loaded = loadLevel(text);
const game = new Game(loaded, GAMEMODES.domination({ ...loaded.meta, mode: "domination" }));
const nav = (game as unknown as { nav: NavGraph }).nav;
const nodes = nav.nodes;
const n = nodes.length;
g = new Float64Array(n);
parent = new Int32Array(n);
stamp = new Int32Array(n).fill(-1);

// Warm up (JIT + let bots engage), then measure the real AI budget.
for (let t = 0; t < WARMUP; t++) game.update();
profiler.reset();
profiler.enabled = true;
sampling = true;
for (let t = 0; t < MEASURE; t++) {
  game.update();
  profiler.endFrame();
}
sampling = false;
profiler.enabled = false;

const rows = profiler.rows();
const aiRow = rows.find((r) => r.label === "ai");
const aiMsPerTick = aiRow ? aiRow.msPerFrame : 0;
const routePerTick = routeCalls / MEASURE;

console.log(`\n--- profiler breakdown (ms/tick, busiest first) ---`);
for (const r of rows) console.log(`  ${r.label.padEnd(16)} ${r.msPerFrame.toFixed(4)}  (${r.calls} calls)`);

// ---- micro-benchmark the two query strategies over the sampled real pairs ----
const REPS = Math.max(1, Math.ceil(400_000 / Math.max(1, pairs.length)));

// cached O(1) lookup
let sink = 0;
let s = performance.now();
for (let r = 0; r < REPS; r++)
  for (const p of pairs) {
    const res = realRoute.call(nav, p.from, p.to);
    if (res) sink += res.next;
  }
const cachedMs = performance.now() - s;
const cachedPerQuery = cachedMs / (REPS * pairs.length);

// A* on demand
s = performance.now();
for (let r = 0; r < REPS; r++)
  for (const p of pairs) {
    const res = astar(nodes, p.from, p.to);
    if (res) sink += res.next;
  }
const astarMs = performance.now() - s;
const astarPerQuery = astarMs / (REPS * pairs.length);

// correctness: A* path lengths must match the cached table on the sampled pairs
let mismatch = 0;
let checked = 0;
const seen = new Set<number>();
for (const p of pairs) {
  const key = p.from * n + p.to;
  if (seen.has(key)) continue;
  seen.add(key);
  checked++;
  const a = astar(nodes, p.from, p.to);
  const c = realRoute.call(nav, p.from, p.to);
  const al = a ? a.dist : Infinity;
  const cl = c ? c.dist : Infinity;
  if (Math.abs(al - cl) > 1e-6) mismatch++;
}

// ---- rebuild cost (the "keep the cache, refresh on change" alternative) ----
const RB = 30;
s = performance.now();
for (let r = 0; r < RB; r++) allPairsDijkstra(nodes);
const rebuildMs = (performance.now() - s) / RB;

// average movable degree, for context
let edges = 0;
for (const nd of nodes) edges += nd.movable.size;
const avgDeg = edges / n;

const pct = (x: number): string => (100 * x).toFixed(2) + "%";
console.log(`\n=== A* vs cached pathfinding — ${LEVEL} ===`);
console.log(`nodes=${n}  avg movable degree=${avgDeg.toFixed(1)}  (directed edges=${edges})`);
console.log(`measured ${MEASURE} ticks after ${WARMUP} warmup`);
console.log(`sampled route() pairs: ${pairs.length} (unique checked=${checked}, A*/cached len mismatches=${mismatch})`);
console.log(``);
console.log(`AI budget:            ${aiMsPerTick.toFixed(4)} ms / tick   (profiler "ai" span)`);
console.log(`route() queries:      ${routePerTick.toFixed(1)} / tick`);
console.log(``);
console.log(`per-query cost:`);
console.log(`  cached O(1) lookup: ${(cachedPerQuery * 1000).toFixed(4)} us`);
console.log(`  A* recompute:       ${(astarPerQuery * 1000).toFixed(4)} us   (${(astarPerQuery / cachedPerQuery).toFixed(0)}x cached)`);
console.log(``);
console.log(`cost per tick (queries/tick x per-query):`);
const cachedTick = cachedPerQuery * routePerTick;
const astarTick = astarPerQuery * routePerTick;
console.log(`  cached:  ${cachedTick.toFixed(5)} ms/tick  = ${pct(cachedTick / aiMsPerTick)} of AI`);
console.log(`  A*:      ${astarTick.toFixed(5)} ms/tick  = ${pct(astarTick / aiMsPerTick)} of AI`);
console.log(`  delta (A* - cached): ${(astarTick - cachedTick).toFixed(5)} ms/tick = +${pct((astarTick - cachedTick) / aiMsPerTick)} of AI`);
console.log(``);
console.log(`rebuild-the-cache alternative (all-pairs Dijkstra, edges assumed known):`);
console.log(`  ${rebuildMs.toFixed(3)} ms per full rebuild  (= ${(rebuildMs / aiMsPerTick).toFixed(1)}x one tick's AI budget)`);
console.log(`sink=${sink}`);
