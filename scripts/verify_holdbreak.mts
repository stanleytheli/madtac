/**
 * Verifies that taking damage from an ENEMY while dug in (HOLD) breaks the hold
 * into SHOOT — a landed round means the pre-aimed angle was wrong — while
 * friendly fire, ownerless damage, and zero-damage hits leave the hold standing,
 * and hits in other modes change nothing. Also end-to-end: a real bullet with a
 * hostile owner flipping a holding bot via updateBullets (the world's attacker
 * plumbing, not a direct registerHit call).
 *
 * Run: node_modules/.bin/esbuild scripts/verify_holdbreak.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vb.mjs && node <tmp>/vb.mjs
 */
import { spawnBullet, updateBullets, type Hittable, type World } from "../src/world/world.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { AK47, UNARMED } from "../src/entities/guns.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};

function world(): World {
  return {
    obstacles: [],
    floors: [],
    stairs: [],
    nodes: [],
    items: [],
    vehicles: [],
    bullets: [],
    projectiles: [],
    particles: [], decals: [],
  };
}

/** A blue TacOracle wielding an AK, forced into a standing HOLD plan. */
function holder(): TacOracle {
  const b = new TacOracle(vec(0, 0), { team: "blue", z: 0, realGun: true, stagger: 1 });
  (b as any).slots.primary = new Gun(AK47);
  b.equip("primary");
  const a = b as any;
  a.mode = "hold";
  a.holdEntry = vec(200, 0);
  a.holdCover = vec(-40, 0);
  a.holdPeek = vec(-20, 0);
  a.holdEntryNode = 3;
  a.holdTicks = 50;
  return b;
}

function actor(team: string, x: number, y: number): Character {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = team as Character["team"];
  c.z = 0;
  return c;
}

const HOLD_RETRY_TICKS = 60; // mirrors tacoracle.ts

// --------------------------------------------- enemy hit breaks the hold ------
console.log("a hit from an ENEMY while holding -> SHOOT, plan dropped, retry parked:");
{
  const b = holder();
  const enemy = actor("red", 500, 0);
  b.registerHit(vec(-1, 0), b.pos, 25, AK47.armorPen, enemy);
  const a = b as any;
  check("damage still applied (super ran)", b.hp === 75, `hp=${b.hp}`);
  check("mode flipped to shoot", a.mode === "shoot", `mode=${a.mode}`);
  check("hold plan cleared", a.holdEntry === null && a.holdCover === null && a.holdPeek === null);
  check("hold identity/route cleared", a.holdEntryNode === -1 && a.holdPath.length === 0);
  check("dwell and dug-in clock reset", a.holdDwell === 0 && a.holdTicks === 0);
  check(
    "re-digging parked for the retry window",
    a.holdRetryIn >= HOLD_RETRY_TICKS,
    `holdRetryIn=${a.holdRetryIn}`,
  );
}

// --------------------------------------------- friendly fire does not ---------
console.log("friendly fire / ownerless / zero-damage hits leave the hold standing:");
{
  const b = holder();
  const mate = actor("blue", 500, 0);
  b.registerHit(vec(-1, 0), b.pos, 25, AK47.armorPen, mate);
  check("friendly hit: damage taken but still holding", b.hp === 75 && (b as any).mode === "hold");

  const b2 = holder();
  b2.registerHit(vec(-1, 0), b2.pos, 25, AK47.armorPen, null);
  check("ownerless hit: still holding", (b2 as any).mode === "hold");

  const b3 = holder();
  const enemy = actor("red", 500, 0);
  b3.registerHit(vec(-1, 0), b3.pos, 0, AK47.armorPen, enemy);
  check("zero-damage 'hit': still holding", (b3 as any).mode === "hold");
}

// --------------------------------------------- other modes untouched ----------
console.log("a hit outside HOLD changes nothing about the mode:");
{
  const b = new TacOracle(vec(0, 0), { team: "blue", z: 0, realGun: true, stagger: 1 });
  (b as any).slots.primary = new Gun(AK47);
  b.equip("primary");
  const enemy = actor("red", 500, 0);
  (b as any).mode = "cover";
  b.registerHit(vec(-1, 0), b.pos, 25, AK47.armorPen, enemy);
  check("cover stays cover", (b as any).mode === "cover");
  (b as any).mode = "shoot";
  b.registerHit(vec(-1, 0), b.pos, 25, AK47.armorPen, enemy);
  check("shoot stays shoot", (b as any).mode === "shoot");
}

// --------------------------------------------- end to end via a real bullet ---
console.log("a real bullet owned by a hostile flips a holding bot (world plumbing):");
{
  const w = world();
  const b = holder();
  b.pos = vec(300, 0);
  const enemy = actor("red", 0, 0);
  spawnBullet(w, vec(0, 0), vec(1, 0), 60, 20, 0, enemy, 25, 3, 200, "#fff", AK47.armorPen, 0);
  for (let i = 0; i < 20 && w.bullets.length; i++) {
    updateBullets(w, [b as unknown as Hittable]);
  }
  check("bullet landed", b.hp < 100, `hp=${b.hp}`);
  check("hold broke into shoot", (b as any).mode === "shoot", `mode=${(b as any).mode}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
