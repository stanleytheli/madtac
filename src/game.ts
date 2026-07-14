/**
 * The play session: everything the fixed-timestep simulation owns and mutates —
 * the world, the live character roster, corpses, the player, the active
 * gamemode, and the camera — plus the per-tick `update()` that drives them. The
 * page shell (canvas, rendering, the RAF loop, input wiring) lives in main.ts
 * and reads this object; the level editor is a separate path that never builds a
 * Game.
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
import { hasLineOfSight, ObstacleGrid, pointInBox, resolveCircleVsBox } from "./engine/collision.ts";
import type { GameCtx, Gamemode, PlayerLoadout } from "./gamemodes/gamemode.ts";
import { Gun } from "./entities/gun.ts";
import * as Guns from "./entities/guns.ts";
import { isDown, mouse, moveAxis, pointer } from "./engine/input.ts";
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
import { hudHitTest, type SlotKind } from "./ui/ui.ts";
import { MINIMAP_DEATH_TTL, type DeathMark } from "./ui/minimap.ts";
import { dist, fromAngle, norm, sub, vec, type Vec2 } from "./engine/vec.ts";
import { stairClimbDir, stairZ, updateBullets, updateSurfaceAlphas, type World } from "./world/world.ts";

const PICKUP_RANGE = 75; // world px the player can reach a ground item from
const ZOOM_EASE = 0.12;
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

export class Game implements GameCtx {
  readonly world: World;
  readonly nav: NavGraph | null;
  readonly characters: Character[] = [];
  readonly bodies: Body[] = [];
  readonly player: Character;
  readonly camera: { size: number };
  tick = 0;

  /** Nearest reachable ground item this tick (for the HUD prompt + E). */
  interactable: GroundItem | null = null;

  /** Recent FRIENDLY death locations (non-hostile to the player), for the minimap
   *  X's. Appended in reapDead, aged + pruned in despawnStale, cleared on reset. */
  readonly minimapDeaths: DeathMark[] = [];

  /** Ground items the level shipped with — restored on reset so death-drops
   *  from a finished match don't pile up across restarts. */
  private readonly initialItems: readonly GroundItem[];

  // input edge-detection state (per-tick "was it down last tick?")
  private prevDown = false;
  private rmbDown = false;
  private eDown = false;
  private qDown = false;
  private fourDown = false;
  private jDown = false;
  private kDown = false;
  private enterDown = false;

  constructor(
    readonly level: LevelState,
    readonly gamemode: Gamemode,
  ) {
    this.world = level.world;
    this.initialItems = level.world.items.slice();
    // Build the sight index before the nav graph so the graph's all-pairs
    // visibility build rides the fast line-of-sight path too.
    this.world.grid = new ObstacleGrid(this.world.obstacles);
    this.nav = new NavGraph(this.world);
    this.player = this.buildPlayer();
    this.camera = { size: this.player.gun.spec.zoom };
    this.start();
  }

  /** Construct the player object once (reused across respawns). */
  private buildPlayer(): Character {
    const spawn = this.level.playerSpawn[0];
    const player = new Character(
      vec(spawn?.pos.x ?? 0, spawn?.pos.y ?? 0),
      SKINS[spawn?.skin ?? ""] ?? DEFAULT_SKIN,
      this.playerLoadout(),
    );
    player.z = spawn?.z ?? 0;
    player.team = "player";
    return player;
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
    this.bodies.length = 0;
    this.world.bullets.length = 0;
    this.world.particles.length = 0;
    this.world.items.length = 0;
    this.world.items.push(...this.initialItems);
    this.minimapDeaths.length = 0;

    const spawn = this.level.playerSpawn[0];
    this.player.respawn(vec(spawn?.pos.x ?? 0, spawn?.pos.y ?? 0), spawn?.z ?? 0, this.playerLoadout());
    if (spawn?.armor && ARMOR_SPECS[spawn.armor]) {
      this.player.equipArmor(new Armors.Armor(ARMOR_SPECS[spawn.armor]));
    }
    this.characters.length = 0;
    this.characters.push(this.player);

    this.gamemode.init(this);
    updateSurfaceAlphas(this.world, this.player.z, this.player.pos, true);
  }

  reset(): void {
    this.start();
  }

  // --- GameCtx helpers ---------------------------------------------------------

  addCharacter(c: Character): void {
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
      if (o.z === zone.z) pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
    }
    return { pos, z: zone.z };
  }

  /** Reset the player in place at a spawn point and re-add it to the roster.
   *  With `loadout` (GUN_SPECS / ARMOR_SPECS keys) the player is re-armed to that
   *  kit; without it the player keeps its current weapons + the level's spawn
   *  armor. Guns are rebuilt from spec, so ammo is always full. */
  revivePlayer(pos: Vec2, z: number, loadout?: PlayerLoadout): void {
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
        primary: clone(this.player.slots.primary),
        secondary: clone(this.player.slots.secondary),
        hand: new Gun(Guns.UNARMED),
        utilities: startingUtilities(),
      };
      armorKey = this.level.playerSpawn[0]?.armor;
    }
    this.player.respawn(vec(pos.x, pos.y), z, kit);
    if (armorKey && ARMOR_SPECS[armorKey]) {
      this.player.equipArmor(new Armors.Armor(ARMOR_SPECS[armorKey]));
    }
    if (!this.characters.includes(this.player)) this.characters.push(this.player);
  }

  // --- simulation --------------------------------------------------------------

  private screenCenter(): Vec2 {
    return vec(window.innerWidth / 2, window.innerHeight / 2);
  }

  /** Aim direction from the mouse (screen-space; scale/translation invariant). */
  private aimForward(): Vec2 {
    const t = sub(mouse, this.screenCenter());
    return t.x === 0 && t.y === 0 ? vec(0, -1) : norm(t);
  }

  /** The camera's zoom target: the equipped gun's zoom bent by the floor
   *  underfoot. Only ONE floor's deltaZoom applies at a time — overlapping
   *  lookout floors don't stack; the last (topmost, by render order) wins. */
  private zoomTarget(): number {
    let abs: number | null = null;
    let delta = 0;
    for (const f of this.world.floors) {
      if (f.level !== this.player.z || (f.zoom === undefined && f.deltaZoom === undefined)) continue;
      if (!f.infinite && !pointInBox(this.player.pos, f)) continue;
      if (f.zoom !== undefined) abs = f.zoom;
      if (f.deltaZoom !== undefined) delta = f.deltaZoom;
    }
    return Math.max(0.3, abs ?? this.player.gun.spec.zoom + delta);
  }

  /** Resolve `c` against WALLS: it has already moved this tick (pos += vel), so
   *  just push it out of any wall it now overlaps. No sweep is needed — at the
   *  game's body speeds (max ~7.5 px/tick, far below the 60px body diameter) a
   *  body can't jump across a wall in one tick, and pushing out along the wall's
   *  nearest feature slides the body along it for free. Body-vs-body is the
   *  separate squishy pass (see separateCharacters). */
  private resolveCollisions(c: Character): void {
    c.pos = this.resolveWalls(c.pos, c.z);
  }

  /** Push a body at `pos` out of every wall it overlaps on level `z`, a few
   *  passes so a corner between two walls settles (each push-out can nudge it
   *  into the neighbour). Uses the grid to touch only nearby obstacles. */
  private resolveWalls(pos: Vec2, z: number): Vec2 {
    const grid = this.world.grid;
    for (let i = 0; i < WALL_PASSES; i++) {
      if (grid) {
        grid.eachNear(pos, BODY_RADIUS, z, (o) => {
          pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
        });
      } else {
        for (const o of this.world.obstacles) {
          if (o.z === z) pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
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
    const cs = this.characters.filter((c) => c.hp > 0);
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
    // Walls win: re-project everyone out of walls after the nudge so a shove
    // can't leave a body inside a wall (a body squeezed between a wall and
    // another body ends against the wall — the least-bad spot, not a freeze).
    for (const c of cs) c.pos = this.resolveWalls(c.pos, c.z);
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

  /** Nearest ground item on the player's level, within reach and line of sight. */
  private findInteractable(): GroundItem | null {
    let best: GroundItem | null = null;
    let bestD = Infinity;
    for (const it of this.world.items) {
      const onStairs = this.world.stairs.some((s) => stairZ(s, it.pos) !== null);
      if (it.z !== this.player.z && !onStairs) continue;
      const d = dist(this.player.pos, it.pos);
      if (d > PICKUP_RANGE || d >= bestD) continue;
      if (!hasLineOfSight(this.player.pos, it.pos, this.world.obstacles, this.player.z)) continue;
      best = it;
      bestD = d;
    }
    return best;
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

  private pickUp(item: GroundItem): void {
    const idx = this.world.items.indexOf(item);
    if (idx >= 0) this.world.items.splice(idx, 1);
    const here = (): Vec2 => vec(this.player.pos.x, this.player.pos.y);

    if (item instanceof GunItem) {
      const dropped = this.player.holster(item.gun);
      if (dropped) this.dropToWorld(dropped, here(), this.tossVel(), this.player.z);
    } else if (item instanceof ArmorItem) {
      const prev = this.player.equipArmor(item.armor);
      if (prev) this.dropToWorld(prev, here(), this.tossVel(), this.player.z);
    } else if (item instanceof UtilityItem) {
      // Take what fits (capped at the spec's maxCarry); leave any remainder on
      // the ground so a full belt doesn't silently swallow the pile.
      const took = this.player.addUtility(item.spec, item.count);
      item.count -= took;
      if (item.count > 0) this.world.items.push(item); // re-add the leftover stack
    }
    this.interactable = null;
  }

  private dropEquippedWeapon(): void {
    const dropped = this.player.dropEquipped();
    if (dropped) this.dropToWorld(dropped, vec(this.player.pos.x, this.player.pos.y), this.tossVel(), this.player.z);
  }

  private dropFromHud(kind: SlotKind): void {
    let gear: Droppable | null = null;
    if (kind === "armor") gear = this.player.dropArmor();
    else if (kind === "utility") gear = this.player.dropCurrentUtility();
    else if (kind === "melee") return; // fists — nothing to drop
    else gear = this.player.dropSlot(kind);
    if (gear) this.dropToWorld(gear, vec(this.player.pos.x, this.player.pos.y), this.tossVel(), this.player.z);
  }

  /** Convert any character at 0 HP into a corpse, dropping its gear, and remove
   *  it — signalling the gamemode first so it can score/schedule respawns. */
  private reapDead(): void {
    // Death-drops and corpses inherit the gamemode's despawn timers (null = the
    // object's default: linger forever). Authored pickups are never stamped.
    // Item TTL is applied by dropToWorld; corpses take bodyTtl here.
    const bodyTtl = this.gamemode.bodyTtl ?? null;
    for (let i = this.characters.length - 1; i >= 0; i--) {
      const c = this.characters[i];
      if (c.hp > 0) continue;

      this.gamemode.onDeath(c, this);

      // Mark friendly deaths for the minimap (enemies aren't shown at all).
      if (!areHostile(this.player.team, c.team)) {
        this.minimapDeaths.push({ pos: vec(c.pos.x, c.pos.y), z: c.z, age: 0 });
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
    // Age + prune the minimap's recent-death marks.
    for (let i = this.minimapDeaths.length - 1; i >= 0; i--) {
      if (++this.minimapDeaths[i].age > MINIMAP_DEATH_TTL) this.minimapDeaths.splice(i, 1);
    }
  }

  update(): void {
    this.tick += 1;

    // Match decided: freeze the player, let the scene keep breathing, and take
    // the restart key. (Enter also gets swallowed while playing — harmless.)
    const over = this.gamemode.hud(this)?.over ?? false;
    if (over) {
      if (isDown("enter")) {
        if (!this.enterDown) this.reset();
        this.enterDown = true;
        return;
      }
      this.enterDown = false;
    }

    const canControl = this.player.hp > 0 && !over;
    this.interactable = canControl ? this.findInteractable() : null;

    if (canControl) {
      if (isDown("1")) this.player.equip("primary");
      if (isDown("2")) this.player.equip("secondary");
      if (isDown("3")) this.player.equip("hand");
      if (isDown("r")) this.player.reload();

      // Slot 4: equip the belt from another slot; press again on it to cycle to
      // the next carried utility (so a player can hold several kinds).
      if (isDown("4")) {
        if (!this.fourDown) {
          if (this.player.equippedSlot === "utility") this.player.cycleUtility();
          else this.player.equipUtility();
        }
        this.fourDown = true;
      } else this.fourDown = false;

      if (isDown("e")) {
        if (!this.eDown && this.interactable) this.pickUp(this.interactable);
        this.eDown = true;
      } else this.eDown = false;

      if (isDown("q")) {
        if (!this.qDown) {
          // Drop what's in hand: the held utility, or else the equipped weapon.
          if (this.player.holdingUtility) this.dropFromHud("utility");
          else this.dropEquippedWeapon();
        }
        this.qDown = true;
      } else this.qDown = false;

      if (pointer.rightDown) {
        if (!this.rmbDown) {
          const kind = hudHitTest(mouse, window.innerWidth, window.innerHeight, this.player);
          if (kind) this.dropFromHud(kind);
        }
        this.rmbDown = true;
      } else this.rmbDown = false;

      if (isDown("j")) {
        if (!this.jDown) this.player._takeDamage(22);
        this.jDown = true;
      } else this.jDown = false;
      if (isDown("k")) {
        if (!this.kDown) this.player._heal(10);
        this.kDown = true;
      } else this.kDown = false;
    }

    this.camera.size += (this.zoomTarget() - this.camera.size) * ZOOM_EASE;

    // Refresh every character's staircase state before anyone moves, so the climb
    // slowdown (Character.move / applyStairMove) and the recoil speed both see it.
    for (const c of this.characters) c.onStairs = this.stairDirAt(c);

    if (canControl) {
      this.player.forward = this.aimForward();
      this.player.move(moveAxis()); // speed factors live on the Character now
      this.applyStairZ(this.player); // flip z at the midpoint BEFORE resolving...
      this.resolveCollisions(this.player); // ...so it's against the level it ends on (walls only)
    }

    profiler.begin("surfaces");
    updateSurfaceAlphas(this.world, this.player.z, this.player.pos);
    profiler.end("surfaces");

    for (const c of this.characters) c.tickWeapon();
    // Belt/status upkeep (heal-use timer, regen). Runs before bullets resolve, so
    // a regen tick can't revive someone the same tick a lethal shot lands.
    for (const c of this.characters) c.tickStatus();

    if (canControl) {
      if (this.player.holdingUtility) {
        // Click begins using the selected healing item (not a punch/shot).
        if (pointer.down && !this.prevDown) this.player.startUse();
      } else {
        const f = this.player.gun.spec.fire;
        if (f) {
          const wantFire = f.auto ? pointer.down : pointer.down && !this.prevDown;
          if (wantFire) this.player.fire(this.world);
        }
      }
    }
    this.prevDown = pointer.down;

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

    profiler.begin("collide");
    for (const c of this.characters) {
      if (c === this.player) continue;
      this.applyStairZ(c); // flip z after this tick's move, before resolving (see applyStairZ)
      this.resolveCollisions(c);
    }
    // Body-vs-body last, as one symmetric pass over all characters — every agent
    // treated equally (no resolve-order priority; the player included).
    this.separateCharacters();
    profiler.end("collide");

    profiler.begin("bullets");
    updateBullets(this.world, this.characters);
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
}
