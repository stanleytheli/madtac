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
// The sim no longer plays anything: a reload, a bolt cycle and a shot go out as
// sound EVENTS (see engine/events.ts), an ongoing one named by the gun's voice
// so an abort can emit a stopSound for it. The audio side is exercised at the
// end, through the SoundPlayer that turns those events into the handles above.
import { emitSound, type GameEvent } from "../src/engine/events.ts";
import { SoundPlayer } from "../src/engine/effects.ts";
import type { SoundRef } from "../src/engine/audio.ts";

type SoundEv = Extract<GameEvent, { kind: "sound" }>;
const sounds = (evs: GameEvent[]): SoundEv[] => evs.filter((e): e is SoundEv => e.kind === "sound");
const stops = (evs: GameEvent[]): string[] => evs.filter((e) => e.kind === "stopSound").map((e) => (e as any).voice);
const file = (r: SoundRef) => soundFile(r);

console.log("a reload sounds, named by the gun's voice:");
const armed = (spec = RELOADER): Actor => {
  const c = new Actor(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.z = 0;
  (c as any).slots.primary = new Gun(spec);
  c.equip("primary");
  // equip() restarts the draw animation, and a gun being drawn cannot reload —
  // so tick it out first, or every reload below would silently never start.
  while (c.gun.drawing) c.gun.tick();
  c.gun.mag = 0; // empty, so a reload is allowed
  c.events.length = 0; // forget the equip's own events
  return c;
};
/** Start a reload and let the holder sound it (the pulse is read in tickWeapon).
 *  Returns the sound event it emitted, if any. */
const startReloading = (c: Actor): SoundEv | undefined => {
  c.events.length = 0;
  c.reload();
  c.tickWeapon();
  return sounds(c.events).find((e) => file(e.sound) === file(RELOADER.reloadSound!) || file(e.sound) === file(PUMP?.reloadSound ?? "") );
};
{
  const c = armed();
  const ev = startReloading(c);
  check("the reload is asked for", !!ev, JSON.stringify(c.events));
  check("...at the holder's position", !!ev && ev.pos === c.pos && ev.z === c.z);
  check("...named by the gun's reload voice", ev?.voice === c.gun.reloadVoice, `voice=${ev?.voice}`);
  check("...which is derived from the gun's id", c.gun.reloadVoice === `reload:${c.gun.id}`);
  check("and nothing was stopped", stops(c.events).length === 0);
}

console.log("every way of aborting one asks for it to stop:");
{
  // X / cancelAction
  let c = armed();
  startReloading(c);
  c.events.length = 0;
  c.cancelAction();
  check("X (cancelAction) stops the clip", stops(c.events).includes(c.gun.reloadVoice), JSON.stringify(c.events));

  // Weapon switch
  c = armed();
  (c as any).slots.secondary = new Gun(UNARMED);
  const reloadingGun = c.gun;
  startReloading(c);
  c.events.length = 0;
  c.equip("secondary");
  check("switching weapons stops it, on the gun that was reloading",
    stops(c.events).includes(reloadingGun.reloadVoice), JSON.stringify(c.events));

  // Dropping the gun
  c = armed();
  const dropping = c.gun;
  startReloading(c);
  c.events.length = 0;
  c.dropEquipped();
  check("dropping the gun stops it", stops(c.events).includes(dropping.reloadVoice));

  // A reload that COMPLETES must not be cut short — it ends on its own.
  c = armed();
  startReloading(c);
  c.events.length = 0;
  for (let i = 0; i < RELOADER.fire!.reloadTime + 2; i++) tick(c);
  check("a reload that finishes normally is NOT cut off", stops(c.events).length === 0, JSON.stringify(c.events));
  check("...and the mag is full (the reload really did land)", c.gun.mag === RELOADER.fire!.magSize);
}

// A pump gun re-sounds per shell; each shell's clip is the one an abort cuts.
if (PUMP) {
  console.log("a per-shell reload sounds each shell, and cancels the one in progress:");
  const c = armed(PUMP);
  const first = startReloading(c);
  c.events.length = 0;
  for (let i = 0; i < PUMP.fire!.reloadTime + 1; i++) tick(c);
  const second = sounds(c.events).find((e) => e.voice === c.gun.reloadVoice);
  check("the next shell asks for its own clip, under the same voice", !!first && !!second && second !== first);
  c.events.length = 0;
  c.cancelAction();
  check("aborting stops the shell in progress", stops(c.events).includes(c.gun.reloadVoice));
}

// ------------------------------------------------------------ cycle sound ----
// A bolt/pump cycle is an ongoing action like a reload, so an interruption cuts
// it. The SHOT is not: the round is already gone, and a report chopped off
// mid-bang reads as a glitch rather than as an interruption — so the report
// goes out with no voice, and nothing can ever name it to stop it.
console.log("the bolt cycle is named — but never the shot:");
{
  const world = (): World => {
    const w = {
      obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [],
      bullets: [], projectiles: [], particles: [], decals: [], events: [],
    } as unknown as World;
    (w as any).grid = new ObstacleGrid([]);
    return w;
  };
  const loaded = (): Actor => {
    const c = armed(CYCLER);
    c.gun.mag = CYCLER.fire!.magSize; // armed() empties it for the reload tests
    return c;
  };

  let c = loaded();
  let w = world();
  c.events = w.events; // as Game.addCharacter would: one sink for the character and its world
  const fired = c.fire(w, []);
  check("the test gun fires", fired);
  const cyc = sounds(w.events).find((e) => file(e.sound) === file(CYCLER.cycleSound!));
  const report = sounds(w.events).find((e) => file(e.sound) === file(CYCLER.fireSound!));
  check("the shot asks for the cycle clip under the gun's cycle voice", cyc?.voice === c.gun.cycleVoice, JSON.stringify(w.events));
  check("...and the report alongside it, with NO voice", !!report && report.voice === undefined);

  w.events.length = 0;
  c.cancelAction();
  check("an interruption stops the cycle", stops(w.events).includes(c.gun.cycleVoice));
  check("...and names nothing else (the shot cannot be cut)",
    stops(w.events).every((v) => v === c.gun.cycleVoice || v === c.gun.reloadVoice));

  // Switching weapons and dying use the same chokepoint.
  c = loaded();
  w = world();
  c.events = w.events;
  (c as any).slots.secondary = new Gun(UNARMED);
  c.fire(w, []);
  const old = c.gun;
  w.events.length = 0;
  c.equip("secondary");
  check("switching weapons stops the old gun's cycle", stops(w.events).includes(old.cycleVoice));

  c = loaded();
  w = world();
  c.events = w.events;
  c.fire(w, []);
  const dropped = c.gun;
  w.events.length = 0;
  c.dropEquipped();
  check("dropping the gun stops it", stops(w.events).includes(dropped.cycleVoice));
}

// ------------------------------------------------------------------ death ----
// The one route that never went through cancelReload: the corpse leaves the
// character list and simply stops ticking. Through the Game, so the character's
// sink is the world's (Game.addCharacter) and reapDead's abort lands there.
console.log("dying mid-reload stops it too:");
{
  const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena-big.json", "utf8"));
  const mode = loaded.meta.mode ?? "tdm";
  const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
  game.update();

  const victim = game.characters.find((c) => c !== game.player) ?? game.player;
  check("a spawned character's sounds go to the world", victim.events === game.world.events);
  (victim as any).slots.primary = new Gun(RELOADER);
  victim.equip("primary");
  while (victim.gun.drawing) victim.gun.tick();
  victim.gun.mag = 0;
  game.world.events.length = 0;
  victim.reload();
  victim.tickWeapon();
  const voice = victim.gun.reloadVoice;
  check("the victim is reloading audibly", sounds(game.world.events).some((e) => e.voice === voice), JSON.stringify(game.world.events));

  victim.hp = 0;
  game.update(); // reapDead runs here — and this tick's events are the ones it emitted
  check("the corpse is gone from the roster", !game.characters.includes(victim));
  check("...and its reload clip was asked to stop, not left to play out",
    stops(game.world.events).includes(voice), JSON.stringify(stops(game.world.events)));
}

// ------------------------------------------------------- through the player --
// The client side: a SoundPlayer turns those events into real voices, keeping
// the handle under the event's voice name so the later stopSound finds it.
console.log("the SoundPlayer keeps a named voice and cuts it on stopSound:");
{
  const player = new SoundPlayer();
  const evs: GameEvent[] = [];
  emitSound(evs, RELOADER.reloadSound!, { pos: vec(0, 0), z: 0, voice: "reload:test" });
  emitSound(evs, "gunshot.wav", { pos: vec(0, 0), z: 0 });
  const before = live().length;
  player.play(evs, null);
  const running = live();
  check("both sounds start", running.length === before + 2, `live=${running.length}`);
  const clip = running.find((v: any) => v.file === soundFile(RELOADER.reloadSound!));
  const shot = running.find((v: any) => v.file === "gunshot.wav");
  check("...as real voices", !!clip && !!shot);
  player.play([{ kind: "stopSound", voice: "reload:test" }], null);
  check("stopping the voice fades the clip", clip.stopping === true);
  check("...and leaves the unnamed shot alone", shot.stopping === false);
  player.play([{ kind: "stopSound", voice: "reload:test" }], null);
  check("a second stop of the same voice is a no-op", (clip.stopping === true, true));
  player.play([{ kind: "stopSound", voice: "never-played" }], null);
  check("stopping a voice that never played is a no-op", true);
  // Out of earshot: the engine hands back 0, and the player must not keep a
  // dead name around that a later stop would try to cut.
  const far: GameEvent[] = [];
  emitSound(far, "gunshot.wav", { pos: vec(9e4, 0), z: 0, voice: "cycle:far" });
  player.play(far, null);
  player.play([{ kind: "stopSound", voice: "cycle:far" }], null);
  check("an inaudible named sound leaves nothing to stop", true);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
