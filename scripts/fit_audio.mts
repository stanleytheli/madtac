/**
 * Fit each weapon's raw duration-synced audio to its in-game timing and emit the
 * served WAV. This is what lets you freely swap these sounds: drop a raw clip
 * (any format) into audio-src/, point the spec's field at "<name>.wav", and run
 * this — no hand-computing stretch factors.
 *
 *   node scripts/fit_audio.mts      # or: npm run fit-audio
 *
 * Two kinds of duration-synced sound, both processed the same way:
 *   - reloadSound → stretched to fire.reloadTime / 60 s (ends on reload-complete)
 *   - cycleSound  → stretched to fire.delay / 60 s (the bolt/pump action between
 *                   shots on slow weapons; played on every shot)
 *
 * For each, it:
 *   1. finds the raw source in audio-src/ by basename,
 *   2. trims TRAILING silence only — LEADING silence is preserved, because for a
 *      cycle sound it encodes how long after the bang the action lands,
 *   3. time-stretches — pitch-preserving (ffmpeg atempo) — to the target seconds,
 *   4. writes public/audio/<name>.
 *
 * fireSound is converted as-is (no trim, no stretch — the bang plays exactly as
 * authored). It's still WAV rather than the raw mp3 because mp3 decoding bakes
 * ~25–50ms of priming silence onto the clip's start — a late gunshot.
 *
 * Sharing rules: two guns naming the same output with IDENTICAL processing is
 * fine (one file serves both). The same output demanded with DIFFERENT
 * processing (e.g. shared reloadSound, different reloadTimes) is an authoring
 * error this script detects and refuses — the mtime skip would otherwise let
 * the first gun's fit silently win. To share one RAW clip across different
 * timings, use a variant name: "Ak47_reload_01@scar17.wav" looks up the raw by
 * the part before the "@" and writes its own separate output.
 *
 * Idempotent: a job is skipped when its output is already newer than its source,
 * so it's cheap to run on every dev start (see the `predev` npm script). Never
 * throws out — a missing ffmpeg or a bad clip warns and is skipped, so it can't
 * block `npm run dev`.
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
const TPS = 60; // game ticks per second — reloadTime / delay are in ticks
const SILENCE_DB = -45; // trim a trailing run quieter than this...
const SILENCE_MIN = 0.03; // ...lasting at least this many seconds

/** The duration-synced sound fields, each with the tick count it's fitted to. */
const KINDS: { field: "reloadSound" | "cycleSound"; ticks: (s: GunSpec) => number | undefined; what: string }[] = [
  { field: "reloadSound", ticks: (s) => s.fire?.reloadTime, what: "reload" },
  { field: "cycleSound", ticks: (s) => s.fire?.delay, what: "fire-cycle" },
];

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

/** The raw-lookup basename for an output name — the part before any "@", so
 *  variant outputs ("Base@gun.wav") share one raw clip. */
function rawBase(outName: string): string {
  return parse(outName).name.split("@")[0];
}

let built = 0;
let skipped = 0;

/** Trim trailing silence + stretch `outName`'s raw source to `targetSec`. */
function fit(key: string, outName: string, targetSec: number, what: string): void {
  if (conflicted.has(outName)) return;
  const base = rawBase(outName);
  const raw = findRaw(base);
  if (!raw) {
    console.warn(`! ${key} (${what}): no raw source audio-src/${base}.* for "${outName}" — skipping`);
    return;
  }
  const out = join(OUT_DIR, outName);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(raw).mtimeMs) {
    skipped++;
    console.log(`= ${key} (${what}): ${outName} up to date`);
    return;
  }
  try {
    const tmp = join(tmpdir(), `fit_${base}.wav`);
    // 1. trim trailing silence (reverse → trim leading → reverse back). Leading
    //    silence of the original is untouched.
    sh("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", raw,
      "-af",
      `areverse,silenceremove=start_periods=1:start_threshold=${SILENCE_DB}dB:start_duration=${SILENCE_MIN},areverse`,
      tmp,
    ]);
    const trimmed = duration(tmp);
    // 2. stretch what's left onto the target length
    sh("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp, "-af", atempoChain(trimmed / targetSec), out]);
    const finalDur = duration(out);
    built++;
    console.log(
      `✓ ${key} (${what}): ${parse(raw).base} (${trimmed.toFixed(3)}s) → ${outName} ` +
        `${finalDur.toFixed(3)}s  (target ${targetSec.toFixed(3)}s)`,
    );
  } catch (e) {
    console.warn(`! ${key} (${what}): failed to fit "${outName}" — ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Plain conversion for fire sounds: raw source → public/audio/<name>, format
 *  change only. A missing raw is fine when the served wav already exists (many
 *  fire sounds predate audio-src/); only a spec pointing at nothing warns. */
function convert(key: string, outName: string): void {
  if (conflicted.has(outName)) return;
  const base = rawBase(outName);
  const raw = findRaw(base);
  const out = join(OUT_DIR, outName);
  if (!raw) {
    if (!existsSync(out)) {
      console.warn(`! ${key} (fire): no audio-src/${base}.* and no ${outName} — sound will be silent`);
    }
    return;
  }
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(raw).mtimeMs) {
    skipped++;
    console.log(`= ${key} (fire): ${outName} up to date`);
    return;
  }
  try {
    sh("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, out]);
    built++;
    console.log(`✓ ${key} (fire): ${parse(raw).base} → ${outName}`);
  } catch (e) {
    console.warn(`! ${key} (fire): failed to convert "${outName}" — ${(e as Error).message.split("\n")[0]}`);
  }
}

// ffmpeg present? If not, this is a no-op rather than a hard failure.
try {
  sh("ffmpeg", ["-version"]);
} catch {
  console.warn("fit-audio: ffmpeg not found on PATH — skipping audio fitting.");
  process.exit(0);
}

const specs = Object.entries(Guns).filter(([, v]) => v && typeof v === "object" && "armorPen" in (v as object)) as [
  string,
  GunSpec,
][];

// Detect same-output-different-processing collisions BEFORE building anything:
// with the mtime skip, whichever gun ran first would win and every other gun
// would silently get a file fitted to the wrong duration.
const conflicted = new Set<string>();
{
  const sigs = new Map<string, { sig: string; by: string }>();
  for (const [key, spec] of specs) {
    const demands: [string | undefined, string][] = [
      [spec.fireSound, "verbatim"],
      [spec.reloadSound, `fit:${spec.fire?.reloadTime}`],
      [spec.cycleSound, `fit:${spec.fire?.delay}`],
    ];
    for (const [name, sig] of demands) {
      if (!name) continue;
      const prev = sigs.get(name);
      if (!prev) sigs.set(name, { sig, by: key });
      else if (prev.sig !== sig && !conflicted.has(name)) {
        conflicted.add(name);
        console.warn(
          `! CONFLICT: ${name} demanded as ${prev.sig} by ${prev.by} but ${sig} by ${key} — ` +
            `refusing to build it. Give one gun a variant name ("${rawBase(name)}@<gun>.wav").`,
        );
      }
    }
  }
}

for (const [key, spec] of specs) {
  if (spec.fireSound) convert(key, spec.fireSound);
  for (const kind of KINDS) {
    const name = spec[kind.field];
    if (!name) continue;
    const ticks = kind.ticks(spec);
    if (!ticks) {
      console.warn(`! ${key} (${kind.what}): ${kind.field} set but no matching tick count — skipping`);
      continue;
    }
    fit(key, name, ticks / TPS, kind.what);
  }
}

console.log(`\nfit-audio: ${built} built, ${skipped} up to date.`);
