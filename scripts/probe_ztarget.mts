/** How often is the newly-admitted off-level target actually chosen, and does it
 *  leave the bot standing still in strafeMove (the deferred case)? */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
const LEVEL = process.argv[2] ?? "dust2-a-tdm-2", TICKS = Number(process.argv[3] ?? 4000), SEED = Number(process.argv[4] ?? 1);
let sd = SEED >>> 0; Math.random = () => ((sd = (sd * 1664525 + 1013904223) >>> 0), sd / 4294967296);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");
let botTicks = 0, offTarget = 0, offAndStuck = 0, fired = 0, offFired = 0;
const game = new Game(loadLevel(TEXT), /dom/.test(LEVEL)
  ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
  : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
const of2 = (TacOracle.prototype as any).shouldFire;
(TacOracle.prototype as any).shouldFire = function (this: any, ai: any, t: any) {
  const r = of2.call(this, ai, t);
  if (r) { fired++; if (t && t.z !== this.z) offFired++; }
  return r;
};
for (let i = 0; i < TICKS; i++) {
  game.update();
  for (const c of (game as any).characters) {
    if (!(c instanceof TacOracle) || c.hp <= 0) continue;
    const a = c as any;
    botTicks++;
    const t = a.lastTarget;
    if (t && t.hp > 0 && t.z !== c.z) {
      offTarget++;
      // standing still with an off-level target = the strafeMove case we deferred
      if (Math.hypot(c.vel.x, c.vel.y) < 0.01) offAndStuck++;
    }
  }
}
const p = (x: number, of: number) => (of ? `${((100 * x) / of).toFixed(2)}%` : "—");
console.log(`${LEVEL} seed ${SEED}: ${botTicks} bot-ticks`);
console.log(`  target is off-level:      ${offTarget}  (${p(offTarget, botTicks)} of bot-ticks)`);
console.log(`  ...and bot is motionless: ${offAndStuck}  (${p(offAndStuck, offTarget)} of those)`);
console.log(`  shouldFire true: ${fired};  at an off-level target: ${offFired}  (must be 0)`);
