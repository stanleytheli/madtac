/**
 * Verifies a bot gets round a teammate standing in its lane instead of
 * standing behind them.
 *
 * The bug: on a plan tick TacOracle.act() saw a teammate in the lane to its
 * chase (blockingMate) and sidestepped one step, which skips navChase, so the
 * waypoint never advanced. coast() — the four ticks between plans — was meant
 * to do the same, but looked for the lane to `target ?? focus`, not to the chase
 * act walked toward. A chase from bestChase or a domination objective marker is
 * neither, so coast saw no lane and walked back onto the stale waypoint. Step
 * out, walk back, repeat: on dom-arena a bot stood at the basement doorway,
 * behind a teammate, for as long as that teammate stayed (traced in seed 18 of
 * the dom probe). coast now uses the chase act chose (moveChase).
 *
 * Checks: a domination bot in point A's basement, heading for its capture spot
 * with a stationary teammate 70 or 110 px ahead in its lane, reaches the ring
 * within 5 s, from each of five starts round the point. (It takes 0-2.5 s; the
 * old code never got there from the west corridor, and took 7 s from the south
 * stairs.)
 *
 * Run: node_modules/.bin/esbuild scripts/verify_sidestep.mts --bundle --platform=node
 *   --format=esm --banner:js="$(cat scripts/stub_audio_banner.js)"
 *   --outfile=<tmp>/vs.mjs && node <tmp>/vs.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
import { spawnEnemy } from "../src/ai/enemies.ts";
import { vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
}

const TEXT = readFileSync("src/world/levels/dom-arena-big-fix.json", "utf8");
const POINT_A = { x: -40, y: -1380, z: -1, radius: 250 };
// Basement (z -1) starts round point A, outside its ring: the west doorway, the
// west and east corridors, the feet of the south and north stairs.
const STARTS: [string, number, number][] = [
  ["west doorway", -318, -1426], ["west corridor", -560, -1380], ["east corridor", 500, -1380],
  ["south stairs", -40, -1100], ["north stairs", -40, -1660],
];

type Bot = {
  pos: Vec2; z: number; team: string; objMarker: { pos: Vec2; z: number } | null;
  siteChoice: unknown; siteCommitIn: number; captureGoal: unknown;
};

console.log("a domination bot gets round a teammate standing in its lane to point A:");
for (const [where, x, y] of STARTS) {
  for (const ahead of [70, 110]) {
    let s = 11;
    Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
    const game = new Game(loadLevel(TEXT), new DominationMode({ blue: { troops: 1 }, red: { troops: 0 } }), { humans: 0 });
    game.update();
    const chars = (game as unknown as { characters: Bot[] }).characters;
    const bot = chars.find((c) => c.team === "blue")!;
    bot.pos = vec(x, y);
    bot.z = POINT_A.z;
    // It may already have committed to a point from the spawn (whether it planned
    // on the first tick depends on its stagger phase); drop that, so it picks
    // from here — point A, right next to it.
    bot.siteChoice = null;
    bot.siteCommitIn = 0;
    bot.captureGoal = null;
    for (let t = 0; t < 12; t++) game.update();
    const mark = bot.objMarker;
    if (!mark || mark.z !== POINT_A.z) {
      check(`${where}: it heads for a capture spot on point A`, false, `marker ${mark ? `on level ${mark.z}` : "none"}`);
      continue;
    }
    const dx = mark.pos.x - bot.pos.x;
    const dy = mark.pos.y - bot.pos.y;
    const l = Math.hypot(dx, dy);
    game.addCharacter(spawnEnemy({ type: "robot", team: "blue", z: POINT_A.z, pos: vec(bot.pos.x + (dx / l) * ahead, bot.pos.y + (dy / l) * ahead) }));
    let reached = -1;
    for (let t = 0; t < 300 && reached < 0; t++) {
      game.update();
      if (bot.z === POINT_A.z && Math.hypot(bot.pos.x - POINT_A.x, bot.pos.y - POINT_A.y) <= POINT_A.radius) reached = t;
    }
    check(`${where}, teammate ${ahead} px ahead: it reaches the ring`, reached >= 0,
      reached >= 0 ? `in ${(reached / 60).toFixed(1)} s` : `not in 5 s; ended at (${bot.pos.x | 0}, ${bot.pos.y | 0})`);
  }
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
