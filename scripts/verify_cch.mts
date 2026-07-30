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

// ---- congestion metric (setRoute) -------------------------------------------
// The congested metric is a SECOND customization of the same topology. It must:
//   (a) leave the plain metric untouched — other callers use route() distances as
//       measurements, not as a choice of walk;
//   (b) return to exactly the plain weights once every route is withdrawn, or a
//       stamp leak would silently bend pathfinding for the rest of the match;
//   (c) never change reachability — a surcharge is finite, so nothing it does can
//       disconnect the graph.
console.log("\n--- congestion metric ---");
const cnav = new NavGraph(loaded.world);
const g = cnav as unknown as {
  plain: { w: Float64Array };
  cong: { w: Float64Array };
  congestion: Float64Array;
};
const M = g.plain.w.length;
const plainBefore = Float64Array.from(g.plain.w);
const congBefore = Float64Array.from(g.cong.w);
let okCong = true;
const say = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) okCong = false;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `   ${detail}` : ""}`);
};
say("both metrics start identical",
  congBefore.every((w, i) => w === plainBefore[i]));

// Stamp several routes, as a squad of bots would.
const owners = [{}, {}, {}, {}, {}, {}];
let seedC = 7;
const rndC = (): number => (seedC = (seedC * 1664525 + 1013904223) >>> 0) / 4294967296;
const routes = owners.map(() => {
  const nodes: number[] = [];
  let cur = Math.floor(rndC() * cnav.nodes.length);
  const goal = Math.floor(rndC() * cnav.nodes.length);
  for (let h = 0; h < 12 && cur !== goal; h++) {
    const step = cnav.route(cur, goal, true);
    if (!step || step.next === cur) break;
    nodes.push(cur);
    cur = step.next;
  }
  return nodes;
});
const st = performance.now();
owners.forEach((o, i) => cnav.setRoute(o, routes[i]));
console.log(`      setRoute x${owners.length}: ${(performance.now() - st).toFixed(3)} ms total`);

say("the plain metric is untouched by stamping",
  g.plain.w.every((w, i) => w === plainBefore[i]));
let bent = 0;
for (let a = 0; a < M; a++) if (g.cong.w[a] !== congBefore[a]) bent++;
say("stamping actually moved the congested metric", bent > 0, `arcs changed=${bent}`);

// Reachability is unchanged, and every congested first hop is a real walkable edge.
let unreachable = 0;
let badHop = 0;
for (let t = 0; t < 4000; t++) {
  const a = Math.floor(rndC() * cnav.nodes.length);
  const b = Math.floor(rndC() * cnav.nodes.length);
  if (a === b) continue;
  const p = cnav.route(a, b);
  const c = cnav.route(a, b, true);
  if (!!p !== !!c) unreachable++;
  if (c && c.next !== a && !cnav.nodes[a].movable.has(c.next)) badHop++;
}
say("congestion never changes reachability", unreachable === 0, `mismatches=${unreachable}`);
say("every congested first hop is a real walkable edge", badHop === 0, `bad=${badHop}`);

// Withdraw one at a time; the field must land back exactly where it started.
owners.forEach((o) => cnav.setRoute(o, []));
say("withdrawing every route zeroes the congestion field",
  g.congestion.every((c) => c === 0));
let residue = 0;
for (let a = 0; a < M; a++) if (g.cong.w[a] !== congBefore[a]) residue++;
say("...and restores the congested metric exactly", residue === 0, `arcs still bent=${residue}`);

console.log(`\nRESULT: baseline ${ok1 ? "OK" : "FAIL"}, sparse-update ${okInc ? "OK" : "FAIL"}, rebuild ${okFull ? "OK" : "FAIL"}, congestion ${okCong ? "OK" : "FAIL"}`);
process.exit(ok1 && okInc && okFull && okCong ? 0 : 1);
