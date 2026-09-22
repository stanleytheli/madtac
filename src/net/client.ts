/**
 * The client's mirror of a match a server runs (see net/protocol.ts): a
 * Session (ui/session.ts) whose world, characters, corpses, items and rounds
 * are rebuilt from snapshots rather than simulated. The same Character / Body
 * / GroundItem / Vehicle classes as the local game, so the renderer draws it
 * without knowing; their ids are the SERVER's, so events name them correctly.
 *
 * survev-style: no prediction. The local player is drawn from the server's
 * position like everyone else, one snapshot interval behind, interpolated
 * between the last two snapshots (see interpolate). Rounds are extrapolated
 * per tick from their last known velocity and stopped by the local geometry,
 * and dropped the moment a snapshot no longer lists them.
 */
import { Character } from "../entities/actor.ts";
import { Armor } from "../entities/armor.ts";
import { Body } from "../entities/body.ts";
import { DEFAULT_SKIN } from "../entities/character.ts";
import { UtilityStack } from "../entities/consumable.ts";
import { Gun } from "../entities/gun.ts";
import { ArmorItem, GunItem, UtilityItem, type GroundItem } from "../entities/item.ts";
import { UNARMED } from "../entities/guns.ts";
import { ALL_GUN_SPECS, ARMOR_SPECS, UTILITY_SPECS } from "../entities/specs.ts";
import { Vehicle } from "../entities/vehicle.ts";
import { VEHICLE_SPECS } from "../entities/vehicles.ts";
import { ObstacleGrid } from "../engine/collision.ts";
import type { PlayerInput } from "../engine/command.ts";
import type { GameEvent } from "../engine/events.ts";
import { add, vec, type Vec2 } from "../engine/vec.ts";
import type { GamemodeHud, KillFeedEntry, PlayerLoadout } from "../gamemodes/gamemode.ts";
import type { DeathMark } from "../ui/minimap.ts";
import type { RespawnHost, Session } from "../ui/session.ts";
import { loadLevel, type LevelMeta } from "../world/level.ts";
import type { Bullet, Projectile, World } from "../world/world.ts";
import {
  DEFAULT_SNAP_HZ,
  PROTOCOL,
  WS_PATH,
  type CharFull,
  type CharSnap,
  type ClientMsg,
  type ServerMsg,
  type SnapMsg,
  type WelcomeMsg,
} from "./protocol.ts";

/** Send the held input state at least this often even when unchanged (ticks),
 *  so a dropped message can't leave a key stuck on the server. */
const INPUT_KEEPALIVE_TICKS = 6;
/** How often the RTT is measured (ms). */
const PING_MS = 2000;
/** Retry a dropped connection after this long (ms). */
const RECONNECT_MS = 1500;

const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };

/** Where a mirror was and is going, for interpolation. */
interface Pose {
  x: number;
  y: number;
  fx: number;
  fy: number;
}
interface Track {
  from: Pose;
  to: Pose;
  /** When `to` arrived (ms); the mirror reads from->to over one snapshot interval after it. */
  at: number;
}

export type NetStatus = "connecting" | "connected" | "reconnecting" | "rejected";

export class NetSession implements Session {
  world: World;
  player: Character;
  readonly characters: Character[] = [];
  readonly bodies: Body[] = [];
  tick = 0;
  controllable = false;
  killFeed: KillFeedEntry[] = [];
  minimapDeaths: DeathMark[] = [];
  interactable: GroundItem | null = null;
  enterable: { vehicle: Vehicle; seat: number } | null = null;

  /** The match's meta (mode, sight mask, minimap size), from the welcome. */
  meta: LevelMeta | null = null;
  /** Called once the level has arrived and the world is real. main.ts rebinds
   *  its renderer to the new world here. */
  onReady: (() => void) | null = null;
  status: NetStatus = "connecting";
  /** Last measured round trip, ms. */
  ping = 0;
  /** Why the server refused us, if it did. */
  rejectReason = "";

  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly name: string;
  private token: string | null;
  private myId = 0;
  private snapMs = 1000 / DEFAULT_SNAP_HZ;
  private hudState: GamemodeHud | null = null;
  private label: string | null = null;
  private view = { zoom: 1, spread: 0, cone: 360 };
  private grid: ObstacleGrid | null = null;
  private readonly tracks = new Map<number, Track>();
  private readonly mirrors = new Map<number, Character>();
  private readonly bodyById = new Map<number, Body>();
  private readonly itemById = new Map<number, GroundItem>();
  private readonly vehicleById = new Map<number, Vehicle>();
  private readonly bulletById = new Map<number, Bullet>();
  private readonly projById = new Map<number, Projectile>();
  /** Events from snapshots, waiting for the next step() to hand them to the
   *  effects pipeline in world.events. */
  private pendingEvents: GameEvent[] = [];
  private seq = 0;
  private lastSent: string | null = null;
  private sinceSent = 0;
  private lastPingAt = 0;
  private reconnectTimer: number | null = null;

  /** `host` is "host:port" or a full ws:// URL; `name` is what to join as.
   *  `connect` = false builds the mirror without a socket (a headless test
   *  feeds it messages through receive()). */
  constructor(host: string, name: string, connect = true) {
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    this.url = /^wss?:\/\//.test(host) ? host : `${secure ? "wss" : "ws"}://${host}${WS_PATH}`;
    this.name = name;
    this.token = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(`madtac.token.${this.url}`) : null;
    // A placeholder world and player until the welcome brings the real level,
    // so the renderer has something to draw on the first frames.
    this.world = loadLevel(`{ "version": 1, "entities": [] }`).world;
    this.player = new Character(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
    if (connect) this.connect();
  }

  // -------------------------------------------------------------- socket ----

  private connect(): void {
    this.status = this.myId ? "reconnecting" : "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: "join", protocol: PROTOCOL, name: this.name, token: this.token ?? undefined });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status === "rejected") return;
      this.status = "reconnecting";
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS) as unknown as number;
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Take one server message (the socket's onmessage, or a test's hand). */
  receive(msg: ServerMsg): void {
    if (msg.t === "welcome") this.welcome(msg);
    else if (msg.t === "snap") this.applySnapshot(msg);
    else if (msg.t === "pong") this.ping = Math.round(performance.now() - msg.at);
    else if (msg.t === "reject") {
      this.status = "rejected";
      this.rejectReason = msg.reason;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.ws?.close();
    }
  }

  private welcome(m: WelcomeMsg): void {
    this.status = "connected";
    this.token = m.token;
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(`madtac.token.${this.url}`, m.token);
    this.snapMs = 1000 / (m.snapHz || DEFAULT_SNAP_HZ);
    const rejoin = this.myId === m.id && this.meta !== null;
    this.myId = m.id;
    this.meta = m.meta;
    this.tick = m.tick;
    if (rejoin) return; // same match, same character: keep the mirrors we have
    // A new match (or our first): rebuild the world from the level and forget
    // every mirror — the server will re-send whatever we can see.
    this.world = loadLevel(m.level).world;
    this.world.grid = new ObstacleGrid(this.world.obstacles);
    this.grid = this.world.grid;
    this.characters.length = 0;
    this.bodies.length = 0;
    this.mirrors.clear();
    this.tracks.clear();
    this.bodyById.clear();
    this.itemById.clear();
    this.vehicleById.clear();
    this.bulletById.clear();
    this.projById.clear();
    this.player = this.mirror(m.id);
    this.onReady?.();
  }

  // ----------------------------------------------------------- snapshots ----

  private mirror(id: number): Character {
    let c = this.mirrors.get(id);
    if (!c) {
      c = new Character(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
      c.id = id;
      this.mirrors.set(id, c);
      this.characters.push(c);
      if (id === this.myId) this.player = c;
    }
    return c;
  }

  private applyFull(c: Character, f: CharFull): void {
    c.skin = f.skin;
    c.team = f.team;
    c.maxHp = f.maxHp;
    const gunOf = (key: string | null, have: Gun | null): Gun | null => {
      const spec = key ? ALL_GUN_SPECS[key] : undefined;
      if (!spec) return null;
      return have && have.spec === spec ? have : new Gun(spec);
    };
    c.slots.primary = gunOf(f.primary, c.slots.primary);
    c.slots.secondary = gunOf(f.secondary, c.slots.secondary);
    c.slots.hand = gunOf(f.hand, c.slots.hand) ?? new Gun(UNARMED);
    const armorSpec = f.armor ? ARMOR_SPECS[f.armor] : undefined;
    c.armor = armorSpec ? (c.armor?.spec === armorSpec ? c.armor : new Armor(armorSpec)) : null;
    const utilSpec = f.util ? UTILITY_SPECS[f.util] : undefined;
    c.utilities = utilSpec ? [new UtilityStack(utilSpec, f.utilN)] : [];
    c.utilityIndex = 0;
    if (c.equippedSlot !== f.slot) {
      c.equip(f.slot);
      c.gun.drawTicks = 0; // the snapshot's own draw timer follows
    }
  }

  private applyChar(s: CharSnap, now: number): void {
    const c = this.mirror(s.id);
    if (s.full) this.applyFull(c, s.full);
    // Where it is going: the previous target becomes where it is coming from.
    const to: Pose = { x: s.x, y: s.y, fx: s.fx, fy: s.fy };
    const t = this.tracks.get(s.id);
    if (t) {
      this.tracks.set(s.id, { from: t.to, to, at: now });
    } else {
      this.tracks.set(s.id, { from: to, to, at: now });
      c.pos = vec(s.x, s.y);
      c.forward = vec(s.fx, s.fy);
    }
    c.z = s.z;
    c.hp = s.hp;
    const g = c.gun;
    g.kickback = s.k;
    g.flashTicks = s.fl;
    g.fireCooldown = s.co;
    g.reloadTicks = s.re;
    g.drawTicks = s.dr;
    g.setPunch(s.pu);
    c.setUseTimer(s.us, s.ut);
    c.vehicle = s.vh ? (this.vehicleById.get(s.vh) ?? null) : null;
    c.seatIndex = s.st;
  }

  private applySnapshot(m: SnapMsg): void {
    const now = performance.now();
    this.tick = m.tick;
    for (const id of m.gone) {
      const c = this.mirrors.get(id);
      if (!c) continue;
      this.mirrors.delete(id);
      this.tracks.delete(id);
      const i = this.characters.indexOf(c);
      if (i >= 0) this.characters.splice(i, 1);
    }
    // Vehicles before characters, so a seated character can find its seat.
    for (const id of m.goneVehicles) {
      const v = this.vehicleById.get(id);
      if (!v) continue;
      this.vehicleById.delete(id);
      const i = this.world.vehicles.indexOf(v);
      if (i >= 0) this.world.vehicles.splice(i, 1);
    }
    for (const s of m.vehicles) {
      let v = this.vehicleById.get(s.id);
      const spec = VEHICLE_SPECS[s.key];
      if (!spec) continue;
      if (!v) {
        v = new Vehicle(spec, vec(s.x, s.y), s.a, s.z);
        v.id = s.id;
        this.vehicleById.set(s.id, v);
        this.world.vehicles.push(v);
      }
      v.pos = vec(s.x, s.y);
      v.angle = s.a;
      v.z = s.z;
      for (let i = 0; i < s.ta.length && i < v.turretAngle.length; i++) v.turretAngle[i] = s.ta[i];
    }
    for (const s of m.chars) this.applyChar(s, now);

    // Rounds: replace the set.
    const keepB = new Set<number>();
    for (const s of m.bullets) {
      keepB.add(s.id);
      let b = this.bulletById.get(s.id);
      if (!b) {
        b = {
          id: s.id, pos: vec(s.x, s.y), prev: vec(s.x, s.y), vel: vec(s.vx, s.vy), z: s.z, life: 600,
          origin: vec(s.ox, s.oy), renderAfter: s.ra, owner: null, damage: 0, tracerWidth: s.w,
          tracerLength: s.l, tracerColor: s.c, armorPen: AP, penetration: 0, penUsed: 0, penSkip: 0, gun: null,
        };
        this.bulletById.set(s.id, b);
        this.world.bullets.push(b);
      } else {
        b.pos = vec(s.x, s.y);
        b.vel = vec(s.vx, s.vy);
        b.z = s.z;
      }
    }
    this.world.bullets = this.world.bullets.filter((b) => {
      if (keepB.has(b.id)) return true;
      this.bulletById.delete(b.id);
      return false;
    });
    const keepP = new Set<number>();
    for (const s of m.projs) {
      keepP.add(s.id);
      let p = this.projById.get(s.id);
      if (!p) {
        p = {
          id: s.id, pos: vec(s.x, s.y), prev: vec(s.x, s.y), vel: vec(s.vx, s.vy), z: s.z, life: 600,
          origin: vec(s.ox, s.oy), renderAfter: s.ra, owner: null, damage: 0, radius: 0, armorPen: AP,
          bodyRadius: s.br, color: s.c, trailColor: s.tc, sprite: s.sp, spriteScale: s.ss, gun: null,
        };
        this.projById.set(s.id, p);
        this.world.projectiles.push(p);
      } else {
        p.pos = vec(s.x, s.y);
        p.vel = vec(s.vx, s.vy);
        p.z = s.z;
      }
    }
    this.world.projectiles = this.world.projectiles.filter((p) => {
      if (keepP.has(p.id)) return true;
      this.projById.delete(p.id);
      return false;
    });

    // Items and corpses: diffs.
    for (const id of m.goneItems) {
      const it = this.itemById.get(id);
      if (!it) continue;
      this.itemById.delete(id);
      const i = this.world.items.indexOf(it);
      if (i >= 0) this.world.items.splice(i, 1);
    }
    for (const s of m.items) {
      let it = this.itemById.get(s.id);
      if (!it) {
        const pos = vec(s.x, s.y);
        if (s.kind === "gun") {
          const spec = ALL_GUN_SPECS[s.key];
          if (!spec) continue;
          it = new GunItem(pos, new Gun(spec), vec(0, 0), s.z);
        } else if (s.kind === "armor") {
          const spec = ARMOR_SPECS[s.key];
          if (!spec) continue;
          it = new ArmorItem(pos, new Armor(spec), vec(0, 0), s.z);
        } else {
          const spec = UTILITY_SPECS[s.key];
          if (!spec) continue;
          it = new UtilityItem(pos, spec, s.n ?? 1, vec(0, 0), s.z);
        }
        it.id = s.id;
        this.itemById.set(s.id, it);
        this.world.items.push(it);
      }
      it.pos = vec(s.x, s.y);
      it.z = s.z;
      it.lifetime = s.lt;
      it.age = s.ag;
      if (it instanceof UtilityItem && s.n !== undefined) it.count = s.n;
    }
    for (const id of m.goneBodies) {
      const b = this.bodyById.get(id);
      if (!b) continue;
      this.bodyById.delete(id);
      const i = this.bodies.indexOf(b);
      if (i >= 0) this.bodies.splice(i, 1);
    }
    for (const s of m.bodies) {
      let b = this.bodyById.get(s.id);
      if (!b) {
        b = Body.mirror(s.id, vec(s.x, s.y), s.z, s.a, s.skin, s.team);
        this.bodyById.set(s.id, b);
        this.bodies.push(b);
      }
      b.pos = vec(s.x, s.y);
      b.angle = s.a;
      b.lifetime = s.lt;
      b.age = s.ag;
    }

    // Events, for the next step() to play.
    for (const e of m.events) {
      if (e.kind !== "decal") {
        this.pendingEvents.push(e);
      } else {
        const on = this.world.obstacles[e.oi];
        if (on) this.pendingEvents.push({ kind: "decal", near: e.near, on, z: e.z, heft: e.heft });
      }
    }

    // The private block.
    const me = this.player;
    const mine = m.me;
    me.gun.mag = mine.mag;
    me.gun.reserveMags = mine.res;
    if (me.armor) me.armor.hp = mine.armorHp;
    me.regenTicks = mine.regenTicks;
    me.regenRate = mine.regenRate;
    me.damageMarks = mine.marks;
    this.view = { zoom: mine.zoom, spread: mine.spread, cone: mine.cone };
    this.controllable = mine.ctrl;
    this.label = mine.label;
    this.interactable = mine.item !== null ? (this.itemById.get(mine.item) ?? null) : null;
    const seat = mine.seat ? this.vehicleById.get(mine.seat.vh) : undefined;
    this.enterable = mine.seat && seat ? { vehicle: seat, seat: mine.seat.st } : null;
    if (m.hud !== undefined) this.hudState = m.hud;
    if (m.feed) {
      this.killFeed = m.feed.map((f) => ({ ...f, gun: f.gun ? (ALL_GUN_SPECS[f.gun] ?? null) : null }));
    }
    if (m.deaths) this.minimapDeaths = m.deaths;
  }

  // ------------------------------------------------------------- Session ----

  hud(): GamemodeHud | null {
    return this.hudState;
  }
  interactLabel(): string | null {
    return this.label;
  }
  zoomTarget(): number {
    return this.meta ? this.view.zoom : this.player.gun.spec.zoom;
  }
  spreadTarget(): number {
    return this.view.spread;
  }
  visionConeTarget(): number {
    return this.view.cone;
  }
  respawnHost(): RespawnHost | null {
    return {
      setLoadout: (loadout: PlayerLoadout) => this.send({ t: "loadout", loadout }),
      randomize: () => this.send({ t: "random" }),
      // The panel closes itself once the server's HUD stops asking for a kit.
      respawn: () => (this.send({ t: "respawn" }), false),
    };
  }

  /** One client tick: send the input, hand the snapshot events on, and move
   *  the rounds along by their last known velocity. */
  step(input: PlayerInput): void {
    this.sendInput(input);
    this.world.events.length = 0;
    if (this.pendingEvents.length) {
      this.world.events.push(...this.pendingEvents);
      this.pendingEvents.length = 0;
    }
    // Gun timers run between snapshots so kick, flash and reloads animate
    // smoothly; the next snapshot re-syncs them.
    for (const c of this.characters) c.gun.tick();
    for (const c of this.characters) c.tickStatus();
    const flight = (r: { pos: Vec2; prev: Vec2; vel: Vec2; z: number }): boolean => {
      r.prev = r.pos;
      r.pos = add(r.pos, r.vel);
      // Stopped by a wall we can see the shape of; the server's word follows.
      return !(this.grid && this.grid.hit(r.pos, r.z));
    };
    this.world.bullets = this.world.bullets.filter((b) => flight(b) || (this.bulletById.delete(b.id), false));
    this.world.projectiles = this.world.projectiles.filter((p) => flight(p) || (this.projById.delete(p.id), false));
    const now = performance.now();
    if (now - this.lastPingAt > PING_MS && this.status === "connected") {
      this.lastPingAt = now;
      this.send({ t: "ping", at: now });
    }
  }

  /** Move every mirror to where it should read now: between the two latest
   *  snapshots, one interval behind the newest. */
  interpolate(nowMs: number): void {
    for (const [id, t] of this.tracks) {
      const c = this.mirrors.get(id);
      if (!c) continue;
      const a = Math.max(0, Math.min(1, (nowMs - t.at) / this.snapMs));
      c.pos = vec(t.from.x + (t.to.x - t.from.x) * a, t.from.y + (t.to.y - t.from.y) * a);
      // Facing: shortest-way angle blend.
      const a0 = Math.atan2(t.from.fy, t.from.fx);
      let d = Math.atan2(t.to.fy, t.to.fx) - a0;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const ang = a0 + d * a;
      c.forward = vec(Math.cos(ang), Math.sin(ang));
    }
  }

  private sendInput(input: PlayerInput): void {
    const pressed =
      input.firePressed || !!input.equip || input.cancel || input.interact || input.drop || !!input.dropHud ||
      input.restart || input.debugDamage || input.debugHeal;
    const held = JSON.stringify([input.move, input.aim, input.fire, input.reload]);
    this.sinceSent += 1;
    if (!pressed && held === this.lastSent && this.sinceSent < INPUT_KEEPALIVE_TICKS) return;
    this.lastSent = held;
    this.sinceSent = 0;
    this.seq += 1;
    this.send({ t: "input", seq: this.seq, in: input });
  }
}
