/**
 * Verifies cross-floor SIGHT under the chosen design: bots are ALWAYS aware of
 * characters on other levels — roofs, hideWhenUnder floors and visibleFrom sets
 * hide nothing from them. A deliberate bot advantage, picked on feel over a
 * renderer-faithful version that was built and playtested. What keeps it fair
 * lives elsewhere and is pinned here too: exposure (visibility) stays honestly
 * ZERO across floors — an off-level enemy can be pursued but never reads as
 * shootable — and same-level sight remains the plain raycast.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_zsight.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vs.mjs && node <tmp>/vs.mjs
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall } from "../src/world/world.ts";
import type { World, Floor } from "../src/world/world.ts";
import { vec } from "../src/engine/vec.ts";

const floor = (x: number, y: number, w: number, h: number, level: number, extra: Partial<Floor> = {}): Floor =>
  ({ pos: vec(x, y), w, h, color: "#888", level, alpha: 1, ...extra } as Floor);
const world = (floors: Floor[] = [], obstacles: any[] = []): World => {
  const w: World = { obstacles, floors, stairs: [], nodes: [], items: [], vehicles: [], bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [] } as unknown as World;
  (w as any).grid = new ObstacleGrid(obstacles);
  return w;
};
const bot = (x: number, y: number, z: number): TacOracle => {
  const b = new TacOracle(vec(x, y), { team: "blue", z });
  b.z = z; return b;
};
const foe = (x: number, y: number, z: number): Character => {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "red" as any; c.z = z; return c;
};
let pass = 0, fail = 0;
const check = (n: string, ok: boolean): void => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); ok ? pass++ : fail++; };

console.log("across floors, bots are always aware:");
{
  const roofed = world([floor(0, 0, 400, 400, 1, { hideWhenUnder: true })]);
  const under = bot(0, 50, 0);
  check("even from UNDER a hideWhenUnder floor, its occupant is seen", (under as any).canSee(roofed, foe(0, 0, 1)));
  const walled = world([floor(0, 0, 400, 400, 1, { visibleFrom: { atLeast: 2 } as any })]);
  check("a floor the renderer hides from our level hides nothing from bots", (bot(600, 0, 0) as any).canSee(walled, foe(0, 0, 1)));
  const open = world();
  check("open ground below: seen", (bot(600, 0, 0) as any).canSee(open, foe(0, 0, -1)));
}

console.log("...but exposure stays honest, and same-level sight is unchanged:");
{
  const w = world([floor(0, 0, 400, 400, 1)]);
  const b = bot(600, 0, 0);
  check("visibility() is 0 across floors (aware, never shootable)", (b as any).visibility(w, foe(0, 0, 1)) === 0);
  const clear = world();
  check("same-z clear line: seen", (bot(600, 0, 0) as any).canSee(clear, foe(0, 0, 0)));
  const blocked = world([], [makeWall(vec(300, 0), 40, 400, 0)]);
  check("same-z fully walled: NOT seen (no cross-floor shortcut on our own level)",
    !(bot(600, 0, 0) as any).canSee(blocked, foe(0, 0, 0)));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
