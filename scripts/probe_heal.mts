/**
 * probe_heal.mts — why don't bots heal? Samples every bot every tick and splits
 * "wants to heal" (hurt and alive) by whichever gate is actually blocking, then
 * follows every heal that does start: how long it lasted, why it ended, and
 * whether the item use ever completed.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_heal.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/phl.mjs && node <tmp>/phl.mjs [level] [ticks] [seed]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { areHostile } from "../src/entities/team.ts";

const LEVEL = process.argv[2] ?? "house-3";
const TICKS = Number(process.argv[3] ?? 6000);
const SEED = Number(process.argv[4] ?? 1);
let sd = SEED >>> 0;
Math.random = () => ((sd = (sd * 1664525 + 1013904223) >>> 0), sd / 4294967296);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

// mirrors tacoracle's constants
const HEAL_HP = 75, HEAL_SAFE = 700, HEAL_ALARM = 400, HEAL_COMMIT = 90;

let usesStarted = 0, usesFinished = 0, hpHealed = 0, spawns = 0, spawnsEmpty = 0;
// Combat output, so a heal-happy bot that stops fighting shows up as a cost.
let enemyDamage = 0, deaths = 0;
// The cost axis for the panic threshold: damage taken, and deaths, while the
// victim was actually mid-heal. A lower alarm keeps bots healing longer, so this
// is where "kept healing too long" shows up.
let dmgWhileHealing = 0, deathsWhileHealing = 0;
{
  const o = (Character.prototype as any).registerHit;
  (Character.prototype as any).registerHit = function (this: any, ...a: any[]) {
    const hp0 = this.hp;
    const r = o.apply(this, a);
    const attacker = a[4];
    const took = Math.max(0, hp0 - this.hp);
    if (attacker && attacker.team && areHostile(attacker.team, this.team)) enemyDamage += took;
    if (hp0 > 0 && this.hp <= 0) deaths++;
    if ((this as any).mode === "heal") {
      dmgWhileHealing += took;
      if (hp0 > 0 && this.hp <= 0) deathsWhileHealing++;
    }
    return r;
  };
}
{
  const o = (Character.prototype as any).startUse;
  (Character.prototype as any).startUse = function (this: any, ...a: any[]) {
    const before = this.useTicks;
    const r = o.apply(this, a);
    if (before === 0 && this.useTicks > 0) usesStarted++;
    return r;
  };
  const f = (Character.prototype as any).finishUse;
  (Character.prototype as any).finishUse = function (this: any, ...a: any[]) {
    usesFinished++;
    const hp0 = this.hp;
    const r = f.apply(this, a);
    hpHealed += Math.max(0, this.hp - hp0);
    return r;
  };
}

const bump = (m: Map<string, number>, k: string, n = 1): void => m.set(k, (m.get(k) ?? 0) + n);
{
  const o = (Character.prototype as any).applyLoadout ?? null;
  void o;
}
const blocked = new Map<string, number>();
const reach = new Map<string, number>();
let reachTicks = 0;
const exits = new Map<string, number>();
const durations: number[] = [];
let wantTicks = 0, healTicks = 0, entries = 0, regenHp = 0;

const game = new Game(loadLevel(TEXT), /dom/.test(LEVEL)
  ? new DominationMode({ blue: { troops: 5 }, red: { troops: 5 } })
  : new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));

for (let i = 0; i < TICKS; i++) {
  game.update();
  for (const c of (game as any).characters) {
    if (!(c instanceof TacOracle) || c.hp <= 0) continue;
    const a = c as any;
    const items = a.utilities.length > 0;
    const evd = a.enemyVisDist ?? Infinity;

    // Did a heal just end? Classify by which stay-condition failed.
    if (a.__mode === "heal" && a.mode !== "heal") {
      durations.push(a.__healLen ?? 0);
      bump(exits,
        !items ? "out of items"
        : c.hp >= c.maxHp ? "topped off"
        : evd < HEAL_ALARM ? `alarm (enemy reach < ${HEAL_ALARM})`
        : "other (outranked by another posture?)");
      a.__healLen = 0;
    }
    if (a.mode === "heal") {
      healTicks++;
      a.__healLen = (a.__healLen ?? 0) + 1;
      if (a.__mode !== "heal") entries++;
    }
    a.__mode = a.mode;

    // How FAR off is the safety gate? Bucketed for the hurt-and-equipped case,
    // which is the population a threshold change would actually reach.
    if (c.hp < HEAL_HP && items && a.mode !== "heal") {
      const b = evd === Infinity ? "unreachable (no enemy can reach us)"
        : evd < 100 ? "0-100" : evd < 200 ? "100-200" : evd < 400 ? "200-400"
        : evd < 700 ? "400-700" : evd < 1200 ? "700-1200" : "1200+";
      bump(reach, b);
      reachTicks++;
    }

    // Hurt and alive: what is stopping a heal right now?
    if (a.__seen === undefined || a.__hp0 === undefined || (a.__hp0 <= 0 && c.hp > 0)) {
      spawns++; if (a.utilities.length === 0) spawnsEmpty++; a.__seen = 1;
    }
    a.__hp0 = c.hp;
    if (c.hp < HEAL_HP) {
      wantTicks++;
      if (a.mode === "heal") bump(blocked, "HEALING");
      else if (!items) bump(blocked, "no healing item carried");
      else if (evd < HEAL_SAFE) bump(blocked, `enemy reach < ${HEAL_SAFE} (unsafe)`);
      else if ((a.healDwell ?? 0) < HEAL_COMMIT) bump(blocked, `safe, still serving the ${HEAL_COMMIT}t dwell`);
      else bump(blocked, "eligible but not healing (outranked?)");
    }
  }
}
// regen (syringe) delivered over time
for (const c of (game as any).characters) void c;

const pct = (x: number, of: number): string => (of ? `${((100 * x) / of).toFixed(1)}%` : "—");
const table = (m: Map<string, number>, of: number, title: string): void => {
  console.log(`\n${title}`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${k.padEnd(42)} ${String(v).padStart(7)}   ${pct(v, of)}`);
};
console.log(`${LEVEL} seed ${SEED}, ${TICKS} ticks`);
console.log(`hurt (hp<${HEAL_HP}) bot-ticks: ${wantTicks};  heal-mode ticks: ${healTicks} (${pct(healTicks, wantTicks)} of hurt time)`);
table(blocked, wantTicks, `while hurt, the blocking gate was:`);
table(reach, reachTicks, "hurt WITH an item, by distance-until-an-enemy-could-see-us:");
console.log(`\nheals entered: ${entries}`);
durations.sort((a, b) => a - b);
if (durations.length) {
  const med = durations[Math.floor(durations.length / 2)];
  console.log(`  duration: median ${med}t, longest ${durations[durations.length - 1]}t`);
  console.log(`  shorter than a bandage use (150t): ${durations.filter((d) => d < 150).length}/${durations.length}`);
}
table(exits, durations.length, "heals ended because:");
console.log(`\nspawns observed ${spawns}, of which carried NO healing item: ${spawnsEmpty} (${pct(spawnsEmpty, spawns)})`);
console.log(`enemy damage ${enemyDamage.toFixed(0)}, deaths ${deaths}`);
console.log(`caught mid-heal: ${deathsWhileHealing} deaths, ${dmgWhileHealing.toFixed(0)} damage taken`);
console.log(`item uses started ${usesStarted}, completed ${usesFinished} (${pct(usesFinished, usesStarted)}), HP restored ${hpHealed.toFixed(0)}`);
void regenHp;
