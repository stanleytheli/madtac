/**
 * probe_walkpick.mts — does costing target selection by WALKING distance rather
 * than straight line actually change who gets picked, and how far apart are the
 * two answers? Shadows every selectTarget scan with a straight-line rerun.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_walkpick.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pw.mjs && node <tmp>/pw.mjs [level] [ticks] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { dist } from "../src/engine/vec.ts";

const LEVEL = process.argv[2] ?? "house-3";
const TICKS = Number(process.argv[3] ?? 4000);
const SEED = Number(process.argv[4] ?? 1);
let sd = SEED >>> 0;
Math.random = () => ((sd = (sd * 1664525 + 1013904223) >>> 0), sd / 4294967296);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

let scans = 0, differed = 0, multi = 0;
const ratios: number[] = [];
const orig = (TacOracle.prototype as any).selectTarget;
(TacOracle.prototype as any).selectTarget = function (this: any, ai: any) {
  const picked = orig.call(this, ai);
  // A real scan resets targetEvalIn to TARGET_EVAL_TICKS (10); the fast path
  // leaves it at evalBefore-1, which is 0..9. So ===10 is exactly "scanned".
  if (this.targetEvalIn !== 10) return picked;
  const cands = this.hostiles(ai).filter((h: any) => h.z === this.z && this.canSee(ai.world, h));
  if (cands.length < 2) return picked;
  scans++; multi++;
  // Re-rank with the straight line in place of the walk, everything else equal.
  let best: any = null, bestCost = Infinity;
  for (const h of cands) {
    const d = dist(this.pos, h.pos);
    let c = this.shootCost(ai, h) + 0.75 * d;
    if (d > this.gun.feasibleRange) c += 1e5;
    c += this.targetShareCost(ai, h);
    if (h === this.focus) c -= 30;
    if (c < bestCost) { bestCost = c; best = h; }
  }
  if (best && picked && best !== picked) {
    differed++;
    const w = this.walkDist(ai, this, picked), sl = dist(this.pos, picked.pos);
    if (sl > 1) ratios.push(w / sl);
  }
  return picked;
};

const game = new Game(loadLevel(TEXT), /dom/.test(LEVEL)
  ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
  : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
for (let i = 0; i < TICKS; i++) game.update();

ratios.sort((a, b) => a - b);
const pct = (x: number, of: number): string => (of ? `${((100 * x) / of).toFixed(1)}%` : "—");
console.log(`${LEVEL} seed ${SEED}: ${multi} scans with 2+ visible candidates`);
console.log(`  pick differs from straight-line: ${differed}  (${pct(differed, multi)})`);
if (ratios.length) {
  console.log(`  walk/straight ratio of the chosen target when it differs: ` +
    `median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}x, max ${ratios[ratios.length - 1].toFixed(2)}x`);
}
