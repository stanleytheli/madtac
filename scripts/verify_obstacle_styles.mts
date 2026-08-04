/**
 * Verifies the obstacle registry after barrels stopped being inferred from the
 * generic `round` + `cross` flags and got an explicit `style` instead.
 *
 * Two things are easy to break here. `match` predicates must partition the shared
 * obstacle array — an obstacle matching two defs gets written to the level twice
 * under different kinds, one matching none silently vanishes on save. And the
 * circular kinds must keep `round` set, since that is what collision.ts dispatches
 * the circle collider on; the style split is meant to be cosmetic only.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_obstacle_styles.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vo.mjs && node <tmp>/vo.mjs
 */
import { ENTITY_DEFS, loadLevel, serializeLevel } from "../src/world/level.ts";
import {
  makeBarrelMetal,
  makeBarrelWood,
  makeCircle,
  makeCrate,
  makeFence,
  makeWall,
  type Obstacle,
} from "../src/world/world.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "  ok" : "FAIL"}  ${name}${extra ? `   — ${extra}` : ""}`);
};

const EMPTY = `{ "version": 1, "entities": [] }`;

/** One of every obstacle kind, at distinct positions so they're identifiable. */
const samples: { kind: string; make: () => Obstacle }[] = [
  { kind: "wall", make: () => makeWall(vec(0, 0), 140, 20, 0) },
  { kind: "crate", make: () => makeCrate(vec(100, 0), 64, 64, 0) },
  { kind: "fence", make: () => makeFence(vec(200, 0), 140, 14, 0) },
  { kind: "circle", make: () => makeCircle(vec(300, 0), 30, 0) },
  { kind: "barrel_metal", make: () => makeBarrelMetal(vec(400, 0), 30, 0) },
  { kind: "barrel_wood", make: () => makeBarrelWood(vec(500, 0), 30, 0) },
];

console.log("\nevery obstacle matches EXACTLY ONE entity def:");
for (const s of samples) {
  const e = s.make();
  // Only the defs that live in world.obstacles can claim an obstacle.
  const state = loadLevel(EMPTY);
  const obstacleDefs = ENTITY_DEFS.filter((d) => d.list(state) === state.world.obstacles);
  const matched = obstacleDefs.filter((d) => d.match(e));
  check(
    `${s.kind} -> ${matched.map((d) => d.kind).join(",") || "(none)"}`,
    matched.length === 1 && matched[0].kind === s.kind,
    `${matched.length} match(es)`,
  );
}

console.log("\ncircular kinds keep the circle COLLIDER (round), differ only in style:");
{
  const c = makeCircle(vec(0, 0), 30, 0);
  const m = makeBarrelMetal(vec(0, 0), 30, 0);
  const w = makeBarrelWood(vec(0, 0), 30, 0);
  check("plain circle is round", c.round === true);
  check("metal barrel is round", m.round === true);
  check("wood barrel is round", w.round === true);
  check("plain circle carries no style", c.style === undefined, String(c.style));
  check("metal barrel styled", m.style === "barrel_metal", String(m.style));
  check("wood barrel styled", w.style === "barrel_wood", String(w.style));
  // cross used to be the wood/metal discriminator; it must no longer say anything
  // about a circle, or the old inference is still lurking.
  check("no circular kind relies on cross any more", !c.cross && !m.cross && !w.cross);
  check("crate still uses cross for its planks", makeCrate(vec(0, 0), 64, 64, 0).cross === true);
}

console.log("\nround-trip through the level format preserves every kind:");
{
  const state = loadLevel(EMPTY);
  for (const s of samples) state.world.obstacles.push(s.make());
  const text = serializeLevel(state);

  for (const s of samples) {
    check(`${s.kind} written to the level string`, text.includes(`"kind":"${s.kind}"`));
  }

  const back = loadLevel(text);
  check(
    "same obstacle count after reload",
    back.world.obstacles.length === samples.length,
    `${back.world.obstacles.length} vs ${samples.length}`,
  );

  const reState = loadLevel(EMPTY);
  const obstacleDefs = ENTITY_DEFS.filter((d) => d.list(reState) === reState.world.obstacles);
  const kindOf = (e: Obstacle): string => obstacleDefs.find((d) => d.match(e))?.kind ?? "(none)";
  const got = back.world.obstacles.map(kindOf).sort();
  const want = samples.map((s) => s.kind).sort();
  check("kinds survive the round trip", got.join(",") === want.join(","), `${got.join(",")}`);

  const styles = back.world.obstacles.filter((o) => o.round).map((o) => o.style ?? "(plain)").sort();
  check(
    "circular styles survive",
    styles.join(",") === ["(plain)", "barrel_metal", "barrel_wood"].join(","),
    styles.join(","),
  );
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
