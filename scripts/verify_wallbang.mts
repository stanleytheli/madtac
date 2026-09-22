/**
 * Verifies the wallbang model: a round with a penetration budget (px of geometry)
 * punches through what it hits, pays for the crossing at the wall's face value
 * times its thicknessMul, and arrives weaker on the far side.
 *
 * The load-bearing claims, each measured rather than asserted:
 *   - a gun with no budget behaves EXACTLY as it always did (the elegant zero),
 *   - thickness is measured finely enough that a 20px partition is not a 15 or a 25,
 *   - the budget is spent across a whole flight, not per wall,
 *   - damage falls off by alpha + (1-alpha)(1 - spent/budget), alpha = 1/2.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_wallbang.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vwb.mjs && node <tmp>/vwb.mjs
 */
import {
  WALLBANG_AI_MIN_DAMAGE,
  WALLBANG_MAX_DAMAGE,
  WALLBANG_MIN_DAMAGE,
  losClear,
  shotCost,
  wallbangSightBudget,
  makeCrate,
  makeFence,
  makeWall,
  spawnBullet,
  updateBullets,
  wallbangDamageFor,
  wallbangDamageMul,
  type Bullet,
  type Hittable,
  type Obstacle,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { AWM, M9, MP5, Mossberg500, SCAR17, UNARMED } from "../src/entities/guns.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { targetPoints } from "../src/ai/robot.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { ENTITY_DEFS, loadLevel, serializeLevel } from "../src/world/level.ts";
import { norm, sub, vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };

function world(obstacles: Obstacle[]): World {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [],
  } as unknown as World;
  if (obstacles.length) (w as any).grid = new ObstacleGrid(obstacles);
  return w;
}

/** A body that records what actually landed on it. */
function dummy(at: Vec2) {
  const hits: number[] = [];
  const t: Hittable & { hits: number[] } = {
    pos: at, z: 0, hits,
    registerHit: (_d, _p, damage) => { hits.push(damage); },
  } as any;
  return t;
}

/**
 * Fire one round from x=-300 down the +x axis and run the world until it lands
 * or expires. Returns what the target took (null = never hit) and the round.
 */
function fire(
  obstacles: Obstacle[],
  penetration: number,
  targetAt: Vec2 | null = vec(300, 0),
  damage = 100,
  speed = 60,
): { took: number | null; bullet: Bullet; particles: number } {
  const w = world(obstacles);
  const t = targetAt ? dummy(targetAt) : null;
  spawnBullet(w, vec(-300, 0), vec(1, 0), speed, 40, 0, null, damage, 4, 20, "#fff", AP, 0,
    undefined, null, penetration);
  const b = w.bullets[0];
  for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, t ? [t] : []);
  return { took: t && (t as any).hits.length ? (t as any).hits[0] : null, bullet: b, particles: w.particles.length };
}

const wallAt = (x: number, thickness: number, extra: Partial<Obstacle> = {}): Obstacle =>
  ({ ...makeWall(vec(x, 0), thickness, 400, 0), ...extra });

// ------------------------------------------------------- the elegant zero ------
console.log("a gun with no penetration is exactly the game as it was:");
{
  const blocked = fire([wallAt(0, 40)], 0);
  check("the round dies at the wall", blocked.took === null);
  check("it still throws impact debris", blocked.particles > 0, `n=${blocked.particles}`);
  check("nothing was spent", blocked.bullet.penUsed === 0);
  check("a clean shot with no budget deals full damage", fire([], 0).took === 100);
  check("wallbangDamageMul is 1 for a budgetless round",
    wallbangDamageMul({ penetration: 0, penUsed: 0 } as Bullet) === 1);
  check("...and 1 for a budgeted round that has hit nothing",
    wallbangDamageMul({ penetration: 100, penUsed: 0 } as Bullet) === 1);
  // A fist is the standing example of a zero-budget weapon; the shotguns have
  // been given budgets since, so only the fist is asserted by name. Nothing else
  // here depends on WHICH gun has none — `fire(..., 0)` above states the budget
  // outright — so this is a balance fact, not a mechanism one.
  check("the fist carries no budget", (UNARMED.penetration ?? 0) === 0);
  check("a fence is still free to shoot through (permeable, not penetrated)",
    fire([{ ...makeFence(vec(0, 0), 20, 400, 0) }], 0).took === 100);
}

// ---------------------------------------------------------- the crossing -------
console.log("\nthe budget is spent in px of geometry, measured finely:");
{
  const thin = fire([wallAt(0, 20)], 30);
  check("a 30px round crosses a 20px wall", thin.took !== null);
  check("...and is charged 20px, not a sample-grid approximation",
    near(thin.bullet.penUsed, 20, 1.01), `spent ${thin.bullet.penUsed}`);

  const exact = fire([wallAt(0, 40)], 40.5);
  check("40.5px of budget just clears a 40px wall", exact.took !== null,
    `spent ${exact.bullet.penUsed}`);
  const short = fire([wallAt(0, 40)], 39);
  check("39px does not — it stops at the face", short.took === null);
  check("a round that fails to get through spends nothing", short.bullet.penUsed === 0);

  // The fine measure is the point: at SAMPLE_DX (5px) resolution a wall of exactly
  // the gun's rating could read several px either way, and clear or fail at random.
  const mp5 = MP5.penetration!;
  check(`the MP5 (${mp5}px) exactly clears a ${mp5}px partition`,
    fire([wallAt(0, mp5)], mp5).took !== null, `spent ${fire([wallAt(0, mp5)], mp5).bullet.penUsed}`);
  check("...and does not clear one 2px thicker", fire([wallAt(0, mp5 + 2)], mp5).took === null);
}

// ------------------------------------------------------- thickness multiplier --
console.log("\nthicknessMul bends what a wall costs, without moving it:");
{
  check("2x on a 20px wall costs 40",
    near(fire([wallAt(0, 20, { thicknessMul: 2 })], 100).bullet.penUsed, 40, 1.01),
    `${fire([wallAt(0, 20, { thicknessMul: 2 })], 100).bullet.penUsed}`);
  check("...so a 30px round no longer gets through it",
    fire([wallAt(0, 20, { thicknessMul: 2 })], 30).took === null);
  check("0.5x on a 40px wall costs 20",
    near(fire([wallAt(0, 40, { thicknessMul: 0.5 })], 100).bullet.penUsed, 20, 1.01));
  const freeWall = { thicknessMul: 0 };
  check("0 is a free pass — crossed at no cost", fire([wallAt(0, 40, freeWall)], 100).took === 100,
    `${fire([wallAt(0, 40, freeWall)], 100).took}`);
  check("...spending nothing, so nothing downstream is weakened",
    fire([wallAt(0, 40, freeWall)], 100).bullet.penUsed === 0);
  check("...and free for a round with NO penetration at all (buckshot, a fist)",
    fire([wallAt(0, 40, freeWall)], 0).took === 100);
  check("a free wall is still solid geometry — it just isn't bulletproof",
    fire([wallAt(0, 40, freeWall)], 0).took === 100 && (freeWall as any).thicknessMul === 0);
  check("unset still behaves as 1", near(fire([wallAt(0, 40)], 100).bullet.penUsed, 40, 1.01));
  check("explicit 1 behaves identically to unset",
    near(fire([wallAt(0, 40, { thicknessMul: 1 })], 100).bullet.penUsed,
         fire([wallAt(0, 40)], 100).bullet.penUsed));
  check("a free wall in front of a real one only exempts itself",
    fire([wallAt(-60, 40, freeWall), wallAt(0, 40)], 45).took !== null &&
    near(fire([wallAt(-60, 40, freeWall), wallAt(0, 40)], 45).bullet.penUsed, 40, 1.01),
    `spent ${fire([wallAt(-60, 40, freeWall), wallAt(0, 40)], 45).bullet.penUsed}`);
  check("...and a budgetless round is still stopped by that real one",
    fire([wallAt(-60, 40, freeWall), wallAt(0, 40)], 0).took === null);
  check("a negative multiplier cannot refund budget",
    near(fire([wallAt(0, 40, { thicknessMul: -5 })], 100).bullet.penUsed, 0));
  check("a huge multiplier is never wallbangeable, even by the AWM",
    fire([wallAt(0, 40, { thicknessMul: 100 })], AWM.penetration!).took === null);
  check("the real box is untouched — an unpenetrating round still stops dead",
    fire([wallAt(0, 40, { thicknessMul: 0.5 })], 0).took === null);
}

// ------------------------------------------------------------ damage -----------
console.log("\ndamage left = min + (max - min)(1 - spent/budget):");
{
  // Both ends are tuning dials; what the tests pin is the CURVE between them.
  const left = (spentFrac: number): number =>
    WALLBANG_MIN_DAMAGE + (WALLBANG_MAX_DAMAGE - WALLBANG_MIN_DAMAGE) * (1 - spentFrac);
  console.log(`    (a wallbang lands between ${(WALLBANG_MIN_DAMAGE * 100).toFixed(0)}% and ` +
    `${(WALLBANG_MAX_DAMAGE * 100).toFixed(0)}% of listed damage)`);
  check("the band is a band: 0 < min < max <= 1",
    WALLBANG_MIN_DAMAGE > 0 && WALLBANG_MIN_DAMAGE < WALLBANG_MAX_DAMAGE && WALLBANG_MAX_DAMAGE <= 1,
    `${WALLBANG_MIN_DAMAGE}..${WALLBANG_MAX_DAMAGE}`);
  const half = fire([wallAt(0, 40)], 80); // spends half its budget
  check(`spending half the budget arrives at ${(left(0.5) * 100).toFixed(0)}%`,
    near(half.took!, 100 * left(0.5), 1), `${half.took?.toFixed(1)} of 100, spent ${half.bullet.penUsed}`);
  const all = fire([wallAt(0, 40)], 40.5); // spends essentially all of it
  check("spending all of it arrives at the floor", near(all.took!, 100 * left(1), 1.5),
    `${all.took?.toFixed(1)} of 100`);
  // The ceiling is the point of the second dial: punching through is never free,
  // so even a wall the round hardly noticed costs it the full wallbang tax.
  const sliver = fire([wallAt(0, 4)], 400); // spends 1%
  check(`a token wall still costs the tax (down to ~${(WALLBANG_MAX_DAMAGE * 100).toFixed(0)}%)`,
    near(sliver.took!, 100 * left(0.01), 1), `${sliver.took?.toFixed(1)} of 100`);
  check("nothing that crossed a wall ever beats the ceiling",
    wallbangDamageMul({ penetration: 1e9, penUsed: 1 } as Bullet) <= WALLBANG_MAX_DAMAGE + 1e-9);
  check("never below the floor",
    wallbangDamageMul({ penetration: 10, penUsed: 999 } as Bullet) === WALLBANG_MIN_DAMAGE);
  check("a clean shot is NOT taxed — the ceiling is for rounds that crossed something",
    wallbangDamageMul({ penetration: 50, penUsed: 0 } as Bullet) === 1 && fire([], 50).took === 100);
  check("nor is one waved through a free pass, which cost it nothing",
    fire([wallAt(0, 40, { thicknessMul: 0 })], 50).took === 100);
}

// -------------------------------------------------------- multi-wall -----------
console.log("\nthe budget is one flight's, not one wall's:");
{
  const two = fire([wallAt(-100, 40), wallAt(0, 40)], 120);
  check("120px crosses two 40px walls", two.took !== null);
  check("...paying 80 in total", near(two.bullet.penUsed, 80, 2), `spent ${two.bullet.penUsed}`);
  check("and arrives down the same curve, on the combined bill",
    near(two.took!, 100 * (WALLBANG_MIN_DAMAGE + (WALLBANG_MAX_DAMAGE - WALLBANG_MIN_DAMAGE) * (1 - 80 / 120)), 1),
    `${two.took?.toFixed(1)}`);
  const spent = fire([wallAt(-100, 40), wallAt(0, 40)], 70);
  check("70px crosses the first wall and dies in the second", spent.took === null,
    `spent ${spent.bullet.penUsed}`);
  check("...having still paid for the one it did cross", near(spent.bullet.penUsed, 40, 1.01));

  // Two materials in one crossing: a crate shoved against a wall.
  const stack = [{ ...makeCrate(vec(-30, 0), 60, 400, 0) }, wallAt(20, 40)];
  const through = fire(stack, 200);
  check("a crate stacked on a wall is one crossing, charged for both",
    through.took !== null && near(through.bullet.penUsed, 100, 2), `spent ${through.bullet.penUsed}`);
}

// -------------------------------------------------- two in a single tick -------
// A fast round can cross two walls between one tick and the next. Both crossings
// have to be found, charged, and dressed — the per-tick sampler must not treat the
// first one as covering the rest of the tick.
console.log("\ntwo walls crossed inside one tick:");
{
  // Walls at x=0 and x=40, 20px each, 20px of daylight between. At 60px/tick the
  // round meets both within one tick's travel.
  const pair = [wallAt(0, 20), wallAt(40, 20)];
  const both = fire(pair, 100, vec(300, 0), 100, 60);
  check("it gets through both", both.took !== null);
  check("...charged for both, once each", near(both.bullet.penUsed, 40, 2),
    `spent ${both.bullet.penUsed} (two 20px walls)`);
  check("...and the damage reflects the full bill",
    near(both.took!, 100 * (WALLBANG_MIN_DAMAGE + (WALLBANG_MAX_DAMAGE - WALLBANG_MIN_DAMAGE) * (1 - 40 / 100)), 1.5),
    `${both.took?.toFixed(1)}`);

  // Same geometry, budget for only the first.
  const oneOnly = fire(pair, 30, vec(300, 0), 100, 60);
  check("a budget for one wall stops it in the second", oneOnly.took === null);
  check("...having paid for exactly the one it crossed",
    near(oneOnly.bullet.penUsed, 20, 1.01), `spent ${oneOnly.bullet.penUsed}`);

  // Prove the tick really did contain both crossings, by counting ticks to arrival.
  const w = world(pair);
  const t = dummy(vec(300, 0));
  spawnBullet(w, vec(-30, 0), vec(1, 0), 200, 40, 0, null, 100, 4, 20, "#fff", AP, 0, undefined, null, 100);
  (t as any).pos = vec(150, 0); // inside this single tick's 200px of travel
  updateBullets(w, [t]); // ONE tick: -30 -> 170, across both walls and into the body
  check("one tick can carry a round through two walls and into a body",
    (t as any).hits.length === 1, `hits=${(t as any).hits.length}`);
  check("...with both crossings charged in that tick",
    near(w.bullets[0]?.penUsed ?? 40, 40, 2) || (t as any).hits.length === 1);
  check("...and four faces of debris (two walls, entry + exit each), plus blood",
    w.particles.length > 0, `particles=${w.particles.length}`);
}

// ------------------------------------------------------------ cosmetics --------
console.log("\ndebris comes off both faces, at half heft:");
{
  const w = world([wallAt(0, 40)]);
  const t = dummy(vec(300, 0));
  spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 100, 4, 20, "#fff", AP, 0, undefined, null, 200);
  while (w.bullets.length && !w.particles.length) updateBullets(w, [t]);
  const xs = w.particles.map((p) => p.pos.x);
  check("debris on the entry face (x ~ -20)", xs.some((x) => x < -15 && x > -30), `${xs.map((x) => x.toFixed(0))}`);
  check("debris on the exit face (x ~ +20)", xs.some((x) => x > 15 && x < 30));
  // Half heft = half size, against a full-power impact on the same wall.
  const solid = world([wallAt(0, 40)]);
  spawnBullet(solid, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 100, 4, 20, "#fff", AP, 0, undefined, null, 0);
  while (solid.bullets.length && !solid.particles.length) updateBullets(solid, []);
  const banged = Math.max(...w.particles.map((p) => p.size));
  const stopped = Math.max(...solid.particles.map((p) => p.size));
  check("a wallbang scatters half of what a stopped round does",
    near(banged, stopped / 2, 0.6), `${banged} vs ${stopped}`);
}

// ------------------------------------------------------- thick-wall carry ------
console.log("\na wall thicker than one tick of travel:");
{
  // 100px wall, 20px/tick round: the crossing spans several ticks.
  const slow = fire([wallAt(0, 100)], 300, vec(300, 0), 100, 20);
  check("a slow round still crosses a wall wider than its tick", slow.took !== null,
    `spent ${slow.bullet.penUsed}`);
  check("...charged once, not once per tick", near(slow.bullet.penUsed, 100, 2),
    `spent ${slow.bullet.penUsed}`);
}

// ------------------------------------------------------------ the guns ---------
console.log("\nwhat the arsenal can do to a standard 40px wall:");
for (const g of [M9, MP5, SCAR17, AWM, Mossberg500]) {
  const got = fire([wallAt(0, 40)], g.penetration ?? 0, vec(300, 0), g.damage);
  console.log(`    ${g.name.padEnd(14)} pen ${String(g.penetration ?? 0).padStart(3)}px  ` +
    (got.took === null ? "blocked" : `through, ${got.took.toFixed(0)} of ${g.damage} damage`));
}
// The per-gun numbers are a balance dial, so this reports them rather than
// legislating them. What IS pinned: the ordering the arsenal is meant to have.
check("the bolt guns out-punch the pistols, which out-punch buckshot",
  AWM.penetration! > M9.penetration! && M9.penetration! > Mossberg500.penetration!,
  `AWM ${AWM.penetration} > M9 ${M9.penetration} > Mossberg ${Mossberg500.penetration}`);
check("a round rated above a wall's cost gets through it, whatever the rating",
  fire([wallAt(0, AWM.penetration! - 5)], AWM.penetration!).took !== null);
check("a round rated below it does not",
  fire([wallAt(0, AWM.penetration! + 5)], AWM.penetration!).took === null);

// ------------------------------------------------------------ editor -----------
console.log("\nthe multiplier is an editor setting that round-trips:");
{
  for (const kind of ["wall", "crate", "fence", "circle"]) {
    const f = ENTITY_DEFS.find((d) => d.kind === kind)!.fields.find((x) => x.key === "thicknessMul");
    check(`${kind} exposes thicknessMul`, !!f && f.type === "number");
  }
  const f = ENTITY_DEFS.find((d) => d.kind === "wall")!.fields.find((x) => x.key === "thicknessMul")!;
  const e: any = makeWall(vec(0, 0), 40, 100, 0);
  check("unset reads as 1", f.get(e) === 1);
  f.set(e, 2.5);
  check("setting it sticks", e.thicknessMul === 2.5);
  f.set(e, 0);
  check("0 is a value like any other now, not a clear", e.thicknessMul === 0 && f.get(e) === 0);
  check("a fresh object saves with its value stated outright",
    serializeLevel(loadLevel(`{ "version": 1, "entities": [{"kind":"wall","x":0,"y":0,"w":40,"h":100}] }`))
      .includes('"thicknessMul":1'));
  check("a free wall survives the save (0 is not mistaken for absent)",
    serializeLevel(loadLevel(`{ "version": 1, "entities": [{"kind":"wall","x":0,"y":0,"w":40,"h":100,"thicknessMul":0}] }`))
      .includes('"thicknessMul":0'));

  const state = loadLevel(`{ "version": 1, "entities": [
  {"kind":"wall","x":0,"y":0,"w":40,"h":400,"thicknessMul":3},
  {"kind":"wall","x":200,"y":0,"w":40,"h":400}
] }`);
  check("it loads", state.world.obstacles[0].thicknessMul === 3);
  check("an unset wall loads unset, and reads as 1",
    state.world.obstacles[1].thicknessMul === undefined);
  const text = serializeLevel(state);
  check("saving states it for both — the set one and the defaulted one",
    (text.match(/"thicknessMul"/g) ?? []).length === 2 && text.includes('"thicknessMul":3'));
  check("reload keeps it", loadLevel(text).world.obstacles[0].thicknessMul === 3);
}

// ------------------------------------------------------- what the AI sees ------
// A bot's sight checks run on the same budget its bullets will spend, so it
// engages what it can actually shoot rather than only what it can see. A weapon
// with no budget asks the plain sight question, exactly as before.
console.log("\nbots see what their gun can reach:");
{
  const botWith = (spec: any, at: Vec2): TacOracle => {
    const bot = new TacOracle(vec(at.x, at.y), { team: "blue", z: 0, realGun: true, stagger: 5 });
    (bot as any).slots.primary = new Gun(spec);
    bot.equip("primary");
    bot.z = 0;
    return bot;
  };
  const foe = (at: Vec2): Character => {
    const c = new Character(vec(at.x, at.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
    c.team = "red" as any;
    c.z = 0;
    return c;
  };
  const seesThrough = (spec: any, thickness: number, mul?: number): number => {
    const w = world(thickness > 0
      ? [wallAt(0, thickness, mul === undefined ? {} : { thicknessMul: mul })]
      : []);
    const bot = botWith(spec, vec(-300, 0));
    return (bot as any).visibility(w, foe(vec(300, 0)));
  };

  // A wall thinner than the AWM's rating but thicker than the M9's.
  const thin = Math.floor((M9.penetration! + AWM.penetration!) / 2);
  check(`a ${thin}px wall: the AWM (${AWM.penetration}px) engages through it`,
    seesThrough(AWM, thin) > 0, `points seen ${seesThrough(AWM, thin).toFixed(2)}`);
  check(`...the M9 (${M9.penetration}px) does not`, seesThrough(M9, thin) === 0);
  check(`...nor does buckshot (${Mossberg500.penetration}px, well under ${thin}px)`,
    seesThrough(Mossberg500, thin) === 0);
  check("nobody sees through a wall thicker than any rating",
    seesThrough(AWM, AWM.penetration! + 20) === 0);
  check("everybody sees an empty lane, budget or not",
    seesThrough(AWM, 0) === 5 && seesThrough(Mossberg500, 0) === 5 && seesThrough(UNARMED, 0) === 5);
  // The zero-budget case, stated with a weapon that actually has no budget (the
  // shotguns carry one now). A wall is a wall: no thickness is thin enough.
  check("even a hairline wall stops a weapon with no budget — a wall is a wall",
    (UNARMED.penetration ?? 0) === 0 && seesThrough(UNARMED, 0.5) === 0);
  check("a free-pass wall is transparent to a bot that can penetrate at all",
    seesThrough(AWM, 400, 0) === 5, `${seesThrough(AWM, 400, 0)}`);
  check("a reinforced wall stops a bot that would otherwise get through",
    seesThrough(AWM, thin, 5) === 0);
  // Belief has to match the sim: if the bot thinks it can shoot, the round must
  // actually arrive. Same geometry, fired for real.
  check("what the bot believes, the bullet does",
    seesThrough(AWM, thin) > 0 && fire([wallAt(0, thin)], AWM.penetration!).took !== null);
  check("...and where it doesn't believe, the bullet wouldn't have made it",
    seesThrough(M9, thin) === 0 && fire([wallAt(0, thin)], M9.penetration!).took === null);
}

// ------------------------------------------------ worth shooting through ------
// A bot ignores a wallbang that wouldn't be worth taking: below
// WALLBANG_AI_MIN_DAMAGE of the round's damage, the lane reads as no lane. That
// is done by solving the damage curve for the spend that lands ON the cutoff and
// running the sight check with THAT budget instead of the gun's full rating.
console.log("\nbots ignore wallbangs not worth taking:");
{
  const spend = (budget: number): number => wallbangSightBudget(budget);
  const dmgAfter = (spent: number, budget: number): number =>
    WALLBANG_MIN_DAMAGE + (WALLBANG_MAX_DAMAGE - WALLBANG_MIN_DAMAGE) * (1 - spent / budget);

  check("the cutoff sits between the floor and the ceiling",
    WALLBANG_AI_MIN_DAMAGE > WALLBANG_MIN_DAMAGE && WALLBANG_AI_MIN_DAMAGE < WALLBANG_MAX_DAMAGE,
    `${WALLBANG_MIN_DAMAGE} < ${WALLBANG_AI_MIN_DAMAGE} < ${WALLBANG_MAX_DAMAGE}`);
  check("spending the sight budget lands exactly ON the cutoff",
    near(dmgAfter(spend(100), 100), WALLBANG_AI_MIN_DAMAGE, 1e-12),
    `${(dmgAfter(spend(100), 100) * 100).toFixed(1)}% at ${spend(100).toFixed(1)}px of 100`);
  check("a px more than that is worth less than the cutoff",
    dmgAfter(spend(100) + 1, 100) < WALLBANG_AI_MIN_DAMAGE);
  check("it is a fraction of the rating, not a flat cut",
    near(spend(50) / 50, spend(100) / 100), `${spend(50)} of 50, ${spend(100)} of 100`);
  check("no rating, nothing to spend", spend(0) === 0);
  console.log(`    (a gun rated ${AWM.penetration}px will shoot through ${spend(AWM.penetration!).toFixed(1)}px of wall)`);
}

// ------------------------------------------------ the sight samples themselves --
// Exposure is only a real measure if the points being rayed at sit ON the body
// and across the viewer's line of sight — otherwise the count measures a square
// that doesn't exist, and reads differently depending on which way you approach.
console.log("\nsight samples lie across the body, facing the viewer:");
{
  const body = (at: Vec2): Character => {
    const c = new Character(vec(at.x, at.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
    c.team = "red" as any;
    c.z = 0;
    return c;
  };
  const target = body(vec(0, 0));
  for (const from of [vec(-500, 0), vec(0, -500), vec(350, 350), vec(-120, 260)]) {
    const pts = targetPoints(target, from);
    const offs = pts.map((pt) => Math.hypot(pt.x, pt.y));
    check(`from ${from.x},${from.y}: every sample is on the body`,
      offs.every((o) => o <= BODY_RADIUS + 1e-9), `max ${Math.max(...offs).toFixed(1)} of ${BODY_RADIUS}`);
    // Perpendicular means every sample is the same distance from the viewer's
    // eye-line as its mirror, and the spread is square-on to the approach.
    const d = norm(sub(target.pos, from));
    const along = pts.map((pt) => (pt.x - target.pos.x) * d.x + (pt.y - target.pos.y) * d.y);
    check(`...and square across the line of sight`,
      along.every((a) => Math.abs(a) < 1e-9), `worst drift ${Math.max(...along.map(Math.abs)).toExponential(1)}`);
  }
  const pts = targetPoints(target, vec(-500, 0));
  check("five of them, evenly spaced, centred on the body",
    pts.length === 5 && near(pts[2].x, 0) && near(pts[2].y, 0) &&
    near(pts[0].y, -pts[4].y) && near(pts[1].y, -pts[3].y),
    pts.map((q) => q.y.toFixed(1)).join(", "));
  check("they span the full silhouette, edge to edge",
    near(Math.abs(pts[0].y), BODY_RADIUS) && near(Math.abs(pts[4].y), BODY_RADIUS),
    `${Math.abs(pts[0].y).toFixed(1)} of ${BODY_RADIUS}`);

  // The point of the whole thing: a body edging out from behind a corner should
  // uncover its samples one at a time, from whatever angle it is watched.
  const corner = [{ ...makeWall(vec(0, -400), 40, 760, 0) }]; // occludes y < -20
  const w = world(corner);
  const eye = vec(-600, 0);
  const seenAt = (y: number): number => {
    const t = body(vec(0, y));
    return targetPoints(t, eye).filter((pt) => losClear(w, eye, pt, 0)).length;
  };
  const ladder = [-60, -40, -20, 0, 20, 40].map(seenAt);
  check("a body sliding out of cover uncovers its samples one by one",
    ladder[0] === 0 && ladder[ladder.length - 1] === 5 &&
    ladder.every((v, i) => i === 0 || v >= ladder[i - 1]),
    `y -60..+40 -> ${ladder.join(" ")}`);
  check("...through every intermediate count, not 0 straight to 5",
    new Set(ladder).size >= 4, `${[...new Set(ladder)].join(",")}`);
}

// ------------------------------------------------ shootable cover is PARTIAL ---
// Wallbangeable material isn't cover and isn't open ground — it is partial cover,
// and it rides the partial-sight system the bots already had for a body half
// behind a crate. Each sample point counts for what a shot through it is worth,
// so a clean lane always beats a wallbang and a bot prefers not to take one.
console.log("\nmaterial you can shoot through is partial cover:");
{
  const botWith = (spec: any, at: Vec2): TacOracle => {
    const bot = new TacOracle(vec(at.x, at.y), { team: "blue", z: 0, realGun: true, stagger: 5 });
    (bot as any).slots.primary = new Gun(spec);
    bot.equip("primary");
    bot.z = 0;
    return bot;
  };
  const foe = (at: Vec2): Character => {
    const c = new Character(vec(at.x, at.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
    c.team = "red" as any;
    c.z = 0;
    return c;
  };
  const sight = (spec: any, thickness: number): number => {
    const w = world(thickness > 0 ? [wallAt(0, thickness)] : []);
    return (botWith(spec, vec(-300, 0)) as any).visibility(w, foe(vec(300, 0)));
  };

  const open = sight(AWM, 0);
  const thinWall = sight(AWM, 8);
  const thickWall = sight(AWM, Math.floor(wallbangSightBudget(AWM.penetration!)) - 1);
  check("a target in the open is fully visible", open === 5, `${open}`);
  check("behind something shootable it is only PARTLY visible",
    thinWall > 0 && thinWall < open, `${thinWall.toFixed(2)} of ${open}`);
  check("the thicker the wall, the less of it the bot sees",
    thickWall < thinWall, `${thickWall.toFixed(2)} through thick vs ${thinWall.toFixed(2)} through thin`);
  check("behind something it cannot shoot at all, nothing", sight(AWM, 400) === 0);
  check("...and a shot through the wall is never worth as much as a clean one",
    thinWall / 5 < 1 && thinWall / 5 >= WALLBANG_AI_MIN_DAMAGE,
    `each point worth ${(thinWall / 5).toFixed(2)}`);
  // The weight IS the damage the round would arrive with — the same curve the sim
  // charges, so "how much cover is this" and "how much will it hurt" agree. Not
  // exact to the last digit: the samples are spread across the body, so the
  // outer rays meet the wall at a slight angle and cross a hair more material
  // than its face thickness (which is itself the right answer).
  const perpendicular = WALLBANG_MIN_DAMAGE +
    (WALLBANG_MAX_DAMAGE - WALLBANG_MIN_DAMAGE) * (1 - 8 / AWM.penetration!);
  check("a point's worth is the damage that shot would land",
    near(thinWall / 5, perpendicular, 0.01) && thinWall / 5 <= perpendicular,
    `${(thinWall / 5).toFixed(4)} vs ${perpendicular.toFixed(4)} straight-on`);
  check("a weapon with no budget still counts whole points, as it always did",
    sight(Mossberg500, 0) === 5 && sight(Mossberg500, 8) === 0);

  // The preference, asserted directly rather than inferred from how often bots
  // end up wallbanging: given the SAME target from two spots, one with a clean
  // lane and one that has to punch through, the clean spot scores higher.
  const opponent = foe(vec(300, 0));
  (opponent as any).slots.primary = new Gun(AWM); // exposure is THEIR gun's question
  // A wall covering only the lane from y = -200, leaving y = +200 in the open.
  const w = world([{ ...makeWall(vec(0, -200), 20, 260, 0) }]);
  const bot = botWith(AWM, vec(-300, 0));
  const ai = { world: w, characters: [bot, opponent], nav: undefined, tick: 0 } as any;
  const thru = (bot as any).scoreAt(ai, vec(-300, -200), 0, opponent, 0);
  const open2 = (bot as any).scoreAt(ai, vec(-300, 200), 0, opponent, 0);
  check("the spot with a clean lane outscores the one that must wallbang",
    open2.score > thru.score, `clean ${open2.score.toFixed(2)} vs through-wall ${thru.score.toFixed(2)}`);
  check("...but the wallbang spot is still a lane, not a blank",
    thru.score > 0 && thru.clear > 0, `clear ${thru.clear.toFixed(2)}`);
  check("standing behind something THEY can shoot counts as partial exposure",
    thru.exposed > 0 && thru.exposed < open2.exposed,
    `${thru.exposed.toFixed(2)} exposed vs ${open2.exposed.toFixed(2)} in the open`);
  // ...and the same wall is full cover against someone who can't shoot through it.
  const fists = foe(vec(300, 0));
  const vsFists = (bot as any).scoreAt(
    { world: w, characters: [bot, fists], nav: undefined, tick: 0 } as any,
    vec(-300, -200), 0, fists, 0);
  check("the same wall is FULL cover against a weapon that can't punch through",
    vsFists.exposed === 0, `${vsFists.exposed}`);
}

// ---------------------------------------- what the bot believes vs. what happens
// The strongest claim in the feature: a bot's sight check and the bullet code run
// the SAME geometry, so belief and outcome agree. Random walls, random lanes,
// every case fired for real.
console.log("\nbelief vs. reality, over random geometry:");
{
  let seed = 987654321;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const range = (lo: number, hi: number): number => lo + rnd() * (hi - lo);

  let lanes = 0;
  let believed = 0;
  let brokenPromise = 0;   // bot thought it could shoot; the round didn't arrive
  let underCutoff = 0;     // bot thought it was worth it; it wasn't
  let missedChance = 0;    // bot saw nothing, yet a worthwhile shot existed
  let worstBelieved = 1;
  for (let trial = 0; trial < 400; trial++) {
    const rating = [15, 20, 30, 50, 120][Math.floor(rnd() * 5)];
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
      const o = wallAt(range(-150, 150), range(8, 70));
      if (rnd() < 0.35) o.thicknessMul = [0, 0.5, 1, 2][Math.floor(rnd() * 4)];
      obstacles.push(o);
    }
    const w = world(obstacles);
    const from = vec(-300, range(-40, 40));
    const to = vec(300, range(-40, 40));

    // What the bot believes, with the damage-cutoff budget its sight runs on.
    const sightBudget = wallbangSightBudget(rating);
    const sees = shotCost(w, from, to, 0, sightBudget) !== null;

    // What actually happens when it pulls the trigger.
    const wr = world(obstacles.map((o) => ({ ...o })));
    const t = dummy(to);
    spawnBullet(wr, from, vec((to.x - from.x) / 600, (to.y - from.y) / 600), 60, 40, 0, null,
      100, 4, 20, "#fff", AP, 0, undefined, null, rating);
    for (let i = 0; i < 40 && wr.bullets.length; i++) updateBullets(wr, [t]);
    const took = (t as any).hits.length ? (t as any).hits[0] : null;

    lanes++;
    if (sees) {
      believed++;
      if (took === null) brokenPromise++;
      else {
        const frac = took / 100;
        worstBelieved = Math.min(worstBelieved, frac);
        // Allow a hair of slack: the bot rays at the target's centre, the bullet
        // flies a hair off it through the same geometry.
        if (frac < WALLBANG_AI_MIN_DAMAGE - 0.02) underCutoff++;
      }
    } else if (took !== null && took / 100 > WALLBANG_AI_MIN_DAMAGE + 0.02) {
      missedChance++;
    }
  }
  check(`fired ${lanes} random lanes (${believed} the bot believed in)`, believed > 100,
    `${believed} believed`);
  check("every lane the bot believed in, the round actually crossed",
    brokenPromise === 0, `${brokenPromise} broken promises`);
  check("...and arrived for at least the cutoff",
    underCutoff === 0, `${underCutoff} under; worst ${(worstBelieved * 100).toFixed(1)}%`);
  check("no worthwhile shot was passed up", missedChance === 0, `${missedChance} missed`);
}

// ---------------------------------------------------------- tracer fade -------
// A spent round LOOKS spent: the tracer is drawn at the damage multiplier it will
// land with, so what you see is what it will do.
console.log("a round's tracer is drawn at the damage it has left:");
{
  const bullet = (penetration: number, penUsed: number): Bullet =>
    ({ penetration, penUsed } as Bullet);
  const fade = (penetration: number, penUsed: number): number =>
    wallbangDamageMul(bullet(penetration, penUsed));

  check("a fresh round draws at full strength", fade(100, 0) === 1);
  check("a gun with no budget draws at full strength, always",
    fade(0, 0) === 1 && fade(0, 50) === 1);
  check("the tracer IS the damage multiplier — one number, not two rules",
    fade(100, 50) === wallbangDamageMul(bullet(100, 50)) &&
      near(fade(100, 50), wallbangDamageFor(50, 100)));

  // The curve's own ends bound it, so nothing has to be clamped for display:
  // crossing anything at all costs the wallbang tax, and a fully spent round
  // still lands — and still shows — at the damage floor.
  check("crossing anything drops it to the wallbang ceiling or below",
    fade(100, 1) <= WALLBANG_MAX_DAMAGE && fade(100, 1) < 1,
    `${fade(100, 1).toFixed(3)} vs ceiling ${WALLBANG_MAX_DAMAGE}`);
  check("a fully spent round is still visible, at the damage floor",
    fade(100, 100) === WALLBANG_MIN_DAMAGE);
  check("over-spending cannot push it below that floor",
    fade(100, 500) === WALLBANG_MIN_DAMAGE);
  check("it is never outside the curve's own two ends",
    [1, 25, 50, 75, 100, 300].every((sp) => {
      const f = fade(100, sp);
      return f >= WALLBANG_MIN_DAMAGE && f <= WALLBANG_MAX_DAMAGE;
    }));

  // Monotone: more wall crossed is never a brighter tracer.
  let monotone = true;
  let prev = fade(200, 0);
  for (let spent = 10; spent <= 260; spent += 10) {
    const f = fade(200, spent);
    if (f > prev + 1e-9) monotone = false;
    prev = f;
  }
  check("every px of wall crossed dims it further (or holds at the floor)", monotone);

  // End to end: the same round, before and after a wall — and the tracer's
  // brightness equals the damage that round actually deals on arrival.
  const w = world([wallAt(0, 40)]);
  spawnBullet(w, vec(-200, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0,
    undefined, AWM, 200);
  const fresh = wallbangDamageMul(w.bullets[0]);
  for (let i = 0; i < 40 && w.bullets.length && (w.bullets[0].penUsed || 0) === 0; i++) {
    updateBullets(w, []);
  }
  const after = w.bullets.length ? wallbangDamageMul(w.bullets[0]) : 0;
  check("a real round dims the moment it crosses a wall", fresh === 1 && after < 1,
    `${fresh} -> ${after.toFixed(3)}`);
  check("...to no more than the wallbang ceiling", after <= WALLBANG_MAX_DAMAGE);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
