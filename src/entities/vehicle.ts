/**
 * Vehicles: rigid, multi-part, drivable objects with seats. One seat drives
 * (relative WASD — W is *forward along the hull*, not screen-up); other seats
 * ride. A seat may own a turret part it aims/fires with the mouse; a plain seat
 * fires the occupant's personal weapon.
 *
 * A vehicle is a set of boxes (`parts`) placed in the vehicle's LOCAL frame and
 * transformed to world each tick from `pos`/`angle`. Parts drive four systems:
 *   - movement/nav: `solid` parts block bodies + the CCH walkability march.
 *   - rounds/sight: `solid && !permeable` parts stop bullets/rockets and shield
 *     a blast — this is where occupant protection comes from. An enclosed seat
 *     (driver in a tank hull) can't be shot from outside because incoming rounds
 *     die on the hull; an exposed seat (open jeep bench, a `permeable` body that
 *     stops driving-through but lets rounds pass) both shoots out and is exposed.
 *   - render: `over` parts (turret/roof) draw above occupants, the chassis below.
 *
 * Physics is a scalar forward-speed model (grippy arcade: the hull goes where it
 * points, no drift), integrated in `drive()` then resolved out of static walls
 * and other vehicles by covering each solid part with collision circles and
 * reusing the existing circle-vs-box push-out. Per-tick step is far below a
 * circle's radius, so nothing tunnels (same argument as character separation).
 *
 * The spec/instance split mirrors gun.ts/guns.ts: immutable `VehicleSpec` data
 * lives in vehicles.ts; this file is the live class.
 */
import { circleIntersectsBox, pointInBox, resolveCircleVsBox, segmentIntersectsBox, worldAabb, type AABB, type Box } from "../engine/collision.ts";
import { add, dot, fromAngle, rotate, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import { Gun } from "./gun.ts";
import { GUN_SPECS } from "./specs.ts";
import type { Character } from "./actor.ts";
import type { World } from "../world/world.ts";
import type { NavGraph } from "../world/nav.ts";

export type SeatRole = "driver" | "passenger";

/** A vehicle-mounted weapon on a turret part: which gun, and how far past the
 *  turret pivot the muzzle sits (so its rounds spawn OUTSIDE the hull and clear). */
export interface TurretSpec {
  gun: string; // GUN_SPECS key
  muzzle: number; // world px from the pivot to the barrel tip
}

/** One box of a vehicle, in the vehicle's local frame (before pos/angle). */
export interface VehiclePartSpec {
  lpos: Vec2; // offset from the vehicle center
  w: number;
  h: number;
  langle?: number; // local rotation (static parts); turret parts spin freely instead
  /** Blocks bodies + the nav march. Default true. */
  solid?: boolean;
  /** Rounds and sight pass through (still solid to movement if `solid`): an open
   *  jeep body, a window. Occupants behind a permeable part are exposed. */
  permeable?: boolean;
  /** Drawn ON TOP of occupants (turret, roof) instead of beneath (chassis). */
  over?: boolean;
  /** Makes this part a rotating, aimable weapon mount. */
  turret?: TurretSpec;
  // appearance
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** Future destructibility — scaffolded, unused in v1 (vehicles are indestructible). */
  hp?: number;
}

export interface SeatSpec {
  lpos: Vec2;
  role: SeatRole;
  /** Index into `parts` of the turret this seat aims/fires (driver or gunner).
   *  Omitted = the occupant uses their own personal weapon. */
  turret?: number;
}

export interface VehicleSpec {
  name: string;
  parts: VehiclePartSpec[];
  seats: SeatSpec[];
  // physics (per 60 Hz tick)
  accel: number; // forward speed gained per tick at full throttle
  maxSpeed: number; // px/tick
  reverseMul: number; // reverse top speed as a fraction of maxSpeed
  friction: number; // forward-speed retained per tick
  turnRate: number; // rad/tick at full steer
  /** true = pivot in place (tank); false = turn scales with speed + reverses in reverse (car). */
  turnAtRest: boolean;
  /** Override the auto collision-circle radius (default = half the part's short side). */
  colRadius?: number;
}

/** A resolved seat: its spec plus who's sitting in it. */
export interface Seat {
  spec: SeatSpec;
  occupant: Character | null;
}

/** A part transformed to world space, for rendering. */
export interface PartWorld {
  box: Box;
  spec: VehiclePartSpec;
}

const isSolid = (p: VehiclePartSpec): boolean => p.solid ?? true;

export class Vehicle {
  pos: Vec2;
  angle: number;
  z: number;
  /** Signed forward speed (the integrator state); `vel` is the derived world step. */
  speed = 0;
  vel: Vec2 = vec(0, 0);
  /** Driver inputs for this tick, −1..1. */
  throttle = 0;
  steer = 0;

  spec: VehicleSpec;
  seats!: Seat[];
  /** World facing of each turret part (indexed like `parts`; junk at non-turrets). */
  turretAngle!: number[];
  /** The Gun backing each turret part, or null (indexed like `parts`). */
  turretGun!: (Gun | null)[];

  /** Local-frame collision circles covering the solid parts (rebuilt on setSpec). */
  private circles!: { c: Vec2; r: number }[];
  /** Packed nav-edge keys this vehicle currently blocks (see syncNav). */
  readonly blocked = new Set<number>();

  constructor(spec: VehicleSpec, pos: Vec2, angle = 0, z = 0) {
    this.spec = spec;
    this.pos = vec(pos.x, pos.y);
    this.angle = angle;
    this.z = z;
    this.init();
  }

  /** Swap the vehicle's spec, rebuilding all derived state — the editor's "type"
   *  change path (entities are edited in place, so identity is preserved). */
  setSpec(spec: VehicleSpec): void {
    this.spec = spec;
    this.init();
  }

  /** (Re)build seats, turret state, and collision circles from the current spec. */
  private init(): void {
    this.seats = this.spec.seats.map((s) => ({ spec: s, occupant: null }));
    this.turretAngle = this.spec.parts.map(() => this.angle);
    this.turretGun = this.spec.parts.map((p) =>
      p.turret && GUN_SPECS[p.turret.gun] ? new Gun(GUN_SPECS[p.turret.gun]) : null,
    );
    this.circles = this.buildCircles();
  }

  /** Cover each solid part's long axis with circles sized to its short side, so
   *  circle-vs-box push-out resolves the whole hull against walls/vehicles. */
  private buildCircles(): { c: Vec2; r: number }[] {
    const out: { c: Vec2; r: number }[] = [];
    for (const p of this.spec.parts) {
      if (!isSolid(p)) continue;
      const long = Math.max(p.w, p.h);
      const r = this.spec.colRadius ?? Math.min(p.w, p.h) / 2;
      const axis = rotate(p.w >= p.h ? vec(1, 0) : vec(0, 1), p.langle ?? 0);
      const span = Math.max(0, long / 2 - r);
      const n = span < 1e-6 ? 1 : Math.max(2, Math.ceil((2 * span) / (2 * r)) + 1);
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
        out.push({ c: add(p.lpos, scale(axis, t)), r });
      }
    }
    return out;
  }

  // -------------------------------------------------------- world transforms --

  /** Part `i` as a world-frame box. Turret parts use their own aim angle. */
  private partBox(i: number): Box {
    const p = this.spec.parts[i];
    const pos = add(this.pos, rotate(p.lpos, this.angle));
    const angle = p.turret ? this.turretAngle[i] : this.angle + (p.langle ?? 0);
    return { pos, w: p.w, h: p.h, angle };
  }

  /** World position of seat `i`. */
  seatWorld(i: number): Vec2 {
    return add(this.pos, rotate(this.seats[i].spec.lpos, this.angle));
  }

  /** Every part in world space, for rendering. */
  worldParts(): PartWorld[] {
    return this.spec.parts.map((spec, i) => ({ box: this.partBox(i), spec }));
  }

  /** Solid parts as world boxes (movement/nav side — includes permeable ones). */
  movementBoxes(): Box[] {
    const out: Box[] = [];
    for (let i = 0; i < this.spec.parts.length; i++) {
      if (isSolid(this.spec.parts[i])) out.push(this.partBox(i));
    }
    return out;
  }

  /** World-space bounding box of the whole vehicle (culling + nav broad-phase). */
  aabb(): AABB {
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (let i = 0; i < this.spec.parts.length; i++) {
      const a = worldAabb(this.partBox(i));
      if (a.minx < minx) minx = a.minx;
      if (a.maxx > maxx) maxx = a.maxx;
      if (a.miny < miny) miny = a.miny;
      if (a.maxy > maxy) maxy = a.maxy;
    }
    return { minx, maxx, miny, maxy };
  }

  // ------------------------------------------------------------ hull queries --

  /** Does any SOLID part overlap the circle at `pt` (radius `r`)? Movement/nav.
   *  Caller checks z. Allocation-free (loops parts). */
  blocksCircle(pt: Vec2, r: number): boolean {
    const parts = this.spec.parts;
    for (let i = 0; i < parts.length; i++) {
      if (isSolid(parts[i]) && circleIntersectsBox(pt, r, this.partBox(i))) return true;
    }
    return false;
  }

  /** The SOLID, non-permeable part containing `pt`, or null — a round's hull hit. */
  roundPartAt(pt: Vec2): Box | null {
    const parts = this.spec.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!isSolid(p) || p.permeable) continue;
      const b = this.partBox(i);
      if (pointInBox(pt, b)) return b;
    }
    return null;
  }

  /** Does a SOLID, non-permeable part cross the segment a->b? (blast shielding.) */
  blocksSegment(a: Vec2, b: Vec2): boolean {
    const parts = this.spec.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!isSolid(p) || p.permeable) continue;
      if (segmentIntersectsBox(a, b, this.partBox(i))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- turrets ---

  /** The Gun backing the seat's turret, or null if the seat controls no turret. */
  turretGunForSeat(seatIndex: number): Gun | null {
    const t = this.seats[seatIndex]?.spec.turret;
    return t === undefined ? null : this.turretGun[t];
  }

  /** Point the seat's turret at world direction `dir`. No-op if it has no turret. */
  aimTurret(seatIndex: number, worldAngle: number): void {
    const t = this.seats[seatIndex]?.spec.turret;
    if (t !== undefined) this.turretAngle[t] = worldAngle;
  }

  /** Fire the seat's turret (mounted weapon), if it has one and can. The round
   *  spawns at the barrel muzzle — OUTSIDE the hull — so it clears its own vehicle
   *  without any owner exemption (cover is bidirectional). Returns true on a shot. */
  fireTurret(seatIndex: number, world: World, shooter: Character): boolean {
    const t = this.seats[seatIndex]?.spec.turret;
    if (t === undefined) return false;
    const gun = this.turretGun[t];
    const spec = this.spec.parts[t].turret;
    if (!gun || !spec) return false;
    const dir = fromAngle(this.turretAngle[t]);
    const pivot = add(this.pos, rotate(this.spec.parts[t].lpos, this.angle));
    const origin = add(pivot, scale(dir, spec.muzzle));
    return gun.fire(world, origin, dir, shooter, 0);
  }

  /** Per-tick upkeep for turret weapons (cooldown/flash/reload). */
  tick(): void {
    for (const g of this.turretGun) g?.tick();
  }

  // ------------------------------------------------------------ simulation ----

  /** Integrate driving, resolve out of static walls + other vehicles, then push
   *  the CCH update (sparse — see syncNav). Runs every tick for every vehicle. */
  drive(world: World, nav: NavGraph | null): void {
    this.integrate();
    this.collideStatic(world);
    this.collideVehicles(world);
    if (nav) this.syncNav(world, nav);
  }

  private integrate(): void {
    const s = this.spec;
    this.speed = (this.speed + s.accel * this.throttle) * s.friction;
    const cap = this.speed < 0 ? s.maxSpeed * s.reverseMul : s.maxSpeed;
    this.speed = Math.max(-cap, Math.min(cap, this.speed));
    if (Math.abs(this.speed) < 1e-4) this.speed = 0;

    let steer = this.steer;
    if (!s.turnAtRest) {
      steer *= Math.min(1, Math.abs(this.speed) / s.maxSpeed);
      if (this.speed < 0) steer = -steer; // reverse inverts steering
    }
    this.angle += s.turnRate * steer;

    const fwd = fromAngle(this.angle); // grippy: velocity always aligns with heading
    this.vel = scale(fwd, this.speed);
    this.pos = add(this.pos, this.vel);
  }

  /** Push every collision circle out of nearby static walls; damp speed if the
   *  correction opposes travel (hit a wall head-on). Two passes settle corners. */
  private collideStatic(world: World): void {
    const grid = world.grid;
    const before = vec(this.pos.x, this.pos.y);
    for (let pass = 0; pass < 2; pass++) {
      for (const lc of this.circles) {
        const c = add(this.pos, rotate(lc.c, this.angle));
        let p = c;
        if (grid) {
          grid.eachNear(c, lc.r, this.z, (o) => {
            p = resolveCircleVsBox(p, lc.r, o);
          });
        } else {
          for (const o of world.obstacles) {
            if (o.z === this.z) p = resolveCircleVsBox(p, lc.r, o);
          }
        }
        this.pos = add(this.pos, sub(p, c));
      }
    }
    const corr = sub(this.pos, before);
    if ((corr.x || corr.y) && dot(corr, fromAngle(this.angle)) * this.speed < 0) this.speed = 0;
  }

  /** Push out of other vehicles' solid parts (this vehicle yields; symmetric
   *  since every vehicle runs the same pass). */
  private collideVehicles(world: World): void {
    for (const other of world.vehicles) {
      if (other === this || other.z !== this.z) continue;
      const boxes = other.movementBoxes();
      if (boxes.length === 0) continue;
      for (const lc of this.circles) {
        const c = add(this.pos, rotate(lc.c, this.angle));
        let p = c;
        for (const b of boxes) p = resolveCircleVsBox(p, lc.r, b);
        this.pos = add(this.pos, sub(p, c));
      }
    }
  }

  // --------------------------------------------------------------- nav (CCH) --

  /** Re-derive which nav edges this vehicle's hull blocks and push ONLY the diff
   *  (edges that just started/stopped being blocked) to the CCH. Cheap by design:
   *  a vehicle blocking no edge (open ground) diffs to nothing; a parked one's set
   *  is stable so it stops paying; updateWalkability + customizeDirty are already
   *  local to the handful of touched edges. See nav.ts's CCH doc. */
  private syncNav(world: World, nav: NavGraph): void {
    const now = nav.candidateEdges(this);
    let changed = false;
    for (const key of now) if (!this.blocked.has(key)) { changed = true; break; }
    if (!changed) for (const key of this.blocked) if (!now.has(key)) { changed = true; break; }
    if (!changed) return;

    const pairs: [number, number][] = [];
    const n = nav.nodes.length;
    for (const key of now) if (!this.blocked.has(key)) pairs.push([Math.floor(key / n), key % n]);
    for (const key of this.blocked) if (!now.has(key)) pairs.push([Math.floor(key / n), key % n]);
    this.blocked.clear();
    for (const key of now) this.blocked.add(key);
    nav.updateWalkability(world, pairs);
  }
}
