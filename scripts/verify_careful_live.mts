/**
 * Does `careful` hold up in a real match? scripts/verify_careful.mts asks the
 * predicate; scripts/verify_careful_e2e.mts fires rounds at a fixed pose. This
 * one runs an actual Game with every bot carrying a careful launcher and watches
 * where the rockets really go — intercepting Gun.fire, so the shot recorded is
 * the one the gate just approved, taken at whatever speed the bot happened to be
 * moving.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_careful_live.mts --bundle
 *   --platform=node --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vcl.mjs && node <tmp>/vcl.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Gun } from "../src/entities/gun.ts";
import { losClear } from "../src/world/world.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { norm, add, scale, dist } from "../src/engine/vec.ts";

const LEVEL = process.argv[2] ?? "desert-teamfight-tac-3";
const TICKS = Number(process.argv[3] ?? 12000);
const GUN = "RPG";

// Every bot gets the careful launcher, so every shot fired is a gated shot.
const text = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8").replace(
  /"gun":"[A-Za-z0-9_]+"/g,
  `"gun":"${GUN}"`,
);
const state = loadLevel(text);
const mode = state.meta.mode ?? DEFAULT_MODE;
const game = new Game(state, GAMEMODES[mode]({ ...state.meta, mode }));

const stat = { shots: 0, moving: 0, wall: 0, mate: 0, splash: 0, worstDeg: 0, worstSpeed: 0 };
const rad2deg = (r: number) => (r * 180) / Math.PI;

const realFire = Gun.prototype.fire;
Gun.prototype.fire = function (world: any, origin: any, forward: any, owner: any, speedRatio: number) {
  if (!this.spec.careful) return realFire.call(this, world, origin, forward, owner, speedRatio);
  const before = world.projectiles.length;
  const out = realFire.call(this, world, origin, forward, owner, speedRatio);
  if (!out || world.projectiles.length === before) return out;

  const p: any = world.projectiles[world.projectiles.length - 1];
  const dir = norm(p.vel);
  stat.shots++;
  if (speedRatio > 0.01) stat.moving++;
  stat.worstSpeed = Math.max(stat.worstSpeed, speedRatio);
  let off = Math.abs(Math.atan2(dir.y, dir.x) - Math.atan2(forward.y, forward.x));
  if (off > Math.PI) off = 2 * Math.PI - off;
  stat.worstDeg = Math.max(stat.worstDeg, rad2deg(off));

  // How far the round actually gets before something stops it, and what it meets.
  const reach = this.spec.fire.bulletSpeed * this.spec.fire.bulletLife;
  const end = add(origin, scale(dir, reach));
  if (!losClear(world, origin, end, owner.z)) {
    // A wall somewhere down the true path — only counts as a clip if it is
    // nearer than the bot's target, i.e. the round dies before it arrives.
    const tgt = (owner as any).lastTarget;
    if (tgt && tgt.hp > 0) {
      const toTgt = add(origin, scale(dir, dist(origin, tgt.pos)));
      if (!losClear(world, origin, toTgt, owner.z)) stat.wall++;
    }
  }
  for (const c of game.characters as any[]) {
    if (c === owner || c.hp <= 0 || c.z !== owner.z) continue;
    if (c.team !== owner.team) continue;
    const t = (c.pos.x - origin.x) * dir.x + (c.pos.y - origin.y) * dir.y;
    if (t <= 0 || t > reach) continue;
    const ex = c.pos.x - (origin.x + dir.x * t), ey = c.pos.y - (origin.y + dir.y * t);
    if (Math.hypot(ex, ey) < BODY_RADIUS + (this.spec.projectile?.bodyRadius ?? 0)) { stat.mate++; break; }
  }
  // Splash: the gate vets a 60px-wide corridor to the target, but the warhead
  // has a 250px blast. A mate standing well clear of the line still eats it.
  const blast = this.spec.projectile?.radius ?? 0;
  const tgt = (owner as any).lastTarget;
  if (blast > 0 && tgt && tgt.hp > 0) {
    for (const c of game.characters as any[]) {
      if (c === owner || c.hp <= 0 || c.z !== owner.z || c.team !== owner.team) continue;
      if (dist(c.pos, tgt.pos) < blast) { stat.splash++; break; }
    }
  }
  return out;
};

for (let i = 0; i < TICKS; i++) game.update();
Gun.prototype.fire = realFire;

const pct = (n: number) => `${((n / Math.max(1, stat.shots)) * 100).toFixed(1)}%`;
console.log(`level ${LEVEL}, ${TICKS} ticks, every bot on ${GUN}`);
console.log(`  careful shots taken:        ${stat.shots}`);
console.log(`  fired while moving:         ${stat.moving}  (${pct(stat.moving)})   worst speedRatio ${stat.worstSpeed.toFixed(2)}`);
console.log(`  worst deflection from the vetted heading: ${stat.worstDeg.toFixed(2)}°`);
console.log(`  rounds that hit a wall short of the target: ${stat.wall}  (${pct(stat.wall)})`);
console.log(`  rounds whose path passed through a teammate: ${stat.mate}  (${pct(stat.mate)})`);
console.log(`  shots with a teammate inside the blast radius of the aim point: ${stat.splash}  (${pct(stat.splash)})`);
