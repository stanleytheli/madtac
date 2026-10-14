/**
 * Verifies melee as a reach-and-arc check rather than an invisible bullet.
 *
 * Fists used to fire a tracerless round that flew 23px a tick — dodgeable by
 * walking, missable by a hair of spread, and (once debris scaled with tracer
 * width) throwing nothing at all on impact. A swing now connects on reach, arc
 * and plain line of sight, and throws debris weighted by the weapon's own
 * particleScale.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_melee.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vm.mjs && node <tmp>/vm.mjs
 */
import { spawnEffects } from "../src/engine/effects.ts";
import { makeWall, type Obstacle, type World } from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { SHRAPNEL_TRACER_WIDTH, BLOOD, BLOOD_MIN_HEFT } from "../src/engine/particle.ts";
import { AWM, UNARMED } from "../src/entities/guns.ts";
import { Gun } from "../src/entities/gun.ts";
import { Character } from "../src/entities/actor.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "../src/entities/character.ts";
import { deg2rad, fromAngle, vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

function world(obstacles: Obstacle[] = []): World {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], events: [],
  } as unknown as World;
  if (obstacles.length) (w as any).grid = new ObstacleGrid(obstacles);
  return w;
}
const body = (at: Vec2, team: string): Character => {
  const c = new Character(vec(at.x, at.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = team as any;
  c.z = 0;
  return c;
};

/** Throw one punch from the origin, facing `angle`, at a target `dist` away at
 *  `targetAngle`. Returns what happened. */
function punch(opts: {
  facing?: number;
  targetAt?: Vec2 | null;
  obstacles?: Obstacle[];
  reach?: number;
} = {}) {
  const w = world(opts.obstacles ?? []);
  const attacker = body(vec(0, 0), "blue");
  attacker.forward = fromAngle(opts.facing ?? 0, 1);
  const target = opts.targetAt ? body(opts.targetAt, "red") : null;
  const before = target ? target.hp : 0;
  const fired = attacker.fire(w, target ? [attacker, target] : [attacker]);
  spawnEffects(w); // the swing's blood / chips, as the client would throw them
  return {
    fired,
    hurt: target ? before - target.hp : 0,
    bullets: w.bullets.length,
    particles: w.particles,
    blood: w.particles.filter((p) => p.color === BLOOD.color),
    debris: w.particles.filter((p) => p.color !== BLOOD.color),
  };
}

const REACH = UNARMED.meleeReach!;
const CONE = UNARMED.meleeConeDeg!;

// -------------------------------------------------------- not a bullet --------
console.log("a punch is a swing, not a projectile:");
{
  const hit = punch({ targetAt: vec(REACH - 20, 0) });
  check("the swing goes out", hit.fired);
  check("no bullet is spawned at all", hit.bullets === 0, `${hit.bullets} bullets`);
  check("it lands immediately, in the same call", hit.hurt > 0, `${hit.hurt} damage`);
  check("...for the weapon's damage", near(hit.hurt, UNARMED.damage), `${hit.hurt}`);
}

// ------------------------------------------------------------ reach -----------
console.log("\nreach:");
{
  check(`inside ${REACH}px it connects`, punch({ targetAt: vec(REACH - 5, 0) }).hurt > 0);
  check("...just past it, nothing", punch({ targetAt: vec(REACH + 5, 0) }).hurt === 0);
  check("point blank connects", punch({ targetAt: vec(5, 0) }).hurt > 0);
  check("a swing at empty air still counts as a swing",
    punch({ targetAt: null }).fired && punch({ targetAt: null }).hurt === 0);
}

// ------------------------------------------------------------- arc ------------
console.log(`\narc (${CONE} degrees total, ${CONE / 2} either side):`);
{
  const at = (deg: number) => {
    const a = deg2rad(deg);
    return punch({ targetAt: vec(Math.cos(a) * 80, Math.sin(a) * 80) });
  };
  check("dead ahead lands", at(0).hurt > 0);
  check(`${CONE / 2 - 2} degrees off lands`, at(CONE / 2 - 2).hurt > 0);
  check(`${CONE / 2 + 2} degrees off misses`, at(CONE / 2 + 2).hurt === 0);
  check("the arc is symmetric", at(-(CONE / 2 - 2)).hurt > 0 && at(-(CONE / 2 + 2)).hurt === 0);
  check("behind the swinger, nothing", at(180).hurt === 0);
  check("straight up, nothing", at(90).hurt === 0);
}

// ------------------------------------------------------- line of sight --------
console.log("\nyou cannot punch through a wall, however thin:");
{
  const wall = (t: number): Obstacle => makeWall(vec(50, 0), t, 400, 0);
  check("a wall between them blocks the swing",
    punch({ targetAt: vec(100, 0), obstacles: [wall(20)] }).hurt === 0);
  check("...even a 4px one", punch({ targetAt: vec(100, 0), obstacles: [wall(4)] }).hurt === 0);
  check("the fists carry no penetration to spend anyway", (UNARMED.penetration ?? 0) === 0);
  check("with the wall out of the way it lands",
    punch({ targetAt: vec(100, 0) }).hurt > 0);
}

// ------------------------------------------------------------ debris ----------
console.log("\nfists throw debris again, on the tracer-width scale:");
{
  const hit = punch({ targetAt: vec(60, 0) });
  check("landing on a body draws blood", hit.blood.length > 0, `${hit.blood.length} particles`);
  const expected = Math.max(BLOOD_MIN_HEFT, UNARMED.particleScale! / SHRAPNEL_TRACER_WIDTH);
  check("...at the weight particleScale asks for",
    near(hit.blood[0].size, BLOOD.size * expected), `${hit.blood[0].size} vs ${BLOOD.size * expected}`);
  check("particleScale is stated in tracer-width units",
    UNARMED.particleScale === SHRAPNEL_TRACER_WIDTH,
    `${UNARMED.particleScale} vs an ordinary round's ${SHRAPNEL_TRACER_WIDTH}`);

  const onWall = punch({ targetAt: null, obstacles: [makeWall(vec(60, 0), 40, 400, 0)] });
  check("punching a wall chips it", onWall.debris.length > 0, `${onWall.debris.length} particles`);
  check("...and draws no blood", onWall.blood.length === 0);
  const far = punch({ targetAt: null, obstacles: [makeWall(vec(REACH + 60, 0), 40, 400, 0)] });
  check("a wall out of reach is not chipped", far.particles.length === 0);
  check("a swing at nothing at all throws nothing", punch({ targetAt: null }).particles.length === 0);
}

// ---------------------------------------------------------- one target --------
console.log("\na punch lands on one person — the nearest:");
{
  const w = world();
  const attacker = body(vec(0, 0), "blue");
  attacker.forward = vec(1, 0);
  const near1 = body(vec(50, 0), "red");
  const far1 = body(vec(110, 0), "red");
  attacker.fire(w, [attacker, near1, far1]);
  check("the near one is struck", near1.hp < 100);
  check("the far one is not", far1.hp === 100, `${far1.hp}`);
}

// -------------------------------------------------------------- teams ---------
console.log("\nthe swing is blind to allegiance, like every other weapon:");
{
  const w = world();
  const attacker = body(vec(0, 0), "blue");
  attacker.forward = vec(1, 0);
  const mate = body(vec(50, 0), "blue");
  attacker.fire(w, [attacker, mate]);
  check("a teammate in the fist's way takes it", mate.hp < 100, `${mate.hp}`);
  const w2 = world();
  const solo = body(vec(0, 0), "blue");
  solo.forward = vec(1, 0);
  solo.fire(w2, [solo]);
  check("nobody punches themselves", solo.hp === 100);
}

// ------------------------------------------------------------- guns -----------
console.log("\nnothing else changed:");
{
  const w = world();
  const shooter = body(vec(0, 0), "blue");
  (shooter as any).slots.primary = new Gun(AWM);
  shooter.equip("primary");
  (shooter.gun as any).drawTicks = 0;
  shooter.forward = vec(1, 0);
  const victim = body(vec(300, 0), "red");
  shooter.fire(w, [shooter, victim]);
  check("a real gun still spawns a bullet", w.bullets.length === 1, `${w.bullets.length}`);
  check("...and doesn't melee anyone on the way", victim.hp === 100);
  check("a rifle has no melee parameters", AWM.meleeReach === undefined && !AWM.melee);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
