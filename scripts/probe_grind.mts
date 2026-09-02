/**
 * probe_grind.mts — anatomy of a grinding clump. Why doesn't the squishy
 * separation let bots push past each other?
 *
 * Finds a bot in sustained teammate contact with no net progress and dumps a
 * per-tick trace: which movement branch drove it, the step magnitude, what it
 * is walking TO and how far that is, how many bodies it touches, and the same
 * for its nearest contact. Distinguishes the hypotheses:
 *  - pass-through works, but the pile is pinned by walls at a chokepoint
 *  - destination conflict: bots want the SAME spot, squish evicts, they re-enter
 *  - tiny steps: the dest is basically underfoot so min(speed, d) crawls
 *  - act/coast disagreement: plan ticks step somewhere else than coast ticks
 *
 * Run: node_modules/.bin/esbuild scripts/probe_grind.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pg.mjs && node <tmp>/pg.mjs [level] [seed] [ticks]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { Oracle } from "../src/ai/oracle.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { areHostile } from "../src/entities/team.ts";

const LEVEL = process.argv[2] ?? "dust2-a-tdm-2";
const SEED = Number(process.argv[3] ?? 1);
const TICKS = Number(process.argv[4] ?? 8000);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
const DIAM = 2 * BODY_RADIUS;

let seed = SEED >>> 0;
Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);

// Label each bot's step with the branch that produced it (as prof_crowd does).
function label(proto: any, name: string, branch: string): void {
  const orig = proto[name];
  if (typeof orig !== "function") return;
  proto[name] = function (this: any, ...args: any[]) {
    const bx = this.pos.x, by = this.pos.y;
    const r = orig.apply(this, args);
    if (this.pos.x !== bx || this.pos.y !== by) this.__branch = branch;
    return r;
  };
}
label(TacOracle.prototype as any, "strafeMove", "strafe");
label(TacOracle.prototype as any, "coverMove", "cover");
label(TacOracle.prototype as any, "healMove", "heal");
label(TacOracle.prototype as any, "holdMove", "hold");
label(TacOracle.prototype as any, "sidestep", "SIDESTEP");
label(Oracle.prototype as any, "navChase", "navChase");
label(Oracle.prototype as any, "coastStep", "coast");
label(TacOracle.prototype as any, "stepToward", "stepToward");

const level = loadLevel(TEXT);
const dom = /dom/.test(LEVEL);
const game = new Game(
  level,
  dom
    ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
    : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }),
);

const fmt = (n: number): string => n.toFixed(0);
/** What is this bot walking to right now, and how far is it? */
function destOf(a: any): string {
  const nav = (game as any).nav;
  if (a.strafeTarget) {
    return `strafeT ${fmt(Math.hypot(a.strafeTarget.x - a.pos.x, a.strafeTarget.y - a.pos.y))}px`;
  }
  if (a.holdPeek || a.holdCover) {
    const p = a.holdPeek ?? a.holdCover;
    return `holdSpot ${fmt(Math.hypot(p.x - a.pos.x, p.y - a.pos.y))}px`;
  }
  if (a.atGoalNode && a.lastTarget) {
    return `beeline ${fmt(Math.hypot(a.lastTarget.pos.x - a.pos.x, a.lastTarget.pos.y - a.pos.y))}px`;
  }
  if (nav && a.waypoint >= 0 && a.waypoint < nav.nodes.length) {
    const p = nav.nodes[a.waypoint].pos;
    return `wp#${a.waypoint} ${fmt(Math.hypot(p.x - a.pos.x, p.y - a.pos.y))}px`;
  }
  return "none";
}

function line(tag: string, a: any, touch: number): string {
  const tz = a.lastTarget ? (a.lastTarget.z === a.z ? "sameZ" : "offZ") : "noTgt";
  return (
    `${tag} (${fmt(a.pos.x)},${fmt(a.pos.y)})z${a.z} |v|=${Math.hypot(a.vel.x, a.vel.y).toFixed(2)} ` +
    `${(a.__branch ?? "still").padEnd(9)} ${a.mode.padEnd(5)} ${tz} -> ${destOf(a)} ` +
    `touch=${touch}${a.onStairs ? " STAIR" : ""}`
  );
}

let tracked: any = null;
let runStart: any = null;
let runPath = 0;
let runTicks = 0;
let tracing = 0;
let traces = 0;
const TRACE = 40;
const MAX_TRACES = 3;

for (let i = 0; i < TICKS && traces <= MAX_TRACES; i++) {
  for (const c of (game as any).characters) if (c instanceof TacOracle) (c as any).__branch = null;
  game.update();
  const chars = (game as any).characters.filter(
    (c: any) => c instanceof TacOracle && c.hp > 0 && !c.vehicle,
  );
  const touchOf = (a: any): any[] =>
    chars.filter((b: any) => {
      if (b === a || b.z !== a.z || areHostile(a.team, b.team)) return false;
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
      return dx * dx + dy * dy < DIAM * DIAM;
    });

  if (tracing > 0 && tracked) {
    if (tracked.hp <= 0) { tracing = 0; tracked = null; continue; }
    const mates = touchOf(tracked);
    console.log(`t=${i} ` + line("A", tracked, mates.length));
    for (const m of mates.slice(0, 2)) console.log("       " + line("M", m, touchOf(m).length));
    tracing--;
    if (tracing === 0) tracked = null;
    continue;
  }

  for (const a of chars) {
    const touching = touchOf(a);
    if (a === tracked) {
      if (touching.length === 0) { tracked = null; runPath = 0; runTicks = 0; continue; }
      runPath += Math.hypot(a.vel.x, a.vel.y);
      runTicks++;
      const net = Math.hypot(a.pos.x - runStart.x, a.pos.y - runStart.y);
      if (runTicks >= 25 && runPath > 3 * Math.max(net, 1)) {
        traces++;
        console.log(`\n== grind ${traces} at t=${i} (${runTicks}t, path ${fmt(runPath)}px, net ${fmt(net)}px) ==`);
        tracing = TRACE;
        runPath = 0; runTicks = 0;
      }
    } else if (!tracked && touching.length > 0) {
      tracked = a;
      runStart = { x: a.pos.x, y: a.pos.y };
      runPath = 0;
      runTicks = 0;
    }
  }
}
if (traces === 0) console.log("no grind episodes found");
