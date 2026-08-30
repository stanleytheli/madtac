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

console.log("opposing traffic — the head-on slip:");
{
  // A mate in contact dead ahead AND walking at us: the plain projection would
  // remove the whole step of both and the pair would stall forever (each step
  // is radial, symmetry never breaks). The slip turns the removed part
  // sideways instead — each bot to its own side, so the pair picks opposite
  // sides and passes. (These mates are plain Characters, so their `vel` is
  // their intent; a stalled ORACLE mate publishes `moveIntent` instead — see
  // the cold-start walk below.)
  const w = world();
  const b = bot(vec(0, 0));
  const m = body(vec(CONTACT - 10, 0), "blue");
  m.vel = vec(-2.4, 0); // walking at us
  const ai = ctx(w, [b, m]);
  const got = push(b, ai, vec(2.4, 0));
  check("the stalled step is turned sideways, not dropped", len(got) > 1, `|move| = ${len(got).toFixed(2)}`);
  check("and it is lateral (never presses in)", Math.abs(got.x) < 1e-6 && Math.abs(got.y) > 1,
    `(${got.x.toFixed(2)}, ${got.y.toFixed(2)})`);

  // The mirrored bot slips to the OTHER side — that is what breaks the symmetry.
  const b2 = bot(vec(CONTACT - 10, 0));
  const m2 = body(vec(0, 0), "blue");
  m2.vel = vec(2.4, 0);
  const got2 = push(b2, ctx(w, [b2, m2]), vec(-2.4, 0));
  check("the opposing bot slips to the opposite side", got.y * got2.y < 0,
    `${got.y.toFixed(2)} vs ${got2.y.toFixed(2)}`);

  // A grazing contact that still has real tangential motion gets NO slip —
  // it is already sliding past, and extra lateral motion just churns crowds.
  const graze = push(b, ai, vec(1.0, 2.4)); // mostly tangential
  check("a sliding contact is left to the plain projection",
    Math.abs(graze.x) < 1e-6 && Math.abs(graze.y - 2.4) < 1e-6,
    `(${graze.x.toFixed(2)}, ${graze.y.toFixed(2)})`);

  // A destination basically AT the mate disarms the slip: converging on a
  // shared spot reads as opposing too, and slipping there is an endless dance.
  const conv = (b as any).unshove(ai, vec(2.4, 0), CONTACT);
  check("no slip when the walk goal is not beyond the mate", len(conv) < 1e-6,
    `|move| = ${len(conv).toFixed(2)}`);
}

console.log("the approach shell — opposing pairs divert BEFORE touching:");
{
  // Acting only inside contact set up a boundary cycle (see probe_churn):
  // press in at full speed just outside the edge, slip just inside, repeat —
  // a multi-second grind. In the shell (up to 1.5x contact) an opposing
  // mate's radial component is diverted sideways so the pair arcs past.
  const w = world();
  const b = bot(vec(0, 0));
  const m = body(vec(CONTACT + 20, 0), "blue"); // NOT touching, in the shell
  m.vel = vec(-2.4, 0); // walking at us
  const got = push(b, ctx(w, [b, m]), vec(2.4, 0));
  check("an opposing mate in the shell diverts the step", Math.abs(got.y) > 1,
    `(${got.x.toFixed(2)}, ${got.y.toFixed(2)})`);
  const rest = body(vec(CONTACT + 20, 0), "blue"); // resting in the shell
  const past = push(b, ctx(w, [b, rest]), vec(2.4, 0));
  check("a RESTING mate in the shell filters nothing",
    Math.abs(past.x - 2.4) < 1e-6 && Math.abs(past.y) < 1e-6,
    `(${past.x.toFixed(2)}, ${past.y.toFixed(2)})`);
}

console.log("two walkers crossing head-on actually trade places:");
{
  const w = world();
  const a = new TacOracle(vec(0, 0), { team: "blue", z: 0 });
  const b = new TacOracle(vec(600, 0), { team: "blue", z: 0 });
  const ai = ctx(w, [a, b]);
  let doneAt = -1;
  for (let t = 1; t <= 600 && doneAt < 0; t++) {
    (ai as any).tick = t; // moveIntent freshness needs a live tick
    (a as any).stepToward(ai, vec(600, 0));
    (b as any).stepToward(ai, vec(0, 0));
    if (dist(a.pos, vec(600, 0)) < 30 && dist(b.pos, vec(0, 0)) < 30) doneAt = t;
  }
  // Unobstructed this walk is ~250 ticks; before the slip it never finished.
  check("both arrive, near unobstructed time", doneAt > 0 && doneAt < 350, `took ${doneAt} ticks`);
}

console.log("...and from a COLD START, already touching, velocities zero:");
{
  // The in-game killer the vel-based test missed: both steps get projected
  // away, both vels read zero, and a vel-based opposing test never re-arms.
  // The published moveIntent stays hot while stalled, so the pair still slips.
  const w = world();
  const a = new TacOracle(vec(0, 0), { team: "blue", z: 0 });
  const b = new TacOracle(vec(CONTACT - 6, 0), { team: "blue", z: 0 });
  const ai = ctx(w, [a, b]);
  let doneAt = -1;
  for (let t = 1; t <= 600 && doneAt < 0; t++) {
    (ai as any).tick = t;
    (a as any).stepToward(ai, vec(600, 0));
    (b as any).stepToward(ai, vec(-600 + CONTACT, 0));
    if (a.pos.x > 300 && b.pos.x < -300) doneAt = t;
  }
  check("the stalled pair still passes (intent, not vel)", doneAt > 0 && doneAt < 350,
    `took ${doneAt < 0 ? ">600" : doneAt} ticks`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
