/**
 * Verifies a bot keeps walking where its route offers two near-equal ways round:
 * arena-teamfight's side walkways, raised, with stairs at both ends.
 *
 * The bug: Oracle.plan() takes the bot's own route off the congestion field,
 * plans, then puts it back; the string-pull (skipReachableHops) then asked
 * route() for "the hop after the waypoint" again, with the bot's own route back
 * on the field. Routing around itself, that query preferred the other way round,
 * back through the node the bot stood on, so the pull walked the waypoint back
 * onto it. Arriving there re-planned the same first hop, the pull undid it, and
 * the bot stood still for as long as the traffic stayed the same — the left
 * AK ally parked on its walkway with reds alive. The pull (and blind facing) now
 * follow the route the plan committed to.
 *
 * Checks:
 *  1. A lone bot on the left walkway's middle node walks off toward an unseen
 *     red, wherever the red is (the old code didn't move a pixel in 10 s for
 *     6 of these 8 placements, and froze on the other 2 as well: it saw those
 *     reds across the map, out of range, and approaches over the same planner).
 *  2. The string-pull never moves a waypoint onto the node the bot stands on.
 *  3. Seeded sandbox matches: the left AK ally never stands 3 s on its own
 *     waypoint with nobody in sight and reds alive (the symptom as reported).
 *
 * Run: node_modules/.bin/esbuild scripts/verify_walkway.mts --bundle --platform=node
 *   --format=esm --banner:js="$(cat scripts/stub_audio_banner.js)"
 *   --outfile=<tmp>/vw.mjs && node <tmp>/vw.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { SandboxMode } from "../src/gamemodes/sandbox.ts";
import { Oracle } from "../src/ai/oracle.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
}

const seed = (s: number): void => {
  let x = s >>> 0;
  Math.random = () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 4294967296);
};
const TEXT = readFileSync("src/world/levels/arena-teamfight.json", "utf8");
const raw = JSON.parse(TEXT);

// The bot internals these checks read.
type Probe = { pos: { x: number; y: number }; z: number; vel: { x: number; y: number }; waypoint: number; goal: number; lastTarget: unknown; mode: string; hp: number; team: string };
type Nav = { nodes: { pos: { x: number; y: number } }[] };
const onNode = (b: Probe, nav: Nav, n: number): boolean =>
  n >= 0 && Math.hypot(nav.nodes[n].pos.x - b.pos.x, nav.nodes[n].pos.y - b.pos.y) <= 8;

// (2) Count every string-pull that lands a waypoint on the bot's own node.
let pullsOntoSelf = 0;
let pulls = 0;
{
  const proto = Oracle.prototype as unknown as { skipReachableHops(nav: Nav, world: unknown): void };
  const original = proto.skipReachableHops;
  proto.skipReachableHops = function (this: Probe, nav: Nav, world: unknown) {
    const before = this.waypoint;
    original.call(this, nav, world);
    if (this.waypoint !== before) {
      pulls++;
      if (this.waypoint !== this.goal && onNode(this, nav, this.waypoint)) pullsOntoSelf++;
    }
  };
}

console.log("a lone bot on the left walkway walks off toward an unseen red:");
const WALKWAY_NODE = { x: -860, y: -140, z: 1 }; // the walkway's middle node
const REDS: [number, number, number][] = [
  [-457, -418, 0], [-380, -400, 0], [940, -480, 1], [450, -387, 0],
  [798, -199, 1], [0, -980, 0], [0, 400, 0], [-5, -101, 0],
];
for (const [x, y, z] of REDS) {
  seed(7);
  const entities = raw.entities.filter((e: { kind: string }) => e.kind !== "enemy");
  entities.push({ kind: "enemy", ...WALKWAY_NODE, type: "tacoracle", team: "ally", gun: "AK47", armor: "ARMOR_L2", skin: "BLUE_SKIN" });
  entities.push({ kind: "enemy", x, y, z, type: "robot", team: "enemy" }); // stationary
  const game = new Game(loadLevel(JSON.stringify({ ...raw, entities })), new SandboxMode(), { humans: 0 });
  game.update();
  const bot = (game as unknown as { characters: Probe[] }).characters.find((c) => c.team === "ally")!;
  let far = 0;
  for (let t = 0; t < 600; t++) {
    game.update();
    far = Math.max(far, Math.hypot(bot.pos.x - WALKWAY_NODE.x, bot.pos.y - WALKWAY_NODE.y));
  }
  check(`red at (${x}, ${y}) on level ${z}: the bot leaves the walkway's middle`, far >= 300, `got ${far.toFixed(0)} px from it in 10 s`);
}

console.log("\nseeded sandbox matches, the left AK ally (the report):");
let parkedSpells = 0;
let longest = 0;
let matches = 0;
for (let s = 1; s <= 30; s++) {
  seed(s);
  const game = new Game(loadLevel(TEXT), new SandboxMode());
  game.update();
  const g = game as unknown as { characters: Probe[]; nav: Nav };
  const ally = g.characters.find((c) => c instanceof TacOracle && c.team === "ally" && Math.hypot(c.pos.x + 700, c.pos.y - 400) < 40)!;
  matches++;
  let run = 0;
  for (let t = 0; t < 5400; t++) {
    game.update();
    if (ally.hp <= 0 || !g.characters.some((c) => c.team === "enemy" && c.hp > 0)) break;
    const parked = !ally.lastTarget && ally.mode !== "hold" && ally.mode !== "heal" &&
      ally.waypoint !== ally.goal && onNode(ally, g.nav, ally.waypoint) && Math.hypot(ally.vel.x, ally.vel.y) < 0.01;
    run = parked ? run + 1 : 0;
    if (run === 180) parkedSpells++;
    longest = Math.max(longest, run);
  }
}
check("it never stands 3 s on its own waypoint with nobody in sight and reds alive", parkedSpells === 0,
  `${parkedSpells} such spells in ${matches} matches, longest ${(longest / 60).toFixed(1)} s`);

console.log("");
check("the string-pull never moves a waypoint onto the node the bot stands on", pullsOntoSelf === 0,
  `${pullsOntoSelf} of ${pulls} pulls`);

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
