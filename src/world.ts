import { BODY_RADIUS } from "./character.ts";
import { pointInBox } from "./collision.ts";
import {
  BLOOD,
  CRATE_SHRAPNEL,
  WALL_SHRAPNEL,
  spawnParticles,
  updateParticles,
  type Particle,
  type ParticleStyle,
} from "./particle.ts";
import type { GroundItem } from "./item.ts";
import { add, dist, norm, scale, vec, type Vec2 } from "./vec.ts";

/**
 * A solid, axis-aligned box that blocks movement, bullets, and line of sight.
 * Crates and walls are both Obstacles, differing only in appearance + shrapnel.
 */
export interface Obstacle {
  pos: Vec2; // center
  w: number;
  h: number;
  // appearance
  fill: string;
  stroke: string;
  strokeWidth: number;
  cross: boolean; // draw the diagonal plank "X" (crates) or not (walls)
  /** The shrapnel burst thrown when a bullet hits it. */
  particle: ParticleStyle;
}

/** Purely decorative ground patch. No collision with anything; drawn under objects. */
export interface Floor {
  pos: Vec2; // center
  w: number;
  h: number;
  color: string;
}

export function makeCrate(pos: Vec2, w: number, h: number): Obstacle {
  return { pos, w, h, fill: "#92632d", stroke: "#412b04", strokeWidth: 9, cross: true, particle: CRATE_SHRAPNEL };
}

export function makeWall(pos: Vec2, w: number, h: number): Obstacle {
  return { pos, w, h, fill: "#6b7076", stroke: "#3a3d40", strokeWidth: 6, cross: false, particle: WALL_SHRAPNEL };
}

export function makeFloor(pos: Vec2, w: number, h: number, color: string): Floor {
  return { pos, w, h, color };
}

/**
 * Anything a bullet can strike and damage. Characters satisfy this structurally
 * (declared here, not imported, to keep world.ts free of an actor.ts cycle).
 */
export interface Hittable {
  pos: Vec2;
  registerHit(dir: Vec2, point: Vec2, damage: number): void;
}

export interface Bullet {
  pos: Vec2;
  prev: Vec2; // position last tick (for tracer drawing)
  vel: Vec2;
  life: number; // ticks remaining
  origin: Vec2; // spawn position (head center)
  renderAfter: number; // don't draw until this far from origin (hides it inside the gun)
  owner: Hittable | null; // who fired it; never collides with its own owner
  damage: number; // damage dealt on hit (from the firing gun)
  tracerWidth: number; // cosmetic streak thickness (from the firing gun)
  tracerLength: number; // cosmetic streak length behind the bullet (from the firing gun)
}

/** Static map data plus live projectiles, particle debris, and ground items. */
export interface World {
  obstacles: Obstacle[]; // solid: crates + walls
  floors: Floor[]; // decorative, no collision
  items: GroundItem[]; // pickups lying on the ground
  bullets: Bullet[];
  particles: Particle[];
}

export function createWorld(): World {
  const obstacles: Obstacle[] = [
    // crates
    makeCrate(vec(160, -120), 64, 64),
    makeCrate(vec(240, -120), 64, 64),
    makeCrate(vec(-200, 80), 80, 80),
    makeCrate(vec(-40, 220), 64, 64),
    makeCrate(vec(120, 200), 64, 64),
    makeCrate(vec(-260, -180), 64, 64),
    // walls (long thin boxes forming a partial enclosure)
    makeWall(vec(40, -340), 520, 28),
    makeWall(vec(-300, -120), 28, 460),
    makeWall(vec(360, 60), 28, 320),
  ];

  const floors: Floor[] = [
    makeFloor(vec(0, 0), 260, 260, "#46603f"),
    makeFloor(vec(220, 220), 180, 180, "#5a4a6a"),
  ];

  return { obstacles, floors, items: [], bullets: [], particles: [] };
}

const BACKOUT_STEPS = 10; // max steps to walk a bullet out of what it hit
const BACKOUT_STEP = 4; // world px per back-out step

/**
 * Walk `pos` backward along `back` (a unit vector) until it's no longer `inside`
 * the thing it hit, so debris spawns on the surface rather than buried in it.
 * Capped at `BACKOUT_STEPS` to avoid pathological loops.
 */
function backOut(pos: Vec2, back: Vec2, inside: (p: Vec2) => boolean): Vec2 {
  let p = pos;
  for (let i = 0; i < BACKOUT_STEPS && inside(p); i++) {
    p = add(p, scale(back, BACKOUT_STEP));
  }
  return p;
}

const SUBSTEPS = 10; // sub-tick collision samples along each bullet's path

/**
 * Advance all bullets one tick and drop any that expire or hit something. To stop
 * fast bullets tunneling through thin walls / past characters, collision is sampled
 * at SUBSTEPS points along the path this tick (not just at the endpoint).
 *
 * `targets` are the hittable characters; a bullet never collides with its own
 * owner (you can't shoot yourself), but hits everyone else from the first sample.
 */
export function updateBullets(w: World, targets: readonly Hittable[]): void {
  const alive: Bullet[] = [];
  for (const b of w.bullets) {
    b.life -= 1;
    if (b.life <= 0) continue;

    const start = b.pos;
    const step = scale(b.vel, 1 / SUBSTEPS);
    const backDir = norm(scale(b.vel, -1)); // debris flies back toward the shooter

    let consumed = false;
    for (let i = 1; i <= SUBSTEPS && !consumed; i++) {
      const sample = add(start, scale(step, i));

      // Obstacles (walls/crates) block first.
      for (const o of w.obstacles) {
        if (pointInBox(sample, o)) {
          const at = backOut(sample, backDir, (p) => pointInBox(p, o));
          spawnParticles(w.particles, at, backDir, o.particle);
          consumed = true;
          break;
        }
      }
      if (consumed) break;

      // Then characters (never the shooter).
      for (const t of targets) {
        if (t === b.owner) continue;
        if (dist(sample, t.pos) < BODY_RADIUS) {
          t.registerHit(norm(b.vel), sample, b.damage);
          const at = backOut(sample, backDir, (p) => dist(p, t.pos) < BODY_RADIUS);
          spawnParticles(w.particles, at, backDir, BLOOD);
          consumed = true;
          break;
        }
      }
    }

    if (consumed) continue;

    // No hit along the path: commit the full move.
    b.prev = start;
    b.pos = add(start, b.vel);
    alive.push(b);
  }
  w.bullets = alive;

  w.particles = updateParticles(w.particles);
}

/**
 * Spawn a bullet travelling along `dir` at `speed` from `origin`. `renderAfter`
 * is how far it must travel before it's drawn (so it stays hidden inside the gun).
 * `owner` is the shooter, protected from its own bullet until it clears them.
 */
export function spawnBullet(
  w: World,
  origin: Vec2,
  dir: Vec2,
  speed: number,
  life: number,
  renderAfter: number,
  owner: Hittable | null,
  damage: number,
  tracerWidth: number,
  tracerLength: number,
): void {
  w.bullets.push({
    pos: origin,
    prev: origin,
    vel: scale(dir, speed),
    life,
    origin,
    renderAfter,
    owner,
    damage,
    tracerWidth,
    tracerLength,
  });
}
