/**
 * Verifies the `careful` firing gate (RPG et al.): a careful weapon holds fire
 * unless (1) the muzzle is settled inside a TIGHT aim cone on the jittered aim
 * point, and (2) an actual raycast down the true heading is clear of walls and
 * teammates out to the target — while a non-careful gun keeps its loose cone and
 * center-line-only lane check (so it happily grazes a corner). No self-blast veto.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_careful.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vc.mjs && node <tmp>/vc.mjs
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { RPG, AWM, UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall as mkWall, type World } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { norm, sub, vec, deg2rad, add, scale, fromAngle, angleOf } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};

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
    particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
  };
  if (obstacles.length) w.grid = new ObstacleGrid(obstacles);
  return w;
}

/** Build a bot holding `spec`, aimed at `aimPt`, with all the transient combat
 *  state a fire decision reads set to "ready". */
function armedBot(spec: any, at: any, aimPt: any): TacOracle {
  const bot = new TacOracle(vec(at.x, at.y), { team: "blue", z: 0, realGun: true, stagger: 5 });
  (bot as any).slots.primary = new Gun(spec);
  bot.equip("primary");
  bot.z = 0;
  bot.forward = norm(sub(aimPt, bot.pos));
  const any = bot as any;
  any.mode = "shoot";
  any.fireOk = true;
  any.burstDone = false;
  any.clickIn = 0;
  any.aimError = vec(0, 0);
  return bot;
}

const enemy = (x: number, y: number): Character => {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "red";
  c.z = 0;
  return c;
};
const mate = (x: number, y: number): Character => {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "blue";
  c.z = 0;
  return c;
};
const ctx = (w: World, chars: Character[]): AiContext =>
  ({ world: w, characters: chars, nav: undefined, tick: 0 } as any);
const fires = (bot: TacOracle, ai: AiContext, t: Character): boolean =>
  (bot as any).shouldFire(ai, t);

// -------------------------------------------------- baseline: open lane --------
console.log("open lane, dead-on aim — everyone fires:");
{
  const w = world();
  const t = enemy(600, 0);
  const rpg = armedBot(RPG, vec(0, 0), t.pos);
  check("careful RPG fires with a clear lane", fires(rpg, ctx(w, [rpg, t]), t));
  const awm = armedBot(AWM, vec(0, 0), t.pos);
  check("non-careful AWM fires with a clear lane", fires(awm, ctx(w, [awm, t]), t));
}

// -------------------------------------------------- wall in the muzzle line ----
console.log("a wall sits between the muzzle and the target:");
{
  const wall = mkWall(vec(150, 0), 20, 400, 0); // vertical wall at x=150
  const w = world([wall]);
  const t = enemy(300, 0);
  const rpg = armedBot(RPG, vec(0, 0), t.pos);
  check("careful RPG HOLDS fire (won't clip the wall)", !fires(rpg, ctx(w, [rpg, t]), t));
  // Same geometry, a non-careful heavy gun still fires — proving `careful` is the
  // thing that changed, not the scenario (laneClear ignores walls entirely).
  const awm = armedBot(AWM, vec(0, 0), t.pos);
  check("non-careful AWM still fires (grazes the corner — the 'feature')", fires(awm, ctx(w, [awm, t]), t));
}

// -------------------------------------------------- teammate in the heading ----
console.log("a teammate stands in the muzzle line:");
{
  const w = world();
  const t = enemy(600, 0);
  const friend = mate(200, 0); // dead ahead, between bot and target
  const rpg = armedBot(RPG, vec(0, 0), t.pos);
  check("careful RPG HOLDS fire (mate in the line)", !fires(rpg, ctx(w, [rpg, t, friend]), t));
  // Move the mate well off the line: the shot is clear again.
  const friend2 = mate(200, 300);
  const rpg2 = armedBot(RPG, vec(0, 0), t.pos);
  check("careful RPG fires once the mate is clear of the line", fires(rpg2, ctx(w, [rpg2, t, friend2]), t));
}

// -------------------------------------------------- tighter aim cone -----------
console.log("muzzle off-axis but lane clear — tight cone gates the careful gun:");
{
  const w = world();
  const t = enemy(2000, 0); // far, so aimWidth() is tiny and the FLOOR decides
  // Point the muzzle 8° off the target: inside the 15° default cone, outside the
  // 4° careful cone.
  const off = armedBot(RPG, vec(0, 0), t.pos);
  off.forward = fromAngle(angleOf(sub(t.pos, off.pos)) + deg2rad(8));
  check("careful RPG HOLDS fire at 8° off (tight 4° cone)", !fires(off, ctx(w, [off, t]), t));
  const offAwm = armedBot(AWM, vec(0, 0), t.pos);
  offAwm.forward = fromAngle(angleOf(sub(t.pos, offAwm.pos)) + deg2rad(8));
  check("non-careful AWM fires at 8° off (loose 15° cone)", fires(offAwm, ctx(w, [offAwm, t]), t));
  // Dead-on, the careful gun fires.
  const on = armedBot(RPG, vec(0, 0), t.pos);
  check("careful RPG fires when settled dead-on", fires(on, ctx(w, [on, t]), t));
}

// -------------------------------------------------- must be standing still ----
// The clearance check vets `forward`, but the round leaves along
// rotate(forward, shoot(speedRatio)) — a launcher's moving-first-shot recoil
// throws that ~20 degrees at half speed, which no corridor check can cover. So a
// careful gun holds fire until the shooter has actually stopped.
console.log("shooter still moving — the careful gun waits for it to stop:");
{
  const w = world();
  const t = enemy(600, 0);
  const rolling = armedBot(RPG, vec(0, 0), t.pos);
  rolling.vel = vec(2, 0); // mid-stride, lane and cone both perfect
  check("careful RPG HOLDS fire while the shooter is moving", !fires(rolling, ctx(w, [rolling, t]), t));
  rolling.vel = vec(0, 0);
  check("careful RPG fires once it has stopped", fires(rolling, ctx(w, [rolling, t]), t));
  // A non-careful gun is unaffected — this gate is the careful flag's, not a
  // blanket "no shooting on the move" rule.
  const moving = armedBot(AWM, vec(0, 0), t.pos);
  moving.vel = vec(2, 0);
  check("non-careful AWM still fires on the move", fires(moving, ctx(w, [moving, t]), t));
}

// -------------------------------------------------- spec flag ------------------
console.log("spec wiring:");
{
  check("RPG is marked careful", RPG.careful === true);
  check("AWM is not careful", !AWM.careful);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
