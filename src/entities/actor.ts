import type { Armor } from "./armor.ts";
import type { TeamId } from "./team.ts";
import { drawCharacter, type Skin } from "./character.ts";
import { UtilityStack, type UtilitySpec } from "./consumable.ts";
import { Gun } from "./gun.ts";
import { interpGrip, type ArmorPen, type GripLocal, type GunSpec } from "./guns.ts";
import { gunIcon, utilityIcon } from "./item.ts";
import { add, angleOf, deg2rad, len, mid, perp, scale, scaleAlong, sub, vec, type Vec2 } from "../engine/vec.ts";
import { playSound } from "../engine/audio.ts";
import type { Hittable, World } from "../world/world.ts";
import type { Vehicle } from "./vehicle.ts";

const SQRT1_2 = Math.SQRT1_2; // 1/sqrt(2), for diagonal movement normalization

// A holstered primary is drawn slung across the back, behind the body.
const SLUNG_SCALE = 0.5; // icon scale (matches the ground-item icon size)
const SLUNG_ANGLE_DEG = 100; // rotation off the aim direction (diagonal across the back)
const SLUNG_BACK_OFFSET = 40; // world px shifted opposite the aim, so it peeks out behind

// Movement tuning (per 60 Hz tick).
const ACCEL = 1.5; // velocity gained per tick at full input
const FRICTION = 0.80; // velocity retained per tick
/** On a staircase, the velocity component along the climb axis is scaled by this
 *  each tick — climbing is slower than flat ground (see Character.applyStairMove).
 *  1/sqrt2. */
const STAIR_CLIMB_MUL = 0.9;

/** Terminal speed of the accel/friction model, per the recoil spec's definition. */
const maxSpeedFor = (spec: GunSpec): number => (ACCEL * spec.speed) / (1 - FRICTION);

export type SlotName = "primary" | "secondary" | "hand";
/** What can be held: a weapon slot, or the utility belt (slot 4). */
export type EquipSlot = SlotName | "utility";

/** Multiplier on move speed while a utility use is in progress (like reloading,
 *  but heavier — you're patching yourself up). Applied by the session (game.ts). */
export const USE_SPEED_MUL = 0.6;

/** Longest-side size (world px) of a utility icon held in hand. Separate from the
 *  ground-item size so held items can read bigger — tune here. */
const UTILITY_HELD_SIZE = 50;

export interface Loadout {
  primary?: Gun;
  secondary?: Gun;
  hand: Gun; // always present (fists / melee); the fallback slot
  /** Belt/slot-4 consumables the character spawns holding (copied on spawn). */
  utilities?: UtilityStack[];
}

/**
 * A character in the world: position, movement, a 3-slot weapon loadout, and the
 * logic to fire/draw itself. The player and every NPC are instances of this.
 */
export class Character {
  pos: Vec2;
  vel: Vec2 = vec(0, 0);
  forward: Vec2 = vec(0, -1); // unit aim direction
  /** Vertical level (integer). Changes sharply when crossing a staircase's
   *  midpoint; gates rendering, collision, bullets, and line of sight. */
  z = 0;
  /** When standing on a staircase, the unit direction of its climb axis (set by
   *  the session each tick before move()); null on flat ground. move() shrinks the
   *  velocity component along it (climbing is slower), and the recoil `speed`
   *  getter undoes that scaling so accuracy reflects the intended movement. */
  onStairs: Vec2 | null = null;
  skin: Skin;
  /** Team allegiance (see team.ts). AI picks targets by team hostility; the
   *  player's character is on "player", spawned NPCs get theirs from the spawn. */
  team: TeamId = "player";

  maxHp = 100;
  hp = 100;

  /** Travel direction (unit) of the most recent bullet to hit this character; the
   *  body launches this way on death. Null if never hit (e.g. test damage). */
  lastHitDir: Vec2 | null = null;

  /** Whoever fired the most recent bullet to hit this character (for kill
   *  attribution — see gamemodes/tdm.ts K/D). Null if never shot. */
  lastAttacker: Hittable | null = null;

  /** The gun spec behind the most recent damaging hit — read on death to label the
   *  kill feed with the weapon used. Null if never shot, or shot by no gun. */
  lastAttackerGun: GunSpec | null = null;

  /** Worn armor, or null. Soaks bullet damage and renders on the head (see draw). */
  armor: Armor | null = null;

  /** When seated in a vehicle: the vehicle and the seat index (else null/−1 on
   *  foot). An occupant is pinned to its seat and skips body/wall collision; its
   *  rounds skip its OWN vehicle's hull, so an exposed seat can fire out while an
   *  enclosed one is sealed. Set/cleared by the session (see game.ts enter/exit). */
  vehicle: Vehicle | null = null;
  seatIndex = -1;

  readonly slots: Record<SlotName, Gun | null>;
  private equipped: EquipSlot;

  /** The belt: utility consumables carried (slot 4), and which one is selected.
   *  Distinct kinds only — each stack is one spec with a count (see consumable.ts). */
  utilities: UtilityStack[] = [];
  utilityIndex = 0;

  /** Utility-use timer (a timed action like reloading): ticks left, its total,
   *  and the spec being used (whose effect lands when the timer hits 0). */
  useTicks = 0;
  private useTotal = 0;
  private usingSpec: UtilitySpec | null = null;

  /** Regen status effect (syringe): heals `regenRate` HP per tick while
   *  `regenTicks` remain. Set/refreshed by applyRegen; does not stack. */
  regenTicks = 0;
  regenRate = 0;

  /** Stagger status (a staggering weapon hit): while `staggerTicks` remain, the
   *  ACTUAL per-tick displacement is scaled by `staggerMul` — see applyStaggerMove.
   *  Set/refreshed by applyStagger; does not stack. Deliberately NOT folded into
   *  `vel`, so the inaccuracy `speed` still reads the intended velocity: a stagger
   *  slows you down without ever making you a better shot. */
  staggerTicks = 0;
  staggerMul = 1;

  constructor(pos: Vec2, skin: Skin, loadout: Loadout) {
    this.pos = pos;
    this.skin = skin;
    this.slots = {
      primary: loadout.primary ?? null,
      secondary: loadout.secondary ?? null,
      hand: loadout.hand,
    };
    this.utilities = (loadout.utilities ?? []).map((u) => new UtilityStack(u.spec, u.count));
    this.equipped = loadout.primary ? "primary" : loadout.secondary ? "secondary" : "hand";
  }

  /**
   * Reset this character to a fresh spawn: full health, a new position/level,
   * cleared momentum + armor, and a fresh loadout. Reuses the same object so
   * every reference to it (the player held by main's render/camera) stays valid
   * across a gamemode respawn — see gamemodes/tdm.ts.
   */
  respawn(pos: Vec2, z: number, loadout: Loadout): void {
    this.pos = pos;
    this.z = z;
    this.vel = vec(0, 0);
    this.onStairs = null;
    this.forward = vec(0, -1);
    this.hp = this.maxHp;
    this.lastHitDir = null;
    this.lastAttacker = null;
    this.armor = null;
    this.vehicle = null;
    this.seatIndex = -1;
    this.slots.primary = loadout.primary ?? null;
    this.slots.secondary = loadout.secondary ?? null;
    this.slots.hand = loadout.hand;
    this.utilities = (loadout.utilities ?? []).map((u) => new UtilityStack(u.spec, u.count));
    this.utilityIndex = 0;
    this.cancelUse();
    this.regenTicks = 0;
    this.regenRate = 0;
    this.staggerTicks = 0;
    this.staggerMul = 1;
    this.equipped = loadout.primary ? "primary" : loadout.secondary ? "secondary" : "hand";
    this.gun.resetDraw();
  }

  /** The currently held gun (never null: the hand slot is always filled). While
   *  the utility belt is equipped there's no gun, so this falls back to the fists
   *  (used for movement speed / camera zoom / hand rendering). */
  get gun(): Gun {
    if (this.equipped === "utility") return this.slots.hand!;
    return this.slots[this.equipped] ?? this.slots.hand!;
  }

  /** Which slot is currently held (for the HUD's slot highlight + input). */
  get equippedSlot(): EquipSlot {
    return this.equipped;
  }

  /** True while the utility belt (slot 4) is held — click uses, doesn't fire. */
  get holdingUtility(): boolean {
    return this.equipped === "utility";
  }

  /** The selected belt item (slot 4), or null if the belt is empty. */
  get currentUtility(): UtilitySpec | null {
    return this.utilities[this.utilityIndex]?.spec ?? null;
  }

  /** How many of the selected belt item are carried. */
  get currentUtilityCount(): number {
    return this.utilities[this.utilityIndex]?.count ?? 0;
  }

  /** True while a utility use is in progress (drives the timer bar + move slow). */
  get usingUtility(): boolean {
    return this.useTicks > 0;
  }

  /** Use progress in [0, 1] (0 just started, 1 done). 0 when not using. */
  get useProgress(): number {
    return this.useTotal > 0 ? 1 - this.useTicks / this.useTotal : 0;
  }

  /** Current movement speed (world px/tick). */
  get speed(): number {
    // On stairs, applyStairMove shrank the climb-axis velocity by STAIR_CLIMB_MUL;
    // undo it here (the inverse) so recoil — the consumer that matters — treats a
    // climb as full-speed movement instead of rewarding the shooter for the stair
    // slowdown.
    if (this.onStairs) return len(scaleAlong(this.vel, this.onStairs, 1 / STAIR_CLIMB_MUL));
    return len(this.vel);
  }

  /** The movement fraction gun inaccuracy scales by: current speed over the most
   *  this loadout can manage. Exactly what fire() hands the gun, exposed so the
   *  HUD can ask the gun what its spread would be without guessing at it. */
  get speedRatio(): number {
    return this.speed / maxSpeedFor(this.gun.spec);
  }

  /** This character's movement speed multiplier: the held gun's weight, worn
   *  armor, and whether a utility use is slowing it (heal). Assembled here, with
   *  the movement it scales, rather than by the caller. */
  get moveSpeedMul(): number {
    let m = this.gun.spec.speed;
    if (this.armor) m *= this.armor.spec.speed;
    if (this.usingUtility) m *= USE_SPEED_MUL; // slowed mid-heal
    return m;
  }

  /** Switch to a slot. No-op if it's empty (a gun slot with no gun, or the utility
   *  belt with nothing on it); resets spray, cancels any reload, and aborts a
   *  utility use in progress. */
  equip(slot: EquipSlot): void {
    if (slot === this.equipped) return;
    if (slot === "utility") {
      if (this.utilities.length === 0) return;
    } else if (this.slots[slot] === null) {
      return;
    }
    const old = this.equipped === "utility" ? null : this.slots[this.equipped];
    old?.resetRecoil();
    old?.cancelReload(); // switching weapons aborts a reload in progress
    this.cancelUse(); // ...and aborts a healing use in progress
    this.equipped = slot;
    // this.gun.resetRecoil();
    if (slot !== "utility") this.gun.resetDraw();
  }

  /** Equip the utility belt (slot 4). No-op if nothing is carried. */
  equipUtility(): void {
    this.equip("utility");
  }

  /** Advance to the next carried utility, wrapping. Cancels a use in progress
   *  (the item under the cursor changed). No-op with fewer than two kinds. */
  cycleUtility(): void {
    if (this.utilities.length === 0) return;
    this.utilityIndex = (this.utilityIndex + 1) % this.utilities.length;
    this.cancelUse();
  }

  /** Begin using the selected utility. No-op unless the belt is held, something
   *  is selected, and no use is already running. */
  startUse(): void {
    if (this.equipped !== "utility" || this.useTicks > 0) return;
    const cur = this.utilities[this.utilityIndex];
    if (!cur) return;
    this.usingSpec = cur.spec;
    this.useTotal = cur.spec.useTime;
    this.useTicks = cur.spec.useTime;
  }

  /** Abort a use in progress without consuming the item. */
  cancelUse(): void {
    this.useTicks = 0;
    this.useTotal = 0;
    this.usingSpec = null;
  }

  /** Set/refresh a regen status: heal `rate` HP per tick for `ticks`. Reapplying
   *  refreshes the duration at the new rate but does NOT add to it (no stacking). */
  applyRegen(rate: number, ticks: number): void {
    this.regenRate = rate;
    this.regenTicks = ticks;
  }

  /** Apply a movement stagger: scale actual movement by `mul` for `ticks` ticks
   *  (see staggerTicks / applyStaggerMove). Non-stacking like regen — a fresh hit
   *  REPLACES any active stagger rather than compounding, so a shotgun's many
   *  pellets or a blast's coverage don't multiply into a freeze. This is the
   *  optional `Hittable.applyStagger` hook the hit pipeline calls. */
  applyStagger(mul: number, ticks: number): void {
    this.staggerMul = mul;
    this.staggerTicks = ticks;
  }

  /** Add up to `n` of a utility spec to the belt (capped at its maxCarry).
   *  Returns how many were actually taken (0 if already full). */
  addUtility(spec: UtilitySpec, n = 1): number {
    const stack = this.utilities.find((u) => u.spec === spec);
    const have = stack?.count ?? 0;
    const take = Math.max(0, Math.min(n, spec.maxCarry - have));
    if (take === 0) return 0;
    if (stack) stack.count += take;
    else this.utilities.push(new UtilityStack(spec, take));
    return take;
  }

  /** Drop one of the selected utility (HUD right-click), returning it as a
   *  single-count stack (a Droppable) to place on the ground, or null if the
   *  belt is empty. */
  dropCurrentUtility(): UtilityStack | null {
    const cur = this.utilities[this.utilityIndex];
    if (!cur) return null;
    const spec = cur.spec;
    this.consumeUtility(spec);
    return new UtilityStack(spec, 1);
  }

  /** All carried utilities (for death drops), clearing the belt. */
  dropUtilities(): UtilityStack[] {
    const out = this.utilities.slice();
    this.utilities = [];
    this.utilityIndex = 0;
    return out;
  }

  /** Remove one of `spec` from the belt; drop the stack when it empties, keeping
   *  the selection valid and falling back to fists if the belt is now empty. */
  private consumeUtility(spec: UtilitySpec): void {
    const idx = this.utilities.findIndex((u) => u.spec === spec);
    if (idx < 0) return;
    this.utilities[idx].count -= 1;
    if (this.utilities[idx].count > 0) return;
    this.utilities.splice(idx, 1);
    if (this.utilities.length === 0) {
      this.utilityIndex = 0;
      if (this.equipped === "utility") {
        this.equipped = "hand"; // nothing left to hold — bring the fists up
        this.gun.resetDraw();
      }
    } else if (this.utilityIndex >= this.utilities.length) {
      this.utilityIndex = this.utilities.length - 1;
    }
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
    if (this.equipped === "hand" || this.equipped === "utility") return null; // not a droppable gun
    const g = this.slots[this.equipped];
    if (!g) return null;
    g.cancelReload();
    this.slots[this.equipped] = null;
    this.equipped = "hand";
    this.gun.resetDraw(); // bringing the fists up takes its draw time
    return g.dropClone();
  }

  /** Drop the gun in a specific slot (not the fists), regardless of what's equipped.
   *  If that slot was the equipped one, fall back to fists. Returns the ground-version
   *  to place in the world, or null if the slot was empty. */
  dropSlot(slot: "primary" | "secondary"): Gun | null {
    const g = this.slots[slot];
    if (!g) return null;
    g.cancelReload();
    this.slots[slot] = null;
    if (this.equipped === slot) {
      this.equipped = "hand";
      this.gun.resetDraw(); // bringing the fists up takes its draw time
    }
    return g.dropClone();
  }

  /** Put on `armor`, returning whatever was worn before (for the caller to drop),
   *  or null if the character was unarmored. */
  equipArmor(armor: Armor): Armor | null {
    const prev = this.armor;
    this.armor = armor;
    return prev;
  }

  /** Take off and return the worn armor (for the caller to drop), or null if none. */
  dropArmor(): Armor | null {
    const a = this.armor;
    this.armor = null;
    return a;
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

  /** Start reloading the equipped gun (no-op if full / no spare / already reloading).
   *  The reload sound is driven off the gun's reloadPulse in tickWeapon(), so it
   *  covers both the first cycle and a perBullet gun's per-shell auto-cycles. */
  reload(): void {
    this.gun.startReload();
  }

  /** Abort whatever timed action is in progress — a utility use or a reload (incl.
   *  a per-round reload's auto-cycle). No-op if nothing is running. Bound to X. */
  cancelAction(): void {
    this.cancelUse();
    this.gun.cancelReload();
  }

  /** Acceleration + friction movement. `axis` is raw -1/0/1 input per axis. */
  move(axis: Vec2): void {
    let ax = axis.x;
    let ay = axis.y;
    // Normalize diagonals so they aren't faster than cardinal movement.
    if (ax !== 0 && ay !== 0) {
      ax *= SQRT1_2;
      ay *= SQRT1_2;
    }
    const accel = ACCEL * this.moveSpeedMul;
    this.vel = add(this.vel, vec(ax * accel, ay * accel));
    this.vel = scale(this.vel, FRICTION);
    this.pos = add(this.pos, this.vel);
    this.applyStairMove(); // staircase climb slowdown (no-op off stairs)
    this.applyStaggerMove(); // stagger slowdown (no-op when not staggered)
  }

  /** Apply the staircase climb slowdown to the step just taken: shrink this tick's
   *  velocity component along the flight's climb axis by STAIR_CLIMB_MUL (leaving
   *  the sideways, perpendicular component full) and shift position to match — so a
   *  diagonal approach scales the stairs no faster than a straight climb. Called by
   *  every mover after it steps (the player's physics move() above, and an AI's
   *  kinematic step via Robot.think), so climbing is slower for all. `onStairs` (the
   *  climb-axis unit vector) is set by the session before the move; no-op off
   *  stairs. The recoil `speed` getter undoes this so accuracy reflects intent. */
  applyStairMove(): void {
    if (!this.onStairs) return;
    const scaled = scaleAlong(this.vel, this.onStairs, STAIR_CLIMB_MUL);
    // pos was already stepped by the full vel; nudge it by the shortfall.
    this.pos = add(this.pos, sub(scaled, this.vel));
    this.vel = scaled;
  }

  /** Apply the movement stagger to the step just taken: pull the position back so
   *  the ACTUAL displacement this tick is `staggerMul` of the intended step, while
   *  leaving `vel` untouched — so the recoil `speed` getter still reads the full
   *  intended velocity and a stagger can never buy accuracy (the whole point). Runs
   *  after applyStairMove, off `vel` (which stairs already scaled), so the two
   *  slowdowns compose. Called by every mover — the player's move() and an AI's
   *  Robot.think. No-op when not staggered. */
  applyStaggerMove(): void {
    if (this.staggerTicks <= 0) return;
    this.pos = add(this.pos, scale(this.vel, this.staggerMul - 1));
  }

  /** Per-tick recovery for the equipped gun (cooldown, flash, kick, spray reset). */
  tickWeapon(): void {
    this.gun.tick();
    // A reload cycle (re)started this tick — play the reload sound. On a perBullet
    // gun (pump shotgun) the gun's auto-cycle pulses this once per shell, so the
    // clip repeats for each round loaded; on a normal gun it fires just once.
    if (this.gun.reloadPulse) {
      this.gun.reloadPulse = false;
      if (this.gun.spec.reloadSound) {
        playSound(this.gun.spec.reloadSound, { pos: this.pos, z: this.z });
      }
    }
  }

  /** Per-tick belt/status upkeep: advance a utility use (landing its effect and
   *  consuming it on completion) and tick down any regen. Runs for every
   *  character each tick, before damage is resolved. */
  tickStatus(): void {
    if (this.useTicks > 0) {
      this.useTicks -= 1;
      if (this.useTicks === 0) this.finishUse();
    }
    if (this.regenTicks > 0) {
      this.regenTicks -= 1;
      this._heal(this.regenRate);
    }
    if (this.staggerTicks > 0) {
      this.staggerTicks -= 1;
      if (this.staggerTicks === 0) this.staggerMul = 1; // effect over: back to full speed
    }
  }

  /** Land the finished use's effect and consume one from the belt. */
  private finishUse(): void {
    const spec = this.usingSpec;
    this.usingSpec = null;
    this.useTotal = 0;
    if (!spec) return;
    spec.apply(this);
    this.consumeUtility(spec);
  }

  /**
   * Fire if the equipped weapon can. Returns true if a shot went out. The caller
   * decides *when* to attempt (held trigger for auto, click edge for semi).
   */
  fire(world: World): boolean {
    const gun = this.gun;
    return gun.fire(world, this.pos, this.forward, this, this.speedRatio);
  }

  /**
   * Take a hit from a bullet travelling in `dir` (unit) at world point `point`,
   * dealing `damage`. (Armor mitigation will hook in here later.) The world
   * spawns the blood particle for the impact.
   */
  registerHit(
    dir: Vec2,
    _point: Vec2,
    damage: number,
    armorPen: ArmorPen,
    attacker: Hittable | null = null,
    gun: GunSpec | null = null,
  ): void {
    this.lastHitDir = dir;
    this.lastAttacker = attacker;
    this.lastAttackerGun = gun;

    let toBody = damage;
    const armor = this.armor;
    if (armor && !armor.destroyed) {
      // The body only takes the fraction that penetrates this armor's level...
      const pen = armorPen[`l${armor.level}` as keyof ArmorPen];
      toBody = damage * pen;
      // ...while the armor soaks the full bullet damage, and may shatter.
      if (armor.absorb(damage)) this.armor = null;
    }
    this.hp = Math.max(0, this.hp - toBody);
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
    this.drawSlung(ctx); // behind the body, so the torso covers its middle
    const gun = this.gun;
    // While the belt is held there's no gun; the hands play the utility's own
    // use animation (or hold the fists pose) instead of the gun's hand track.
    const hands =
      this.equipped === "utility" ? this.utilityHands() : gun.handPositions(this.pos, this.forward);
    drawCharacter(
      ctx,
      this.pos,
      this.forward,
      hands.right,
      hands.left,
      this.skin,
      () => gun.draw(ctx, this.pos, this.forward, this.skin.outline),
      this.armor,
    );
    if (this.equipped === "utility") this.drawHeldUtility(ctx, hands);
  }

  /** Hand positions while holding the belt: the fists' rest grips, overridden by
   *  the selected utility's `useAnim` keyframes while a use is in progress (same
   *  keyframe machinery as a gun reload — see interpGrip). */
  private utilityHands(): { right: Vec2; left: Vec2 } {
    const side = perp(this.forward);
    const gripAt = (g: GripLocal): Vec2 =>
      add(this.pos, add(scale(this.forward, g.f), scale(side, g.l)));
    const hand = this.slots.hand!;
    let rg: GripLocal = hand.spec.rightGrip;
    let lg: GripLocal = hand.spec.leftGrip;
    const anim = this.currentUtility?.useAnim;
    if (anim && this.useTicks > 0) {
      const t = this.useTotal - this.useTicks; // elapsed ticks into the use
      if (anim.rightPositions && anim.rightTimes) rg = interpGrip(anim.rightPositions, anim.rightTimes, t);
      if (anim.leftPositions && anim.leftTimes) lg = interpGrip(anim.leftPositions, anim.leftTimes, t);
    }
    return { right: gripAt(rg), left: gripAt(lg) };
  }

  /** Draw the selected utility icon between the hands (which are already drawn by
   *  the body pass), so it tracks the use animation and reads as "held." */
  private drawHeldUtility(ctx: CanvasRenderingContext2D, hands: { right: Vec2; left: Vec2 }): void {
    const spec = this.currentUtility;
    if (!spec) return;
    const img = utilityIcon(spec);
    if (!img) return;
    const c = mid(hands.right, hands.left);
    const k = UTILITY_HELD_SIZE / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(angleOf(this.forward) + Math.PI / 2); // upright relative to aim
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /**
   * Draw the holstered primary slung diagonally across the back. Only when a
   * primary is carried but not the equipped weapon; rendered first (under the
   * body) so the torso covers its middle and the ends poke out behind.
   */
  private drawSlung(ctx: CanvasRenderingContext2D): void {
    const primary = this.slots.primary;
    if (!primary || this.equipped === "primary") return;
    const img = gunIcon(primary.spec);
    if (!img) return;

    const w = img.naturalWidth * SLUNG_SCALE;
    const h = img.naturalHeight * SLUNG_SCALE;
    const center = add(this.pos, scale(this.forward, -SLUNG_BACK_OFFSET));
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(angleOf(this.forward) + deg2rad(SLUNG_ANGLE_DEG));
    ctx.drawImage(img, -w / 2, - h / 2, w, h);
    ctx.restore();
  }
}
