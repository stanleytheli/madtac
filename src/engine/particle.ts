import { add, angleOf, fromAngle, scale, vec, type Vec2 } from "./vec.ts";

/**
 * Short-lived visual debris: shrapnel from map objects, blood from characters.
 * Particles are pure eye-candy — they carry no gameplay state and never collide.
 */
export type ParticleShape = "square" | "circle";

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  z: number; // z level of whatever spawned it (renders with that level)
  angle: number; // current rotation (rad)
  spin: number; // rotation change per tick
  life: number; // ticks remaining
  maxLife: number; // for fade-out
  size: number; // half-extent (square) / radius (circle)
  color: string;
  shape: ParticleShape;
  /** If set, the particle leaves a trail of this color: each tick (while moving)
   *  it stamps a static copy of itself — same pos, orientation, and shape — that
   *  shrinks to nothing. See updateParticles. */
  trail?: string;
  /** Per-tick change to `size`, in the same units (px of half-extent / radius):
   *  negative shrinks (an ember burning out, trail stamps tapering away), positive
   *  expands (a growing puff), 0/undefined holds. Integrated each tick in
   *  updateParticles; the particle is dropped once it reaches size 0. Alpha still
   *  fades over life unless `noFade`. */
  sizeChange?: number;
  /** If true, alpha stays at full for the whole life instead of fading out — the
   *  particle only vanishes by shrinking (used for trail stamps). */
  noFade?: boolean;
}

/**
 * A recipe for a burst of particles. `dir` at spawn time decides which way the
 * burst flies; everything here is the per-burst flavour (look + spread + count).
 */
export interface ParticleStyle {
  color: string;
  shape: ParticleShape;
  size: number;
  /** Base ejection speed (world px/tick). */
  speed: number;
  /** Half-angle of the random ejection cone (radians). */
  spread: number;
  /** Base lifetime in ticks (each particle gets 0.7..1x of this). */
  life: number;
  /** How many particles to emit per burst. */
  count: number;
  /** Optional trail color "#rrggbb": each particle stamps shrinking afterimages
   *  of itself in this color as it flies (see Particle.trail). */
  trail?: string;
  /** Optional per-tick size change in px (see Particle.sizeChange): negative to
   *  shrink as it burns out, positive to expand. Omitted = constant size. */
  sizeChange?: number;
  /** Optional: hold full alpha and vanish only by shrinking (see Particle.noFade). */
  noFade?: boolean;
}

/** Brown wooden splinters kicked off a crate when shot. */
export const CRATE_SHRAPNEL: ParticleStyle = {
  color: "#8a5a26",
  shape: "square",
  size: 4,
  speed: 4.5,
  spread: 1.0,
  life: 16,
  count: 7,
};

/** Gray concrete chips kicked off a wall when shot. */
export const WALL_SHRAPNEL: ParticleStyle = {
  color: "#3a3d40",
  shape: "square",
  size: 4,
  speed: 4.0,
  spread: 1.0,
  life: 14,
  count: 6,
};

/** Bright steel sparks kicked off a metal barrel when shot — fast, small, and
 *  short-lived, so they read as a spark shower rather than debris. */
export const METAL_SHRAPNEL: ParticleStyle = {
  color: "#ffd27a",
  shape: "square",
  size: 3,
  speed: 5.5,
  spread: 0.9,
  life: 10,
  count: 8,
};

/** Stylized red "blood" hitmarker when a character is struck. */
export const BLOOD: ParticleStyle = {
  color: "#d11a1a",
  shape: "circle",
  size: 7,
  speed: 3.5,
  spread: 1.2,
  life: 14,
  count: 6,
};

/** Bright fireball flung out in every direction by an explosion. `spread` = PI is
 *  a full 360° burst (the ejection cone spans the whole circle). */
export const EXPLOSION: ParticleStyle = {
  color: "#ffb43a",
  shape: "circle",
  size: 125,
  speed: 0,
  spread: Math.PI,
  life: 20,
  count: 1,
  sizeChange: 2,
};

/** Dark smoke puff layered under the fireball for a bit of body. */
export const EXPLOSION_SMOKE: ParticleStyle = {
  color: "#4a4038",
  shape: "circle",
  size: 60,
  speed: 18,
  spread: Math.PI,
  life: 50,
  count: 8,
  sizeChange: 0.25,
};

/** Burning green embers flung out of an explosion, each dragging a yellow
 *  exhaust trail and shrinking as it burns out. Cosmetic only. */
export const EXPLOSION_SHRAPNEL: ParticleStyle = {
  color: "#ffe14a",
  shape: "square",
  size: 15,
  speed: 30,
  spread: Math.PI, // full 360° burst
  life: 25,
  count: 8,
  trail: "#ffe14a",
  sizeChange: -0.6, // 15px -> 0 over the ~25-tick life (burns out)
};

/** The default explosion look — dark smoke, a bright fireball, and burning
 *  shrapnel — as a list of bursts spawned at the blast point. Launcher weapons
 *  reference a blast preset like this from their spec (GunSpec.projectile.explosion),
 *  so different rounds can detonate with different visuals. */
export const STANDARD_EXPLOSION: readonly ParticleStyle[] = [
  EXPLOSION_SMOKE,
  EXPLOSION,
  EXPLOSION_SHRAPNEL,
];

const DRAG = 0.86; // per-tick velocity retention (particles slow as they fly)

/**
 * Emit a burst of particles at `pos` flying roughly along `dir` (already a unit
 * vector), spread into a cone. Pushes them into the supplied array.
 */
export function spawnParticles(
  out: Particle[],
  pos: Vec2,
  dir: Vec2,
  style: ParticleStyle,
  z = 0,
): void {
  const base = angleOf(dir);
  for (let i = 0; i < style.count; i++) {
    const ang = base + (Math.random() * 2 - 1) * style.spread;
    const speed = style.speed * (0.5 + Math.random() * 0.5);
    const life = style.life * (0.7 + Math.random() * 0.3);
    out.push({
      pos,
      vel: fromAngle(ang, speed),
      z,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() * 2 - 1) * 0.4,
      life,
      maxLife: life,
      size: style.size,
      color: style.color,
      shape: style.shape,
      trail: style.trail,
      sizeChange: style.sizeChange,
      noFade: style.noFade,
    });
  }
}

const STAMP_LIFE = 12; // ticks a trail stamp lives (it shrinks to nothing over this)
const MIN_TRAIL_SPEED = 0.5; // below this the particle is ~stopped: stop trailing

/** Advance all particles one tick; drop the dead ones. A particle with a `trail`
 *  color also stamps a static, shrinking afterimage of itself each tick while it's
 *  still moving — the stamps carry no trail of their own, so they don't recurse. */
export function updateParticles(particles: Particle[]): Particle[] {
  const alive: Particle[] = [];
  for (const p of particles) {
    p.pos = add(p.pos, p.vel);
    p.vel = scale(p.vel, DRAG);
    p.angle += p.spin;
    if (p.sizeChange) p.size += p.sizeChange; // grow / shrink at its per-tick rate
    p.life -= 1;
    if (p.life <= 0 || p.size <= 0) continue; // dead, or shrunk away to nothing

    if (p.trail && Math.hypot(p.vel.x, p.vel.y) > MIN_TRAIL_SPEED) {
      // Stamp at the current pos + orientation + size (whatever the parent is drawing
      // now), in the trail colour, set to shrink to nothing over STAMP_LIFE. noFade
      // => it holds full opacity and simply shrinks away, a tapering streak of
      // afterimages. Pushed BEFORE the parent so the parent draws on top of its own
      // trail — otherwise the fresh same-spot stamp would hide the parent every frame.
      alive.push({
        pos: vec(p.pos.x, p.pos.y),
        vel: vec(0, 0),
        z: p.z,
        angle: p.angle,
        spin: 0,
        life: STAMP_LIFE,
        maxLife: STAMP_LIFE,
        size: p.size,
        sizeChange: -p.size / STAMP_LIFE,
        color: p.trail,
        shape: p.shape,
        noFade: true,
      });
    }
    alive.push(p);
  }
  return alive;
}

/** Draw particles. Alpha fades over remaining life unless `noFade`; the drawn size
 *  is `size` itself (grown/shrunk each tick by `sizeChange` in updateParticles).
 *  Pass `z` to draw only the ones on that level (each level's render pass draws its
 *  own debris). */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: readonly Particle[],
  z?: number,
): void {
  for (const p of particles) {
    if (z !== undefined && p.z !== z) continue;
    if (p.size <= 0) continue;
    ctx.save();
    ctx.globalAlpha = p.noFade ? 1 : Math.max(0, p.life / p.maxLife);
    ctx.translate(p.pos.x, p.pos.y);
    ctx.fillStyle = p.color;
    if (p.shape === "square") {
      ctx.rotate(p.angle);
      ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
