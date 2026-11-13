/**
 * Verifies that the dead take no more hits. A body killed this tick stays in the
 * target list until the tick's reap, so the hit loops must skip it themselves:
 * the rounds of a burst past the one that killed fly on (and land on whoever
 * stands behind), the kill stays with whoever made it, and a swing or a blast
 * goes to the living.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_deadpass.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vdp.mjs && node <tmp>/vdp.mjs
 */
import { explode, meleeSwing, spawnBullet, updateBullets, type Hittable, type World } from "../src/world/world.ts";
import { Character } from "../src/entities/actor.ts";
import { Gun } from "../src/entities/gun.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };

function world(): World {
  return {
    obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
  } as unknown as World;
}

function body(at: Vec2, hp: number): Character {
  const c = new Character(at, DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.hp = hp;
  return c;
}

/** Hits the events say landed on `c`. */
const hitsOn = (w: World, c: Hittable): number => w.events.filter((e) => e.kind === "hit" && e.victim === c.id).length;

console.log("a burst past the kill flies on:");
{
  // Five 15-damage rounds in one volley down +x, all reaching the front body
  // on the same tick: 20 hp takes two of them, the three left go on behind.
  const w = world();
  const front = body(vec(0, 0), 20);
  const back = body(vec(120, 0), 100);
  const a = body(vec(-500, 300), 100); // the shooters, out of the way
  const b = body(vec(-500, -300), 100);
  for (let i = 0; i < 5; i++) {
    spawnBullet(w, vec(-200, 0), vec(1, 0), 60, 40, 0, i < 2 ? a : b, 15, 4, 20, "#fff", AP, 0);
  }
  const hits = { front: 0, back: 0 };
  for (let i = 0; i < 40 && w.bullets.length; i++) {
    w.events = [];
    updateBullets(w, [front, back, a, b]);
    hits.front += hitsOn(w, front);
    hits.back += hitsOn(w, back);
  }
  check("the front body takes only the rounds that killed it", front.hp === 0 && hits.front === 2, `${hits.front} hits, hp ${front.hp}`);
  check("...the rest land on the body behind it", hits.back === 3 && back.hp === 55, `${hits.back} hits, hp ${back.hp}`);
  check("...and the kill stays with the shooter whose round made it", front.lastAttacker === a,
    front.lastAttacker === b ? "credited to the next shooter" : "");
}

console.log("\na swing or a blast goes to the living:");
{
  const w = world();
  const swinger = body(vec(-60, 0), 100);
  const dead = body(vec(0, 0), 0);
  const alive = body(vec(40, 0), 100);
  meleeSwing(w, swinger, vec(1, 0), [dead, alive], { reach: 145, coneDeg: 60, damage: 20, armorPen: AP, heft: 1 });
  check("a swing skips a body already dead in front for the live one behind", hitsOn(w, dead) === 0 && alive.hp === 80,
    `dead hit ${hitsOn(w, dead)}x, live hp ${alive.hp}`);

  const wb = world();
  const corpse = body(vec(50, 0), 0);
  const near = body(vec(-50, 0), 100);
  explode(wb, vec(0, 0), 0, 80, 300, AP, null, [corpse, near]);
  check("a blast hurts the living and leaves the dead alone",
    hitsOn(wb, corpse) === 0 && corpse.lastAttacker === null && near.hp < 100 &&
      wb.events.filter((e) => e.kind === "blood").length === 1,
    `corpse hit ${hitsOn(wb, corpse)}x, live hp ${near.hp.toFixed(1)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
