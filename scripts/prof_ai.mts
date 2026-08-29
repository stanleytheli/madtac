/**
 * prof_ai.mts — where does per-tick AI time actually go? Wraps the hot AI
 * methods with a self-time profiler (exclusive of patched children, so nesting
 * doesn't double-count) and runs headless TDM matches. Answers "is the
 * first-sight march (routeUntilSight) the culprit, or the node scans / routing?"
 *
 * Run:
 *   node_modules/.bin/esbuild scripts/prof_ai.mts --bundle --platform=node \
 *     --format=esm \
 *     --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};let _s=1;Math.random=()=>{_s=(_s*1664525+1013904223)>>>0;return _s/4294967296;};' \
 *     --outfile=/tmp/pa.mjs && node /tmp/pa.mjs [matches] [level]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { Oracle } from "../src/ai/oracle.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { NavGraph } from "../src/world/nav.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";

// --- self-time profiler -----------------------------------------------------
type Acc = { self: number; incl: number; n: number };
const acc: Record<string, Acc> = {};
const stack: number[] = []; // per-frame accumulator of patched-child inclusive time
const hr = () => Number(process.hrtime.bigint());

function timed(proto: any, name: string, label = name): void {
  const orig = proto[name];
  if (typeof orig !== "function") throw new Error(`no method ${name}`);
  acc[label] ??= { self: 0, incl: 0, n: 0 };
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const start = hr();
    stack.push(0);
    try {
      return orig.apply(this, args);
    } finally {
      const elapsed = hr() - start;
      const child = stack.pop()!;
      const a = acc[label];
      a.self += elapsed - child;
      a.incl += elapsed;
      a.n += 1;
      if (stack.length) stack[stack.length - 1] += elapsed;
    }
  };
}

timed(Robot.prototype, "think");
timed(Oracle.prototype, "plan");
timed(TacOracle.prototype, "contactScan");
timed(TacOracle.prototype, "routeUntilSight");
if ((TacOracle.prototype as any).reachTo) timed(TacOracle.prototype, "reachTo");
// REACH CACHE hit rate: how often a pair was already computed by whoever asked
// first (either side of the pair, or an earlier consumer this beat).
let reachCalls = 0, reachMiss = 0;
const dirs = new Map<string, number>();
const noRow = new Map<string, number>();
{
  const rt = (TacOracle.prototype as any).reachTo;
  const ru = (TacOracle.prototype as any).routeUntilSight;
  if (rt) {
    (TacOracle.prototype as any).reachTo = function (this: any, ...a: any[]) {
      reachCalls++;
      const before = ru;
      let missed = false;
      (this as any).routeUntilSight = function (this: any, ...b: any[]) { missed = true; return before.apply(this, b); };
      try { return rt.apply(this, a); } finally {
        delete (this as any).routeUntilSight;
        if (missed) reachMiss++;
      const self = a[1] === this;           // "my" direction vs "en" direction
      const k = (self ? "my" : "en") + (missed ? " MISS" : " hit");
      dirs.set(k, (dirs.get(k) ?? 0) + 1);
      if (!self && missed) {
        // Why did the reverse entry not exist? Either that character never runs
        // a scan (not a TacOracle), or it is in contact and skips scanning.
        const tgt: any = a[1];
        noRow.set(tgt instanceof TacOracle ? "is a TacOracle (in contact / off-beat?)" : "not a TacOracle (no rows ever)",
          (noRow.get(tgt instanceof TacOracle ? "is a TacOracle (in contact / off-beat?)" : "not a TacOracle (no rows ever)") ?? 0) + 1);
      }
      }
    };
  }
}
process.on("exit", () => {
  if (reachCalls) {
    console.log(`REACHCACHE\t${reachCalls}\t${reachMiss}\t${(100*(reachCalls-reachMiss)/reachCalls).toFixed(1)}`);
    for (const [k, v] of [...dirs.entries()].sort()) console.log(`  DIR ${k.padEnd(10)} ${v}`);
    for (const [k, v] of noRow.entries()) console.log(`  ENMISS ${k}  ${v}`);
  }
});
timed(NavGraph.prototype, "route");
timed(NavGraph.prototype, "routePath");
timed(NavGraph.prototype, "nearestWalkable");
timed(NavGraph.prototype, "nearestInSight");

// --- run matches ------------------------------------------------------------
const MATCHES = Number(process.argv[2] ?? 3);
const LEVEL = process.argv[3] ?? "tdm-arena-big";
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
const MAX_TICKS = 30_000;

// --- equivalence: routePath() must equal iterating route().next -------------
// Across plain AND each team's congested metric, so we prove the one-query path
// is identical to the per-hop walk (and preserves the adaptive-metric paths).
{
  (Robot as unknown as { nextPhase: number }).nextPhase = 0;
  const g = new Game(loadLevel(TEXT), new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
  for (let i = 0; i < 400; i++) g.update(); // let both teams stamp congestion routes
  const nav = g.nav!;
  const nn = nav.nodes.length;
  const rint = (n: number) => Math.floor(Math.random() * n);
  const walk = (from: number, to: number, team: string | null): number[] | null => {
    if (from === to) return [from];
    const seq = [from];
    let cur = from;
    for (let k = 0; k < nn + 2; k++) {
      const s = nav.route(cur, to, team as never);
      if (!s) return null;
      cur = s.next;
      seq.push(cur);
      if (cur === to) return seq;
    }
    return null;
  };
  let ok = 0, bad = 0, unreach = 0;
  for (const team of [null, "blue", "red"]) {
    for (let i = 0; i < 2000; i++) {
      const a = rint(nn), b = rint(nn);
      const w = walk(a, b, team);
      const rpFull = nav.routePath(a, b, team as never);
      const rp = rpFull ? rpFull.nodes : null;
      // also require the returned dist to equal route().dist exactly (the ceiling relies on it)
      const refDist = a === b ? 0 : (nav.route(a, b, team as never)?.dist ?? null);
      const distOk = rpFull === null ? refDist === null : rpFull.dist === refDist;
      const eq = distOk && ((w === null && rp === null) || (!!w && !!rp && w.length === rp.length && w.every((x, j) => x === rp[j])));
      if (w === null && rp === null) unreach++;
      if (eq) ok++;
      else {
        bad++;
        if (bad <= 5) console.error(`  MISMATCH team=${team} ${a}->${b}\n    walk=${w}\n    path=${rp}`);
      }
    }
  }
  console.log(`equivalence: ${ok} ok, ${bad} mismatches, ${unreach} unreachable (plain+blue+red, 6000 pairs)`);
  if (bad > 0) {
    console.error("routePath is NOT equivalent to iterated route() — aborting.");
    process.exit(1);
  }
  for (const k of Object.keys(acc)) acc[k] = { self: 0, incl: 0, n: 0 }; // reset before profiling
  stack.length = 0;
}

let totalTicks = 0;
let botTicks = 0; // sum over ticks of (live Robots that turn)
let wall = 0;

for (let m = 0; m < MATCHES; m++) {
  (Robot as unknown as { nextPhase: number }).nextPhase = 0;
  const mode = new TeamDeathmatchMode({ killLimit: 20, blue: { troops: 5 }, red: { troops: 5 } });
  const game = new Game(loadLevel(TEXT), mode);
  const over = () => game.gamemode.hud(game)?.over ?? false;
  const w0 = hr();
  let t = 0;
  for (; t < MAX_TICKS && !over(); t++) {
    game.update();
    for (const c of game.characters) if (c instanceof Robot && c.hp > 0) botTicks++;
  }
  wall += hr() - w0;
  totalTicks += t;
  process.stderr.write(`  match ${m + 1}/${MATCHES}: ${t} ticks\n`);
}

// --- report -----------------------------------------------------------------
const ms = (ns: number) => ns / 1e6;
const perBotTickUs = (ns: number) => ns / botTicks / 1e3;
const thinkSelfPlusChildren = acc.think.incl;

console.log(`\n================ AI COST PROFILE (${LEVEL}) ================`);
console.log(`matches=${MATCHES}  ticks=${totalTicks}  bot-ticks=${botTicks}  wall=${ms(wall).toFixed(0)}ms`);
console.log(`think() total = ${ms(thinkSelfPlusChildren).toFixed(0)}ms  =  ${perBotTickUs(thinkSelfPlusChildren).toFixed(2)} µs / bot-tick`);
console.log(`(think is ${((100 * thinkSelfPlusChildren) / wall).toFixed(0)}% of match wall-time)\n`);

const rows = Object.entries(acc)
  .map(([k, a]) => ({ k, ...a }))
  .sort((x, y) => y.self - x.self);

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
console.log(`${pad("function", 18)}${padL("self ms", 10)}${padL("self %", 8)}${padL("incl ms", 10)}${padL("calls", 10)}${padL("µs/call", 10)}${padL("µs/botTk", 10)}`);
console.log("-".repeat(76));
const selfTotal = rows.reduce((s, r) => s + r.self, 0);
for (const r of rows) {
  console.log(
    pad(r.k, 18) +
      padL(ms(r.self).toFixed(0), 10) +
      padL(((100 * r.self) / selfTotal).toFixed(1) + "%", 8) +
      padL(ms(r.incl).toFixed(0), 10) +
      padL(String(r.n), 10) +
      padL((r.self / Math.max(1, r.n) / 1e3).toFixed(2), 10) +
      padL(perBotTickUs(r.self).toFixed(2), 10),
  );
}
console.log("-".repeat(76));
console.log("self% = share of measured (patched) time, exclusive of patched children.");
console.log("Unpatched work (raycasts inside a march/scan) shows as that function's self time.");
console.log("===========================================================");
