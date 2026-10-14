/** Nav sanity for harbor.json: every node linked, one component, and routes
 *  between the spawns, the three points, the cages, the deck ends and the side
 *  pockets. A -1 node id means the probe spot itself is inside an obstacle.
 *
 *    npx tsx scripts/verify_harbor.mts
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { NavGraph } from "../src/world/nav.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { vec } from "../src/engine/vec.ts";
const st = loadLevel(readFileSync("src/world/levels/harbor.json", "utf8"));
const w = st.world;
w.grid = new ObstacleGrid(w.obstacles);
const g = new NavGraph(w);
const nodes = w.nodes;
// isolated nodes
const iso = nodes.filter((n) => n.movable.size === 0);
console.log(`nodes=${nodes.length} isolated=${iso.length}`, iso.map((n) => `(${n.pos.x},${n.pos.y},z${n.z})`).join(" "));
// component sizes via BFS over movable
const seen = new Set<number>(); const comps: number[][] = [];
for (const n of nodes) { if (seen.has(n.id)) continue; const q = [n.id]; seen.add(n.id); const c: number[] = [];
  while (q.length) { const i = q.pop()!; c.push(i); for (const j of nodes[i].movable.keys()) if (!seen.has(j)) { seen.add(j); q.push(j); } }
  comps.push(c); }
comps.sort((a, b) => b.length - a.length);
console.log("components:", comps.map((c) => c.length).join(","));
for (const c of comps.slice(1)) console.log("  small comp:", c.map((i) => `(${nodes[i].pos.x},${nodes[i].pos.y},z${nodes[i].z})`).join(" "));
const spots: [string, number, number, number][] = [["blueSpawn", -1570, -300, 0], ["redSpawn", 1570, -300, 0], ["A", 0, -960, 0], ["B", 0, 920, 1], ["C", 0, 0, 0], ["alley", 0, -1273, 0], ["cageW", -640, -1120, 0], ["cageE", 640, -1120, 0], ["deckW", -1000, 800, 1], ["deckE", 1000, 800, 1], ["pocketE", 1550, 0, 0], ["pocketW", -1550, 0, 0], ["southE", 1150, 480, 0], ["southW", -1150, 480, 0]];
const ids = spots.map(([n, x, y, z]) => [n, g.nearestWalkable(w, vec(x, y), z)] as const);
for (const [n, id] of ids) if (id < 0) console.log("NO WALKABLE NODE for", n);
let bad = 0;
for (const [a, ia] of ids) for (const [b, ib] of ids) { if (a >= b || ia < 0 || ib < 0) continue; const r = g.route(ia, ib); if (!r) { bad++; console.log("UNREACHABLE", a, "->", b); } }
console.log(bad === 0 ? "ALL KEY ROUTES OK" : `${bad} bad routes`);
const id = (n: string) => ids.find(([k]) => k === n)![1];
for (const [a, b] of [["C", "A"], ["C", "B"], ["blueSpawn", "A"], ["blueSpawn", "B"], ["blueSpawn", "C"], ["A", "B"]]) console.log(`route ${a}->${b}: ${g.route(id(a), id(b))?.dist.toFixed(0)}`);
