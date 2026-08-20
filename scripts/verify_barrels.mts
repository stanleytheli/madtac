/**
 * Verifies circular ("barrel") obstacles behave as a CIRCLE — not the bounding
 * box — across every geometry query in the game, and that the two variants
 * (metal / wood) round-trip through the level format.
 *
 * The recurring trick: a point/segment that clips a bounding-box CORNER but
 * stays outside the inscribed circle. A box obstacle blocks it; a barrel must
 * not. Each check pairs the barrel against a same-size square wall so the
 * circle-vs-box difference is explicit, not just asserted.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_barrels.mts --bundle
 *   --platform=node --format=esm --outfile=<tmp>/vb.mjs && node <tmp>/vb.mjs
 */
import {
  ObstacleGrid,
  circleIntersectsObstacle,
  obstacleRadius,
  pointInObstacle,
  resolveCircleVsObstacle,
  segmentIntersectsObstacle,
} from "../src/engine/collision.ts";
import { makeBarrelMetal, makeBarrelWood, makeWall, type Obstacle } from "../src/world/world.ts";
import { CRATE_SHRAPNEL, METAL_SPARKS } from "../src/engine/particle.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { ENTITY_DEFS, loadLevel, serializeLevel } from "../src/world/level.ts";
import { dist, vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

// A 64px barrel at the origin: radius 32, bounding square [-32,32]^2. Its corners
// (±32,±32) sit at distance ~45 — well outside the circle. A same-size square
// wall is the box control.
const barrel = makeBarrelMetal(vec(0, 0), 32, 0);
const wall = makeWall(vec(0, 0), 64, 64, 0);
// A point in the box corner, outside the circle (dist 35.4 > 32).
const CORNER = vec(25, 25);
// A segment along x+y=50 (dist from origin 35.4): crosses the square, misses the circle.
const A: Vec2 = vec(10, 40);
const B: Vec2 = vec(40, 10);

console.log("radius is derived from the smaller extent:");
check("obstacleRadius = w/2", obstacleRadius(barrel) === 32, `r=${obstacleRadius(barrel)}`);

console.log("point-in: a corner point is inside the box but outside the barrel:");
check("point in the square wall", pointInObstacle(CORNER, wall));
check("point NOT in the barrel", !pointInObstacle(CORNER, barrel));
check("barrel centre is inside", pointInObstacle(vec(0, 0), barrel));

console.log("sight: a ray clipping the corner is blocked by the wall, not the barrel:");
check("wall blocks the corner-clipping ray", segmentIntersectsObstacle(A, B, wall));
check("barrel does NOT block it", !segmentIntersectsObstacle(A, B, barrel));
check("barrel blocks a ray through its centre", segmentIntersectsObstacle(vec(-100, 0), vec(100, 0), barrel));

console.log("overlap: a body touching only the box corner overlaps the wall, not the barrel:");
// Body centre 50px out along the diagonal: 70.7 from centre. Circle+body = 62 (clear),
// but the box's nearest corner is only 25.5 away (< 30, overlap).
const near5050 = vec(50, 50);
check("body overlaps the square wall's corner", circleIntersectsObstacle(near5050, BODY_RADIUS, wall));
check("body clears the barrel", !circleIntersectsObstacle(near5050, BODY_RADIUS, barrel));

console.log("push-out is radial and lands exactly at r + body radius:");
const inside = resolveCircleVsObstacle(vec(5, 0), BODY_RADIUS, barrel);
check("straight push lands at the surface", near(dist(inside, vec(0, 0)), 32 + BODY_RADIUS, 1e-6), `d=${dist(inside, vec(0, 0)).toFixed(2)}`);
check("straight push stays on-axis", near(inside.y, 0, 1e-9));
const diag = resolveCircleVsObstacle(vec(20, 20), BODY_RADIUS, barrel);
check("diagonal push lands at the surface", near(dist(diag, vec(0, 0)), 32 + BODY_RADIUS, 1e-6));
check("diagonal push preserved the 45° bearing", near(diag.x, diag.y, 1e-9));
const farBody = vec(200, 0);
check("a body well clear is untouched", dist(resolveCircleVsObstacle(farBody, BODY_RADIUS, barrel), farBody) === 0);

console.log("spatial grid honours the circle for hit() and solidCircle():");
const grid = new ObstacleGrid([barrel]);
const wallGrid = new ObstacleGrid([wall]);
check("grid.hit finds the barrel at its centre", grid.hit(vec(0, 0), 0) === barrel);
check("grid.hit misses at the box corner", grid.hit(CORNER, 0) === null);
check("the box grid HITS at that same corner", wallGrid.hit(CORNER, 0) === wall);
// A body-sized probe just past a corner: the wall blocks the march, the barrel doesn't.
check("solidCircle blocked by the barrel centre", grid.solidCircle(vec(0, 0), BODY_RADIUS, 0));
check("solidCircle clear past the barrel corner", !grid.solidCircle(near5050, BODY_RADIUS, 0));
check("the same probe is blocked by the square wall", wallGrid.solidCircle(near5050, BODY_RADIUS, 0));

console.log("the two variants carry the right shrapnel + look:");
check("metal barrel is round, bare (no cross), steel sparks", !!barrel.round && !barrel.cross && barrel.particle === METAL_SPARKS);
const wood = makeBarrelWood(vec(0, 0), 32, 0);
check("wood barrel is round, planked (cross), wood splinters", !!wood.round && !!wood.cross && wood.particle === CRATE_SHRAPNEL);

console.log("the editor registry routes each variant to its own kind:");
const OBSTACLE_KINDS = ["wall", "crate", "fence", "barrel_metal", "barrel_wood"];
const kindOf = (e: Obstacle): string | null =>
  ENTITY_DEFS.find((d) => OBSTACLE_KINDS.includes(d.kind) && d.match(e))?.kind ?? null;
check("metal barrel -> barrel_metal", kindOf(barrel) === "barrel_metal", `${kindOf(barrel)}`);
check("wood barrel -> barrel_wood", kindOf(wood) === "barrel_wood", `${kindOf(wood)}`);
check("a plain wall still -> wall (not a barrel)", kindOf(wall) === "wall", `${kindOf(wall)}`);

console.log("level round-trip preserves shape, variant, and size:");
const lvl = `{ "version": 1, "entities": [
  {"kind":"barrel_metal","x":100,"y":0,"w":64,"h":64},
  {"kind":"barrel_wood","x":200,"y":-50,"w":80,"h":80}
] }`;
const state = loadLevel(lvl);
const obs = state.world.obstacles;
check("both barrels loaded", obs.length === 2);
const m = obs.find((o) => o.round && !o.cross);
const wdb = obs.find((o) => o.round && o.cross);
check("metal barrel loaded round with r=32", !!m && obstacleRadius(m) === 32);
check("wood barrel loaded round with r=40", !!wdb && obstacleRadius(wdb) === 40);
const re = serializeLevel(state);
check("re-serialized string keeps barrel_metal", re.includes('"barrel_metal"'));
check("re-serialized string keeps barrel_wood", re.includes('"barrel_wood"'));
// Reload the re-serialized string: identical obstacle shapes survive a full cycle.
const state2 = loadLevel(re);
check("reload keeps both round barrels", state2.world.obstacles.filter((o) => o.round).length === 2);

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
