/**
 * Verifies the two things the kill feed newly has to say: that a round came
 * through a wall, and that somebody blew themselves up.
 *
 * The wallbang mark rides on a flag the victim records at the moment of the hit
 * (Character.lastAttackerWallbang), so this checks BOTH halves — that real
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
import { AWM, RPG, UNARMED } from "../src/entities/guns.ts";
import { Gun } from "../src/entities/gun.ts";
import { Character } from "../src/entities/actor.ts";
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
    bullets: [], projectiles: [], particles: [],
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
  check("a clean shot lands, and is not a wallbang", clean.hp < 100 && !clean.lastAttackerWallbang);
  const through = shoot([makeWall(vec(0, 0), 20, 400, 0)], 50);
  check("one that punched through a wall is", through.hp < 100 && through.lastAttackerWallbang,
    `hp ${through.hp}`);
  const stopped = shoot([makeWall(vec(0, 0), 200, 400, 0)], 50);
  check("one the wall stopped never reaches anyone", stopped.hp === 100);
  // A free-pass wall costs nothing, so nothing was punched through.
  const freeWall = { ...makeWall(vec(0, 0), 40, 400, 0), thicknessMul: 0 };
  const waved = shoot([freeWall], 50);
  check("a wall that costs nothing to cross is not a wallbang either",
    waved.hp < 100 && !waved.lastAttackerWallbang);

  // The flag is per-hit, not sticky: a later clean shot clears it.
  const w = world([makeWall(vec(0, 0), 20, 400, 0)]);
  const victim = body(vec(300, 0));
  spawnBullet(w, vec(-300, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0, undefined, AWM, 50);
  for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
  check("wallbanged once, flagged", victim.lastAttackerWallbang);
  spawnBullet(w, vec(200, 0), vec(1, 0), 60, 40, 0, null, 10, 4, 20, "#fff", AP, 0, undefined, AWM, 50);
  for (let i = 0; i < 40 && w.bullets.length; i++) updateBullets(w, [victim]);
  check("...then hit cleanly, the mark is gone", !victim.lastAttackerWallbang);
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
  check("a bot shot through a wall is marked", banged.hp < 100 && banged.lastAttackerWallbang,
    `hp ${banged.hp}`);
  const clean = bot();
  shootAt(clean, [], 50);
  check("a bot shot cleanly is not", clean.hp < 100 && !clean.lastAttackerWallbang);
  // Guard the general case rather than this one subclass: whatever a Character
  // subclass does on top, it has to hand the base class the whole hit.
  const direct = bot();
  direct.registerHit(vec(1, 0), direct.pos, 1, AP, null, AWM, true);
  check("...and an override forwards the flag it was given", direct.lastAttackerWallbang);
}

console.log("\nother ways of dying are never wallbangs:");
{
  const w = world();
  const victim = body(vec(0, 0));
  explode(w, vec(40, 0), 0, 50, 250, AP, null, [victim]);
  check("a blast is not a wallbang", victim.hp < 100 && !victim.lastAttackerWallbang);

  const w2 = world();
  const puncher = body(vec(0, 0));
  puncher.forward = vec(1, 0);
  const punched = body(vec(60, 0));
  puncher.fire(w2, [puncher, punched]);
  check("a punch is not a wallbang", punched.hp < 100 && !punched.lastAttackerWallbang);
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
    check("...and not marked a wallbang", entry?.wallbang === false);
    check("a self-kill credits nobody with a kill",
      (game.gamemode as any).agents?.every?.((a: any) => a.kills === 0) ?? true);
  }

  // A wallbanged kill on the player carries the mark into the feed.
  {
    const game = fresh();
    const p = game.player;
    const foe = game.characters.find((c) => c !== p)!;
    p.hp = 1;
    p.registerHit(vec(1, 0), p.pos, 500, AP, foe, AWM, true);
    check("the player went down to it", p.hp <= 0);
    game.update();
    const entry = game.killFeed.find((f) => !f.selfKill);
    check("the kill reaches the feed", !!entry, `${game.killFeed.length} entries`);
    check("...marked as a wallbang", entry?.wallbang === true);
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
    p.registerHit(vec(1, 0), p.pos, 500, AP, foe, AWM, false);
    game.update();
    check("a plain kill carries no mark",
      game.killFeed.find((f) => !f.selfKill)?.wallbang === false);
  }
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
