/**
 * Verifies Oracle.unshove — the contact projection every AI movement step goes
 * through. For each teammate already inside CONTACT_DIST, the component of the
 * step along the line to them is removed and the tangential part is kept: a bot
 * walking past a teammate keeps sliding past, and only the part that presses
 * into them disappears. Enemies are left alone.
 *
 * Also checks the five movement paths actually route through it, since the whole
 * point is that no mover can bypass it.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_unshove.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vu.mjs && node <tmp>/vu.mjs
 */
import { readFileSync } from "node:fs";
import { Oracle } from "../src/ai/oracle.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import type { World } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { dist, vec, type Vec2 } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};
const CONTACT = BODY_RADIUS * 2; // mirrors oracle.ts

const world = (): World => {
  const w: World = {
    obstacles: [], floors: [], stairs: [], nodes: [],
    items: [], vehicles: [], bullets: [], projectiles: [], particles: [],
  };
  w.grid = new ObstacleGrid([]);
  return w;
};
const body = (p: Vec2, team: string, hp = 100): Character => {
  const c = new Character(vec(p.x, p.y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = team as any;
  c.z = 0;
  c.hp = hp;
  return c;
};
const bot = (p: Vec2): Oracle => new Oracle(vec(p.x, p.y), { team: "blue", z: 0 });
const ctx = (w: World, cs: Character[]): AiContext =>
  ({ world: w, characters: cs, nav: null, tick: 0 } as any);
const push = (b: Oracle, ai: AiContext, mv: Vec2): Vec2 => (b as any).unshove(ai, mv);
const len = (v: Vec2): number => Math.hypot(v.x, v.y);

// --------------------------------------------------------- the projection ----
console.log("a teammate dead ahead, in contact:");
{
  const w = world();
  const b = bot(vec(0, 0));
  const m = body(vec(CONTACT - 10, 0), "blue"); // touching, straight ahead
  const ai = ctx(w, [b, m]);
  const got = push(b, ai, vec(2.4, 0)); // walking straight at them
  check("the whole step is removed", len(got) < 1e-6, `|move| = ${len(got).toFixed(3)}`);
  const away = push(b, ai, vec(-2.4, 0));
  check("walking AWAY is untouched", Math.abs(away.x + 2.4) < 1e-6 && Math.abs(away.y) < 1e-6);
}

console.log("a teammate to the side — the pass-by keeps sliding:");
{
  const w = world();
  const b = bot(vec(0, 0));
  const m = body(vec(0, CONTACT - 10), "blue"); // touching, directly to our left
  const ai = ctx(w, [b, m]);
  const got = push(b, ai, vec(2.4, 0)); // walking past them, not at them
  check("a purely tangential step survives whole", Math.abs(got.x - 2.4) < 1e-6 && Math.abs(got.y) < 1e-6);
  const diag = push(b, ai, vec(2.4, 2.4)); // half into them
  check("the sideways half is removed", Math.abs(diag.y) < 1e-6, `y = ${diag.y.toFixed(3)}`);
  check("the forward half is kept", Math.abs(diag.x - 2.4) < 1e-6, `x = ${diag.x.toFixed(3)}`);
  check("so it still MOVES (no stop, no deadlock)", len(diag) > 1);
}

console.log("range and eligibility:");
{
  const w = world();
  const b = bot(vec(0, 0));
  const far = ctx(w, [b, body(vec(CONTACT + 1, 0), "blue")]);
  check("a teammate beyond contact does not filter", Math.abs(push(b, far, vec(2.4, 0)).x - 2.4) < 1e-6);
  const foe = ctx(w, [b, body(vec(CONTACT - 10, 0), "red")]);
  check("an ENEMY in contact does not filter (that's a fight)", Math.abs(push(b, foe, vec(2.4, 0)).x - 2.4) < 1e-6);
  const dead = ctx(w, [b, body(vec(CONTACT - 10, 0), "blue", 0)]);
  check("a corpse does not filter", Math.abs(push(b, dead, vec(2.4, 0)).x - 2.4) < 1e-6);
  const b2 = bot(vec(0, 0));
  const other = body(vec(0, 0), "blue");
  check("a coincident body never yields NaN", Number.isFinite(len(push(b2, ctx(w, [b2, other]), vec(2.4, 0)))));
}

console.log("two teammates at once:");
{
  const w = world();
  const b = bot(vec(0, 0));
  // A wedge: mates ahead-left and ahead-right. Driving forward presses both.
  const ai = ctx(w, [b, body(vec(40, 30), "blue"), body(vec(40, -30), "blue")]);
  const got = push(b, ai, vec(2.4, 0));
  const into = (m: Character): number => {
    const dx = m.pos.x - b.pos.x, dy = m.pos.y - b.pos.y, d = Math.hypot(dx, dy);
    return (got.x * dx + got.y * dy) / d;
  };
  const mates = ai.characters.filter((c) => c !== b) as Character[];
  check("presses into neither", mates.every((m) => into(m) <= 1e-6),
    mates.map((m) => into(m).toFixed(3)).join(", "));
}

// ------------------------------------------------- every mover uses it -------
console.log("all five movement paths route through unshove:");
{
  const src = readFileSync("src/ai/oracle.ts", "utf8") + readFileSync("src/ai/tacoracle.ts", "utf8");
  const writes = [...src.matchAll(/this\.pos = /g)].length;
  const calls = [...src.matchAll(/this\.unshove\(/g)].length;
  check("five position writes across the AI", writes === 5, `found ${writes}`);
  check("five unshove calls to match", calls === 5, `found ${calls}`);
}

console.log("driving at a stationary teammate for 200 ticks:");
{
  // EXACTLY head-on. The step is purely radial, so all of it is removed and the
  // bot comes to rest against them rather than pushing through. That is the
  // intended answer, not a bug: with a body in the way and no sideways
  // component to keep, waiting is what a projection means. It is also a case
  // that does not survive contact with the game — the other body moves, and
  // separateCharacters nudges the pair off-axis — so measured stall streaks in
  // real matches run 1-5 ticks and never exceeded 19 across ~128k bot-ticks.
  const w = world();
  const b = new TacOracle(vec(-200, 0), { team: "blue", z: 0 });
  const m = body(vec(0, 0), "blue");
  const ai = ctx(w, [b, m]);
  let minGap = Infinity;
  for (let i = 0; i < 200; i++) {
    (b as any).stepToward(ai, vec(200, 0));
    minGap = Math.min(minGap, dist(b.pos, m.pos));
  }
  check("never presses inside contact", minGap >= CONTACT - 3, `closest ${minGap.toFixed(1)}px`);
  check("comes to rest against them (no push-through)", b.pos.x < 0, `ended at x = ${b.pos.x.toFixed(0)}`);
}

console.log("...and with the teammate a body-width off the line, it slides past:");
{
  const w = world();
  const b = new TacOracle(vec(-200, 0), { team: "blue", z: 0 });
  const m = body(vec(0, BODY_RADIUS), "blue"); // off-axis, as any real body is
  const ai = ctx(w, [b, m]);
  let minGap = Infinity;
  for (let i = 0; i < 200; i++) {
    (b as any).stepToward(ai, vec(200, 0));
    minGap = Math.min(minGap, dist(b.pos, m.pos));
  }
  check("still never presses inside contact", minGap >= CONTACT - 3, `closest ${minGap.toFixed(1)}px`);
  check("and gets past them", b.pos.x > 0, `ended at x = ${b.pos.x.toFixed(0)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
