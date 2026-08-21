/**
 * Verifies the character body splits cleanly in two for the bullet pass.
 *
 * The renderer draws every character's limbs, then the tracers, then every
 * character's head, so a round passes in front of arms and gun and vanishes
 * behind the body it hits. That only works if the two halves together are still
 * the whole character, drawn in the same order — which is what this checks, by
 * recording the drawing calls against a stub canvas instead of pixels.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_charlayers.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vcl.mjs && node <tmp>/vcl.mjs
 */
import { BODY_RADIUS, DEFAULT_PARAMS, DEFAULT_SKIN, drawCharacter } from "../src/entities/character.ts";
import { Armor } from "../src/entities/armor.ts";
import { ARMOR_SPECS } from "../src/entities/specs.ts";
import { vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** A canvas that draws nothing and remembers everything. */
function stubCtx() {
  const calls: string[] = [];
  const rec = (name: string) => (...a: any[]) =>
    calls.push(`${name}(${a.map((v) => (typeof v === "number" ? v.toFixed(2) : String(v))).join(",")})`);
  const ctx: any = { calls };
  for (const m of ["beginPath","closePath","moveTo","lineTo","arc","ellipse","fill","stroke",
                   "save","restore","translate","rotate","scale","fillRect","strokeRect",
                   "drawImage","clip","setTransform","quadraticCurveTo","bezierCurveTo"]) ctx[m] = rec(m);
  for (const p of ["fillStyle","strokeStyle","lineWidth","globalAlpha","font","textAlign","textBaseline","lineCap"]) {
    let v: any;
    Object.defineProperty(ctx, p, {
      get: () => v,
      set: (nv) => { v = nv; calls.push(`${p}=${nv}`); },
    });
  }
  return ctx;
}

const POS = vec(100, 50);
const FWD = vec(1, 0);
const RH = vec(140, 60);
const LH = vec(135, 35);

function trace(layer: "all" | "limbs" | "head", armor: Armor | null) {
  const ctx = stubCtx();
  let gunDrawn = 0;
  drawCharacter(ctx, POS, FWD, RH, LH, DEFAULT_SKIN, () => { gunDrawn++; ctx.calls.push("GUN"); },
    armor, DEFAULT_PARAMS, layer);
  return { calls: ctx.calls as string[], gunDrawn };
}

for (const [label, armor] of [
  ["bare", null],
  ["armored", new Armor(ARMOR_SPECS[Object.keys(ARMOR_SPECS)[Object.keys(ARMOR_SPECS).length - 1]])],
] as [string, Armor | null][]) {
  console.log(`\n${label}:`);
  const all = trace("all", armor);
  const limbs = trace("limbs", armor);
  const head = trace("head", armor);

  check("the two halves together are the whole character, in the same order",
    JSON.stringify([...limbs.calls, ...head.calls]) === JSON.stringify(all.calls),
    `${limbs.calls.length} + ${head.calls.length} vs ${all.calls.length}`);
  check("neither half is empty", limbs.calls.length > 0 && head.calls.length > 0,
    `limbs ${limbs.calls.length}, head ${head.calls.length}`);
  check("nothing is drawn twice", limbs.calls.length + head.calls.length === all.calls.length);

  check("the gun is drawn with the limbs, once", limbs.gunDrawn === 1 && head.gunDrawn === 0);
  check("...and the whole-character pass still draws it once", all.gunDrawn === 1);

  // The head is a circle of exactly BODY_RADIUS about the character's centre —
  // the hitbox itself, which is why it belongs on the far side of the tracers.
  const headArc = `arc(${POS.x.toFixed(2)},${POS.y.toFixed(2)},${BODY_RADIUS.toFixed(2)}`;
  check(`the head half draws the body circle (r=${BODY_RADIUS}, the hitbox)`,
    head.calls.some((c) => c.startsWith(headArc)), headArc);
  check("...and the limb half never does",
    !limbs.calls.some((c) => c.startsWith(headArc)));

  check("the hands are drawn with the limbs",
    limbs.calls.some((c) => c.startsWith(`arc(${RH.x.toFixed(2)},${RH.y.toFixed(2)}`)) &&
    !head.calls.some((c) => c.startsWith(`arc(${RH.x.toFixed(2)},${RH.y.toFixed(2)}`)));
}

// Armour is split too: shoulder pads ride with the limbs, the head ring and
// helmet with the head.
console.log("\narmor lands on the right side of the split:");
{
  const key = Object.keys(ARMOR_SPECS)[Object.keys(ARMOR_SPECS).length - 1];
  const armor = new Armor(ARMOR_SPECS[key]);
  const bareLimbs = trace("limbs", null).calls.length;
  const bareHead = trace("head", null).calls.length;
  const armLimbs = trace("limbs", armor).calls.length;
  const armHead = trace("head", armor).calls.length;
  check(`${key} adds shoulder pads to the limb half`, armLimbs > bareLimbs,
    `${armLimbs} vs ${bareLimbs}`);
  check("...and the ring/helmet to the head half", armHead > bareHead, `${armHead} vs ${bareHead}`);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
