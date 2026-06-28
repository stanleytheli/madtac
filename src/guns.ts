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
}

/** Fraction of damage that passes through each armor tier (0..1). Armor lands later. */
export interface ArmorPen {
  l1: number;
  l2: number;
  l3: number;
}

export interface GunSpec {
  name: string;
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
  /** Firing behaviour. Omitted for weapons that can't shoot (e.g. unarmed). */
  fire?: FireSpec;

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

export const M16: GunSpec = {
  name: "m16",
  rightGrip: { f: 40, l: 0 },
  leftGrip: { f: 65, l: -6 },
  barrel: { start: 35, end: 110, width: 11 },
  color: "#26292e",
  damage: 11,
  armorPen: { l1: 0.9, l2: 0.7, l3: 0.5 },
  zoom: 2.2,
  speed: 0.8,
  fire: {
    delay: 7,
    bulletSpeed: 35,
    bulletLife: 70,
    auto: true,
    spread: 0.02,
    magSize: 30,
    reserveMags: 3,
    reloadTime: 150,
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

export const M9: GunSpec = {
  name: "m9",
  rightGrip: { f: 50, l: 0 },
  //leftGrip: { f: 55, l: -9 },
  //leftGrip: { f: 35, l: 20 },
  leftGrip: { f: 30, l: 10 },

  barrel: { start: 50, end: 100, width: 8 },
  color: "#33373d",
  damage: 16,
  armorPen: { l1: 0.7, l2: 0.45, l3: 0.2 },
  zoom: 1.5,
  speed: 0.9,
  fire: {
    delay: 6,
    bulletSpeed: 30,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 12,
    reserveMags: 4,
    reloadTime: 70,
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
  rightGrip: { f: 55, l: 0 },
  leftGrip: { f: 60, l: 0 },
  barrel: { start: 55, end: 110, width: 11 },
  color: "#7e858f",
  damage: 35,
  armorPen: { l1: 0.9, l2: 0.85, l3: 0.8 },
  zoom: 1.8,
  speed: 0.8,
  fire: {
    delay: 15,
    bulletSpeed: 35,
    bulletLife: 60,
    auto: false,
    spread: 0.01,
    magSize: 7,
    reserveMags: 3,
    reloadTime: 90,
  },
  visualRecoil: 17,
  recoilRecovery: 1,
  recoilCoef: 0.17,
  recoilGain: 15.0,
  recoilDelay: 40,
  movePenalty: 1.5,
  movingFirstShotRecoilMin: 35.0,
  movingFirstShotRecoilMax: 40.0,
};


/** Unarmed: hands rest out to the sides, no barrel. Shortest "range", fastest move. */
export const UNARMED: GunSpec = {
  name: "unarmed",
  rightGrip: { f: 55, l: 30 },
  leftGrip: { f: 60, l: -25 },
  color: "#000000", // no barrel, so unused
  damage: 8, // melee, for later
  armorPen: { l1: 0, l2: 0, l3: 0 },
  zoom: 1.8,
  speed: 1.0,
  visualRecoil: 0,
  recoilRecovery: 0,
  recoilCoef: 0,
  recoilGain: 0,
  recoilDelay: 1,
  movePenalty: 0,
  movingFirstShotRecoilMin: 0,
  movingFirstShotRecoilMax: 0,
};
