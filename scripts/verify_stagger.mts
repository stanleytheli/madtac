/**
 * Verifies the weapon stagger effect: a staggering hit slows the receiver's actual
 * MOVEMENT for its duration but never their inaccuracy `speed` (so a stagger can't
 * make you a better shot); it's applied to a bullet's struck body and to everyone an
 * explosion damaged (any distance in range, any sliver of visibility); it doesn't
 * stack (a fresh hit refreshes); and it expires via tickStatus.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_stagger.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vs.mjs && node <tmp>/vs.mjs
 */
import {
  explode,
  spawnBullet,
  updateBullets,
  makeWall,
  type Hittable,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { AK47, RPG, UNARMED } from "../src/entities/guns.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

function world(obstacles: any[] = []): World {
  const w: World = {
    obstacles,
    floors: [],
    stairs: [],
    nodes: [],
    items: [],
    vehicles: [],
    bullets: [],
    projectiles: [],
    particles: [],
  };
  if (obstacles.length) w.grid = new ObstacleGrid(obstacles);
  return w;
}

/** A minimal Hittable that records the stagger it was told to take. */
function dummy(x: number, y: number, z = 0) {
  return {
    pos: vec(x, y),
    z,
    dmg: 0,
    stMul: 1,
    stTicks: 0,
    registerHit(_d: any, _p: any, damage: number) {
      this.dmg += damage;
    },
    applyStagger(mul: number, ticks: number) {
      this.stMul = mul;
      this.stTicks = ticks;
    },
  };
}

const player = (spec = UNARMED): Character =>
  new Character(vec(0, 0), DEFAULT_SKIN, { primary: new Gun(spec), hand: new Gun(UNARMED) });

// --------------------------------------------- movement slows, aim doesn't -----
console.log("a stagger slows ACTUAL movement but not the inaccuracy speed:");
{
  const staggered = player();
  const control = player();
  staggered.applyStagger(0.5, 10);
  for (let i = 0; i < 6; i++) {
    staggered.move(vec(1, 0));
    control.move(vec(1, 0));
  }
  check("control moved forward", control.pos.x > 0, `x=${control.pos.x.toFixed(2)}`);
  check("staggered moved LESS", staggered.pos.x < control.pos.x, `st=${staggered.pos.x.toFixed(2)} ctl=${control.pos.x.toFixed(2)}`);
  check("staggered moved ~half as far (mul 0.5)", near(staggered.pos.x, control.pos.x * 0.5, 1e-6),
    `ratio=${(staggered.pos.x / control.pos.x).toFixed(3)}`);
  // The whole point: inaccuracy reads the SAME speed, so no accuracy is gained.
  check("inaccuracy speed identical (no accuracy from stagger)", near(staggered.speed, control.speed),
    `st=${staggered.speed.toFixed(4)} ctl=${control.speed.toFixed(4)}`);
  check("speedRatio identical too", near(staggered.speedRatio, control.speedRatio));
}

// --------------------------------------------- expiry via tickStatus -----------
console.log("stagger counts down and expires:");
{
  const c = player();
  c.applyStagger(0.3, 3);
  check("staggered now", c.staggerTicks === 3 && c.staggerMul === 0.3);
  c.tickStatus();
  c.tickStatus();
  check("still staggered after 2 ticks", c.staggerTicks === 1);
  c.tickStatus();
  check("expired after the 3rd tick", c.staggerTicks === 0 && c.staggerMul === 1);
  // Post-expiry movement is full again.
  const ctl = player();
  for (let i = 0; i < 4; i++) {
    c.move(vec(1, 0));
    ctl.move(vec(1, 0));
  }
  check("moves at full speed once expired", near(c.pos.x, ctl.pos.x, 1e-6));
}

// --------------------------------------------- non-stacking --------------------
console.log("staggers don't stack — a fresh hit refreshes, never compounds:");
{
  const c = player();
  c.applyStagger(0.5, 20);
  c.applyStagger(0.5, 20); // a second simultaneous pellet/ray
  check("mul stays 0.5, not 0.25 (no compounding)", c.staggerMul === 0.5, `mul=${c.staggerMul}`);
  check("ticks refreshed, not summed", c.staggerTicks === 20, `ticks=${c.staggerTicks}`);
}

// --------------------------------------------- bullet applies its stagger ------
console.log("a bullet carries + applies its gun's stagger to the body it strikes:");
{
  const w = world();
  const target = dummy(300, 0);
  // AK47 (no stagger) -> nothing applied.
  spawnBullet(w, vec(0, 0), vec(1, 0), 60, 20, 0, null, AK47.damage, 3, 200, "#fff", AK47.armorPen, 0, AK47.stagger);
  for (let i = 0; i < 20 && w.bullets.length; i++) updateBullets(w, [target as unknown as Hittable]);
  check("plain bullet: target took damage", target.dmg > 0);
  check("plain bullet: no stagger applied (AK has none)", target.stTicks === 0 && target.stMul === 1);

  // A staggering bullet applies mul/ticks on hit.
  const t2 = dummy(300, 0);
  spawnBullet(w, vec(0, 0), vec(1, 0), 60, 20, 0, null, 25, 3, 200, "#fff", AK47.armorPen, 0, { mul: 0.4, ticks: 33 });
  for (let i = 0; i < 20 && w.bullets.length; i++) updateBullets(w, [t2 as unknown as Hittable]);
  check("staggering bullet: target hit", t2.dmg > 0);
  check("staggering bullet: stagger applied", t2.stMul === 0.4 && t2.stTicks === 33, `mul=${t2.stMul} ticks=${t2.stTicks}`);
}

// --------------------------------------------- player-equivalent, end to end --
console.log("a real Character (exactly what the player is) is staggered by a hit and then walks slower:");
{
  // The player in game.ts is `new Character(...)`, moved with Character.move(),
  // ticked with tickStatus(), and passed to updateBullets as a hit target — the
  // same three touchpoints exercised here, so this IS the player's path.
  const w = world();
  const victim = player();
  const control = player();
  victim.pos = vec(300, 0);
  control.pos = vec(300, 0);
  spawnBullet(w, vec(0, 0), vec(1, 0), 60, 20, 0, null, 25, 3, 200, "#fff", AK47.armorPen, 0, { mul: 0.4, ticks: 30 });
  for (let i = 0; i < 20 && w.bullets.length; i++) {
    updateBullets(w, [victim, control] as unknown as Hittable[]);
  }
  check("the hit staggered the struck Character", victim.staggerTicks === 30 && victim.staggerMul === 0.4);
  check("the bystander Character was not staggered", control.staggerTicks === 0 && control.staggerMul === 1);
  const vx0 = victim.pos.x,
    cx0 = control.pos.x;
  for (let i = 0; i < 5; i++) {
    victim.move(vec(1, 0));
    control.move(vec(1, 0));
  }
  const vMoved = victim.pos.x - vx0;
  const cMoved = control.pos.x - cx0;
  check("staggered Character walks slower", vMoved < cMoved, `moved ${vMoved.toFixed(2)} vs ${cMoved.toFixed(2)}`);
  check("...and is no more accurate (speed unaffected)", near(victim.speed, control.speed));
  // tickStatus (run for every character each frame, player included) counts it down.
  for (let i = 0; i < 30; i++) victim.tickStatus();
  check("stagger expires under tickStatus", victim.staggerTicks === 0 && victim.staggerMul === 1);
}

// --------------------------------------------- explosion staggers all damaged --
console.log("an explosion staggers everyone it damaged — and only them:");
{
  const R = 300;
  const st = { mul: 0.35, ticks: 60 };
  const centre = dummy(0, 0); // full damage
  const edge = dummy(R + 100, 0); // beyond radius -> no damage, no stagger
  const behindWall = dummy(200, 0); // damaged? blocked by a wall -> v=0, no damage
  const wall = makeWall(vec(120, 0), 20, 400, 0); // between blast and behindWall
  const w = world([wall]);
  explode(w, vec(0, 0), 0, 120, R, RPG.armorPen, null, [centre, edge, behindWall], RPG.projectile!.explosion, st);
  check("centre was damaged", centre.dmg > 0);
  check("centre staggered", centre.stMul === 0.35 && centre.stTicks === 60);
  check("out-of-range took no damage", edge.dmg === 0);
  check("out-of-range NOT staggered", edge.stTicks === 0 && edge.stMul === 1);
  check("fully-shielded took no damage", behindWall.dmg === 0);
  check("fully-shielded NOT staggered", behindWall.stTicks === 0 && behindWall.stMul === 1);
}

// --------------------------------------------- spec wiring ---------------------
console.log("spec wiring:");
{
  check("RPG has a stagger", !!RPG.stagger && RPG.stagger.mul < 1 && RPG.stagger.ticks > 0);
  check("AK47 has no stagger", AK47.stagger === undefined);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
