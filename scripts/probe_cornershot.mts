/** How many bot shots go straight into the cover the bot is peeking from.
 *  Hooks TacOracle.onFired: at each shot, cast the TRUE line of fire (head
 *  centre along `forward`, out to the aim distance) and classify it as clear,
 *  a wallbang the gun can punch through, blocked near the shooter (< NEAR px:
 *  its own corner), or blocked further out.
 *  Also counts hit events landed per shot. Domination 8v8, random equip.
 *
 *    npx tsx scripts/probe_cornershot.mts src/world/levels/house-3.json [ticks] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { losClear, shotClear, wallbangSightBudget } from "../src/world/world.ts";
import { add, dist, scale, type Vec2 } from "../src/engine/vec.ts";

const TEXT = readFileSync(process.argv[2], "utf8");
const TICKS = Number(process.argv[3] ?? 9000);
const SEED = Number(process.argv[4] ?? 1);
// Deterministic Math.random (mulberry32) so before/after runs are comparable.
let s = SEED >>> 0;
Math.random = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const NEAR = 120;
(Robot as unknown as { nextPhase: number }).nextPhase = 0;
const mode = new DominationMode({ scoreLimit: 100000, blue: { troops: 8, skill: 0.6, equip: "random" }, red: { troops: 8, skill: 0.6, equip: "random" } });
const game = new Game(loadLevel(TEXT), mode);
let shots = 0, clear = 0, near = 0, far = 0, bang = 0;
const proto = TacOracle.prototype as any;
const orig = proto.onFired;
proto.onFired = function (this: any) {
  orig.call(this);
  const t = this.lastTarget;
  if (!t || this.gun.spec.melee) return;
  shots++;
  const aim = add(t.pos, this.aimError);
  const d = dist(this.pos, aim);
  const w = game.world;
  const at = (k: number): Vec2 => add(this.pos, scale(this.forward, k));
  if (losClear(w, this.pos, at(d), this.z)) { clear++; return; }
  // Through material the gun is rated to punch: a deliberate wallbang, not a waste.
  const budget = wallbangSightBudget(this.gun.spec.penetration ?? 0);
  if (budget > 0 && shotClear(w, this.pos, at(d), this.z, budget)) { bang++; return; }
  // Bisect for the first blocked distance.
  let lo = 0, hi = d;
  for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (losClear(w, this.pos, at(m), this.z)) lo = m; else hi = m; }
  if (hi < NEAR) near++; else far++;
};
let hits = 0;
const botIds = () => new Set(game.characters.filter((c) => c instanceof TacOracle).map((c) => c.id));
for (let t = 0; t < TICKS; t++) {
  game.update();
  const ids = botIds();
  for (const e of game.world.events) if (e.kind === "hit" && e.attacker !== null && ids.has(e.attacker)) hits++;
}
const pct = (n: number) => `${((100 * n) / shots).toFixed(1)}%`;
console.log(`shots=${shots} clear=${pct(clear)} intoOwnCover(<${NEAR}px)=${pct(near)} blockedFar=${pct(far)} wallbang=${pct(bang)} hits/shot=${(hits / shots).toFixed(3)}`);
const ag = (mode as any).agents as { team: string; kills: number }[];
console.log(`kills total=${ag.reduce((a, b) => a + b.kills, 0)}`);
