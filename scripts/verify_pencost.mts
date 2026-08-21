/**
 * Verifies ObstacleGrid.penetrationCost — the closed-form "what does this lane
 * cost to shoot through" query the AI sight checks and the wallbang code lean on.
 *
 * The check that matters is DIFFERENTIAL: the same lanes are priced by marching a
 * fine step along them and summing the material found, which is ground truth by
 * construction, and the analytic answer has to match. Random geometry, rotated
 * boxes, circles, overlapping walls, mixed multipliers.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_pencost.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vpc.mjs && node <tmp>/vpc.mjs
 */
import { ObstacleGrid, pointInObstacle, segmentSpanInObstacle } from "../src/engine/collision.ts";
import { makeBarrelMetal, makeCrate, makeWall, type Obstacle } from "../src/world/world.ts";
import { deg2rad, vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

// Deterministic PRNG so a failure is reproducible.
let seed = 12345;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const range = (a: number, b: number): number => a + rnd() * (b - a);

/**
 * Ground truth: march the lane in fine steps, and at each step charge the
 * highest multiplier covering that point (material is priced once however many
 * obstacles overlap there). Dead slow, exact enough to judge by.
 */
function marchedCost(obstacles: Obstacle[], a: Vec2, b: Vec2, z: number, step = 0.05): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.ceil(len / step);
  const dx = (b.x - a.x) / n;
  const dy = (b.y - a.y) / n;
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const p = vec(a.x + dx * (i + 0.5), a.y + dy * (i + 0.5));
    let m = 0;
    for (const o of obstacles) {
      if (o.z !== z || o.permeable) continue;
      if (pointInObstacle(p, o)) m = Math.max(m, Math.max(0, o.thicknessMul ?? 1));
    }
    cost += m * (len / n);
  }
  return cost;
}

// --------------------------------------------------------------- basics -------
console.log("the span a segment spends inside one obstacle:");
{
  const w = makeWall(vec(0, 0), 40, 400, 0);
  const span = segmentSpanInObstacle(vec(-100, 0), vec(100, 0), w)!;
  check("straight through a 40px wall is 40px of the 200px lane",
    !!span && Math.abs((span[1] - span[0]) * 200 - 40) < 1e-9, `${((span[1] - span[0]) * 200).toFixed(3)}`);
  const diag = segmentSpanInObstacle(vec(-100, -100), vec(100, 100), w)!;
  check("at 45 degrees it is 40*sqrt(2) — an angled shot crosses more material",
    Math.abs((diag[1] - diag[0]) * Math.hypot(200, 200) - 40 * Math.SQRT2) < 1e-6,
    `${((diag[1] - diag[0]) * Math.hypot(200, 200)).toFixed(3)}`);
  check("a miss is null", segmentSpanInObstacle(vec(-100, 300), vec(100, 300), w) === null);
  const rot = { ...makeWall(vec(0, 0), 40, 400, 0), angle: deg2rad(45) };
  const r = segmentSpanInObstacle(vec(-200, 0), vec(200, 0), rot)!;
  check("a wall rotated 45 degrees reads 40*sqrt(2) across, not 40",
    Math.abs((r[1] - r[0]) * 400 - 40 * Math.SQRT2) < 1e-6, `${((r[1] - r[0]) * 400).toFixed(3)}`);
  const circ = segmentSpanInObstacle(vec(-100, 0), vec(100, 0), makeBarrelMetal(vec(0, 0), 32, 0))!;
  check("through a barrel's center is its diameter", Math.abs((circ[1] - circ[0]) * 200 - 64) < 1e-9,
    `${((circ[1] - circ[0]) * 200).toFixed(3)}`);
  const graze = segmentSpanInObstacle(vec(-100, 31), vec(100, 31), makeBarrelMetal(vec(0, 0), 32, 0))!;
  check("a graze near its edge is a short chord", !!graze && (graze[1] - graze[0]) * 200 < 20,
    `${((graze[1] - graze[0]) * 200).toFixed(1)}px`);
  check("passing outside it is null",
    segmentSpanInObstacle(vec(-100, 40), vec(100, 40), makeBarrelMetal(vec(0, 0), 32, 0)) === null);
}

// ------------------------------------------------------- differential ---------
console.log("\nanalytic vs. marched, over random geometry:");
{
  let worst = 0;
  let worstCase = "";
  let lanes = 0;
  let withMaterial = 0;
  for (let trial = 0; trial < 60; trial++) {
    const obstacles: Obstacle[] = [];
    const n = 3 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const x = range(-400, 400);
      const y = range(-400, 400);
      const pick = rnd();
      let o: Obstacle;
      if (pick < 0.45) o = makeWall(vec(x, y), range(20, 120), range(20, 300), 0);
      else if (pick < 0.7) o = makeCrate(vec(x, y), range(40, 140), range(40, 140), 0);
      else o = makeBarrelMetal(vec(x, y), range(20, 60), 0);
      if (rnd() < 0.4 && !o.round) o.angle = deg2rad(range(0, 180));
      if (rnd() < 0.5) o.thicknessMul = [0, 0.25, 0.5, 1, 2, 3][Math.floor(rnd() * 6)];
      obstacles.push(o);
    }
    const grid = new ObstacleGrid(obstacles);
    for (let s = 0; s < 25; s++) {
      const a = vec(range(-600, 600), range(-600, 600));
      const b = vec(range(-600, 600), range(-600, 600));
      const truth = marchedCost(obstacles, a, b, 0);
      const got = grid.penetrationCost(a, b, 0, Infinity);
      lanes++;
      if (truth > 0.01) withMaterial++;
      const diff = Math.abs((got ?? -1) - truth);
      if (diff > worst) {
        worst = diff;
        worstCase = `truth ${truth.toFixed(3)} vs analytic ${(got ?? NaN).toFixed(3)}`;
      }
    }
  }
  check(`priced ${lanes} random lanes (${withMaterial} crossing material)`, lanes > 1000);
  // The march samples at 0.05px, so it quantizes the true answer by up to that
  // per material boundary; a handful of boundaries per lane is the tolerance.
  check("analytic matches the marched price everywhere", worst < 0.3,
    `worst disagreement ${worst.toFixed(4)}px  (${worstCase})`);
}

// ------------------------------------------------------ budget + blocked ------
console.log("\nthe budget answer agrees with the plain blocking test:");
{
  let mismatches = 0;
  let bothWays = 0;
  for (let trial = 0; trial < 40; trial++) {
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < 5; i++) {
      const o = makeWall(vec(range(-300, 300), range(-300, 300)), range(20, 100), range(20, 200), 0);
      if (rnd() < 0.3) o.angle = deg2rad(range(0, 180));
      obstacles.push(o); // no zero muls here: those are meant to diverge
    }
    const grid = new ObstacleGrid(obstacles);
    for (let s = 0; s < 25; s++) {
      const a = vec(range(-500, 500), range(-500, 500));
      const b = vec(range(-500, 500), range(-500, 500));
      const clearByCost = grid.penetrationCost(a, b, 0, 0) === 0;
      const clearByBlocked = !grid.blocked(a, b, 0);
      if (clearByCost !== clearByBlocked) mismatches++;
      bothWays++;
    }
  }
  check(`a 0 budget reproduces blocked() exactly (${bothWays} lanes)`, mismatches === 0,
    `${mismatches} disagreements`);
}

// ------------------------------------------------------------- rules ----------
console.log("\nthe rules the sim plays by:");
{
  const wall = (x: number, t: number, mul?: number): Obstacle => {
    const o = makeWall(vec(x, 0), t, 400, 0);
    if (mul !== undefined) o.thicknessMul = mul;
    return o;
  };
  const cost = (obstacles: Obstacle[], budget: number): number | null =>
    new ObstacleGrid(obstacles).penetrationCost(vec(-300, 0), vec(300, 0), 0, budget);

  check("a clear lane costs nothing", cost([], 0) === 0);
  check("one 40px wall costs 40", Math.abs((cost([wall(0, 40)], 100) ?? -1) - 40) < 1e-9);
  check("two of them cost 80", Math.abs((cost([wall(-100, 40), wall(100, 40)], 100) ?? -1) - 80) < 1e-9);
  check("over budget is null, not a number", cost([wall(0, 40)], 39) === null);
  check("exactly on budget gets through — not decided by float noise",
    Math.abs((cost([wall(0, 40)], 40) ?? -1) - 40) < 1e-6, `${cost([wall(0, 40)], 40)}`);
  check("thicknessMul prices it", Math.abs((cost([wall(0, 40, 2)], 100) ?? -1) - 80) < 1e-9);
  check("a free pass costs nothing even at 0 budget", cost([wall(0, 40, 0)], 0) === 0);
  check("...though it is still a solid obstacle to blocked()",
    new ObstacleGrid([wall(0, 40, 0)]).blocked(vec(-300, 0), vec(300, 0), 0));
  // The overlap rule: two walls sharing space are one wall's worth of material.
  const stacked = [wall(0, 40), wall(0, 40)];
  check("a doubled-up wall is charged once, not twice",
    Math.abs((cost(stacked, 100) ?? -1) - 40) < 1e-9, `${cost(stacked, 100)}`);
  const half = [wall(0, 40), wall(20, 40)]; // overlap on [0,20]
  check("partly overlapping walls charge the union, not the sum",
    Math.abs((cost(half, 100) ?? -1) - 60) < 1e-6, `${cost(half, 100)}`);
  check("where they overlap, the dearer multiplier wins",
    Math.abs((cost([wall(0, 40, 1), wall(0, 40, 3)], 200) ?? -1) - 120) < 1e-6,
    `${cost([wall(0, 40, 1), wall(0, 40, 3)], 200)}`);
  check("a fence costs nothing — it never stopped anything",
    cost([{ ...wall(0, 40), permeable: true }], 0) === 0);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
