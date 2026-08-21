/**
 * One-shot migration: state `thicknessMul` outright on every map object in every
 * level.
 *
 * The value is 1 — exactly what an unset object already behaves as — so this
 * changes no geometry and no gameplay. The point is to leave 0 free to mean what
 * it says (a free pass for bullets, see Obstacle.thicknessMul) instead of doubling
 * as "no value here", which is what an omitted key would otherwise have to mean.
 *
 * Surgical on purpose: each entity line is parsed, given the key in the position
 * the editor's own serializer would put it, and written back compactly. Everything
 * else in the file — field order, spacing, entity order, the meta line — is left
 * byte for byte alone, so the diff is one key per map object and nothing else.
 * Idempotent: objects that already state a value are left as they are.
 *
 * Run: node scripts/migrate_thickness.mts [--dry]
 */
import { readFileSync, writeFileSync, globSync } from "node:fs";

/** Kinds that are obstacles — the only things a bullet can be stopped by. */
const OBSTACLES = new Set(["wall", "crate", "fence", "circle", "barrel_metal", "barrel_wood"]);
/** The key entityToJSON writes immediately after thicknessMul, so the migrated
 *  files match what the next save from the editor would produce. */
const NEXT_KEY = "fill";
const VALUE = 1;

const dry = process.argv.includes("--dry");
let files = 0;
let touched = 0;
let already = 0;

for (const path of globSync("src/world/levels/*.json").sort()) {
  const src = readFileSync(path, "utf8");
  const out: string[] = [];
  let changed = 0;

  for (const line of src.split("\n")) {
    const trimmed = line.trim().replace(/,$/, "");
    // Only entity lines: an object with a "kind" we care about. Anything else
    // (the wrapper, the meta line, blank lines) passes through untouched.
    if (!trimmed.startsWith("{") || !trimmed.includes('"kind"')) {
      out.push(line);
      continue;
    }
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      out.push(line); // not ours to rewrite
      continue;
    }
    if (!OBSTACLES.has(e.kind as string)) {
      out.push(line);
      continue;
    }
    if ("thicknessMul" in e) {
      already++;
      out.push(line);
      continue;
    }
    // Rebuild in order, slotting the new key where the serializer would.
    const next: Record<string, unknown> = {};
    let placed = false;
    for (const [k, v] of Object.entries(e)) {
      if (k === NEXT_KEY && !placed) {
        next.thicknessMul = VALUE;
        placed = true;
      }
      next[k] = v;
    }
    if (!placed) next.thicknessMul = VALUE;

    const indent = line.slice(0, line.length - line.trimStart().length);
    out.push(`${indent}${JSON.stringify(next)}${line.trimEnd().endsWith(",") ? "," : ""}`);
    changed++;
  }

  files++;
  touched += changed;
  if (changed && !dry) writeFileSync(path, out.join("\n"));
  if (changed) console.log(`  ${changed.toString().padStart(4)} objects  ${path}`);
}

console.log(
  `\n${dry ? "[dry run] would set" : "set"} thicknessMul=${VALUE} on ${touched} map objects ` +
    `across ${files} levels` + (already ? ` (${already} already stated one)` : ""),
);
