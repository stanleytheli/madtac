/**
 * probe_ignore.mts — why does a bot stand near a visible enemy without
 * targeting it?
 *
 * Watches every live TacOracle each tick for "ignore episodes": a same-z
 * hostile is CLOSE (< CLOSE px), VISIBLE (raycast > 0), and stays that way for
 * THRESH+ consecutive ticks while the bot's committed focus is someone else
 * (or nothing). When an episode crosses the threshold, it snapshots the
 * selectTarget cost breakdown for the ignored enemy vs the current focus and
 * classifies the cause: share-forbid (3+ mates on them), share-big (2 mates),
 * lane blocked, focus honestly cheaper, out of range.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_ignore.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pi.mjs && node <tmp>/pi.mjs [matches] [ticks] [level] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { areHostile } from "../src/entities/team.ts";

const MATCHES = Number(process.argv[2] ?? 4);
const TICKS = Number(process.argv[3] ?? 4000);
const LEVEL = process.argv[4] ?? "dust2-a-tdm-2";
const SEED = Number(process.argv[5] ?? 1);
const TROOPS = Number(process.argv[6] ?? 5);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

const CLOSE = 450; // "very close" (px, straight line, same z)
const THRESH = 60; // ticks ignored before it counts as an episode (1s)

let seed = SEED >>> 0;
Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);

let botTicks = 0;
let exposedTicks = 0; // bot-ticks with a close visible same-z hostile at all
let ignoredTicks = 0; // ...of those, focus is not any of them
const episodes: number[] = []; // lengths of finished ignore streaks
const causes = new Map<string, number>();
const focusKind = new Map<string, number>();
const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
let snapshots = 0;
const SNAP_MAX = 12;

function diagnose(ai: any, bot: any, near: any[], tick: number): void {
  // Rebuild selectTarget's cost for the closest ignored hostile and the focus.
  const h = near[0];
  const range = bot.gun.feasibleRange;
  const d = Math.hypot(h.pos.x - bot.pos.x, h.pos.y - bot.pos.y);
  const sc = bot.shootCost(ai, h);
  const share = bot.targetShareCost(ai, h);
  const mates = ((): number => {
    let k = 0;
    for (const c of ai.characters) {
      if (c === bot || c.hp <= 0 || areHostile(bot.team, c.team)) continue;
      if (c instanceof TacOracle && (c as any).focus === h) k++;
    }
    return k;
  })();
  const costH = sc + 0.75 * d + share + (d > range ? 1e5 : 0);

  const f = bot.focus;
  let costF = Infinity;
  let fDesc = "none";
  if (f && f.hp > 0) {
    const df = Math.hypot(f.pos.x - bot.pos.x, f.pos.y - bot.pos.y);
    const nearF = f.z === bot.z ? df : bot.walkDist(ai, bot, f);
    costF = bot.shootCost(ai, f) + 0.75 * nearF + bot.targetShareCost(ai, f) - 30;
    if (df > range) costF += 1e5;
    fDesc = `${f.z === bot.z ? "same-z" : "OFF-Z"} d=${df.toFixed(0)} walk=${nearF.toFixed(0)} cost=${costF.toFixed(0)}`;
  }
  bump(focusKind, f ? (f.z === bot.z ? "same-z focus" : "off-z focus") : "no focus");

  let cause: string;
  const cd = (bot as any).pursueCooldown ?? 0;
  const pt = (bot as any).pursueTicks ?? 0;
  if (cd > 0) cause = "pursuit-leash cooldown (dom AI ignoring off-site enemies)";
  else if (d > range) cause = "out of range";
  else if (mates >= 3) cause = "share-forbid (3+ mates on them)";
  else if (mates === 2 && share >= 400 && costH > costF) cause = "share-big (2 mates on them)";
  else if (sc >= 400 && costH > costF) cause = "no lane from any local spot";
  else if (costH > costF) cause = "focus honestly cheaper";
  else cause = `UNEXPLAINED (H cost ${costH.toFixed(0)} < focus ${costF.toFixed(0)})`;
  bump(causes, cause);

  if (snapshots < SNAP_MAX) {
    snapshots++;
    console.log(
      `  [t=${tick}] ignored: d=${d.toFixed(0)} lane=${sc} share=${share}(k=${mates}) ` +
        `cost=${costH.toFixed(0)} | mode=${bot.mode} leash cd=${cd} pt=${pt} focus: ${fDesc} | ${cause}`,
    );
  }
}

function runMatch(): void {
  const level = loadLevel(TEXT);
  const dom = /dom/.test(LEVEL);
  const game = new Game(
    level,
    dom
      ? new DominationMode({ blue: { troops: TROOPS }, red: { troops: TROOPS } })
      : new TeamDeathmatchMode({ blue: { troops: TROOPS }, red: { troops: TROOPS } }),
  );
  for (let i = 0; i < TICKS; i++) {
    game.update();
    const chars = (game as any).characters;
    const ai = { world: (game as any).world, characters: chars, nav: (game as any).nav, tick: i };
    for (const a of chars) {
      if (!(a instanceof TacOracle) || a.hp <= 0 || a.vehicle) continue;
      const b: any = a;
      botTicks++;
      const near: any[] = [];
      for (const h of chars) {
        if (h === a || h.hp <= 0 || h.z !== a.z || !areHostile(a.team, h.team)) continue;
        const d = Math.hypot(h.pos.x - a.pos.x, h.pos.y - a.pos.y);
        if (d >= CLOSE) continue;
        if (b.visibility((game as any).world, h) <= 0) continue;
        near.push(h);
      }
      if (near.length === 0) {
        if (b.__ig > 0) episodes.push(b.__ig);
        b.__ig = 0;
        continue;
      }
      near.sort(
        (p: any, q: any) =>
          Math.hypot(p.pos.x - a.pos.x, p.pos.y - a.pos.y) -
          Math.hypot(q.pos.x - a.pos.x, q.pos.y - a.pos.y),
      );
      exposedTicks++;
      if (near.includes(b.focus)) {
        if (b.__ig > 0) episodes.push(b.__ig);
        b.__ig = 0;
        continue;
      }
      ignoredTicks++;
      b.__ig = (b.__ig ?? 0) + 1;
      if (b.__ig === THRESH) diagnose(ai, b, near, i);
    }
  }
}

for (let m = 0; m < MATCHES; m++) runMatch();

const pct = (a: number, b: number): string => (b > 0 ? ((100 * a) / b).toFixed(2) + "%" : "—");
const long = episodes.filter((e) => e >= THRESH);
episodes.sort((a, b) => a - b);
console.log(`\n${MATCHES} matches x ${TICKS} ticks on ${LEVEL} (x2 troops ${TROOPS}), seed ${SEED}`);
console.log(`bot-ticks ${botTicks}; with a close visible same-z hostile: ${pct(exposedTicks, botTicks)}`);
console.log(`...ignoring all of them (focus elsewhere/none): ${pct(ignoredTicks, exposedTicks)} of exposed ticks`);
console.log(
  `ignore streaks: ${episodes.length} total, ${episodes.filter((e) => e >= 30).length} >= 30t, ` +
    `${long.length} >= ${THRESH}t; longest ${episodes[episodes.length - 1] ?? 0}`,
);
console.log("\ncause at the moment each episode crossed the threshold:");
for (const [k, v] of [...causes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v}`);
console.log("\nwhat the bot was focused on instead:");
for (const [k, v] of [...focusKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v}`);
