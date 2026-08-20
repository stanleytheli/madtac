/**
 * Verifies per-object impact debris: the SHRAPNEL_STYLES registry an obstacle
 * picks from by name, the sparks material itself (the explosion's burning
 * shrapnel scaled down to a bullet hit, trail and all), that the metal barrel
 * sparks out of the box, and that a pick survives a round trip through the level
 * format — i.e. it really is an editor setting a wall or crate can carry.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_shrapnel.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vsh.mjs && node <tmp>/vsh.mjs
 */
import {
  CRATE_SHRAPNEL,
  EXPLOSION_SHRAPNEL,
  METAL_SPARKS,
  SHRAPNEL_STYLES,
  SHRAPNEL_TRACER_WIDTH,
  WALL_SHRAPNEL,
  spawnParticles,
  updateParticles,
  type Particle,
} from "../src/engine/particle.ts";
import {
  makeBarrelMetal,
  makeBarrelWood,
  makeCrate,
  makeWall,
  obstacleShrapnel,
  spawnBullet,
  updateBullets,
  type Obstacle,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { ENTITY_DEFS, loadLevel, serializeLevel } from "../src/world/level.ts";
import { vec } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};

// ------------------------------------------------------------ the look --------
console.log("sparks wear the explosion-shrapnel look, sized down to an impact:");
check("squares, like the explosion's embers",
  METAL_SPARKS.shape === "square" && METAL_SPARKS.shape === EXPLOSION_SHRAPNEL.shape,
  `${METAL_SPARKS.color} ${METAL_SPARKS.shape}`);
check("they leave a trail", METAL_SPARKS.trail !== undefined, `trail=${METAL_SPARKS.trail}`);
check("they shoot out fast — quicker than the chips they replace",
  METAL_SPARKS.speed > CRATE_SHRAPNEL.speed && METAL_SPARKS.speed > WALL_SHRAPNEL.speed,
  `${METAL_SPARKS.speed} vs ${CRATE_SHRAPNEL.speed}/${WALL_SHRAPNEL.speed}`);
check("...but not as far as an explosion's embers",
  METAL_SPARKS.speed < EXPLOSION_SHRAPNEL.speed, `${METAL_SPARKS.speed} vs ${EXPLOSION_SHRAPNEL.speed}`);
check("thrown out of a cone, not a full circle (a hit has a direction)",
  METAL_SPARKS.spread < Math.PI, `spread=${METAL_SPARKS.spread}`);
check("burn out: shrink to nothing by the end of the life",
  METAL_SPARKS.sizeChange !== undefined && METAL_SPARKS.sizeChange < 0 &&
  METAL_SPARKS.size + METAL_SPARKS.sizeChange * METAL_SPARKS.life <= 0,
  `${METAL_SPARKS.size} + ${METAL_SPARKS.sizeChange}*${METAL_SPARKS.life}`);
check("short-lived — gone inside a quarter second (15 ticks)", METAL_SPARKS.life <= 15,
  `life=${METAL_SPARKS.life}`);

// ------------------------------------------------------------ fading ----------
// The spark itself always faded (alpha = life/maxLife). Its TRAIL is what used
// to hold full brightness until it tapered away — `trailFade` makes the stamps
// dim as they thin, like ordinary debris.
console.log("\nthe trail fades out as well as thinning out:");
const alphaOf = (p: Particle): number => (p.noFade ? 1 : Math.max(0, p.life / p.maxLife));
{
  check("the sparks style asks for a fading trail", METAL_SPARKS.trailFade === true);
  const burst: Particle[] = [];
  spawnParticles(burst, vec(0, 0), vec(1, 0), METAL_SPARKS, 0);
  check("spawned sparks carry the flag", burst.every((p) => p.trailFade === true));
  check("the spark itself fades, as it always did", burst.every((p) => !p.noFade));

  const out = updateParticles(burst);
  const stamp = out.find((p) => p.vel.x === 0 && p.vel.y === 0)!;
  check("its trail stamps no longer hold full alpha", !!stamp && !stamp.noFade);
  // Walk one stamp to extinction: alpha must fall the whole way, not sit at 1.
  let only = [stamp];
  const alphas = [alphaOf(stamp)];
  for (let i = 0; i < 40 && only.length; i++) {
    only = updateParticles(only);
    if (only[0]) alphas.push(alphaOf(only[0]));
  }
  check("alpha falls every tick", alphas.every((a, i) => i === 0 || a < alphas[i - 1]),
    alphas.map((a) => a.toFixed(2)).join(" "));
  check("it is nearly transparent by the end", alphas[alphas.length - 1] < 0.25,
    `last=${alphas[alphas.length - 1].toFixed(2)}`);
  check("and it still thins out on the way (shrink kept)",
    stamp.sizeChange !== undefined && stamp.sizeChange < 0, `dz=${stamp.sizeChange}`);
}
{
  // Scope guard: explosions were not asked to change, and must not have.
  const embers: Particle[] = [];
  spawnParticles(embers, vec(0, 0), vec(1, 0), EXPLOSION_SHRAPNEL, 0);
  const out = updateParticles(embers);
  const stamp = out.find((p) => p.vel.x === 0 && p.vel.y === 0)!;
  check("an explosion's ember trail still holds full brightness",
    EXPLOSION_SHRAPNEL.trailFade === undefined && !!stamp && stamp.noFade === true);
}

// --------------------------------------------------------- which objects ------
console.log("\nwhich objects spark:");
const barrel = makeBarrelMetal(vec(0, 0), 32, 0);
const wood = makeBarrelWood(vec(0, 0), 32, 0);
const wall = makeWall(vec(0, 0), 64, 64, 0);
const crate = makeCrate(vec(0, 0), 64, 64, 0);
check("the metal barrel sparks with nothing picked", obstacleShrapnel(barrel) === METAL_SPARKS);
check("the wooden barrel still splinters", obstacleShrapnel(wood) === CRATE_SHRAPNEL);
check("a plain wall throws its own debris", obstacleShrapnel(wall) !== METAL_SPARKS);
check("a plain crate throws its own debris", obstacleShrapnel(crate) !== METAL_SPARKS);
check("...tinted to its own paint, as before", obstacleShrapnel(crate).color === crate.stroke);

const metalWall: Obstacle = { ...makeWall(vec(0, 0), 64, 64, 0), shrapnel: "sparks" };
const metalCrate: Obstacle = { ...makeCrate(vec(0, 0), 64, 64, 0), shrapnel: "sparks" };
check("a wall set to `sparks` sparks", obstacleShrapnel(metalWall) === METAL_SPARKS);
check("a crate set to `sparks` sparks", obstacleShrapnel(metalCrate) === METAL_SPARKS);
check("the pick beats the object's own paint (sparks keep their hot color)",
  obstacleShrapnel(metalWall).color === METAL_SPARKS.color &&
  metalWall.stroke !== METAL_SPARKS.color, `stroke=${metalWall.stroke}`);
// A styled obstacle's hand-authored particle normally wins; an explicit pick outranks it.
const sparkingWoodBarrel: Obstacle = { ...wood, shrapnel: "sparks" };
check("the pick beats even a styled obstacle's own particle",
  obstacleShrapnel(sparkingWoodBarrel) === METAL_SPARKS);

console.log("\nany material in the registry can be put on any object:");
for (const [key, style] of Object.entries(SHRAPNEL_STYLES)) {
  check(`a wall set to \`${key}\` throws ${key}`,
    obstacleShrapnel({ ...wall, shrapnel: key }) === style);
}
check("a named pick is used verbatim, NOT recolored to the object's paint",
  obstacleShrapnel({ ...wall, shrapnel: "wood" }).color === SHRAPNEL_STYLES.wood.color,
  `${obstacleShrapnel({ ...wall, shrapnel: "wood" }).color} vs wall stroke ${wall.stroke}`);
check("an unknown material falls back to the object's own debris (forward-compat)",
  obstacleShrapnel({ ...wall, shrapnel: "plasma" }).color === wall.stroke);
check("...and an unknown one on a styled object keeps that object's particle",
  obstacleShrapnel({ ...wood, shrapnel: "plasma" }) === CRATE_SHRAPNEL);

// ------------------------------------------------------------ end to end ------
console.log("\nshooting one: a real bullet into a wall set to `sparks`:");
function shootInto(o: Obstacle, tracerWidth = SHRAPNEL_TRACER_WIDTH): Particle[] {
  const w: World = {
    obstacles: [o], floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [],
  } as unknown as World;
  (w as any).grid = new ObstacleGrid(w.obstacles);
  const pen = { l1: 1, l2: 1, l3: 1, l4: 1 };
  spawnBullet(w, vec(-200, 0), vec(1, 0), 60, 30, 0, null, 10, tracerWidth, 20, "#fff", pen, 0);
  for (let i = 0; i < 6 && w.particles.length === 0; i++) updateBullets(w, []);
  return w.particles;
}
{
  // updateBullets ticks the particles at the end of the same call, so what comes
  // back is the burst plus the afterimage each spark has already stamped behind it.
  const ps = shootInto(metalWall);
  const sparks = ps.filter((p) => p.trail !== undefined);
  const stamps = ps.filter((p) => p.trail === undefined);
  check("the hit spawns a burst", sparks.length === METAL_SPARKS.count, `n=${sparks.length}`);
  check("every spark is a yellow square",
    sparks.every((p) => p.color === METAL_SPARKS.color && p.shape === "square"));
  check("every spark carries the trail color", sparks.every((p) => p.trail === METAL_SPARKS.trail));
  check("they fly back toward the shooter (bullet came from -x)",
    sparks.every((p) => p.vel.x < 0), sparks.map((p) => p.vel.x.toFixed(1)).join(","));
  check("each spark has already left a trail stamp behind it",
    stamps.length === sparks.length && stamps.every((p) => p.color === METAL_SPARKS.trail && p.vel.x === 0 && p.vel.y === 0),
    `${stamps.length}/${sparks.length}`);
  check("both the spark and its stamp fade with age", [...sparks, ...stamps].every((p) => !p.noFade));
  // Run the whole shower to extinction: nothing lingers.
  let live = ps;
  for (let i = 0; i < METAL_SPARKS.life + 20; i++) live = updateParticles(live);
  check("the whole shower burns out and leaves nothing", live.length === 0, `n=${live.length}`);
}
{
  const ps = shootInto(makeWall(vec(0, 0), 64, 64, 0));
  check("an unflagged wall's hit is NOT sparks — chips, no trail, no stamps",
    ps.length === 6 && ps.every((p) => p.trail === undefined && !p.noFade), `n=${ps.length}`);
}

// ------------------------------------------------- size vs. the round ---------
// Debris scales with the bullet's tracer width, calibrated so the authored sizes
// are what a width-4 round throws.
console.log("\nheavier rounds throw bigger, faster debris:");
{
  check("the reference width is 4", SHRAPNEL_TRACER_WIDTH === 4);

  const burst = (heft: number): Particle[] => {
    const out: Particle[] = [];
    spawnParticles(out, vec(0, 0), vec(1, 0), METAL_SPARKS, 0, heft);
    return out;
  };
  const speeds = (heft: number, trials = 200): number[] => {
    const out: Particle[] = [];
    for (let i = 0; i < trials; i++) spawnParticles(out, vec(0, 0), vec(1, 0), METAL_SPARKS, 0, heft);
    return out.map((p) => Math.hypot(p.vel.x, p.vel.y));
  };
  // Ejection speed is style.speed * (0.5..1) * heft, so the band it lands in is
  // exact even though the draw inside it is random.
  const inBand = (heft: number): boolean =>
    speeds(heft).every((v) => v <= METAL_SPARKS.speed * heft + 1e-9 &&
                              v >= METAL_SPARKS.speed * heft * 0.5 - 1e-9);
  check("scale 1 keeps the authored speed band", inBand(1),
    `<= ${METAL_SPARKS.speed}`);
  check("scale 2 doubles the whole band", inBand(2), `<= ${METAL_SPARKS.speed * 2}`);
  check("scale 0.75 takes three quarters of it", inBand(0.75));
  check("the bands really do differ (not all clamped to the same number)",
    Math.max(...speeds(2)) > Math.max(...speeds(1)) * 1.5);
  check("scale 1 leaves the authored size alone",
    burst(1).every((p) => p.size === METAL_SPARKS.size && p.sizeChange === METAL_SPARKS.sizeChange));
  check("scale 2 doubles size AND the shrink rate",
    burst(2).every((p) => p.size === METAL_SPARKS.size * 2 && p.sizeChange === METAL_SPARKS.sizeChange! * 2));
  check("so a big piece still burns out over the same lifetime",
    burst(2).every((p) => near(p.size / -p.sizeChange!, METAL_SPARKS.size / -METAL_SPARKS.sizeChange!)),
    `${burst(2)[0].size} / ${-burst(2)[0].sizeChange!}`);
  check("scale 0 emits nothing at all", burst(0).length === 0);

  // End to end, through a real bullet. Every particle in a burst spawns at the
  // same size, and they have all been ticked once, so the ratio between two
  // widths is exactly the ratio of the widths.
  const sizeAt = (tracerWidth: number): number => {
    const ps = shootInto(metalWall, tracerWidth).filter((p) => p.trail !== undefined);
    return ps.length ? ps[0].size : 0;
  };
  const ref = sizeAt(SHRAPNEL_TRACER_WIDTH);
  check("a width-4 round throws the authored size",
    near(ref, METAL_SPARKS.size + METAL_SPARKS.sizeChange!), `${ref}`);
  check("the AWM's width-8 round throws double", near(sizeAt(8), ref * 2), `${sizeAt(8)} vs ${ref}`);
  check("the M9's width-3 round throws three quarters", near(sizeAt(3), ref * 0.75), `${sizeAt(3)} vs ${ref}`);
  check("a punch (no tracer at all) throws no debris", shootInto(metalWall, 0).length === 0);

  // ...and the same round throws it further, because speed scales but life does not.
  const reachAt = (tracerWidth: number, trials = 150): number => {
    let far = 0;
    for (let i = 0; i < trials; i++)
      for (const p of shootInto(metalWall, tracerWidth).filter((q) => q.trail !== undefined))
        far = Math.max(far, Math.hypot(p.vel.x, p.vel.y));
    return far;
  };
  check("the width-8 round also throws its sparks twice as fast",
    Math.abs(reachAt(8) / reachAt(4) - 2) < 0.05, `${reachAt(8).toFixed(1)} vs ${reachAt(4).toFixed(1)} px/tick`);
  check("lifetime is untouched — heavier means further, not longer",
    shootInto(metalWall, 8).filter((p) => p.trail !== undefined)
      .every((p) => p.maxLife <= METAL_SPARKS.life));
  check("a plain wall's chips scale the same way",
    near(shootInto(makeWall(vec(0, 0), 64, 64, 0), 8)[0].size, WALL_SHRAPNEL.size * 2),
    `${shootInto(makeWall(vec(0, 0), 64, 64, 0), 8)[0].size} vs ${WALL_SHRAPNEL.size}`);
}

// --------------------------------------------------------- editor setting -----
console.log("\nit is an editor dropdown on the ordinary map objects:");
for (const kind of ["wall", "crate", "fence", "circle", "barrel_metal", "barrel_wood"]) {
  const def = ENTITY_DEFS.find((d) => d.kind === kind)!;
  const f = def.fields.find((x) => x.key === "shrapnel");
  check(`${kind} exposes a \`shrapnel\` select`, !!f && f.type === "select");
}
{
  const f = ENTITY_DEFS.find((d) => d.kind === "wall")!.fields.find((x) => x.key === "shrapnel")!;
  const opts = f.options!();
  check("the menu leads with a default (= the kind's own debris)",
    opts[0].value === "" && opts.length === Object.keys(SHRAPNEL_STYLES).length + 1,
    opts.map((o) => o.label).join(", "));
  check("every registered material is offered — a new one needs no editor work",
    Object.keys(SHRAPNEL_STYLES).every((k) => opts.some((o) => o.value === k)));
  // The menu writes through to the entity, and back off again.
  const e: any = makeWall(vec(0, 0), 64, 64, 0);
  f.set(e, "sparks");
  check("choosing one sets it", e.shrapnel === "sparks" && f.get(e) === "sparks");
  f.set(e, "");
  check("choosing (default) clears it back to undefined",
    e.shrapnel === undefined && f.get(e) === "");
  f.set(e, "plasma");
  check("a junk value is refused, not stored", e.shrapnel === undefined);
}

console.log("\nthe setting round-trips through the level format:");
{
  const lvl = `{ "version": 1, "entities": [
  {"kind":"wall","x":0,"y":0,"w":100,"h":40,"shrapnel":"sparks"},
  {"kind":"crate","x":300,"y":0,"w":64,"h":64}
] }`;
  const state = loadLevel(lvl);
  const [w0, c0] = state.world.obstacles;
  check("the wall loads with its material set", w0.shrapnel === "sparks");
  check("the plain crate loads with none", c0.shrapnel === undefined);
  check("the wall sparks when shot", obstacleShrapnel(w0) === METAL_SPARKS);

  const text = serializeLevel(state);
  check("saving writes the material on the wall", text.includes('"shrapnel":"sparks"'), text.split("\n")[2]?.trim());
  check("saving writes nothing for the plain crate",
    (text.match(/"shrapnel"/g) ?? []).length === 1, `${(text.match(/"shrapnel"/g) ?? []).length} occurrences`);

  const again = loadLevel(text);
  check("reload keeps it", again.world.obstacles[0].shrapnel === "sparks" && !again.world.obstacles[1].shrapnel);
  // The metal barrel needs no pick, so it must not start writing one.
  const bstate = loadLevel(`{ "version": 1, "entities": [{"kind":"barrel_metal","x":0,"y":0,"w":64,"h":64}] }`);
  check("a metal barrel serializes with no `shrapnel` key (it needs none)",
    !serializeLevel(bstate).includes('"shrapnel"'));
  check("...and still sparks after the round trip",
    obstacleShrapnel(bstate.world.obstacles[0]) === METAL_SPARKS);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
