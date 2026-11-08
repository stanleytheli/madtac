/**
 * The client's mirror of a match a server runs (see net/protocol.ts): a
 * Session (ui/session.ts) whose world, characters, corpses, items and rounds
 * are rebuilt from snapshots rather than simulated. The same Character / Body
 * / GroundItem / Vehicle classes as the local game, so the renderer draws it
 * without knowing; their ids are the SERVER's, so events name them correctly.
 *
 * Two clocks, the way shooters do it:
 *
 * EVERYONE ELSE is drawn a little in the past, on the server's clock. Each
 * snapshot is stamped with its tick; it is held in a buffer and applied when
 * render time reaches that tick, and characters and vehicles are interpolated
 * between it and the next one. Render time is a playout buffer: real speed,
 * nudged a few percent to keep a cushion of snapshots in hand that is sized by
 * how unevenly they have been arriving (and by how the server's tick rate
 * wanders against ours), so a late or an early packet changes nothing on
 * screen. Rounds fly on the same clock (linear from their last
 * position), and the world's events — shots, impacts, blood, footsteps — play
 * when render time reaches them, so a muzzle flash and its tracer line up with
 * the shooter you see. Our own rounds are drawn without the delay.
 *
 * OUR OWN PLAYER is drawn in the present, predicted. Every tick we send one
 * input (numbered) and run it here at once through the same steps the server
 * will (a weapon switch, a reload, walking against the same walls and stairs
 * in world/locomotion.ts, the gun's timers, the trigger), so moving and
 * shooting answer the keys immediately. The trigger is the real Gun.fire,
 * seeded as the server seeds that input's shot (engine/rng.ts): flash, kick,
 * sound and ammo at once, and bullets of our own that fly here against
 * everyone as we draw them, with their impacts (blood, sparks, holes, the hit
 * sound) the moment they land. Each input also says what server tick we were
 * drawing everyone at, and the server rewinds its targets there for our shots
 * (lag compensation), so what hit here hit there; the damage is still the
 * server's call. Each snapshot says which of our inputs the server has applied
 * and where that left us (MeSnap): we rewind to that, replay the inputs it
 * hasn't seen yet, and if the result differs from what we showed (a shove, a
 * hit's stagger) the difference is melted away over a few ticks rather than
 * jumped. The server's copies of the sounds we already played are skipped
 * (`by`). Seated in a vehicle, dead, or with the match decided, we are drawn
 * from the snapshots like everyone else.
 *
 * The server leaves out what we already know (see net/protocol.ts): a standing
 * character, a round's look after its first listing, and ages. So a mirror
 * keeps its last pose until told otherwise, the look of each round is cached
 * by id, and corpses, drops, feed lines and death marks are aged here.
 */
import { Character, type EquipSlot } from "../entities/actor.ts";
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
import { add, len, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import type { GamemodeHud, KillFeedEntry, PlayerLoadout, PlayerRow } from "../gamemodes/gamemode.ts";
import type { DeathMark } from "../ui/minimap.ts";
import type { RespawnHost, Session } from "../ui/session.ts";
import { loadLevel, type LevelMeta } from "../world/level.ts";
import { footsteps, stairDirAt, walk } from "../world/locomotion.ts";
import { updateBullets, type Bullet, type Hittable, type Projectile, type World } from "../world/world.ts";
import { shotRng } from "../engine/rng.ts";
import {
  DEFAULT_SNAP_HZ,
  PROTOCOL,
  SIM_HZ,
  serverUrls,
  type BulletSnap,
  type CharFull,
  type CharSnap,
  type ClientMsg,
  type MeSnap,
  type ProjSnap,
  type ServerMsg,
  type SnapMsg,
  type VehicleSnap,
  type WelcomeMsg,
} from "./protocol.ts";

/** How often the RTT is measured (ms). */
const PING_MS = 2000;
/** Retry a dropped connection after this long (ms). */
const RECONNECT_MS = 1500;
const TICK_MS = 1000 / SIM_HZ;

// --- the delayed clock (a playout buffer) -------------------------------------
// Render time runs at real speed, a few percent faster or slower as needed to
// keep a cushion of snapshots ahead of it: deep enough that the next one is
// in hand when it's needed, however unevenly they arrive and however the
// server's own tick rate wanders against our clock. It never runs past the
// newest snapshot: with nothing newer, everyone holds still until more comes.
//
// The cushion is thinnest just before a snapshot arrives; that reading is
// followed by a "valley": a thinner reading pulls it down at once (a late
// snapshot is answered right away), a thicker one lets it rise over half a
// second or so (so it never steers on a thin spot long gone). Render speed
// steers the valley toward CUSHION_TICKS.
/** Ticks of cushion wanted at its thinnest. */
const CUSHION_TICKS = 3;
/** How far the valley moves toward each reading: a thinner one, a thicker one. */
const VALLEY_DOWN = 0.5;
const VALLEY_UP = 0.03;
/** A gap between arrivals this long (ms) is an outage, not jitter: it says
 *  nothing about the jitter to come, so the valley starts over from the next
 *  reading. */
const OUTAGE_MS = 250;
/** An arrival this soon (ms) after the one before is part of a bunch; the
 *  thin point was before the bunch's first, so it gives no reading. */
const BUNCHED_MS = 8;
/** Render speed heads for real speed times 1 + bias + STEER x (valley -
 *  CUSHION_TICKS) and eases there by RATE_EASE a tick, so speed never changes
 *  abruptly. The steer is held to MAX_SLOW slower (a few percent, too little to
 *  see) and MAX_HURRY faster (the cushion is thick even at its thinnest, as
 *  after an outage: a brief fast-forward beats drawing everyone that far in the
 *  past for seconds). The bias learns, BIAS_GAIN per tick of error per tick,
 *  how fast the server is really ticking against our clock, so a server that
 *  runs a few percent slow or fast for a while doesn't leave the cushion thin
 *  or fat; it only learns near the target (within BIAS_BAND ticks) and stays
 *  within MAX_BIAS. */
const STEER = 0.04;
const MAX_SLOW = 0.08;
const MAX_HURRY = 0.25;
const RATE_EASE = 0.05;
const BIAS_GAIN = 0.0005;
const BIAS_BAND = 3;
const MAX_BIAS = 0.06;
/** This many ticks further behind than needed and render time jumps. */
const JUMP_TICKS = 60;
/** Applied this many ticks behind render time, a snapshot is stale (a
 *  backgrounded tab catching up): its events are dropped, not played in a heap. */
const STALE_TICKS = 30;
/** The server's tick count going back this far means the match restarted. */
const RESTART_TICKS = 60;

// --- prediction ---------------------------------------------------------------
/** Inputs kept for replay at most (2 s): beyond this the server isn't hearing us. */
const MAX_PENDING = 120;
/** A correction bigger than this (px) is a jump (a respawn, a vehicle shove),
 *  not drift: taken at once. */
const SNAP_DIST = 80;
/** Fraction of a correction still showing after each tick (gone in ~100 ms). */
const SMOOTH_KEEP = 0.85;

const AP = { l1: 1, l2: 1, l3: 1, l4: 1 };

/** A pose as of the last applied snapshot. `f` = facing angle. */
interface Pose {
  x: number;
  y: number;
  f: number;
}
/** A vehicle's pose likewise. */
interface VehiclePose {
  x: number;
  y: number;
  a: number;
  ta: number[];
}

/** How a round in flight looks, from its first listing (see BulletSnap). */
type BulletLook = Pick<Bullet, "tracerWidth" | "tracerLength" | "tracerColor" | "renderAfter" | "origin">;
type ProjLook = Pick<Projectile, "renderAfter" | "origin" | "bodyRadius" | "color" | "trailColor" | "sprite" | "spriteScale">;
/** A round in flight: what is drawn, and where it was at which server tick,
 *  from which it flies on in a straight line. `own` = ours, drawn on the
 *  present clock rather than the delayed one. */
interface Round<T> {
  r: T;
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  own: boolean;
}

/** A received snapshot waiting for render time, with its characters and
 *  vehicles by id for the interpolation to look ahead into. */
interface Buffered {
  m: SnapMsg;
  chars: Map<number, CharSnap>;
  vehicles: Map<number, VehicleSnap>;
}

const angleLerp = (a: number, b: number, t: number): number => {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const PREDICTED_SLOTS: readonly EquipSlot[] = ["primary", "secondary", "hand"];

export type NetStatus = "connecting" | "connected" | "reconnecting" | "rejected" | "left";

export class NetSession implements Session {
  world: World;
  player: Character;
  readonly characters: Character[] = [];
  readonly bodies: Body[] = [];
  /** The server tick of the last snapshot applied (the delayed clock). */
  tick = 0;
  controllable = false;
  killFeed: KillFeedEntry[] = [];
  minimapDeaths: DeathMark[] = [];

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
  /** Where outgoing messages go instead of the socket, if set (a headless
   *  test carrying them to a server itself). */
  outbox: ((msg: ClientMsg) => void) | null = null;

  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly name: string;
  private readonly password: string | undefined;
  private token: string | null;
  private myId = 0;
  private snapMs = 1000 / DEFAULT_SNAP_HZ;
  /** The HUD as the server last sent it, its scoreboard rows (sent on their
   *  own), and the two put back together for hud(). */
  private hudHead: GamemodeHud | null = null;
  private hudPlayers: PlayerRow[] | null = null;
  private hudState: GamemodeHud | null = null;
  private label: string | null = null;
  private interactableId: number | null = null;
  private seat: { vh: number; st: number } | null = null;
  private view = { zoom: 1, spread: 0, cone: 360 };
  private grid: ObstacleGrid | null = null;
  private readonly mirrors = new Map<number, Character>();
  private readonly bodyById = new Map<number, Body>();
  private readonly itemById = new Map<number, GroundItem>();
  private readonly vehicleById = new Map<number, Vehicle>();
  private readonly bullets = new Map<number, Round<Bullet>>();
  private readonly projs = new Map<number, Round<Projectile>>();
  /** The look of every round we've been told about and still draw. */
  private readonly bulletLook = new Map<number, BulletLook>();
  private readonly projLook = new Map<number, ProjLook>();
  /** Events waiting for the next step() to hand them to the effects pipeline. */
  private pendingEvents: GameEvent[] = [];
  private lastPingAt = 0;
  private reconnectTimer: number | null = null;

  // The delayed clock (see the file comment).
  private readonly buffer: Buffered[] = [];
  private lastReceivedTick = -1;
  /** Render time (server ticks), the wall time it was last advanced to, and
   *  the thinnest the cushion has recently been (see CUSHION_TICKS). */
  private renderAt: number | null = null;
  private renderNow = 0;
  /** The cushion's valley (see VALLEY_DOWN), and whether the next reading
   *  sets it outright (after an outage). */
  private valley = 0;
  private freshValley = false;
  /** Render speed, as a multiple of real time, and its learned bias. */
  private rate = 1;
  private bias = 0;
  /** When the newest snapshot arrived (wall ms). */
  private lastArrival = 0;
  /** Average cushion (ticks), for the delay figure and our own rounds' clock. */
  private lead = 0;
  /** The server tick we last came back on (a respawn, on arrival): a death of
   *  ours older than this, reached late on the delayed clock, is stale. */
  private ownBackTick = -1;
  /** Poses as of the last applied snapshot, interpolated from toward the next. */
  private readonly poses = new Map<number, Pose>();
  private readonly vehiclePoses = new Map<number, VehiclePose>();

  // Prediction (see the file comment).
  private seq = 0;
  /** Inputs sent and not yet applied by the server, oldest first. */
  private pending: { seq: number; input: PlayerInput }[] = [];
  private predicting = false;
  /** Our predicted position and level; `player.pos` is this plus `smooth`. */
  private predPos: Vec2 = vec(0, 0);
  private smooth: Vec2 = vec(0, 0);
  /** Where our own simulation's events go while replaying (heard by no one). */
  private readonly muted: GameEvent[] = [];
  /** The match's shot seed (WelcomeMsg.salt; see engine/rng.ts). */
  private salt = 0;
  /** Our own rounds, predicted: fired here the instant the trigger is pulled
   *  (seeded as the server seeds the real shot, so they fly the same way) and
   *  flown here against everyone as we draw them, impacts and all. The
   *  server's copies of them, and of what they hit, aren't shown. */
  private ownBullets: Bullet[] = [];

  /** `host` is "host:port" or a full ws:// URL; `name` is what to join as;
   *  `password` the server's join password, if it has one. `connect` = false
   *  builds the mirror without a socket (a headless test feeds it messages
   *  through receive()). */
  constructor(host: string, name: string, connect = true, password?: string) {
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    this.url = serverUrls(host, secure).ws;
    this.name = name;
    this.password = password || undefined;
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
      this.send({ t: "join", protocol: PROTOCOL, name: this.name, token: this.token ?? undefined, password: this.password });
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
      if (this.status === "rejected" || this.status === "left") return;
      this.status = "reconnecting";
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS) as unknown as number;
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private send(msg: ClientMsg): void {
    if (this.outbox) this.outbox(msg);
    else if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Leave the match for good: the server frees our slot at once instead of
   *  holding it for a reconnect, and nothing here tries to reconnect. */
  leave(): void {
    this.send({ t: "leave" });
    this.status = "left"; // so the onclose that follows doesn't reconnect
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(`madtac.token.${this.url}`);
    this.ws?.close();
  }

  /** Take one server message (the socket's onmessage, or a test's hand, with
   *  the arrival time it wants). */
  receive(msg: ServerMsg, nowMs = performance.now()): void {
    if (msg.t === "welcome") this.welcome(msg);
    else if (msg.t === "snap") this.onSnapshot(msg, nowMs);
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
    this.salt = m.salt;
    this.ownBullets = [];
    const rejoin = this.myId === m.id && this.meta !== null;
    this.myId = m.id;
    this.meta = m.meta;
    this.tick = m.tick;
    // The server starts every connection from nothing (a fresh ClientMirror),
    // so it will re-send everything we can see but can't say what went away
    // while we were gone. Forget every mirror; on a rejoin (same match, same
    // character) keep the world and our own character, which main.ts holds.
    if (!rejoin) {
      // A new match (or our first): the level's geometry. What is on it —
      // items, vehicles, rounds — is the server's to say, under its ids.
      this.world = loadLevel(m.level).world;
      this.world.grid = new ObstacleGrid(this.world.obstacles);
      this.grid = this.world.grid;
    }
    // Blood on the floor lasts as long as the server's gamemode says.
    this.world.bloodTtl = m.bloodTtl;
    this.world.items.length = 0;
    this.world.vehicles.length = 0;
    this.world.bullets = [];
    this.world.projectiles = [];
    this.characters.length = 0;
    this.bodies.length = 0;
    this.mirrors.clear();
    this.bodyById.clear();
    this.itemById.clear();
    this.vehicleById.clear();
    this.bullets.clear();
    this.projs.clear();
    this.bulletLook.clear();
    this.projLook.clear();
    this.poses.clear();
    this.vehiclePoses.clear();
    this.buffer.length = 0;
    this.pendingEvents.length = 0;
    this.renderAt = null;
    this.lastReceivedTick = -1;
    this.ownBackTick = -1;
    // Inputs sent into a dead socket were never heard: nothing to replay.
    this.pending = [];
    this.predicting = false;
    if (rejoin) {
      this.mirrors.set(m.id, this.player);
      this.characters.push(this.player);
      return;
    }
    // A new match: a fresh character, none of the last match's state on it.
    this.player = new Character(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
    this.player = this.mirror(m.id);
    this.onReady?.();
  }

  // ------------------------------------------------------ the snapshot ----

  /** A snapshot arrives. What is ours applies now (our character, the private
   *  block, the HUD, hits); the world waits in the buffer for render time. */
  private onSnapshot(m: SnapMsg, now: number): void {
    // The match restarted (its tick count started over): nothing buffered from
    // before applies to the new one; show it all now and start the clock again.
    if (this.lastReceivedTick >= 0 && m.tick < this.lastReceivedTick - RESTART_TICKS) {
      this.flush();
      this.renderAt = null;
      this.lastReceivedTick = -1;
    }
    // Render time up to this arrival, before it counts: the cushion is at its
    // thinnest right now, which is what sizes it.
    this.renderTick(now);
    const gap = now - this.lastArrival;
    if (gap >= OUTAGE_MS) {
      this.freshValley = true;
    } else if (this.renderAt !== null && gap >= BUNCHED_MS) {
      const c = this.lastReceivedTick - this.renderAt;
      if (this.freshValley) this.valley = c;
      else this.valley += (c - this.valley) * (c < this.valley ? VALLEY_DOWN : VALLEY_UP);
      this.freshValley = false;
    }
    this.lastReceivedTick = m.tick;
    this.lastArrival = now;

    // Hits are feedback (a hit marker, our own hurt), not scenery: at once.
    // (Not the hits of our own rounds while we predict them: we've shown those.)
    for (const e of m.events) {
      if (e.kind === "hit" && !(e.round && e.attacker === this.myId && this.predicting)) this.pendingEvents.push(e);
    }

    // Our own character, all but its pose (which is predicted, or else drawn
    // on the delayed clock with everyone's).
    if (m.gone.includes(this.myId)) {
      // We are always in our own view, so our own character going means it
      // left the roster: we died. Dead from now (prediction stops, the HUD
      // knows); it stays drawn, frozen where it fell, until the delayed clock
      // reaches this snapshot and its corpse takes its place (applyWorld).
      const c = this.mirrors.get(this.myId);
      if (c) c.hp = 0;
    }
    const mine = m.chars.find((s) => s.id === this.myId);
    if (mine) {
      // Back from the dead (a respawn): a death still waiting on the delayed
      // clock must not take us out again.
      if (!this.mirrors.has(this.myId) || this.player.hp <= 0) this.ownBackTick = m.tick;
      this.applyOwn(mine);
    }
    this.applyPrivate(m);
    this.reconcile(m.me, m.seq);

    // Rounds: the look of each comes with its first listing; ours fly now.
    for (const s of m.bullets) {
      if (s.w !== undefined) {
        this.bulletLook.set(s.id, {
          tracerWidth: s.w, tracerLength: s.l ?? 0, tracerColor: s.c ?? "#fff",
          renderAfter: s.ra ?? 0, origin: vec(s.ox ?? s.x, s.oy ?? s.y),
        });
      }
    }
    for (const s of m.projs) {
      if (s.br !== undefined) {
        this.projLook.set(s.id, {
          renderAfter: s.ra ?? 0, origin: vec(s.ox ?? s.x, s.oy ?? s.y), bodyRadius: s.br,
          color: s.c ?? "#fff", trailColor: s.tc ?? "#fff", sprite: s.sp, spriteScale: s.ss,
        });
      }
    }
    this.syncRounds(m, true);

    this.buffer.push({ m, chars: new Map(m.chars.map((s) => [s.id, s])), vehicles: new Map(m.vehicles.map((s) => [s.id, s])) });
  }

  /** How far behind the newest snapshot everyone else is drawn, on average,
   *  counting the wait for the next (ms). */
  get delay(): number {
    return (this.lead + this.snapMs / TICK_MS / 2) * TICK_MS;
  }

  /** The server tick to draw everyone else at, at `now` (fractional): see the
   *  playout buffer above. Advancing it is idempotent for a given `now`. */
  renderTick(now: number): number {
    if (this.lastReceivedTick < 0) return this.tick;
    const snapTicks = this.snapMs / TICK_MS;
    if (this.renderAt === null) {
      // Start a snapshot interval plus the cushion behind the newest, as of
      // when it arrived.
      this.renderAt = this.lastReceivedTick - snapTicks - CUSHION_TICKS;
      this.renderNow = this.lastArrival;
      this.valley = CUSHION_TICKS;
      this.freshValley = false;
      this.lead = snapTicks + CUSHION_TICKS;
      this.rate = 1;
      this.bias = 0;
    }
    if (now > this.renderNow) {
      const dt = (now - this.renderNow) / TICK_MS;
      if (this.valley - CUSHION_TICKS > JUMP_TICKS) {
        // Far behind: no point hurrying.
        this.renderAt += this.valley - CUSHION_TICKS;
        this.valley = CUSHION_TICKS;
      }
      const err = this.valley - CUSHION_TICKS;
      if (Math.abs(err) < BIAS_BAND) this.bias = Math.max(-MAX_BIAS, Math.min(MAX_BIAS, this.bias + BIAS_GAIN * err * dt));
      const want = 1 + this.bias + Math.max(-MAX_SLOW, Math.min(MAX_HURRY, STEER * err));
      this.rate += (want - this.rate) * Math.min(1, RATE_EASE * dt);
      this.renderAt += dt * this.rate;
      this.renderNow = now;
      // Never past the newest snapshot: with nothing newer in hand, everyone
      // holds where they last were until more arrives.
      if (this.renderAt > this.lastReceivedTick) this.renderAt = this.lastReceivedTick;
      this.lead += (this.lastReceivedTick - this.renderAt - this.lead) * Math.min(1, dt / 30);
    }
    return this.renderAt;
  }

  /** The server tick it is "now", as far as we know (our own rounds' clock):
   *  render time plus the average cushion, so it is as smooth. */
  private presentTick(now: number): number {
    return this.renderTick(now) + this.lead;
  }

  /** Apply every buffered snapshot render time has reached. */
  private advance(now: number): void {
    const r = this.renderTick(now);
    while (this.buffer.length && this.buffer[0].m.tick <= r) this.applyWorld(this.buffer.shift()!.m, r);
  }

  /** Apply everything buffered at once (a restart; a test that wants the
   *  world as the server last described it). */
  flush(): void {
    while (this.buffer.length) {
      const m = this.buffer.shift()!.m;
      this.applyWorld(m, m.tick);
    }
  }

  // ---------------------------------------------------------- mirrors ----

  /** The mirror for character `id`, made on first sight. Our own is the one
   *  object `player` for the whole session, as in a local Game (where a
   *  human is revived in place): main.ts holds that reference, so a respawn
   *  (our character leaving the snapshots, then coming back) must bring back
   *  the same object, not a new one the screen never sees. */
  private mirror(id: number): Character {
    let c = this.mirrors.get(id);
    if (!c) {
      c = id === this.myId ? this.player : new Character(vec(0, 0), DEFAULT_SKIN, { hand: new Gun(UNARMED) });
      c.id = id;
      this.mirrors.set(id, c);
      this.characters.push(c);
    }
    return c;
  }

  /** A full record: kit, team, look. `equip` = also take its slot in hand
   *  (not for our predicted player, whose slot follows our own inputs). */
  private applyFull(c: Character, f: CharFull, equip: boolean): void {
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
    if (equip && c.equippedSlot !== f.slot) {
      c.equip(f.slot);
      c.gun.drawTicks = 0; // the snapshot's own draw timer follows
    }
  }

  /** A character's state besides its pose: health, the held gun's timers, the
   *  utility timer, its seat. */
  private applyState(c: Character, s: CharSnap): void {
    c.z = s.z ?? 0;
    c.hp = s.hp;
    const g = c.gun;
    g.kickback = s.k ?? 0;
    g.flashTicks = s.fl ?? 0;
    g.fireCooldown = s.co ?? 0;
    g.reloadTicks = s.re ?? 0;
    g.drawTicks = s.dr ?? 0;
    g.setPunch(s.pu ?? 0);
    c.setUseTimer(s.us ?? 0, s.ut ?? 0);
    c.vehicle = s.vh ? (this.vehicleById.get(s.vh) ?? null) : null;
    c.seatIndex = s.st ?? -1;
  }

  /** Our own character's record, on arrival. Predicting, our gun's timers,
   *  slot and position are ours to run (see reconcile); the rest is the
   *  server's. Not predicting, it is everyone's treatment, but on arrival. */
  private applyOwn(s: CharSnap): void {
    const c = this.mirror(s.id);
    const predicting = this.canPredict();
    if (s.full) this.applyFull(c, s.full, !predicting);
    if (predicting) {
      c.hp = s.hp;
      c.vehicle = s.vh ? (this.vehicleById.get(s.vh) ?? null) : null;
      c.seatIndex = s.st ?? -1;
    } else {
      this.applyState(c, s);
    }
  }

  /** A snapshot's world, once render time reaches it: who is where (the
   *  starting poses for the interpolation), what changed, what happened. `r`
   *  is the render tick it is applied at. */
  private applyWorld(m: SnapMsg, r: number): void {
    // Age what the server won't re-send just for aging, by the ticks since the
    // last snapshot applied (none across a restart). Anything this snapshot
    // does carry overwrites its age with the server's.
    const dt = Math.max(0, m.tick - this.tick);
    this.tick = m.tick;
    if (dt > 0) {
      for (const it of this.world.items) it.age += dt;
      for (const b of this.bodies) b.age += dt;
    }
    for (const id of m.gone) {
      // Ours: our death, now that the delayed clock is here (the corpse comes
      // in this same snapshot) — unless we've respawned since.
      if (id === this.myId && this.ownBackTick > m.tick) continue;
      const c = this.mirrors.get(id);
      if (!c) continue;
      this.mirrors.delete(id);
      this.poses.delete(id);
      const i = this.characters.indexOf(c);
      if (i >= 0) this.characters.splice(i, 1);
    }
    // Vehicles before characters, so a seated character can find its seat.
    for (const id of m.goneVehicles) {
      const v = this.vehicleById.get(id);
      if (!v) continue;
      this.vehicleById.delete(id);
      this.vehiclePoses.delete(id);
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
      this.vehiclePoses.set(s.id, { x: s.x, y: s.y, a: s.a, ta: s.ta.slice() });
    }
    for (const s of m.chars) {
      const own = s.id === this.myId;
      if (own && (this.predicting || this.player.hp <= 0 || !this.mirrors.has(s.id))) {
        // Ours, and in the present (predicted), dead (frozen where it fell) or
        // out of the roster: nothing for the delayed clock to do with it, and
        // it must not be put back. Forget its last delayed pose, so if it goes
        // on the delayed clock later (a seat) it starts from where it's drawn.
        this.poses.delete(s.id);
        continue;
      }
      const c = this.mirror(s.id);
      if (!own) {
        if (s.full) this.applyFull(c, s.full, true);
        this.applyState(c, s);
      }
      if (!this.poses.has(s.id)) {
        c.pos = vec(s.x, s.y);
        c.forward = vec(Math.cos(s.f), Math.sin(s.f));
      }
      this.poses.set(s.id, { x: s.x, y: s.y, f: s.f });
    }

    this.syncRounds(m, false);

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

    // The scenery's events, now that it is time for them: not hits (they went
    // on arrival), not the sounds of our own actions we already played, and
    // nothing at all from a snapshot render time left far behind.
    if (r - m.tick > STALE_TICKS) return;
    for (const e of m.events) {
      if (e.kind === "hit") continue;
      if ((e as { by?: number }).by === this.myId && this.predicting) continue; // ours: played already
      if (e.kind !== "decal") {
        this.pendingEvents.push(e);
      } else {
        const on = this.world.obstacles[e.oi];
        if (on) this.pendingEvents.push({ kind: "decal", near: e.near, on, z: e.z, heft: e.heft });
      }
    }
  }

  /** Bring the rounds in line with snapshot `m`: ours on arrival (`arrival`),
   *  everyone else's when render time reaches it. A round that snapshot no
   *  longer lists has landed or left view. */
  private syncRounds(m: SnapMsg, arrival: boolean): void {
    const sync = <T extends Bullet | Projectile, S extends BulletSnap | ProjSnap>(
      list: S[],
      rounds: Map<number, Round<T>>,
      looks: Map<number, object>,
      make: (s: S) => T | null,
    ): void => {
      const listed = new Set<number>();
      for (const s of list) {
        if (!!s.o !== arrival) continue;
        listed.add(s.id);
        let rd = rounds.get(s.id);
        if (!rd) {
          const r = make(s);
          if (!r) continue; // never told how it looks: nothing to draw
          rd = { r, tick: m.tick, x: s.x, y: s.y, vx: s.vx, vy: s.vy, own: !!s.o };
          rounds.set(s.id, rd);
        }
        rd.tick = m.tick;
        rd.x = s.x;
        rd.y = s.y;
        rd.vx = s.vx;
        rd.vy = s.vy;
        rd.r.vel = vec(s.vx, s.vy);
        rd.r.z = s.z;
      }
      for (const [id, rd] of rounds) {
        if (rd.own !== arrival || listed.has(id)) continue;
        rounds.delete(id);
        looks.delete(id);
      }
    };
    sync(m.bullets, this.bullets, this.bulletLook, (s) => {
      const look = this.bulletLook.get(s.id);
      if (!look) return null;
      return {
        id: s.id, pos: vec(s.x, s.y), prev: vec(s.x, s.y), vel: vec(s.vx, s.vy), z: s.z, life: 600,
        owner: null, damage: 0, armorPen: AP, penetration: 0, penUsed: 0, penSkip: 0, gun: null, ...look,
      };
    });
    sync(m.projs, this.projs, this.projLook, (s) => {
      const look = this.projLook.get(s.id);
      if (!look) return null;
      return {
        id: s.id, pos: vec(s.x, s.y), prev: vec(s.x, s.y), vel: vec(s.vx, s.vy), z: s.z, life: 600,
        owner: null, damage: 0, radius: 0, armorPen: AP, gun: null, ...look,
      };
    });
  }

  /** The private block, the HUD, the feed and the death marks, on arrival. */
  private applyPrivate(m: SnapMsg): void {
    // The feed and the marks are HUD, on the present clock: aged by the ticks
    // between snapshots received.
    const me = this.player;
    const mine = m.me;
    if (me.armor) me.armor.hp = mine.armorHp;
    me.regenTicks = mine.regenTicks;
    me.regenRate = mine.regenRate;
    me.damageMarks = mine.marks;
    this.view = { zoom: mine.zoom, spread: mine.spread, cone: mine.cone };
    this.controllable = mine.ctrl;
    this.label = mine.label;
    this.interactableId = mine.item;
    this.seat = mine.seat;
    if (m.hud !== undefined || m.players !== undefined) {
      if (m.hud !== undefined) this.hudHead = m.hud;
      if (m.players !== undefined) this.hudPlayers = m.players;
      this.hudState = this.hudHead ? { ...this.hudHead, players: this.hudPlayers ?? undefined } : null;
    }
    if (m.feed) {
      this.killFeed = m.feed.map((f) => ({ ...f, gun: f.gun ? (ALL_GUN_SPECS[f.gun] ?? null) : null }));
    }
    if (m.deaths) this.minimapDeaths = m.deaths;
  }

  // ------------------------------------------------------- prediction ----

  /** Our player can be predicted: alive, in control, on foot, in the roster. */
  private canPredict(): boolean {
    const c = this.player;
    return this.meta !== null && this.controllable && c.hp > 0 && !c.vehicle && this.mirrors.get(this.myId) === c;
  }

  /** The server has applied our inputs up to `acked`, leaving us as `me` says:
   *  rewind there, replay the inputs it hasn't seen, and keep what we showed
   *  as a correction to melt away. */
  private reconcile(me: MeSnap, acked: number): void {
    this.pending = this.pending.filter((p) => p.seq > acked);
    const was = this.predicting;
    this.predicting = this.canPredict();
    const c = this.player;
    if (!this.predicting) {
      c.gun.mag = me.mag;
      c.gun.reserveMags = me.res;
      return;
    }
    const shown = was ? this.predPos : null;

    // Rewind. The gun's look (kick, flash, a punch) stays as it is: replaying a
    // shot must not show it twice.
    const g0 = c.gun;
    const look = { kick: g0.kickback, flash: g0.flashTicks, punch: g0.punch };
    c.pos = vec(me.px, me.py);
    c.vel = vec(me.vx, me.vy);
    c.z = me.pz;
    c.staggerTicks = me.stg;
    c.staggerMul = me.stm;
    if (c.equippedSlot !== me.sl) this.quietly(() => c.equip(me.sl));
    const g = c.gun;
    g.fireCooldown = me.co;
    g.reloadTicks = me.re;
    g.drawTicks = me.dr;
    // The spray too: the replay below fires the unacked shots again, and each
    // adds to currentRecoil, so without this it would climb by every unacked
    // shot on every snapshot and our predicted rounds spray far past the real.
    g.currentRecoil = me.rc;
    g.idleTicks = me.ri;
    g.mag = me.mag;
    g.reserveMags = me.res;
    c.setUseTimer(me.us, Math.max(me.us, c.useTotalTicks));

    // Replay what the server hasn't seen yet, silently.
    for (const p of this.pending) this.simulate(p, false);

    const now = c.gun;
    if (now === g0) {
      now.kickback = look.kick;
      now.flashTicks = look.flash;
      now.setPunch(look.punch);
    }
    const after = c.pos;
    this.predPos = after;
    if (shown) {
      const err = sub(shown, after);
      this.smooth = len(add(this.smooth, err)) > SNAP_DIST ? vec(0, 0) : add(this.smooth, err);
    } else {
      this.smooth = vec(0, 0); // just started predicting: take the server's word
    }
    c.pos = add(this.predPos, this.smooth);
  }

  /** Run `f` with our character's events going nowhere. */
  private quietly(f: () => void): void {
    const c = this.player;
    const events = c.events;
    c.events = this.muted;
    f();
    c.events = events;
    this.muted.length = 0;
  }

  /**
   * One tick of our own player, as the server's Game.update runs it for a
   * human (prepareHuman's one-shots on our own kit, moveHuman, tickWeapon, the
   * stagger part of tickStatus, fireHuman), as far as this side can know it:
   * pickups, drops, utility use and healing stay the server's. `live` = the
   * tick being played now (heard and seen); otherwise a silent replay.
   */
  private simulate(p: { seq: number; input: PlayerInput }, live: boolean): void {
    const input = p.input;
    const c = this.player;
    const events = live ? this.world.events : this.muted;
    const saved = c.events;
    c.events = events;
    if (input.equip && PREDICTED_SLOTS.includes(input.equip)) c.equip(input.equip);
    if (input.reload) c.reload();
    if (input.cancel) c.cancelAction();
    c.forward = input.aim;
    c.onStairs = stairDirAt(this.world, c);
    walk(this.world, c, input.move);
    c.tickWeapon();
    if (c.useTicks > 0) c.setUseTimer(c.useTicks - 1, c.useTotalTicks);
    c.tickStagger();
    const f = c.gun.spec.fire;
    if (f && !c.holdingUtility && (f.auto ? input.fire : input.firePressed)) {
      // The real trigger, into a world of its own: what it spawns becomes our
      // predicted rounds (live) or is thrown away (a replay). Seeded as the
      // server seeds this input's shot, so the spread comes out the same.
      const fw: World = { ...this.world, bullets: [], projectiles: [], events };
      c.gun.fire(fw, c.pos, c.forward, c, c.speedRatio, [], c.speedFraction, shotRng(this.salt, p.seq));
      if (live) this.ownBullets.push(...fw.bullets);
    }
    if (live) footsteps(c, events);
    c.events = saved;
    if (!live) this.muted.length = 0;
  }

  // ------------------------------------------------------------- Session ----

  get interactable(): GroundItem | null {
    return this.interactableId !== null ? (this.itemById.get(this.interactableId) ?? null) : null;
  }
  get enterable(): { vehicle: Vehicle; seat: number } | null {
    const v = this.seat ? this.vehicleById.get(this.seat.vh) : undefined;
    return this.seat && v ? { vehicle: v, seat: this.seat.st } : null;
  }
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

  /** One client tick: send this tick's input and play it on our own player,
   *  apply the snapshots render time has reached, and hand their events on. */
  step(input: PlayerInput, nowMs = performance.now()): void {
    this.seq += 1;
    // Where we're drawing everyone else: a shot this input fires should meet
    // them there on the server too (lag compensation).
    const vt = this.renderAt !== null ? Math.round(this.renderTick(nowMs) * 10) / 10 : undefined;
    this.send(vt === undefined ? { t: "input", seq: this.seq, in: input } : { t: "input", seq: this.seq, in: input, vt });
    this.pending.push({ seq: this.seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    this.world.events.length = 0;
    this.advance(nowMs);
    if (this.pendingEvents.length) {
      this.world.events.push(...this.pendingEvents);
      this.pendingEvents.length = 0;
    }

    // Everyone else's gun and status timers run between snapshots so kick,
    // flash and reloads animate smoothly; the next snapshot re-syncs them.
    for (const c of this.characters) {
      if (c === this.player && this.predicting) continue;
      c.gun.tick();
      c.tickStatus();
    }

    this.predicting = this.canPredict();
    if (this.predicting) {
      const c = this.player;
      c.pos = this.predPos;
      const from = this.world.events.length;
      this.simulate({ seq: this.seq, input }, true);
      // Our own sounds' voices, apart from the server's: a "stop reload:7" for
      // someone else's gun 7 mustn't cut ours.
      for (let i = from; i < this.world.events.length; i++) {
        const e = this.world.events[i];
        if ((e.kind === "sound" && e.voice) || e.kind === "stopSound") this.world.events[i] = { ...e, voice: `me:${e.voice}` };
      }
      this.predPos = c.pos;
      this.smooth = len(this.smooth) < 0.05 ? vec(0, 0) : scale(this.smooth, SMOOTH_KEEP);
      c.pos = add(this.predPos, this.smooth);
    }

    // Our predicted rounds fly against everyone where we draw them right now,
    // just as the server flies the real ones against where we saw them (lag
    // compensation): their impacts show the moment they happen, and harm no
    // one here (the damage is the server's to deal).
    if (this.ownBullets.length) {
      this.placeEveryone(nowMs);
      const fw: World = { ...this.world, bullets: this.ownBullets, events: this.world.events };
      updateBullets(fw, this.asDrawn());
      this.ownBullets = fw.bullets;
    }

    if (nowMs - this.lastPingAt > PING_MS && this.status === "connected") {
      this.lastPingAt = nowMs;
      this.send({ t: "ping", at: nowMs });
    }
  }

  /** Everyone else where render time puts them: between the last applied
   *  snapshot and the next. */
  private placeEveryone(nowMs: number): void {
    this.advance(nowMs);
    const r = this.renderTick(nowMs);
    const next = this.buffer[0];
    const a = next ? Math.max(0, Math.min(1, (r - this.tick) / Math.max(1, next.m.tick - this.tick))) : 0;
    for (const [id, p] of this.poses) {
      const c = this.mirrors.get(id);
      if (!c || (c === this.player && this.predicting)) continue;
      const n = next?.chars.get(id);
      const x = n ? p.x + (n.x - p.x) * a : p.x;
      const y = n ? p.y + (n.y - p.y) * a : p.y;
      const f = n ? angleLerp(p.f, n.f, a) : p.f;
      c.pos = vec(x, y);
      c.forward = vec(Math.cos(f), Math.sin(f));
    }
    for (const [id, p] of this.vehiclePoses) {
      const v = this.vehicleById.get(id);
      if (!v) continue;
      const n = next?.vehicles.get(id);
      v.pos = n ? vec(p.x + (n.x - p.x) * a, p.y + (n.y - p.y) * a) : vec(p.x, p.y);
      v.angle = n ? angleLerp(p.a, n.a, a) : p.a;
      for (let i = 0; i < v.turretAngle.length && i < p.ta.length; i++) {
        v.turretAngle[i] = n && i < n.ta.length ? angleLerp(p.ta[i], n.ta[i], a) : p.ta[i];
      }
    }
  }

  /** Everyone else, for our predicted rounds to hit: where they're drawn, as
   *  stand-ins that take no harm (the server decides the damage). */
  private asDrawn(): Hittable[] {
    const out: Hittable[] = [];
    for (const c of this.characters) {
      if (c === this.player || c.hp <= 0) continue;
      out.push({ id: c.id, pos: c.pos, z: c.z, registerHit: () => {} });
    }
    return out;
  }

  /** Before a frame: everyone else where render time puts them (between the
   *  last applied snapshot and the next), the rounds where they have flown. */
  interpolate(nowMs: number): void {
    this.placeEveryone(nowMs);
    const r = this.renderTick(nowMs);
    // Rounds fly on in a straight line from where they last were: everyone
    // else's on the delayed clock, ours on the present one. One that would
    // have crossed a wall since is out of sight (and soon out of the list).
    const present = this.presentTick(nowMs);
    const fly = <T extends Bullet | Projectile>(rounds: Map<number, Round<T>>, skipOwn = false): T[] => {
      const out: T[] = [];
      for (const rd of rounds.values()) {
        if (skipOwn && rd.own) continue;
        const dt = Math.max(0, (rd.own ? present : r) - rd.tick);
        const from = vec(rd.x, rd.y);
        const pos = vec(rd.x + rd.vx * dt, rd.y + rd.vy * dt);
        if (this.blocked(from, pos, rd.r.z)) continue;
        rd.r.pos = pos;
        rd.r.prev = sub(pos, rd.r.vel);
        out.push(rd.r);
      }
      return out;
    };
    // Our own bullets are our predicted ones; the server's copies stay hidden
    // while we predict (seated, say, ours come from the server like anyone's).
    this.world.bullets = [...fly(this.bullets, this.predicting), ...this.ownBullets];
    this.world.projectiles = fly(this.projs);
  }

  /** A wall between `a` and `b` on level `z`? Checked every 16 px. */
  private blocked(a: Vec2, b: Vec2, z: number): boolean {
    const grid = this.grid;
    if (!grid) return false;
    const d = sub(b, a);
    const n = Math.ceil(len(d) / 16);
    for (let i = 1; i <= n; i++) if (grid.hit(add(a, scale(d, i / n)), z)) return true;
    return false;
  }
}
