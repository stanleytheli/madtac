/**
 * prof_crowd.mts — which movement branch actually drives bots into each other?
 *
 * Every TacOracle movement path is wrapped so each bot's step this tick is
 * labelled with the branch that produced it (strafe / cover / heal / hold /
 * sidestep / approach / coast). After each update we look at every overlapping
 * pair of teammates and ask, of each one, "did YOUR step this tick point at
 * them?". That is a shove: a bot walking into a body. The tally by branch says
 * where a fix has to go.
 *
 * Also reports the crowd gate's own hit rate, so a branch that is supposed to be
 * handled but isn't shows up as "shoves from strafe with the gate cold".
 *
 * Run: node_modules/.bin/esbuild scripts/prof_crowd.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pc.mjs && node <tmp>/pc.mjs [matches] [ticks] [level] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { areHostile } from "../src/entities/team.ts";
import { Oracle } from "../src/ai/oracle.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";

const MATCHES = Number(process.argv[2] ?? 4);
const TICKS = Number(process.argv[3] ?? 4000);
const LEVEL = process.argv[4] ?? "tdm-arena-big";
const SEED = Number(process.argv[5] ?? 1);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
const DIAM = 2 * BODY_RADIUS;

let seed = SEED >>> 0;
Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);

type Branch =
  | "strafe" | "cover" | "heal" | "hold" | "sidestep"
  | "approach" | "coast-approach" | "coast-strafeTarget" | "rearm" | "none";
const BRANCHES: Branch[] = [
  "strafe", "cover", "heal", "hold", "sidestep",
  "approach", "coast-approach", "coast-strafeTarget", "rearm", "none",
];

// ---------------------------------------------------------------- patching ---
/** Label every step with the branch that produced it. Wrappers set the label
 *  around the call; the innermost one to actually move the bot wins, because
 *  the outer wrapper only overwrites when its own callee moved nothing. */
function label(proto: any, name: string, branch: Branch): void {
  const orig = proto[name];
  if (typeof orig !== "function") throw new Error(`no ${name} to patch`);
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
label(TacOracle.prototype as any, "sidestep", "sidestep");
label(Oracle.prototype as any, "navChase", "approach");
label(Oracle.prototype as any, "coastStep", "coast-approach");
label(TacOracle.prototype as any, "rearm", "rearm");
// Fallback: a bare stepToward not inside any labelled parent is TacOracle.coast
// walking the committed strafe/cover spot between plan ticks. Labelled parents
// overwrite it on the way out, so it only survives when nothing else claimed it.
label(TacOracle.prototype as any, "stepToward", "coast-strafeTarget");

{
  // Flags set by the early-outs act() runs BEFORE the mode dispatch, so the
  // dispatch can be classified without re-running anything (bestChase mutates).
  for (const [name, flag] of [["rearm", "__rearmed"], ["standToShoot", "__stand"]] as const) {
    const o = (TacOracle.prototype as any)[name];
    (TacOracle.prototype as any)[name] = function (this: any, ...a: any[]) {
      const r = o.apply(this, a);
      (this as any)[flag] = r;
      return r;
    };
  }
  const orig = (TacOracle.prototype as any).act;
  (TacOracle.prototype as any).act = function (this: any, ai: any, target: any) {
    this.__rearmed = false;
    this.__stand = false;
    const r = orig.call(this, ai, target);
    bumpD("act calls");
    if (this.__rearmed) { bumpD("  rearm (returned early)"); return r; }
    if (this.__stand) { bumpD("  planted by standToShoot (returned early)"); return r; }
    if (this.mode === "heal") bumpD("  heal");
    else if (this.mode === "hold") bumpD("  hold");
    else if (this.mode === "cover") bumpD("  cover");
    else if (target && Math.hypot(target.pos.x - this.pos.x, target.pos.y - this.pos.y) <= this.engageRange)
      bumpD("  STRAFE");
    else {
      bumpD("  approach");
      if (!target) bumpD("    ...target null: no enemy visible");
      else bumpD("    ...visible enemy beyond engageRange");
    }
    return r;
  };
}

// Stall watch: how often does unshove remove (nearly) the whole step, and for
// how many ticks in a row? A long streak is a bot standing still because a
// teammate is in the way — the failure mode a pure projection can have.
let unshoveCalls = 0, unshoveCut = 0, unshoveKilled = 0;
const stallRuns: number[] = [];
{
  const o = (Oracle.prototype as any).unshove;
  if (o) {
    (Oracle.prototype as any).unshove = function (this: any, ai: any, move: any) {
      const r = o.call(this, ai, move);
      const li = Math.hypot(move.x, move.y);
      const lo = Math.hypot(r.x, r.y);
      unshoveCalls++;
      if (li > 1e-6) {
        if (lo < li - 1e-6) unshoveCut++;
        if (lo < 0.1 * li) {
          unshoveKilled++;
          this.__stall = (this.__stall ?? 0) + 1;
        } else if (this.__stall) { stallRuns.push(this.__stall); this.__stall = 0; }
      }
      return r;
    };
  }
}

// ----------------------------------------------------------------- tallies ---
const shoves: Record<Branch, number> = Object.fromEntries(BRANCHES.map((b) => [b, 0])) as any;
let botTicks = 0, overlapTicks = 0, multiOverlapTicks = 0, shoveTicks = 0;
// How LONG does one contact last? A shove that survives a plan tick (stagger,
// 5 ticks) is one the planner looked at and did not fix — a different failure
// from a 1-2 tick brush between plans.
const runs: number[] = [];
/** Branch composition of the ticks inside runs longer than one plan cycle. */
const longRunBranch: Record<Branch, number> = Object.fromEntries(BRANCHES.map((b) => [b, 0])) as any;
let longRunTicks = 0;
/** Per-bot funnel: why the crowd gate is or isn't reached. */
/** Where act() actually dispatches, and why the strafe branch is or isn't taken. */
const disp = new Map<string, number>();
const bumpD = (k: string): void => { disp.set(k, (disp.get(k) ?? 0) + 1); };
/** Is a long contact a bot going somewhere, or a bot churning in place? Path
 *  length vs net displacement over the run says it outright: a bot shoved off a
 *  destination and walking back racks up steps and goes nowhere. */
const destKind = new Map<string, number>();
let runPath = 0, runNet = 0, churnRuns = 0, travelRuns = 0;
const standoffHist = new Map<string, number>();
/** The bot's own `mode` field on each contact tick, and crossed with the branch
 *  that moved it — "shoot mode" covers strafeMove AND the approach/coast paths,
 *  so the branch alone does not say what posture the bot thought it was in. */
const modeTicks = new Map<string, number>();
const modeShoves = new Map<string, number>();
const modeLong = new Map<string, number>();
const cross = new Map<string, number>();
const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };

function runMatch(): void {
  const level = loadLevel(TEXT);
  const dom = /dom/.test(LEVEL);
  const game = new Game(
    level,
    dom
      ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
      : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }),
  );
  for (let i = 0; i < TICKS; i++) {
    const bots = (game as any).characters.filter(
      (c: any) => c instanceof TacOracle && c.hp > 0 && !c.vehicle,
    );
    for (const b of bots) { b.__branch = "none"; }
    game.update();

    for (const a of bots) {
      if (a.hp <= 0) continue;
      botTicks++;
      let touching = 0, shoved = false;
      for (const b of bots) {
        if (b === a || b.hp <= 0 || b.z !== a.z) continue;
        if (areHostile(a.team, b.team)) continue;
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        if (dx * dx + dy * dy >= DIAM * DIAM) continue;
        touching++;
        // Did OUR step this tick point at them? That is the shove.
        if (a.vel.x * dx + a.vel.y * dy > 0) shoved = true;
      }
      if (touching > 0) overlapTicks++;
      if (touching > 1) multiOverlapTicks++;
      const br = (a.__branch ?? "none") as Branch;
      if (shoved) {
        shoveTicks++;
        shoves[br]++;
      }
      // Contact run length, per bot: touching a teammate at all (shoving or not).
      const md = String(a.mode ?? "?");
      // What is this bot walking to right now, and how far off it is.
      const navg = (game as any).nav;
      let dk = "none";
      let dp: any = null;
      if (a.strafeTarget) { dk = "strafeTarget"; dp = a.strafeTarget; }
      else if (a.holdPeek || a.holdCover) { dk = "hold spot"; dp = a.holdPeek ?? a.holdCover; }
      else if (a.atGoalNode && a.lastTarget) { dk = "beeline at chase"; dp = a.lastTarget.pos; }
      else if (navg && a.waypoint >= 0 && a.waypoint < navg.nodes.length) { dk = "waypoint node"; dp = navg.nodes[a.waypoint].pos; }
      if (touching > 0) {
        bump(destKind, dk);
        if (dk === "beeline at chase" && dp) {
          const d = Math.hypot(dp.x - a.pos.x, dp.y - a.pos.y);
          const so = (a as any).standoff ?? 130;
          const band = d < so - 20 ? "inside standoff" : d <= so + 20 ? "AT standoff (+/-20px)" : "outside standoff";
          bump(standoffHist, band);
        }
      }
      if (touching > 0) { bump(modeTicks, md); if (shoved) bump(modeShoves, md); }
      if (touching > 0) {
        a.__run = (a.__run ?? 0) + 1;
        a.__runBr = a.__runBr ?? [];
        a.__runBr.push([br, md]);
        a.__runPath = (a.__runPath ?? 0) + Math.hypot(a.vel.x, a.vel.y);
        if (a.__runStart === undefined) a.__runStart = { x: a.pos.x, y: a.pos.y };
        a.__runEnd = { x: a.pos.x, y: a.pos.y };
      } else if (a.__run) {
        runs.push(a.__run);
        if (a.__run > 5) {
          longRunTicks += a.__run;
          for (const [b, md2] of a.__runBr) {
            longRunBranch[b as Branch]++;
            bump(modeLong, md2); bump(cross, `${md2} / ${b}`);
          }
        }
        if (a.__run > 5 && a.__runStart) {
          const net = Math.hypot(a.__runEnd.x - a.__runStart.x, a.__runEnd.y - a.__runStart.y);
          runPath += a.__runPath ?? 0;
          runNet += net;
          if ((a.__runPath ?? 0) > 3 * Math.max(net, 1)) churnRuns++; else travelRuns++;
        }
        a.__run = 0;
        a.__runBr = [];
        a.__runPath = 0;
        a.__runStart = undefined;
      }
    }
  }
}

for (let m = 0; m < MATCHES; m++) runMatch();

const pct = (x: number, of: number): string => (of > 0 ? `${((100 * x) / of).toFixed(2)}%` : "—");
console.log(`\n${MATCHES} matches x ${TICKS} ticks on ${LEVEL} (5v5), seed ${SEED}`);
console.log(`bot-ticks ${botTicks}\n`);
console.log(`overlapping a teammate      ${String(overlapTicks).padStart(8)}   ${pct(overlapTicks, botTicks)} of bot-ticks`);
console.log(`overlapping 2+ (pileup)     ${String(multiOverlapTicks).padStart(8)}   ${pct(multiOverlapTicks, botTicks)}`);
console.log(`stepping INTO a teammate    ${String(shoveTicks).padStart(8)}   ${pct(shoveTicks, botTicks)}\n`);
console.log("shoves by movement branch        total");
for (const b of BRANCHES) {
  if (shoves[b] === 0) continue;
  console.log(
    `  ${b.padEnd(28)} ${String(shoves[b]).padStart(6)}   ${pct(shoves[b], shoveTicks)}`,
  );
}
runs.sort((a, b) => a - b);
const bucket = (lo: number, hi: number): number => runs.filter((r) => r >= lo && r <= hi).length;
console.log(`\ncontact runs (consecutive ticks touching a teammate): ${runs.length}`);
console.log(`  1-2 ticks   ${String(bucket(1, 2)).padStart(6)}   ${pct(bucket(1, 2), runs.length)}`);
console.log(`  3-5 ticks   ${String(bucket(3, 5)).padStart(6)}   ${pct(bucket(3, 5), runs.length)}`);
console.log(`  6-15 ticks  ${String(bucket(6, 15)).padStart(6)}   ${pct(bucket(6, 15), runs.length)}`);
console.log(`  16-60 ticks ${String(bucket(16, 60)).padStart(6)}   ${pct(bucket(16, 60), runs.length)}`);
console.log(`  61+ ticks   ${String(bucket(61, 1e9)).padStart(6)}   ${pct(bucket(61, 1e9), runs.length)}   longest ${runs[runs.length - 1] ?? 0}`);
console.log(`\nbranch mix INSIDE runs longer than one plan cycle (${longRunTicks} ticks):`);
for (const b of BRANCHES) {
  if (longRunBranch[b] === 0) continue;
  console.log(`  ${b.padEnd(22)} ${String(longRunBranch[b]).padStart(6)}   ${pct(longRunBranch[b], longRunTicks)}`);
}
const table = (m: Map<string, number>, of: number, title: string): void => {
  console.log(`\n${title}`);
  for (const [k, v] of [...m.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(6)}   ${pct(v, of)}`);
  }
};
table(modeTicks, overlapTicks, "bot `mode` on every tick spent touching a teammate:");
table(modeShoves, shoveTicks, "bot `mode` on every tick it stepped INTO a teammate:");
table(cross, longRunTicks, "mode / branch inside runs longer than one plan cycle:");
table(destKind, overlapTicks, "what the bot was walking to, on every tick it was touching a teammate:");
if (standoffHist.size) table(standoffHist, [...standoffHist.values()].reduce((x, y) => x + y, 0), "beeline contacts, by distance to the chase:");
console.log(`\nlong contacts (>5 ticks): walked ${runPath.toFixed(0)}px of path for ${runNet.toFixed(0)}px of progress` +
  ` (${runNet > 0 ? (runPath / runNet).toFixed(1) : "inf"}x)`);
console.log(`  churning in place (path > 3x net): ${churnRuns} runs;  actually travelling: ${travelRuns}`);
stallRuns.sort((a, b) => a - b);
const sb = (lo: number, hi: number): number => stallRuns.filter((r) => r >= lo && r <= hi).length;
console.log(`\nunshove: ${unshoveCalls} calls, ${unshoveCut} trimmed (${pct(unshoveCut, unshoveCalls)}), ` +
  `${unshoveKilled} all but killed (${pct(unshoveKilled, unshoveCalls)})`);
console.log(`stall streaks (consecutive killed steps): ${stallRuns.length}` +
  `  1-5t ${sb(1, 5)}  6-15t ${sb(6, 15)}  16-60t ${sb(16, 60)}  61+ ${sb(61, 1e9)}  longest ${stallRuns[stallRuns.length - 1] ?? 0}`);
console.log("\nact() dispatch:");
for (const [k, v] of disp) console.log(`  ${k.padEnd(46)} ${String(v).padStart(7)}   ${pct(v, disp.get("act calls") ?? 1)}`);

// One machine-readable line per run, so a sweep over maps can be tabulated.
const share = (m: Map<string, number>, k: string, of: number): string =>
  of > 0 ? ((100 * (m.get(k) ?? 0)) / of).toFixed(1) : "0.0";
const acts = disp.get("act calls") ?? 1;
const longRuns = runs.filter((r) => r > 5).length;
const topBranch = BRANCHES.reduce((a, b) => (shoves[b] > shoves[a] ? b : a), "none" as Branch);
console.log(
  [
    "SUMMARY", LEVEL, botTicks,
    pct(overlapTicks, botTicks), pct(multiOverlapTicks, botTicks), pct(shoveTicks, botTicks),
    pct(longRuns, runs.length), runs[runs.length - 1] ?? 0,
    share(disp, "  STRAFE", acts), share(disp, "  approach", acts),
    share(disp, "  cover", acts), share(disp, "  hold", acts),
    share(disp, "  planted by standToShoot (returned early)", acts),
    share(modeShoves, "shoot", shoveTicks), share(modeShoves, "cover", shoveTicks),
    share(modeShoves, "hold", shoveTicks),
    topBranch, pct(shoves[topBranch], shoveTicks),
  ].join("\t"),
);
