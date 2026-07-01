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
  /** Spare magazines carried (reserve is counted in whole mags, hardcore-style). */
  reserveMags: number;
  /** Ticks a full reload takes. */
  reloadTime: number;
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

/** Fraction of damage that passes through each armor tier (0..1). Indexed by the
 *  worn armor's level: l1..l4. Lower fraction = the armor stops more. */
export interface ArmorPen {
  l1: number;
  l2: number;
  l3: number;
  l4: number;
}

export interface GunSpec {
  name: string;
  primary: boolean;
  /** Icon asset basename in /assets (e.g. "m16" -> /assets/m16.png) for ground rendering. */
  icon?: string;
  rightGrip: GripLocal;
  leftGrip: GripLocal;
  /** Barrel drawn as a rounded bar from `barrel.start` to `barrel.end` along forward. */
  barrel?: { start: number; end: number; width: number };
  /** Gun body color. The gun renders itself, so this is not part of the character skin. */
  color: string;
  /** Damage dealt per bullet, before armor. */
  damage: number;
  /** Per-tier armor penetration. Stored now; consumed once armor exists. */
  armorPen: ArmorPen;
  /** Camera zoom while equipped. Higher = more vision; longer-range weapons see further. */
  zoom: number;
  /** Movement speed multiplier while equipped (CSGO-style: heavier guns are slower). */
  speed: number;
  /** Firing behaviour. Omitted for weapons that can't shoot at all. */
  fire?: FireSpec;
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
}

const DEFAULT_AP_MELEE = { l1: 0.80, l2: 0.70, l3: 0.60, l4: 0.40 }
const DEFAULT_AP_9MM =   { l1: 0.70, l2: 0.55, l3: 0.40, l4: 0.30 }
const DEFAULT_AP_556 =   { l1: 0.80, l2: 0.65, l3: 0.50, l4: 0.33 }
const DEFAULT_AP_762 =   { l1: 0.85, l2: 0.70, l3: 0.55, l4: 0.35 }
const DEFAULT_AP_50AE =  { l1: 0.95, l2: 0.75, l3: 0.60, l4: 0.37 }

export const M16: GunSpec = {
  name: "M-16",
  primary: true,
  icon: "m16",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },
  barrel: { start: 35, end: 110, width: 11 },
  color: "#26292e",
  damage: 20,
  armorPen: DEFAULT_AP_556,
  zoom: 2.2,
  speed: 0.8,
  fire: {
    delay: 7,
    bulletSpeed: 35,
    bulletLife: 70,
    auto: true,
    spread: 0.02,
    magSize: 30,
    reserveMags: 4,
    reloadTime: 150,
    drawTime: 40,
    tracerWidth: 3.5,
    tracerLength: 150,
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

export const AK47: GunSpec = {
  name: "AK-47",
  primary: true,
  icon: "ak47",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },
  barrel: { start: 35, end: 110, width: 11 },
  color: "#53360b",
  damage: 25,
  armorPen: DEFAULT_AP_762,
  zoom: 2.2,
  speed: 0.8,
  fire: {
    delay: 8,
    bulletSpeed: 35,
    bulletLife: 70,
    auto: true,
    spread: 0.025,
    magSize: 30,
    reserveMags: 3,
    reloadTime: 150,
    drawTime: 40,
    tracerWidth: 4.5,
    tracerLength: 160,
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


export const M9: GunSpec = {
  name: "M9",
  primary: false,
  icon: "m9",
  rightGrip: { f: 50, l: 0 },
  leftGrip: { f: 55, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  //leftGrip: { f: 30, l: 10 },

  barrel: { start: 50, end: 100, width: 8 },
  color: "#33373d",
  damage: 17,
  armorPen: DEFAULT_AP_9MM,
  zoom: 1.8,
  speed: 0.9,
  fire: {
    delay: 6,
    bulletSpeed: 30,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 15,
    reserveMags: 4,
    reloadTime: 70,
    drawTime: 30,
    tracerWidth: 3,
    tracerLength: 110,
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

export const Deagle: GunSpec = {
  name: "Desert Eagle",
  primary: false,
  icon: "deagle",
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: 0 },
  barrel: { start: 55, end: 110, width: 11 },
  color: "#7e858f",
  damage: 40,
  armorPen: DEFAULT_AP_50AE,
  zoom: 1.8,
  speed: 0.8,
  fire: {
    delay: 10,
    bulletSpeed: 35,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 7,
    reserveMags: 3,
    reloadTime: 90,
    drawTime: 40,
    tracerWidth: 5,
    tracerLength: 140,
    tracerColor: "#ffe26b"
  },
  visualRecoil: 17,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 15.0,
  recoilDelay: 30,
  movePenalty: 1.5,
  movingFirstShotRecoilMin: 35.0,
  movingFirstShotRecoilMax: 40.0,
};

export const Golden_Deagle: GunSpec = {
  name: "Golden DEagle",
  primary: false,
  icon: "golden_deagle",
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: 0 },
  barrel: { start: 55, end: 110, width: 11 },
  color: "#f0d313",
  damage: 50,
  armorPen: DEFAULT_AP_50AE,
  zoom: 2.0,
  speed: 0.75,
  fire: {
    delay: 13,
    bulletSpeed: 35,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 7,
    reserveMags: 3,
    reloadTime: 90,
    drawTime: 50,
    tracerWidth: 5,
    tracerLength: 140,
    tracerColor: "#ae9131", // gold
  },
  visualRecoil: 19,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 15.0,
  recoilDelay: 40,
  movePenalty: 1.5,
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
  rightGrip: { f: 50, l: 15 },
  leftGrip: { f: 70, l: -20 },
  color: "#000000", // no barrel, so unused
  damage: 20,
  armorPen: DEFAULT_AP_MELEE,
  zoom: 1.8,
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
