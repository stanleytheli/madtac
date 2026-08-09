/**
 * Fit each weapon's raw reload clip to its in-game reload duration and emit the
 * served WAV. This is what lets you freely swap reload sounds: drop a raw clip
 * (any format) into audio-src/, point the spec's `reloadSound` at "<name>.wav",
 * and run this — no hand-computing stretch factors.
 *
 *   node scripts/fit_reload_sounds.mts      # or: npm run fit-reloads
 *
 * For every GunSpec that has a `reloadSound`, it:
 *   1. finds the raw source in audio-src/ by basename,
 *   2. trims trailing silence (so the final click sits at the very end),
 *   3. time-stretches — pitch-preserving (ffmpeg atempo) — to exactly
 *      fire.reloadTime / 60 seconds, so the clip ends on reload-complete,
 *   4. writes public/audio/<reloadSound>.
 *
 * Idempotent: a job is skipped when its output is already newer than its source,
 * so it's cheap enough to run on every dev start (see the `predev` npm script).
 * Never throws out — a missing ffmpeg or a bad clip warns and is skipped, so it
 * can't block `npm run dev`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as Guns from "../src/entities/guns.ts";
import type { GunSpec } from "../src/entities/guns.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "audio-src");
const OUT_DIR = join(ROOT, "public", "audio");
const TPS = 60; // game ticks per second — reloadTime is in ticks
const SILENCE_DB = -45; // trim a trailing run quieter than this...
const SILENCE_MIN = 0.03; // ...lasting at least this many seconds

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function duration(path: string): number {
  return parseFloat(
    sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).trim(),
  );
}

/** atempo accepts only 0.5–2.0 per stage; chain stages so their product = f. */
function atempoChain(f: number): string {
  const parts: number[] = [];
  let r = f;
  while (r > 2) { parts.push(2); r /= 2; }
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  parts.push(r);
  return parts.map((p) => `atempo=${p.toFixed(6)}`).join(",");
}

/** The raw clip in audio-src/ whose basename matches (any extension), or null. */
function findRaw(base: string): string | null {
  if (!existsSync(SRC_DIR)) return null;
  const hit = readdirSync(SRC_DIR).find((f) => parse(f).name === base);
  return hit ? join(SRC_DIR, hit) : null;
}

// ffmpeg present? If not, this is a no-op rather than a hard failure.
try {
  sh("ffmpeg", ["-version"]);
} catch {
  console.warn("fit-reloads: ffmpeg not found on PATH — skipping reload fitting.");
  process.exit(0);
}

const jobs = Object.entries(Guns).filter(
  ([, v]) => v && typeof v === "object" && (v as GunSpec).reloadSound,
) as [string, GunSpec][];

if (!jobs.length) {
  console.log("fit-reloads: no specs with a reloadSound — nothing to do.");
  process.exit(0);
}

let built = 0;
let skipped = 0;
for (const [key, spec] of jobs) {
  const outName = spec.reloadSound!;
  const base = parse(outName).name;
  const reloadTime = spec.fire?.reloadTime;
  if (!reloadTime) {
    console.warn(`! ${key}: reloadSound set but no fire.reloadTime — skipping`);
    continue;
  }
  const target = reloadTime / TPS;

  const raw = findRaw(base);
  if (!raw) {
    console.warn(`! ${key}: no raw source audio-src/${base}.* for "${outName}" — skipping`);
    continue;
  }

  const out = join(OUT_DIR, outName);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(raw).mtimeMs) {
    skipped++;
    console.log(`= ${key}: ${outName} up to date`);
    continue;
  }

  try {
    const tmp = join(tmpdir(), `fit_${base}.wav`);
    // 1. trim trailing silence (reverse → trim leading → reverse back)
    sh("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", raw,
      "-af",
      `areverse,silenceremove=start_periods=1:start_threshold=${SILENCE_DB}dB:start_duration=${SILENCE_MIN},areverse`,
      tmp,
    ]);
    const trimmed = duration(tmp);
    // 2. stretch what's left onto the reload length
    const factor = trimmed / target;
    sh("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp, "-af", atempoChain(factor), out]);
    const finalDur = duration(out);
    built++;
    console.log(
      `✓ ${key}: ${parse(raw).base} (${trimmed.toFixed(3)}s) → ${outName} ` +
        `${finalDur.toFixed(3)}s  (target ${target.toFixed(3)}s = ${reloadTime}t)`,
    );
  } catch (e) {
    console.warn(`! ${key}: failed to fit "${outName}" — ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log(`\nfit-reloads: ${built} built, ${skipped} up to date.`);
