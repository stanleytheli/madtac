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
  /** Fade the trail as well as shrinking it: its stamps lose alpha over their
   *  life the way ordinary debris does, instead of holding full opacity until
   *  they taper away. A softer streak — see updateParticles. */
  trailFade?: boolean;
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
  /** Optional: let that trail fade out as well as thin out (see Particle.trailFade).
   *  Omitted = the streak holds full opacity, the way an explosion's embers do. */
  trailFade?: boolean;
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

/** Bright steel sparks struck off a metal object by a bullet — the explosion's burning
 *  shrapnel (EXPLOSION_SHRAPNEL) scaled down to an impact: same yellow squares
 *  dragging the same trail, but thrown out of a cone rather than a full circle
 *  and burning out inside a quarter of a second. Any obstacle can ask for these
 *  instead of its own debris — see SHRAPNEL_STYLES. */
export const METAL_SPARKS: ParticleStyle = {
  color: "#b39e33",
  shape: "square",
  size: 4,
  speed: 8,
  spread: 1.0,
  life: 10,
  count: 4,
  trail: "#ffe14a",
  trailFade: true, // the streak dims as it thins, instead of winking out at full brightness
  sizeChange: -0.4, // 4px -> 0 over the ~10-tick life (burns out)
};

/**
 * The tracer width the debris styles above are authored against: a round this fat
 * throws shrapnel at exactly the size and speed its style names, and anything
 * thinner or fatter scales in proportion — a rifle chips a wall, a .50 takes a
 * bite out of it. See spawnParticles' `heft` and the impact call in updateBullets.
 */
export const SHRAPNEL_TRACER_WIDTH = 4;

/**
 * The impact debris an obstacle can be given BY NAME, instead of the one its kind
 * implies (a crate splinters, a wall chips). Keys are what a level stores and what
 * the editor's shrapnel dropdown lists, so adding a material is one entry here —
 * see Obstacle.shrapnel and obstacleShrapnel.
 *
 * A named pick is used verbatim, in its own colors: choosing `wood` on a concrete
 * wall is asking for brown splinters, not the wall's gray restated. (The default —
 * no pick — still tints the kind's own debris to the object's paint.)
 */
export const SHRAPNEL_STYLES: Record<string, ParticleStyle> = {
  sparks: METAL_SPARKS,
  wood: CRATE_SHRAPNEL,
  concrete: WALL_SHRAPNEL,
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
  size: 135,
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
  speed: 20,
  spread: Math.PI,
  life: 55,
  count: 8,
  sizeChange: 0.30,
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



/** Bright fireball flung out in every direction by an explosion. `spread` = PI is
 *  a full 360° burst (the ejection cone spans the whole circle). */
export const SMALL_EXPLOSION_BLAST: ParticleStyle = {
  color: "#ffb43a",
  shape: "circle",
  size: 90,
  speed: 0,
  spread: Math.PI,
  life: 20,
  count: 1,
  sizeChange: 1.5,
};

/** Dark smoke puff layered under the fireball for a bit of body. */
export const SMALL_EXPLOSION_SMOKE: ParticleStyle = {
  color: "#4a4038",
  shape: "circle",
  size: 50,
  speed: 16,
  spread: Math.PI,
  life: 40,
  count: 8,
  sizeChange: 0.20,
};

/** Burning green embers flung out of an explosion, each dragging a yellow
 *  exhaust trail and shrinking as it burns out. Cosmetic only. */
export const SMALL_EXPLOSION_SHRAPNEL: ParticleStyle = {
  color: "#ffe14a",
  shape: "square",
  size: 12,
  speed: 25,
  spread: Math.PI, // full 360° burst
  life: 25,
  count: 5,
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

export const SMALL_EXPLOSION: readonly ParticleStyle[] = [
  SMALL_EXPLOSION_SMOKE,
  SMALL_EXPLOSION_BLAST,
  SMALL_EXPLOSION_SHRAPNEL,
];


const DRAG = 0.86; // per-tick velocity retention (particles slow as they fly)

/**
 * Emit a burst of particles at `pos` flying roughly along `dir` (already a unit
 * vector), spread into a cone. Pushes them into the supplied array.
 *
 * `heft` is how heavy the hit was: it multiplies both the size the debris comes
 * off at (and its shrink rate with it, so the timing is unchanged) and the speed
 * it comes off at, which is what carries the bigger pieces further. Lifetime is
 * NOT scaled — a heavier round throws further in the same handful of ticks.
 * 1 = the style as authored, 0 = emit nothing at all.
 */
export function spawnParticles(
  out: Particle[],
  pos: Vec2,
  dir: Vec2,
  style: ParticleStyle,
  z = 0,
  heft = 1,
): void {
  // Nothing to throw: a round with no visible tracer at all (a punch) leaves no
  // debris, rather than a burst of zero-size particles nobody can see.
  if (heft <= 0) return;
  const base = angleOf(dir);
  for (let i = 0; i < style.count; i++) {
    const ang = base + (Math.random() * 2 - 1) * style.spread;
    const speed = style.speed * (0.5 + Math.random() * 0.5) * heft;
    const life = style.life * (0.7 + Math.random() * 0.3);
    out.push({
      pos,
      vel: fromAngle(ang, speed),
      z,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() * 2 - 1) * 0.4,
      life,
      maxLife: life,
      // Both scale, so a bigger piece still burns out over the same lifetime
      // rather than outliving the burst it belongs to.
      size: style.size * heft,
      color: style.color,
      shape: style.shape,
      trail: style.trail,
      trailFade: style.trailFade,
      sizeChange: style.sizeChange === undefined ? undefined : style.sizeChange * heft,
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
      // afterimages; a `trailFade` parent gives that up, so its streak dims as it
      // thins, like ordinary debris. Pushed BEFORE the parent so the parent draws on top of its own
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
        noFade: !p.trailFade,
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
