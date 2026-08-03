/**
 * Verifies the particle size model: `sizeChange` (px/tick) generalizes the old
 * shrink boolean — negative shrinks, positive expands, 0/absent holds — is
 * integrated once per tick, and a particle is dropped when it reaches size 0.
 * Also checks trail stamps taper to nothing over their life, and that the
 * EXPLOSION_SHRAPNEL preset carries the migrated value.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_particles.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vpt.mjs && node <tmp>/vpt.mjs
 */
import {
  updateParticles,
  spawnParticles,
  EXPLOSION_SHRAPNEL,
  type Particle,
} from "../src/engine/particle.ts";
import { vec } from "../src/engine/vec.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
};
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

function part(over: Partial<Particle> = {}): Particle {
  return {
    pos: vec(0, 0),
    vel: vec(0, 0),
    z: 0,
    angle: 0,
    spin: 0,
    life: 1000,
    maxLife: 1000,
    size: 10,
    color: "#fff",
    shape: "square",
    ...over,
  };
}

// ------------------------------------------------------------- shrink ----------
console.log("negative sizeChange shrinks by that many px/tick, then drops at 0:");
{
  let ps = [part({ size: 10, sizeChange: -2, shape: "circle" })];
  ps = updateParticles(ps);
  check("after 1 tick: 10 -> 8", ps.length === 1 && near(ps[0].size, 8), `size=${ps[0]?.size}`);
  ps = updateParticles(ps);
  ps = updateParticles(ps);
  check("after 3 ticks: 10 -> 4", ps.length === 1 && near(ps[0].size, 4), `size=${ps[0]?.size}`);
  ps = updateParticles(ps); // 2
  ps = updateParticles(ps); // 0 -> dropped
  check("dropped once it reaches size 0", ps.length === 0, `n=${ps.length}`);
}

// ------------------------------------------------------------- expand ----------
console.log("positive sizeChange expands the particle:");
{
  let ps = [part({ size: 5, sizeChange: 3 })];
  for (let i = 0; i < 3; i++) ps = updateParticles(ps);
  check("after 3 ticks: 5 -> 14", ps.length === 1 && near(ps[0].size, 14), `size=${ps[0]?.size}`);
}

// ------------------------------------------------------------- constant --------
console.log("no sizeChange holds size constant (old default behavior):");
{
  let ps = [part({ size: 7 })];
  for (let i = 0; i < 20; i++) ps = updateParticles(ps);
  check("size unchanged after 20 ticks", ps.length === 1 && near(ps[0].size, 7), `size=${ps[0]?.size}`);
}

// ------------------------------------------------------------- trail stamp -----
console.log("a moving trail particle stamps a shrinking, non-fading afterimage:");
{
  const parent = part({ size: 6, vel: vec(10, 0), trail: "#abc", shape: "square" });
  const out = updateParticles([parent]);
  check("stamp + parent both present", out.length === 2, `n=${out.length}`);
  const stamp = out.find((p) => p.vel.x === 0 && p.vel.y === 0)!;
  check("stamp is in the trail color", stamp.color === "#abc");
  check("stamp holds full alpha (noFade)", stamp.noFade === true);
  check("stamp carries no trail of its own (no recursion)", stamp.trail === undefined);
  check("stamp shrinks (negative sizeChange)", stamp.sizeChange !== undefined && stamp.sizeChange < 0, `dz=${stamp.sizeChange}`);
  check("stamp shrinks to 0 over its life", near(stamp.size + stamp.sizeChange! * stamp.life, 0, 1e-6),
    `size=${stamp.size} dz=${stamp.sizeChange} life=${stamp.life}`);

  // Run the stamp alone to extinction: it must vanish (no trail => no new stamps).
  const stampLife = stamp.life;
  let only = [stamp];
  for (let i = 0; i <= stampLife; i++) only = updateParticles(only);
  check("stamp eventually disappears", only.length === 0, `n=${only.length}`);
}

// ------------------------------------------------------------- spawn copy ------
console.log("spawnParticles copies sizeChange from the style:");
{
  const out: Particle[] = [];
  spawnParticles(out, vec(0, 0), vec(1, 0), EXPLOSION_SHRAPNEL, 0);
  check("EXPLOSION_SHRAPNEL migrated to sizeChange", EXPLOSION_SHRAPNEL.sizeChange === -0.6);
  check("spawned embers all carry it", out.length > 0 && out.every((p) => p.sizeChange === -0.6));
  check("no legacy `shrink` field remains on the style", !("shrink" in EXPLOSION_SHRAPNEL));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
