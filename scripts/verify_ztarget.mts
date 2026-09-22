/**
 * Verifies target selection across z levels.
 *
 * Rounds are z-bound, so the AI used to drop anyone on another floor from
 * consideration outright. On a staircase that reads badly: stairZ is sharp, so a
 * bot flips its own z at the stair midpoint, and an enemy standing right there
 * would blink in and out of the candidate set while the bot reached past it for
 * whoever shared its level. Off-level hostiles are now COSTED rather than
 * excluded — chased, never shot at.
 *
 * Since 2026-09-21 ONE ranking covers every hostile (TacOracle.rankHostiles):
 * shootable = lane + straight range; not shootable right now — behind a wall on
 * our level OR on another floor — = the no-lane sentinel + the WALK. The winner
 * is the aim TARGET only when shootable or about to be (pre-aim: within
 * PREAIM_SIGHT_DIST of travel from a sight line, either direction); otherwise it
 * is chase-only, reached through bestChase. A pre-aimed enemy gets the muzzle
 * but never a round until actually exposed.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_ztarget.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vz.mjs && node <tmp>/vz.mjs
 */
import { TacOracle } from "../src/ai/tacoracle.ts";
import { Character } from "../src/entities/actor.ts";
import { DEFAULT_SKIN } from "../src/entities/character.ts";
import { Gun } from "../src/entities/gun.ts";
import { AK47, UNARMED } from "../src/entities/guns.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { makeWall, type World } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { norm, sub, vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

const world = (obstacles: any[] = []): World => {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [],
  } as unknown as World;
  (w as any).grid = new ObstacleGrid(obstacles);
  return w;
};
const ctx = (w: World, chars: Character[]): AiContext =>
  ({ world: w, characters: chars, nav: undefined, tick: 0 } as any);

function bot(at = vec(0, 0), z = 0): TacOracle {
  const b = new TacOracle(vec(at.x, at.y), { team: "blue", z, realGun: true, stagger: 5 });
  (b as any).slots.primary = new Gun(AK47);
  b.equip("primary");
  while (b.gun.drawing) b.gun.tick();
  b.z = z;
  return b;
}
const foe = (x: number, y: number, z: number): Character => {
  const c = new Character(vec(x, y), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
  c.team = "red" as any;
  c.z = z;
  return c;
};
const pick = (b: TacOracle, ai: AiContext): Character | null => (b as any).selectTarget(ai);
const chase = (b: TacOracle, ai: AiContext): Character | null => (b as any).bestChase(ai);
/** Put `b` in the state a bot is in when the trigger is genuinely live, aimed at
 *  `t` — otherwise "holds fire" passes for reasons that have nothing to do with z. */
function armForFiring(b: TacOracle, t: Character): void {
  b.forward = norm(sub(t.pos, b.pos));
  b.vel = vec(0, 0); // AK-47 is a stand-to-shoot gun; moving would veto on its own
  const any = b as any;
  any.mode = "shoot";
  any.fireOk = true;
  any.burstDone = false;
  any.clickIn = 0;
  any.aimError = vec(0, 0);
}
const wouldFire = (b: TacOracle, ai: AiContext, t: Character): boolean => (b as any).shouldFire(ai, t);

const REACH = new Gun(AK47).feasibleRange;

// ------------------------------------------------------------- selection ------
console.log("who a bot picks when the floors differ:");
{
  const w = world();
  // A shootable enemy on this floor, and a nearer one a floor up.
  const b = bot();
  const here = foe(600, 0, 0);
  const upstairs = foe(120, 0, 1);
  check("a shootable target on THIS floor wins, even against a nearer one above",
    pick(b, ctx(w, [b, here, upstairs])) === here);

  // Nothing on this floor: the one upstairs is not ignored. Right by us (within
  // pre-aim reach) it is the target itself; further off it is chase-only — the
  // walk goes after it while the gun stays free.
  const b2 = bot();
  const only = foe(200, 0, 1);
  check("with nobody on this floor, one right above is pre-aimed (a target)",
    pick(b2, ctx(w, [b2, only])) === only);
  const b2f = bot();
  const far = foe(900, 0, 1);
  const aiFar = ctx(w, [b2f, far]);
  check("...one further above is not a target (nothing to aim at yet)", pick(b2f, aiFar) === null);
  check("...but it IS what the bot walks after", chase(b2f, aiFar) === far);

  // Out of the gun's reach on this floor vs close by on another: prefer the one
  // that can actually be reached on foot.
  const b3 = bot();
  const faraway = foe(REACH + 800, 0, 0);
  const nearAbove = foe(150, 0, 1);
  check(`an unreachable enemy on this floor (${Math.round(REACH)}px gun) loses to a close one above`,
    pick(b3, ctx(w, [b3, faraway, nearAbove])) === nearAbove);
}

// ---------------------------------------------------- hidden, same level -------
// A wall is cover you walk around, exactly as a floor is: a hostile behind one on
// OUR level competes on the same walk-costed terms as one on another floor.
console.log("a hidden enemy on this floor competes like an off-level one:");
{
  // A thick wall between us and x>500; no nav graph, so the walk is the line.
  const w = world([makeWall(vec(400, 0), 200, 600, 0)]);
  const b = bot();
  const hidden = foe(700, 0, 0);
  const above = foe(1500, 0, 1);
  const ai = ctx(w, [b, hidden, above]);
  check("neither is a target (nothing shootable, nobody about to be)", pick(b, ai) === null);
  check("the nearer one by foot is chased, even though it is behind a wall on our level",
    chase(b, ai) === hidden);

  // Pre-aim: the same wall, the enemy just the other side of it.
  const b2 = bot();
  const near = foe(380, 0, 0);
  const w2 = world([makeWall(vec(200, 0), 200, 600, 0)]);
  const ai2 = ctx(w2, [b2, near]);
  check("an enemy within pre-aim reach behind the wall IS the target", pick(b2, ai2) === near);
  armForFiring(b2, near);
  check("...held in the sights but NOT fired at through the wall", !wouldFire(b2, ai2, near));
  check("...nor is a heavy gun planted on it", !(b2 as any).standToShoot(ai2, near));
  // They step out on our side of the wall: same focus, now a real shot.
  near.pos = vec(80, 0);
  armForFiring(b2, near);
  check("...and the tick they step out, it fires", pick(b2, ai2) === near && wouldFire(b2, ai2, near));
}

// ---------------------------------------------------------------- firing ------
console.log("what it does with an off-level target:");
{
  const w = world();
  const b = bot();
  const above = foe(200, 0, 1);
  armForFiring(b, above);
  check("it will NOT fire at it — rounds are z-bound", !wouldFire(b, ctx(w, [b, above]), above));
  check("...nor plant a heavy gun on it", !(b as any).standToShoot(ctx(w, [b, above]), above));

  // The same target on our own level is fired at normally, so the veto is the z
  // difference and nothing else about this setup.
  above.z = 0;
  check("the same target on this floor IS fired at", wouldFire(b, ctx(w, [b, above]), above));
}

// ------------------------------------------------------------ stair churn -----
// The case that motivated this: crossing a stair midpoint flips the bot's own z.
console.log("a bot crossing a stair midpoint keeps its target:");
{
  const w = world();
  const b = bot();
  const enemy = foe(400, 0, 0);
  const ai = ctx(w, [b, enemy]);
  check("it locks on first", pick(b, ai) === enemy);

  // Walk over the midpoint: same world, same enemy, the bot's z flips.
  b.z = 1;
  const afterFlip = pick(b, ai);
  check("its own z flipping does not drop the lock", afterFlip === enemy,
    `${afterFlip === null ? "null" : "kept"}`);
  // Arm the trigger properly, so the two checks below turn on z and nothing else.
  armForFiring(b, enemy);
  check("...and it holds fire while the floors differ", !wouldFire(b, ai, enemy));
  b.z = 0;
  check("...then fires again once they match", wouldFire(b, ai, enemy));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
