/**
 * A gun is defined in the player's local frame:
 *   - `f` (forward) = distance ahead of the head center, along the aim direction
 *   - `l` (lateral) = distance to the player's right (perpendicular to aim)
 *
 * The grips decide where the hands sit; everything else (arms, shoulders) is
 * solved from the hand positions. `rightGrip` is the trigger hand (player's
 * right side, l >= 0), `leftGrip` is the support hand (left side, l <= 0).
 *
 * A `GunSpec` is immutable data. The mutable, per-instance game object that
 * tracks recoil/cooldown/etc. is the `Gun` class (see gun.ts).
 */
import { STANDARD_EXPLOSION, SMALL_EXPLOSION, type ParticleStyle } from "../engine/particle.ts";

/** How fast you have to be moving for a sniper kill to count as a no-scope: this
 *  fraction of the fastest the shooter can actually move, ARMOR INCLUDED — see
 *  Character.speedFraction, not speedRatio, which measures against the gun alone
 *  and would quietly hold a Level V wearer (0.75x) to 67% of their own top speed
 *  while everyone else got 50%. Half speed is a walk you could have stopped out
 *  of: deliberate enough to be a choice, fast enough that it wasn't a planted shot. */
export const NOSCOPE_SPEED_RATIO = 0.5;
import type { SoundRef } from "../engine/audio.ts";

export interface GripLocal {
  f: number;
  l: number;
}

export interface FireSpec {
  /** Ticks between shots (60 ticks/s). Lower = faster fire rate. */
  delay: number;
  /** Bullet speed in world px per tick. */
  bulletSpeed: number;
  /** Bullet lifetime in ticks (range = bulletSpeed * bulletLife). */
  bulletLife: number;
  /** true = hold to fire (full auto); false = one shot per click (semi). */
  auto: boolean;
  /** Base random aim deviation in radians, +/-. */
  spread: number;
  /** Rounds per magazine. */
  magSize: number;
  /** Spare magazines carried (reserve is counted in whole mags, hardcore-style).
   *  On a `perBullet` gun this instead counts spare *rounds* (shotgun shells). */
  reserveMags: number;
  /**
   * Ticks a reload takes. For a normal gun this is one full mag swap; for a
   * `perBullet` gun it's one *cycle* — the time to chamber a single round — and
   * `reloadAnim` describes that one cycle too.
   */
  reloadTime: number;
  /**
   * Per-round reload (pump shotguns, etc.): each reload cycle chambers ONE round
   * (draining one from the `reserveMags` spare-round pool) and, while the mag
   * still isn't full and rounds remain, auto-starts the next cycle — so a single
   * reload tops the mag off round by round until full, dry, or cancelled.
   * Omitted/false = the normal whole-mag swap.
   */
  perBullet?: boolean;
  /** time since drawing weapon to being able to fire */
  drawTime: number;
  /** Tracer streak thickness in world px (cosmetic). */
  tracerWidth: number;
  /** Tracer streak length behind the bullet, in world px (cosmetic). */
  tracerLength: number;
  /** Tracer streak color, "#rrggbb" (cosmetic). The streak fades from transparent
   *  at the tail to this color at the bullet's tip. */
  tracerColor: string;
}

/**
 * Turns a gun into a launcher: instead of a hitscan-ish bullet, each shot spawns
 * an AoE projectile (see world.ts Projectile / spawnProjectile). The blast's
 * damage and armor penetration reuse the GunSpec's `damage`/`armorPen`; the
 * projectile's travel speed and range reuse the FireSpec's `bulletSpeed`/
 * `bulletLife` (so `feasibleRange = bulletSpeed * bulletLife` stays correct for
 * the AI with no override). This block adds only what's blast/round specific.
 */
export interface ProjectileSpec {
  /** Blast radius in world px (full damage at centre, linear falloff to 0 here). */
  radius: number;
  /** The round's own collision + draw radius (world px). */
  bodyRadius: number;
  /** Projectile body color "#rrggbb". Also the fallback body when no `sprite`
   *  is set (or its image hasn't decoded yet). */
  color: string;
  /** Exhaust-trail color "#rrggbb". */
  trailColor: string;
  /** Optional sprite basename in /assets (e.g. "rocket" -> /assets/rocket.png),
   *  drawn in place of the plain body disc, rotated to the round's heading. The
   *  art should point +x (nose to the right). */
  sprite?: string;
  /** Sprite native px -> world px, applied to both axes (aspect preserved). Only
   *  meaningful with `sprite` set; defaults to DEFAULT_PROJECTILE_SPRITE_SCALE. */
  spriteScale?: number;
  /** The particle bursts spawned at detonation (smoke / fireball / shrapnel / …).
   *  Omitted = the STANDARD_EXPLOSION preset. Give a launcher its own list here to
   *  make it detonate with a distinct look. */
  explosion?: readonly ParticleStyle[];
  /** Detonation sound in /audio (e.g. "Explosion_01.wav", or { file, volume }),
   *  played at the blast. Omitted = the explosion is silent. */
  explosionSound?: SoundRef;
}

/**
 * A weapon's stagger: a hit briefly slows the receiver's MOVEMENT (a stumble),
 * without touching their aim accuracy. For a bullet it lands on whoever is struck;
 * for a launcher it lands on everyone the blast damaged at all (any distance in the
 * radius, any sliver of visibility). Staggers don't stack — a fresh hit refreshes
 * the effect rather than compounding (see Character.applyStagger).
 */
export interface StaggerSpec {
  /** Movement multiplier while staggered (0..1; e.g. 0.4 = 40% move speed). */
  mul: number;
  /** How many ticks (60/s) the stagger lasts from the hit. */
  ticks: number;
}

/** Fraction of damage that passes through each armor tier (0..1). Indexed by the
 *  worn armor's level: l1..l4. Lower fraction = the armor stops more. */
export interface ArmorPen {
  l1: number;
  l2: number;
  l3: number;
  l4: number;
}

export interface HandsAnimation {
  rightPositions?: GripLocal[];
  leftPositions?: GripLocal[];
  leftTimes?: number[];
  rightTimes?: number[]
}

/**
 * Sample a keyframed hand track at elapsed time `t` (ticks). `times` is the
 * ascending keyframe schedule and `positions` the matching local grips; returns
 * the interpolated grip. Shared by gun reloads (see Gun.handPositions) and the
 * utility-use animation (see Character), so both read from the same `reloadAnim`
 * / `useAnim` shape. Clamps at both ends (holds the first/last pose off-range).
 */
export function interpGrip(positions: GripLocal[], times: number[], t: number): GripLocal {
  let idx = times.length - 1;
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) { idx = i; break; }
  }
  const span = times[idx] - times[idx - 1] || 1;
  const p = Math.max(0, Math.min(1, (t - times[idx - 1]) / span));
  const a = positions[idx - 1];
  const b = positions[idx];
  return { f: a.f + (b.f - a.f) * p, l: a.l + (b.l - a.l) * p };
}

export interface LinePart {
  p0: GripLocal,
  p1: GripLocal,
  color: string,
  width: number,
  over: boolean,
}

export interface GunSpec {
  name: string;
  primary: boolean;
  /** Icon asset basename in /assets (e.g. "m16" -> /assets/m16.png) for ground rendering. */
  icon?: string;
  /** Firing sound in /audio: a filename (e.g. "m16.wav") or { file, volume } to
   *  bake in a loudness multiplier. Omitted = the default gunshot. */
  fireSound?: SoundRef;
  /** Reload sound in /audio (filename or { file, volume }), played when a reload
   *  begins. Stretch the clip to `fire.reloadTime / 60` seconds so its final
   *  click lands on reload-complete. Omitted = silent reload. */
  reloadSound?: SoundRef;
  /** "Fire-cycle" sound in /audio (filename or { file, volume }), played on every
   *  shot alongside the gunshot — the bolt/pump action that cycles between shots
   *  on slow weapons. Stretched to `fire.delay / 60` seconds (the time until the
   *  next shot), with its LEADING silence preserved so the mechanical part lands
   *  the right beat after the bang. Omitted = no cycle sound. */
  cycleSound?: SoundRef;
  rightGrip: GripLocal;
  leftGrip: GripLocal;

  reloadAnim?: HandsAnimation;
  fireAnim?: HandsAnimation; 
  
  /**
   * Muzzle location in the holder's local frame (`f` forward, `l` lateral), like
   * a grip. Purely mechanical — it fixes where the muzzle flash spawns and (via
   * its distance from the head center) how far a bullet flies before it renders,
   * nothing visual. Fully decoupled from the *drawn* barrel, which is just another
   * entry in `parts`. Omitted = no muzzle (e.g. unarmed/melee).
   */
  muzzle?: GripLocal;

  /**
   * Rendered gun geometry: rounded bars in the holder's local frame (each
   * endpoint an `f`/`l` grip), drawn under (`over: false`) then over the pass.
   * The visible barrel carries no special status — it's simply one of these.
   */
  parts?: LinePart[];

  /** Damage dealt per bullet, before armor. */
  damage: number;
  /** Per-tier armor penetration. Stored now; consumed once armor exists. */
  armorPen: ArmorPen;
  /**
   * How much wall this round can punch through, in world px of geometry, at a
   * wall's face value (an obstacle's `thicknessMul` bends what a px costs). Spent
   * as a budget across everything one bullet crosses, and what's left of it decides
   * how much damage survives the trip — see penetrationOf / wallbangDamageMul.
   *
   * Calibrated against the standard 40px wall: pistol-caliber rounds clear a thin
   * 20px partition and stop at a real wall, rifles get through one, and the big
   * bolt guns get through one and a bit more. Omitted or 0 = no wallbang at all;
   * the round dies at the first thing it touches, exactly as it always has.
   */
  /** This weapon can earn the no-scope mark: a kill with it counts as a no-scope
   *  when the shot was taken at NOSCOPE_SPEED_RATIO or more of the shooter's top
   *  speed. Snipers only — landing one from a hip-fired SMG on the move is just
   *  called shooting. Cosmetic: it changes the kill feed, nothing else. */
  noscope?: boolean;
  penetration?: number;
  /** Camera zoom while equipped. Higher = more vision; longer-range weapons see further. */
  zoom: number;
  /** Under a level's sight mask (meta.visibility): the full angular width, in
   *  degrees, of the cone the player can see while aiming this. Outside it
   *  only a small grace circle around the player shows (see world/sight.ts).
   *  Omitted = all round. Narrower for weapons you look down. */
  visionCone?: number;
  /** Movement speed multiplier while equipped (CSGO-style: heavier guns are slower). */
  speed: number;

  /** Pellet count of shotgun */
  shotgunPellets?: number;
  /** Shotgun spread (stddev of normdist) in DEGREES */
  shotgunSpread?: number;

  /** Firing behaviour. */
  fire?: FireSpec;
  /** Present on launcher weapons: each shot is an AoE projectile, not a bullet. */
  projectile?: ProjectileSpec;
  /** Optional movement stagger applied to whoever this weapon hits — the struck
   *  body for a bullet, everyone the blast damaged for a launcher. Omitted = none. */
  stagger?: StaggerSpec;
  /**
   * What impact debris this weapon throws, in the same units as `fire.tracerWidth`
   * — see SHRAPNEL_TRACER_WIDTH, where 4 is an ordinary round's burst. Bullets
   * take their debris weight from the tracer, which is a fair stand-in for how
   * heavy the round looks; a melee weapon has no tracer, so it says so here.
   * Omitted = nothing thrown.
   */
  particleScale?: number;
  /**
   * Melee reach in px, centre to centre — so two bodies connect with
   * `meleeReach - 2 * BODY_RADIUS` px of clear air between them.
   */
  meleeReach?: number;
  /** Melee arc: the FULL apex angle in degrees, so 30 means 15 either side of
   *  the facing. A body whose centre is inside it, in reach and in plain sight,
   *  is struck (see meleeSwing). */
  meleeConeDeg?: number;
  /**
   * Melee weapon (fists, and knives/bats later). Modeled as a gun that fires a
   * very short-range, invisible bullet: it reuses the whole shooting/hit pipeline
   * but never drains ammo, never reloads, draws no tracer, and plays a punch
   * animation instead of a muzzle flash. (This is why fists aren't a special case —
   * a melee weapon is just a gun with a stubby invisible "bullet".)
   */
  melee?: boolean;

  // --- visual kick (gun + hands pushed back, recovers over time) ---
  /** How far (world px) the gun + hands kick back per shot. */
  visualRecoil: number;
  /** How much of that kick is recovered each tick (constant speed). */
  recoilRecovery: number;

  // --- recoil pattern (deterministic spray + accuracy penalties) ---
  /** Scales the deterministic spray pattern. Offset uses recoilCoef^2. */
  recoilCoef: number;
  /** How much `currentRecoil` grows per shot. */
  recoilGain: number;
  /** Ticks of not-firing (while equipped) before `currentRecoil` resets to 0. */
  recoilDelay: number;
  /** How strongly movement hurts accuracy & spray growth (0 = no penalty). */
  movePenalty: number;
  /**
   * First-shot-while-moving inaccuracy, expressed as a *recoil value* (same scale
   * as recoilGain/currentRecoil). On a fresh first shot (currentRecoil 0) the spray
   * pattern is computed as if currentRecoil were `(speed/maxSpeed) * random[min, max]`.
   * Stationary -> 0 (pinpoint). Lets pistols stay accurate on the move while snipers
   * become near-unusable.
   */
  movingFirstShotRecoilMin: number;
  movingFirstShotRecoilMax: number;

  /**
   * Make the AI fire *carefully* with this weapon (default off). A normal gun
   * looses the moment its muzzle is within a generous cone of the aim point and
   * only checks for a teammate on the line to the target — so it grazes wall
   * corners and sprays past friends now and then, which reads as human. On a
   * launcher that's a disaster (a rocket clipping a corner detonates on the
   * shooter; a blast lands beside a squadmate). With `careful`, the AI (see
   * TacOracle.shouldFire) holds fire until the muzzle is genuinely settled on the
   * aim point (a tight cone, same Gaussian aim error underneath — not a better
   * shot, just a committed one) AND an actual raycast along its true heading is
   * clear of walls and teammates out to the target.
   */
  careful?: boolean;
}

// const DEFAULT_AP_MELEE     = { l1: 0.80, l2: 0.70, l3: 0.60, l4: 0.40 }
// const DEFAULT_AP_12GA_BUCK = { l1: 0.60, l2: 0.50, l3: 0.40, l4: 0.28 }
// const DEFAULT_AP_9MM       = { l1: 0.70, l2: 0.55, l3: 0.40, l4: 0.30 }
// const DEFAULT_AP_45ACP     = { l1: 0.75, l2: 0.60, l3: 0.45, l4: 0.31 }
// const DEFAULT_AP_556       = { l1: 0.80, l2: 0.65, l3: 0.50, l4: 0.33 }
// const DEFAULT_AP_762       = { l1: 0.85, l2: 0.70, l3: 0.55, l4: 0.35 }
// const DEFAULT_AP_50AE      = { l1: 0.95, l2: 0.75, l3: 0.60, l4: 0.37 }

const DEFAULT_AP_XLOW =   { l1: 0.60, l2: 0.50, l3: 0.37, l4: 0.30, l5: 0.20 } // 16
const DEFAULT_AP_LOW =    { l1: 0.70, l2: 0.55, l3: 0.40, l4: 0.32, l5: 0.21 } // 17
const DEFAULT_AP_MLOW =   { l1: 0.75, l2: 0.60, l3: 0.45, l4: 0.36, l5: 0.22 } // 18
const DEFAULT_AP_MED =    { l1: 0.80, l2: 0.65, l3: 0.50, l4: 0.39, l5: 0.23 } // 20
const DEFAULT_AP_MHIGH =  { l1: 0.85, l2: 0.75, l3: 0.60, l4: 0.43, l5: 0.26 } // 22
const DEFAULT_AP_HIGH =   { l1: 0.90, l2: 0.80, l3: 0.65, l4: 0.47, l5: 0.28 } // 24
const DEFAULT_AP_XHIGH =  { l1: 0.93, l2: 0.85, l3: 0.75, l4: 0.50, l5: 0.31 } // 25



export const M16: GunSpec = {
  name: "M-16",
  primary: true,
  icon: "m16",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },
  //leftGrip: { f: 55, l: -12},

  fireSound: "Hk416_01.wav",
  reloadSound: "Hk416_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 65, l : -6}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 60
                    { f : 65, l : -6}, // 100
                    { f: 70, l: -12}, // 105
                    { f: 70, l: -12}, // 115
                    { f: 55, l: -12}, // 125
                    { f: 55, l: -12}, // 130
                    { f: 70, l: -12}, // 140
                    { f : 65, l : -6}, // 150
                    ],
    leftTimes: [0, 40, 60, 100, 105, 115, 125, 130, 140, 150]
  },


  muzzle: { f: 115, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 115, l: 0 }, width: 11, color: "#26292e", over: false },
  ],
  damage: 20,
  armorPen: DEFAULT_AP_MED,
  penetration: 23,
  zoom: 2.3,
  visionCone: 60,
  speed: 0.85,
  fire: {
    delay: 7,
    bulletSpeed: 90,
    bulletLife: 50,
    auto: true,
    spread: 0.02,
    magSize: 30,
    reserveMags: 4,
    reloadTime: 150,
    drawTime: 40,
    tracerWidth: 4.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 8,
  recoilRecovery: 2,
  recoilCoef: 0.12,
  recoilGain: 5.0,
  recoilDelay: 30,
  movePenalty: 3.0,
  movingFirstShotRecoilMin: 5.0,
  movingFirstShotRecoilMax: 8.0,
};

export const M4A1S: GunSpec = {
  name: "M4A1-S",
  primary: true,
  icon: "m4a1s",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 70, l: -6 },
  //leftGrip: { f: 55, l: -12},

  fireSound: "M4a1_01.wav",
  reloadSound: "Hk416_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 70, l : -6}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 60
                    { f : 65, l : -6}, // 100
                    { f: 70, l: -12}, // 105
                    { f: 70, l: -12}, // 115
                    { f: 55, l: -12}, // 125
                    { f: 55, l: -12}, // 130
                    { f: 70, l: -12}, // 140
                    { f : 70, l : -6}, // 150
                    ],
    leftTimes: [0, 40, 60, 100, 105, 115, 125, 130, 140, 150]
  },


  muzzle: { f: 145, l: 0 },
  parts: [
    { p0: { f: 100, l: 0 }, p1: { f: 115, l: 0 }, width: 5, color: "#12151a", over: false },
    { p0: { f: 35, l: 0 }, p1: { f: 105, l: 0 }, width: 11, color: "#26292e", over: false },
    { p0: { f: 110, l: 0 }, p1: { f: 145, l: 0 }, width: 11, color: "#12151a", over: false },

  ],
  damage: 23,
  armorPen: DEFAULT_AP_MED,
  penetration: 23,
  zoom: 2.3,
  visionCone: 60,
  speed: 0.85,
  fire: {
    delay: 8,
    bulletSpeed: 90,
    bulletLife: 50,
    auto: true,
    spread: 0.02,
    magSize: 25,
    reserveMags: 4,
    reloadTime: 150,
    drawTime: 50,
    tracerWidth: 4.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 8,
  recoilRecovery: 2,
  recoilCoef: 0.135,
  recoilGain: 5.0,
  recoilDelay: 30,
  movePenalty: 4.0,
  movingFirstShotRecoilMin: 5.0,
  movingFirstShotRecoilMax: 8.0,
};


export const AK47: GunSpec = {
  name: "AK-47",
  primary: true,
  icon: "ak47",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },

  fireSound: "Ak47_01.wav",
  reloadSound: "Ak47_reload_01.wav", // stretched to reloadTime (150t / 60 = 2.5s)

  reloadAnim: {
    leftPositions: [{ f : 65, l : -6}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 60
                    { f : 65, l : -6}, // 100
                    { f: 70, l: -12}, // 105
                    { f: 70, l: -12}, // 115
                    { f: 55, l: -12}, // 125
                    { f: 55, l: -12}, // 130
                    { f: 70, l: -12}, // 140
                    { f : 65, l : -6}, // 150
                    ],
    leftTimes: [0, 40, 60, 100, 105, 115, 125, 130, 140, 150]
  },

  muzzle: { f: 115, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 115, l: 0 }, width: 11, color: "#53360b", over: false },
  ],
  damage: 26,
  armorPen: DEFAULT_AP_MHIGH,
  penetration: 30,
  zoom: 2.3,
  visionCone: 60,
  speed: 0.85,
  fire: {
    delay: 8,
    bulletSpeed: 90,
    bulletLife: 50,
    auto: true,
    spread: 0.0225,
    magSize: 30,
    reserveMags: 3,
    reloadTime: 150,
    drawTime: 40,
    tracerWidth: 5.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 10,
  recoilRecovery: 2,
  recoilCoef: 0.15,
  recoilGain: 5.5,
  recoilDelay: 30,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 7.0,
  movingFirstShotRecoilMax: 8.0,
};

export const MP5: GunSpec = {
  name: "MP5",
  primary: true,
  icon: "mp5",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 70, l: -6 },
  //leftGrip: { f: 55, l: -12},

  fireSound: "Mp5_01.wav",
  reloadSound: "Mp5_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 70, l : -6}, // 0
                    { f : 20, l : -27}, // 20 // 30
                    { f : 20, l : -27}, // 35 // 45
                    { f : 65, l : -6}, // 55 // 75
                    { f: 70, l: -12}, // 65 // 80
                    { f: 70, l: -12}, // 75 // 90
                    { f: 55, l: -12}, // 85 // 100
                    { f: 55, l: -12}, // 90 // 105
                    { f: 70, l: -12}, // 100 // 115
                    { f : 70, l : -6}, // 120 // 120
                    ],
    leftTimes: [0, 20, 35, 55, 65, 75, 85, 90, 100, 120]
  },


  muzzle: { f: 105, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 105, l: 0 }, width: 9, color: "#242525", over: false },
  ],
  damage: 18,
  armorPen: DEFAULT_AP_LOW,
  penetration: 15,
  zoom: 2.1,
  visionCone: 90,
  speed: 0.90,
  fire: {
    delay: 6,
    bulletSpeed: 75,
    bulletLife: 35,
    auto: true,
    spread: 0.05,
    magSize: 30,
    reserveMags: 5,
    reloadTime: 120,
    drawTime: 30,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 6,
  recoilRecovery: 2,
  recoilCoef: 0.125,
  recoilGain: 4.0,
  recoilDelay: 25,
  movePenalty: 1.0,
  movingFirstShotRecoilMin: 0.0,
  movingFirstShotRecoilMax: 0.0,
};

export const SCAR17: GunSpec = {
  name: "SCAR-17",
  primary: true,
  icon: "scar",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 70, l: -6 },

  fireSound: "L86_01.wav",
  // "@scar17" = same raw clip as the AK47's, but fitted to THIS gun's
  // reloadTime (180t / 60 = 3.0s); fit_audio resolves the raw by the part
  // before the "@" and writes a separate output.
  reloadSound: "Ak47_reload_01@scar17.wav",

  reloadAnim: {
    leftPositions: [{ f : 70, l : -6}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 60
                    { f : 70, l : -6}, // 100 // 100
                    { f : 70, l : -6}, // 120 // 100
                    { f: 75, l: -12}, // 130 // 105
                    { f: 75, l: -12}, // 140 // 115
                    { f: 55, l: -12}, // 150 // 125
                    { f: 55, l: -12}, // 155 // 130 
                    { f: 75, l: -12}, // 165 // 140
                    { f : 70, l : -6}, // 180 // 150
                    ],
    leftTimes: [0, 40, 60, 100, 120, 130, 140, 150, 155, 165, 180]
  },

  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 120, l: 0 }, width: 11, color: "#cfb59e", over: false },
  ],
  damage: 34,
  armorPen: DEFAULT_AP_MHIGH,
  penetration: 30,
  zoom: 2.5,
  visionCone: 45,
  speed: 0.80,
  fire: {
    delay: 11,
    bulletSpeed: 90,
    bulletLife: 40,
    auto: false,
    spread: 0.005,
    magSize: 20,
    reserveMags: 3,
    reloadTime: 180,
    drawTime: 75,
    tracerWidth: 5.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 12,
  recoilRecovery: 1,
  recoilCoef: 0.22,
  recoilGain: 3.0,
  recoilDelay: 25,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 17.0,
  movingFirstShotRecoilMax: 28.0,
};


export const Scout: GunSpec = {
  noscope: true, // a sniper: kills on the move are no-scopes
  name: "Steyr Scout",
  primary: true,
  icon: "scout",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },

  fireSound: "Mosin_01.wav",
  // Shares the AWM's raw reload clip but fitted to this gun's reloadTime (175t).
  reloadSound: "Sv98_reload_01@scout.wav",
  cycleSound: "Blr_cycle_01.wav", // bolt cycle, fitted to fire.delay (80t / 60 = 1.33s)


  reloadAnim: {
    leftPositions: [{ f : 65, l : -6}, // 0
                    { f : 20, l : -27}, // 35
                    { f : 20, l : -27}, // 50
                    { f : 65, l : -6}, // 85
                    { f : 65, l : -6}, // 175
                    ],
    leftTimes: [0, 35, 50, 85, 175],

    rightPositions:  [{ f: 40, l: 0 }, // 0
                      { f: 40, l: 0 }, // 0 + 95
                      { f: 50, l: 15}, // 15 + 95
                      { f: 50, l: 8}, // 20 + ...
                      { f: 50, l: 8}, // 25 ...
                      { f: 40, l: 8}, // 35
                      { f: 40, l: 8}, // 40
                      { f: 50, l: 8}, // 50
                      { f: 50, l: 8}, // 55
                      { f: 50, l: 15}, // 60
                      { f: 50, l: 15}, // 65
                      { f: 40, l: 0}, // 80
                      ],
    rightTimes: [0, 95, 110, 115, 120, 130, 135, 145, 150, 155, 160, 175]
  },

  fireAnim: {
    rightPositions:  [{ f: 40, l: 0 }, // 0
                      { f: 50, l: 15}, // 15
                      { f: 50, l: 8}, // 20
                      { f: 50, l: 8}, // 25
                      { f: 40, l: 8}, // 35
                      { f: 40, l: 8}, // 40
                      { f: 50, l: 8}, // 50
                      { f: 50, l: 8}, // 55
                      { f: 50, l: 15}, // 60
                      { f: 50, l: 15}, // 65
                      { f: 40, l: 0}, // 80
                      ],
    rightTimes: [0, 15, 20, 25, 35, 40, 50, 55, 60, 65, 80]
  },

  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 30, l: 0 }, p1: { f: 120, l: 0 }, width: 9, color: "#877d6e", over: false },
  ],
  damage: 65,
  armorPen: DEFAULT_AP_MHIGH,
  penetration: 40,
  zoom: 2.7,
  visionCone: 30,
  speed: 0.75,
  stagger: { mul: 0.5, ticks: 30 },
  fire: {
    delay: 80,
    bulletSpeed: 90,
    bulletLife: 70,
    auto: false,
    spread: 0.005,
    magSize: 10,
    reserveMags: 3,
    reloadTime: 175,
    drawTime: 60,
    tracerWidth: 7.0,
    tracerLength: 400,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 16,
  recoilRecovery: 1,
  recoilCoef: 0.25,
  recoilGain: 5.5,
  recoilDelay: 80,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 20,
  movingFirstShotRecoilMax: 28,
};
export const AWM: GunSpec = {
  noscope: true, // a sniper: kills on the move are no-scopes
  name: "AWM",
  primary: true,
  icon: "awm",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 70, l: -6 },

  fireSound: "Barrett_01.wav",
  reloadSound: "Sv98_reload_01.wav",
  cycleSound: "Sv98_cycle_01.wav", // bolt cycle, fitted to fire.delay (90t / 60 = 1.5s)

  reloadAnim: {
    leftPositions: [{ f : 65, l : -6}, // 0
                    { f : 20, l : -27}, // 35
                    { f : 20, l : -27}, // 50
                    { f : 65, l : -6}, // 85
                    { f : 65, l : -6}, // 175
                    ],
    leftTimes: [0, 35, 50, 85, 175],

    rightPositions:  [{ f: 40, l: 0 }, // 0
                      { f: 40, l: 0 }, // 0 + 95
                      { f: 50, l: 15}, // 20 + 95
                      { f: 50, l: 8}, // 25 + ...
                      { f: 50, l: 8}, // 30
                      { f: 40, l: 8}, // 40
                      { f: 40, l: 8}, // 50
                      { f: 50, l: 8}, // 60
                      { f: 50, l: 8}, // 65
                      { f: 50, l: 15}, // 70
                      { f: 50, l: 15}, // 75
                      { f: 40, l: 0}, // 90
                      ],
    rightTimes: [0, 95, 115, 130, 125, 135, 145, 155, 160, 165, 170, 185]
  },

  fireAnim: {
    rightPositions:  [{ f: 40, l: 0 }, // 0
                      { f: 50, l: 15}, // 20
                      { f: 50, l: 8}, // 25
                      { f: 50, l: 8}, // 30
                      { f: 40, l: 8}, // 40
                      { f: 40, l: 8}, // 50
                      { f: 50, l: 8}, // 60
                      { f: 50, l: 8}, // 65
                      { f: 50, l: 15}, // 70
                      { f: 50, l: 15}, // 75
                      { f: 40, l: 0}, // 90
                      ],
    rightTimes: [0, 30, 35, 40, 50, 60, 70, 75, 80, 85, 100]
  },

  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 30, l: 0 }, p1: { f: 125, l: 0 }, width: 11, color: "rgb(73, 76, 67)", over: false },
  ],
  damage: 100,
  armorPen: DEFAULT_AP_HIGH,
  penetration: 50,
  zoom: 2.7,
  visionCone: 30,
  speed: 0.65,
  stagger: { mul: 0.5, ticks: 45 },
  fire: {
    delay: 100,
    bulletSpeed: 75,
    bulletLife: 70,
    auto: false,
    spread: 0.005,
    magSize: 5,
    reserveMags: 3,
    reloadTime: 185,
    drawTime: 70,
    tracerWidth: 9.0,
    tracerLength: 350,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 18,
  recoilRecovery: 1,
  recoilCoef: 0.275,
  recoilGain: 5.5,
  recoilDelay: 100,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 20,
  movingFirstShotRecoilMax: 28,
};


export const MP220: GunSpec = {
  name: "MP220",
  primary: true,
  icon: "mp220",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 70, l: -6 },

  fireSound: "Mp220_01.wav",
  reloadSound: "Mp220_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 70, l : -6}, // 0
                    { f : 20, l : -27}, // 25
                    { f : 20, l : -27}, // 35
                    { f : 55, l : -6}, // 60
                    { f : 60, l : -6}, // 65
                    { f : 55, l : -6}, // 70
                    { f : 55, l : -6}, // 80

                    { f : 20, l : -27}, // 105
                    { f : 20, l : -27}, // 115
                    { f : 55, l : 6}, // 140
                    { f : 60, l : 6}, // 145
                    { f : 70, l : -6}, // 150
                    ],
    leftTimes: [0, 25, 35, 60, 65, 70, 80, 105, 115, 140, 145, 150]
  },

  muzzle: { f: 110, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 90, l: 0 }, width: 11, color: "#53360b", over: false },
    { p0: { f: 60, l: 5 }, p1: { f: 120, l: 5 }, width: 6, color: "#393939", over: false },
    { p0: { f: 60, l: -5 }, p1: { f: 120, l: -5 }, width: 6, color: "#393939", over: false },

  ],
  damage: 10,
  armorPen: DEFAULT_AP_XLOW,
  penetration: 10,
  shotgunPellets: 9,
  shotgunSpread: 2.5,
  zoom: 1.9,
  visionCone: 105,
  speed: 0.925,
  fire: {
    delay: 10,
    bulletSpeed: 75,
    bulletLife: 15,
    auto: false,
    spread: 0.025,
    magSize: 2,
    reserveMags: 10,
    reloadTime: 150,
    drawTime: 40,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 14,
  recoilRecovery: 2,
  recoilCoef: 0.25,
  recoilGain: 1.0,
  recoilDelay: 3,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 19.0,
  movingFirstShotRecoilMax: 23.0,
};


/**
 * Pump-action shotgun with a tube magazine loaded one shell at a time (`perBullet`).
 * `reserveMags` here counts spare *shells*, and each reload cycle (`reloadTime` /
 * `reloadAnim`) stuffs a single shell, auto-cycling until the tube is full, dry,
 * or the player taps X to break off and fire. Buckshot spray via shotgunPellets /
 * shotgunSpread. Auto-registers in GUN_SPECS (has an icon), so it's editor-placeable.
 */
export const Mossberg500: GunSpec = {
  name: "Mossberg 500",
  primary: true,
  icon: "mossberg500",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 80, l: -11 },

  fireSound: "M870_01.wav",
  reloadSound: "M870_reload_01.wav",
  cycleSound: "M870_cycle_01.wav", // pump action, fitted to fire.delay (45t / 60 = 0.75s)

  // One cycle = load a single shell: support hand dips to the shell belt and back
  // up to the loading port, over the reloadTime below.
  reloadAnim: {
    leftPositions: [{ f: 80, l: -11 }, // 0  support
                    { f: 20, l: -27 }, // 10 grab a shell
                    { f: 45, l: -6 }, // 25 press it into the port
                    { f: 45, l: -6 }, // 30 seat it
                    { f: 80, l: -11 }, // 40 back to support
                    ],
    leftTimes: [0, 10, 25, 30, 40],
  },

  fireAnim: {
    leftPositions: [{ f: 80, l: -11 }, // 0 
                    { f: 80, l: -11 }, // 15
                    { f: 60, l: -11 }, // 25
                    { f: 60, l: -11 }, // 35
                    { f: 80, l: -11 }, // 45
                    ],
    leftTimes: [0, 15, 25, 35, 45],
  },

  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 55, l: -8 }, p1: { f: 100, l: -8}, width: 7, color: "#5a3a1c", over: false }, // pump/forend
    { p0: { f: 35, l: 0 }, p1: { f: 120, l: 0 }, width: 10, color: "#2b2b2b", over: false }, // barrel
  ],
  damage: 10,
  armorPen: DEFAULT_AP_XLOW,
  penetration: 10,
  shotgunPellets: 9,
  shotgunSpread: 2.25,
  zoom: 1.9,
  visionCone: 105,
  speed: 0.85,
  fire: {
    delay: 45, // pump action between shots
    bulletSpeed: 75,
    bulletLife: 15,
    auto: false,
    spread: 0.03,
    magSize: 6, // tube capacity
    reserveMags: 24, // spare *shells* (perBullet)
    reloadTime: 40, // ticks to chamber ONE shell
    perBullet: true,
    drawTime: 45,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b",
  },
  visualRecoil: 16,
  recoilRecovery: 2,
  recoilCoef: 0.22,
  recoilGain: 2.0,
  recoilDelay: 8,
  movePenalty: 3.5,
  movingFirstShotRecoilMin: 19.0,
  movingFirstShotRecoilMax: 23.0,
};

export const M249: GunSpec = {
  name: "M249",
  primary: true,
  icon: "m249_small",
  rightGrip: { f: 45, l: 0 },
  leftGrip: { f: 75, l: -6 },
  muzzle: { f: 125, l: 0 },

  fireSound: "Qbb97_01.wav",
  reloadSound: "M249_reload_01.wav",

  parts: [
    {p0: {f: 60, l: -20}, p1: {f: 60, l: 20}, width: 22, color: "#043309", over: false},
    { p0: { f: 30, l: 0 }, p1: { f: 125, l: 0 }, width: 14, color: "#1f1f1f", over: false },
  ],

  reloadAnim: {
    leftPositions: [
      { f: 75, l: -6 }, // 0 -- opening cover
      { f: 60, l: -6 }, // 15
      { f: 60, l: -10 }, // 25
      { f: 60, l: -10 }, // 35
      { f: 60, l: 10 }, // 55
      { f: 60, l: -10 }, // 75
      { f: 60, l: -10 }, // 85

      { f: 60, l: -20 }, // 95 -- new mag
      { f : 20, l : -27}, // 140
      { f : 20, l : -27}, // 190
      { f: 60, l: -20 }, // 235
      { f: 60, l: -10 }, // 245
      { f: 75, l: -6 }, // 265
      { f: 75, l: -6 }, // 360
      ],
    leftTimes: [0, 15, 25, 35, 55, 75, 85, 95, 140, 190, 235, 245, 265, 360],
    rightPositions: [
      { f: 45, l: 0 }, // 0 -- opening cover
      { f: 45, l: 0 }, // 265

      { f: 55, l: 10}, // 295
      { f: 40, l: 10}, // 305
      { f: 40, l: 10}, // 320
      { f: 55, l: 10}, // 330
      { f: 45, l: 0 }, // 360
      ],
    rightTimes: [0, 265, 295, 305, 320, 330, 360],
  },

  damage: 18,
  armorPen: DEFAULT_AP_MED,
  penetration: 26,
  zoom: 2.3,
  visionCone: 60,
  speed: 0.75,
  fire: {
    delay: 6,
    bulletSpeed: 90,
    bulletLife: 50,
    auto: true,
    spread: 0.04,
    magSize: 100,
    reserveMags: 1,
    reloadTime: 360,
    drawTime: 75,
    tracerWidth: 4.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 7,
  recoilRecovery: 1,
  recoilCoef: 0.125,
  recoilGain: 5.9,
  recoilDelay: 45,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 5.0,
  movingFirstShotRecoilMax: 10.0,
};

/**
 * Shoulder-fired rocket launcher: one heavy, slow-travelling round per shot that
 * detonates into a big blast on impact (see the `projectile` block + world.ts
 * explode). Single-shot mag, long draw, heavy move penalty. Full friendly fire —
 * fire it close and you'll catch yourself in the blast. `icon: "rpg"` (drop a
 * public/assets/rpg.png to give it a ground sprite; until then it shows the
 * generic pickup backdrop). In-hand it's drawn from `parts` — a launch tube with a
 * fat warhead. Auto-registers in GUN_SPECS, so it's placeable in the editor.
 */
export const RPG: GunSpec = {
  name: "RPG-7",
  primary: true,
  icon: "rpg_large",
  rightGrip: { f: 30, l: 35 },
  leftGrip: { f: 50, l: 5 },
  muzzle: { f: -60, l: 42 },

  fireSound: "Potato_smg_01.wav",
  reloadSound: "rpg_reload.wav",

  parts: [
    { p0: { f: -35, l: 37 }, p1: { f: 57, l: 17 }, width: 14, color: "#643116", over: false },
    { p0: { f: -38, l: 22 }, p1: { f: -32, l: 52 }, width: 5, color: "#181818", over: false },
    { p0: { f: 57, l: 17 }, p1: { f: 76, l: 13 }, width: 11, color: "#1a5313", over: false },
    { p0: { f: 76, l: 13 }, p1: { f: 90, l: 10 }, width: 16, color: "#1a5313", over: false },
    { p0: { f: 90, l: 10 }, p1: { f: 104, l: 7 }, width: 10, color: "#1a5313", over: false },
    { p0: { f: 104, l: 7 }, p1: { f: 114, l: 5 }, width: 6, color: "#1a5313", over: false },
  ],

  reloadAnim: {
    leftPositions: [{ f : 50, l : 5}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 60
                    { f : 90, l : 10}, // 110
                    { f : 90, l : 10}, // 130
                    { f : 50, l : 5}, // 150
    ],
    leftTimes: [0, 40, 60, 110, 130, 150]
  },

  damage: 110,
  armorPen: DEFAULT_AP_XHIGH,
  penetration: 0, // unused: launchers spawn a projectile, not a bullet
  zoom: 2.3,
  visionCone: 60,
  speed: 0.65,
  careful: true, // AI won't loose a rocket into a corner or a squadmate
  stagger: { mul: 0.5, ticks: 60 }, // the blast rattles anyone it catches
  fire: {
    delay: 0,
    bulletSpeed: 30, // projectile travel speed (px/tick)
    bulletLife: 70, // range/fuse ~1680 px
    auto: false,
    spread: 0.025,
    magSize: 1,
    reserveMags: 5,
    reloadTime: 150,
    drawTime: 60,
    tracerWidth: 0, // unused: launchers spawn a projectile, not a tracer bullet
    tracerLength: 0,
    tracerColor: "#000000",
  },
  projectile: {
    radius: 250,
    bodyRadius: 9,
    color: "#d6d6d6",
    trailColor: "#ffb454",
    sprite: "rocket",
    spriteScale: 1.0, // 115px art -> ~58px long in world
    explosion: STANDARD_EXPLOSION,
    explosionSound: "Explosion_01.wav",
  },
  visualRecoil: 14,
  recoilRecovery: 1,
  recoilCoef: 0.25,
  recoilGain: 4,
  recoilDelay: 60,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 32.0,
  movingFirstShotRecoilMax: 48.0,
};

export const M79: GunSpec = {
  name: "M79 Thumper",
  primary: false,
  icon: "m79",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -8 },

  fireSound: "Potato_cannon_01.wav",
  reloadSound: "Flare_gun_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 65, l : -8}, // 0
                    { f : 20, l : -27}, // 40
                    { f : 20, l : -27}, // 70
                    { f : 55, l : 0}, // 110
                    { f : 55, l : 0}, // 125
                    { f : 65, l : 0}, // 135
                    { f : 65, l : 0}, // 140
                    { f : 65, l : -8}, // 155
                    ],
    leftTimes: [0, 40, 70, 110, 125, 135, 140, 155]
  },


  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 35, l: 0 }, p1: { f: 100, l: 0 }, width: 9, color: "#5a340e", over: false },
    { p0: { f: 60, l: 0 }, p1: { f: 120, l: 0 }, width: 15, color: "#373636", over: false },
  ],

  damage: 75,
  armorPen: DEFAULT_AP_HIGH,
  penetration: 0, // unused: launchers spawn a projectile, not a bullet
  zoom: 2.1,
  visionCone: 75,
  speed: 0.80,
  careful: true, // AI won't loose a rocket into a corner or a squadmate
  stagger: { mul: 0.5, ticks: 45 }, // a lighter jolt than the RPG
  fire: {
    delay: 0,
    bulletSpeed: 25, // projectile travel speed (px/tick)
    bulletLife: 55, // range/fuse
    auto: false,
    spread: 0.025,
    magSize: 1,
    reserveMags: 6,
    reloadTime: 155,
    drawTime: 60,
    tracerWidth: 0, // unused: launchers spawn a projectile, not a tracer bullet
    tracerLength: 0,
    tracerColor: "#000000",
  },
  projectile: {
    radius: 200,
    bodyRadius: 7,
    color: "#d6d6d6",
    trailColor: "#ffb454",
    sprite: "m79_grenade",
    spriteScale: 1.0, // 115px art -> ~58px long in world
    explosion: SMALL_EXPLOSION,
    explosionSound: "Explosion_03.wav",
  },
  visualRecoil: 10,
  recoilRecovery: 1,
  recoilCoef: 0.25,
  recoilGain: 4,
  recoilDelay: 60,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 32.0,
  movingFirstShotRecoilMax: 48.0,
};


export const Golden_M249: GunSpec = {
  name: "Golden M249",
  primary: true,
  icon: "golden_m249",
  rightGrip: { f: 45, l: 0 },
  leftGrip: { f: 75, l: -6 },
  muzzle: { f: 125, l: 0 },

  fireSound: "Qbb97_01.wav",
  reloadSound: "M249_reload_01.wav",

  parts: [
    {p0: {f: 60, l: -20}, p1: {f: 60, l: 20}, width: 22, color: "#330404", over: false},
    { p0: { f: 30, l: 0 }, p1: { f: 125, l: 0 }, width: 14, color: "#8d8213", over: false },
  ],

  reloadAnim: {
    leftPositions: [
      { f: 75, l: -6 }, // 0 -- opening cover
      { f: 60, l: -6 }, // 15
      { f: 60, l: -10 }, // 25
      { f: 60, l: -10 }, // 35
      { f: 60, l: 10 }, // 55
      { f: 60, l: -10 }, // 75
      { f: 60, l: -10 }, // 85

      { f: 60, l: -20 }, // 95 -- new mag
      { f : 20, l : -27}, // 140
      { f : 20, l : -27}, // 190
      { f: 60, l: -20 }, // 235
      { f: 60, l: -10 }, // 245
      { f: 75, l: -6 }, // 265
      { f: 75, l: -6 }, // 360
      ],
    leftTimes: [0, 15, 25, 35, 55, 75, 85, 95, 140, 190, 235, 245, 265, 360],
    rightPositions: [
      { f: 45, l: 0 }, // 0 -- opening cover
      { f: 45, l: 0 }, // 265

      { f: 55, l: 10}, // 295
      { f: 40, l: 10}, // 305
      { f: 40, l: 10}, // 320
      { f: 55, l: 10}, // 330
      { f: 45, l: 0 }, // 360
      ],
    rightTimes: [0, 265, 295, 305, 320, 330, 360],
  },

  shotgunPellets: 2,
  shotgunSpread: 1.25,

  damage: 15,
  armorPen: DEFAULT_AP_MED,
  penetration: 23,
  zoom: 2.3,
  visionCone: 60,
  speed: 0.75,
  fire: {
    delay: 8,
    bulletSpeed: 90,
    bulletLife: 70,
    auto: true,
    spread: 0.04,
    magSize: 100,
    reserveMags: 1,
    reloadTime: 360,
    drawTime: 75,
    tracerWidth: 4.0,
    tracerLength: 300,
    tracerColor: "#ae9131"
  },
  visualRecoil: 7,
  recoilRecovery: 1,
  recoilCoef: 0.125,
  recoilGain: 5.9,
  recoilDelay: 45,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 5.0,
  movingFirstShotRecoilMax: 10.0,
};


export const M9: GunSpec = {
  name: "M9",
  primary: false,
  icon: "m9",
  rightGrip: { f: 50, l: 0 },
  leftGrip: { f: 55, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  //leftGrip: { f: 30, l: 10 },

  fireSound: "M9_01.wav",
  reloadSound: "M9_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 55, l : -9}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 25
                    { f : 55, l : -9}, // 40
                    { f: 70, l: -12}, // 45
                    { f: 45, l: -12}, // 55
                    { f: 70, l: -12}, // 65
                    { f : 55, l : -9}, // 70
                    ],
    leftTimes: [0, 15, 25, 40, 45, 55, 65, 70]
  },

  muzzle: { f: 100, l: 0 },
  parts: [
    { p0: { f: 50, l: 0 }, p1: { f: 100, l: 0 }, width: 8, color: "#33373d", over: false },
  ],
  damage: 17,
  armorPen: DEFAULT_AP_LOW,
  penetration: 15,
  zoom: 1.9,
  visionCone: 105,
  speed: 0.925,
  fire: {
    delay: 8,
    bulletSpeed: 75,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 15,
    reserveMags: 4,
    reloadTime: 70,
    drawTime: 30,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 12,
  recoilRecovery: 3,
  recoilCoef: 0.10,
  recoilGain: 9.0,
  recoilDelay: 20,
  movePenalty: 1.0,
  movingFirstShotRecoilMin: 0.0,
  movingFirstShotRecoilMax: 0.0,
};

export const Skorpion: GunSpec = {
  name: "Skorpion",
  primary: false,
  icon: "skorpion_1",
  rightGrip: { f: 50, l: 0 },
  leftGrip: { f: 75, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  //leftGrip: { f: 30, l: 10 },
  fireSound: "Glock_01.wav",
  reloadSound: "Mp5_reload_01.wav",


  reloadAnim: {
    leftPositions: [{ f : 75, l : -9}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 30
                    { f : 55, l : -9}, // 45
                    { f: 70, l: -12}, // 55
                    { f: 45, l: -12}, // 65
                    { f: 45, l: -12}, // 70
                    { f: 70, l: -12}, // 80
                    { f: 75, l: -9}, // 90
                    ],
    leftTimes: [0, 15, 30, 45, 55, 65, 70, 80, 90]
  },

  muzzle: { f: 105, l: 0 },
  parts: [
    { p0: { f: 50, l: 0 }, p1: { f: 105, l: 0 }, width: 8, color: "#464a51", over: false },
  ],
  damage: 20,
  armorPen: DEFAULT_AP_LOW,
  penetration: 15,
  zoom: 1.9,
  visionCone: 90,
  speed: 0.925,
  fire: {
    delay: 7,
    bulletSpeed: 75,
    bulletLife: 60,
    auto: true,
    spread: 0.10,
    magSize: 20,
    reserveMags: 4,
    reloadTime: 90,
    drawTime: 45,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 10,
  recoilRecovery: 2,
  recoilCoef: 0.12,
  recoilGain: 8.0,
  recoilDelay: 30,
  movePenalty: 1.0,
  movingFirstShotRecoilMin: 0.0,
  movingFirstShotRecoilMax: 0.0,
};

export const Uzi: GunSpec = {
  name: "Uzi",
  primary: false,
  icon: "uzi",
  rightGrip: { f: 50, l: 0 },
  leftGrip: { f: 75, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  //leftGrip: { f: 30, l: 10 },
  fireSound: "Mp5_01.wav",
  reloadSound: "Mp5_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 75, l : -9}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 30
                    { f : 55, l : -9}, // 45
                    { f: 70, l: -12}, // 55
                    { f: 45, l: -12}, // 65
                    { f: 45, l: -12}, // 70
                    { f: 70, l: -12}, // 80
                    { f: 75, l: -9}, // 90
                    ],
    leftTimes: [0, 15, 30, 45, 55, 65, 70, 80, 90]
  },

  muzzle: { f: 110, l: 0 },
  parts: [
    { p0: { f: 50, l: 0 }, p1: { f: 110, l: 0 }, width: 8, color: "#000000", over: false },
  ],
  damage: 17,
  armorPen: DEFAULT_AP_LOW,
  penetration: 15,
  zoom: 1.9,
  visionCone: 90,
  speed: 0.925,
  fire: {
    delay: 7,
    bulletSpeed: 75,
    bulletLife: 60,
    auto: true,
    spread: 0.08,
    magSize: 20,
    reserveMags: 4,
    reloadTime: 90,
    drawTime: 45,
    tracerWidth: 3.0,
    tracerLength: 200,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 8,
  recoilRecovery: 2,
  recoilCoef: 0.10,
  recoilGain: 5.0,
  recoilDelay: 30,
  movePenalty: 1.0,
  movingFirstShotRecoilMin: 0.0,
  movingFirstShotRecoilMax: 0.0,
};

export const Colt44: GunSpec = {
  name: "Colt .44",
  primary: false,
  icon: "colt",
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: -5 },
  fireSound: "Sw500_01.wav",
  reloadSound: "Mosin_reload_01.wav",

  // One cycle = load a single shell: support hand dips to the shell belt and back
  // up to the loading port, over the reloadTime below.
  reloadAnim: {
    leftPositions: [{ f: 60, l: -5 }, // 0  support
                    { f: 20, l: -27 }, // 15 grab a shell
                    { f: 20, l: -27 }, // 20
                    { f: 55, l: -10 }, // 35
                    { f: 70, l: -10 }, // 40 
                      { f: 60, l: -5 }, // 45
                    ],
    leftTimes: [0, 14, 20, 35, 40, 45],
  },

  muzzle: { f: 120, l: 0 },
  parts: [
    { p0: { f: 55, l: 0 }, p1: { f: 120, l: 0 }, width: 9, color: "#9d9d9d", over: false },
  ],
  damage: 30,
  armorPen: DEFAULT_AP_HIGH,
  penetration: 30,
  zoom: 2.3,
  visionCone: 75,
  speed: 0.85,
  fire: {
    delay: 20,
    bulletSpeed: 105,
    bulletLife: 60,
    auto: false,
    spread: 0.005,
    magSize: 6,
    reserveMags: 24,
    perBullet: true,
    reloadTime: 45,
    drawTime: 30,
    tracerWidth: 5.0,
    tracerLength: 250,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 13,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 12.0,
  recoilDelay: 35,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 35.0,
  movingFirstShotRecoilMax: 40.0,
};

export const USPS: GunSpec = {
  name: "USP-S",
  primary: false,
  icon: "usps",
  rightGrip: { f: 50, l: 0 },
  leftGrip: { f: 55, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  //leftGrip: { f: 30, l: 10 },
  fireSound: "Ots38_01.wav",
  reloadSound: "Mp5_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 60, l : 0}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 30
                    { f : 55, l : -9}, // 45
                    { f: 70, l: -12}, // 55
                    { f: 45, l: -12}, // 65
                    { f: 45, l: -12}, // 70
                    { f: 70, l: -12}, // 80
                    { f: 60, l: 0}, // 90
                    ],
    leftTimes: [0, 15, 30, 45, 55, 65, 70, 80, 90]
  },

  muzzle: { f: 135, l: 0 },

  parts: [
    {p0: {f: 50, l: 0}, p1: {f: 90, l: 0}, width: 8, color: "#000000", over: false},
    {p0: {f: 85, l: 0}, p1: {f: 100, l: 0}, width: 4, color: "#000000", over: false},
    { p0: { f: 95, l: 0 }, p1: { f: 135, l: 0 }, width: 8, color: "#000000", over: false },
  ],

  damage: 22,
  armorPen: DEFAULT_AP_MLOW,
  penetration: 23,
  zoom: 2.1,
  visionCone: 90,
  speed: 0.925,
  fire: {
    delay: 8,
    bulletSpeed: 75,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 12,
    reserveMags: 4,
    reloadTime: 90,
    drawTime: 45,
    tracerWidth: 4.0,
    tracerLength: 250,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 12,
  recoilRecovery: 3,
  recoilCoef: 0.115,
  recoilGain: 11.5,
  recoilDelay: 30,
  movePenalty: 1.5,
  movingFirstShotRecoilMin: 0.0,
  movingFirstShotRecoilMax: 0.0,
};


export const Deagle: GunSpec = {
  name: "Desert Eagle",
  primary: false,
  icon: "deagle",
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: 0 },
  fireSound: "Svd_01.wav",
  reloadSound: "Deagle_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 60, l : 0}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 30
                    { f : 55, l : -9}, // 45
                    { f: 70, l: -12}, // 55
                    { f: 45, l: -12}, // 65
                    { f: 45, l: -12}, // 70
                    { f: 70, l: -12}, // 80
                    { f: 60, l: 0}, // 90
                    ],
    leftTimes: [0, 15, 30, 45, 55, 65, 70, 80, 90]
  },

  muzzle: { f: 110, l: 0 },
  parts: [
    { p0: { f: 55, l: 0 }, p1: { f: 110, l: 0 }, width: 11, color: "#7e858f", over: false },
  ],
  damage: 40,
  armorPen: DEFAULT_AP_HIGH,
  penetration: 35,
  zoom: 2.1,
  visionCone: 60,
  speed: 0.85,
  fire: {
    delay: 15,
    bulletSpeed: 90,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 7,
    reserveMags: 3,
    reloadTime: 90,
    drawTime: 40,
    tracerWidth: 5.0,
    tracerLength: 300,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 17,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 15.0,
  recoilDelay: 30,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 35.0,
  movingFirstShotRecoilMax: 40.0,
};

export const Golden_Deagle: GunSpec = {
  name: "Golden DEagle",
  primary: false,
  icon: "golden_deagle",
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: 0 },
  fireSound: "Svd_01.wav",
  reloadSound: "Deagle_reload_01.wav",

  reloadAnim: {
    leftPositions: [{ f : 60, l : 0}, // 0
                    { f : 20, l : -27}, // 15
                    { f : 20, l : -27}, // 30
                    { f : 55, l : -9}, // 45
                    { f: 70, l: -12}, // 55
                    { f: 45, l: -12}, // 65
                    { f: 45, l: -12}, // 70
                    { f: 70, l: -12}, // 80
                    { f: 60, l: 0}, // 90
                    ],
    leftTimes: [0, 15, 30, 45, 55, 65, 70, 80, 90]
  },

  muzzle: { f: 110, l: 0 },
  parts: [
    { p0: { f: 55, l: 0 }, p1: { f: 110, l: 0 }, width: 11, color: "#f0d313", over: false },
  ],
  damage: 50,
  armorPen: DEFAULT_AP_HIGH,
  penetration: 35,
  zoom: 2.2,
  visionCone: 60,
  speed: 0.8,
  fire: {
    delay: 15,
    bulletSpeed: 90,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 7,
    reserveMags: 3,
    reloadTime: 90,
    drawTime: 50,
    tracerWidth: 5.0,
    tracerLength: 300,
    tracerColor: "#ae9131", // gold
  },
  visualRecoil: 19,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 15.0,
  recoilDelay: 40,
  movePenalty: 2.0,
  movingFirstShotRecoilMin: 35.0,
  movingFirstShotRecoilMax: 40.0,
};


/**
 * Unarmed fists: hands rest out to the sides, no barrel. A melee weapon — each
 * "shot" is a short, invisible bullet (the punch's reach) that deals contact
 * damage. Never drains ammo / reloads; the punch animation lives in the Gun.
 */
export const UNARMED: GunSpec = {
  name: "unarmed",
  primary: false,
  melee: true,

  fireSound: "Punch_swing_01.wav",

  // Reach matches what the old invisible bullet actually achieved: it moved
  // bulletSpeed px a tick for (bulletLife - 1) ticks and connected within
  // BODY_RADIUS of a centre, i.e. 23*5 + 30. Kept so this is a change of
  // mechanism, not of balance.
  meleeReach: 145,
  meleeConeDeg: 60, // 30 degrees either side of the facing
  particleScale: 4, // an ordinary round's worth of debris (SHRAPNEL_TRACER_WIDTH)
  rightGrip: { f: 50, l: 15 },
  leftGrip: { f: 70, l: -20 },
  damage: 20,
  armorPen: DEFAULT_AP_MHIGH,
  penetration: 0, // a fist punches nobody through a wall
  zoom: 1.9,
  visionCone: 120,
  speed: 1.0,
  fire: {
    delay: 16, // punch cadence (ticks between hits)
    bulletSpeed: 23, // with bulletLife -> ~90px of effective punch reach
    bulletLife: 6,
    auto: false, // click to punch
    spread: 0,
    magSize: 1, // unused: melee never drains
    reserveMags: 0,
    reloadTime: 0,
    drawTime: 0, // quick to bring the fists up
    tracerWidth: 0, // invisible (the punch isn't a visible projectile)
    tracerLength: 0,
    tracerColor: "#000000", // unused: never rendered
  },
  visualRecoil: 0,
  recoilRecovery: 0,
  recoilCoef: 0,
  recoilGain: 0,
  recoilDelay: 1,
  movePenalty: 0,
  movingFirstShotRecoilMin: 0,
  movingFirstShotRecoilMax: 0,
};
