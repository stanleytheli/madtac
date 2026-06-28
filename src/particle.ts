import { add, angleOf, fromAngle, scale, type Vec2 } from "./vec.ts";

/**
 * Short-lived visual debris: shrapnel from map objects, blood from characters.
 * Particles are pure eye-candy — they carry no gameplay state and never collide.
 */
export type ParticleShape = "square" | "circle";

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  angle: number; // current rotation (rad)
  spin: number; // rotation change per tick
  life: number; // ticks remaining
  maxLife: number; // for fade-out
  size: number; // half-extent (square) / radius (circle)
  color: string;
  shape: ParticleShape;
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
): void {
  const base = angleOf(dir);
  for (let i = 0; i < style.count; i++) {
    const ang = base + (Math.random() * 2 - 1) * style.spread;
    const speed = style.speed * (0.5 + Math.random() * 0.5);
    const life = style.life * (0.7 + Math.random() * 0.3);
    out.push({
      pos,
      vel: fromAngle(ang, speed),
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() * 2 - 1) * 0.4,
      life,
      maxLife: life,
      size: style.size,
      color: style.color,
      shape: style.shape,
    });
  }
}

/** Advance all particles one tick; drop the dead ones. */
export function updateParticles(particles: Particle[]): Particle[] {
  const alive: Particle[] = [];
  for (const p of particles) {
    p.pos = add(p.pos, p.vel);
    p.vel = scale(p.vel, DRAG);
    p.angle += p.spin;
    p.life -= 1;
    if (p.life > 0) alive.push(p);
  }
  return alive;
}

/** Draw every particle, fading out over its remaining life. */
export function drawParticles(ctx: CanvasRenderingContext2D, particles: readonly Particle[]): void {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
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
