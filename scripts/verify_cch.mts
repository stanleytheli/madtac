/**
 * Verifies the CCH NavGraph against a reference all-pairs Dijkstra over the very
 * same movable graph the old index used — so "matches the reference" means
 * "same answers as the pathfinding system we replaced". Also times build/query
 * and checks that a sparse updateWalkability after a map change equals a full
 * rebuild.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_cch.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/v.mjs && node <tmp>/v.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { dist } from "../src/engine/vec.ts";
import { NavGraph, MOVE_RADIUS, walkable } from "../src/world/nav.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall, type World } from "../src/world/world.ts";

// Reference: plain all-pairs Dijkstra over the movable adjacency (the old index).
function reference(world: World): { len: Float64Array; hop: Int32Array; n: number } {
  const nodes = world.nodes;
  const n = nodes.length;
  const len = new Float64Array(n * n).fill(Infinity);
  const hop = new Int32Array(n * n).fill(-1);
  for (let src = 0; src < n; src++) {
    const d = new Float64Array(n).fill(Infinity);
    const par = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    d[src] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && d[i] < best) ((best = d[i]), (u = i));
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of nodes[u].movable) if (d[u] + w < d[v]) ((d[v] = d[u] + w), (par[v] = u));
    }
    const base = src * n;
    len[base + src] = 0;
    hop[base + src] = src;
    for (let v = 0; v < n; v++) {
      if (v === src || par[v] < 0) continue;
      let first = v;
      while (par[first] !== src) first = par[first];
      len[base + v] = d[v];
      hop[base + v] = first;
    }
  }
  return { len, hop, n };
}

const EPS = 1e-6;

function compareAll(nav: NavGraph, ref: { len: Float64Array; hop: Int32Array; n: number }, label: string): boolean {
  const { len, hop, n } = ref;
  const nodes = nav.nodes;
  let distMismatch = 0,
    reachMismatch = 0,
    hopExact = 0,
    hopDiffValid = 0,
    hopInvalid = 0,
    pairs = 0;
  let worstDist = 0;
  for (let from = 0; from < n; from++) {
    for (let to = 0; to < n; to++) {
      pairs++;
      const r = nav.route(from, to);
      const rl = len[from * n + to];
      const refReach = rl !== Infinity;
      const cchReach = r !== null;
      if (refReach !== cchReach) {
        reachMismatch++;
        continue;
      }
      if (!refReach) continue;
      worstDist = Math.max(worstDist, Math.abs(r!.dist - rl));
      if (Math.abs(r!.dist - rl) > EPS) distMismatch++;
      if (from === to) continue;
      // first-hop check: exact, or a different but equally-short valid step
      const next = r!.next;
      if (next === hop[from * n + to]) {
        hopExact++;
      } else {
        const edge = nodes[from].movable.get(next);
        const rest = next === to ? 0 : len[next * n + to];
        if (edge !== undefined && Math.abs(edge + rest - rl) <= 1e-4) hopDiffValid++;
        else hopInvalid++;
      }
    }
  }
  console.log(`[${label}] pairs=${pairs}`);
  console.log(`  reachability mismatches: ${reachMismatch}`);
  console.log(`  distance mismatches (>${EPS}): ${distMismatch}   worst abs diff=${worstDist.toExponential(2)}`);
  console.log(`  first-hop: exact=${hopExact}  different-but-optimal=${hopDiffValid}  INVALID=${hopInvalid}`);
  return reachMismatch === 0 && distMismatch === 0 && hopInvalid === 0;
}

const LEVEL = process.argv[2] ?? "dom-arena-big";
const text = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
const loaded = loadLevel(text);
const world = loaded.world;
world.grid = new ObstacleGrid(world.obstacles);

// ---- build + correctness ----
const t0 = performance.now();
const nav = new NavGraph(world);
const buildMs = performance.now() - t0;
const ref = reference(world);
const n = ref.n;
console.log(`level=${LEVEL} nodes=${n}   build=${buildMs.toFixed(2)} ms`);
const ok1 = compareAll(nav, ref, "baseline");

// ---- query timing over random reachable-ish pairs ----
const pairs: [number, number][] = [];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let i = 0; i < 200000; i++) pairs.push([Math.floor(rnd() * n), Math.floor(rnd() * n)]);
let sink = 0;
const q0 = performance.now();
for (const [a, b] of pairs) {
  const r = nav.route(a, b);
  if (r) sink += r.next;
}
const qMs = performance.now() - q0;
console.log(`query: ${((qMs / pairs.length) * 1000).toFixed(3)} us/route  (${pairs.length} routes, sink=${sink})`);

// ---- sparse update: drop a wall into the arena, update only changed edges,
//      and check it equals a full rebuild on the mutated world ----
console.log(`\n--- sparse update test ---`);
// snapshot pre-change walkability of every within-radius pair
const within: [number, number][] = [];
for (let i = 0; i < n; i++)
  for (let j = i + 1; j < n; j++)
    if (dist(world.nodes[i].pos, world.nodes[j].pos) <= MOVE_RADIUS) within.push([i, j]);
const wasWalkable = new Map<string, boolean>();
for (const [i, j] of within) {
  const a = world.nodes[i],
    b = world.nodes[j];
  wasWalkable.set(`${i},${j}`, walkable(world, a.pos, a.z, b.pos, b.z) && walkable(world, b.pos, b.z, a.pos, a.z));
}
// mutate the world: straddle the midpoints of several real z=0 walkable links
// with fresh walls, so a batch of edges actually flips to blocked.
let placed = 0;
for (const [i, j] of within) {
  if (placed >= 6) break;
  const a = world.nodes[i],
    b = world.nodes[j];
  if (a.z !== 0 || b.z !== 0 || !wasWalkable.get(`${i},${j}`)) continue;
  const mx = (a.pos.x + b.pos.x) / 2;
  const my = (a.pos.y + b.pos.y) / 2;
  world.obstacles.push(makeWall({ x: mx, y: my }, 120, 120, 0));
  placed++;
}
world.grid = new ObstacleGrid(world.obstacles);
// which within-radius pairs changed walkability?
const changed: [number, number][] = [];
for (const [i, j] of within) {
  const a = world.nodes[i],
    b = world.nodes[j];
  const now = walkable(world, a.pos, a.z, b.pos, b.z) && walkable(world, b.pos, b.z, a.pos, a.z);
  if (now !== wasWalkable.get(`${i},${j}`)) changed.push([i, j]);
}
console.log(`edges toggled by the new wall: ${changed.length} / ${within.length} candidate edges`);
const u0 = performance.now();
nav.updateWalkability(world, changed);
const updMs = performance.now() - u0;
console.log(`sparse updateWalkability: ${updMs.toFixed(3)} ms`);

// full rebuild on the mutated world for reference
const navFull = new NavGraph(world);
const refFull = reference(world);
const okInc = compareAll(nav, refFull, "after sparse update vs fresh reference");
const okFull = compareAll(navFull, refFull, "full rebuild vs fresh reference (control)");

console.log(`\nRESULT: baseline ${ok1 ? "OK" : "FAIL"}, sparse-update ${okInc ? "OK" : "FAIL"}, rebuild ${okFull ? "OK" : "FAIL"}`);
process.exit(ok1 && okInc && okFull ? 0 : 1);
