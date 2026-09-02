/**
 * Probes crossing traffic between AI walkers: head-on swaps, column
 * crossings, corridor squeezes, and bots converging on one point. This is the
 * acceptance harness for "can bots get past each other" — the step-level
 * contact projection ("unshove") was reverted because it failed exactly here.
 *
 * Sim = the game's per-tick movement order for walkers in open space:
 * raw step toward dest, wall resolve, then the squishy separation pass
 * (radial only, SQUISH_DELTA capped) from game.ts.
 *
 * Run: node_modules/.bin/esbuild scripts/probe_cross.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=/tmp/pc.mjs && node /tmp/pc.mjs
 */
import { Oracle } from "../src/ai/oracle.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { ObstacleGrid, resolveCircleVsObstacle } from "../src/engine/collision.ts";
import type { World } from "../src/world/world.ts";
import type { AiContext } from "../src/ai/robot.ts";
import { dist, norm, scale, sub, add, vec, type Vec2 } from "../src/engine/vec.ts";

const SQUISH_DELTA = 2.0; // mirrors game.ts
const SPEED = 2.4; // walker step, px/tick
const ARRIVE = 30; // "made it" radius, px

const world = (): World => {
  const w: World = {
    obstacles: [], floors: [], stairs: [], nodes: [],
    items: [], vehicles: [], bullets: [], projectiles: [], particles: [],
  } as any;
  (w as any).grid = new ObstacleGrid([]);
  return w;
};

interface Walker {
  bot: Oracle;
  dest: Vec2;
  arrived: number; // tick of arrival, -1 while walking
}

const walker = (p: Vec2, dest: Vec2): Walker => {
  const bot = new Oracle(vec(p.x, p.y), { team: "blue", z: 0 } as any);
  bot.hp = 100;
  return { bot, dest, arrived: -1 };
};

/** Walls for the corridor scenarios (a bare Obstacle: box at pos, w x h). */
const wallAt = (x: number, y: number, w: number, h: number): any => ({
  pos: vec(x, y), w, h, z: 0,
  fill: "", stroke: "", strokeWidth: 0, cross: false, particle: "wood",
});
let walls: any[] = [];
const resolveWalls = (p: Vec2): Vec2 => {
  for (let i = 0; i < 3; i++) for (const o of walls) p = resolveCircleVsObstacle(p, BODY_RADIUS, o);
  return p;
};

/** One game tick for the walkers: raw step, then squishy separation. */
const tick = (ws: Walker[], ai: AiContext, t: number): void => {
  for (const w of ws) {
    const b = w.bot;
    const d = dist(b.pos, w.dest);
    if (d <= ARRIVE) {
      if (w.arrived < 0) w.arrived = t;
      b.vel = vec(0, 0);
      continue;
    }
    const move = scale(norm(sub(w.dest, b.pos)), Math.min(SPEED, d));
    b.vel = move;
    b.pos = resolveWalls(add(b.pos, move));
  }
  // squishy separation (game.ts separateCharacters, open space, single z)
  const diam = 2 * BODY_RADIUS;
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i].bot;
      const b = ws[j].bot;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= diam * diam || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const half = Math.min(SQUISH_DELTA, diam - d) * 0.5;
      a.pos = resolveWalls(vec(a.pos.x - nx * half, a.pos.y - ny * half));
      b.pos = resolveWalls(vec(b.pos.x + nx * half, b.pos.y + ny * half));
    }
  }
};

const run = (ws: Walker[], maxTicks: number): { done: number; last: number } => {
  const w0 = world();
  const ai = { world: w0, characters: ws.map((w) => w.bot), nav: null, tick: 0 } as any;
  for (let t = 1; t <= maxTicks; t++) {
    tick(ws, ai, t);
    if (ws.every((w) => w.arrived >= 0)) return { done: ws.length, last: t };
  }
  return { done: ws.filter((w) => w.arrived >= 0).length, last: maxTicks };
};

const straightTicks = (a: Vec2, b: Vec2): number => Math.ceil(dist(a, b) / SPEED);

// ------------------------------------------------------------- scenarios ----
console.log("== head-on swap (A and B trade places, 600px apart) ==");
for (const offset of [0, 5, 20, 40]) {
  const ws = [walker(vec(0, 0), vec(600, offset)), walker(vec(600, offset), vec(0, 0))];
  const base = straightTicks(vec(0, 0), vec(600, offset));
  const r = run(ws, 2000);
  console.log(
    `  y-offset ${String(offset).padStart(2)}px: ${r.done}/2 arrived, ` +
      `${r.last} ticks (unobstructed ${base})` +
      (r.done < 2 ? "  <-- STUCK" : r.last > base * 2 ? "  <-- slow" : ""),
  );
}

console.log("== COLD-START head-on: already in contact, velocities zero ==");
// The in-game failure: two bots meet, both steps get projected away, both vels
// read ~0, and a vel-based opposing test can never re-arm — mutual stall.
for (const offset of [0, 5, 20]) {
  const ws = [
    walker(vec(0, 0), vec(600, offset)),
    walker(vec(2 * BODY_RADIUS - 6, offset / 10), vec(-600 + 2 * BODY_RADIUS, offset)),
  ];
  const base = straightTicks(vec(0, 0), vec(600, offset));
  const r = run(ws, 2000);
  console.log(
    `  y-offset ${String(offset).padStart(2)}px: ${r.done}/2 arrived, ` +
      `${r.last} ticks (unobstructed ~${base})` +
      (r.done < 2 ? "  <-- STUCK" : r.last > base * 2 ? "  <-- slow" : ""),
  );
}

console.log("== oblique cross (paths at 90 degrees through one point) ==");
{
  const ws = [walker(vec(0, 0), vec(600, 0)), walker(vec(300, -300), vec(300, 300))];
  const r = run(ws, 2000);
  console.log(`  ${r.done}/2 arrived, ${r.last} ticks (unobstructed ${straightTicks(vec(0, 0), vec(600, 0))})`);
}

console.log("== column crossing (3 going east through 3 going west) ==");
{
  const ws: Walker[] = [];
  for (let i = 0; i < 3; i++) {
    ws.push(walker(vec(0, i * 70), vec(600, i * 70)));
    ws.push(walker(vec(600, i * 70 + 30), vec(0, i * 70 + 30)));
  }
  const base = straightTicks(vec(0, 0), vec(600, 0));
  const r = run(ws, 3000);
  console.log(`  ${r.done}/6 arrived, ${r.last} ticks (unobstructed ${base})` + (r.done < 6 ? "  <-- STUCK" : ""));
}

console.log("== corridor swap (walls above and below; width = free space) ==");
// Bodies are 60px wide, so a 120px corridor is the geometric minimum to pass.
for (const width of [125, 140, 180, 240]) {
  walls = [
    wallAt(300, -(width / 2 + 100), 1400, 200),
    wallAt(300, width / 2 + 100, 1400, 200),
  ];
  const ws = [walker(vec(0, 0), vec(600, 0)), walker(vec(600, 0), vec(0, 0))];
  const base = straightTicks(vec(0, 0), vec(600, 0));
  const r = run(ws, 3000);
  console.log(
    `  width ${String(width).padStart(3)}px: ${r.done}/2 arrived, ${r.last} ticks (unobstructed ${base})` +
      (r.done < 2 ? "  <-- STUCK" : r.last > base * 2 ? "  <-- slow" : ""),
  );
}
{
  // 3 vs 3 in a two-lane corridor — the worst realistic squeeze.
  const width = 180;
  walls = [
    wallAt(300, -(width / 2 + 100), 1400, 200),
    wallAt(300, width / 2 + 100, 1400, 200),
  ];
  const ws: Walker[] = [];
  for (let i = 0; i < 3; i++) {
    ws.push(walker(vec(-i * 70, 0), vec(1100 + i * 70, 0)));
    ws.push(walker(vec(600 + i * 70, 20), vec(-500 - i * 70, 20)));
  }
  const r = run(ws, 4000);
  console.log(`  3v3 at 180px: ${r.done}/6 arrived, ${r.last} ticks` + (r.done < 6 ? "  <-- STUCK" : ""));
}
walls = [];

console.log("== common destination (both walk at the same point; orbit check) ==");
{
  const ws = [walker(vec(0, 0), vec(300, 0)), walker(vec(600, 0), vec(300, 0))];
  const w0 = world();
  const ai = { world: w0, characters: ws.map((w) => w.bot), nav: null, tick: 0 } as any;
  let travelled = 0; // total path length after both are near the dest region
  let settledAt = -1;
  for (let t = 1; t <= 1200; t++) {
    const before = ws.map((w) => vec(w.bot.pos.x, w.bot.pos.y));
    tick(ws, ai, t);
    const near = ws.every((w) => dist(w.bot.pos, w.dest) < ARRIVE + diamPad());
    if (near && settledAt < 0) settledAt = t;
    if (settledAt >= 0) for (let k = 0; k < ws.length; k++) travelled += dist(before[k], ws[k].bot.pos);
  }
  console.log(
    `  settled near dest at tick ${settledAt}; drift after settling ${travelled.toFixed(0)}px` +
      (travelled > 200 ? "  <-- ORBIT/JITTER" : "  (calm)"),
  );
}

function diamPad(): number {
  // both can't stand ON the point: allow one body diameter of standoff
  return 2 * BODY_RADIUS;
}
