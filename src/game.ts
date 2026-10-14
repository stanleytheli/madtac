/**
 * The play session: everything the fixed-timestep simulation owns and mutates —
 * the world, the live character roster, corpses, the human players, and the
 * active gamemode — plus the per-tick `update()` that drives them.
 *
 * Humans are PlayerSlots: a Character plus the per-person state the sim keeps
 * for it (its input for the tick, what it could pick up, its kill feed). Single
 * player is a Game with one slot whose input comes from the keyboard; a server
 * is a Game with a slot per connection (addHuman / removeHuman) whose inputs
 * come off the wire. `player` is the first slot's character — the local human
 * in single player, and what every script means by "the player". The page shell
 * (canvas, rendering, the RAF loop, input wiring) lives in main.ts and reads
 * this object; the level editor is a separate path that never builds a Game.
 *
 * The sim is PURE: it reads nothing but the PlayerInput it is handed (see
 * engine/command.ts), touches no DOM, plays no sound, and draws nothing. What
 * it wants the outside to hear or see goes out as World.events (see
 * engine/events.ts); what the client needs to smooth for the eye — the camera
 * zoom, the crosshair, the vision cone, floor fades — it asks for as targets
 * (zoomTarget, aimingGun) and eases itself (see ui/view.ts). That is what lets
 * the same class run headless in a script today and on a server later.
 *
 * Extracted from main.ts so a match can be *reset in place* (respawns, and the
 * "press Enter to restart" flow) without reloading the page — `reset()` rebuilds
 * the combat state and re-runs the gamemode's init. The static geometry and the
 * nav graph are untouched by a reset, so the player object is reused (revived,
 * never replaced) and every reference main.ts holds to it stays valid.
 */
import { Character, type Loadout } from "./entities/actor.ts";
import * as Armors from "./entities/armor.ts";
import { Body } from "./entities/body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./entities/character.ts";
import { startingUtilities } from "./entities/consumable.ts";
import { hasLineOfSight, ObstacleGrid, pointInBox, resolveCircleVsBox, resolveCircleVsObstacle } from "./engine/collision.ts";
import { KILLFEED_TTL, type GameCtx, type Gamemode, type KillFeedEntry, type PlayerLoadout } from "./gamemodes/gamemode.ts";
import { Gun } from "./entities/gun.ts";
import * as Guns from "./entities/guns.ts";
import { ArmorItem, GunItem, separateItems, UtilityItem, type Droppable, type GroundItem } from "./entities/item.ts";
import {
  ARMOR_SPECS,
  DEFAULT_PLAYER_PRIMARY,
  DEFAULT_PLAYER_SECONDARY,
  GUN_SPECS,
  SKINS,
  type LevelState,
} from "./world/level.ts";
import { NavGraph } from "./world/nav.ts";
import { profiler } from "./engine/profiler.ts";
import { Robot, type AiContext } from "./ai/robot.ts";
import { areHostile, type TeamId } from "./entities/team.ts";
import type { SlotKind } from "./ui/ui.ts";
import { heldOnly, idleInput, type PlayerInput } from "./engine/command.ts";
import { emitSound } from "./engine/events.ts";
import { MINIMAP_DEATH_TTL, type DeathMark } from "./ui/minimap.ts";
import { add, angleOf, dist, dot, fromAngle, len, norm, perp, scale, sub, vec, type Vec2 } from "./engine/vec.ts";
import { FOOTSTEP_LEAD, FOOTSTEP_MIN_SPEED, FOOTSTEP_SOUNDS, FOOTSTEP_TICKS } from "./world/hitsounds.ts";
import { stairClimbDir, stairZ, updateBullets, updateProjectiles, type World } from "./world/world.ts";
import { Vehicle, type VehicleSpec } from "./entities/vehicle.ts";

const PICKUP_RANGE = 75; // world px the player can reach a ground item from
const ENTER_RANGE = 160; // world px to a seat the player can board it from (hulls are big)

// --- inferred player route (nav congestion) ---------------------------------
/** How often the player's route is re-inferred (ticks). The inference costs a
 *  nearest-node scan, the same one a bot pays per re-plan, so it runs on a
 *  cadence rather than every tick. */
const PLAYER_ROUTE_TICKS = 15;
/** Hops of corridor projected ahead of the player. Short: it's a guess from a
 *  heading, and it goes stale as soon as they turn. */
const PLAYER_ROUTE_HOPS = 6;
/** Below this speed (world px/tick) the player isn't going anywhere, so there's
 *  no corridor to claim. */
const PLAYER_ROUTE_MIN_SPEED = 0.35;
/** How closely a graph edge must line up with the player's heading to count as
 *  "the way they're going" (cosine). ~60 degrees either side. */
const PLAYER_ROUTE_MIN_COS = 0.5;
// Body/wall separation (see separateCharacters / resolveWalls).
// One small squishy nudge per tick between touching bodies — LESS than a
// determined mutual push (2×moveSpeed ≈ 4.8/tick, more sprinting), so two bodies
// set on the same spot sink in and clip through instead of hard-locking; a
// casual one-sided bump (≈2.4/tick) still gets eased apart. This softness is the
// whole point: it's what lets a mutual wedge resolve.
const SQUISH_DELTA = 2.0; // max centre-line separation applied per tick (px)
const WALL_PASSES = 3; // push-out passes so a body in a corner (two walls) settles

/** The gun for a player slot: "none" = empty, omitted/unknown = the default. */
function slotGun(key: string | undefined, fallback: string): Gun | undefined {
  if (key === "none") return undefined;
  const spec = GUN_SPECS[key ?? fallback] ?? GUN_SPECS[fallback];
  return spec ? new Gun(spec) : undefined;
}

/** One human in the match: their character and everything the sim keeps per
 *  person rather than per world. See Game.humans. */
export class PlayerSlot {
  /** Their character. Revived in place across respawns, never replaced, so the
   *  reference (and its id) is stable for the life of the slot. */
  readonly char: Character;
  /** Display name (the callsign a gamemode gives them, or what they joined as). */
  name: string;
  /** Their intent for the coming tick (see engine/command.ts). Presses are
   *  consumed by update() — cleared after the tick they were applied — so an
   *  input that isn't refreshed keeps its held state but repeats no press. */
  input: PlayerInput = idleInput();
  /** Whether their input drove them last tick: alive, and the match not yet
   *  decided. What the HUD's crosshair reads to know when to close. */
  controllable = true;
  /** Nearest reachable ground item this tick (for the HUD prompt + E). */
  interactable: GroundItem | null = null;
  /** Nearest empty vehicle seat they could board this tick (on foot). E
   *  boards it; while seated, E exits. */
  enterable: { vehicle: Vehicle; seat: number } | null = null;
  /** Recent FRIENDLY death locations (non-hostile to them), for the minimap
   *  X's. Appended in reapDead, aged + pruned in despawnStale, cleared on reset. */
  readonly minimapDeaths: DeathMark[] = [];
  /** Their recent-kills feed (the stacked bars above the ammo). The gamemode
   *  unshifts a credited kill (newest first); despawnStale ages them and drops
   *  any past KILLFEED_TTL; cleared on reset. */
  readonly killFeed: KillFeedEntry[] = [];

  constructor(char: Character, name: string) {
    this.char = char;
    this.name = name;
  }
}

/** How many humans a Game is built with. Default 1 — the local player. A
 *  server builds with 0 and adds one per connection (addHuman). */
export interface GameOptions {
  humans?: number;
}

export class Game implements GameCtx {
  readonly world: World;
  readonly nav: NavGraph | null;
  readonly characters: Character[] = [];
  readonly bodies: Body[] = [];
  /** The humans in the match, in join order. See PlayerSlot. */
  readonly humans: PlayerSlot[] = [];
  tick = 0;

  /** Ground items the level shipped with — restored on reset so death-drops
   *  from a finished match don't pile up across restarts. */
  private readonly initialItems: readonly GroundItem[];

  /** The vehicles the level shipped with, as authored transforms — rebuilt fresh
   *  each match in start() (so a reset ejects occupants and restores positions),
   *  and kept OUT of the nav baseline (see the constructor). */
  private readonly initialVehicles: readonly { spec: VehicleSpec; pos: Vec2; angle: number; z: number }[];

  constructor(
    readonly level: LevelState,
    readonly gamemode: Gamemode,
    opts: GameOptions = {},
  ) {
    this.world = level.world;
    this.initialItems = level.world.items.slice();
    // Snapshot the authored vehicles, then clear the live list BEFORE the nav
    // graph is built: the CCH baseline must be the vehicle-free map, so each
    // vehicle's hull is a pure dynamic delta applied later via updateWalkability
    // (see start() -> the initial drive() sync). start() rebuilds them fresh.
    this.initialVehicles = level.world.vehicles.map((v) => ({
      spec: v.spec,
      pos: vec(v.pos.x, v.pos.y),
      angle: v.angle,
      z: v.z,
    }));
    this.world.vehicles.length = 0;
    // Build the sight index before the nav graph so the graph's edge-visibility
    // build rides the fast line-of-sight path too.
    this.world.grid = new ObstacleGrid(this.world.obstacles);
    this.nav = new NavGraph(this.world);
    for (let i = 0; i < (opts.humans ?? 1); i++) this.addHuman(`Player ${i + 1}`, false);
    this.start();
  }

  /** The first human's character: the local player in single player, and what
   *  a script means by "the player". A Game built with no humans has none —
   *  every path inside the sim goes through `humans` instead. */
  get player(): Character {
    const first = this.humans[0];
    if (!first) throw new Error("Game has no human player");
    return first.char;
  }

  /** The slot driving `c`, or undefined for a bot. */
  slotOf(c: Character): PlayerSlot | undefined {
    return this.humans.find((h) => h.char === c);
  }

  /**
   * Add a human to the match: a fresh character at the level's player spawn,
   * with the level's kit. In a running match the gamemode is told (onHumanJoin)
   * so it can put them on a team and spawn them properly; at construction the
   * slots are built first and start() -> gamemode.init handles them all at once
   * (`announce` = false).
   */
  addHuman(name: string, announce = true): PlayerSlot {
    const spawn = this.level.playerSpawn[0];
    const char = new Character(
      vec(spawn?.pos.x ?? 0, spawn?.pos.y ?? 0),
      SKINS[spawn?.skin ?? ""] ?? DEFAULT_SKIN,
      this.playerLoadout(),
    );
    char.z = spawn?.z ?? 0;
    char.team = "player";
    char.events = this.world.events;
    const slot = new PlayerSlot(char, name);
    this.humans.push(slot);
    if (announce) {
      this.spawnHumanAtLevelSpawn(slot);
      if (!this.characters.includes(char)) this.characters.push(char);
      this.gamemode.onHumanJoin?.(this, char);
    }
    return slot;
  }

  /** A human left: their character leaves the roster without a corpse (they
   *  didn't die), the gamemode is told so it can fill the gap, and the slot is
   *  dropped. Its character object stays valid for anyone still holding it. */
  removeHuman(slot: PlayerSlot): void {
    const i = this.humans.indexOf(slot);
    if (i < 0) return;
    const c = slot.char;
    if (c.vehicle) this.exitVehicle(slot);
    c.cancelAction();
    if (this.nav) this.nav.setRoute(c, [], c.team);
    this.gamemode.onHumanLeave?.(this, c);
    const ci = this.characters.indexOf(c);
    if (ci >= 0) this.characters.splice(ci, 1);
    this.humans.splice(i, 1);
  }

  /** Put a human back at the level's authored player spawn with its kit. */
  private spawnHumanAtLevelSpawn(slot: PlayerSlot): void {
    const spawn = this.level.playerSpawn[0];
    slot.char.respawn(vec(spawn?.pos.x ?? 0, spawn?.pos.y ?? 0), spawn?.z ?? 0, this.playerLoadout());
    if (spawn?.armor && ARMOR_SPECS[spawn.armor]) {
      slot.char.equipArmor(new Armors.Armor(ARMOR_SPECS[spawn.armor]));
    }
  }

  /** A fresh loadout matching the level's player spawn (or the classic kit). */
  private playerLoadout(): Loadout {
    const spawn = this.level.playerSpawn[0];
    return {
      primary: slotGun(spawn?.primary, DEFAULT_PLAYER_PRIMARY),
      secondary: slotGun(spawn?.secondary, DEFAULT_PLAYER_SECONDARY),
      hand: new Gun(Guns.UNARMED),
      utilities: startingUtilities(),
    };
  }

  /** Begin (or restart) the match: clear combat state, put the player back at
   *  its spawn, then let the gamemode place teams and do its initial spawns. */
  start(): void {
    this.tick = 0;
    // The nav graph outlives a match, so last match's committed routes would
    // otherwise still be congesting corridors nobody is walking.
    this.nav?.clearRoutes();
    this.bodies.length = 0;
    this.world.bullets.length = 0;
    this.world.particles.length = 0;
    this.world.decals.length = 0;
    this.world.scorches.length = 0;
    this.world.events.length = 0;
    this.world.items.length = 0;
    this.world.items.push(...this.initialItems);
    for (const h of this.humans) {
      h.minimapDeaths.length = 0;
      h.killFeed.length = 0;
      h.interactable = null;
      h.enterable = null;
    }

    // Rebuild vehicles fresh from the authored transforms (drops any occupants,
    // restores positions), then apply each one's footprint to the CCH — a first
    // drive() with zero throttle just settles it out of walls and runs syncNav.
    this.world.vehicles.length = 0;
    for (const iv of this.initialVehicles) {
      this.world.vehicles.push(new Vehicle(iv.spec, iv.pos, iv.angle, iv.z));
    }
    for (const v of this.world.vehicles) v.drive(this.world, this.nav);

    this.characters.length = 0;
    for (const h of this.humans) {
      this.spawnHumanAtLevelSpawn(h);
      this.characters.push(h.char);
    }

    this.gamemode.init(this);
  }

  reset(): void {
    this.start();
  }

  // --- GameCtx helpers ---------------------------------------------------------

  addCharacter(c: Character): void {
    c.events = this.world.events; // its sounds go where everyone else's do
    this.characters.push(c);
  }

  /** A random point inside a random zone of `team`, nudged clear of obstacles. */
  spawnPoint(team: TeamId): { pos: Vec2; z: number } | null {
    const zones = this.level.spawnZones.filter((z) => z.team === team);
    if (zones.length === 0) return null;
    const zone = zones[Math.floor(Math.random() * zones.length)];
    const lx = (Math.random() - 0.5) * zone.w;
    const ly = (Math.random() - 0.5) * zone.h;
    const a = zone.angle ?? 0;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let pos = vec(zone.pos.x + lx * cos - ly * sin, zone.pos.y + lx * sin + ly * cos);
    for (const o of this.world.obstacles) {
      if (o.z === zone.z) pos = resolveCircleVsObstacle(pos, BODY_RADIUS, o);
    }
    return { pos, z: zone.z };
  }

  /** Reset a human's character in place at a spawn point and re-add it to the
   *  roster. With `loadout` (GUN_SPECS / ARMOR_SPECS keys) they are re-armed to
   *  that kit; without it they keep their current weapons + the level's spawn
   *  armor. Guns are rebuilt from spec, so ammo is always full. */
  reviveHuman(who: Character, pos: Vec2, z: number, loadout?: PlayerLoadout): void {
    let kit: Loadout;
    let armorKey: string | undefined;
    if (loadout) {
      kit = {
        primary: loadout.primary ? slotGun(loadout.primary, DEFAULT_PLAYER_PRIMARY) : undefined,
        secondary: loadout.secondary ? slotGun(loadout.secondary, DEFAULT_PLAYER_SECONDARY) : undefined,
        hand: new Gun(Guns.UNARMED),
        utilities: startingUtilities(),
      };
      armorKey = loadout.armor;
    } else {
      // Keep whatever the player was carrying, rebuilt from spec so ammo refills.
      const clone = (g: Gun | null): Gun | undefined => (g ? new Gun(g.spec) : undefined);
      kit = {
        primary: clone(who.slots.primary),
        secondary: clone(who.slots.secondary),
        hand: new Gun(Guns.UNARMED),
        utilities: startingUtilities(),
      };
      armorKey = this.level.playerSpawn[0]?.armor;
    }
    who.respawn(vec(pos.x, pos.y), z, kit);
    if (armorKey && ARMOR_SPECS[armorKey]) {
      who.equipArmor(new Armors.Armor(ARMOR_SPECS[armorKey]));
    }
    if (!this.characters.includes(who)) this.characters.push(who);
  }

  /** Take a character out of the roster without a death: no corpse, no drops,
   *  no gamemode death. For a bot a human is replacing (see onHumanJoin). */
  removeCharacter(c: Character): void {
    c.cancelAction();
    if (c.vehicle) {
      const s = c.vehicle.seats[c.seatIndex];
      if (s) s.occupant = null;
      c.vehicle = null;
      c.seatIndex = -1;
    }
    if (this.nav) this.nav.setRoute(c, [], c.team);
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
  }

  // --- simulation --------------------------------------------------------------

  /** The camera's zoom target: the equipped gun's zoom bent by the floor
   *  underfoot. Only ONE floor's deltaZoom applies at a time — overlapping
   *  lookout floors don't stack; the last (topmost, by render order) wins.
   *  A target only: the client eases its camera toward it (see ui/view.ts). */
  zoomTarget(slot: PlayerSlot): number {
    const p = slot.char;
    let abs: number | null = null;
    let delta = 0;
    for (const f of this.world.floors) {
      if (f.level !== p.z || (f.zoom === undefined && f.deltaZoom === undefined)) continue;
      if (!f.infinite && !pointInBox(p.pos, f)) continue;
      if (f.zoom !== undefined) abs = f.zoom;
      if (f.deltaZoom !== undefined) delta = f.deltaZoom;
    }
    return Math.max(0.3, abs ?? p.gun.spec.zoom + delta);
  }

  /** The crosshair's spread target: what the aimed gun would do at the human's
   *  current speed, or closed while they can't act. Eased by the client. */
  spreadTarget(slot: PlayerSlot): number {
    return slot.controllable ? this.aimingGun(slot).maxSpread(slot.char.speedRatio) : 0;
  }

  /** The sight mask's vision cone target, degrees (360 = all round): the aimed
   *  weapon's. Eased by the client. */
  visionConeTarget(slot: PlayerSlot): number {
    return this.aimingGun(slot).spec.visionCone ?? 360;
  }

  /** Resolve `c` against WALLS: it has already moved this tick (pos += vel), so
   *  just push it out of any wall it now overlaps. No sweep is needed — at the
   *  game's body speeds (max ~7.5 px/tick, far below the 60px body diameter) a
   *  body can't jump across a wall in one tick, and pushing out along the wall's
   *  nearest feature slides the body along it for free. Body-vs-body is the
   *  separate squishy pass (see separateCharacters). */
  private resolveCollisions(c: Character): void {
    const before = c.pos;
    c.pos = this.resolveWalls(c.pos, c.z);
    c.pos = this.resolveVehicles(c.pos, c.z);
    // The push-out moved the body, not its velocity: pressing into a wall left
    // `vel` at full running speed while the body stood still, so everything
    // that reads speed (spread, footsteps, the no-scope mark, the player's
    // inferred route) behaved as if it were sprinting. Cancel the component of
    // vel that points into the wall (the push direction), keep the rest so a
    // glancing approach still slides along it at the slide speed.
    const push = sub(c.pos, before);
    const pl = len(push);
    if (pl > 1e-6) {
      const n = scale(push, 1 / pl);
      const into = dot(c.vel, n);
      if (into < 0) c.vel = sub(c.vel, scale(n, into));
    }
  }

  /** Push a body at `pos` out of every vehicle's solid parts on level `z` — a
   *  pedestrian can't stand inside a hull (occupants are pinned and skip this).
   *  A moving vehicle thus shoves anyone it drives into (they're re-ejected each
   *  tick as the hull advances). No-op when the map has no vehicles. */
  private resolveVehicles(pos: Vec2, z: number): Vec2 {
    for (const v of this.world.vehicles) {
      if (v.z !== z) continue;
      for (const b of v.movementBoxes()) pos = resolveCircleVsBox(pos, BODY_RADIUS, b);
    }
    return pos;
  }

  /** Push a body at `pos` out of every wall it overlaps on level `z`, a few
   *  passes so a corner between two walls settles (each push-out can nudge it
   *  into the neighbour). Uses the grid to touch only nearby obstacles. */
  private resolveWalls(pos: Vec2, z: number): Vec2 {
    const grid = this.world.grid;
    for (let i = 0; i < WALL_PASSES; i++) {
      if (grid) {
        grid.eachNear(pos, BODY_RADIUS, z, (o) => {
          pos = resolveCircleVsObstacle(pos, BODY_RADIUS, o);
        });
      } else {
        for (const o of this.world.obstacles) {
          if (o.z === z) pos = resolveCircleVsObstacle(pos, BODY_RADIUS, o);
        }
      }
    }
    return pos;
  }

  /** Squishy bodies: push every overlapping pair of live characters apart,
   *  EQUALLY — each gives way half the penetration along their centre line — then
   *  re-project everyone out of walls (walls are immovable, so a body squeezed
   *  between a wall and another body ends against the wall). Order-independent and
   *  symmetric by construction: no agent has priority, a mover and the body it
   *  walks into both yield, and crowds part instead of one jamming behind another.
   *  SQUISHY: one small nudge per tick, NOT the full penetration and NOT iterated
   *  — two bodies driven together harder than SQUISH_DELTA/tick sink in and clip
   *  through rather than hard-locking (the fix for the mutual-wedge freeze: there
   *  is no longer a rigid wall for two determined agents to jam against). A casual
   *  one-sided bump is below the delta, so it still eases apart and doesn't clip.
   *  Per-tick movement is far below a body diameter, so nothing tunnels between
   *  ticks. This IS the whole body-collision model — the wall side is a plain
   *  push-out (resolveWalls); together they replaced the swept normal system. */
  private separateCharacters(): void {
    // Occupants are pinned to their seats — never squished against other bodies.
    const cs = this.characters.filter((c) => c.hp > 0 && !c.vehicle);
    const diam = 2 * BODY_RADIUS;
    const diam2 = diam * diam;
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j];
        if (a.z !== b.z) continue;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= diam2) continue; // not touching
        let nx: number;
        let ny: number;
        let overlap: number;
        if (d2 < 1e-6) {
          // Exactly coincident: ease apart along a deterministic axis so the
          // split is stable (no NaN, no random jitter).
          const a2 = (i + 1) * 2.399;
          nx = Math.cos(a2);
          ny = Math.sin(a2);
          overlap = diam;
        } else {
          const d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
          overlap = diam - d;
        }
        // A single small correction along the centre line, capped at the actual
        // overlap so it never opens a gap past touching. PURELY radial — no
        // tangential component: a fixed-handedness slip integrates into an orbit
        // (two bodies driving at a common point circled each other), so radial
        // only. Offset contacts still slide (the normal carries a lateral part).
        const half = Math.min(SQUISH_DELTA, overlap) * 0.5;
        a.pos = vec(a.pos.x - nx * half, a.pos.y - ny * half);
        b.pos = vec(b.pos.x + nx * half, b.pos.y + ny * half);
      }
    }
    // Walls win: re-project everyone out of walls (and vehicle hulls) after the
    // nudge so a shove can't leave a body inside a wall (a body squeezed between a
    // wall and another body ends against the wall — the least-bad spot, not a freeze).
    for (const c of cs) {
      c.pos = this.resolveWalls(c.pos, c.z);
      c.pos = this.resolveVehicles(c.pos, c.z);
    }
  }

  /** Flip `c`'s z at any stair midpoint it's standing on. Called right after a
   *  character moves and before it resolves collisions, so it always resolves
   *  against the level it actually ended up on — crossing the midpoint used to
   *  resolve against the OLD level, then snap (or clip through a wall) next tick. */
  private applyStairZ(c: Character): void {
    for (const s of this.world.stairs) {
      const z = stairZ(s, c.pos);
      if (z !== null) c.z = z;
    }
  }

  /** The climb-axis direction of the staircase `c` is standing on, or null if on
   *  none. Handed to the Character so its move() can slow the climb (see
   *  Character.onStairs) — the world-aware half of that feature. */
  private stairDirAt(c: Character): Vec2 | null {
    for (const s of this.world.stairs) {
      if (stairZ(s, c.pos) !== null) return stairClimbDir(s);
    }
    return null;
  }

  /** Nearest ground item on the human's level, within reach and line of sight. */
  private findInteractable(p: Character): GroundItem | null {
    let best: GroundItem | null = null;
    let bestD = Infinity;
    for (const it of this.world.items) {
      const onStairs = this.world.stairs.some((s) => stairZ(s, it.pos) !== null);
      if (it.z !== p.z && !onStairs) continue;
      const d = dist(p.pos, it.pos);
      if (d > PICKUP_RANGE || d >= bestD) continue;
      if (!hasLineOfSight(p.pos, it.pos, this.world.obstacles, p.z)) continue;
      best = it;
      bestD = d;
    }
    return best;
  }

  /** The nearest empty vehicle seat the player could board: on the player's z,
   *  within ENTER_RANGE, with clear line of sight to the seat. LOS uses only the
   *  static walls (the vehicle's OWN hull doesn't block — boarding "through" its
   *  walls is the whole point), so you can't board through a map wall. */
  private findEnterable(p: Character): { vehicle: Vehicle; seat: number } | null {
    let best: { vehicle: Vehicle; seat: number } | null = null;
    let bestD = Infinity;
    for (const v of this.world.vehicles) {
      if (v.z !== p.z) continue;
      for (let i = 0; i < v.seats.length; i++) {
        if (v.seats[i].occupant) continue;
        const sp = v.seatWorld(i);
        const d = dist(p.pos, sp);
        if (d > ENTER_RANGE || d >= bestD) continue;
        if (!hasLineOfSight(p.pos, sp, this.world.obstacles, p.z)) continue;
        best = { vehicle: v, seat: i };
        bestD = d;
      }
    }
    return best;
  }

  /** E on foot: board the boardable seat, else pick up the item (at most one of
   *  the two is set — see update()). Seated: E exits. */
  private interact(slot: PlayerSlot): void {
    if (slot.char.vehicle) this.exitVehicle(slot);
    else if (slot.enterable) this.enterVehicle(slot, slot.enterable);
    else if (slot.interactable) this.pickUp(slot, slot.interactable);
  }

  enterVehicle(slot: PlayerSlot, t: { vehicle: Vehicle; seat: number }): void {
    const p = slot.char;
    t.vehicle.seats[t.seat].occupant = p;
    p.vehicle = t.vehicle;
    p.seatIndex = t.seat;
    p.vel = vec(0, 0);
    p.pos = t.vehicle.seatWorld(t.seat);
    p.z = t.vehicle.z;
    slot.interactable = null;
    slot.enterable = null;
  }

  exitVehicle(slot: PlayerSlot): void {
    const p = slot.char;
    const v = p.vehicle;
    if (!v) return;
    const seat = p.seatIndex;
    if (v.seats[seat]) v.seats[seat].occupant = null;
    v.throttle = 0; // stop driving the instant you step out
    v.steer = 0;
    p.pos = this.exitSpot(v, seat);
    p.z = v.z;
    p.vel = vec(0, 0);
    p.vehicle = null;
    p.seatIndex = -1;
  }

  /** A free spot to step out to beside `seat`: try left, right, behind, ahead of
   *  the hull (far enough to clear it), and take the first that's clear of static
   *  walls AND every vehicle hull. Falls back to the seat pushed out of walls, so
   *  exiting never clips the player into a wall. */
  private exitSpot(v: Vehicle, seat: number): Vec2 {
    const fwd = fromAngle(v.angle);
    const right = perp(fwd);
    const box = v.aabb();
    const reach = 0.5 * Math.max(box.maxx - box.minx, box.maxy - box.miny) + BODY_RADIUS + 15;
    const seatW = v.seatWorld(seat);
    for (const dir of [right, scale(right, -1), scale(fwd, -1), fwd]) {
      const cand = add(seatW, scale(dir, reach));
      if (this.spotClear(cand, v.z)) return cand;
    }
    return this.resolveWalls(seatW, v.z);
  }

  /** Is a body at `pos` on `z` clear of every static wall and vehicle hull? */
  private spotClear(pos: Vec2, z: number): boolean {
    const rw = this.resolveWalls(pos, z);
    if (rw.x !== pos.x || rw.y !== pos.y) return false; // pushed => inside a wall
    for (const v of this.world.vehicles) {
      if (v.z === z && v.blocksCircle(pos, BODY_RADIUS)) return false;
    }
    return true;
  }

  /** Route the player's WASD to the driven vehicle — throttle forward/back, steer
   *  left/right, RELATIVE to the hull's facing — and aim its turret at the mouse.
   *  A passenger seat has no driving controls (it only aims a turret if it owns one). */
  private driveInput(slot: PlayerSlot, input: PlayerInput): void {
    const v = slot.char.vehicle!;
    const seat = slot.char.seatIndex;
    const spec = v.seats[seat]?.spec;
    if (!spec) return;
    if (spec.role === "driver") {
      v.throttle = -input.move.y; // W (screen-up = -y) drives forward along the hull
      v.steer = input.move.x; // D (+x) steers right
    }
    if (spec.turret !== undefined) v.aimTurret(seat, angleOf(input.aim));
  }

  /** The interaction prompt text for the HUD: "Exit" while seated, else "Enter
   *  <vehicle>" or the item's label (at most one is active — see update()). */
  interactLabel(slot: PlayerSlot): string | null {
    if (slot.char.vehicle) return "Exit";
    if (slot.enterable) return `Enter ${slot.enterable.vehicle.spec.name}`;
    return slot.interactable ? slot.interactable.label : null;
  }

  private tossVel(): Vec2 {
    return fromAngle(Math.random() * Math.PI * 2, 9.5);
  }

  /** Put a dropped piece of gear on the ground (via its own getGroundItem) at
   *  (pos, z), tossed with `vel`, and stamp it with the gamemode's despawn timer —
   *  so voluntary drops (Q, HUD right-click, pickup swaps) age out exactly like
   *  death drops instead of lingering forever. */
  private dropToWorld(gear: Droppable, pos: Vec2, vel: Vec2, z: number): void {
    const it = gear.getGroundItem(pos, vel, z);
    it.lifetime = this.gamemode.itemTtl ?? null;
    this.world.items.push(it);
  }

  private pickUp(slot: PlayerSlot, item: GroundItem): void {
    const p = slot.char;
    const idx = this.world.items.indexOf(item);
    if (idx >= 0) this.world.items.splice(idx, 1);
    const here = (): Vec2 => vec(p.pos.x, p.pos.y);

    if (item instanceof GunItem) {
      const dropped = p.holster(item.gun);
      if (dropped) this.dropToWorld(dropped, here(), this.tossVel(), p.z);
    } else if (item instanceof ArmorItem) {
      const prev = p.equipArmor(item.armor);
      if (prev) this.dropToWorld(prev, here(), this.tossVel(), p.z);
    } else if (item instanceof UtilityItem) {
      // Take what fits (capped at the spec's maxCarry); leave any remainder on
      // the ground so a full belt doesn't silently swallow the pile.
      const took = p.addUtility(item.spec, item.count);
      item.count -= took;
      if (item.count > 0) this.world.items.push(item); // re-add the leftover stack
    }
    slot.interactable = null;
  }

  private dropEquippedWeapon(p: Character): void {
    const dropped = p.dropEquipped();
    if (dropped) this.dropToWorld(dropped, vec(p.pos.x, p.pos.y), this.tossVel(), p.z);
  }

  private dropFromHud(p: Character, kind: SlotKind): void {
    let gear: Droppable | null = null;
    if (kind === "armor") gear = p.dropArmor();
    else if (kind === "utility") gear = p.dropCurrentUtility();
    else if (kind === "melee") return; // fists — nothing to drop
    else gear = p.dropSlot(kind);
    if (gear) this.dropToWorld(gear, vec(p.pos.x, p.pos.y), this.tossVel(), p.z);
  }

  /** Convert any character at 0 HP into a corpse, dropping its gear, and remove
   *  it — signalling the gamemode first so it can score/schedule respawns. */
  /**
   * Declare the player's likely path to the nav congestion field, so bots route
   * around it exactly as they route around each other.
   *
   * Bots publish a route because they HAVE one — a plan with a goal. The player
   * never states a destination, so it's inferred the way you'd infer any walker's
   * from the outside: start at the node they're standing on and follow the graph
   * in the direction they're actually moving, a few hops. Stop moving (or get in
   * a vehicle, or die) and the claim is withdrawn.
   */
  private updatePlayerRoute(p: Character): void {
    const nav = this.nav;
    if (!nav || this.tick % PLAYER_ROUTE_TICKS !== 0) return;
    if (p.hp <= 0 || p.vehicle || p.speed < PLAYER_ROUTE_MIN_SPEED) {
      nav.setRoute(p, [], p.team);
      return;
    }
    const start = nav.nearestWalkable(this.world, p.pos, p.z);
    if (start < 0) {
      nav.setRoute(p, [], p.team);
      return;
    }
    const dir = norm(p.vel);
    const nodes = [start];
    let cur = start;
    for (let hop = 0; hop < PLAYER_ROUTE_HOPS; hop++) {
      let best = -1;
      let bestCos = PLAYER_ROUTE_MIN_COS;
      for (const nb of nav.nodes[cur].movable.keys()) {
        const to = nav.nodes[nb];
        if (to.z !== p.z || nodes.includes(nb)) continue;
        const dx = to.pos.x - nav.nodes[cur].pos.x;
        const dy = to.pos.y - nav.nodes[cur].pos.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const cos = (dx * dir.x + dy * dir.y) / len;
        if (cos > bestCos) {
          bestCos = cos;
          best = nb;
        }
      }
      if (best < 0) break; // nothing ahead of them: the corridor ends here
      nodes.push(best);
      cur = best;
    }
    nav.setRoute(p, nodes, p.team);
  }

  /** The weapon the player's aim actually drives: a turret when seated in one,
   *  otherwise the held gun. One definition, so the trigger and the crosshair
   *  can never disagree about which gun's spread is on screen. */
  aimingGun(slot: PlayerSlot): Gun {
    const p = slot.char;
    const veh = p.vehicle;
    if (!veh) return p.gun;
    return veh.turretGunForSeat(p.seatIndex) ?? p.gun;
  }

  private reapDead(): void {
    // Death-drops and corpses inherit the gamemode's despawn timers (null = the
    // object's default: linger forever). Authored pickups are never stamped.
    // Item TTL is applied by dropToWorld; corpses take bodyTtl here.
    const bodyTtl = this.gamemode.bodyTtl ?? null;
    for (let i = this.characters.length - 1; i >= 0; i--) {
      const c = this.characters[i];
      if (c.hp > 0) continue;

      // Abort whatever it was in the middle of. Every other way a reload ends —
      // X, a weapon switch, dropping the gun — goes through cancelReload, but
      // dying never did: the corpse leaves this list and simply stops ticking,
      // so its reload clip would play on to the end over a dead body.
      c.cancelAction();

      // A dead occupant frees its seat and stops driving (the body drops at the seat).
      if (c.vehicle) {
        const s = c.vehicle.seats[c.seatIndex];
        if (s) s.occupant = null;
        c.vehicle.throttle = 0;
        c.vehicle.steer = 0;
        c.vehicle = null;
        c.seatIndex = -1;
      }

      // Withdraw any committed route from the nav congestion field — a corpse
      // must not keep a corridor looking busy.
      if (this.nav) this.nav.setRoute(c, [], c.team);

      this.gamemode.onDeath(c, this);

      // Mark friendly deaths on each human's minimap (enemies aren't shown at all).
      for (const h of this.humans) {
        if (!areHostile(h.char.team, c.team)) h.minimapDeaths.push({ pos: vec(c.pos.x, c.pos.y), z: c.z, age: 0 });
      }

      // All the dead character's gear, each tossed out on its own random spurt
      // and stamped with the gamemode's death-drop despawn timer.
      const gear: Droppable[] = [...c.dropWeapons(), ...c.dropUtilities()];
      const armor = c.dropArmor();
      if (armor) gear.push(armor);
      for (const g of gear) {
        const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
        this.dropToWorld(g, vec(c.pos.x, c.pos.y), vel, c.z);
      }
      const body = Body.fromCharacter(c);
      body.lifetime = bodyTtl;
      this.bodies.push(body);
      this.characters.splice(i, 1);
    }
  }

  /** Remove corpses and death-dropped items that have outlived their lifetime. */
  private despawnStale(): void {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      if (this.bodies[i].expired) this.bodies.splice(i, 1);
    }
    for (let i = this.world.items.length - 1; i >= 0; i--) {
      const it = this.world.items[i];
      if (it.lifetime !== null && it.age >= it.lifetime) this.world.items.splice(i, 1);
    }
    for (const h of this.humans) {
      // Age + prune the minimap's recent-death marks.
      for (let i = h.minimapDeaths.length - 1; i >= 0; i--) {
        if (++h.minimapDeaths[i].age > MINIMAP_DEATH_TTL) h.minimapDeaths.splice(i, 1);
      }
      // Age + prune the kill feed (the count cap is enforced at push time).
      for (let i = h.killFeed.length - 1; i >= 0; i--) {
        if (++h.killFeed[i].age > KILLFEED_TTL) h.killFeed.splice(i, 1);
      }
    }
  }

  /** One tick. `input` is the human player's intent for it (see
   *  engine/command.ts); omitted = an idle player, which is what a headless
   *  script's is. Last tick's events are dropped first — read them in between. */
  /**
   * One tick. `input` is the FIRST human's intent for it (single player: the
   * keyboard's, see engine/command.ts); every other slot's input is whatever
   * was last set on it (a server sets each from the wire before calling this).
   * Presses are consumed: after the tick each slot keeps only its held state.
   * Last tick's events are dropped first — read them in between.
   */
  update(input?: PlayerInput): void {
    this.tick += 1;
    this.world.events.length = 0;
    if (input && this.humans[0]) this.humans[0].input = input;

    // Match decided: freeze the humans, let the scene keep breathing, and take
    // the restart key from anyone.
    const over = this.gamemode.hud(this)?.over ?? false;
    if (over && this.humans.some((h) => h.input.restart)) {
      for (const h of this.humans) h.input = heldOnly(h.input);
      this.reset();
      return;
    }

    for (const h of this.humans) this.prepareHuman(h, over);

    // Refresh every character's staircase state before anyone moves, so the climb
    // slowdown (Character.move / applyStairMove) and the recoil speed both see it.
    for (const c of this.characters) c.onStairs = this.stairDirAt(c);

    for (const h of this.humans) this.moveHuman(h);

    // Vehicles: integrate physics + sync the CCH every tick. Only a human-driven
    // vehicle carries nonzero throttle/steer (set in driveInput); the rest idle.
    // Then pin every occupant to its seat (they don't move or collide on their own).
    for (const v of this.world.vehicles) {
      v.tick();
      v.drive(this.world, this.nav);
    }
    for (const v of this.world.vehicles) {
      for (let i = 0; i < v.seats.length; i++) {
        const occ = v.seats[i].occupant;
        if (occ && occ.hp > 0) {
          occ.pos = v.seatWorld(i);
          occ.z = v.z;
          occ.vel = vec(0, 0);
          occ.onStairs = null;
        }
      }
    }

    for (const c of this.characters) c.tickWeapon();
    // Belt/status upkeep (heal-use timer, regen). Runs before bullets resolve, so
    // a regen tick can't revive someone the same tick a lethal shot lands.
    for (const c of this.characters) c.tickStatus();

    for (const h of this.humans) {
      this.fireHuman(h);
      h.input = heldOnly(h.input); // presses consumed; held state carries
    }

    profiler.begin("ai");
    const ai: AiContext = {
      world: this.world,
      characters: this.characters,
      nav: this.nav,
      tick: this.tick,
      objectives: this.gamemode.objectives?.(this),
    };
    for (const c of this.characters) {
      if (c instanceof Robot && c.hp > 0) c.think(ai);
    }
    profiler.end("ai");

    // Footsteps, everyone's: on foot and moving, one every FOOTSTEP_TICKS,
    // clips cycled. Positional at the walker's feet — a human's own sit in
    // the same mix as the world's, and an unseen bot's carry through walls.
    // After the AI phase so a bot's step this tick is in its vel.
    for (const c of this.characters) {
      if (c.hp > 0 && !c.vehicle && Math.hypot(c.vel.x, c.vel.y) >= FOOTSTEP_MIN_SPEED) {
        c.stepTicks += 1;
        if (c.stepTicks >= FOOTSTEP_TICKS) {
          c.stepTicks = 0;
          emitSound(this.world.events, FOOTSTEP_SOUNDS[c.stepIndex], { pos: c.pos, z: c.z, pitchVar: 0.06 });
          c.stepIndex = (c.stepIndex + 1) % FOOTSTEP_SOUNDS.length;
        }
      } else {
        c.stepTicks = FOOTSTEP_TICKS - FOOTSTEP_LEAD;
      }
    }

    profiler.begin("collide");
    for (const c of this.characters) {
      if (c.vehicle || this.slotOf(c)) continue; // humans resolved above; occupants are pinned
      this.applyStairZ(c); // flip z after this tick's move, before resolving (see applyStairZ)
      this.resolveCollisions(c);
    }
    // Body-vs-body last, as one symmetric pass over all characters — every agent
    // treated equally (no resolve-order priority; the humans included).
    this.separateCharacters();
    profiler.end("collide");

    profiler.begin("bullets");
    updateBullets(this.world, this.characters);
    updateProjectiles(this.world, this.characters);
    profiler.end("bullets");

    profiler.begin("items");
    for (const b of this.bodies) b.update(this.world.obstacles);
    for (const it of this.world.items) it.update(this.world.obstacles);
    separateItems(this.world.items);
    profiler.end("items");

    profiler.begin("rules");
    this.reapDead();
    // Rules evaluation runs after the dead are reaped and scored.
    this.gamemode.update(this);
    // Clear corpses/drops that have aged out (TDM; no-op when no TTL is set).
    this.despawnStale();
    profiler.end("rules");
  }

  /** The start of a human's tick: what they can reach, and every one-shot
   *  action their input asks for (equip, reload, cancel, interact, drops). */
  private prepareHuman(h: PlayerSlot, over: boolean): void {
    const p = h.char;
    const input = h.input;
    const canControl = p.hp > 0 && !over;
    h.controllable = canControl;
    // Item pickup and vehicle boarding are on-foot actions; while seated E exits.
    const onFoot = !p.vehicle;
    h.interactable = canControl && onFoot ? this.findInteractable(p) : null;
    h.enterable = canControl && onFoot ? this.findEnterable(p) : null;
    // Exactly one interaction is active at a time — one highlight, one E action.
    // When a seat and an item are both in reach, keep the nearer and drop the other.
    if (h.interactable && h.enterable) {
      const ds = dist(p.pos, h.enterable.vehicle.seatWorld(h.enterable.seat));
      const di = dist(p.pos, h.interactable.pos);
      if (ds <= di) h.interactable = null;
      else h.enterable = null;
    }
    if (!canControl) return;

    // Slot keys: switch; the belt key while already on the belt cycles to the
    // next carried utility (so a player can hold several kinds).
    if (input.equip === "utility") {
      if (p.equippedSlot === "utility") p.cycleUtility();
      else p.equipUtility();
    } else if (input.equip) {
      p.equip(input.equip);
    }
    if (input.reload) p.reload();
    // X: cancel a timed action (a reload — including a per-round auto-cycle — or
    // a utility use), so you can break off and fire/switch.
    if (input.cancel) p.cancelAction();
    if (input.interact) this.interact(h);
    if (input.drop) {
      // Drop what's in hand: the held utility, or else the equipped weapon.
      if (p.holdingUtility) this.dropFromHud(p, "utility");
      else this.dropEquippedWeapon(p);
    }
    if (input.dropHud) this.dropFromHud(p, input.dropHud);
    if (input.debugDamage) p._takeDamage(22);
    if (input.debugHeal) p._heal(10);
  }

  /** A human's movement for the tick (aim, walk or drive), then their inferred
   *  corridor for the nav congestion field. */
  private moveHuman(h: PlayerSlot): void {
    const p = h.char;
    if (h.controllable) {
      p.forward = h.input.aim;
      if (p.vehicle) {
        this.driveInput(h, h.input); // WASD -> vehicle (relative to its facing); aim its turret
      } else {
        p.move(h.input.move); // speed factors live on the Character now
        this.applyStairZ(p); // flip z at the midpoint BEFORE resolving...
        this.resolveCollisions(p); // ...so it's against the level it ends on (walls only)
      }
    }
    // They have moved for this tick, so their inferred corridor is current.
    this.updatePlayerRoute(p);
  }

  /** A human's trigger for the tick: the mounted weapon from a turret seat,
   *  the selected utility from the belt, or the held gun. */
  private fireHuman(h: PlayerSlot): void {
    if (!h.controllable) return;
    const p = h.char;
    const input = h.input;
    const veh = p.vehicle;
    if (veh) {
      // Seated: a turret seat fires the mounted weapon (from a muzzle outside the
      // hull); any other seat fires the occupant's own personal weapon out.
      const seat = p.seatIndex;
      const tgun = veh.turretGunForSeat(seat);
      const f = this.aimingGun(h).spec.fire;
      if (f) {
        const wantFire = f.auto ? input.fire : input.firePressed;
        if (wantFire) {
          if (tgun) veh.fireTurret(seat, this.world, p);
          else p.fire(this.world, this.characters);
        }
      }
    } else if (p.holdingUtility) {
      // Click begins using the selected healing item (not a punch/shot).
      if (input.firePressed) p.startUse();
    } else {
      const f = p.gun.spec.fire;
      if (f) {
        const wantFire = f.auto ? input.fire : input.firePressed;
        if (wantFire) p.fire(this.world, this.characters);
      }
    }
  }
}
