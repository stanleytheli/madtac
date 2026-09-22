/**
 * Verifies the two things the kill feed newly has to say: that a round came
 * through a wall, and that somebody blew themselves up.
 *
 * The wallbang mark rides on a flag the victim records at the moment of the hit
 * (Character.lastAttackerMarks), so this checks BOTH halves — that real
 * bullets set it only when they actually punched through something, and that a
 * lethal one turns into a feed entry carrying the mark.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_killfeed.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vkf.mjs && node <tmp>/vkf.mjs
 */
import { readFileSync } from "node:fs";
import {
  explode,
  makeWall,
  spawnBullet,
  updateBullets,
  type Obstacle,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { Game } from "../src/game.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { loadLevel } from "../src/world/level.ts";
import { AK47, AWM, M9, NOSCOPE_SPEED_RATIO, RPG, Scout, UNARMED, type GunSpec } from "../src/entities/guns.ts";
import { Gun } from "../src/entities/gun.ts";
import { Character } from "../src/entities/actor.ts";
import { Armor, type ArmorSpec } from "../src/entities/armor.ts";
import { ARMOR_SPECS } from "../src/entities/specs.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };
function world(obstacles: Obstacle[] = []): World {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], events: [],
  } as unknown as World;
  if (obstacles.length) (w as any).grid = new ObstacleGrid(obstacles);
  return w;
}
const body = (at: Vec2): Character => {
  const c = new Character(vec(at.x, at.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "red" as any;
  c.z = 0;
  return c;
};

// ------------------------------------------------- the flag on the victim -----
console.log("a victim records whether the round came through a wall:");
{
  const shoot = (obstacles: Obstacle[], penetration: number): Character => {
    const w = world(obstacles);
    const victim = body(vec(300, 0));
    spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0,
      undefined, AWM, penetration);
    for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
    return victim;
  };
  const clean = shoot([], 50);
  check("a clean shot lands, and is not a wallbang", clean.hp < 100 && !clean.lastAttackerMarks.throughWall);
  const through = shoot([makeWall(vec(0, 0), 20, 400, 0)], 50);
  check("one that punched through a wall is", through.hp < 100 && through.lastAttackerMarks.throughWall === true,
    `hp ${through.hp}`);
  const stopped = shoot([makeWall(vec(0, 0), 200, 400, 0)], 50);
  check("one the wall stopped never reaches anyone", stopped.hp === 100);
  // A free-pass wall costs nothing, so nothing was punched through.
  const freeWall = { ...makeWall(vec(0, 0), 40, 400, 0), thicknessMul: 0 };
  const waved = shoot([freeWall], 50);
  check("a wall that costs nothing to cross is not a wallbang either",
    waved.hp < 100 && !waved.lastAttackerMarks.throughWall);

  // The flag is per-hit, not sticky: a later clean shot clears it.
  const w = world([makeWall(vec(0, 0), 20, 400, 0)]);
  const victim = body(vec(300, 0));
  spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0, undefined, AWM, 50);
  for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
  check("wallbanged once, flagged", victim.lastAttackerMarks.throughWall === true);
  spawnBullet(w, vec(200, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0, undefined, AWM, 50);
  for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
  check("...then hit cleanly, the mark is gone", !victim.lastAttackerMarks.throughWall);
}

// The victims in a real match are TacOracles, not bare Characters, and TacOracle
// overrides registerHit to break its hold when shot. An override that forwards
// only the arguments it happens to care about silently drops the flag — which is
// exactly what happened, and why every bot death came back unmarked while the
// bare-Character tests above passed.
console.log("\nthe flag survives the subclass every real victim actually is:");
{
  const bot = () => {
    const t = new TacOracle(vec(300, 0), { team: "red", z: 0, realGun: true, stagger: 5 });
    t.z = 0;
    return t;
  };
  const shootAt = (victim: Character, obstacles: Obstacle[], penetration: number): void => {
    const w = world(obstacles);
    spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0,
      undefined, AWM, penetration);
    for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
  };
  const banged = bot();
  shootAt(banged, [makeWall(vec(0, 0), 20, 400, 0)], 50);
  check("a bot shot through a wall is marked", banged.hp < 100 && banged.lastAttackerMarks.throughWall === true,
    `hp ${banged.hp}`);
  const clean = bot();
  shootAt(clean, [], 50);
  check("a bot shot cleanly is not", clean.hp < 100 && !clean.lastAttackerMarks.throughWall);
  // Guard the general case rather than this one subclass: whatever a Character
  // subclass does on top, it has to hand the base class the whole hit.
  const direct = bot();
  direct.registerHit(vec(1, 0), direct.pos, 1, AP, null, AWM, { throughWall: true });
  check("...and an override forwards the flag it was given", direct.lastAttackerMarks.throughWall === true);
}

console.log("\nother ways of dying are never wallbangs:");
{
  const w = world();
  const victim = body(vec(0, 0));
  explode(w, vec(40, 0), 0, 50, 250, AP, null, [victim]);
  check("a blast is not a wallbang", victim.hp < 100 && !victim.lastAttackerMarks.throughWall);

  const w2 = world();
  const puncher = body(vec(0, 0));
  puncher.forward = vec(1, 0);
  const punched = body(vec(60, 0));
  puncher.fire(w2, [puncher, punched]);
  check("a punch is not a wallbang", punched.hp < 100 && !punched.lastAttackerMarks.throughWall);
}

// ----------------------------------------------------- into the feed ----------
console.log("\nthe feed itself, on a live match:");
{
  const fresh = () => {
    const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena.json", "utf8"));
    const mode = loaded.meta?.mode ?? DEFAULT_MODE;
    const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
    game.update(); // let the mode place everyone
    return game;
  };

  // Blowing yourself up: the victim is their own attacker.
  {
    const game = fresh();
    const p = game.player;
    explode(game.world, p.pos, p.z, 500, 250, AP, p, game.characters, undefined, undefined, RPG);
    check("the blast killed the player", p.hp <= 0, `hp ${p.hp}`);
    check("...and named them their own attacker", p.lastAttacker === p);
    game.update(); // the mode reaps the dead and writes the feed
    const entry = game.killFeed.find((f) => f.selfKill);
    check("a self-kill reaches the feed at all", !!entry, `${game.killFeed.length} entries`);
    check("...naming the same person both sides, for the HUD to collapse",
      entry?.killerName === entry?.victimName, `${entry?.killerName} / ${entry?.victimName}`);
    check("...and not marked a wallbang", entry?.marks.throughWall !== true);
    check("a self-kill credits nobody with a kill",
      (game.gamemode as any).agents?.every?.((a: any) => a.kills === 0) ?? true);
  }

  // A wallbanged kill on the player carries the mark into the feed.
  {
    const game = fresh();
    const p = game.player;
    const foe = game.characters.find((c) => c !== p)!;
    p.hp = 1;
    p.registerHit(vec(1, 0), p.pos, 500, AP, foe, AWM, { throughWall: true });
    check("the player went down to it", p.hp <= 0);
    game.update();
    const entry = game.killFeed.find((f) => !f.selfKill);
    check("the kill reaches the feed", !!entry, `${game.killFeed.length} entries`);
    check("...marked as a wallbang", entry?.marks.throughWall === true);
    check("...and not a self-kill", entry?.selfKill === false);
    check("...naming two different people", entry?.killerName !== entry?.victimName,
      `${entry?.killerName} / ${entry?.victimName}`);
  }

  // An ordinary kill is unmarked.
  {
    const game = fresh();
    const p = game.player;
    const foe = game.characters.find((c) => c !== p)!;
    p.hp = 1;
    p.registerHit(vec(1, 0), p.pos, 500, AP, foe, AWM, {});
    game.update();
    check("a plain kill carries no mark",
      game.killFeed.find((f) => !f.selfKill)?.marks.throughWall !== true);
  }
}

// ------------------------------------------------------------- noscope --------
// The game's no-scope: a sniper kill taken while moving at NOSCOPE_SPEED_RATIO or
// more of top speed. Earned by the SHOT, not by the hit — the round is still in
// the air long after the shooter has stopped.
console.log("\nno-scope: a sniper landed on the move:");
{
  /** Set a character moving at exactly `frac` of the top speed its loadout allows.
   *  Solved from the gun's own numbers with a unit probe rather than hardcoding a
   *  px/tick figure, so retuning weapon speeds can't quietly invalidate these. */
  const setSpeedRatio = (c: Character, frac: number): void => {
    c.vel = vec(1, 0);
    const perPx = c.speedRatio; // what 1 px/tick is worth for this loadout
    c.vel = vec(perPx > 0 ? frac / perPx : 0, 0);
  };
  /** Same probe, against the speed the character can ACTUALLY reach (armor and
   *  all) — which is what the no-scope threshold is measured in. */
  const setSpeedFraction = (c: Character, frac: number): void => {
    c.vel = vec(1, 0);
    const perPx = c.speedFraction;
    c.vel = vec(perPx > 0 ? frac / perPx : 0, 0);
  };
  const shooter = (spec: GunSpec, speedFrac: number, armor: ArmorSpec | null = null): Character => {
    const c = body(vec(-150, 0));
    c.team = "blue" as any;
    (c as any).slots.primary = new Gun(spec);
    c.equip("primary");
    if (armor) c.armor = new Armor(armor);
    while (c.gun.drawing) c.gun.tick(); // a gun being drawn cannot fire
    c.forward = vec(1, 0);
    setSpeedFraction(c, speedFrac);
    return c;
  };

  check("the snipers carry the flag", Scout.noscope === true && AWM.noscope === true);
  check("...and ordinary weapons do not",
    !AK47.noscope && !M9.noscope && !UNARMED.noscope);
  check("the threshold is half speed", NOSCOPE_SPEED_RATIO === 0.5);

  /** Fire `spec` at a victim with the shooter moving at `speedFrac` of top speed,
   *  then (optionally) stop dead before the round arrives. */
  const snipe = (spec: GunSpec, speedFrac: number, stopAfterFiring = false, armor: ArmorSpec | null = null) => {
    const w = world();
    const shot = shooter(spec, speedFrac, armor);
    // Close range on purpose: this is a test about the MARK, not about whether a
    // moving sniper can hit at range.
    const victim = body(vec(0, 0));
    const ratio = shot.speedFraction;
    shot.fire(w, [shot, victim]);
    // Whether the round is STAMPED is deterministic; whether it connects is not,
    // because firing on the move is exactly what widens the spray. Assert on the
    // stamp, and let the end-to-end checks below retry until one lands.
    const stamped = w.bullets.length > 0 && w.bullets.every((b) => b.noscope === true);
    if (stopAfterFiring) shot.vel = vec(0, 0);
    for (let i = 0; i < 60 && w.bullets.length; i++) updateBullets(w, [shot, victim]);
    return { victim, ratio, stamped, hit: victim.hp < 100 };
  };
  /** Keep taking the shot until one connects — a moving sniper misses a lot. */
  const snipeUntilHit = (spec: GunSpec, speedFrac: number) => {
    let last = snipe(spec, speedFrac);
    for (let i = 0; i < 60 && !last.hit; i++) last = snipe(spec, speedFrac);
    return last;
  };

  const moving = snipe(AWM, 1);
  check("a sniper fired at full tilt stamps the round", moving.stamped, `ratio ${moving.ratio.toFixed(2)}`);
  const landed = snipeUntilHit(AWM, 1);
  check("...and a landed one marks the victim",
    landed.hit && landed.victim.lastAttackerMarks.noscope === true);

  const still = snipeUntilHit(AWM, 0);
  check("standing still is not a no-scope",
    still.hit && !still.stamped && !still.victim.lastAttackerMarks.noscope);

  const crawling = snipeUntilHit(AWM, 0.2);
  check("...nor is a crawl under the threshold",
    crawling.hit && !crawling.stamped && !crawling.victim.lastAttackerMarks.noscope,
    `ratio ${crawling.ratio.toFixed(2)}`);

  // Right at the line: the threshold is inclusive, and a hair under it is not.
  check("exactly at the threshold counts", snipe(AWM, NOSCOPE_SPEED_RATIO).stamped);
  check("...a hair under it does not", !snipe(AWM, NOSCOPE_SPEED_RATIO - 0.01).stamped);

  const scout = snipeUntilHit(Scout, 1);
  check("the Scout earns it too", scout.hit && scout.victim.lastAttackerMarks.noscope === true);

  const smg = snipeUntilHit(AK47, 1);
  check("a non-sniper on the move earns nothing",
    smg.hit && !smg.stamped && !smg.victim.lastAttackerMarks.noscope);

  // The reason the flag is stamped at the muzzle: stopping mid-flight must not
  // take the mark away, and it would if the hit asked the shooter's speed.
  let stopped = snipe(AWM, 1, true);
  for (let i = 0; i < 60 && !stopped.hit; i++) stopped = snipe(AWM, 1, true);
  check("stopping before the round lands keeps the mark",
    stopped.hit && stopped.victim.lastAttackerMarks.noscope === true);

  // Armour slows you down, so "half speed" has to mean half of what YOU can do.
  // Measured against the gun alone (speedRatio), a Level V wearer at 0.75x tops
  // out at 0.75 and would need 67% of their own sprint while everyone else needed
  // 50% — the same input, a different rule per loadout.
  {
    const heavy = ARMOR_SPECS.ArmorV ?? Object.values(ARMOR_SPECS).find((a) => a.speed < 0.8)!;
    check("the test armour really is a slowdown", heavy.speed < 1, `${heavy.name} x${heavy.speed}`);

    // Just over half of what an armoured sniper can manage: a no-scope.
    check("an armoured sniper at 60% of ITS top speed earns the mark",
      snipe(AWM, 0.6, false, heavy).stamped);
    // The same shot measured the old way would be 0.6 * 0.75 = 0.45 — under the
    // bar, and silently unmarked.
    check("...which the gun-only measure would have called too slow",
      0.6 * heavy.speed < NOSCOPE_SPEED_RATIO, `${(0.6 * heavy.speed).toFixed(3)}`);

    // The threshold sits at the same place for everyone.
    for (const spec of Object.values(ARMOR_SPECS)) {
      const over = snipe(AWM, NOSCOPE_SPEED_RATIO + 0.02, false, spec);
      const under = snipe(AWM, NOSCOPE_SPEED_RATIO - 0.02, false, spec);
      check(`${spec.name} (x${spec.speed}): the bar is in the same place`,
        over.stamped && !under.stamped);
    }
    // ...and armour never makes it unreachable.
    check("full tilt in the heaviest armour is always a no-scope",
      snipe(AWM, 1, false, heavy).stamped);
  }

  // Marks are independent and can co-occur: a wallbanged no-scope carries both.
  const w = world([makeWall(vec(0, 0), 20, 400, 0)]);
  const both = body(vec(300, 0));
  spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0,
    undefined, AWM, 50, true);
  for (let i = 0; i < 60 && w.bullets.length; i++) updateBullets(w, [both]);
  check("a wallbanged no-scope carries BOTH marks",
    both.hp < 100 && both.lastAttackerMarks.throughWall === true &&
      both.lastAttackerMarks.noscope === true,
    JSON.stringify(both.lastAttackerMarks));

  // ...and reaches the feed as both.
  const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena.json", "utf8"));
  const mode = loaded.meta?.mode ?? DEFAULT_MODE;
  const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
  game.update();
  const p = game.player;
  const foe = game.characters.find((c) => c !== p)!;
  p.hp = 1;
  p.registerHit(vec(1, 0), p.pos, 500, AP, foe, AWM, { throughWall: true, noscope: true });
  game.update();
  const entry = game.killFeed.find((f) => !f.selfKill);
  check("the feed entry carries both marks",
    entry?.marks.throughWall === true && entry?.marks.noscope === true,
    JSON.stringify(entry?.marks));

  // Nothing leaks between hits: a clean shot after a marked one clears them.
  const w2 = world();
  const reused = body(vec(300, 0));
  reused.registerHit(vec(1, 0), reused.pos, 1, AP, null, AWM, { throughWall: true, noscope: true });
  spawnBullet(w2, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0, undefined, AK47, 0);
  for (let i = 0; i < 60 && w2.bullets.length; i++) updateBullets(w2, [reused]);
  check("a later plain hit clears both marks",
    !reused.lastAttackerMarks.throughWall && !reused.lastAttackerMarks.noscope,
    JSON.stringify(reused.lastAttackerMarks));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
