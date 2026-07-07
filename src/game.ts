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
import { Character, type Loadout } from "./actor.ts";
import * as Armors from "./armor.ts";
import { Body } from "./body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./character.ts";
import { hasLineOfSight, ObstacleGrid, pointInBox, resolveCircleVsBox, resolveCircleVsCircle } from "./collision.ts";
import type { GameCtx, Gamemode, PlayerLoadout } from "./gamemodes/gamemode.ts";
import { Gun } from "./gun.ts";
import * as Guns from "./guns.ts";
import { isDown, mouse, moveAxis, pointer } from "./input.ts";
import { ArmorItem, GunItem, separateItems, type GroundItem } from "./item.ts";
import {
  ARMOR_SPECS,
  DEFAULT_PLAYER_PRIMARY,
  DEFAULT_PLAYER_SECONDARY,
  GUN_SPECS,
  SKINS,
  type LevelState,
} from "./level.ts";
import { NavGraph } from "./nav.ts";
import { profiler } from "./profiler.ts";
import { Robot, type AiContext } from "./robot.ts";
import type { TeamId } from "./team.ts";
import { hudHitTest, type SlotKind } from "./ui.ts";
import { dist, fromAngle, norm, sub, vec, type Vec2 } from "./vec.ts";
import { stairZ, updateBullets, updateSurfaceAlphas, type World } from "./world.ts";

const PICKUP_RANGE = 75; // world px the player can reach a ground item from
const ZOOM_EASE = 0.12;

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

  /** Ground items the level shipped with — restored on reset so death-drops
   *  from a finished match don't pile up across restarts. */
  private readonly initialItems: readonly GroundItem[];

  // input edge-detection state (per-tick "was it down last tick?")
  private prevDown = false;
  private rmbDown = false;
  private eDown = false;
  private qDown = false;
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
      };
      armorKey = loadout.armor;
    } else {
      // Keep whatever the player was carrying, rebuilt from spec so ammo refills.
      const clone = (g: Gun | null): Gun | undefined => (g ? new Gun(g.spec) : undefined);
      kit = {
        primary: clone(this.player.slots.primary),
        secondary: clone(this.player.slots.secondary),
        hand: new Gun(Guns.UNARMED),
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

  /** Push `c` out of walls, and (unless `vsChars` is false) out of other
   *  characters. The player is resolved with `vsChars=false` so bots never shove
   *  it — bots yield to the player instead, on their own per-tick resolve pass
   *  (which always runs), so walking into a bot pushes the bot, not the player. */
  private resolveCollisions(c: Character, vsChars = true): void {
    let pos = c.pos;
    for (let i = 0; i < 2; i++) {
      for (const o of this.world.obstacles) {
        if (o.z !== c.z) continue;
        pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
      }
      if (vsChars) {
        for (const other of this.characters) {
          if (other === c || other.z !== c.z) continue;
          pos = resolveCircleVsCircle(pos, BODY_RADIUS, other.pos, BODY_RADIUS);
        }
      }
    }
    c.pos = pos;
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

  private pickUp(item: GroundItem): void {
    const idx = this.world.items.indexOf(item);
    if (idx >= 0) this.world.items.splice(idx, 1);
    const here = (): Vec2 => vec(this.player.pos.x, this.player.pos.y);

    if (item instanceof GunItem) {
      const dropped = this.player.holster(item.gun);
      if (dropped) this.world.items.push(new GunItem(here(), dropped, this.tossVel(), this.player.z));
    } else if (item instanceof ArmorItem) {
      const prev = this.player.equipArmor(item.armor);
      if (prev) this.world.items.push(new ArmorItem(here(), prev, this.tossVel(), this.player.z));
    }
    this.interactable = null;
  }

  private dropEquippedWeapon(): void {
    const dropped = this.player.dropEquipped();
    if (!dropped) return;
    this.world.items.push(new GunItem(vec(this.player.pos.x, this.player.pos.y), dropped, this.tossVel(), this.player.z));
  }

  private dropFromHud(kind: SlotKind): void {
    const at = vec(this.player.pos.x, this.player.pos.y);
    if (kind === "armor") {
      const a = this.player.dropArmor();
      if (a) this.world.items.push(new ArmorItem(at, a, this.tossVel(), this.player.z));
    } else {
      const g = this.player.dropSlot(kind);
      if (g) this.world.items.push(new GunItem(at, g, this.tossVel(), this.player.z));
    }
  }

  /** Convert any character at 0 HP into a corpse, dropping its gear, and remove
   *  it — signalling the gamemode first so it can score/schedule respawns. */
  private reapDead(): void {
    // Death-drops and corpses inherit the gamemode's despawn timers (null = the
    // object's default: linger forever). Authored pickups are never stamped.
    const itemTtl = this.gamemode.itemTtl ?? null;
    const bodyTtl = this.gamemode.bodyTtl ?? null;
    for (let i = this.characters.length - 1; i >= 0; i--) {
      const c = this.characters[i];
      if (c.hp > 0) continue;

      this.gamemode.onDeath(c, this);

      for (const gun of c.dropWeapons()) {
        const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
        const gi = new GunItem(vec(c.pos.x, c.pos.y), gun, vel, c.z);
        gi.lifetime = itemTtl;
        this.world.items.push(gi);
      }
      const a = c.dropArmor();
      if (a) {
        const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
        const ai = new ArmorItem(vec(c.pos.x, c.pos.y), a, vel, c.z);
        ai.lifetime = itemTtl;
        this.world.items.push(ai);
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

      if (isDown("e")) {
        if (!this.eDown && this.interactable) this.pickUp(this.interactable);
        this.eDown = true;
      } else this.eDown = false;

      if (isDown("q")) {
        if (!this.qDown) this.dropEquippedWeapon();
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

    if (canControl) {
      this.player.forward = this.aimForward();
      let speedMult = this.player.gun.spec.speed;
      if (this.player.armor) speedMult *= this.player.armor.spec.speed;
      this.player.move(moveAxis(), speedMult);
      this.resolveCollisions(this.player, false); // walls block the player; bots yield to it
    }

    // Stair transitions: crossing a staircase's midpoint flips your level.
    for (const c of this.characters) {
      for (const s of this.world.stairs) {
        const z = stairZ(s, c.pos);
        if (z !== null) c.z = z;
      }
    }

    profiler.begin("surfaces");
    updateSurfaceAlphas(this.world, this.player.z, this.player.pos);
    profiler.end("surfaces");

    for (const c of this.characters) c.tickWeapon();

    const f = this.player.gun.spec.fire;
    if (canControl && f) {
      const wantFire = f.auto ? pointer.down : pointer.down && !this.prevDown;
      if (wantFire) this.player.fire(this.world);
    }
    this.prevDown = pointer.down;

    profiler.begin("ai");
    const ai: AiContext = { world: this.world, characters: this.characters, nav: this.nav, tick: this.tick };
    for (const c of this.characters) {
      if (c instanceof Robot && c.hp > 0) c.think(ai);
    }
    profiler.end("ai");

    profiler.begin("collide");
    for (const c of this.characters) {
      if (c !== this.player) this.resolveCollisions(c);
    }
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
