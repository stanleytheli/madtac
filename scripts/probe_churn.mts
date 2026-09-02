/**
 * probe_churn.mts — trace the geometry of a churning teammate contact.
 *
 * Finds bots in sustained teammate contact whose path is much longer than
 * their net progress, and dumps a per-tick trace of the pair: distance, the
 * bearing of the contact line (is the pair ROTATING or FLIP-FLOPPING?), each
 * bot's intent direction, and whether the slip branch fired.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_churn.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pch.mjs && node <tmp>/pch.mjs [level] [seed] [ticks]
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

const level = loadLevel(TEXT);
const dom = /dom/.test(LEVEL);
const game = new Game(
  level,
  dom
    ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
    : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }),
);

const deg = (r: number): number => Math.round((r * 180) / Math.PI);
const dirOf = (v: { x: number; y: number }): string =>
  Math.hypot(v.x, v.y) < 0.05 ? "  --" : String(deg(Math.atan2(v.y, v.x))).padStart(4);

// Track one bot's contact run; when it qualifies as churn, trace TRACE ticks.
let tracked: any = null;
let mate: any = null;
let runStart: { x: number; y: number } | null = null;
let runPath = 0;
let runTicks = 0;
let tracing = 0;
let traces = 0;
const TRACE = 50;
const MAX_TRACES = 3;

for (let i = 0; i < TICKS && traces <= MAX_TRACES; i++) {
  game.update();
  const chars = (game as any).characters.filter(
    (c: any) => c instanceof TacOracle && c.hp > 0 && !c.vehicle,
  );

  if (tracing > 0 && tracked && mate) {
    if (tracked.hp <= 0 || mate.hp <= 0) { tracing = 0; tracked = null; continue; }
    const dx = mate.pos.x - tracked.pos.x;
    const dy = mate.pos.y - tracked.pos.y;
    const d = Math.hypot(dx, dy);
    const bearing = deg(Math.atan2(dy, dx));
    console.log(
      `  t=${String(i).padStart(5)} d=${d.toFixed(0).padStart(3)} pairAngle=${String(bearing).padStart(4)} ` +
        `A:vel=${dirOf(tracked.vel)} mode=${tracked.mode} ` +
        `B:vel=${dirOf(mate.vel)} mode=${mate.mode} ` +
        `Apos=(${tracked.pos.x.toFixed(0)},${tracked.pos.y.toFixed(0)})`,
    );
    tracing--;
    if (tracing === 0) { tracked = null; mate = null; }
    continue;
  }

  // Look for a bot in continuous contact making no progress.
  for (const a of chars) {
    let touching: any = null;
    for (const b of chars) {
      if (b === a || b.z !== a.z || areHostile(a.team, b.team)) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      if (dx * dx + dy * dy < DIAM * DIAM) { touching = b; break; }
    }
    if (a === tracked) {
      if (!touching) { tracked = null; runPath = 0; runTicks = 0; continue; }
      runPath += Math.hypot(a.vel.x, a.vel.y);
      runTicks++;
      const net = Math.hypot(a.pos.x - runStart!.x, a.pos.y - runStart!.y);
      if (runTicks >= 20 && runPath > 3 * Math.max(net, 1)) {
        traces++;
        console.log(`\n== churn episode ${traces} at t=${i} (run ${runTicks}t, path ${runPath.toFixed(0)}px, net ${net.toFixed(0)}px) ==`);
        mate = touching;
        tracing = TRACE;
        runPath = 0; runTicks = 0;
      }
    } else if (!tracked && touching) {
      tracked = a;
      runStart = { x: a.pos.x, y: a.pos.y };
      runPath = 0;
      runTicks = 0;
    }
  }
}
if (traces === 0) console.log("no churn episodes found");
