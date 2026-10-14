/**
 * Verifies the vehicle system end-to-end, headless:
 *   - driving physics (throttle drives along the hull's facing; car can't turn at
 *     rest, tank pivots in place)
 *   - vehicle-vs-wall collision (no tunneling through a static wall)
 *   - rounds vs hulls: an enclosed occupant is bulletproof; an exposed one is hit;
 *     an occupant's own round clears its own hull; blast is shielded by a hull
 *   - turret fires from a muzzle OUTSIDE the hull
 *   - CCH: a vehicle parked over a nav link blocks it (sparse update == full
 *     rebuild), driving off restores it, and an open-ground vehicle blocks nothing
 *   - enter/exit clip-safety: exiting beside a wall never lands inside it
 *   - full-Game integration: a vehicle driven 600 ticks, no throw / no tunnel
 *
 * Run: node_modules/.bin/esbuild scripts/verify_vehicles.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vv.mjs && node <tmp>/vv.mjs
 */
import { loadLevel } from "../src/world/level.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import { Vehicle } from "../src/entities/vehicle.ts";
import { JEEP, TANK } from "../src/entities/vehicles.ts";
import { NavGraph } from "../src/world/nav.ts";
import {
  explode,
  losClear,
  makeNode,
  makeWall,
  updateBullets,
  updateProjectiles,
  vehicleBlocksSegment,
  type Hittable,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid, pointInBox, resolveCircleVsBox } from "../src/engine/collision.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { RPG } from "../src/entities/guns.ts";
import { dist, vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};
const near = (a: number, b: number, eps = 1): boolean => Math.abs(a - b) <= eps;

function emptyWorld(obstacles: any[] = [], vehicles: Vehicle[] = []): World {
  const w: World = {
    obstacles,
    floors: [],
    stairs: [],
    nodes: [],
    items: [],
    vehicles,
    bullets: [],
    projectiles: [],
    particles: [], decals: [], scorches: [], events: [],
  };
  w.grid = new ObstacleGrid(obstacles);
  return w;
}

function dummy(x: number, y: number, z = 0) {
  return {
    pos: vec(x, y),
    z,
    dmg: 0,
    registerHit(_dir: any, _pt: any, damage: number) {
      this.dmg += damage;
    },
  };
}

// ------------------------------------------------------------ physics ---------
console.log("driving physics:");
{
  const w = emptyWorld();
  const jeep = new Vehicle(JEEP, vec(0, 0), 0, 0);
  jeep.throttle = 1;
  for (let i = 0; i < 40; i++) jeep.drive(w, null);
  check("throttle drives forward along facing (+x at angle 0)", jeep.pos.x > 50 && near(jeep.pos.y, 0, 1), `pos=(${jeep.pos.x.toFixed(0)},${jeep.pos.y.toFixed(0)})`);
  check("speed capped at maxSpeed", jeep.speed <= JEEP.maxSpeed + 1e-6, `speed=${jeep.speed.toFixed(2)}`);
}
{
  const w = emptyWorld();
  const car = new Vehicle(JEEP, vec(0, 0), 0, 0);
  car.steer = 1; // no throttle: a car can't turn standing still
  for (let i = 0; i < 40; i++) car.drive(w, null);
  check("car does NOT turn at rest", near(car.angle, 0, 1e-6), `angle=${car.angle.toFixed(3)}`);
  car.throttle = 1;
  for (let i = 0; i < 40; i++) car.drive(w, null);
  check("car turns once moving", Math.abs(car.angle) > 0.1, `angle=${car.angle.toFixed(3)}`);

  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  tank.steer = 1; // tank pivots in place
  for (let i = 0; i < 40; i++) tank.drive(w, null);
  check("tank pivots in place (turnAtRest)", Math.abs(tank.angle) > 0.1, `angle=${tank.angle.toFixed(3)}`);
}

// ---------------------------------------------------- wall collision ----------
console.log("vehicle vs static wall (no tunneling):");
{
  const wall = makeWall(vec(300, 0), 40, 400, 0); // wall spans x∈[280,320]
  const w = emptyWorld([wall]);
  const jeep = new Vehicle(JEEP, vec(0, 0), 0, 0);
  jeep.throttle = 1;
  let crossed = false;
  for (let i = 0; i < 300; i++) {
    jeep.drive(w, null);
    if (jeep.pos.x > 320) crossed = true; // center passed through the wall
  }
  check("jeep never tunnels the wall", !crossed && jeep.pos.x < 300, `pos.x=${jeep.pos.x.toFixed(0)}`);
  check("speed damped against the wall", Math.abs(jeep.speed) < 1, `speed=${jeep.speed.toFixed(2)}`);
}

// ------------------------------------------------------ rounds vs hull --------
console.log("rounds vs hull — enclosed protection, exposed exposure, own-hull skip:");
{
  // TANK hull encloses the driver at its centre.
  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  const w = emptyWorld([], [tank]);
  const occupant = dummy(0, 0); // driver, inside the hull
  const shooter = dummy(-400, 0);
  // Incoming round from outside — must die on the hull.
  w.bullets.push({
    pos: vec(-400, 0), prev: vec(-400, 0), vel: vec(60, 0), z: 0, life: 40,
    origin: vec(-400, 0), renderAfter: 0, owner: shooter as any,
    damage: 50, tracerWidth: 0, tracerLength: 0, tracerColor: "#000", armorPen: RPG.armorPen,
  });
  let t = 0;
  while (w.bullets.length && t < 60) { updateBullets(w, [occupant, shooter] as any); t++; }
  check("incoming round dies on the hull (enclosed occupant unhurt)", occupant.dmg === 0 && w.bullets.length === 0, `dmg=${occupant.dmg}`);
}
{
  // Bidirectional cover: an enclosed occupant's OWN round can't exit its hull
  // either — which is exactly why the tank shoots via a turret muzzle outside it.
  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  const w = emptyWorld([], [tank]);
  const occupant = dummy(0, 0);
  const target = dummy(400, 0);
  w.bullets.push({
    pos: vec(0, 0), prev: vec(0, 0), vel: vec(60, 0), z: 0, life: 40,
    origin: vec(0, 0), renderAfter: 0, owner: occupant as any,
    damage: 50, tracerWidth: 0, tracerLength: 0, tracerColor: "#000", armorPen: RPG.armorPen,
  });
  let t = 0;
  while (w.bullets.length && t < 60) { updateBullets(w, [occupant, target] as any); t++; }
  check("enclosed occupant's own round is blocked by its own hull (bidirectional)", target.dmg === 0 && w.bullets.length === 0, `dmg=${target.dmg}`);
}
{
  // JEEP body is permeable — a passenger there is exposed, and CAN fire out.
  const jeep = new Vehicle(JEEP, vec(0, 0), 0, 0);
  const w = emptyWorld([], [jeep]);
  const seat = jeep.seatWorld(2); // rear bench, clear of the solid front hood
  const exposed = dummy(seat.x, seat.y);
  const shooter = dummy(seat.x, seat.y - 300);
  w.bullets.push({
    pos: vec(seat.x, seat.y - 300), prev: vec(seat.x, seat.y - 300), vel: vec(0, 60), z: 0, life: 40,
    origin: vec(seat.x, seat.y - 300), renderAfter: 0, owner: shooter as any,
    damage: 50, tracerWidth: 0, tracerLength: 0, tracerColor: "#000", armorPen: RPG.armorPen,
  });
  let t = 0;
  while (w.bullets.length && t < 60) { updateBullets(w, [exposed, shooter] as any); t++; }
  check("round passes a permeable body and hits the exposed occupant", exposed.dmg > 0, `dmg=${exposed.dmg}`);

  // And the exposed occupant's OWN round exits through the permeable body.
  const outTarget = dummy(seat.x, seat.y + 400);
  w.bullets.push({
    pos: vec(seat.x, seat.y), prev: vec(seat.x, seat.y), vel: vec(0, 60), z: 0, life: 40,
    origin: vec(seat.x, seat.y), renderAfter: 0, owner: exposed as any,
    damage: 50, tracerWidth: 0, tracerLength: 0, tracerColor: "#000", armorPen: RPG.armorPen,
  });
  t = 0;
  while (w.bullets.length && t < 60) { updateBullets(w, [exposed, outTarget] as any); t++; }
  check("exposed occupant fires out through the permeable body", outTarget.dmg > 0, `dmg=${outTarget.dmg}`);
}

// ---------------------------------------------------- blast shielding ---------
console.log("blast shielding by a hull:");
{
  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  const w = emptyWorld([], [tank]);
  const occupant = dummy(0, 0);
  const openBystander = dummy(-300, 55);
  explode(w, vec(-300, 0), 0, 100, 400, RPG.armorPen, null, [occupant, openBystander] as any);
  check("hull shields the enclosed occupant from the blast", occupant.dmg === 0, `dmg=${occupant.dmg}`);
  check("bystander in the open is hit", openBystander.dmg > 0, `dmg=${openBystander.dmg.toFixed(1)}`);
  check("vehicleBlocksSegment sees the hull", vehicleBlocksSegment([tank], vec(-300, 0), vec(0, 0), 0));
}

// ----------------------------------------------------------- turret -----------
console.log("turret fires from a muzzle outside the hull (clears its own hull):");
{
  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  const w = emptyWorld([], [tank]);
  const driver = dummy(0, 0);
  tank.aimTurret(0, 0); // aim +x
  const fired = tank.fireTurret(0, w, driver as any);
  check("turret fired an RPG projectile", fired && w.projectiles.length === 1, `n=${w.projectiles.length}`);
  const p = w.projectiles[0];
  check("round spawns outside the hull (muzzle beyond the front face)", !!p && p.origin.x > 85, `x=${p?.origin.x.toFixed(0)}`);
  // It must NOT detonate on its own hull — it spawns outside and flies away.
  for (let i = 0; i < 3 && w.projectiles.length; i++) updateProjectiles(w, [driver] as any);
  check("turret round clears its own hull (flies out, no self-detonation)", w.projectiles.length === 1 && w.projectiles[0].pos.x > 85);
}

// -------------------------------------------------- hull blocks sight ---------
console.log("hull blocks line of sight (bidirectional cover / AI treats it as cover):");
{
  const tank = new Vehicle(TANK, vec(0, 0), 0, 0);
  const w = emptyWorld([], [tank]);
  check("sight is blocked THROUGH a hull", losClear(w, vec(-300, 0), vec(300, 0), 0) === false);
  check("sight is clear past the hull", losClear(w, vec(-300, 300), vec(300, 300), 0) === true);
}

// -------------------------------------------------------------- CCH -----------
console.log("CCH: parked vehicle blocks a nav link (sparse update == full rebuild):");
function navWorld(vehicles: Vehicle[]): { world: World; nav: NavGraph } {
  const nodes = [makeNode(vec(-150, 0), 0), makeNode(vec(150, 0), 0), makeNode(vec(0, -280), 0)];
  const world: World = {
    obstacles: [], floors: [], stairs: [], nodes, items: [], vehicles: [...vehicles],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], events: [],
  };
  world.grid = new ObstacleGrid([]);
  const nav = new NavGraph(world);
  return { world, nav };
}
{
  // Incremental: build the baseline WITHOUT the tank, then add it and sync.
  const { world, nav } = navWorld([]);
  const base = nav.route(0, 1); // A->B, direct
  check("baseline A->B is the direct link", !!base && near(base!.dist, 300) && base!.next === 1, `dist=${base?.dist.toFixed(0)} next=${base?.next}`);

  const tank = new Vehicle(TANK, vec(0, 0), 0, 0); // parked straddling the A-B line
  world.vehicles.push(tank);
  tank.drive(world, nav); // throttle 0: settles + syncs the CCH
  const blocked = nav.route(0, 1);
  check("parked tank blocks A->B (reroutes via C)", !!blocked && blocked!.next === 2 && blocked!.dist > 600, `dist=${blocked?.dist.toFixed(0)} next=${blocked?.next}`);
  check("tank tracks the blocked edge", tank.blocked.size >= 1, `n=${tank.blocked.size}`);

  // Full rebuild WITH the tank present from construction.
  const full = navWorld([new Vehicle(TANK, vec(0, 0), 0, 0)]);
  const fr = full.nav.route(0, 1);
  check("sparse update == full rebuild (dist)", !!fr && !!blocked && near(fr!.dist, blocked!.dist), `inc=${blocked?.dist.toFixed(1)} full=${fr?.dist.toFixed(1)}`);
  check("sparse update == full rebuild (first hop)", !!fr && !!blocked && fr!.next === blocked!.next);

  // Drive it far away: the edge is restored, and the vehicle now blocks nothing.
  tank.pos = vec(0, 2000);
  tank.drive(world, nav);
  const restored = nav.route(0, 1);
  check("driving off restores A->B", !!restored && near(restored!.dist, 300) && restored!.next === 1, `dist=${restored?.dist.toFixed(0)} next=${restored?.next}`);
  check("open-ground vehicle blocks no edges (empty set)", tank.blocked.size === 0);
}

// -------------------------------------------------- enter / exit clip ---------
console.log("enter/exit — occupant pinned; exit never clips into a wall:");
{
  const LEVEL = JSON.stringify({
    version: 1,
    entities: [
      { kind: "spawn", x: -300, y: 0, z: 0 },
      { kind: "wall", x: 0, y: 120, w: 320, h: 26, z: 0 }, // wall on the +y exit side
      { kind: "vehicle", type: "TANK", x: 0, y: 0, z: 0 },
    ],
  });
  const level = loadLevel(LEVEL);
  const game = new Game(level, GAMEMODES[DEFAULT_MODE]({ ...level.meta, mode: DEFAULT_MODE }));
  const tank = game.world.vehicles[0];
  check("level loaded the tank", !!tank && tank.spec === TANK);

  game.enterVehicle(game.humans[0], { vehicle: tank, seat: 0 });
  check("player is seated", game.player.vehicle === tank && tank.seats[0].occupant === game.player);
  game.update(); // occupant should be pinned to the seat
  check("occupant pinned to the seat", near(game.player.pos.x, tank.seatWorld(0).x) && near(game.player.pos.y, tank.seatWorld(0).y));

  game.exitVehicle(game.humans[0]);
  check("player left the vehicle", game.player.vehicle === null && tank.seats[0].occupant === null);
  const wall = game.world.obstacles.find((o) => o.pos.y === 120)!;
  const outOfWall = resolveCircleVsBox(game.player.pos, BODY_RADIUS, wall);
  check("exit spot is NOT inside the wall", outOfWall.x === game.player.pos.x && outOfWall.y === game.player.pos.y, `pos=(${game.player.pos.x.toFixed(0)},${game.player.pos.y.toFixed(0)})`);
  check("exit spot is NOT inside the hull", !tank.blocksCircle(game.player.pos, BODY_RADIUS));
  check("exit chose the clear (−y) side away from the wall", game.player.pos.y < 0, `y=${game.player.pos.y.toFixed(0)}`);
}

// -------------------------------------------------- Game integration ----------
console.log("headless Game: a vehicle driven 600 ticks (no throw / no tunnel):");
{
  const LEVEL = JSON.stringify({
    version: 1,
    entities: [
      { kind: "spawn", x: -400, y: 0, z: 0 },
      { kind: "vehicle", type: "TANK", x: 0, y: 0, z: 0 },
      { kind: "node", x: -300, y: 0, z: 0 },
      { kind: "node", x: 300, y: 0, z: 0 },
      { kind: "node", x: 0, y: 300, z: 0 },
    ],
  });
  const level = loadLevel(LEVEL);
  const game = new Game(level, GAMEMODES[DEFAULT_MODE]({ ...level.meta, mode: DEFAULT_MODE }));
  const tank = game.world.vehicles[0];
  let threw = false;
  try {
    for (let i = 0; i < 600; i++) {
      tank.throttle = 1; // drive continuously (not player-driven, so update() keeps our input)
      tank.steer = 0.25; // curve around
      game.update();
    }
  } catch {
    threw = true;
  }
  check("600 ticks with a moving vehicle, no throw", !threw);
  check("vehicle position stayed finite", Number.isFinite(tank.pos.x) && Number.isFinite(tank.pos.y), `pos=(${tank.pos.x.toFixed(0)},${tank.pos.y.toFixed(0)})`);
  check("player position stayed finite (no tunnel/NaN)", Number.isFinite(game.player.pos.x) && Number.isFinite(game.player.pos.y));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
