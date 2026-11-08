/**
 * Verifies blood splatters on the ground: how many a hit throws and how big
 * (by damage), where they land (a trail along the spray), which art they use
 * (random, never the same twice running), that they need floor under them, age
 * out, and fade — over the gamemode's bloodTtl, like its bodies, or never where
 * the mode keeps those for good. Then end to end: a bullet, a blast and a punch
 * each emit one, sprayed the right way, and the client turns it into marks.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_bloodsplat.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vbs.mjs && node <tmp>/vbs.mjs
 */
import {
  BLOOD_SPLAT_IMAGES,
  MAX_SPLATS_PER_HIT,
  SPLAT_FULL_DAMAGE,
  SPLAT_JITTER,
  SPLAT_MAX_NUDGE,
  SPLAT_MAX_SIZE,
  SPLAT_MIN_SIZE,
  SPLAT_OPACITY,
  SPLAT_SPREAD,
  SPLAT_STEP,
  drawBloodSplats,
  splatterSizes,
  stampBloodSplatter,
  updateBloodSplats,
  type BloodSplat,
} from "../src/engine/bloodsplat.ts";
import { stepEffects } from "../src/engine/effects.ts";
import { toWire } from "../src/net/snapshot.ts";
import { explode, makeFloor, meleeSwing, spawnBullet, updateBullets, type World } from "../src/world/world.ts";
import { dist, norm, sub, vec, type Vec2 } from "../src/engine/vec.ts";
import { readFileSync } from "node:fs";
import { Game } from "../src/game.ts";
import { loadLevel } from "../src/world/level.ts";
import { SandboxMode } from "../src/gamemodes/sandbox.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";

/** The team modes' splatter life (TeamMatchMode.bloodTtl), for the stamps below. */
const LIFE = 720;

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };
const ground = makeFloor(vec(0, 0), 8000, 8000, "#555", { level: 0, infinite: true });

function world(): World {
  return {
    obstacles: [], floors: [ground], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
  } as unknown as World;
}
const dummy = (at: Vec2) => ({ id: 7, pos: at, z: 0, registerHit: () => {} });

console.log("how many, and how big:");
{
  check("no damage, no blood", splatterSizes(0).length === 0);
  const rifle = splatterSizes(20);
  check("a rifle round (20) throws one, part-full", rifle.length === 1 &&
    near(rifle[0], Math.max(SPLAT_MIN_SIZE, SPLAT_MAX_SIZE * Math.sqrt(20 / SPLAT_FULL_DAMAGE))), `${rifle.map((s) => s.toFixed(1))}`);
  check("...whose AREA goes with the damage (width as its square root)",
    near(splatterSizes(SPLAT_FULL_DAMAGE / 4)[0], Math.max(SPLAT_MIN_SIZE, SPLAT_MAX_SIZE / 2)));
  check("a graze is floored at SPLAT_MIN_SIZE, not shrunk to a speck",
    near(splatterSizes(0.01)[0], SPLAT_MIN_SIZE), `${splatterSizes(0.01)[0].toFixed(1)}`);
  const spill = splatterSizes(SPLAT_FULL_DAMAGE + 0.001);
  check("...and so is a hit's last drop of spill-over", spill.length === 2 && near(spill[1], SPLAT_MIN_SIZE),
    `${spill.map((s) => s.toFixed(1))}`);
  const full = splatterSizes(SPLAT_FULL_DAMAGE);
  check("a full share fills exactly one", full.length === 1 && near(full[0], SPLAT_MAX_SIZE));
  const deagle = splatterSizes(50);
  check("a heavier hit (50) fills the first and spills into a second", deagle.length === 2 &&
    near(deagle[0], SPLAT_MAX_SIZE) && near(deagle[1], Math.max(SPLAT_MIN_SIZE, SPLAT_MAX_SIZE * Math.sqrt(15 / SPLAT_FULL_DAMAGE))),
    `${deagle.map((s) => s.toFixed(1))}`);
  const awm = splatterSizes(100);
  check("an AWM hit (100) throws three", awm.length === 3, `${awm.map((s) => s.toFixed(1))}`);
  const huge = splatterSizes(1000);
  check("never more than three, and none bigger than full", huge.length === MAX_SPLATS_PER_HIT &&
    huge.every((s) => near(s, SPLAT_MAX_SIZE)));
}

console.log("\nwhere they land:");
{
  let worstAlong = 0;
  let worstOff = 0;
  let ok = true;
  for (let i = 0; i < 300; i++) {
    const out: BloodSplat[] = [];
    stampBloodSplatter(out, [ground], [], vec(10, 20), vec(1, 0), 0, 100, LIFE);
    if (out.length !== 3 || out[0].pos.x !== 10 || out[0].pos.y !== 20) ok = false;
    for (let k = 1; k < out.length; k++) {
      const along = out[k].pos.x - out[k - 1].pos.x;
      const off = Math.abs(out[k].pos.y - out[k - 1].pos.y);
      worstAlong = Math.max(worstAlong, Math.abs(along - SPLAT_STEP));
      worstOff = Math.max(worstOff, off);
      if (dist(out[k].pos, vec(out[k - 1].pos.x + SPLAT_STEP, out[k - 1].pos.y)) > SPLAT_JITTER + 1e-9) ok = false;
    }
  }
  check("the first lands exactly where the hit did", ok);
  check("each next one a step further along the spray, within the jitter", ok && worstAlong <= SPLAT_JITTER,
    `worst ${worstAlong.toFixed(1)} px off the step`);
  check("...and the jitter is really there", worstOff > SPLAT_JITTER / 2, `worst sideways ${worstOff.toFixed(1)} px`);

  const back: BloodSplat[] = [];
  stampBloodSplatter(back, [ground], [], vec(0, 0), vec(0, -1), 0, 100, LIFE);
  check("the trail follows the spray's direction, whatever it is", back[2].pos.y < back[1].pos.y && back[1].pos.y < 0);
}

console.log("\nfresh blood spreads off old blood instead of piling on it:");
{
  // One full splatter at the origin; the next hit's spray points +y, so a push
  // in x can only have come from the nudge.
  const old = (): BloodSplat[] => {
    const out: BloodSplat[] = [];
    stampBloodSplatter(out, [ground], [], vec(0, 0), vec(1, 0), 0, SPLAT_FULL_DAMAGE, LIFE);
    return out;
  };
  const reach = SPLAT_SPREAD * SPLAT_MAX_SIZE; // two full splatters' threshold
  const upstairs = makeFloor(vec(0, 0), 8000, 8000, "#555", { level: 1, infinite: true });
  const landAt = (at: Vec2, z = 0): Vec2 => {
    const out = old();
    stampBloodSplatter(out, [ground, upstairs], [], at, vec(0, 1), z, SPLAT_FULL_DAMAGE, LIFE);
    return out[1].pos;
  };
  const p = landAt(vec(5, 0));
  check("one aimed almost on top of an old one is pushed straight away from it",
    near(p.y, 0) && near(p.x, 5 + Math.min(reach - 5, SPLAT_MAX_NUDGE)), `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
  const c = landAt(vec(0, 0));
  check("dead centre on it, it's pushed off the same distance, some way",
    near(dist(c, vec(0, 0)), Math.min(reach, SPLAT_MAX_NUDGE)), `(${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);
  const ways = new Set(Array.from({ length: 20 }, () => Math.round(Math.atan2(landAt(vec(0, 0)).y, landAt(vec(0, 0)).x) * 10)));
  check("...a random way, so pushes on one spot don't all line up", ways.size > 5, `${ways.size} directions in 20`);
  const far = landAt(vec(reach + 1, 0));
  check("one that clears the old one by enough lands where it was aimed", near(far.x, reach + 1) && near(far.y, 0));
  const up = landAt(vec(5, 0), 1);
  check("blood on another level doesn't push", near(up.x, 5) && near(up.y, 0));

  // Twenty one-splatter hits on the very same spot. Unnudged, all 190 pairs
  // would sit exactly on each other; the nudge leaves a handful at most (worst
  // of 2000 trials: 7), so a tenth is a regression, not bad luck.
  const pile: BloodSplat[] = [];
  for (let i = 0; i < 20; i++) stampBloodSplatter(pile, [ground], [], vec(0, 0), vec(1, 0), 0, SPLAT_FULL_DAMAGE, LIFE);
  let stacked = 0;
  for (let i = 0; i < pile.length; i++)
    for (let j = i + 1; j < pile.length; j++) if (dist(pile[i].pos, pile[j].pos) < 1) stacked++;
  const spread = Math.max(...pile.map((q) => dist(q.pos, vec(0, 0))));
  const pairs = (pile.length * (pile.length - 1)) / 2;
  check("repeated hits on one spot spread out rather than stacking", stacked < pairs / 10 && spread > 0,
    `${stacked} stacked pairs, spread to ${spread.toFixed(0)} px`);
  check("...gently: no splatter moves more than SPLAT_MAX_NUDGE from where it was aimed",
    pile.every((q) => dist(q.pos, vec(0, 0)) <= SPLAT_MAX_NUDGE + 1e-9));
}

console.log("\nwhich art, which way up:");
{
  const out: BloodSplat[] = [];
  for (let i = 0; i < 400; i++) stampBloodSplatter(out, [ground], [], vec(0, 0), vec(1, 0), 0, 100, LIFE);
  let repeats = 0;
  for (let i = 1; i < out.length; i++) if (out[i].image === out[i - 1].image) repeats++;
  check("never the same splatter twice in a row", repeats === 0, `${repeats} repeats in ${out.length}`);
  const used = new Set(out.map((s) => s.image));
  check("all five get used", used.size === BLOOD_SPLAT_IMAGES.length, `${[...used].sort()}`);
  const angles = out.map((s) => s.angle);
  check("each has its own random spin", new Set(angles).size === angles.length &&
    angles.every((a) => a >= 0 && a < Math.PI * 2));
}

console.log("\nit needs ground to land on:");
{
  // A deck at z 1 ending at x = 100; hits right on its edge, spraying off it.
  // Whether a given later splatter still grazes the edge depends on the jitter
  // and the tuning, so this asks over many hits rather than of one.
  const deck = makeFloor(vec(0, 0), 200, 200, "#555", { level: 1 });
  const full = splatterSizes(100).length;
  let firstKept = true;
  let allOnDeck = true;
  let cutShort = 0;
  for (let i = 0; i < 200; i++) {
    const out: BloodSplat[] = [];
    stampBloodSplatter(out, [ground, deck], [], vec(100, 0), vec(1, 0), 1, 100, LIFE);
    if (out.length === 0 || out[0].pos.x !== 100) firstKept = false;
    if (!out.every((s) => s.floors?.includes(deck))) allOnDeck = false;
    if (out.length < full) cutShort++;
  }
  check("the first splatter, on the edge, always lands", firstKept);
  check("every one that lands is on the deck", allOnDeck);
  check("the ones flung clear of it are dropped", cutShort > 0, `${cutShort}/200 trails cut short`);
  const mid: BloodSplat[] = [];
  stampBloodSplatter(mid, [deck], [], vec(5000, 0), vec(1, 0), 1, 100, LIFE);
  check("a hit over nothing leaves nothing", mid.length === 0);
}

console.log("\nthey age out, fading at the end:");
{
  let out: BloodSplat[] = [];
  stampBloodSplatter(out, [ground], [], vec(0, 0), vec(1, 0), 0, 20, LIFE);
  const alphas: number[] = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {}, clip() {}, translate() {}, rotate() {},
    drawImage() { alphas.push(this.globalAlpha); },
  } as unknown as CanvasRenderingContext2D;
  const imgs = BLOOD_SPLAT_IMAGES.map(() => ({}) as CanvasImageSource);
  drawBloodSplats(ctx, out, imgs, 0, () => true);
  check("at full SPLAT_OPACITY while fresh", alphas.length === 1 && alphas[0] === SPLAT_OPACITY, `alpha ${alphas[0]}`);
  for (let i = 0; i < LIFE - 30; i++) out = updateBloodSplats(out);
  drawBloodSplats(ctx, out, imgs, 0, () => true);
  check("fading near the end", out.length === 1 && alphas[1] > 0 && alphas[1] < SPLAT_OPACITY, `alpha ${alphas[1]?.toFixed(2)}`);
  drawBloodSplats(ctx, out, [null, null, null, null, null], 0, () => true);
  check("not drawn while its art is still loading", alphas.length === 2);
  drawBloodSplats(ctx, out, imgs, 1, () => true);
  check("not drawn in another level's pass", alphas.length === 2);
  for (let i = 0; i < 40; i++) out = updateBloodSplats(out);
  check("gone after its life", out.length === 0);

  let kept: BloodSplat[] = [];
  stampBloodSplatter(kept, [ground], [], vec(0, 0), vec(1, 0), 0, 20, null);
  for (let i = 0; i < 100_000; i++) kept = updateBloodSplats(kept);
  const before = alphas.length;
  drawBloodSplats(ctx, kept, imgs, 0, () => true);
  check("with no life set (null) it never fades or goes", kept.length === 1 && alphas.length === before + 1 && alphas[before] === SPLAT_OPACITY,
    `after 100000 ticks: ${kept.length} left, alpha ${alphas[before]}`);
}

console.log("\nhow long they last is the gamemode's, like its bodies:");
{
  const level = (name: string): ReturnType<typeof loadLevel> => loadLevel(readFileSync(`src/world/levels/${name}.json`, "utf8"));
  const tdm = new Game(level("arena-teamfight-tdm"), new TeamDeathmatchMode());
  check("team deathmatch: blood lasts as long as a body", tdm.world.bloodTtl === tdm.gamemode.bloodTtl && tdm.world.bloodTtl === tdm.gamemode.bodyTtl,
    `blood ${tdm.world.bloodTtl}, bodies ${tdm.gamemode.bodyTtl}`);
  const dom = new Game(level("dom-arena-big-fix"), new DominationMode());
  check("domination: likewise", dom.world.bloodTtl === dom.gamemode.bodyTtl, `blood ${dom.world.bloodTtl}, bodies ${dom.gamemode.bodyTtl}`);
  const sand = new Game(level("arena-teamfight"), new SandboxMode());
  check("sandbox: blood stays for good, like its bodies", sand.world.bloodTtl === undefined && sand.gamemode.bodyTtl === undefined);
  // What the client stamps from a hit takes the world's setting (the same step
  // then ages it one tick).
  for (const [name, g, want] of [["team deathmatch", tdm, tdm.gamemode.bloodTtl! - 1], ["sandbox", sand, null]] as const) {
    g.world.events.push({ kind: "blood", pos: vec(0, 400), dir: vec(1, 0), z: 0, damage: 20 });
    stepEffects(g.world);
    const s = g.world.bloodSplats[0];
    check(`${name}: a hit's splatter gets that life`, !!s && s.life === want, s ? `life ${s.life}` : "no splatter");
  }
}

console.log("\nend to end — every way of getting hurt bleeds:");
{
  // A bullet travelling +x into a body at the origin.
  const w = world();
  spawnBullet(w, vec(-200, 0), vec(1, 0), 60, 30, 0, null, 50, 4, 20, "#fff", AP, 0);
  const target = dummy(vec(0, 0));
  let ev: any = null;
  for (let i = 0; i < 6 && !ev; i++) {
    updateBullets(w, [target]);
    ev = w.events.find((e) => e.kind === "blood") ?? null;
    if (!ev) w.events.length = 0;
  }
  check("a bullet hit emits blood", !!ev);
  check("...sprayed the way the round was going", ev && near(ev.dir.x, 1) && near(ev.dir.y, 0));
  // backOut steps out of the body in small increments, so "where it hit" sits
  // just outside the radius, on the shooter's side.
  check("...from where it hit the body", ev && Math.abs(dist(ev.pos, target.pos) - 30) <= 5 && ev.pos.x < 0,
    ev ? `(${ev.pos.x.toFixed(1)}, ${ev.pos.y.toFixed(1)})` : "");
  check("...carrying the round's damage", ev && near(ev.damage, 50));
  // The wire rounds it like every positioned event (0.1 px, 0.001 on the
  // direction, 0.1 damage), which is nothing the eye can see.
  const wired: any = ev && toWire(ev, new Map());
  check("it goes over the wire, rounded but otherwise as is", !!wired && wired.kind === "blood" && wired.z === ev.z &&
    Math.abs(wired.pos.x - ev.pos.x) <= 0.05 && Math.abs(wired.pos.y - ev.pos.y) <= 0.05 &&
    Math.abs(wired.dir.x - ev.dir.x) <= 0.0005 && Math.abs(wired.dir.y - ev.dir.y) <= 0.0005 &&
    Math.abs(wired.damage - ev.damage) <= 0.05, JSON.stringify(wired));
  stepEffects(w);
  check("the client stains the ground with it", w.bloodSplats.length === splatterSizes(50).length,
    `n=${w.bloodSplats.length}`);

  // A blast up and to the left of a body: blood sprays away from it.
  const wb = world();
  const victim = dummy(vec(100, 100));
  explode(wb, vec(0, 0), 0, 80, 300, AP, null, [victim]);
  const be: any = wb.events.find((e) => e.kind === "blood");
  const out = norm(sub(victim.pos, vec(0, 0)));
  check("a blast emits blood", !!be);
  check("...sprayed outward from the blast centre", be && near(be.dir.x, out.x) && near(be.dir.y, out.y));
  check("...sized by what the blast did to it", be && be.damage > 0 && be.damage < 80, be ? `${be.damage.toFixed(1)}` : "");

  // A punch from the left.
  const wm = world();
  const puncher = dummy(vec(-60, 0));
  meleeSwing(wm, puncher, vec(1, 0), [dummy(vec(0, 0))], { reach: 145, coneDeg: 60, damage: 20, armorPen: AP, heft: 1 });
  const me: any = wm.events.find((e) => e.kind === "blood");
  check("a punch draws blood on the ground too", !!me && near(me.dir.x, 1) && near(me.damage, 20));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
