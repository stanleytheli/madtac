/**
 * Verifies per-round ("perBullet") reloading: a pump-shotgun-style Gun tops its
 * mag off one round at a time, auto-cycling until full / dry / cancelled, draining
 * the reserve as a spare-ROUND pool — while a normal gun keeps its whole-mag swap.
 * Also checks Character.cancelAction() aborts a reload, and the new Mossberg500 is
 * a registered, per-bullet spec.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_perbullet.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vpb.mjs && node <tmp>/vpb.mjs
 */
import { Gun } from "../src/entities/gun.ts";
import { Mossberg500, AK47, UNARMED } from "../src/entities/guns.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};

/** Advance a gun n ticks. */
function tick(g: Gun, n: number): void {
  for (let i = 0; i < n; i++) g.tick();
}

// ---------------------------------------------------------------- spec ---------
console.log("Mossberg500 spec — registered per-bullet shotgun:");
{
  check("registered in GUN_SPECS", GUN_SPECS.Mossberg500 === Mossberg500);
  check("is per-bullet", Mossberg500.fire!.perBullet === true);
  check("AK47 is NOT per-bullet", !AK47.fire!.perBullet);
}

// ------------------------------------------------ per-bullet full top-off ------
console.log("perBullet: one reload tops the mag off round by round to full:");
{
  const g = new Gun(Mossberg500);
  const f = Mossberg500.fire!;
  g.mag = 0;
  g.reserveMags = 10; // plenty of spare shells
  check("starts empty", g.mag === 0);

  g.startReload();
  check("reload started", g.reloading);

  // One cycle chambers exactly one shell.
  tick(g, f.reloadTime);
  check("after one cycle: +1 round", g.mag === 1, `mag=${g.mag}`);
  check("one shell drained from reserve", g.reserveMags === 9, `res=${g.reserveMags}`);
  check("still reloading (auto-cycling)", g.reloading);

  // Second cycle.
  tick(g, f.reloadTime);
  check("after two cycles: +2 rounds", g.mag === 2, `mag=${g.mag}`);

  // Run the rest to completion.
  tick(g, f.reloadTime * (f.magSize - 2));
  check("mag filled to capacity", g.mag === f.magSize, `mag=${g.mag}`);
  check("stops reloading once full", !g.reloading);
  check("reserve drained by exactly magSize shells", g.reserveMags === 10 - f.magSize, `res=${g.reserveMags}`);
}

// ------------------------------------------------ per-bullet runs dry ----------
console.log("perBullet: auto-cycle stops when spare rounds run out (mag partial):");
{
  const g = new Gun(Mossberg500);
  const f = Mossberg500.fire!;
  g.mag = 0;
  g.reserveMags = 3; // fewer shells than the tube holds
  g.startReload();
  tick(g, f.reloadTime * 3);
  check("loaded exactly the 3 available shells", g.mag === 3, `mag=${g.mag}`);
  check("reserve now empty", g.reserveMags === 0, `res=${g.reserveMags}`);
  check("not reloading (nothing left to load)", !g.reloading);
  check("cannot reload with an empty reserve", !g.canReload);

  // A couple more ticks must not resurrect the cycle or overflow the mag.
  tick(g, f.reloadTime * 2);
  check("mag unchanged after dry", g.mag === 3, `mag=${g.mag}`);
}

// ------------------------------------------------ mid-reload cancel ------------
console.log("perBullet: cancel mid-top-off keeps the rounds already chambered:");
{
  const g = new Gun(Mossberg500);
  const f = Mossberg500.fire!;
  g.mag = 0;
  g.reserveMags = 10;
  g.startReload();
  tick(g, f.reloadTime * 2 + 5); // two shells in, part way into the third
  check("two shells chambered so far", g.mag === 2, `mag=${g.mag}`);
  g.cancelReload();
  check("cancel stops the reload", !g.reloading);
  tick(g, f.reloadTime * 2);
  check("no further shells after cancel", g.mag === 2, `mag=${g.mag}`);
  check("reserve only spent on chambered shells", g.reserveMags === 8, `res=${g.reserveMags}`);
  check("partial mag is usable (can fire)", g.canFire);
}

// ------------------------------------------ perBullet: click-to-fire cancels ---
console.log("perBullet: firing mid-top-off cancels the reload (mag not empty):");
{
  const world = { bullets: [] as any[], events: [] as any[] } as any;
  const owner = { z: 0, pos: vec(0, 0) } as any;
  const g = new Gun(Mossberg500);
  g.mag = 2; // partway topped off
  g.reserveMags = 8;
  g.drawTicks = 0;
  g.startReload();
  check("reloading before the shot", g.reloading);

  const fired = g.fire(world, vec(0, 0), vec(1, 0), owner, 0);
  check("fire() succeeded mid-reload", fired === true);
  check("reload was cancelled by the shot", !g.reloading);
  check("a round was spent", g.mag === 1, `mag=${g.mag}`);
  check("shotgun pellets went out", world.bullets.length === Mossberg500.shotgunPellets, `n=${world.bullets.length}`);
}

console.log("perBullet: an EMPTY mag can't fire-cancel (reload commits):");
{
  const world = { bullets: [] as any[], events: [] as any[] } as any;
  const owner = { z: 0, pos: vec(0, 0) } as any;
  const g = new Gun(Mossberg500);
  g.mag = 0; // nothing chambered
  g.reserveMags = 8;
  g.drawTicks = 0;
  g.startReload();
  const fired = g.fire(world, vec(0, 0), vec(1, 0), owner, 0);
  check("fire() blocked with an empty mag", fired === false);
  check("reload still running (not cancelled)", g.reloading);
  check("no pellets went out", world.bullets.length === 0, `n=${world.bullets.length}`);
}

console.log("normal gun: firing does NOT interrupt its reload:");
{
  const world = { bullets: [] as any[], events: [] as any[] } as any;
  const owner = { z: 0, pos: vec(0, 0) } as any;
  const g = new Gun(AK47);
  g.mag = 10; // has rounds, but mid whole-mag reload
  g.drawTicks = 0;
  g.startReload();
  const fired = g.fire(world, vec(0, 0), vec(1, 0), owner, 0);
  check("fire() blocked mid-reload (whole-mag commits)", fired === false);
  check("reload still running", g.reloading);
}

// ------------------------------------------------ normal gun unchanged ---------
console.log("normal gun: still a single whole-mag swap:");
{
  const g = new Gun(AK47);
  const f = AK47.fire!;
  g.mag = 3; // partial mag
  const res0 = g.reserveMags;
  g.startReload();
  tick(g, f.reloadTime - 1);
  check("mid-reload: mag not yet refilled", g.mag === 3, `mag=${g.mag}`);
  tick(g, 1);
  check("one reloadTime => full mag (swap, not per-round)", g.mag === f.magSize, `mag=${g.mag}`);
  check("exactly one whole mag consumed", g.reserveMags === res0 - 1, `res=${g.reserveMags}`);
  check("not still reloading", !g.reloading);
}

// ------------------------------------------------ Character.cancelAction -------
console.log("Character.cancelAction() aborts an in-progress reload:");
{
  const c = new Character(vec(0, 0), DEFAULT_SKIN, {
    primary: new Gun(Mossberg500),
    hand: new Gun(UNARMED),
  });
  c.gun.mag = 0;
  c.gun.reserveMags = 10;
  c.gun.drawTicks = 0; // skip the equip draw so a reload can start
  c.reload();
  check("reload running", c.gun.reloading);
  c.cancelAction();
  check("cancelAction stopped it", !c.gun.reloading);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
