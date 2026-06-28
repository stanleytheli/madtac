import { BODY_RADIUS } from "./character.ts";
import { pointInCrate } from "./collision.ts";
import {
  BLOOD,
  CRATE_SHRAPNEL,
  spawnParticles,
  updateParticles,
  type Particle,
  type ParticleStyle,
} from "./particle.ts";
import { add, dist, norm, scale, vec, type Vec2 } from "./vec.ts";

export interface Crate {
  pos: Vec2; // center
  w: number;
  h: number;
  /** The shrapnel burst this crate throws off when a bullet hits it. */
  particle: ParticleStyle;
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
  owner: Hittable | null; // who fired it (can't be hit by it until it exits them)
  clearedOwner: boolean; // true once the bullet has left the owner's body
  damage: number; // damage dealt on hit (from the firing gun)
}

/** Static map data plus live projectiles and particle debris. */
export interface World {
  crates: Crate[];
  bullets: Bullet[];
  particles: Particle[];
}

export function createWorld(): World {
  const crate = (pos: Vec2, w: number, h: number): Crate => ({
    pos,
    w,
    h,
    particle: CRATE_SHRAPNEL,
  });
  const crates: Crate[] = [
    crate(vec(160, -120), 64, 64),
    crate(vec(240, -120), 64, 64),
    crate(vec(-200, 80), 80, 80),
    crate(vec(-40, 220), 64, 64),
    crate(vec(120, 200), 64, 64),
    crate(vec(-260, -180), 64, 64),
  ];

  return { crates, bullets: [], particles: [] };
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

/**
 * Advance all bullets one tick and drop any that expire or hit something.
 * `targets` are the hittable characters; a bullet can't damage its own owner
 * until it has travelled clear of the owner's body (the owner may be moving in
 * the firing direction, so this is checked against the owner's live position).
 */
export function updateBullets(w: World, targets: readonly Hittable[]): void {
  const alive: Bullet[] = [];
  for (const b of w.bullets) {
    b.prev = b.pos;
    b.pos = add(b.pos, b.vel);
    b.life -= 1;
    if (b.life <= 0) continue;

    // Once the bullet is outside the owner, it's armed against everyone.
    if (b.owner && !b.clearedOwner && dist(b.pos, b.owner.pos) > BODY_RADIUS) {
      b.clearedOwner = true;
    }

    const backDir = norm(scale(b.vel, -1)); // debris flies back toward the shooter

    let hit = false;
    for (const c of w.crates) {
      if (pointInCrate(b.pos, c)) {
        // Back out of the crate before throwing shrapnel from its surface.
        const at = backOut(b.pos, backDir, (p) => pointInCrate(p, c));
        spawnParticles(w.particles, at, backDir, c.particle);
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const t of targets) {
        if (t === b.owner && !b.clearedOwner) continue; // can't hit yourself point-blank
        if (dist(b.pos, t.pos) < BODY_RADIUS) {
          t.registerHit(norm(b.vel), b.pos, b.damage);
          // Back out of the body so the blood spawns at the point of impact.
          const at = backOut(b.pos, backDir, (p) => dist(p, t.pos) < BODY_RADIUS);
          spawnParticles(w.particles, at, backDir, BLOOD);
          hit = true;
          break;
        }
      }
    }
    if (hit) continue;

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
): void {
  w.bullets.push({
    pos: origin,
    prev: origin,
    vel: scale(dir, speed),
    life,
    origin,
    renderAfter,
    owner,
    clearedOwner: false,
    damage,
  });
}
