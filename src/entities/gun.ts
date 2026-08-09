import { DEFAULT_PARAMS, drawMuzzleFlash, FLASH_TICKS } from "./character.ts";
import { GunItem, type Droppable, type GroundItem } from "./item.ts";
import { interpGrip, type GunSpec } from "./guns.ts";
import { add, angleOf, deg2rad, dist, mid, perp, rotate, scale, sub, type Vec2 } from "../engine/vec.ts";
import { spawnBullet, spawnProjectile, type Hittable, type World } from "../world/world.ts";

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
  // ctx.roundRect(-dist(p0, p1) / 2, -r, dist(p0, p1), w, r);
  ctx.roundRect(-dist(p0, p1) / 2, -r, dist(p0, p1), w, 0);
  ctx.fill();
  ctx.restore();
}

function sampleNormal(mu: number, sigma: number) {
  return mu + sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * A gun as a game object: wraps an immutable `GunSpec` and tracks all the
 * mutable per-instance state (cooldown, visual kick, muzzle flash, and the
 * recoil-pattern accumulator). These are meant to exist in the world and be
 * dropped / picked up, so each carries its own state independent of who holds it.
 */
export class Gun implements Droppable {
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
   * The range (world px) at which the gun stops being worth firing — the AI won't
   * shoot, chase, or count a target as "in contact" past it. For now this is just
   * the bullet's physical reach: it lives `bulletLife` ticks at `bulletSpeed`
   * px/tick, so it simply vanishes past `bulletSpeed * bulletLife`. A melee/no-fire
   * gun has no feasible range (0). (Named for the concept, not the formula, so a
   * later accuracy-aware model can slot in here without touching callers.)
   */
  get feasibleRange(): number {
    const f = this.spec.fire;
    return f ? f.bulletSpeed * f.bulletLife : 0;
  }

  /**
   * The gun to leave on the ground when the holder drops it or dies. A normal gun
   * drops itself (keeping its ammo state); subclasses may substitute a different
   * instance (e.g. an enemy gun yields a normal, player-usable version).
   */
  dropClone(): Gun {
    return this;
  }

  /**
   * Put this gun on the ground as a pickup at (`pos`, `z`), tossed with `vel`
   * (the Droppable API — see item.ts). It keeps its ammo (mag + reserve) but
   * forgets all transient timing — cooldown, kick, muzzle flash, reload, draw,
   * and recoil spray — so picking it back up starts from a clean slate instead
   * of mid-reload or mid-cooldown.
   */
  getGroundItem(pos: Vec2, vel: Vec2, z: number): GroundItem {
    this.fireCooldown = 0;
    this.kickback = 0;
    this.flashTicks = 0;
    this.reloadTicks = 0;
    this.drawTicks = 0;
    this.currentRecoil = 0;
    this.idleTicks = 0;
    this.meleeTicks = 0;
    return new GunItem(pos, this, vel, z);
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

  /** Is there room and ammo to load? (A mag that isn't full, a spare, not already
   *  reloading, not drawing.) This is the *continuation* predicate — it's what a
   *  perBullet gun re-checks to auto-cycle the next shell. Starting a reload from
   *  scratch has the extra condition in `canStartReload`. */
  get canReload(): boolean {
    const f = this.spec.fire;
    return f !== undefined && !this.reloading && this.mag < f.magSize && this.reserveMags > 0 && !this.drawing;
  }

  /**
   * Can a reload be *started* right now? Everything `canReload` wants, plus the
   * fire delay having fully elapsed.
   *
   * That last condition is what stops reload-cancelling from laundering away the
   * fire delay: reload, then abort it (X, a weapon switch, or — on a perBullet gun
   * — just firing), and you'd be back to a ready weapon without having waited out
   * the shot you already took. Gating the *start* rather than `canReload` itself
   * keeps a pump shotgun's shell-by-shell cycle intact, which matters because
   * Mossberg500 reloads a shell (40t) faster than it can fire (45t).
   */
  get canStartReload(): boolean {
    return this.canReload && this.fireCooldown <= 0;
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

  /** Begin a reload if allowed. No-op otherwise (full mag, no spare, or the fire
   *  delay from the last shot hasn't run out yet). */
  startReload(): void {
    if (!this.canStartReload) return;
    this.reloadTicks = this.spec.fire!.reloadTime;
    // NB: deliberately does NOT clear fireCooldown. It used to, which is what made
    // reload-cancel a free way to skip the fire delay; canStartReload now
    // guarantees it's already 0 anyway.
  }

  /** Abort an in-progress reload without consuming a spare (e.g. on weapon switch). */
  cancelReload(): void {
    this.reloadTicks = 0;
  }

  /**
   * Land one reload cycle. A normal gun does a hardcore mag swap: a fresh mag,
   * any rounds left in the old one lost. A `perBullet` gun (pump shotgun, etc.)
   * chambers a single round from its spare-round pool and, if the mag still isn't
   * full and rounds remain, immediately restarts the cycle — so one `startReload`
   * tops the whole mag off round by round until full, dry, or cancelled.
   */
  private finishReload(): void {
    const f = this.spec.fire!;
    if (f.perBullet) {
      this.mag += 1;
      this.reserveMags -= 1;
      if (this.canReload) this.reloadTicks = f.reloadTime; // auto-cycle to the next round
    } else {
      this.mag = f.magSize;
      this.reserveMags -= 1;
    }
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

    if (this.spec.reloadAnim && this.spec.fire !== undefined && this.reloadTicks > 0) {
      const t = this.spec.fire.reloadTime - this.reloadTicks
      const anim = this.spec.reloadAnim
      // grip() is affine, so interpolating the local grips then applying grip is
      // identical to lerping the world-space hand positions.
      if (anim.leftPositions && anim.leftTimes) left = grip(interpGrip(anim.leftPositions, anim.leftTimes, t))
      if (anim.rightPositions && anim.rightTimes) right = grip(interpGrip(anim.rightPositions, anim.rightTimes, t))
    }
    if (this.spec.fireAnim && this.spec.fire !== undefined && this.fireCooldown > 0) {
      const t = this.spec.fire.delay - this.fireCooldown
      const anim = this.spec.fireAnim
      // grip() is affine, so interpolating the local grips then applying grip is
      // identical to lerping the world-space hand positions.
      if (anim.leftPositions && anim.leftTimes) left = grip(interpGrip(anim.leftPositions, anim.leftTimes, t))
      if (anim.rightPositions && anim.rightTimes) right = grip(interpGrip(anim.rightPositions, anim.rightTimes, t))
    }


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
    const side = perp(forward); // unit vector to the holder's right
    const grip = (g: { f: number; l: number }): Vec2 =>
      add(headCenter, add(scale(forward, g.f - this.kickback), scale(side, g.l)));

    // Muzzle flash at the functional muzzle (a local f/l point, kicked back with
    // the gun), drawn first so it sits below the gun -- just looks better imo. A
    // gun with no muzzle (unarmed) never flashes. The flash still points along
    // forward regardless of any lateral muzzle offset.
    if (this.flashTicks > 0 && this.spec.muzzle !== undefined) {
      drawMuzzleFlash(ctx, grip(this.spec.muzzle), forward, this.flashTicks / FLASH_TICKS);
    }

    // Rendered parts (the barrel is just one of them): outline + fill per bar,
    // `over: false` beneath, then `over: true` on top.
    const parts = this.spec.parts;
    if (!parts) return;
    const drawPart = (line: (typeof parts)[number]): void => {
      drawBar(ctx, grip(line.p0), grip(line.p1), line.width + outlineWidth * 2, outlineColor);
      drawBar(ctx, grip(line.p0), grip(line.p1), line.width, line.color);
    };
    for (const line of parts) if (!line.over) drawPart(line);
    for (const line of parts) if (line.over) drawPart(line);
  }

  /**
   * Fire from `origin` along `forward` (unit) if able, spawning the bullet with the
   * recoil offset applied. Returns true if a shot went out. `owner` is protected
   * from its own bullet until it clears them; `speedRatio` drives move-inaccuracy.
   */
  fire(world: World, origin: Vec2, forward: Vec2, owner: Hittable, speedRatio: number): boolean {
    // Per-round guns (pump shotguns): a trigger pull interrupts an in-progress
    // top-off so you can fire right away, as long as at least one round is
    // chambered — no need to tap X first. A whole-mag-swap reload still commits.
    if (this.reloading && this.spec.fire?.perBullet && this.mag > 0) this.cancelReload();
    if (!this.canFire) return false;
    const f = this.spec.fire!;
    // Project from the head center (not the muzzle) so shots can't originate past
    // objects/walls in front of the shooter.
    const dir = rotate(forward, this.shoot(speedRatio));
    const m = this.spec.muzzle;
    const muzzleLen = m ? Math.hypot(m.f, m.l) : 0;
    // Melee "bullets" are never drawn (the punch is the visual); guns hide the
    // bullet until it has cleared the muzzle.
    const renderAfter = this.spec.melee ? Infinity : muzzleLen + 50;

    // Launcher weapons throw an AoE projectile instead of a bullet. Blast damage /
    // penetration come from the spec; travel speed + range from the FireSpec.
    const pj = this.spec.projectile;
    if (pj) {
      spawnProjectile(
        world,
        origin,
        dir,
        f.bulletSpeed,
        f.bulletLife,
        renderAfter,
        owner,
        this.damage,
        pj.radius,
        this.spec.armorPen,
        pj.bodyRadius,
        pj.color,
        pj.trailColor,
        owner.z,
        pj.sprite,
        pj.spriteScale,
        pj.explosion,
        this.spec.stagger,
        this.spec,
      );
      return true;
    }

    if (this.spec.shotgunPellets == undefined || this.spec.shotgunSpread == undefined) {
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
        owner.z, // the bullet lives on the shooter's level
        this.spec.stagger,
        this.spec,
      );
    } else {
      for (let i = 0; i < this.spec.shotgunPellets; i++) {
        const pellet_dir = rotate(dir, sampleNormal(0, deg2rad(this.spec.shotgunSpread)))
        spawnBullet(
          world,
          origin,
          pellet_dir,
          f.bulletSpeed,
          f.bulletLife,
          renderAfter,
          owner,
          this.damage,
          f.tracerWidth,
          f.tracerLength,
          f.tracerColor,
          this.spec.armorPen,
          owner.z, // the bullet lives on the shooter's level
          this.spec.stagger,
          this.spec,
        );
      }
    }
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
    const pattern = this.patternBound(recoilForPattern) * Math.sin(recoilForPattern);
    const random = (Math.random() * 2 - 1) * this.randomBound(speedRatio);

    // Spend the round (melee weapons never drain) and, if melee, throw a punch.
    if (s.melee) this.startPunch();
    else this.mag -= 1;

    // Then grow the spray; movement makes it grow faster.
    this.currentRecoil += s.recoilGain * this.moveMul(speedRatio);
    this.idleTicks = 0;

    this.fireCooldown = f.delay;
    this.kickback = s.visualRecoil;
    this.flashTicks = FLASH_TICKS;

    return pattern + random;
  }

  /** How much movement inflates the random spread and the recoil growth. */
  protected moveMul(speedRatio: number): number {
    return 1 + this.spec.movePenalty * speedRatio;
  }

  /** |deterministic pattern| at its widest for a given recoil value — the sin()
   *  factor shoot() multiplies this by is at most 1. */
  protected patternBound(recoil: number): number {
    return this.spec.recoilCoef * this.spec.recoilCoef * Math.sqrt(recoil);
  }

  /** |random spread| at its widest for this movement speed. */
  protected randomBound(speedRatio: number): number {
    return this.spec.fire ? this.spec.fire.spread * this.moveMul(speedRatio) : 0;
  }

  /**
   * Upper bound (radians) on the aim offset the NEXT shot could take — the same
   * two terms shoot() adds, each at its extreme. Shares shoot()'s expressions
   * rather than restating them, so a change to the spray model can't leave the
   * crosshair lying about it.
   *
   * The pattern term uses whatever recoil the next shot would spray from: the
   * accumulated value normally, and for a first shot while moving the top of the
   * range shoot() draws from (it picks uniformly in [min, max] — this is the
   * worst case of that draw).
   */
  maxSpread(speedRatio: number): number {
    if (!this.spec.fire) return 0;
    const recoil =
      this.currentRecoil > 0
        ? this.currentRecoil
        : speedRatio * this.spec.movingFirstShotRecoilMax;
    return this.patternBound(recoil) + this.randomBound(speedRatio);
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

  /** Flat uniform spread, so the bound is simply that spread. */
  override maxSpread(_speedRatio: number): number {
    return this.spreadRad;
  }
}
