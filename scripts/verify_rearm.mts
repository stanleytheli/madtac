/**
 * Verifies the out-of-ammo rearm behavior: a TacOracle with no bullets left
 * routes to the nearest ground gun that STILL HAS AMMO, ignoring empty ones (so
 * it can't loop picking up and dropping dry weapons), grabs it, and can fire again.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_rearm.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vr.mjs && node <tmp>/vr.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { NavGraph } from "../src/world/nav.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Gun } from "../src/entities/gun.ts";
import { AK47, M16 } from "../src/entities/guns.ts";
import { GunItem } from "../src/entities/item.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { dist, vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
}

const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena-big.json", "utf8"));
const world = loaded.world;
world.grid = new ObstacleGrid(world.obstacles);
const nav = new NavGraph(world);

// Bot on a z0 node; a loaded gun a walk away; an EMPTY gun right next to the bot.
const home = nav.nodes.find((n) => n.z === 0)!;
const hn = nav.nearestWalkable(world, home.pos, 0)!;
let farPos = vec(home.pos.x, home.pos.y);
for (const n of nav.nodes) {
  if (n.z !== 0 || n === home) continue;
  const gn = nav.nearestWalkable(world, n.pos, 0);
  if (gn < 0) continue;
  const r = nav.route(hn, gn);
  if (r && r.dist > 150 && r.dist < 500) { farPos = vec(n.pos.x, n.pos.y); break; }
}

const bot = new TacOracle(vec(home.pos.x, home.pos.y), { team: "player", z: 0, realGun: true, stagger: 5 });
// Drain the bot's weapon: no rounds anywhere.
bot.slots.primary!.mag = 0;
bot.slots.primary!.reserveMags = 0;

// A loaded AK a walk away, and a DRY M16 right on top of the bot (a decoy that
// naive "nearest gun" logic would grab and loop on).
const loadedGun = new Gun(AK47); // fresh => full mag + reserves
const loadedItem = new GunItem(vec(farPos.x, farPos.y), loadedGun, vec(0, 0), 0);
const dryGun = new Gun(M16);
dryGun.mag = 0;
dryGun.reserveMags = 0;
const dryItem = new GunItem(vec(home.pos.x + 40, home.pos.y), dryGun, vec(0, 0), 0);
world.items.push(dryItem, loadedItem);

const any = bot as unknown as { outOfAmmo(): boolean };
check("bot starts out of ammo", any.outOfAmmo());
check("an empty gun sits within pickup range at the start",
  dist(bot.pos, dryItem.pos) <= 65);

let grabbedTick = -1;
for (let tick = 0; tick < 600; tick++) {
  bot.think({ world, characters: [bot], nav, tick } as AiContext);
  if (!world.items.includes(loadedItem)) { grabbedTick = tick; break; }
}

check("picked up the loaded gun (within a reasonable walk)", grabbedTick >= 0,
  `grabbed at tick ${grabbedTick}`);
check("the adjacent EMPTY gun was never taken (no empty-pickup loop)",
  world.items.includes(dryItem));
check("bot now carries a loaded gun", !any.outOfAmmo());
// It grabbed the loaded AK and equipped it on the spot (before posture may later
// holster it to sprint), and it's carried with ammo.
check("equipped the picked-up AK at grab", bot.gun.spec === AK47,
  `spec=${bot.gun.spec.name}`);
check("carries the AK with ammo", bot.slots.primary?.spec === AK47 && bot.slots.primary.mag > 0,
  `mag=${bot.slots.primary?.mag}`);
check("bot walked to the gun (ended near where it was)",
  dist(bot.pos, farPos) <= 80, `dist=${dist(bot.pos, farPos).toFixed(0)}`);

// A bot with a loaded gun ignores ground guns entirely (doesn't wander off to
// collect them).
const armed = new TacOracle(vec(home.pos.x, home.pos.y), { team: "player", z: 0, realGun: true, stagger: 5 });
const armedAny = armed as unknown as { outOfAmmo(): boolean };
check("a bot with ammo is not out of ammo", !armedAny.outOfAmmo());

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
