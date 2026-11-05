/**
 * Verifies the broken-angle check on HOLD (TacOracle.angleBroken): a hold whose
 * line to the entry point stays obstructed is torn up and re-planned, while a
 * teammate merely crossing it costs nothing.
 *
 * The case that matters most here is the third one. The check MUST read the
 * peek spot, not wherever the bot is standing: the cover spot cannot see the
 * entry by construction — that is what makes it cover — so a check made from
 * `this.pos` reports a break every time the bot ducks to reload, and would tear
 * up a perfectly good hold on every magazine change.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_holdangle.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vh.mjs && node <tmp>/vh.mjs
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall as mkWall, type World } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { vec, type Vec2 } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};

const world = (obstacles: any[] = []): World => {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [],
    items: [], vehicles: [], bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
  };
  w.grid = new ObstacleGrid(obstacles);
  return w;
};
const body = (p: Vec2, team: string): Character => {
  const c = new Character(vec(p.x, p.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = team as any;
  c.z = 0;
  c.hp = 100;
  return c;
};
const ENTRY = vec(400, 0), PEEK = vec(0, 0), COVER = vec(0, -200);
/** A bot already dug in: peek at PEEK, cover at COVER, watching ENTRY. */
function holder(at: Vec2): TacOracle {
  const b = new TacOracle(vec(at.x, at.y), { team: "blue", z: 0, stagger: 5 });
  const a = b as any;
  a.mode = "hold";
  a.holdEntry = vec(ENTRY.x, ENTRY.y);
  a.holdPeek = vec(PEEK.x, PEEK.y);
  a.holdCover = vec(COVER.x, COVER.y);
  a.holdPath = [];
  a.holdLosCheckIn = 0;
  a.holdLosBroken = 0;
  return b;
}
const ctx = (w: World, cs: Character[]): AiContext =>
  ({ world: w, characters: cs, nav: null, tick: 0 } as any);
/** Run `n` plan ticks of the check; returns the tick it tore the hold up on, or -1. */
function run(b: TacOracle, ai: AiContext, n: number): number {
  for (let i = 0; i < n; i++) if ((b as any).angleBroken(ai)) return i;
  return -1;
}

console.log("a clear angle is never torn up:");
{
  const w = world();
  const b = holder(PEEK);
  check("survives 20 plan ticks", run(b, ctx(w, [b]), 20) === -1);
  check("and the plan is intact", (b as any).holdEntry !== null);
}

console.log("a teammate settled in the line — torn up, but only after the debounce:");
{
  const w = world();
  const b = holder(PEEK);
  const m = body(vec(200, 0), "blue"); // squarely in the peek->entry line
  const ai = ctx(w, [b, m]);
  // stagger 5, checked every HOLD_LOS_CHECK_TICKS(10) => a check every 2 calls;
  // 3 checks to reach HOLD_LOS_BROKEN_TICKS(30) => the 5th call.
  check("not torn up on the first check", !(b as any).angleBroken(ai));
  const at = run(b, ai, 20);
  check("torn up once the break is confirmed", at >= 0, `on call ${at + 2}`);
  check("and the hold is cleared", (b as any).holdEntry === null);
  check("with a retry cooldown set", (b as any).holdRetryIn > 0);
}

console.log("a teammate crossing the line costs nothing:");
{
  const w = world();
  const b = holder(PEEK);
  const m = body(vec(200, 0), "blue");
  const ai = ctx(w, [b, m]);
  (b as any).angleBroken(ai); // one check while fouled
  const broken1 = (b as any).holdLosBroken;
  m.pos = vec(200, 400); // walked out of the line again
  for (let i = 0; i < 4; i++) (b as any).angleBroken(ai);
  check("a fouled check does count", broken1 > 0, `${broken1}t`);
  check("but a clear one resets it", (b as any).holdLosBroken === 0);
  check("so the hold survives", (b as any).holdEntry !== null);
}

console.log("ducked in cover is NOT a broken angle (the check reads the peek):");
{
  // A wall between the COVER spot and the entry, clear of the peek's line at
  // y = 0. Standing in cover, the bot cannot see its own entry point — normal,
  // and exactly what cover means.
  const w = world([mkWall(vec(200, -100), 200, 120, 0)]);
  const b = holder(COVER); // ducked, e.g. reloading
  const ai = ctx(w, [b]);
  check("cover really is blind to the entry (test is meaningful)",
    !(b as any).shootingLaneClear(ai, COVER, ENTRY));
  check("...but the peek still sees it", (b as any).shootingLaneClear(ai, PEEK, ENTRY));
  check("so no break is reported", run(b, ai, 20) === -1);
  check("and the hold survives a whole reload", (b as any).holdEntry !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
