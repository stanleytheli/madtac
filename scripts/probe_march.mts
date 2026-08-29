/**
 * probe_march.mts — would node-granular sight scanning (test each node on the
 * route, then refine only the final leg, as findEntry/firstVisibleAlong do)
 * give a different answer from routeUntilSight's continuous 40px march?
 *
 * Shadows every real call with two reimplementations: `cont` mirrors the shipped
 * march exactly, `node` is the proposed variant. `cont` vs the real return value
 * is the control — if that ever disagrees, the shadow is wrong and the node
 * numbers mean nothing.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_march.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pm.mjs && node <tmp>/pm.mjs [level] [ticks] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { targetPoints } from "../src/ai/robot.ts";
import { losClear, shotClear } from "../src/world/world.ts";
import { add, dist, norm, scale, sub, type Vec2 } from "../src/engine/vec.ts";

const LEVEL = process.argv[2] ?? "house-3";
const TICKS = Number(process.argv[3] ?? 4000);
const SEED = Number(process.argv[4] ?? 1);
let sd = SEED >>> 0;
Math.random = () => ((sd = (sd * 1664525 + 1013904223) >>> 0), sd / 4294967296);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

const SIGHT_MARCH_STEP = 40;   // mirrors tacoracle
const SIGHT_MARCH_HOPS = 24;

let routed = 0, shortCircuit = 0, controlMismatch = 0, differ = 0;
const hopHist = new Map<number, number>();
const diffs: number[] = [];
const bump = (m: Map<number, number>, k: number): void => m.set(k, (m.get(k) ?? 0) + 1);

const orig = (TacOracle.prototype as any).routeUntilSight;
(TacOracle.prototype as any).routeUntilSight = function (
  this: any, ai: any, fromPos: Vec2, fromZ: number, tgt: any,
  range: number, budget: number, fromNode?: number, tgtGoal?: number,
) {
  const real = orig.call(this, ai, fromPos, fromZ, tgt, range, budget, fromNode, tgtGoal);

  const seesFrom = (p: Vec2, z: number): boolean =>
    z === tgt.z && targetPoints(tgt, p).some((pt: Vec2) =>
      budget > 0 ? shotClear(ai.world, p, pt, z, budget) : losClear(ai.world, p, pt, z));
  const gapAt = (p: Vec2): number => Math.max(0, dist(p, tgt.pos) - range);

  if (seesFrom(fromPos, fromZ)) { shortCircuit++; return real; }
  const nav = ai.nav;
  if (!nav || nav.nodes.length === 0) return real;
  const curr = fromNode ?? nav.nearestWalkable(ai.world, fromPos, fromZ);
  const goal = tgtGoal ?? nav.nearestInSight(ai.world, tgt.pos, tgt.z);
  if (curr < 0 || goal < 0) return real;
  const rp = curr === goal ? { nodes: [curr], dist: 0 } : nav.routePath(curr, goal);
  if (rp === null) return real;
  const path: number[] = rp.nodes;
  const ceiling = dist(fromPos, nav.nodes[curr].pos) + rp.dist + gapAt(nav.nodes[goal].pos);
  routed++;

  // --- control: the shipped continuous march, and which hop it answered on ---
  let cont = ceiling, contHop = -1;
  {
    let travelled = 0, from = fromPos, lvl = fromZ;
    outer: for (let hop = 0; hop < path.length && hop < SIGHT_MARCH_HOPS && travelled < ceiling; hop++) {
      const nd = nav.nodes[path[hop]];
      const segLen = dist(from, nd.pos);
      if (lvl === tgt.z && segLen > 1e-3) {
        const dir = norm(sub(nd.pos, from));
        for (let d = SIGHT_MARCH_STEP; d <= segLen; d += SIGHT_MARCH_STEP) {
          const p = add(from, scale(dir, d));
          if (seesFrom(p, lvl)) { cont = Math.min(ceiling, travelled + d + gapAt(p)); contHop = hop; break outer; }
        }
      }
      travelled += segLen; from = nd.pos; lvl = nd.z;
    }
  }
  if (Math.abs(cont - real) > 1) controlMismatch++;
  bump(hopHist, contHop);

  // --- proposal: test NODES only, then refine the one leg that opened --------
  let nodeAns = ceiling;
  {
    let travelled = 0, from = fromPos, lvl = fromZ;
    for (let hop = 0; hop < path.length && hop < SIGHT_MARCH_HOPS && travelled < ceiling; hop++) {
      const nd = nav.nodes[path[hop]];
      const segLen = dist(from, nd.pos);
      if (seesFrom(nd.pos, nd.z)) {
        // refine backwards over just this leg, exactly as firstVisibleAlong does
        let found = travelled + segLen + gapAt(nd.pos);
        if (lvl === tgt.z && segLen > 1e-3) {
          const dir = norm(sub(nd.pos, from));
          for (let d = SIGHT_MARCH_STEP; d <= segLen; d += SIGHT_MARCH_STEP) {
            const p = add(from, scale(dir, d));
            if (seesFrom(p, lvl)) { found = travelled + d + gapAt(p); break; }
          }
        }
        nodeAns = Math.min(ceiling, found);
        break;
      }
      travelled += segLen; from = nd.pos; lvl = nd.z;
    }
  }
  if (Math.abs(nodeAns - cont) > 1) { differ++; diffs.push(nodeAns - cont); }
  return real;
};

const game = new Game(loadLevel(TEXT), /dom/.test(LEVEL)
  ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
  : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
for (let i = 0; i < TICKS; i++) game.update();

const pct = (x: number, of: number): string => (of ? `${((100 * x) / of).toFixed(1)}%` : "—");
diffs.sort((a, b) => a - b);
const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
console.log(`${LEVEL} seed ${SEED}: ${shortCircuit + routed} calls — ${shortCircuit} short-circuit (${pct(shortCircuit, shortCircuit + routed)}), ${routed} routed`);
console.log(`  control mismatches (shadow vs real): ${controlMismatch}  ${controlMismatch ? "<-- SHADOW IS WRONG" : "(shadow verified)"}`);
console.log(`  node-granular differs: ${differ} / ${routed}  (${pct(differ, routed)})`);
if (diffs.length) console.log(`    when it differs: median ${med.toFixed(0)}px, worst +${diffs[diffs.length - 1].toFixed(0)}px, best ${diffs[0].toFixed(0)}px`);
const hops = [...hopHist.entries()].sort((a, b) => a[0] - b[0]);
console.log(`  hop the continuous march answered on: ` +
  hops.map(([h, n]) => `${h < 0 ? "none" : "h" + h}:${pct(n, routed)}`).join("  "));
