/**
 * Verifies that a reload can only START once the fire delay has fully elapsed, so
 * reload-cancelling can no longer launder away the delay from the shot you just
 * took (`startReload` used to zero `fireCooldown` outright).
 *
 * Also pins the thing that made this fiddly: a `perBullet` gun's shell-by-shell
 * auto-cycle must survive the new gate. Mossberg500 chambers a shell in 40 ticks
 * but can only fire every 45, so gating the shared `canReload` predicate — rather
 * than just the start — would have stalled its chain.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_reload_gate.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vr.mjs && node <tmp>/vr.mjs
 */
import { Gun } from "../src/entities/gun.ts";
import { AWM, M16, Mossberg500 } from "../src/entities/guns.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
};

/** Put the gun in the state one shot leaves it in, without needing a World: the
 *  cooldown fire() sets, and a round off the mag. */
function afterShot(g: Gun): void {
  g.fireCooldown = g.spec.fire!.delay;
  g.mag -= 1;
}

console.log("\n--- the exploit: shoot, reload, cancel, shoot again ---");
{
  const g = new Gun(AWM); // delay 90, reloadTime 185 — the worst offender
  afterShot(g);
  const cd = g.fireCooldown;

  g.startReload();
  check("reload is refused while the fire delay is running", !g.reloading);
  check("fireCooldown is left alone by the refused reload", g.fireCooldown === cd, `${g.fireCooldown} vs ${cd}`);

  g.cancelReload(); // the cancel half of the exploit
  check("still cannot fire after the cancel", !g.canFire);

  // Walk out the delay one tick at a time and find when firing comes back.
  let waited = 0;
  while (!g.canFire && waited < 500) {
    g.tick();
    waited++;
  }
  check("full fire delay still had to be waited out", waited === cd, `waited ${waited}, delay ${cd}`);
}

console.log("\n--- a legitimate reload still works ---");
{
  const g = new Gun(M16);
  afterShot(g);
  for (let i = 0; i < g.spec.fire!.delay; i++) g.tick();
  check("fire delay has elapsed", g.fireCooldown === 0);
  g.startReload();
  check("reload starts once the delay is clear", g.reloading);

  const before = g.reserveMags;
  for (let i = 0; i < g.spec.fire!.reloadTime + 2; i++) g.tick();
  check("reload completed", !g.reloading);
  check("mag refilled", g.mag === g.spec.fire!.magSize, `mag ${g.mag}`);
  check("one spare consumed", g.reserveMags === before - 1, `${g.reserveMags} vs ${before - 1}`);
}

console.log("\n--- reloading from a dry mag (the AI's path) is not blocked forever ---");
{
  const g = new Gun(AWM);
  g.mag = 0;
  g.fireCooldown = g.spec.fire!.delay;
  g.startReload();
  check("dry gun still waits out the delay", !g.reloading);
  for (let i = 0; i < g.spec.fire!.delay; i++) g.tick();
  g.startReload();
  check("dry gun reloads once the delay clears", g.reloading);
}

console.log("\n--- perBullet auto-cycle survives (reloadTime 40 < delay 45) ---");
{
  const g = new Gun(Mossberg500);
  const f = g.spec.fire!;
  check("Mossberg reloads a shell faster than it fires", f.reloadTime < f.delay, `${f.reloadTime} vs ${f.delay}`);

  // Empty the mag the way firing would, then wait out the last shot's delay.
  const startReserve = g.reserveMags;
  g.mag = 0;
  g.fireCooldown = f.delay;
  for (let i = 0; i < f.delay; i++) g.tick();

  g.startReload();
  check("pump reload starts", g.reloading);

  // One startReload should chamber shell after shell without further input.
  for (let i = 0; i < f.reloadTime * (f.magSize + 2); i++) g.tick();
  check("mag filled shell by shell from ONE startReload", g.mag === f.magSize, `mag ${g.mag}/${f.magSize}`);
  check(
    "spares drained per shell",
    g.reserveMags === startReserve - f.magSize,
    `${g.reserveMags} vs ${startReserve - f.magSize}`,
  );
  check("chain ended cleanly", !g.reloading);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
