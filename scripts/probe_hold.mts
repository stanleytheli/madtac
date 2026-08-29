import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { areHostile } from "../src/entities/team.ts";
/** Local copy of tacoracle's friendInLine + FRIENDLY_MARGIN, so this probe
 *  measures the same thing against the code both before and after the change. */
const MARGIN = BODY_RADIUS * 2;
const inLine = (from: any, to: any, mate: any): boolean => {
  const dx = to.x - from.x, dy = to.y - from.y, l2 = dx * dx + dy * dy;
  if (l2 < 1e-6) return false;
  const t = ((mate.x - from.x) * dx + (mate.y - from.y) * dy) / l2;
  if (t <= 0 || t >= 1) return false;
  const ex = mate.x - (from.x + dx * t), ey = mate.y - (from.y + dy * t);
  return ex * ex + ey * ey < MARGIN * MARGIN;
};
const mateInAngle = (bot: any, chars: readonly any[], to: any): boolean =>
  chars.some((c) => c !== bot && c.hp > 0 && c.z === bot.z && !areHostile(bot.team, c.team) && inLine(bot.pos, to, c.pos));
const LEVEL = process.argv[2] ?? "house-3", TICKS = Number(process.argv[3] ?? 4000), SEED = Number(process.argv[4] ?? 1);
let sd = SEED >>> 0; Math.random = () => ((sd = (sd * 1664525 + 1013904223) >>> 0), sd / 4294967296);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
let holdTicks = 0, fouled = 0, fouledAtPlan = 0, plans = 0;
const runs: number[] = [];
// Count how often a bot that IS holding has a teammate in the angle it holds.
const oPlan = (TacOracle.prototype as any).planFromEntry;
(TacOracle.prototype as any).planFromEntry = function (this: any, ai: any, entry: any) {
  const r = oPlan.call(this, ai, entry);
  if (r) { plans++; if (mateInAngle(this, ai.characters, this.holdEntry)) fouledAtPlan++; }
  return r;
};
let refreshCalls = 0, peekMoved = 0, parkedFoul = 0, unparkedFoul = 0, holdWalk = 0;
{
  const o = (TacOracle.prototype as any).refreshHold;
  (TacOracle.prototype as any).refreshHold = function (this: any, ai: any, t: any) {
    refreshCalls++;
    const b = this.holdPeek;
    const r = o.call(this, ai, t);
    // Jitter: did the refresh actually move the peek, and by how far?
    if (this.holdPeek && b && Math.hypot(this.holdPeek.x - b.x, this.holdPeek.y - b.y) > 4) peekMoved++;
    return r;
  };
}
const game = new Game(loadLevel(TEXT), /dom/.test(LEVEL)
  ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
  : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
for (let i = 0; i < TICKS; i++) {
  game.update();
  for (const c of (game as any).characters) {
    if (!(c instanceof TacOracle) || c.hp <= 0) continue;
    const a = c as any;
    if (a.mode !== "hold" || !a.holdEntry) { if (a.__f) { runs.push(a.__f); a.__f = 0; } continue; }
    holdTicks++;
    holdWalk += Math.hypot(c.vel.x, c.vel.y);
    const ai = { world: (game as any).world, characters: (game as any).characters, nav: (game as any).nav, tick: i };
    // Measure at the PEEK, which is what the hold's angle actually is, and what
    // the new check tests. Measuring from a.pos reports a break whenever the bot
    // is ducked in cover, which is normal and not a fault.
    const at = a.holdPeek ?? a.pos;
    if (a.holdPeek && ai.characters.some((c: any) => c !== a && c.hp > 0 && c.z === a.z &&
        !areHostile(a.team, c.team) && inLine(at, a.holdEntry, c.pos))) {
      fouled++; a.__f = (a.__f ?? 0) + 1;
      const parked = a.holdPath.length === 0 && a.holdCover && a.holdPeek &&
        (Math.hypot(a.pos.x - a.holdCover.x, a.pos.y - a.holdCover.y) <= 8 ||
         Math.hypot(a.pos.x - a.holdPeek.x, a.pos.y - a.holdPeek.y) <= 8);
      if (parked) parkedFoul++; else unparkedFoul++;
    }
    else if (a.__f) { runs.push(a.__f); a.__f = 0; }
  }
}
runs.sort((x, y) => x - y);
const p = (x: number, of: number) => (of ? `${((100 * x) / of).toFixed(2)}%` : "—");
console.log(`${LEVEL} seed ${SEED}: ${holdTicks} hold-ticks, ${plans} hold plans committed`);
console.log(`  angle fouled by a teammate:  ${fouled} ticks  (${p(fouled, holdTicks)} of hold time)`);
console.log(`  ...already fouled AT PLAN TIME: ${fouledAtPlan} plans (${p(fouledAtPlan, plans)})`);
console.log(`  fouled ticks while PARKED: ${parkedFoul} (${p(parkedFoul, fouled)}), while moving: ${unparkedFoul}`);
console.log(`  refreshHold: ${refreshCalls} calls, ${peekMoved} moved the peek (${p(peekMoved, refreshCalls)}) = jitter risk`);
console.log(`  walking while holding: ${holdWalk.toFixed(0)}px over ${holdTicks} hold-ticks (${(holdWalk / Math.max(holdTicks, 1)).toFixed(3)} px/tick)`);
console.log(`  fouled streaks: ${runs.length}  median ${runs[Math.floor(runs.length / 2)] ?? 0}t  longest ${runs[runs.length - 1] ?? 0}t`);
