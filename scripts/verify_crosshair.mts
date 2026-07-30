/**
 * Verifies the spread crosshair, headless:
 *   - Gun.maxSpread really bounds shoot(): thousands of live shots, none exceeding
 *     the advertised bound, and the bound not absurdly loose.
 *   - it responds to the things it should (recoil accumulating, movement) and is 0
 *     for a gun that cannot fire.
 *   - Game.crosshairSpread tracks the aimed gun and is SMOOTHED: it converges on
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
import { Gun, EnemyGun } from "../src/entities/gun.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { UNARMED } from "../src/entities/guns.ts";

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
console.log("\n--- Game.crosshairSpread is smoothed ---");
const loaded = loadLevel(readFileSync("src/world/levels/tdm-arena-big.json", "utf8"));
const mode = loaded.meta?.mode ?? DEFAULT_MODE;
const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
let biggestJump = 0;
let ticks = 0;
let prev = game.crosshairSpread;
for (let i = 0; i < 600; i++) {
  game.update();
  const jump = Math.abs(game.crosshairSpread - prev);
  if (i > 5) biggestJump = Math.max(biggestJump, jump);
  prev = game.crosshairSpread;
  ticks++;
}
const truth = game.aimingGun().maxSpread(game.player.speedRatio);
check("converges on the gun's own answer while idle",
  Math.abs(game.crosshairSpread - truth) < 1e-3,
  `hud=${game.crosshairSpread.toFixed(5)} gun=${truth.toFixed(5)}`);
// Easing at 0.2 can move at most 20% of the remaining gap in a tick; the largest
// plausible gap is the widest gun spread, so a per-tick jump near that means the
// value is being assigned raw rather than eased.
check("never steps more than the easing allows", biggestJump < 0.3 * 0.25,
  `largest per-tick change=${biggestJump.toFixed(5)} rad over ${ticks} ticks`);

// The point of the smoothing: slam the gun's real spread wide open and the HUD
// value must walk there over several ticks, not arrive next frame.
const settled = game.crosshairSpread;
game.player.gun.currentRecoil = 40; // as if mid-burst
const raw = game.aimingGun().maxSpread(game.player.speedRatio);
game.update();
const afterOne = game.crosshairSpread;
check("a sudden real change is not applied in one tick",
  afterOne < settled + (raw - settled) * 0.9,
  `raw jumped to ${raw.toFixed(4)}, hud moved ${settled.toFixed(4)} -> ${afterOne.toFixed(4)}`);
// ...and then it tracks the gun back down as recoil decays, without being nudged.
let steps = 1;
while (
  steps < 400 &&
  Math.abs(game.crosshairSpread - game.aimingGun().maxSpread(game.player.speedRatio)) > 1e-4
) {
  game.update();
  steps += 1;
}
check("but it does converge on the gun once left alone", steps < 400,
  `tracked back to ${game.crosshairSpread.toFixed(5)} in ${steps} ticks`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
