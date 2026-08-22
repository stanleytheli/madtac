/**
 * Verifies the global output volume: one multiplier applied at the master node,
 * shipping at DEFAULT_MASTER_VOLUME.
 *
 * The claim that matters is WHERE it applies. Every audibility decision the
 * engine makes — distance falloff, the MIN_GAIN cull, the MAX_DIST_PX cutoff,
 * coalescing, voice stealing — reads the PER-SOUND gain, which is computed
 * before the master node. So turning the game down must change how loud it is
 * and nothing else: the same sounds play, in the same mix. That is what most of
 * this file checks.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_volume.mts --bundle --platform=node
 *   --format=esm --banner:js="$(cat scripts/stub_audio_banner.js)"
 *   --outfile=<tmp>/vv.mjs && node <tmp>/vv.mjs
 */
import {
  DEFAULT_MASTER_VOLUME,
  masterVolume0to1,
  playSound,
  setListener,
  setMasterVolume,
} from "../src/engine/audio.ts";
import { vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

const g = globalThis as any;
const master = (): any => g.__master();
const played = g.__played as string[];
/** Play one sound and report every file the engine actually asked for. */
async function play(file: string, opts: Record<string, unknown> = {}): Promise<string[]> {
  played.length = 0;
  playSound(file, opts);
  const out = [...played];
  await new Promise((r) => setTimeout(r, 0)); // let the stub fetch reject + clear
  return out;
}

setListener(vec(0, 0), 0);

// ------------------------------------------------------------ the default -----
console.log("it ships at half volume:");
{
  check("the shipped default is 50%", DEFAULT_MASTER_VOLUME === 0.5, `${DEFAULT_MASTER_VOLUME}`);
  check("nothing has to be called to get it", masterVolume0to1() === DEFAULT_MASTER_VOLUME);
  await play("gunshot.wav", { pos: vec(0, 0), z: 0 }); // forces the context to exist
  check("the master node comes up at that level, not at 1",
    near(master().gain.value, DEFAULT_MASTER_VOLUME), `${master().gain.value}`);
  check("...and it is the node feeding the destination",
    master().outputs.length === 1 && master().outputs[0].kind === "destination");
}

// ------------------------------------------------------------ setting it ------
console.log("setting it moves the master node, live:");
{
  setMasterVolume(0.8);
  check("the level reads back", near(masterVolume0to1(), 0.8));
  check("the live master node follows", near(master().gain.value, 0.8), `${master().gain.value}`);
  check("it glides rather than jumping (a dragged slider must not click)",
    master().gain.events.at(-1)?.[0] === "target", JSON.stringify(master().gain.events.at(-1)));

  setMasterVolume(3);
  check("above 1 clamps to 1", masterVolume0to1() === 1 && near(master().gain.value, 1));
  setMasterVolume(-2);
  check("below 0 clamps to 0 (silence, not an inverted signal)",
    masterVolume0to1() === 0 && near(master().gain.value, 0));
  setMasterVolume(0.25);
  check("and back to an ordinary level", near(masterVolume0to1(), 0.25));
}

// A context built LATER — first unlock, or resetAudioContext — must come up at
// whatever the level is now, not at the shipped default.
console.log("a context built later comes up at the current level:");
{
  setMasterVolume(0.3);
  g.__dropContext();
  await play("gunshot.wav", { pos: vec(0, 0), z: 0 });
  check("the rebuilt master is at the level in force", near(master().gain.value, 0.3),
    `${master().gain.value}`);
  check("...not the shipped default", !near(master().gain.value, DEFAULT_MASTER_VOLUME));
}

// ------------------------------------------------- it changes loudness ONLY ---
// Everything below is the "and nothing else" half of the claim.
console.log("it changes how loud the game is, and nothing else:");
{
  // MAX_DIST_PX is 40m * 50px = 2000px. The cull is on the per-sound gain, so it
  // must land in exactly the same place whatever the master is set to.
  const audible = vec(500, 0);
  const tooFar = vec(3000, 0);
  const at = async (v: number, pos: { x: number; y: number }) => {
    setMasterVolume(v);
    return (await play("gunshot.wav", { pos, z: 0 })).length;
  };
  for (const v of [1, 0.5, 0.05]) {
    check(`at ${v * 100}% a nearby shot still plays`, (await at(v, audible)) === 1);
    check(`at ${v * 100}% a shot out of earshot is still culled`, (await at(v, tooFar)) === 0);
  }
  // Even at zero: muting is an output-stage thing, not a "stop simulating audio"
  // thing, so the engine's decisions do not change under it.
  check("at 0% the same sound is still requested (mute is output-stage)",
    (await at(0, audible)) === 1);
  check("...and the same distant one is still culled", (await at(0, tooFar)) === 0);

  // The off-level muffle, per-sound volumes and pitch all live upstream too:
  // a quiet master must not make an off-level sound fall below the cull.
  setMasterVolume(0.05);
  check("an off-level sound still plays at a quiet master",
    (await play("gunshot.wav", { pos: audible, z: 3 })).length === 1);
  check("a baked-in per-sound volume is still honored",
    (await play("gunshot.wav", { pos: audible, z: 0, volume: 0.5 })).length === 1);
}

setMasterVolume(DEFAULT_MASTER_VOLUME);
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
