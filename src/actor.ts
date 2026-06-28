import { drawCharacter, type Skin } from "./character.ts";
import { Gun } from "./gun.ts";
import type { GunSpec } from "./guns.ts";
import { add, len, rotate, scale, vec, type Vec2 } from "./vec.ts";
import { spawnBullet, type World } from "./world.ts";

const SQRT1_2 = Math.SQRT1_2; // 1/sqrt(2), for diagonal movement normalization

// Movement tuning (per 60 Hz tick).
const ACCEL = 1.4; // velocity gained per tick at full input
const FRICTION = 0.82; // velocity retained per tick

/** Terminal speed of the accel/friction model, per the recoil spec's definition. */
const maxSpeedFor = (spec: GunSpec): number => (ACCEL * spec.speed) / (1 - FRICTION);

export type SlotName = "primary" | "secondary" | "hand";

export interface Loadout {
  primary?: Gun;
  secondary?: Gun;
  hand: Gun; // always present (fists / melee); the fallback slot
}

/**
 * A character in the world: position, movement, a 3-slot weapon loadout, and the
 * logic to fire/draw itself. The player and every NPC are instances of this.
 */
export class Character {
  pos: Vec2;
  vel: Vec2 = vec(0, 0);
  forward: Vec2 = vec(0, -1); // unit aim direction
  skin: Skin;

  maxHp = 100;
  hp = 100;

  readonly slots: Record<SlotName, Gun | null>;
  private equipped: SlotName;

  constructor(pos: Vec2, skin: Skin, loadout: Loadout) {
    this.pos = pos;
    this.skin = skin;
    this.slots = {
      primary: loadout.primary ?? null,
      secondary: loadout.secondary ?? null,
      hand: loadout.hand,
    };
    this.equipped = loadout.primary ? "primary" : "hand";
  }

  /** The currently held gun (never null: the hand slot is always filled). */
  get gun(): Gun {
    return this.slots[this.equipped] ?? this.slots.hand!;
  }

  /** Current movement speed (world px/tick). */
  get speed(): number {
    return len(this.vel);
  }

  /** Switch to a slot. No-op if that slot is empty; resets spray and cancels any reload. */
  equip(slot: SlotName): void {
    if (slot === this.equipped || this.slots[slot] === null) return;
    const old = this.slots[this.equipped];
    old?.resetRecoil();
    old?.cancelReload(); // switching weapons aborts a reload in progress
    this.equipped = slot;
    this.gun.resetRecoil();
  }

  /** Start reloading the equipped gun (no-op if full / no spare / already reloading). */
  reload(): void {
    this.gun.startReload();
  }

  /** Acceleration + friction movement. `axis` is raw -1/0/1 input per axis. */
  move(axis: Vec2, speedMul = 1): void {
    let ax = axis.x;
    let ay = axis.y;
    // Normalize diagonals so they aren't faster than cardinal movement.
    if (ax !== 0 && ay !== 0) {
      ax *= SQRT1_2;
      ay *= SQRT1_2;
    }
    const accel = ACCEL * speedMul;
    this.vel = add(this.vel, vec(ax * accel, ay * accel));
    this.vel = scale(this.vel, FRICTION);
    this.pos = add(this.pos, this.vel);
  }

  /** Per-tick recovery for the equipped gun (cooldown, flash, kick, spray reset). */
  tickWeapon(): void {
    this.gun.tick();
  }

  /**
   * Fire if the equipped weapon can. Returns true if a shot went out. The caller
   * decides *when* to attempt (held trigger for auto, click edge for semi).
   */
  fire(world: World): boolean {
    const gun = this.gun;
    if (!gun.canFire) return false;
    const spec = gun.spec;

    const speedRatio = this.speed / maxSpeedFor(spec);
    const offset = gun.shoot(speedRatio);

    // Project from the head center (not the muzzle) so shots can't originate past
    // objects/walls in front of the character.
    const dir = rotate(this.forward, offset);
    const f = spec.fire!;
    const muzzleLen = spec.barrel ? spec.barrel.end : 0;
    spawnBullet(world, this.pos, dir, f.bulletSpeed, f.bulletLife, muzzleLen + 50, this, gun.damage);
    return true;
  }

  /**
   * Take a hit from a bullet travelling in `dir` (unit) at world point `point`,
   * dealing `damage`. (Armor mitigation will hook in here later.) The world
   * spawns the blood particle for the impact.
   */
  registerHit(_dir: Vec2, _point: Vec2, damage: number): void {
    this.hp = Math.max(0, this.hp - damage);
  }

  _takeDamage(damage: number): void {
    this.hp = Math.max(0, this.hp - damage);
  }
  _heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /**
   * Draw the character: the gun supplies hand positions and renders itself; the
   * Character draws the body around the head and the hands on top of the gun.
   */
  draw(ctx: CanvasRenderingContext2D): void {
    const gun = this.gun;
    const { right, left } = gun.handPositions(this.pos, this.forward);
    drawCharacter(ctx, this.pos, this.forward, right, left, this.skin, () =>
      gun.draw(ctx, this.pos, this.forward, this.skin.outline),
    );
  }
}
