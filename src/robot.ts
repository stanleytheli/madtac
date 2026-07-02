import { Character } from "./actor.ts";
import { Armor, ARMOR_L3, type ArmorSpec } from "./armor.ts";
import { BODY_RADIUS, type Skin } from "./character.ts";
import { hasLineOfSight } from "./collision.ts";
import { EnemyGun, Gun } from "./gun.ts";
import { M16, M9, UNARMED, type GunSpec } from "./guns.ts";
import { angleOf, deg2rad, fromAngle, sub, vec, type Vec2 } from "./vec.ts";
import type { World } from "./world.ts";

/** Flat gray placeholder enemy. */
export const ROBOT_SKIN: Skin = {
  head: "#9aa0a6",
  rightShoulder: "#5f6368",
  leftShoulder: "#5f6368",
  rightUpperarm: "#608dd0",
  leftUpperarm: "#9aa0a6",
  rightForearm: "#9aa0a6",
  leftForearm: "#9aa0a6",
  rightHand: "#5f6368",
  leftHand: "#5f6368",
  outline: "#000000",
};

/** Placeholder "elite" variant — darker, with a red tint. Tweak freely. */
export const ELITE_ROBOT_SKIN: Skin = {
  head: "#6b4a4a",
  rightShoulder: "#3a2a2a",
  leftShoulder: "#3a2a2a",

  rightUpperarm: "#6b4a4a",
  leftUpperarm: "#6b4a4a",
  rightForearm: "#6b4a4a",
  leftForearm: "#6b4a4a",

  rightHand: "#3a2a2a",
  leftHand: "#3a2a2a",
  outline: "#000000",
};

const TURN_GAIN = 0.05; // step grows with angular distance (spec: distance * 0.05)
const TURN_FLOOR_DEG = 2; // ...plus a 1-degree floor so it always closes the gap
const WANDER_MIN = 60; // ticks between idle random turns (~1s)
const WANDER_MAX = 180; // ...up to ~3s

/**
 * Rotate angle `a` toward angle `b` (both radians) the short way around, taking a
 * step that eases down as it closes (so it doesn't snap instantly to target).
 */
function turnToward(a: number, b: number): number {
  // Signed shortest delta in [-pi, pi]; its sign is sgn(sin(b - a)).
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const distDeg = Math.abs(delta) * (180 / Math.PI);
  const stepDeg = distDeg * TURN_GAIN + TURN_FLOOR_DEG;
  const step = deg2rad(stepDeg) * Math.sign(delta || 1);
  if (Math.abs(step) >= Math.abs(delta)) return b; // clamp: no overshoot / jitter
  return a + step;
}

/** Everything that varies between flavours of Robot. All optional with defaults. */
export interface RobotOptions {
  /** Starting & max health. */
  health?: number;
  /** Flat damage per shot. */
  damage?: number;
  /** Body skin (e.g. ROBOT_SKIN vs ELITE_ROBOT_SKIN). */
  skin?: Skin;
  /** Uniform fire spread, +/- degrees. */
  spreadDeg?: number;
  /** fire rate */
  delay? :number;
  /** Which gun it visibly holds (drives cosmetics; damage/spread/firerate are overridden). */
  gun?: GunSpec;
  /** The z level it stands on (e.g. 1 for a balcony guard, -1 in a bunker). */
  z?: number;
}

const ROBOT_DEFAULTS: Required<RobotOptions> = {
  health: 100,
  damage: 10,
  skin: ROBOT_SKIN,
  spreadDeg: 15,
  delay: 10,
  gun: M16,
  z: 0,
};

/**
 * A minimal hostile enemy: stands in place, sweeps its aim, and opens fire with a
 * sloppy spread the instant it can see any part of the player. It turns smoothly
 * (never instantly) toward whatever it's tracking. Parametrized so we can build
 * all kinds of robots (tanky/elite/different guns/etc.).
 */
export class Robot extends Character {
  private angle: number;
  private seenPlayer = false;
  private wanderTarget: number;
  private wanderTimer = 0;

  constructor(pos: Vec2, options: RobotOptions = {}) {
    const opts = { ...ROBOT_DEFAULTS, ...options };
    super(pos, opts.skin, {
      primary: new EnemyGun(opts.gun, { damage: opts.damage, spreadDeg: opts.spreadDeg, delay: opts.delay }),
      hand: new Gun(UNARMED),
    });
    this.maxHp = opts.health;
    this.hp = opts.health;
    this.z = opts.z;
    this.angle = Math.random() * Math.PI * 2;
    this.wanderTarget = this.angle;
    this.forward = fromAngle(this.angle);
  }

  /** Per-tick AI. Call after `tickWeapon()` so the fire cooldown is up to date. */
  think(world: World, player: Character): void {
    // Sight is per-level: a balcony guard ignores (and can't hit) a ground-level
    // player, and vice versa, until they share a z.
    const visible = this.z === player.z && this.canSee(world, player);

    if (visible) {
      // Track and shoot.
      this.seenPlayer = true;
      this.angle = turnToward(this.angle, angleOf(sub(player.pos, this.pos)));
    } else if (!this.seenPlayer) {
      // Never spotted the player: idly turn to a new random heading now and then.
      if (this.wanderTimer <= 0) {
        this.wanderTarget = Math.random() * Math.PI * 2;
        this.wanderTimer = WANDER_MIN + Math.floor(Math.random() * (WANDER_MAX - WANDER_MIN));
      }
      this.wanderTimer -= 1;
      this.angle = turnToward(this.angle, this.wanderTarget);
    }
    // else: has seen the player but lost sight -> hold angle, "on alert".

    this.forward = fromAngle(this.angle);

    if (visible) this.fire(world); // no-op while the gun is on cooldown
  }

  /** Sees the player if any ray to the player's bounding box (center + corners) is clear. */
  private canSee(world: World, player: Character): boolean {
    const r = BODY_RADIUS;
    const p = player.pos;
    const points: Vec2[] = [
      p,
      vec(p.x - r, p.y - r),
      vec(p.x + r, p.y - r),
      vec(p.x - r, p.y + r),
      vec(p.x + r, p.y + r),
    ];
    return points.some((pt) => hasLineOfSight(this.pos, pt, world.obstacles, this.z));
  }
}

// --- enemy flavours -----------------------------------------------------------
// The named enemy types levels can spawn. This is the single place a new unique
// enemy is registered: add an entry and it shows up in the level editor's
// palette and in level strings (keyed by the record key) automatically.

export interface EnemyTypeDef {
  /** Human-readable name (editor palette / inspector dropdown). */
  label: string;
  /** Robot construction options; the spawn's z overrides options.z. */
  options: RobotOptions;
  /** Armor worn from the start, if any. */
  armor?: ArmorSpec;
  /** Marker color in the level editor. */
  color: string;
}

export const ENEMY_TYPES: Record<string, EnemyTypeDef> = {
  grunt: { label: "Grunt (M16)", options: {}, color: "#c94f4f" },
  pistol: { label: "Grunt (M9)", options: { gun: M9 }, color: "#d9913d" },
  elite: {
    label: "Elite",
    options: { health: 200, damage: 10, spreadDeg: 10, skin: ELITE_ROBOT_SKIN, gun: M16, delay: 10 },
    armor: ARMOR_L3,
    color: "#8a4ad0",
  },
};

/** Instantiate a live Robot from a named enemy type at a position and level. */
export function spawnEnemy(type: string, pos: Vec2, z: number): Robot {
  const t = ENEMY_TYPES[type] ?? ENEMY_TYPES.grunt;
  const r = new Robot(pos, { ...t.options, z });
  if (t.armor) r.equipArmor(new Armor(t.armor));
  return r;
}
