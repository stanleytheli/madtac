import { drawCharacter, type Skin } from "./character.ts";
import { Gun } from "./gun.ts";
import type { GunSpec } from "./guns.ts";
import { add, len, scale, vec, type Vec2 } from "./vec.ts";
import type { World } from "./world.ts";

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
    // this.gun.resetRecoil();
    this.gun.resetDraw();
  }

  /**
   * Put `gun` into its natural slot (primary/secondary per its spec), equip it,
   * and return whatever was in that slot before (for the caller to drop), or null
   * if the slot was empty. The `hand` slot is never replaced this way.
   */
  holster(gun: Gun): Gun | null {
    const slot: SlotName = gun.spec.primary ? "primary" : "secondary";
    const prev = this.slots[slot];
    prev?.resetRecoil();
    prev?.cancelReload();
    this.slots[slot] = gun;
    // this.equipped = slot;
    gun.resetRecoil();
    gun.resetDraw();
    return prev;
  }

  /**
   * Drop the currently equipped weapon as its ground-version, empty that slot, and
   * fall back to fists. Returns the dropped gun for the caller to place in the
   * world, or null if nothing droppable is equipped (fists can't be dropped).
   */
  dropEquipped(): Gun | null {
    if (this.equipped === "hand") return null; // fists/melee aren't droppable
    const g = this.slots[this.equipped];
    if (!g) return null;
    g.cancelReload();
    this.slots[this.equipped] = null;
    this.equipped = "hand";
    this.gun.resetDraw(); // bringing the fists up takes its draw time
    return g.dropClone();
  }

  /** The droppable weapons this character carries: real guns in primary/secondary
   *  (never the fists in the hand slot), as their ground-version (see dropClone). */
  dropWeapons(): Gun[] {
    const out: Gun[] = [];
    for (const slot of ["primary", "secondary"] as const) {
      const g = this.slots[slot];
      if (g) out.push(g.dropClone());
    }
    return out;
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
    const speedRatio = this.speed / maxSpeedFor(gun.spec);
    return gun.fire(world, this.pos, this.forward, this, speedRatio);
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
