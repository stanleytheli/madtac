/**
 * Verifies which report a trigger pull emits — in particular that a melee weapon
 * plays its own `fireSound` (fists used to be silent: fire() skipped the sound
 * outright for melee) without ever falling back to DEFAULT_FIRE_SOUND, which is
 * a gunshot and has no business coming out of a punch.
 *
 * Observation point: playSound() misses the empty buffer cache and calls
 * load(), which fetches /audio/<file>. The banner's recording fetch stub is
 * therefore an exact log of "what the game tried to play".
 *
 * Run: node_modules/.bin/esbuild scripts/verify_firesound.mts --bundle --platform=node
 *   --format=esm --banner:js="$(cat scripts/stub_audio_banner.js)" --outfile=<tmp>/vf.mjs
 *   && node <tmp>/vf.mjs
 */
import { DEFAULT_FIRE_SOUND, Gun } from "../src/entities/gun.ts";
import { AWM, UNARMED, M9 } from "../src/entities/guns.ts";
import type { GunSpec } from "../src/entities/guns.ts";
import { ALL_GUN_SPECS, GUN_SPECS } from "../src/entities/specs.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { soundFile } from "../src/engine/audio.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { vec, fromAngle } from "../src/engine/vec.ts";
import type { World } from "../src/world/world.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

function world(): World {
  const w = {
    obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
  } as unknown as World;
  (w as any).grid = new ObstacleGrid([]);
  return w;
}

const body = (spec: GunSpec, team: string, x = 0): Character => {
  const c = new Character(vec(x, 0), DEFAULT_SKIN, { hand: new Gun(spec) });
  c.team = team as any;
  c.z = 0;
  c.forward = fromAngle(0, 1);
  return c;
};

/** Fire `spec` once and return every sound file the shot asked for — the
 *  sound events the sim emitted (see engine/events.ts), which is what the
 *  client would play. */
async function shotSounds(spec: GunSpec, opts: { target?: boolean } = {}): Promise<string[]> {
  const w = world();
  const shooter = body(spec, "blue");
  const target = opts.target ? body(UNARMED, "red", 60) : null;
  const fired = shooter.fire(w, target ? [shooter, target] : [shooter]);
  if (!fired) throw new Error(`${spec.name} refused to fire`);
  return w.events.filter((e) => e.kind === "sound").map((e) => soundFile(e.sound));
}

// -------------------------------------------------- melee ---------------------
console.log("a melee swing plays the weapon's own fireSound:");
{
  const punchFile = soundFile(UNARMED.fireSound!);
  check("UNARMED names a fireSound", !!UNARMED.fireSound, punchFile);
  const swing = await shotSounds(UNARMED);
  check("a punch into thin air plays it", swing.includes(punchFile), `played ${JSON.stringify(swing)}`);
  const hit = await shotSounds(UNARMED, { target: true });
  check("a punch that connects plays it too", hit.includes(punchFile), `played ${JSON.stringify(hit)}`);
  check(
    "and never the default gunshot",
    !swing.includes(DEFAULT_FIRE_SOUND) && !hit.includes(DEFAULT_FIRE_SOUND),
  );
  check("exactly one report per swing", swing.length === 1, `played ${JSON.stringify(swing)}`);
}

// A melee spec with NO fireSound must stay silent rather than inherit a gunshot.
console.log("a melee weapon with no fireSound of its own:");
{
  const mute: GunSpec = { ...UNARMED, name: "mute-fists", fireSound: undefined };
  const sounds = await shotSounds(mute);
  check("stays silent (no gunshot fallback)", sounds.length === 0, `played ${JSON.stringify(sounds)}`);
}

// -------------------------------------------------- guns unchanged ------------
console.log("ballistic weapons are untouched by the change:");
{
  const awm = await shotSounds(AWM);
  check("AWM plays its own fireSound", awm.includes(soundFile(AWM.fireSound!)), JSON.stringify(awm));
  const m9 = await shotSounds(M9);
  check("M9 plays its own fireSound", m9.includes(soundFile(M9.fireSound!)), JSON.stringify(m9));
  const bare: GunSpec = { ...AWM, name: "bare-rifle", fireSound: undefined, cycleSound: undefined };
  const fallback = await shotSounds(bare);
  check(
    "a gun with no fireSound falls back to the default gunshot",
    fallback.includes(DEFAULT_FIRE_SOUND),
    JSON.stringify(fallback),
  );
}

// -------------------------------------------------- preload coverage ----------
// UNARMED has no ground icon, so it is absent from GUN_SPECS — the registry
// main.ts used to warm sounds from. A cold first punch would be silent (the
// cache miss only kicks off the fetch), which is exactly the bug.
console.log("every weapon that makes noise is warmable at boot:");
{
  check("UNARMED is NOT in GUN_SPECS (no ground icon)", !Object.values(GUN_SPECS).includes(UNARMED));
  check("UNARMED IS in ALL_GUN_SPECS", Object.values(ALL_GUN_SPECS).includes(UNARMED));
  // The melee specs are precisely the ones the old GUN_SPECS loop could miss.
  const meleeMissed = Object.entries(ALL_GUN_SPECS)
    .filter(([, s]) => s.melee && s.fireSound && !Object.values(GUN_SPECS).includes(s))
    .map(([k]) => k);
  check(
    "the melee specs GUN_SPECS misses are covered by ALL_GUN_SPECS",
    meleeMissed.every((k) => k in ALL_GUN_SPECS),
    meleeMissed.join(", ") || "(none)",
  );
  check(
    "ALL_GUN_SPECS is a superset of GUN_SPECS",
    Object.keys(GUN_SPECS).every((k) => k in ALL_GUN_SPECS),
  );
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
