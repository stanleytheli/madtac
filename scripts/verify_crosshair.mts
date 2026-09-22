/**
 * Verifies the spread crosshair, headless:
 *   - Gun.maxSpread really bounds shoot(): thousands of live shots, none exceeding
 *     the advertised bound, and the bound not absurdly loose.
 *   - it responds to the things it should (recoil accumulating, movement) and is 0
 *     for a gun that cannot fire.
 *   - ClientView.crosshairSpread tracks the aimed gun and is SMOOTHED: it converges on
 *     the truth while holding fire, but never jumps the way the raw value does.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_crosshair.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vx.mjs && node <tmp>/vx.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import { ClientView } from "../src/ui/view.ts";
import { Gun, EnemyGun } from "../src/entities/gun.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { UNARMED } from "../src/entities/guns.ts";
import { drawCrosshair } from "../src/ui/ui.ts";

// A canvas stand-in that records the crosshair's geometry, so the checks below
// read what is actually DRAWN rather than restating the arithmetic that draws it.
// Path2D is a browser global; drawCrosshair only touches it at call time, so
// shimming it here (before any call) is enough.
interface Seg { x1: number; y1: number; x2: number; y2: number }
class FakePath {
  segs: Seg[] = [];
  private cx = 0;
  private cy = 0;
  moveTo(x: number, y: number): void { this.cx = x; this.cy = y; }
  lineTo(x: number, y: number): void {
    this.segs.push({ x1: this.cx, y1: this.cy, x2: x, y2: y });
    this.cx = x;
    this.cy = y;
  }
}
(globalThis as any).Path2D = FakePath;

interface Stroke { width: number; segs: Seg[] }
interface Arc { x: number; y: number; r: number; fill: string }
function recordCrosshair(cx: number, cy: number, spread: number) {
  const strokes: Stroke[] = [];
  const arcs: Arc[] = [];
  let pending = 0;
  const ctx: any = {
    save() {}, restore() {}, beginPath() {}, fill() {},
    set lineWidth(w: number) { pending = w; },
    get lineWidth() { return pending; },
    strokeStyle: "", fillStyle: "", lineCap: "",
    stroke(p: FakePath) { strokes.push({ width: pending, segs: p.segs }); },
    arc(x: number, y: number, r: number) { arcs.push({ x, y, r, fill: ctx.fillStyle }); },
  };
  drawCrosshair(ctx as CanvasRenderingContext2D, cx, cy, spread);
  return { strokes, arcs };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? `   ${detail}` : ""}`);
}

// ---- the bound really bounds the gun -----------------------------------------
console.log("\n--- maxSpread bounds shoot() ---");
let breaches = 0;
let checked = 0;
let worstSlack = 0; // how loose the bound is at its loosest, as a ratio
for (const [name, spec] of Object.entries(GUN_SPECS)) {
  if (!spec.fire) continue;
  for (const speedRatio of [0, 0.5, 1]) {
    const gun = new Gun(spec);
    let maxSeen = 0;
    let boundAtMax = 0;
    for (let shot = 0; shot < 400; shot++) {
      // Ask BEFORE firing: the bound must cover the shot that follows it.
      const bound = gun.maxSpread(speedRatio);
      const off = Math.abs(gun.shoot(speedRatio));
      checked += 1;
      if (off > bound + 1e-9) {
        breaches += 1;
        if (breaches <= 3) console.log(`      breach: ${name} speed=${speedRatio} |off|=${off.toFixed(4)} > bound=${bound.toFixed(4)}`);
      }
      if (off > maxSeen) { maxSeen = off; boundAtMax = bound; }
      gun.mag = spec.fire.mag; // keep it firing
    }
    if (maxSeen > 1e-6) worstSlack = Math.max(worstSlack, boundAtMax / maxSeen);
  }
}
check("no shot ever exceeds maxSpread", breaches === 0, `shots=${checked} breaches=${breaches}`);
// sin() and the uniform draw mean the observed max sits below the bound, but a
// bound 10x the worst observed offset would be useless as a display.
check("the bound is tight enough to be meaningful", worstSlack < 4,
  `loosest bound / worst observed offset = ${worstSlack.toFixed(2)}x`);

// ---- responds to recoil and movement -----------------------------------------
console.log("\n--- responds to state ---");
const m16 = new Gun(GUN_SPECS.M16);
const atRest = m16.maxSpread(0);
const moving = m16.maxSpread(1);
check("movement widens it", moving > atRest, `rest=${atRest.toFixed(4)} moving=${moving.toFixed(4)}`);
for (let i = 0; i < 6; i++) { m16.shoot(0); m16.mag = 99; }
const sprayed = m16.maxSpread(0);
check("a burst widens it", sprayed > atRest, `rest=${atRest.toFixed(4)} after 6 shots=${sprayed.toFixed(4)}`);
for (let i = 0; i < 400; i++) m16.tick();
check("it settles back once recoil resets", Math.abs(m16.maxSpread(0) - atRest) < 1e-9,
  `settled=${m16.maxSpread(0).toFixed(4)}`);
// Fists: a fire spec (the punch) but no spread and no recoil coefficient, so the
// crosshair must sit fully closed rather than showing a phantom cone.
check("fists show no spread at any speed",
  new Gun(UNARMED).maxSpread(0) === 0 && new Gun(UNARMED).maxSpread(1) === 0,
  `rest=${new Gun(UNARMED).maxSpread(0)} moving=${new Gun(UNARMED).maxSpread(1)}`);
const eg = new EnemyGun(GUN_SPECS.M16, { spreadDeg: 15 });
let egBreach = 0;
for (let i = 0; i < 500; i++) if (Math.abs(eg.shoot(0)) > eg.maxSpread(0) + 1e-9) egBreach++;
check("EnemyGun's flat spread is bounded too", egBreach === 0, `breaches=${egBreach}`);

// ---- the HUD value is smoothed ----------------------------------------------
console.log("\n--- ClientView.crosshairSpread is smoothed ---");
const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena-big.json", "utf8"));
const mode = loaded.meta?.mode ?? DEFAULT_MODE;
const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
const view = new ClientView(game.player.gun.spec.zoom, game); // the client's eased HUD state
let biggestJump = 0;
let ticks = 0;
let prev = view.crosshairSpread;
for (let i = 0; i < 600; i++) {
  game.update();
  view.update(game);
  const jump = Math.abs(view.crosshairSpread - prev);
  if (i > 5) biggestJump = Math.max(biggestJump, jump);
  prev = view.crosshairSpread;
  ticks++;
}
const truth = game.aimingGun().maxSpread(game.player.speedRatio);
check("converges on the gun's own answer while idle",
  Math.abs(view.crosshairSpread - truth) < 1e-3,
  `hud=${view.crosshairSpread.toFixed(5)} gun=${truth.toFixed(5)}`);
// Easing at 0.2 can move at most 20% of the remaining gap in a tick; the largest
// plausible gap is the widest gun spread, so a per-tick jump near that means the
// value is being assigned raw rather than eased.
check("never steps more than the easing allows", biggestJump < 0.3 * 0.25,
  `largest per-tick change=${biggestJump.toFixed(5)} rad over ${ticks} ticks`);

// The point of the smoothing: slam the gun's real spread wide open and the HUD
// value must walk there over several ticks, not arrive next frame.
const settled = view.crosshairSpread;
game.player.gun.currentRecoil = 40; // as if mid-burst
const raw = game.aimingGun().maxSpread(game.player.speedRatio);
game.update();
view.update(game);
const afterOne = view.crosshairSpread;
check("a sudden real change is not applied in one tick",
  afterOne < settled + (raw - settled) * 0.9,
  `raw jumped to ${raw.toFixed(4)}, hud moved ${settled.toFixed(4)} -> ${afterOne.toFixed(4)}`);
// ...and then it tracks the gun back down as recoil decays, without being nudged.
let steps = 1;
while (
  steps < 400 &&
  Math.abs(view.crosshairSpread - game.aimingGun().maxSpread(game.player.speedRatio)) > 1e-4
) {
  game.update();
  view.update(game);
  steps += 1;
}
check("but it does converge on the gun once left alone", steps < 400,
  `tracked back to ${view.crosshairSpread.toFixed(5)} in ${steps} ticks`);

// ---- the drawn geometry -------------------------------------------------------
// The ticks used to start AT the centre, under the dot and its ring, so the first
// several px of bloom were invisible and small spreads all drew alike.
console.log("\n--- drawn geometry: the ticks clear the dot ---");
{
  /** Distance from the centre to the nearer end of each tick. The centre is taken
   *  from the dot the crosshair actually drew, not the one it was asked for: the
   *  two differ by the pixel snap, and measuring from the request would fold that
   *  offset into every gap and make the four ticks look asymmetric. */
  const innerGaps = (r: ReturnType<typeof recordCrosshair>): number[] => {
    const { x: cx, y: cy } = r.arcs[0];
    return r.strokes[0].segs.map((sg) =>
      Math.min(Math.hypot(sg.x1 - cx, sg.y1 - cy), Math.hypot(sg.x2 - cx, sg.y2 - cy)),
    );
  };

  const at0 = recordCrosshair(400, 300, 0);
  check("four ticks are drawn", at0.strokes[0].segs.length === 4);
  check("...stroked twice: a halo, then the ink over it",
    at0.strokes.length === 2 && at0.strokes[0].width > at0.strokes[1].width,
    `${at0.strokes[0].width} then ${at0.strokes[1].width}`);
  check("...and the dot is likewise a ring under a core",
    at0.arcs.length === 2 && at0.arcs[0].r > at0.arcs[1].r,
    `r=${at0.arcs[0].r} then ${at0.arcs[1].r}`);

  const gaps0 = innerGaps(at0);
  check("all four sit the same distance out (symmetric at rest)",
    Math.max(...gaps0) - Math.min(...gaps0) < 1e-9, gaps0.join(", "));

  // The load-bearing one: a tick's round cap reaches halfWidth back from its
  // endpoint, so the outline's inner edge is gap - haloWidth/2 from the centre.
  // That must clear the dot's outer ring — and only just, or the crosshair reads
  // as a ring of marks with a lost dot in the middle.
  const haloHalf = at0.strokes[0].width / 2;
  const dotOuter = at0.arcs[0].r;
  const clearance = gaps0[0] - haloHalf - dotOuter;
  check("at zero spread the ticks do NOT overlap the dot", clearance >= -1e-9,
    `clearance ${clearance.toFixed(2)}px`);
  check("...but only just — they touch, not float", clearance <= 1,
    `clearance ${clearance.toFixed(2)}px`);

  // Small spreads must now be distinguishable, which is the whole point.
  const gapAt = (spread: number): number => innerGaps(recordCrosshair(400, 300, spread))[0];
  const rest = gapAt(0);
  let monotone = true;
  let prev = rest;
  for (const sp of [0.005, 0.01, 0.02, 0.04, 0.08, 0.15]) {
    const g = gapAt(sp);
    if (g <= prev) monotone = false;
    prev = g;
  }
  check("every step up in spread pushes the ticks further out", monotone);
  check("a rifle's resting spread is already visibly off the dot",
    gapAt(0.01) - rest > 0.5, `${(gapAt(0.01) - rest).toFixed(2)}px past rest`);
  check("the rest offset survives even a gun at the spread ceiling",
    gapAt(10) > rest, `${gapAt(10).toFixed(1)}px vs rest ${rest.toFixed(1)}px`);
  check("...and the ceiling still bounds it", gapAt(10) === gapAt(100));

  // The centre is snapped so an odd-width stroke lands on pixel boundaries.
  // A stroke straddles its own coordinate, so only the axis ACROSS each tick has
  // to land right: a vertical tick's x, a horizontal tick's y. The ends are round
  // caps at a fractional gap and are free to sit anywhere.
  const frac = recordCrosshair(400.7, 300.4, 0);
  const width = frac.strokes[1].width;
  const wantHalf = Number.isInteger(width) && width % 2 === 1;
  const offBoundary = (v: number): number => Math.abs(v - Math.round(v));
  const across = frac.strokes[1].segs.map((sg) => (sg.x1 === sg.x2 ? sg.x1 : sg.y1));
  check("the centre is pixel-snapped for the tick width in use",
    across.every((v) => offBoundary(v) === (wantHalf ? 0.5 : 0)),
    `width ${width}, ${wantHalf ? "half-pixel" : "whole-pixel"} expected, got ${across.join(", ")}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
