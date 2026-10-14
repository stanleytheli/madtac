/** Run a domination match on any level headless (8v8, random equip): which owners
 *  each point saw, how much time bots spent on z=1, deaths. NOTE: the "stood still"
 *  figure counts the idle human player slot too; and in this harness bots almost
 *  never reach an upper-level point even on house-3 (0% over 9000 ticks) — see the
 *  dom-headless-baseline memory before reading a low z=1 figure as a map bug.
 *
 *    npx tsx scripts/smoke_dom.mts src/world/levels/harbor.json [ticks]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
const TEXT = readFileSync(process.argv[2], "utf8");
const TICKS = Number(process.argv[3] ?? 9000);
(Robot as unknown as { nextPhase: number }).nextPhase = 0;
const mode = new DominationMode({ scoreLimit: 300, blue: { troops: 8, skill: 0.6, equip: "random" }, red: { troops: 8, skill: 0.6, equip: "random" } });
const game = new Game(loadLevel(TEXT), mode);
const owners: Record<string, Set<string>> = { A: new Set(), B: new Set(), C: new Set() };
const nameOf = (o: any, i = 0) => "ABC"[i] ?? "?";
let onDeck = 0, samples = 0, maxStill = 0;
const last = new Map<object, { x: number; y: number; t: number }>();
for (let t = 0; t < TICKS; t++) {
  game.update();
  if (t % 60 === 0) {
    mode.objectives(game as never).forEach((o, i) => owners[nameOf(o, i)].add(o.owner));
    for (const c of game.characters) {
      if (c.hp <= 0) continue;
      samples++; if (c.z === 1) onDeck++;
      const l = last.get(c);
      if (l && Math.hypot(l.x - c.pos.x, l.y - c.pos.y) < 20) maxStill = Math.max(maxStill, t - l.t);
      else last.set(c, { x: c.pos.x, y: c.pos.y, t });
    }
  }
  if (t % 3000 === 0 || t === TICKS - 1) {
    const zs = game.characters.filter((c) => c.hp > 0).map((c) => c.z);
    console.log(`t=${t} alive=${zs.length} onDeck=${zs.filter((z) => z === 1).length} objectives=${mode.objectives(game as never).map((o, i) => `${nameOf(o, i)}:${o.owner}`).join(" ")}`);
  }
}
console.log("owners seen:", Object.entries(owners).map(([k, v]) => `${k}=[${[...v].join(",")}]`).join("  "));
console.log(`deck occupancy ${(100 * onDeck / samples).toFixed(1)}% of live bot-samples; longest one bot stood still: ${maxStill} ticks`);
const deaths = (mode as unknown as { agents: { team: string; deaths: number; kills: number }[] }).agents;
console.log("deaths blue/red:", deaths.filter((a) => a.team === "blue").reduce((s, a) => s + a.deaths, 0), deaths.filter((a) => a.team === "red").reduce((s, a) => s + a.deaths, 0));
