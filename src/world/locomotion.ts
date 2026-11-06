/**
 * How a body gets about the world: walking (accel + friction, see
 * Character.move), staircases, pushing out of walls and vehicle hulls, and the
 * footsteps it makes. World geometry only, no Game, so the same code runs in
 * two places that must agree to the pixel:
 *   - the simulation (Game.update), for every character;
 *   - a networked client predicting its own player (net/client.ts), which
 *     replays its unacknowledged inputs through exactly these steps. Any
 *     difference between the two shows up as a correction on screen.
 */
import type { Character } from "../entities/actor.ts";
import { BODY_RADIUS } from "../entities/character.ts";
import { resolveCircleVsBox, resolveCircleVsObstacle } from "../engine/collision.ts";
import { emitSound, type GameEvent } from "../engine/events.ts";
import { dot, len, scale, sub, type Vec2 } from "../engine/vec.ts";
import { FOOTSTEP_LEAD, FOOTSTEP_MIN_SPEED, FOOTSTEP_SOUNDS, FOOTSTEP_TICKS } from "./hitsounds.ts";
import { stairClimbDir, stairZ, type World } from "./world.ts";

/** Push-out passes, so a body in a corner (two walls) settles. */
const WALL_PASSES = 3;

/** The climb-axis direction of the staircase `c` stands on, or null if none.
 *  Handed to the Character so its move() can slow the climb (see
 *  Character.onStairs) — the world-aware half of that feature. */
export function stairDirAt(world: World, c: Character): Vec2 | null {
  for (const s of world.stairs) {
    if (stairZ(s, c.pos) !== null) return stairClimbDir(s);
  }
  return null;
}

/** Flip `c`'s z at any stair midpoint it's standing on. Called right after a
 *  character moves and before it resolves collisions, so it always resolves
 *  against the level it actually ended up on — crossing the midpoint used to
 *  resolve against the OLD level, then snap (or clip through a wall) next tick. */
export function applyStairZ(world: World, c: Character): void {
  for (const s of world.stairs) {
    const z = stairZ(s, c.pos);
    if (z !== null) c.z = z;
  }
}

/** Push a body at `pos` out of every wall it overlaps on level `z`, a few
 *  passes so a corner between two walls settles (each push-out can nudge it
 *  into the neighbour). Uses the grid to touch only nearby obstacles. */
export function resolveWalls(world: World, pos: Vec2, z: number): Vec2 {
  const grid = world.grid;
  for (let i = 0; i < WALL_PASSES; i++) {
    if (grid) {
      grid.eachNear(pos, BODY_RADIUS, z, (o) => {
        pos = resolveCircleVsObstacle(pos, BODY_RADIUS, o);
      });
    } else {
      for (const o of world.obstacles) {
        if (o.z === z) pos = resolveCircleVsObstacle(pos, BODY_RADIUS, o);
      }
    }
  }
  return pos;
}

/** Push a body at `pos` out of every vehicle's solid parts on level `z` — a
 *  pedestrian can't stand inside a hull (occupants are pinned and skip this).
 *  A moving vehicle thus shoves anyone it drives into (they're re-ejected each
 *  tick as the hull advances). No-op when the map has no vehicles. */
export function resolveVehicles(world: World, pos: Vec2, z: number): Vec2 {
  for (const v of world.vehicles) {
    if (v.z !== z) continue;
    for (const b of v.movementBoxes()) pos = resolveCircleVsBox(pos, BODY_RADIUS, b);
  }
  return pos;
}

/** Resolve `c` against WALLS: it has already moved this tick (pos += vel), so
 *  just push it out of any wall it now overlaps. No sweep is needed — at the
 *  game's body speeds (max ~7.5 px/tick, far below the 60px body diameter) a
 *  body can't jump across a wall in one tick, and pushing out along the wall's
 *  nearest feature slides the body along it for free. Body-vs-body is the
 *  separate squishy pass (see Game.separateCharacters). */
export function resolveCollisions(world: World, c: Character): void {
  const before = c.pos;
  c.pos = resolveWalls(world, c.pos, c.z);
  c.pos = resolveVehicles(world, c.pos, c.z);
  // The push-out moved the body, not its velocity: pressing into a wall left
  // `vel` at full running speed while the body stood still, so everything
  // that reads speed (spread, footsteps, the no-scope mark, the player's
  // inferred route) behaved as if it were sprinting. Cancel the component of
  // vel that points into the wall (the push direction), keep the rest so a
  // glancing approach still slides along it at the slide speed.
  const push = sub(c.pos, before);
  const pl = len(push);
  if (pl > 1e-6) {
    const n = scale(push, 1 / pl);
    const into = dot(c.vel, n);
    if (into < 0) c.vel = sub(c.vel, scale(n, into));
  }
}

/** A human's step on foot for one tick: walk along `axis` (raw -1/0/1 per
 *  axis), flip level at a stair midpoint, push out of walls and hulls. Assumes
 *  `c.onStairs` is current (stairDirAt), as Game.update sets it for everyone
 *  before anyone moves. */
export function walk(world: World, c: Character, axis: Vec2): void {
  c.move(axis); // speed factors live on the Character
  applyStairZ(world, c); // flip z at the midpoint BEFORE resolving...
  resolveCollisions(world, c); // ...so it's against the level it ends on (walls only)
}

/** Footsteps: on foot and moving, one every FOOTSTEP_TICKS, clips cycled,
 *  positional at the walker's feet. Run after the tick's movement. `by` tags
 *  the sound with the walker, so a client that plays its own player's steps
 *  itself can skip the server's copy. */
export function footsteps(c: Character, events: GameEvent[]): void {
  if (c.hp > 0 && !c.vehicle && Math.hypot(c.vel.x, c.vel.y) >= FOOTSTEP_MIN_SPEED) {
    c.stepTicks += 1;
    if (c.stepTicks >= FOOTSTEP_TICKS) {
      c.stepTicks = 0;
      emitSound(events, FOOTSTEP_SOUNDS[c.stepIndex], { pos: c.pos, z: c.z, pitchVar: 0.06, by: c.id });
      c.stepIndex = (c.stepIndex + 1) % FOOTSTEP_SOUNDS.length;
    }
  } else {
    c.stepTicks = FOOTSTEP_TICKS - FOOTSTEP_LEAD;
  }
}
