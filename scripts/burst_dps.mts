/**
 * Each gun's damage-per-second envelope: the best it can sustain at a given
 * range, the burst length that achieves it, and the ranges at which that decays
 * to 90 / 50 / 25 percent of its peak.
 *
 * The cycle being optimised is "fire n shots at the weapon's cadence, then hold
 * fire until the spray resets, repeat". Tapping is n = 1 and holding the trigger
 * is n -> large, so both fall out of the same sweep rather than being special
 * cases. Recovery is the game's own rule: `currentRecoil` snaps to 0 once the gun
 * has idled `recoilDelay` ticks (Gun.tick), so a burst costs that many ticks after
 * its last shot, minus the cadence already waited. Reloads are deliberately out of
 * scope — this is what a weapon sustains while it has ammo, so a small magazine
 * flatters itself here.
 *
 * NOTHING IS SAMPLED. The spray pattern is deterministic — shot i of a burst is
 * fired at recoil i*recoilGain, and its aim offset is
 *
 *     p_i = recoilCoef^2 * sqrt(recoil) * sin(recoil)
 *
 * exactly as shoot() computes it — so the only random term left is the uniform
 * spread, and the chance of hitting a body of BODY_RADIUS at distance d is just
 * how much of that uniform interval lands inside the angle the body subtends.
 * That is an interval intersection, not an integral. (Shotguns add a normal
 * pellet spread on top, which needs one numerical integration over the uniform.)
 *
 * Treating sin(recoil) as a random variable instead — even with its correct
 * arcsine law — costs 12% mean / 72% worst error, because the amplitude grows
 * with the shot index so the specific early values never average out, and because
 * a burst's first shot is exactly centred BY CONSTRUCTION (sqrt(0) = 0) which is
 * the whole reason short bursts are good. Hence: no approximation.
 *
 * Run: node_modules/.bin/esbuild scripts/burst_dps.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/bd.mjs && node <tmp>/bd.mjs
 */
import { Gun } from "../src/entities/gun.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";

const MAX_BURST = 2000; // far past any optimum; the sweep reports if one hits it
/**
 * The range the whole table is quoted against. A weapon's own peak is a poor
 * yardstick — every automatic peaks point-blank where nothing can miss, so
 * peak-relative bands say more about how fast it falls off its own ceiling than
 * about how it compares to anything else. A fixed reference distance makes
 * "standard dps" a single cross-weapon number, and turns the bands into "how far
 * past a normal fighting distance does this still carry".
 */
const REF_DIST = Number(process.argv[2] ?? 500);
const D_STEP = 10;
const D_MAX = 7000;

/** Normal CDF, via the standard Abramowitz-Stegun erf approximation (|err| < 1.5e-7). */
function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  const erf = x >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

interface Weapon {
  name: string;
  reach: number;
  resets: boolean;
  /** P(hit) for shot i of a burst at distance d — exact. */
  pHit(i: number, d: number): number;
  damagePerShot: number;
  delay: number;
  recoilDelay: number;
}

function weapon(spec: any): Weapon | null {
  const f = spec.fire;
  if (!f || spec.projectile || spec.melee || !f.bulletSpeed) return null;
  const reach = new Gun(spec).feasibleRange;
  const resets = spec.recoilDelay <= f.delay; // spray never accumulates
  const coef2 = spec.recoilCoef * spec.recoilCoef;
  const s = f.spread; // randomBound at speedRatio 0 (standing)
  const pellets = spec.shotgunPellets ?? 1;
  const sigma = spec.shotgunSpread ? (spec.shotgunSpread * Math.PI) / 180 : 0;

  const pHit = (i: number, d: number): number => {
    if (d > reach) return 0;
    const recoil = resets ? 0 : i * spec.recoilGain;
    const p = coef2 * Math.sqrt(recoil) * Math.sin(recoil); // deterministic pattern
    const h = Math.asin(Math.min(1, BODY_RADIUS / d)); // half-angle the body subtends
    if (pellets === 1 || sigma <= 0) {
      if (s <= 1e-12) return Math.abs(p) < h ? 1 : 0;
      // u ~ U[-1,1]; hit iff |p + u*s| < h
      const lo = Math.max(-1, (-h - p) / s);
      const hi = Math.min(1, (h - p) / s);
      return Math.max(0, (hi - lo) / 2);
    }
    // Shotgun: each pellet is aim + N(0, sigma). Integrate the normal over the
    // uniform aim by quadrature — deterministic, and fine at this resolution.
    const STEPS = 400;
    let acc = 0;
    for (let k = 0; k < STEPS; k++) {
      const u = -1 + (2 * (k + 0.5)) / STEPS;
      const c = p + u * s;
      acc += phi((h - c) / sigma) - phi((-h - c) / sigma);
    }
    return (acc / STEPS) * pellets; // expected pellets on target
  };

  return {
    name: spec.name, reach, resets, pHit,
    damagePerShot: spec.damage, delay: f.delay, recoilDelay: spec.recoilDelay,
  };
}

/** Best cycle at distance d: returns dps and the burst length achieving it. */
function bestAt(w: Weapon, d: number): { dps: number; burst: number } {
  let running = 0;
  let bestDps = 0;
  let bestN = 1;
  // A gun whose spray resets between shots fires every shot from zero recoil, so
  // every shot is identical and the cycle is just its cadence: dps is the same
  // for every burst length. Solve it rather than searching, or float drift picks
  // an arbitrary winner among the ties.
  if (w.resets) {
    return { dps: (w.pHit(0, d) * w.damagePerShot * 60) / w.delay, burst: 1 };
  }
  for (let n = 1; n <= MAX_BURST; n++) {
    running += w.pHit(n - 1, d) * w.damagePerShot;
    const ticks = (n - 1) * w.delay + Math.max(w.delay, w.recoilDelay);
    const dps = running / (ticks / 60);
    if (dps > bestDps + 1e-12) { bestDps = dps; bestN = n; }
    // Past the optimum the pattern only widens, so dps decays monotonically —
    // once it has halved there is nothing left to find.
    else if (n > bestN + 50 && dps < bestDps * 0.5) break;
  }
  return { dps: bestDps, burst: bestN };
}

const guns = (Object.values(GUN_SPECS) as any[]).map(weapon).filter(Boolean) as Weapon[];

const rows = guns.map((w) => {
  let peak = 0;
  const curve: { d: number; dps: number; burst: number }[] = [];
  for (let d = 50; d <= D_MAX; d += D_STEP) {
    const b = bestAt(w, d);
    curve.push({ d, dps: b.dps, burst: b.burst });
    if (b.dps > peak) peak = b.dps;
  }
  const atRef = bestAt(w, REF_DIST);
  // dps decays with range, so each band is simply how far out it still holds
  // that fraction of what it manages at the reference distance.
  const rangeAt = (frac: number): number => {
    let last = 0;
    for (const c of curve) if (c.dps >= atRef.dps * frac) last = c.d;
    return last;
  };
  const capped = curve.filter((c) => c.burst >= MAX_BURST).map((c) => c.d);
  return {
    w, peak, capped, std: atRef.dps, burstRef: atRef.burst,
    r90: rangeAt(0.9), r80: rangeAt(0.8), r50: rangeAt(0.5), r25: rangeAt(0.25),
  };
});

console.log(`  dps envelope, exact (no sampling), no reloads — quoted against ${REF_DIST}px\n`);
console.log(
  `  ${"weapon".padEnd(15)} ${`dps@${REF_DIST}`.padStart(9)} ${"90%".padStart(8)} ${"80%".padStart(8)} ${"50%".padStart(8)} ` +
    `${"25%".padStart(8)} ${"feasible".padStart(9)} ${"burst".padStart(6)} ${"peak".padStart(6)}`,
);
for (const r of rows.sort((a, b) => b.std - a.std)) {
  const burst = r.w.resets ? "any" : String(r.burstRef);
  console.log(
    `  ${r.w.name.padEnd(15)} ${r.std.toFixed(0).padStart(9)} ${(r.r90 + "px").padStart(8)} ` +
      `${(r.r80 + "px").padStart(8)} ${(r.r50 + "px").padStart(8)} ${(r.r25 + "px").padStart(8)} ` +
      `${(r.w.reach + "px").padStart(9)} ` +
      `${burst.padStart(6)} ${r.peak.toFixed(0).padStart(6)}`,
  );
}
console.log(`\n  dps@${REF_DIST} is the standard: what this weapon sustains at a normal fighting`);
console.log(`  distance, played optimally. 90/80/50/25% are how far out it still holds that`);
console.log(`  fraction of it. "burst" is the best burst length at ${REF_DIST}px; "any" means its`);
console.log(`  spray resets between shots so length cannot matter. "peak" is its point-blank`);
console.log(`  ceiling, for reference only.`);
for (const r of rows) {
  if (r.capped.length) {
    console.log(`  CAP: ${r.w.name} wants >= ${MAX_BURST} shots at ${r.capped.length} ranges ` +
      `(${r.capped[0]}..${r.capped[r.capped.length - 1]}px) — resets=${r.w.resets}`);
  }
}
