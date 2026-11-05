/**
 * Verifies blast scorches on stairs: a flight is a surface of both levels it
 * joins, so a blast at either end burns it — and the mark's stair part draws in
 * the flight's own pass (its lower level's), the floor part in the blast's.
 * Drives drawScorches through a recording context to see which pass paints what.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_scorch.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vsc.mjs && node <tmp>/vsc.mjs
 */
import { drawScorches, stampScorch, type Scorch } from "../src/engine/scorch.ts";
import { makeFloor, makeStairs, type Floor, type Stairs } from "../src/world/world.ts";
import { vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

// Node has no Path2D: a stand-in that counts the closed sub-paths (one per rect).
class FakePath {
  rects = 0;
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {
    this.rects++;
  }
}
(globalThis as any).Path2D = FakePath;

/** One pass of drawScorches: how many marks it painted, and the clip each had
 *  (null = unclipped, else the number of rects in it). */
function pass(scorches: Scorch[], z: number): (number | null)[] {
  const draws: (number | null)[] = [];
  let clip: FakePath | null = null;
  const ctx = {
    globalAlpha: 1,
    save() {},
    restore() {
      clip = null;
    },
    clip(p: FakePath) {
      clip = p;
    },
    translate() {},
    rotate() {},
    drawImage() {
      draws.push(clip ? clip.rects : null);
    },
  } as unknown as CanvasRenderingContext2D;
  drawScorches(ctx, scorches, {} as CanvasImageSource, z, () => true);
  return draws;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// A 0 -> 1 flight along y: the low end at y = -100, the high end at y = +100.
const flight = (): Stairs => makeStairs(vec(0, 0), 120, 200, "y", 0, 1, [0, 1], "#7c6034");
const ground = (): Floor => makeFloor(vec(0, 0), 4000, 4000, "#555", { level: 0, infinite: true });
const lobby = (): Floor => makeFloor(vec(0, -400), 600, 600, "#555", { level: 0 }); // ends at y = -100
const landing = (): Floor => makeFloor(vec(0, 200), 300, 200, "#555", { level: 1 }); // starts at y = +100
const SIZE = 150;

console.log("a blast at the top end burns the flight:");
{
  const s = flight();
  const out: Scorch[] = [];
  stampScorch(out, [ground()], [s], vec(0, 50), 1, SIZE); // on the steps you stand on at z 1
  check("it leaves a mark with no floor under it", out.length === 1 && out[0].floors?.length === 0);
  check("...on the flight", out.length === 1 && out[0].stairs.length === 1 && out[0].stairs[0] === s);
  check("the blast's own pass has nothing of it to paint", same(pass(out, 1), []), `${JSON.stringify(pass(out, 1))}`);
  check("the flight's pass paints it, clipped to the flight", same(pass(out, 0), [1]), `${JSON.stringify(pass(out, 0))}`);

  const low: Scorch[] = [];
  stampScorch(low, [ground()], [s], vec(0, -50), 1, SIZE); // over the low half, from z 1
  check("so does one over the low half", low.length === 1 && same(pass(low, 0), [1]));
}

console.log("\nat the top of the flight, it spans the landing and the steps:");
{
  const out: Scorch[] = [];
  stampScorch(out, [ground(), landing()], [flight()], vec(0, 100), 1, SIZE);
  check("the landing part paints in the blast's pass", same(pass(out, 1), [1]), `${JSON.stringify(pass(out, 1))}`);
  check("the steps part paints in the flight's pass", same(pass(out, 0), [1]), `${JSON.stringify(pass(out, 0))}`);
}

console.log("\nat the bottom end:");
{
  const out: Scorch[] = [];
  stampScorch(out, [ground()], [flight()], vec(0, -50), 0, SIZE);
  check("on open ground the mark is unclipped (the ground covers the steps too)",
    out.length === 1 && out[0].floors === null && out[0].stairs.length === 0);
  check("...and paints once, in its own pass", same(pass(out, 0), [null]) && same(pass(out, 1), []));

  const indoors: Scorch[] = [];
  stampScorch(indoors, [lobby()], [flight()], vec(0, -100), 0, SIZE);
  check("indoors, the floor and the steps share one clip — painted once, not twice",
    same(pass(indoors, 0), [2]), `${JSON.stringify(pass(indoors, 0))}`);
}

console.log("\nwhat it doesn't do:");
{
  const out: Scorch[] = [];
  stampScorch(out, [], [flight()], vec(0, 0), 2, SIZE);
  check("a flight that doesn't touch the blast's level takes no mark", out.length === 0);
  const far: Scorch[] = [];
  stampScorch(far, [], [flight()], vec(1000, 0), 1, SIZE);
  check("nor does one it doesn't reach", far.length === 0);

  const s = flight();
  const hidden: Scorch[] = [];
  stampScorch(hidden, [], [s], vec(0, 50), 1, SIZE);
  s.alpha = 0; // faded out for this viewer: drawLevel skips it
  check("a flight the viewer can't see shows none of its mark", same(pass(hidden, 0), []));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
