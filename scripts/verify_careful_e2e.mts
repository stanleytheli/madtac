/**
 * End-to-end check of the `careful` gate: scripts/verify_careful.mts only asks
 * the PREDICATE (shouldFire) its opinion, with aimError zeroed and the muzzle
 * perfectly settled. This one takes the shots — when the gate says "fire", it
 * runs the real Gun.fire path and looks at where the round actually went.
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN, BODY_RADIUS } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { RPG, UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall as mkWall, type World } from "../src/world/world.ts";
import { losClear } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { norm, sub, vec, add, scale, dist } from "../src/engine/vec.ts";

function world(obstacles: any[] = []): World {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], events: [],
  } as any;
  if (obstacles.length) (w as any).grid = new ObstacleGrid(obstacles);
  return w;
}
function armedBot(spec: any, at: any, aimPt: any): TacOracle {
  const bot = new TacOracle(vec(at.x, at.y), { team: "blue", z: 0, realGun: true, stagger: 5 });
  (bot as any).slots.primary = new Gun(spec);
  bot.equip("primary");
  bot.z = 0;
  bot.forward = norm(sub(aimPt, bot.pos));
  const any = bot as any;
  any.mode = "shoot"; any.fireOk = true; any.burstDone = false;
  any.clickIn = 0; any.aimError = vec(0, 0);
  return bot;
}
const chr = (x: number, y: number, team: string): Character => {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = team as any; c.z = 0;
  return c;
};
const ctx = (w: World, chars: Character[]): AiContext =>
  ({ world: w, characters: chars, nav: undefined, tick: 0 } as any);

/** Fire one round through the real path; return the direction it actually took. */
function shoot(bot: TacOracle, w: World, speedRatio: number): { x: number; y: number } | null {
  w.projectiles.length = 0;
  const g = (bot as any).gun as Gun;
  g.fireCooldown = 0; g.mag = Math.max(1, g.mag);
  const ok = g.fire(w, bot.pos, bot.forward, bot as any, speedRatio);
  if (!ok || !w.projectiles.length) return null;
  const p: any = w.projectiles[0];
  return norm(p.vel);
}

const N = 400;
const rad2deg = (r: number) => (r * 180) / Math.PI;

console.log("=== 1. corner peek: gate says FIRE, where do the rockets go? ===");
{
  // A wall the bot is peeking past. The true heading to the target clears the
  // corner with ~25px to spare — the gate's centre ray + 9px rails are happy.
  const wall = mkWall(vec(300, -170), 40, 300, 0); // spans y -320..-20 at x 280..320
  const w = world([wall]);
  const t = chr(900, 0, "red");
  const bot = armedBot(RPG, vec(0, 0), t.pos);
  const ai = ctx(w, [bot, t]);
  const gateSaysFire = (bot as any).shouldFire(ai, t);
  console.log(`  gate: shouldFire = ${gateSaysFire}`);
  for (const [label, speed] of [["planted (speedRatio 0)", 0], ["moving (speedRatio 1)", 1]] as [string, number][]) {
    let clipped = 0, worst = 0;
    for (let i = 0; i < N; i++) {
      const bot2 = armedBot(RPG, vec(0, 0), t.pos);
      const d = shoot(bot2, w, speed);
      if (!d) continue;
      const reach = dist(bot2.pos, t.pos);
      const end = add(bot2.pos, scale(d, reach));
      const off = rad2deg(Math.abs(Math.atan2(d.y, d.x) - Math.atan2(bot2.forward.y, bot2.forward.x)));
      worst = Math.max(worst, off);
      if (!losClear(w, bot2.pos, end, 0)) clipped++;
    }
    console.log(`  ${label}: ${clipped}/${N} rockets hit the wall (${((clipped / N) * 100).toFixed(1)}%), worst deflection ${worst.toFixed(2)}°`);
  }
}

console.log("\n=== 2. teammate just outside the vetted corridor ===");
{
  const w = world();
  const t = chr(900, 0, "red");
  // FRIENDLY_MARGIN is 60. Put the mate 70px off the line: the gate is satisfied.
  const friend = chr(450, 70, "blue");
  const bot = armedBot(RPG, vec(0, 0), t.pos);
  const ai = ctx(w, [bot, t, friend]);
  console.log(`  gate: shouldFire = ${(bot as any).shouldFire(ai, t)}  (mate 70px off the line, margin ${BODY_RADIUS * 2})`);
  for (const [label, speed] of [["planted", 0], ["moving", 1]] as [string, number][]) {
    let hit = 0;
    for (let i = 0; i < N; i++) {
      const bot2 = armedBot(RPG, vec(0, 0), t.pos);
      const d = shoot(bot2, w, speed);
      if (!d) continue;
      // Perpendicular distance from the mate to the round's actual path.
      const tt = ((friend.pos.x - bot2.pos.x) * d.x + (friend.pos.y - bot2.pos.y) * d.y);
      const px = bot2.pos.x + d.x * tt, py = bot2.pos.y + d.y * tt;
      const miss = Math.hypot(friend.pos.x - px, friend.pos.y - py);
      if (tt > 0 && miss < BODY_RADIUS + 9) hit++; // body + rocket hull
    }
    console.log(`  ${label}: ${hit}/${N} rockets pass through the mate's body (${((hit / N) * 100).toFixed(1)}%)`);
  }
}

console.log("\n=== 3. blast radius vs the vetted corridor ===");
{
  const w = world();
  const t = chr(900, 0, "red");
  const friend = chr(880, 120, "blue"); // 120px from the impact point
  const bot = armedBot(RPG, vec(0, 0), t.pos);
  const ai = ctx(w, [bot, t, friend]);
  console.log(`  gate: shouldFire = ${(bot as any).shouldFire(ai, t)}`);
  console.log(`  mate is ${dist(friend.pos, t.pos).toFixed(0)}px from the aim point; RPG blast radius = ${RPG.projectile!.radius}`);
}

console.log("\n=== 4. does the gate even run for non-TacOracle AI? ===");
{
  console.log("  Robot.shouldFire / Oracle: no override — see src/ai/robot.ts:315 (`return target !== null`)");
  console.log("  careful is implemented only in TacOracle.shouldFire (src/ai/tacoracle.ts:1651)");
}
