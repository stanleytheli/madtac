/**
 * Verifies bullet-hole decals: a round that stops on an obstacle stamps a hole
 * ON its surface, oriented by the real outward normal there (a rotated wall, a
 * barrel, a corner), a wallbang stamps one on each face it crossed, and holes
 * age out after DECAL_LIFE ticks. Also drives drawDecals through a recording
 * context to confirm the sprite is placed flat-edge-on-face, body into the wall,
 * clipped to the obstacle's outline.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_bulletholes.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vbh.mjs && node <tmp>/vbh.mjs
 */
import { stepEffects } from "../src/engine/effects.ts";
import {
  makeBarrelMetal,
  makeWall,
  spawnBullet,
  updateBullets,
  type Obstacle,
  type World,
} from "../src/world/world.ts";
import { ObstacleGrid, obstacleSurfaceNormal, pointInObstacle } from "../src/engine/collision.ts";
import { DECAL_LIFE, HOLE_H, HOLE_W, drawDecals, stampBulletHole, updateDecals, type Decal } from "../src/engine/decal.ts";
import { add, deg2rad, dot, fromAngle, scale, vec, type Vec2 } from "../src/engine/vec.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };

function world(obstacles: Obstacle[]): World {
  const w: World = {
    obstacles, floors: [], stairs: [], nodes: [], items: [], vehicles: [],
    bullets: [], projectiles: [], particles: [], decals: [], scorches: [], events: [],
  } as unknown as World;
  if (obstacles.length) (w as any).grid = new ObstacleGrid(obstacles);
  return w;
}

/** Fire one round from `from` along `dir` and run until it lands or expires. */
function fire(obstacles: Obstacle[], from: Vec2, dir: Vec2, penetration = 0, tracer = 4): World {
  const w = world(obstacles);
  spawnBullet(w, from, dir, 60, 40, 0, null, 100, tracer, 20, "#fff", AP, 0, undefined, null, penetration);
  for (let i = 0; i < 40 && w.bullets.length; i++) {
    updateBullets(w, []);
    stepEffects(w); // stamp the holes the sim asked for, as the client would
  }
  return w;
}

/** Signed distance from a point to the obstacle's surface (<0 inside). */
function surfaceDist(p: Vec2, o: Obstacle): number {
  const { dist } = obstacleSurfaceNormal(p, o);
  return dist;
}
const fmt = (v: Vec2) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)})`;

console.log("a stopped round stamps one hole on the face it hit:");
{
  const wall = makeWall(vec(0, 0), 40, 400, 0);
  const w = fire([wall], vec(-300, 10), vec(1, 0));
  check("exactly one decal", w.decals.length === 1, `n=${w.decals.length}`);
  const d = w.decals[0];
  check("on the wall's west face (x = -20)", Math.abs(d.pos.x + 20) < 1e-6 && Math.abs(d.pos.y - 10) < 1e-6, fmt(d.pos));
  check("normal points back at the shooter (-x)", Math.abs(d.normal - Math.PI) < 1e-6, `normal=${d.normal.toFixed(3)}`);
  check("it is the wall's decal", d.on === wall);
  // fire() keeps ticking after the strike, so the life has already begun to count.
  check("fresh life (less the ticks since), sized by the round", d.life > DECAL_LIFE - 40 && d.life <= DECAL_LIFE && d.w === HOLE_W && d.h === HOLE_H, `life=${d.life} w=${d.w} h=${d.h}`);
  const fat = fire([wall], vec(-300, 10), vec(1, 0), 0, 8).decals[0];
  check("a heavier round leaves a bigger hole (2x at an 8px tracer)", fat.w === 2 * HOLE_W && fat.h === 2 * HOLE_H, `w=${fat.w} h=${fat.h}`);
}

console.log("\nthe normal is the obstacle's real one:");
{
  // A wall rotated 30°, hit head-on along its own local -x axis.
  const ang = deg2rad(30);
  const wall: Obstacle = { ...makeWall(vec(0, 0), 40, 400, 0), angle: ang };
  const n = fromAngle(ang); // the rotated wall's +x face normal
  const w = fire([wall], add(vec(0, 0), scale(n, 300)), scale(n, -1));
  check("rotated wall: one decal", w.decals.length === 1, `n=${w.decals.length}`);
  const d = w.decals[0];
  check("...on its surface", Math.abs(surfaceDist(d.pos, wall)) < 1e-6, `dist=${surfaceDist(d.pos, wall).toExponential(2)}`);
  check("...normal = the rotated face's", dot(fromAngle(d.normal), n) > 1 - 1e-9, `normal=${d.normal.toFixed(3)} want=${ang.toFixed(3)}`);

  // A barrel, hit off-centre: the normal is radial at the strike point.
  const barrel = makeBarrelMetal(vec(0, 0), 30, 0);
  const wb = fire([barrel], vec(-300, 15), vec(1, 0));
  check("barrel: one decal", wb.decals.length === 1, `n=${wb.decals.length}`);
  const db = wb.decals[0];
  check("...on the rim", Math.abs(Math.hypot(db.pos.x, db.pos.y) - 30) < 1e-6, fmt(db.pos));
  const radial = fromAngle(db.normal);
  check("...normal is radial", dot(radial, scale(db.pos, 1 / 30)) > 1 - 1e-9, `normal=${db.normal.toFixed(3)}`);
  check("...and faces the shooter", radial.x < 0);

  // A corner: a round grazing past the top-left corner of a box lands on a
  // corner normal, not a snapped axis (the strike point sits within the
  // back-out step of the corner, so its nearest feature is the vertex).
  const box = makeWall(vec(0, 0), 40, 40, 0);
  const wc = fire([box], vec(-300, -298), vec(Math.SQRT1_2, Math.SQRT1_2)); // y = x + 2: clips the top-left corner
  check("corner: one decal", wc.decals.length === 1, `n=${wc.decals.length}`);
  const dc = wc.decals[0];
  check("...on the surface", Math.abs(surfaceDist(dc.pos, box)) < 1e-6, fmt(dc.pos));
  check("...not inside the box", !pointInObstacle(add(dc.pos, scale(fromAngle(dc.normal), 0.01)), box));
}

console.log("\na wallbang stamps both faces it crossed:");
{
  const wall = makeWall(vec(0, 0), 20, 400, 0);
  const w = fire([wall], vec(-300, 0), vec(1, 0), 100);
  check("two decals", w.decals.length === 2, `n=${w.decals.length}`);
  const [entry, exit] = w.decals;
  check("entry on the west face, facing west", Math.abs(entry.pos.x + 10) < 1e-6 && Math.abs(entry.normal - Math.PI) < 1e-6, `${fmt(entry.pos)} n=${entry.normal.toFixed(3)}`);
  check("exit on the east face, facing east", Math.abs(exit.pos.x - 10) < 1e-6 && Math.abs(exit.normal) < 1e-6, `${fmt(exit.pos)} n=${exit.normal.toFixed(3)}`);

  // A crate stacked against a wall is one crossing; the entry hole is the
  // crate's, the exit hole the wall's.
  const crate = makeWall(vec(-15, 0), 10, 400, 0);
  const w2 = fire([crate, wall], vec(-300, 0), vec(1, 0), 100);
  check("touching material: two decals", w2.decals.length === 2, `n=${w2.decals.length}`);
  check("entry is the crate's", w2.decals[0].on === crate && Math.abs(w2.decals[0].pos.x + 20) < 1e-6, fmt(w2.decals[0].pos));
  check("exit is the wall's", w2.decals[1].on === wall && Math.abs(w2.decals[1].pos.x - 10) < 1e-6, fmt(w2.decals[1].pos));
}

console.log("\nholes age out, and invisible barriers take none:");
{
  const wall = makeWall(vec(0, 0), 40, 400, 0);
  const w = fire([wall], vec(-300, 0), vec(1, 0));
  const spawnedAt = w.decals[0].life; // ticks already elapsed in fire() count
  for (let i = 0; i < DECAL_LIFE; i++) w.decals = updateDecals(w.decals);
  check(`gone after ${DECAL_LIFE} ticks (5 s at 60/s)`, w.decals.length === 0 && DECAL_LIFE === 300, `spawned with life=${spawnedAt}`);
  const ghost: Obstacle = { ...wall, invisible: true };
  check("invisible wall: no hole", fire([ghost], vec(-300, 0), vec(1, 0)).decals.length === 0);
  const out: Decal[] = [];
  stampBulletHole(out, vec(-25, 0), wall, 0, 0);
  check("heft 0 (a tracerless punch): no hole", out.length === 0);
}

console.log("\na round landing on an existing hole restarts its clock and leaves it put:");
{
  const wall = makeWall(vec(0, 0), 40, 400, 0);
  const other = makeWall(vec(100, 0), 40, 400, 0);
  const out: Decal[] = [];
  stampBulletHole(out, vec(-25, 0), wall, 0);
  out[0].life = 100;
  const first = out[0];
  stampBulletHole(out, vec(-25, HOLE_W / 2 - 1), wall, 0); // just inside half a width away
  check("within half a hole width: still one hole", out.length === 1, `n=${out.length}`);
  check("...the same object, still at its own point", out[0] === first && Math.abs(first.pos.y) < 1e-9, fmt(first.pos));
  check("...with its clock restarted", first.life === DECAL_LIFE, `life=${first.life}`);
  stampBulletHole(out, vec(-25, HOLE_W / 2 + 1), wall, 0); // just past half a width from the hole
  check("further than that: a second hole", out.length === 2, `n=${out.length}`);
  stampBulletHole(out, vec(-25, 1), wall, 0, 3); // a heavy round merges over its OWN half width
  check("a heavier round merges over its own, wider radius", out.length === 2, `n=${out.length}`);
  check("...and takes the hole over: its size and its point", first.w === 3 * HOLE_W && first.h === 3 * HOLE_H && Math.abs(first.pos.y - 1) < 1e-9, `w=${first.w} ${fmt(first.pos)}`);
  first.life = 100;
  stampBulletHole(out, vec(-25, 0), wall, 0, 1); // a lighter round on the big hole
  check("a lighter round refreshes the big hole but leaves it big and put", out.length === 2 && first.w === 3 * HOLE_W && Math.abs(first.pos.y - 1) < 1e-9 && first.life === DECAL_LIFE, `w=${first.w} ${fmt(first.pos)} life=${first.life}`);
  stampBulletHole(out, vec(75, HOLE_W / 2 - 1), other, 0);
  check("the same spot on a different obstacle is its own hole", out.length === 3, `n=${out.length}`);

  // Through the bullet loop: a burst into one patch leaves one hole.
  const w = world([wall]);
  for (let i = 0; i < 10; i++) {
    spawnBullet(w, vec(-300, 2 * (i % 3)), vec(1, 0), 60, 40, 0, null, 100, 4, 20, "#fff", AP, 0, undefined, null, 0);
  }
  for (let i = 0; i < 40 && w.bullets.length; i++) {
    updateBullets(w, []);
    stepEffects(w);
  }
  check("a 10-round burst into one patch leaves one hole", w.decals.length === 1, `n=${w.decals.length}`);
}

console.log("\ndrawDecals places the sprite flat-edge-on-face, clipped to the obstacle:");
{
  // A recording context: tracks the current transform like a real canvas, and
  // logs clip paths + drawImage rects in WORLD space.
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const apply = (m: M, x: number, y: number): Vec2 => vec(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const log: string[] = [];
  const corners: Vec2[] = [];
  let clipRect: Vec2[] = [];
  let alpha = 1;
  const ctx = {
    save: () => stack.push(m), restore: () => { m = stack.pop()!; },
    translate: (x: number, y: number) => { m = mul(m, [1, 0, 0, 1, x, y]); },
    rotate: (a: number) => { m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    scale: (x: number, y: number) => { m = mul(m, [x, 0, 0, y, 0, 0]); },
    beginPath: () => { clipRect = []; },
    rect: (x: number, y: number, w: number, h: number) => { clipRect = [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)]; },
    arc: () => { log.push("arc"); },
    clip: () => { log.push("clip"); },
    drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => {
      log.push("drawImage");
      corners.push(apply(m, x, y + h), apply(m, x + w, y + h), apply(m, x + w, y), apply(m, x, y)); // bottom-left, bottom-right, top-right, top-left
    },
    set globalAlpha(v: number) { alpha = v; },
  } as unknown as CanvasRenderingContext2D;

  const wall = makeWall(vec(0, 0), 40, 400, 0);
  const d: Decal = { pos: vec(-20, 10), normal: Math.PI, z: 0, on: wall, w: 40, h: 20, flip: false, life: 600 };
  const image = {} as CanvasImageSource;
  drawDecals(ctx, [d], image, 0);
  check("clips before drawing", log.join(",") === "clip,drawImage", log.join(","));
  const cr = clipRect.map(fmt).join(" ");
  check("clip is the wall's outline in world space", clipRect.length === 4 && Math.abs(clipRect[0].x + 20) < 1e-9 && Math.abs(clipRect[2].x - 20) < 1e-9 && Math.abs(clipRect[2].y - 200) < 1e-9, cr);
  const [bl, br, tr, tl] = corners;
  const onFace = (p: Vec2) => Math.abs(p.x + 20) < 1e-9;
  check("sprite's flat (bottom) edge lies on the face, centred on the hit", onFace(bl) && onFace(br) && Math.abs((bl.y + br.y) / 2 - 10) < 1e-9, `${fmt(bl)} ${fmt(br)}`);
  check("...spanning 40 px along it", Math.abs(bl.y - br.y) - 40 < 1e-9 && Math.abs(Math.abs(bl.y - br.y) - 40) < 1e-9);
  check("sprite's body extends 20 px INTO the wall (+x)", Math.abs(tl.x) < 1e-9 && Math.abs(tr.x) < 1e-9, `${fmt(tl)} ${fmt(tr)}`);
  check("full alpha until the fade", alpha === 1);
  d.life = 30;
  drawDecals(ctx, [d], image, 0);
  check("half alpha halfway through the last second", Math.abs(alpha - 0.5) < 1e-9, `alpha=${alpha}`);
  corners.length = 0;
  drawDecals(ctx, [d], image, 1);
  check("other level: not drawn", corners.length === 0);

  // A barrel decal clips to an arc and the sprite points at the centre.
  const barrel = makeBarrelMetal(vec(0, 0), 30, 0);
  log.length = 0; corners.length = 0;
  const db: Decal = { pos: vec(-30, 0), normal: Math.PI, z: 0, on: barrel, w: 40, h: 20, flip: true, life: 600 };
  drawDecals(ctx, [db], image, 0);
  check("barrel clips to its disc", log.join(",") === "arc,clip,drawImage", log.join(","));
  const mid = vec((corners[2].x + corners[3].x) / 2, (corners[2].y + corners[3].y) / 2);
  check("...sprite top edge is 20 px toward the centre", Math.abs(mid.x + 10) < 1e-9 && Math.abs(mid.y) < 1e-9, fmt(mid));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
