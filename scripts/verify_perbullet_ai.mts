/**
 * Verifies how a TacOracle handles a perBullet (pump-shotgun) weapon, whose
 * reload economics invert the normal ones: a cycle banks a single shell and
 * `Gun.fire` interrupts it for free, so the bot should top the tube off in every
 * lull instead of only reloading dry — and should still shoot the instant an
 * enemy appears, cancelling the cycle mid-way.
 *
 * The contrast cases with a normal mag-swap gun (AK47) are the point: the same
 * code must NOT start topping off a rifle with a partial mag, because a hardcore
 * swap bins whatever is left in it.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_perbullet_ai.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vp.mjs && node <tmp>/vp.mjs
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { AK47, Mossberg500, UNARMED } from "../src/entities/guns.ts";
import type { GunSpec } from "../src/entities/guns.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "  ok" : "FAIL"}  ${name}${extra ? `   — ${extra}` : ""}`);
};

/** A blue TacOracle holding `spec`, with reactions instant so mode flips land
 *  on the same tick we can observe them. */
function bot(spec: GunSpec): TacOracle {
  const b = new TacOracle(vec(0, 0), { team: "blue", z: 0, realGun: true, stagger: 1, reactionTime: 0 });
  (b as any).slots.primary = new Gun(spec);
  b.equip("primary");
  return b;
}

function enemy(x: number, y: number): Character {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "red";
  c.z = 0;
  return c;
}

/** Drive the private bookkeeping directly — this is the unit under test. */
const step = (b: TacOracle, target: Character | null): void =>
  (b as any).updateMode(target, target);

console.log("\nperBullet, no enemy in sight -> tops off from a partial tube:");
{
  const b = bot(Mossberg500);
  const g = b.gun;
  const f = g.spec.fire!;
  g.mag = f.magSize - 3; // fired a few, nobody around

  step(b, null);
  check("reload started with a partial mag", g.reloading, `mag ${g.mag}/${f.magSize}`);

  // Run it out; one startReload should chain shells until the tube is full.
  const before = g.reserveMags;
  for (let i = 0; i < f.reloadTime * 6; i++) {
    g.tick();
    step(b, null);
  }
  check("tube filled without further prompting", g.mag === f.magSize, `mag ${g.mag}/${f.magSize}`);
  check("three shells consumed", g.reserveMags === before - 3, `${g.reserveMags} vs ${before - 3}`);
  check("not stuck reloading a full tube", !g.reloading);
}

console.log("\nnormal mag-swap gun, no enemy -> does NOT bin a partial mag:");
{
  const b = bot(AK47);
  const g = b.gun;
  g.mag = g.spec.fire!.magSize - 3;
  for (let i = 0; i < 5; i++) {
    g.tick();
    step(b, null);
  }
  check("partial mag left alone", !g.reloading, `mag ${g.mag}`);

  g.mag = 0; // dry is the one case it does swap
  step(b, null);
  check("dry rifle still reloads", g.reloading);
}

console.log("\nperBullet mid-top-off + enemy appears -> stays live, shoots through it:");
{
  const b = bot(Mossberg500);
  const g = b.gun;
  g.mag = 2; // shells up: interruptible

  step(b, null);
  check("topping off with rounds chambered", g.reloading);
  check("a loaded top-off does NOT count as out of action", (b as any).reloadBlocksFire === false);
  check("still reads as ready to fire", (b as any).fireOk === true);

  const e = enemy(300, 0);
  step(b, e);
  check("combat mode stays SHOOT with an enemy up", (b as any).combatMode === "shoot");

  // What actually breaks the cycle is the shot itself (Gun.fire cancels it).
  (g as any).cancelReload();
  check("cycle interruptible at zero cost", !g.reloading && g.mag === 2, `mag ${g.mag}`);
}

console.log("\nperBullet DRY -> genuinely out of action, ducks to cover:");
{
  const b = bot(Mossberg500);
  const g = b.gun;
  g.mag = 0;

  step(b, null);
  check("dry gun reloads", g.reloading);
  check("dry reload DOES count as out of action", (b as any).reloadBlocksFire === true);

  const e = enemy(300, 0);
  step(b, e);
  check("drops to COVER rather than holding a lane empty", (b as any).combatMode === "cover");
}

console.log("\nperBullet with an enemy visible -> does not start a fresh top-off:");
{
  const b = bot(Mossberg500);
  const g = b.gun;
  const f = g.spec.fire!;
  g.mag = f.magSize - 2;
  const e = enemy(300, 0);
  for (let i = 0; i < 10; i++) {
    g.tick();
    step(b, e);
  }
  check("holds its partial tube while engaged", !g.reloading, `mag ${g.mag}/${f.magSize}`);
}

console.log("\nmag-swap gun mid-reload -> still ducks (unchanged behaviour):");
{
  const b = bot(AK47);
  const g = b.gun;
  g.mag = 0;
  step(b, null);
  check("rifle reloading", g.reloading);
  check("rifle reload counts as out of action", (b as any).reloadBlocksFire === true);
  const e = enemy(300, 0);
  step(b, e);
  check("rifle drops to COVER through the swap", (b as any).combatMode === "cover");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
