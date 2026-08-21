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
  obstacleShrapnel,
} from "../src/world/world.ts";
import { globSync, readFileSync } from "node:fs";
import { borderFit } from "../src/engine/collision.ts";
import { VEHICLE_SPECS } from "../src/entities/vehicles.ts";
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

// --------------------------------------------------- borders show the hitbox ---
// A canvas stroke straddles its path, so a border drawn on an obstacle's own edge
// paints half its width OUTSIDE the collider. borderInset pulls it in; what this
// pins is the property that buys: the painted silhouette never exceeds the box a
// bullet or a body actually hits, and never misses it by more than a px either.
console.log("\nborders paint inside the collider, not around it:");
{
  // Painted half-extent along an axis: the inset path plus the half-stroke that
  // still hangs off it outward.
  const painted = (half: number, sw: number, thin: number): number => {
    const { width, inset } = borderFit(sw, thin);
    return half - inset + width / 2;
  };

  let worstOut = -Infinity;
  let worstGap = 0;
  let cases = 0;
  for (const thin of [4, 5, 14, 20, 26, 40, 60, 64, 80, 100, 140]) {
    for (const sw of [0, 1, 2, 3, 4, 5, 6, 7, 9, 12, 20, 40]) {
      const over = painted(thin / 2, sw, thin) - thin / 2; // +ve = paint outside the hitbox
      worstOut = Math.max(worstOut, over);
      worstGap = Math.max(worstGap, -over);
      cases++;
    }
  }
  check(`never paints outside the collider (${cases} shape x stroke combinations)`,
    worstOut <= 0, `worst overshoot ${worstOut.toFixed(2)}px`);
  check("...and never falls more than a px short of it", worstGap <= 1,
    `worst gap ${worstGap.toFixed(2)}px`);
  check("an even stroke lands exactly on the edge", painted(20, 6, 40) === 20);
  check("an odd one rounds inward, by half a px", painted(20, 5, 40) === 19.5);
  check("a stroke thicker than the shape is cut down to fill it, not overrun it",
    borderFit(40, 14).width === 14 && borderFit(40, 14).inset === 7 &&
    painted(7, 40, 14) === 7, `w=${borderFit(40, 14).width} inset=${borderFit(40, 14).inset}`);
  check("a zero stroke insets nothing and has no width to draw",
    borderFit(0, 40).inset === 0 && borderFit(0, 40).width === 0);
  check("the shipped strokes are never clamped (all thinner than what they outline)",
    borderFit(6, 40).width === 6 && borderFit(9, 100).width === 9 && borderFit(5, 14).width === 5);
  // Vehicle hull parts are colliders too — they stop rounds and bodies — so the
  // shipped ones get the same treatment, checked against their real dimensions.
  let parts = 0;
  let hullWorst = -Infinity;
  for (const v of Object.values(VEHICLE_SPECS) as any[]) {
    for (const part of v.parts ?? []) {
      if (!part.stroke || !part.strokeWidth) continue;
      const thin = Math.min(part.w, part.h);
      hullWorst = Math.max(hullWorst, painted(thin / 2, part.strokeWidth, thin) - thin / 2);
      parts++;
    }
  }
  check(`every shipped vehicle part paints inside its hull box (${parts} parts)`,
    parts > 0 && hullWorst <= 0, `worst overshoot ${hullWorst.toFixed(2)}px`);

  for (const [kind, sw, thin] of [["wall", 6, 40], ["fence", 5, 20], ["crate", 9, 100]] as [string, number, number][]) {
    const over = painted(thin / 2, sw, thin) - thin / 2;
    check(`${kind} (stroke ${sw}, ${thin}px thick) now ${over === 0 ? "flush with the hitbox" : `${(-over).toFixed(1)}px inside it`}`,
      over <= 0 && over > -1, `was +${(sw / 2).toFixed(1)}px proud`);
  }
}

// ------------------------------------------------------- no border at all -----
// Canvas cannot be told to stop stroking: assigning 0 to lineWidth (or an empty
// colour to strokeStyle) is IGNORED and the previous value stays in force, so an
// obstacle authored without a border draws whatever the last thing drawn used —
// a width that changes with draw order. The renderer has to skip the stroke call
// instead, and everything downstream has to agree the border isn't there.
console.log("\nan obstacle with no border has no border:");
{
  const bare = { ...makeWall(vec(0, 0), 40, 200, 0), strokeWidth: 0 };
  check("a 0 stroke leaves nothing to draw", borderFit(bare.strokeWidth, 40).width === 0);
  check("its chips come off in its FILL, not a stroke colour nobody paints",
    obstacleShrapnel(bare).color === bare.fill, `${obstacleShrapnel(bare).color} vs fill ${bare.fill}`);
  const painted = makeWall(vec(0, 0), 40, 200, 0);
  check("...while a bordered wall still chips in its stroke",
    obstacleShrapnel(painted).color === painted.stroke);
  const noColor = { ...makeWall(vec(0, 0), 40, 200, 0), stroke: "" };
  check("an empty stroke colour counts as no border too",
    obstacleShrapnel(noColor).color === noColor.fill);

  // The shipped levels really do rely on this: borderless walls are authored.
  let bareCount = 0;
  let allZeroWidth = true;
  let allFillColored = true;
  for (const file of globSync("src/world/levels/*.json").sort()) {
    let state;
    try {
      state = loadLevel(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const o of state.world.obstacles) {
      if (o.strokeWidth > 0 && o.stroke) continue;
      bareCount++;
      if (borderFit(o.strokeWidth, Math.min(o.w, o.h)).width !== 0) allZeroWidth = false;
      if (!o.style && obstacleShrapnel(o).color !== o.fill) allFillColored = false;
    }
  }
  check(`the shipped levels author ${bareCount} borderless obstacles`, bareCount > 0);
  check("every one of them takes the no-border path", allZeroWidth);
  check("...and chips in its own fill", allFillColored);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
