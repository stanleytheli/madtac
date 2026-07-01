import { DEFAULT_PARAMS, drawMuzzleFlash, FLASH_TICKS } from "./character.ts";
import type { GunSpec } from "./guns.ts";
import { add, angleOf, deg2rad, dist, mid, perp, rotate, scale, sub, type Vec2 } from "./vec.ts";
import { spawnBullet, type Hittable, type World } from "./world.ts";

const PUNCH_TICKS = 10; // duration of one punch's hand thrust
const PUNCH_REACH = 35; // world px the punching hand lunges forward at full extension

/** Draw a rounded bar from p0 to p1 of thickness `w`. Shared by gun rendering. */
function drawBar(
  ctx: CanvasRenderingContext2D,
  p0: Vec2,
  p1: Vec2,
  w: number,
  color: string,
): void {
  const c = mid(p0, p1);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(angleOf(sub(p1, p0)));
  ctx.fillStyle = color;
  ctx.beginPath();
  const r = w / 2;
  ctx.roundRect(-dist(p0, p1) / 2, -r, dist(p0, p1), w, r);
  ctx.fill();
  ctx.restore();
}

/**
 * A gun as a game object: wraps an immutable `GunSpec` and tracks all the
 * mutable per-instance state (cooldown, visual kick, muzzle flash, and the
 * recoil-pattern accumulator). These are meant to exist in the world and be
 * dropped / picked up, so each carries its own state independent of who holds it.
 */
export class Gun {
  readonly spec: GunSpec;

  /** Recoil-pattern accumulator. Grows per shot, resets after `recoilDelay` idle ticks. */
  currentRecoil = 0;
  private idleTicks = 0;

  /** Visual/firing state. */
  fireCooldown = 0; // ticks until the next shot is allowed
  kickback = 0; // current visual recoil in world px (eases back to 0)
  flashTicks = 0; // muzzle flash ticks remaining

  /** Ammo state. Reserve is counted in whole mags (hardcore-style). */
  mag = 0; // rounds currently in the magazine
  reserveMags = 0; // spare full magazines
  reloadTicks = 0; // ticks left in the current reload (0 = not reloading)

  drawTicks = 0; // ticks left in drawing

  /** Punch animation (melee only): ticks left in the current thrust, and which
   *  hand is throwing it (+1 right / -1 left), alternating each punch. */
  private meleeTicks = 0;
  private meleeHand: 1 | -1 = -1;

  constructor(spec: GunSpec) {
    this.spec = spec;
    if (spec.fire) {
      this.mag = spec.fire.magSize;
      this.reserveMags = spec.fire.reserveMags;
    }
  }

  get drawing(): boolean {
    return this.drawTicks > 0;
  }

  get reloading(): boolean {
    return this.reloadTicks > 0;
  }

  /** Damage dealt per bullet by this gun. Subclasses (e.g. enemies) may override. */
  get damage(): number {
    return this.spec.damage;
  }

  /**
   * The gun to leave on the ground when the holder drops it or dies. A normal gun
   * drops itself (keeping its ammo state); subclasses may substitute a different
   * instance (e.g. an enemy gun yields a normal, player-usable version).
   */
  dropClone(): Gun {
    return this;
  }

  get canFire(): boolean {
    return (
      this.spec.fire !== undefined &&
      this.fireCooldown <= 0 &&
      !this.reloading &&
      (this.spec.melee || this.mag > 0) && // melee never runs dry
      !this.drawing
    );
  }

  /** Can a reload start now? (Has a mag that isn't full, a spare, and isn't already reloading.) */
  get canReload(): boolean {
    const f = this.spec.fire;
    return f !== undefined && !this.reloading && this.mag < f.magSize && this.reserveMags > 0 && !this.drawing;
  }

  /** Reload progress in [0, 1] (0 just started, 1 done). 0 when not reloading. */
  get reloadProgress(): number {
    const f = this.spec.fire;
    if (!f || !this.reloading) return 0;
    return 1 - this.reloadTicks / f.reloadTime;
  }

  get drawProgress(): number {
    const f = this.spec.fire;
    if (!f || !this.drawing) return 0;
    return 1 - this.drawTicks / f.drawTime; 
  }

  /** Begin a reload if allowed. No-op otherwise (e.g. full mag or no spare). */
  startReload(): void {
    if (!this.canReload) return;
    this.reloadTicks = this.spec.fire!.reloadTime;
  }

  /** Abort an in-progress reload without consuming a spare (e.g. on weapon switch). */
  cancelReload(): void {
    this.reloadTicks = 0;
  }

  /** Hardcore reload: swap in a fresh mag, any rounds left in the old one are lost. */
  private finishReload(): void {
    const f = this.spec.fire!;
    this.mag = f.magSize;
    this.reserveMags -= 1;
  }

  /** Per-tick recovery while this gun is the equipped one. */
  tick(): void {
    if (this.fireCooldown > 0) this.fireCooldown -= 1;
    if (this.flashTicks > 0) this.flashTicks -= 1;
    if (this.drawTicks > 0 ) this.drawTicks -= 1;
    if (this.meleeTicks > 0) this.meleeTicks -= 1;
    this.kickback = Math.max(0, this.kickback - this.spec.recoilRecovery);

    if (this.reloadTicks > 0) {
      this.reloadTicks -= 1;
      if (this.reloadTicks === 0) this.finishReload();
    }

    this.idleTicks += 1;
    if (this.idleTicks >= this.spec.recoilDelay) this.currentRecoil = 0;
  }

  resetDraw(): void {
    this.drawTicks = this.spec.fire!.drawTime;
  }

  /** Begin a punch thrust, alternating which hand throws it. */
  private startPunch(): void {
    this.meleeHand = this.meleeHand === 1 ? -1 : 1;
    this.meleeTicks = PUNCH_TICKS;
  }

  /** Reset the spray (e.g. when this gun is holstered or freshly equipped). */
  resetRecoil(): void {
    this.currentRecoil = 0;
    this.idleTicks = 0;
  }

  /**
   * World-space positions where the holder's hands grip this gun, given the head
   * center and aim direction. Both grips ride the visual kickback, so the arms
   * re-pose as the gun recoils. The Character draws the hands from these.
   */
  handPositions(headCenter: Vec2, forward: Vec2): { right: Vec2; left: Vec2 } {
    const side = perp(forward); // unit vector to the holder's right
    const grip = (g: { f: number; l: number }): Vec2 =>
      add(headCenter, add(scale(forward, g.f - this.kickback), scale(side, g.l)));
    let right = grip(this.spec.rightGrip);
    let left = grip(this.spec.leftGrip);

    // Punch: thrust the active hand forward and back over the animation (sin = a
    // quick out-and-return). The arm IK follows the hand, so the whole arm jabs.
    if (this.meleeTicks > 0) {
      const t = 1 - this.meleeTicks / PUNCH_TICKS; // 0 -> 1 over the thrust
      const offset = scale(forward, Math.sin(t * Math.PI) * PUNCH_REACH);
      if (this.meleeHand === 1) right = add(right, offset);
      else left = add(left, offset);
    }
    return { right, left };
  }

  /**
   * Render the gun itself (barrel + muzzle flash), kicked back by its current
   * recoil. `outlineColor`/`outlineWidth` come from the holder so the sticker
   * outline matches the body. Called at the gun's z-slot by the Character.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    headCenter: Vec2,
    forward: Vec2,
    outlineColor: string,
    outlineWidth = DEFAULT_PARAMS.outline,
  ): void {
    const b = this.spec.barrel;
    if (!b) return; // e.g. unarmed: nothing to draw

    const p0 = add(headCenter, scale(forward, b.start - this.kickback));
    const p1 = add(headCenter, scale(forward, b.end - this.kickback));

    // draw muzzle flash below gun -- just looks better imo
    if (this.flashTicks > 0) {
      drawMuzzleFlash(ctx, p1, forward, this.flashTicks / FLASH_TICKS);
    }

    drawBar(ctx, p0, p1, b.width + outlineWidth * 2, outlineColor); // outline
    drawBar(ctx, p0, p1, b.width, this.spec.color); // fill

  }

  /**
   * Fire from `origin` along `forward` (unit) if able, spawning the bullet with the
   * recoil offset applied. Returns true if a shot went out. `owner` is protected
   * from its own bullet until it clears them; `speedRatio` drives move-inaccuracy.
   */
  fire(world: World, origin: Vec2, forward: Vec2, owner: Hittable, speedRatio: number): boolean {
    if (!this.canFire) return false;
    const f = this.spec.fire!;
    // Project from the head center (not the muzzle) so shots can't originate past
    // objects/walls in front of the shooter.
    const dir = rotate(forward, this.shoot(speedRatio));
    const muzzleLen = this.spec.barrel ? this.spec.barrel.end : 0;
    // Melee "bullets" are never drawn (the punch is the visual); guns hide the
    // bullet until it has cleared the muzzle.
    const renderAfter = this.spec.melee ? Infinity : muzzleLen + 50;
    spawnBullet(
      world,
      origin,
      dir,
      f.bulletSpeed,
      f.bulletLife,
      renderAfter,
      owner,
      this.damage,
      f.tracerWidth,
      f.tracerLength,
      f.tracerColor,
      this.spec.armorPen,
    );
    return true;
  }

  /**
   * Register a shot. `speedRatio` = shooter speed / max speed (0..~1). Returns
   * the aim offset (radians) to add to the shot direction.
   *
   * Caller must check `canFire` first.
   */
  shoot(speedRatio: number): number {
    const s = this.spec;
    const f = s.fire!;
    const moveMul = 1 + s.movePenalty * speedRatio;

    // Recoil value that drives the deterministic spray. Normally `currentRecoil`,
    // so the first shot (0) is unbiased. But on a first shot while moving, stand in
    // a positive recoil value scaled by speed -> the pattern formula turns it into a
    // bounded first-shot-while-moving inaccuracy (pistols small, snipers large).
    let recoilForPattern = this.currentRecoil;
    if (this.currentRecoil === 0) {
      const { movingFirstShotRecoilMin: lo, movingFirstShotRecoilMax: hi } = s;
      recoilForPattern = speedRatio * (lo + Math.random() * (hi - lo));
    }

    // Deterministic spray pattern (a widening sinusoidal wobble) + random spread,
    // with the random part scaled up by the movement penalty.
    const pattern =
      s.recoilCoef * s.recoilCoef * Math.sqrt(recoilForPattern) * Math.sin(recoilForPattern);
    const random = (Math.random() * 2 - 1) * f.spread * moveMul;

    // Spend the round (melee weapons never drain) and, if melee, throw a punch.
    if (s.melee) this.startPunch();
    else this.mag -= 1;

    // Then grow the spray; movement makes it grow faster.
    this.currentRecoil += s.recoilGain * moveMul;
    this.idleTicks = 0;

    this.fireCooldown = f.delay;
    this.kickback = s.visualRecoil;
    this.flashTicks = FLASH_TICKS;

    return pattern + random;
  }
}

/**
 * A gun wielded by an enemy. Replaces the skill-based recoil pattern with a flat
 * uniform spread, so enemies are dangerous without having to "control" a spray.
 * Ammo is effectively infinite (no mag drain), so no enemy reload AI is needed.
 */
export class EnemyGun extends Gun {
  readonly spreadRad: number;
  private readonly enemyDamage: number;
  private readonly delay: number;

  constructor(spec: GunSpec, opts: { damage?: number; spreadDeg?: number, delay? : number } = {}) {
    super(spec);
    this.enemyDamage = opts.damage ?? 10;
    this.spreadRad = deg2rad(opts.spreadDeg ?? 15);
    this.delay = opts.delay ?? 10;
  }

  /** Enemies deal their own flat damage, not the gun's player-facing value. */
  get damage(): number {
    return this.enemyDamage;
  }

  /** Drop a normal, player-usable gun of the same spec (not this AI wrapper). */
  dropClone(): Gun {
    return new Gun(this.spec);
  }

  /** Fire with a constant uniform spread in [-spread, +spread]; never runs dry. */
  shoot(_speedRatio: number): number {
    this.fireCooldown = this.delay;
    // set = visualRecoil, prevents hands/gun going into robot
    this.kickback = this.spec.visualRecoil;
    this.flashTicks = FLASH_TICKS;
    return (Math.random() * 2 - 1) * this.spreadRad;
  }
}
