/**
 * Verifies that an aborted reload takes its sound with it.
 *
 * The reload clip is fitted to the gun's full reloadTime, so a reload that ends
 * early — X, a weapon switch, dropping the gun, or dying — used to leave it
 * clacking away with nothing behind it. Stopping it needs a way to name ONE play
 * (SoundHandle), which has to survive the voice pool recycling that slot into
 * somebody else's gunshot; the ABA case below is the point of the whole design.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_reloadsound.mts --bundle --platform=node
 *   --format=esm --banner:js="$(cat scripts/stub_audio_banner.js)"
 *   --outfile=<tmp>/vrs.mjs && node <tmp>/vrs.mjs
 */
import { readFileSync } from "node:fs";
import { playSound, preload, setListener, soundFile, stopSound, updateAudio } from "../src/engine/audio.ts";
import { Gun } from "../src/entities/gun.ts";
import { Character } from "../src/entities/character.ts";
import { Character as Actor } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { Game } from "../src/game.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { loadLevel } from "../src/world/level.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import type { World } from "../src/world/world.ts";
import { vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

const g = globalThis as any;
g.__decodeOk = true; // sounds must really start for any of this to mean anything
const voices = (): any[] => g.__voices();
const live = (): any[] => voices().filter((v: any) => v.source && !v.stopping);
const voiceOf = (h: number): any => voices().find((v: any) => v.id === h);
const settle = () => new Promise((r) => setTimeout(r, 0));
/** One game tick for `c`, with the audio clock moved on by the same 1/60s.
 *  Without that the context clock stands still, every same-file play lands inside
 *  the 40ms coalesce window and merges into the one before it — so a pump's
 *  second shell would report the FIRST shell's handle. */
const tick = (c: Actor): void => {
  c.tickWeapon();
  g.__advance(1 / 60);
};

setListener(vec(0, 0), 0);

// A gun that actually has a reload clip to cancel.
const RELOADER = Object.values(GUN_SPECS).find((s) => s.reloadSound && !s.fire?.perBullet)!;
const PUMP = Object.values(GUN_SPECS).find((s) => s.reloadSound && s.fire?.perBullet);
/** A gun with a bolt/pump cycle clip — the other ongoing action a shot starts. */
const CYCLER = Object.values(GUN_SPECS).find((s) => s.cycleSound && s.fireSound)!;
// Anything not cached plays as a 0 handle, so warm every clip these tests use.
preload(RELOADER.reloadSound!, "gunshot.wav", CYCLER.cycleSound!, CYCLER.fireSound!);
if (PUMP?.reloadSound) preload(PUMP.reloadSound);
await settle();
await settle();

// ------------------------------------------------------- handles, at the engine
console.log("a play can be named and stopped:");
{
  const h = playSound("gunshot.wav", { pos: vec(0, 0), z: 0 });
  check("playing something hands back a non-zero handle", h !== 0, `h=${h}`);
  check("...naming a voice that is actually playing", !!voiceOf(h)?.source);
  const h2 = playSound(RELOADER.reloadSound!, { pos: vec(0, 0), z: 0 });
  check("a second play gets a different handle", h2 !== 0 && h2 !== h, `${h} vs ${h2}`);

  stopSound(h);
  check("stopping it fades that voice", voiceOf(h)?.stopping === true);
  check("...toward silence, rather than cutting", voiceOf(h)?.gainNode.gain.value === 0);
  check("...and leaves the other one alone", voiceOf(h2)?.stopping === false);
  stopSound(h2);

  check("an unplayable sound hands back 0 (nothing to stop)",
    playSound("not-cached-at-all.wav", { pos: vec(0, 0), z: 0 }) === 0);
  check("...as does one out of earshot", playSound("gunshot.wav", { pos: vec(9e4, 0), z: 0 }) === 0);
}

// The reason handles are serials and not references: the pool recycles slots.
console.log("a stale handle can never cut somebody else's sound:");
{
  // A fresh pool, so the play below lands in slot 0 and the reclaimed slot is
  // unambiguously the one the NEXT play gets handed. (The allocator takes the
  // first free voice; with other tests' voices still fading, that need not be
  // the slot just freed, and the point here is specifically same-slot reuse.)
  g.__dropContext();
  const a = playSound("gunshot.wav", { pos: vec(0, 0), z: 0 });
  const slot = voiceOf(a);
  stopSound(a);
  g.__advance(1); // let the fade run out...
  updateAudio(); // ...and the slot be reclaimed
  check("the stopped voice is reclaimed", slot.source === null && slot.id === 0);

  // Something else now takes that very slot.
  const b = playSound("gunshot.wav", { pos: vec(0, 0), z: 0 });
  check("the freed slot is handed to the next play", voiceOf(b) === slot, `b=${b}`);
  check("the new play has its own handle", b !== a);
  stopSound(a); // the stale one
  check("stopping the STALE handle does not touch it", slot.stopping === false && slot.source !== null);
  stopSound(b);
  check("stopping the current handle does", slot.stopping === true);
  check("stopping 0 is a no-op", (stopSound(0), true));
}

// ---------------------------------------------------------------- the gun ----
console.log("a reload sounds, and the gun keeps the handle:");
const armed = (spec = RELOADER): Actor => {
  const c = new Actor(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.z = 0;
  (c as any).slots.primary = new Gun(spec);
  c.equip("primary");
  // equip() restarts the draw animation, and a gun being drawn cannot reload —
  // so tick it out first, or every reload below would silently never start.
  while (c.gun.drawing) c.gun.tick();
  c.gun.mag = 0; // empty, so a reload is allowed
  return c;
};
/** Start a reload and let the holder sound it (the pulse is read in tickWeapon). */
const startReloading = (c: Actor): number => {
  c.reload();
  c.tickWeapon();
  return c.gun.reloadVoice;
};
{
  const c = armed();
  const h = startReloading(c);
  check("the reload plays", h !== 0, `h=${h}`);
  check("...and the gun holds the handle", c.gun.reloadVoice === h);
  check("...for a voice that is really running", !!voiceOf(h)?.source && !voiceOf(h).stopping);
  stopSound(h);
}

console.log("every way of aborting one stops it:");
{
  // X / cancelAction
  let c = armed();
  let h = startReloading(c);
  c.cancelAction();
  check("X (cancelAction) stops the clip", voiceOf(h)?.stopping === true);
  check("...and clears the handle", c.gun.reloadVoice === 0);

  // Weapon switch
  c = armed();
  (c as any).slots.secondary = new Gun(UNARMED);
  const reloadingGun = c.gun;
  h = startReloading(c);
  c.equip("secondary");
  check("switching weapons stops it", voiceOf(h)?.stopping === true);
  check("...and clears the handle on the gun that was reloading", reloadingGun.reloadVoice === 0);

  // Dropping the gun
  c = armed();
  h = startReloading(c);
  c.dropEquipped();
  check("dropping the gun stops it", voiceOf(h)?.stopping === true);

  // A reload that COMPLETES must not be cut short — it ends on its own.
  c = armed();
  h = startReloading(c);
  for (let i = 0; i < RELOADER.fire!.reloadTime + 2; i++) tick(c);
  check("a reload that finishes normally is NOT cut off", voiceOf(h)?.stopping !== true);
  check("...but the spent handle is dropped", c.gun.reloadVoice === 0);
  check("...and the mag is full (the reload really did land)", c.gun.mag === RELOADER.fire!.magSize);
}

// A pump gun re-sounds per shell; each shell's clip is the one an abort cuts.
if (PUMP) {
  console.log("a per-shell reload cancels only the shell in progress:");
  const c = armed(PUMP);
  const first = startReloading(c);
  for (let i = 0; i < PUMP.fire!.reloadTime + 1; i++) tick(c);
  const second = c.gun.reloadVoice;
  check("the next shell starts its own clip", second !== 0 && second !== first, `${first} -> ${second}`);
  c.cancelAction();
  check("aborting stops the shell in progress", voiceOf(second)?.stopping === true);
}

// ------------------------------------------------------------ cycle sound ----
// A bolt/pump cycle is an ongoing action like a reload, so an interruption cuts
// it. The SHOT is not: the round is already gone, and a report chopped off
// mid-bang reads as a glitch rather than as an interruption.
console.log("the bolt cycle is cut short too — but never the shot:");
{
  const world = (): World => {
    const w = {
      obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [],
      bullets: [], projectiles: [], particles: [],
    } as unknown as World;
    (w as any).grid = new ObstacleGrid([]);
    return w;
  };
  const loaded = (): Actor => {
    const c = armed(CYCLER);
    c.gun.mag = CYCLER.fire!.magSize; // armed() empties it for the reload tests
    return c;
  };
  /** The live voice playing `file`, if any. */
  const playing = (file: string): any =>
    voices().find((v: any) => v.file === soundFile(file) && v.source && !v.stopping);

  let c = loaded();
  const fired = c.fire(world(), []);
  check("the test gun fires", fired);
  check("the shot starts a cycle clip the gun keeps a handle on", c.gun.cycleVoice !== 0,
    `h=${c.gun.cycleVoice}`);
  check("...and the report is playing alongside it", !!playing(CYCLER.fireSound!));

  const cyc = c.gun.cycleVoice;
  const report = playing(CYCLER.fireSound!);
  c.cancelAction();
  check("an interruption cuts the cycle", voiceOf(cyc)?.stopping === true);
  check("...and clears its handle", c.gun.cycleVoice === 0);
  check("...but leaves the shot to finish sounding", report.stopping === false);

  // Switching weapons and dying use the same chokepoint.
  c = loaded();
  (c as any).slots.secondary = new Gun(UNARMED);
  c.fire(world(), []);
  const onSwitch = c.gun.cycleVoice;
  c.equip("secondary");
  check("switching weapons cuts the old gun's cycle", voiceOf(onSwitch)?.stopping === true);

  c = loaded();
  c.fire(world(), []);
  const onDrop = c.gun.cycleVoice;
  c.dropEquipped();
  check("dropping the gun cuts it", voiceOf(onDrop)?.stopping === true);
}

// ------------------------------------------------------------------ death ----
// The one route that never went through cancelReload: the corpse leaves the
// character list and simply stops ticking.
console.log("dying mid-reload stops it too:");
{
  const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena-big.json", "utf8"));
  const mode = loaded.meta.mode ?? "tdm";
  const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
  game.update();

  const victim = game.characters.find((c) => c !== game.player) ?? game.player;
  (victim as any).slots.primary = new Gun(RELOADER);
  victim.equip("primary");
  victim.gun.mag = 0;
  const h = startReloading(victim as unknown as Actor);
  check("the victim is reloading audibly", h !== 0 && voiceOf(h)?.stopping === false, `h=${h}`);

  victim.hp = 0;
  game.update(); // reapDead runs here
  check("the corpse is gone from the roster", !game.characters.includes(victim));
  check("...and its reload clip was stopped, not left to play out",
    voiceOf(h)?.stopping === true || voiceOf(h) === undefined,
    `stopping=${voiceOf(h)?.stopping}`);
  check("...with nothing of it still live", !live().some((v) => v.id === h));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
