/**
 * Verifies the new projectile / explosion system and the RPG launcher end-to-end,
 * plus the hostile-only kill-credit rule's underlying predicate. Uses lightweight
 * fake Hittables for the blast math and a real ObstacleGrid for wall shielding,
 * then fires a real Gun(RPG) and runs a real Game headless with live rockets.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_projectiles.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vp.mjs && node <tmp>/vp.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import {
  explode,
  spawnProjectile,
  updateProjectiles,
  makeWall,
  type Hittable,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { Gun } from "../src/entities/gun.ts";
import { RPG } from "../src/entities/guns.ts";
import { areHostile } from "../src/entities/team.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

function dummy(x: number, y: number, z = 0) {
  return {
    pos: vec(x, y),
    z,
    dmg: 0,
    attacker: undefined as Hittable | null | undefined,
    registerHit(_dir: any, _pt: any, damage: number, _ap: any, attacker: Hittable | null) {
      this.dmg += damage;
      this.attacker = attacker;
    },
  };
}

function emptyWorld(obstacles: any[] = []): World {
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

// ---------------------------------------------------------------- explode -----
console.log("explode() — range falloff (open field = full 9/9 coverage), full FF:");
{
  const R = 150,
    D = 100;
  const center = dummy(0, 0);
  const edgeOfBody = dummy(30, 0); // edge = max(0, 30-30) = 0 -> full
  const half = dummy(105, 0); // edge = 105-30 = 75 -> frac .5
  const atRadius = dummy(180, 0); // edge = 150 = radius -> discarded before raycasting
  const outside = dummy(240, 0); // beyond radius+body -> no hit
  const owner = dummy(40, 0); // the shooter, inside the blast
  const teammate = dummy(-50, 0);
  const targets = [center, edgeOfBody, half, atRadius, outside, owner, teammate];
  explode(emptyWorld(), vec(0, 0), 0, D, R, RPG.armorPen, owner, targets);
  check("centre takes full damage", near(center.dmg, 100), `dmg=${center.dmg}`);
  check("body-edge-at-centre full", near(edgeOfBody.dmg, 100), `dmg=${edgeOfBody.dmg}`);
  check("mid-radius ~half damage", near(half.dmg, 50), `dmg=${half.dmg}`);
  check("at radius: no damage", atRadius.dmg === 0, `dmg=${atRadius.dmg}`);
  check("outside radius: no damage", outside.dmg === 0, `dmg=${outside.dmg}`);
  check("OWNER is hit (full FF, self-damage)", owner.dmg > 0, `dmg=${owner.dmg}`);
  check("teammate is hit (full FF)", teammate.dmg > 0, `dmg=${teammate.dmg}`);
  check("attacker credited to shooter", center.attacker === (owner as unknown as Hittable));
}

// wrong-z is untouched
{
  const upstairs = dummy(0, 0, 1);
  explode(emptyWorld(), vec(0, 0), 0, 100, 150, RPG.armorPen, null, [upstairs]);
  check("different-z body untouched", upstairs.dmg === 0);
}

// ------------------------------------------------------------ wall shield -----
console.log("explode() — a solid wall shields the blast:");
{
  const wall = makeWall(vec(100, 0), 20, 400, 0); // vertical wall at x=100
  const w = emptyWorld([wall]);
  const behind = dummy(200, 0); // wall between blast(0,0) and it
  const open = dummy(0, 160); // clear line
  explode(w, vec(0, 0), 0, 100, 300, RPG.armorPen, null, [behind, open]);
  check("body behind a wall: shielded", behind.dmg === 0, `dmg=${behind.dmg}`);
  check("body in the open: hit", open.dmg > 0, `dmg=${open.dmg}`);
}

// --------------------------------------------------------- partial cover (v/9) -
console.log("explode() — partial cover scales damage by the visible fraction:");
{
  const R = 300,
    D = 100;
  // Open target: all 9 rays clear -> full range-falloff damage.
  const openT = dummy(200, 0);
  explode(emptyWorld(), vec(0, 0), 0, D, R, RPG.armorPen, null, [openT]);
  const full = openT.dmg; // 100 * (1 - (200-30)/300) * 1 = 43.3
  check("open target: full (v=9) damage", near(full, 43.33, 0.1), `dmg=${full.toFixed(1)}`);

  // A wall over the +y half of the silhouette blocks some rays, not all.
  const halfWall = makeWall(vec(170, 155), 20, 290, 0); // x∈[160,180], y∈[10,300]
  const partial = dummy(200, 0);
  explode(emptyWorld([halfWall]), vec(0, 0), 0, D, R, RPG.armorPen, null, [partial]);
  check("partial cover: 0 < dmg < full", partial.dmg > 0 && partial.dmg < full, `dmg=${partial.dmg.toFixed(1)}`);
  // dmg/full == v/9 exactly (both share the range falloff), so this pins the
  // damage to a whole visible-ray count in 1..8 without hardcoding which.
  const v = (partial.dmg / full) * 9;
  check("damage is a whole v/9 fraction (1..8 rays)", near(v, Math.round(v), 1e-6) && Math.round(v) >= 1 && Math.round(v) <= 8, `v=${v.toFixed(3)}`);

  // A wall across the whole silhouette blocks all 9 rays: nothing gets through.
  const bigWall = makeWall(vec(100, 0), 20, 600, 0);
  const covered = dummy(200, 0);
  explode(emptyWorld([bigWall]), vec(0, 0), 0, D, R, RPG.armorPen, null, [covered]);
  check("fully behind cover: no damage (v=0)", covered.dmg === 0, `dmg=${covered.dmg}`);
}

// -------------------------------------------------------- updateProjectiles ---
console.log("updateProjectiles() — impact, airburst, owner pass-through:");
{
  const w = emptyWorld();
  const owner = dummy(0, 0);
  const target = dummy(480, 0);
  spawnProjectile(w, vec(0, 0), vec(1, 0), 24, 70, 0, owner as any, 95, 150, RPG.armorPen, 9, "#fff", "#fa0", 0);
  let ticks = 0;
  while (w.projectiles.length && ticks < 200) {
    updateProjectiles(w, [owner, target]);
    ticks++;
  }
  check("projectile detonated (consumed)", w.projectiles.length === 0, `ticks=${ticks}`);
  check("target hit by the blast", target.dmg > 0, `dmg=${target.dmg.toFixed(1)}`);
  check("owner (far away) unhurt", owner.dmg === 0, `dmg=${owner.dmg}`);
  check("blast attributed to owner", target.attacker === (owner as unknown as Hittable));
}
{
  // airburst: nothing to hit; must detonate at end of life near its final pos
  const w = emptyWorld();
  const bystander = dummy(24 * 5, 0); // sits where the round will be at life's end
  spawnProjectile(w, vec(0, 0), vec(1, 0), 24, 5, 0, null, 95, 150, RPG.armorPen, 9, "#fff", "#fa0", 0);
  for (let i = 0; i < 6; i++) updateProjectiles(w, [bystander]);
  check("airburst at max range consumed", w.projectiles.length === 0);
  check("airburst damages a body at the burst point", bystander.dmg > 0, `dmg=${bystander.dmg.toFixed(1)}`);
}
{
  // wall impact
  const wall = makeWall(vec(300, 0), 40, 400, 0); // wall spans x∈[280,320]
  const w = emptyWorld([wall]);
  const near2 = dummy(235, 55); // in front of the wall, clear LoS to the impact point, off the flight path
  spawnProjectile(w, vec(0, 0), vec(1, 0), 24, 70, 0, null, 95, 150, RPG.armorPen, 9, "#fff", "#fa0", 0);
  let ticks = 0;
  while (w.projectiles.length && ticks < 200) {
    updateProjectiles(w, [near2]);
    ticks++;
  }
  check("projectile detonated on the wall", w.projectiles.length === 0, `ticks=${ticks}`);
  check("body beside the wall impact hit", near2.dmg > 0, `dmg=${near2.dmg.toFixed(1)}`);
}

// ------------------------------------------------------------- Gun(RPG) -------
console.log("Gun(RPG).fire() — spawns a projectile, feasibleRange correct:");
{
  const gun = new Gun(RPG);
  gun.fireCooldown = 0;
  gun.drawTicks = 0;
  const w = emptyWorld();
  const owner = dummy(0, 0);
  const fired = gun.fire(w, vec(0, 0), vec(1, 0), owner as any, 0);
  check("fire() returned true", fired === true);
  check("one projectile spawned (not a bullet)", w.projectiles.length === 1 && w.bullets.length === 0);
  const p = w.projectiles[0];
  check("blast damage from spec", p && p.damage === RPG.damage, `dmg=${p?.damage}`);
  check("blast radius from spec", p && p.radius === RPG.projectile!.radius, `r=${p?.radius}`);
  check("blast visuals carried from spec", p && p.explosion === RPG.projectile!.explosion, `explosion=${!!p?.explosion}`);
  check("travel speed from FireSpec", p && near(Math.hypot(p.vel.x, p.vel.y), RPG.fire!.bulletSpeed, 1e-9));
  check("feasibleRange = speed*life", gun.feasibleRange === RPG.fire!.bulletSpeed * RPG.fire!.bulletLife,
    `range=${gun.feasibleRange}`);
  check("mag drained to 0", gun.mag === 0);
  check("RPG registered as a placeable spec", !!RPG.icon);
}

// ---------------------------------------------------- kill-credit predicate ---
console.log("hostile-only kill-credit predicate (areHostile):");
{
  check("enemy kill counts (blue vs red)", areHostile("blue", "red") === true);
  check("friendly-fire does NOT count (blue vs blue)", areHostile("blue", "blue") === false);
  check("self-kill does NOT count (red vs red)", areHostile("red", "red") === false);
}

// ------------------------------------------------- full-game integration ------
console.log("headless Game with live rockets injected (no crash, rockets resolve):");
{
  const text = readFileSync("src/world/levels/dom-arena-big.json", "utf8");
  const loaded = loadLevel(text);
  const game = new Game(loaded, GAMEMODES.domination({ ...loaded.meta, mode: "domination" }));
  let injected = 0,
    maxAlive = 0;
  for (let t = 0; t < 600; t++) {
    game.update();
    // periodically lob rockets from the arena centre in the four directions
    if (t % 40 === 0) {
      for (const d of [vec(1, 0), vec(-1, 0), vec(0, 1), vec(0, -1)]) {
        spawnProjectile(game.world, vec(0, 0), d, 24, 70, 0, null, 95, 150, RPG.armorPen, 9, "#fff", "#fa0", 0);
        injected++;
      }
    }
    maxAlive = Math.max(maxAlive, game.world.projectiles.length);
  }
  check("game ran 600 ticks with injected rockets", true, `injected=${injected}`);
  check("rockets are being consumed (not leaking)", game.world.projectiles.length < injected, `alive=${game.world.projectiles.length}, maxAlive=${maxAlive}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
