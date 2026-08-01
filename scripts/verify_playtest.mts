/**
 * Verifies the load-bearing safety property of the editor's playtest mode: a
 * playtest runs on a THROWAWAY deep copy, so no amount of live play mutates the
 * authored level the editor is holding. Mirrors exactly what main.ts's
 * startPlaytest does — loadLevel(serializeLevel(state)) then new Game(copy) — and
 * asserts the authored state is byte-for-byte identical afterward, while the copy
 * diverges (the match populated and mutated it).
 *
 * Run: node_modules/.bin/esbuild scripts/verify_playtest.mts --bundle
 *   --platform=node --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vp.mjs && node <tmp>/vp.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel, serializeLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
}

const LEVEL = "dom-arena-big-fix";
const text = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

// The editor's live state: what the user is editing / would save.
const authored = loadLevel(text);
const before = serializeLevel(authored);
const obstaclesBefore = authored.world.obstacles.length;
const itemsBefore = authored.world.items.length;
const mode = authored.meta.mode ?? DEFAULT_MODE;

// --- exactly what startPlaytest does ---------------------------------------
const copy = loadLevel(serializeLevel(authored)); // throwaway deep copy
check(
  "the copy is a distinct world (no shared arrays)",
  copy.world !== authored.world && copy.world.obstacles !== authored.world.obstacles && copy.world.items !== authored.world.items,
);

const g = new Game(copy, GAMEMODES[mode]({ ...copy.meta, mode }));
for (let i = 0; i < 600; i++) g.update();

console.log("the match ran on the copy and mutated it:");
check("characters were spawned into the match", g.characters.length > 0, `n=${g.characters.length}`);
check("the copy built its own nav/sight grid", copy.world.grid !== undefined);
check("the authored world never built a grid (it was only edited)", authored.world.grid === undefined);

console.log("the authored level is byte-for-byte untouched:");
const after = serializeLevel(authored);
check("level string identical after 600 ticks of play", after === before);
check("authored obstacle count unchanged", authored.world.obstacles.length === obstaclesBefore, `${authored.world.obstacles.length} vs ${obstaclesBefore}`);
check("authored item count unchanged", authored.world.items.length === itemsBefore, `${authored.world.items.length} vs ${itemsBefore}`);
check("authored bullets/particles never populated", authored.world.bullets.length === 0 && authored.world.particles.length === 0);

console.log("a second playtest from the same authored state is independent:");
const copy2 = loadLevel(serializeLevel(authored));
const g2 = new Game(copy2, GAMEMODES[mode]({ ...copy2.meta, mode }));
for (let i = 0; i < 120; i++) g2.update();
check("authored still unchanged after a second playtest", serializeLevel(authored) === before);
check("the two playtest copies are separate worlds", copy.world !== copy2.world);

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
