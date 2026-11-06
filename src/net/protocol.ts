/**
 * The wire: what a client and a server say to each other, as JSON.
 *
 * survev-shaped. The client sends its PlayerInput every tick (or when it
 * changes) and a few one-shot requests; the server sends a snapshot at
 * DEFAULT_SNAP_HZ with everything this client can SEE — a pose per visible
 * character that moved, its full record only when that changed, complete
 * lists of rounds in flight, diffs for items / corpses / vehicles, the tick's
 * events, and the private block (`me`) only its own player is told.
 *
 * JSON, kept small by what is sent rather than how: positions to a tenth of a
 * pixel and facings as one angle, fields left out at their resting value, a
 * character only when it moved or changed, a round's look only the first time,
 * and nothing re-sent just because it aged (the client ages corpses, drops,
 * feed lines and death marks itself between updates). A binary encoding is a
 * measured decision for later.
 */
import type { EquipSlot, DamageMark } from "../entities/actor.ts";
import type { Skin } from "../entities/character.ts";
import type { TeamId } from "../entities/team.ts";
import type { PlayerInput } from "../engine/command.ts";
import type { GameEvent } from "../engine/events.ts";
import type { Vec2 } from "../engine/vec.ts";
import type { GamemodeHud, KillFeedEntry, PlayerLoadout, PlayerRow } from "../gamemodes/gamemode.ts";
import type { LevelMeta } from "../world/level.ts";
import type { DeathMark } from "../ui/minimap.ts";
import { vec } from "../engine/vec.ts";

/** Bumped whenever a message shape changes; a mismatch is rejected at join. */
export const PROTOCOL = 4;
/** Sim ticks per second, both sides. */
export const SIM_HZ = 60;
/** Snapshots per second the server sends by default (every other tick). */
export const DEFAULT_SNAP_HZ = 30;
/** Default listen port, and the websocket route on it. */
export const DEFAULT_PORT = 7777;
export const WS_PATH = "/play";
/** The match description route on the same port (see server/server.ts). */
export const INFO_PATH = "/info";

/** Where a server lives, from what a player typed: "host:port", a bare host
 *  (then the page's own scheme picks the port: 443 under https), a full
 *  ws:// / wss:// URL, or the http(s):// link a tunnel prints (its host is
 *  used, secure if https). `secure` is whether the page is https, which
 *  forces wss for the bare forms, since a browser refuses plain ws from a
 *  secure page. */
export function serverUrls(address: string, secure: boolean): { ws: string; info: string } {
  const a = address.trim();
  const full = /^(wss?):\/\/([^/]+)(\/.*)?$/i.exec(a);
  if (full) {
    const httpScheme = full[1].toLowerCase() === "wss" ? "https" : "http";
    return { ws: `${full[1].toLowerCase()}://${full[2]}${full[3] ?? WS_PATH}`, info: `${httpScheme}://${full[2]}${INFO_PATH}` };
  }
  const link = /^(https?):\/\/([^/]+)/i.exec(a);
  if (link) {
    const tls = link[1].toLowerCase() === "https";
    return { ws: `${tls ? "wss" : "ws"}://${link[2]}${WS_PATH}`, info: `${tls ? "https" : "http"}://${link[2]}${INFO_PATH}` };
  }
  const host = a.replace(/\/+$/, "");
  return {
    ws: `${secure ? "wss" : "ws"}://${host}${WS_PATH}`,
    info: `${secure ? "https" : "http"}://${host}${INFO_PATH}`,
  };
}

/** What GET /info answers: the match, for a find-game screen. */
export interface ServerInfo {
  level: string;
  mode: string;
  players: number;
  maxPlayers: number;
  tick: number;
  protocol: number;
  path: string;
  /** Joining takes a password. */
  locked?: boolean;
}

// ------------------------------------------------------- client -> server ----

export type ClientMsg =
  /** First message on a socket. `token` re-attaches to a slot the server is
   *  still holding for a dropped connection (see WelcomeMsg.token);
   *  `password` is the server's join password, when it has one. */
  | { t: "join"; protocol: number; name: string; token?: string; password?: string }
  /** The player's intent for one tick: sent every client tick, `seq` climbing
   *  by one each time. The server applies exactly one per tick, in order, and
   *  each snapshot names the last it applied (SnapMsg.seq): what lets a client
   *  predict its own player and replay the rest (see net/client.ts). `vt` is
   *  the server tick the client was drawing everyone else at: a shot this
   *  input fires meets its targets there (lag compensation, capped; see
   *  Bullet.rewind). */
  | { t: "input"; seq: number; in: PlayerInput; vt?: number }
  /** Respawn-screen picks (see Gamemode.setPlayerLoadout / randomize / respawn). */
  | { t: "loadout"; loadout: PlayerLoadout }
  | { t: "random" }
  | { t: "respawn" }
  | { t: "ping"; at: number }
  /** Gone for good (back to the menu): free the slot now, no reconnect grace. */
  | { t: "leave" };

// ------------------------------------------------------- server -> client ----

/** What a character looks like, sent when it changes (or first seen). */
export interface CharFull {
  name: string;
  team: TeamId;
  skin: Skin;
  maxHp: number;
  /** Which slot is held, and what is in each (gun spec keys; null = empty). */
  slot: EquipSlot;
  primary: string | null;
  secondary: string | null;
  hand: string;
  armor: string | null;
  /** The selected belt item (utility spec key) and how many, for the held icon. */
  util: string | null;
  utilN: number;
}

/** A visible character: where it is, how it is posed. Sent when any of it
 *  changed since this client last heard (and on a periodic refresh); a
 *  character still in view but left out of a snapshot is standing as it was.
 *  Optional fields are left out at their resting value. */
export interface CharSnap {
  id: number;
  /** Position, to 0.1 px. */
  x: number;
  y: number;
  /** Facing as an angle (radians, atan2 of the unit forward), to 0.001. */
  f: number;
  /** Health, to 0.1 (rounded up: alive is never sent as 0). */
  hp: number;
  /** Floor level; absent = 0. */
  z?: number;
  /** The held gun's cosmetic timers, absent = 0: kickback px, flash ticks,
   *  fire cooldown, reload ticks left, draw ticks left, punch (signed by hand;
   *  see Gun.punch). */
  k?: number;
  fl?: number;
  co?: number;
  re?: number;
  dr?: number;
  pu?: number;
  /** Utility use timer: ticks left / total (absent = 0, not using). */
  us?: number;
  ut?: number;
  /** Seated: the vehicle's id (absent = on foot) and seat index (absent = -1). */
  vh?: number;
  st?: number;
  full?: CharFull;
}

/** What only this client's own player is told. */
export interface MeSnap {
  mag: number;
  res: number;
  armorHp: number;
  regenTicks: number;
  regenRate: number;
  marks: DamageMark[];
  /** View targets (see ui/view.ts). */
  zoom: number;
  spread: number;
  cone: number;
  ctrl: boolean;
  /** The E prompt: its label, the item it highlights, the seat it rings. */
  label: string | null;
  item: number | null;
  seat: { vh: number; st: number } | null;
  /** Our own character as of the last input the server applied (SnapMsg.seq):
   *  where a predicting client rewinds to before replaying the inputs it has
   *  sent since. Position (0.01 px) and velocity (0.001 px/tick), level,
   *  stagger (ticks left, speed factor), the slot in hand, the held gun's fire
   *  cooldown / reload / draw ticks, and the utility use ticks left. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  pz: number;
  stg: number;
  stm: number;
  sl: EquipSlot;
  co: number;
  re: number;
  dr: number;
  us: number;
}

/** A ground item, sent when it appears or moves. `ag` is its age when sent;
 *  the client ages it from there (an item is not re-sent just for aging). */
export interface ItemSnap {
  id: number;
  kind: "gun" | "armor" | "util";
  key: string;
  n?: number;
  x: number;
  y: number;
  z: number;
  /** Lifetime / age, for the despawn blink. */
  lt: number | null;
  ag: number;
}

/** A corpse, sent when it appears or moves; aged by the client like an item. */
export interface BodySnap {
  id: number;
  x: number;
  y: number;
  z: number;
  a: number;
  skin: Skin;
  team: TeamId;
  lt: number | null;
  ag: number;
}

export interface VehicleSnap {
  id: number;
  key: string;
  x: number;
  y: number;
  a: number;
  z: number;
  /** Turret facing per part. */
  ta: number[];
}

/** A round in flight: where it is and where it is going, every snapshot. How
 *  it looks (tracer, origin) never changes, so it rides only the first
 *  snapshot that lists the round to this client (`w` present = first). */
export interface BulletSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  w?: number;
  l?: number;
  c?: string;
  ra?: number;
  ox?: number;
  oy?: number;
  /** 1 = this client's own round (drawn without the interpolation delay). */
  o?: 1;
}

/** A projectile in flight, like a BulletSnap: its look only the first time
 *  (`br` present = first). */
export interface ProjSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  ra?: number;
  ox?: number;
  oy?: number;
  br?: number;
  c?: string;
  tc?: string;
  sp?: string;
  ss?: number;
  /** 1 = this client's own (see BulletSnap.o). */
  o?: 1;
}

/** A GameEvent as sent: a decal names its obstacle by index into the level's
 *  obstacle list (both sides load the same level), everything else as is. */
export type WireEvent =
  | Exclude<GameEvent, { kind: "decal" }>
  | { kind: "decal"; near: Vec2; oi: number; z: number; heft: number; by?: number };

/** A kill-feed line as sent: the gun by spec key. */
export type WireFeed = Omit<KillFeedEntry, "gun"> & { gun: string | null };

export interface SnapMsg {
  t: "snap";
  tick: number;
  /** The last input seq the server had applied when this was built (MeSnap's
   *  own state is as of that input). */
  seq: number;
  chars: CharSnap[];
  /** Characters this client was shown before and can't see now. */
  gone: number[];
  /** Rounds in flight, complete: anything missing has landed or left view. */
  bullets: BulletSnap[];
  projs: ProjSnap[];
  /** Items / corpses / vehicles that changed since the last snapshot, and the
   *  ids of ones that went away. */
  items: ItemSnap[];
  goneItems: number[];
  bodies: BodySnap[];
  goneBodies: number[];
  vehicles: VehicleSnap[];
  goneVehicles: number[];
  events: WireEvent[];
  me: MeSnap;
  /** Only when changed since the last snapshot. `hud` comes without its
   *  `players` (the Tab scoreboard rows change far less often than the point
   *  bars and timers), which ride `players` on their own. The feed and the
   *  death marks are sent when a line or mark comes or goes, not as they age. */
  hud?: GamemodeHud | null;
  players?: PlayerRow[] | null;
  feed?: WireFeed[];
  deaths?: DeathMark[];
}

export interface WelcomeMsg {
  t: "welcome";
  protocol: number;
  /** This client's character id, and the token that re-attaches to it. */
  id: number;
  token: string;
  /** The level as its JSON text (loadLevel it), and the match's resolved meta. */
  level: string;
  meta: LevelMeta;
  tick: number;
  snapHz: number;
  /** Seeds the match's shot randomness, so we can predict our own shots
   *  exactly (see engine/rng.ts). */
  salt: number;
}

export type ServerMsg =
  | WelcomeMsg
  | SnapMsg
  | { t: "pong"; at: number }
  | { t: "reject"; reason: string };

// -------------------------------------------------------------- validation --

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const axis = (v: unknown): number => Math.max(-1, Math.min(1, Math.round(num(v))));
const bool = (v: unknown): boolean => v === true;

/** A PlayerInput from whatever a client sent: every field typed and bounded,
 *  the aim a unit vector, the move axis in {-1, 0, 1}. Garbage becomes idle.
 *  The debug keys (hurt / heal yourself) are single-player tools and never
 *  pass: off the wire they would be a heal-every-tick cheat. */
export function sanitizeInput(raw: unknown): PlayerInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mv = (r.move && typeof r.move === "object" ? r.move : {}) as Record<string, unknown>;
  const am = (r.aim && typeof r.aim === "object" ? r.aim : {}) as Record<string, unknown>;
  let ax = num(am.x);
  let ay = num(am.y, -1);
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) {
    ax = 0;
    ay = -1;
  } else {
    ax /= al;
    ay /= al;
  }
  const equip = r.equip;
  const dropHud = r.dropHud;
  return {
    move: vec(axis(mv.x), axis(mv.y)),
    aim: vec(ax, ay),
    fire: bool(r.fire),
    firePressed: bool(r.firePressed),
    reload: bool(r.reload),
    equip:
      equip === "primary" || equip === "secondary" || equip === "hand" || equip === "utility" ? equip : null,
    cancel: bool(r.cancel),
    interact: bool(r.interact),
    drop: bool(r.drop),
    dropHud:
      dropHud === "primary" || dropHud === "secondary" || dropHud === "armor" || dropHud === "melee" || dropHud === "utility"
        ? dropHud
        : null,
    restart: bool(r.restart),
    debugDamage: false,
    debugHeal: false,
  };
}

/** Two inputs into one: the later one's held state, both sets of presses. For
 *  when more than one arrives between ticks, so no press is lost. */
export function mergeInputs(a: PlayerInput, b: PlayerInput): PlayerInput {
  return {
    ...b,
    firePressed: a.firePressed || b.firePressed,
    equip: b.equip ?? a.equip,
    cancel: a.cancel || b.cancel,
    interact: a.interact || b.interact,
    drop: a.drop || b.drop,
    dropHud: b.dropHud ?? a.dropHud,
    restart: a.restart || b.restart,
    debugDamage: a.debugDamage || b.debugDamage,
    debugHeal: a.debugHeal || b.debugHeal,
  };
}

// ------------------------------------------------------- strict parsing -----

/** Longest strings a client may send: a name (the server keeps 24 chars), a
 *  reconnect token (24 hex chars), a join password, a spec key. */
const MAX_NAME = 64;
const MAX_TOKEN = 64;
const MAX_PASSWORD = 128;
const MAX_KEY = 40;

/** Every PlayerInput field, and nothing else. */
const INPUT_KEYS: readonly string[] = [
  "move", "aim", "fire", "firePressed", "reload", "equip", "cancel",
  "interact", "drop", "dropHud", "restart", "debugDamage", "debugHeal",
];
const INPUT_FLAGS: readonly string[] = [
  "fire", "firePressed", "reload", "cancel", "interact", "drop", "restart", "debugDamage", "debugHeal",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Every key of `o` is one of `allowed` (JSON.parse makes "__proto__" an own
 *  key, so it is caught here like any other stranger). */
const onlyKeys = (o: Obj, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max: number): boolean => v === undefined || isStr(v, max);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): boolean => isObj(v) && onlyKeys(v, ["x", "y"]) && isNum(v.x) && isNum(v.y);

/** A PlayerInput's shape: only its fields, each of its type. (The values are
 *  then bounded by sanitizeInput.) */
function isInput(v: unknown): boolean {
  if (!isObj(v) || !onlyKeys(v, INPUT_KEYS)) return false;
  if (v.move !== undefined && !isVec(v.move)) return false;
  if (v.aim !== undefined && !isVec(v.aim)) return false;
  for (const k of INPUT_FLAGS) if (v[k] !== undefined && typeof v[k] !== "boolean") return false;
  for (const k of ["equip", "dropHud"]) if (v[k] !== undefined && v[k] !== null && !isStr(v[k], MAX_KEY)) return false;
  return true;
}

/**
 * A client message from parsed JSON, or null if it is anything but exactly
 * one of the shapes in ClientMsg: a known `t`, only that message's fields,
 * each of the right type and within its length. The server treats null as a
 * reason to hang up, so nothing past this point sees a field it didn't expect.
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case "join":
      if (!onlyKeys(raw, ["t", "protocol", "name", "token", "password"])) return null;
      if (!isNum(raw.protocol) || !isStr(raw.name, MAX_NAME)) return null;
      if (!optStr(raw.token, MAX_TOKEN) || !optStr(raw.password, MAX_PASSWORD)) return null;
      return {
        t: "join", protocol: raw.protocol, name: raw.name,
        token: raw.token as string | undefined, password: raw.password as string | undefined,
      };
    case "input":
      if (!onlyKeys(raw, ["t", "seq", "in", "vt"]) || !isNum(raw.seq) || !isInput(raw.in)) return null;
      if (raw.vt !== undefined && !isNum(raw.vt)) return null;
      return raw.vt === undefined
        ? { t: "input", seq: raw.seq, in: sanitizeInput(raw.in) }
        : { t: "input", seq: raw.seq, in: sanitizeInput(raw.in), vt: raw.vt };
    case "loadout": {
      const l = raw.loadout;
      if (!onlyKeys(raw, ["t", "loadout"]) || !isObj(l) || !onlyKeys(l, ["primary", "secondary", "armor"])) return null;
      if (!optStr(l.primary, MAX_KEY) || !optStr(l.secondary, MAX_KEY) || !optStr(l.armor, MAX_KEY)) return null;
      return {
        t: "loadout",
        loadout: { primary: l.primary as string | undefined, secondary: l.secondary as string | undefined, armor: l.armor as string | undefined },
      };
    }
    case "ping":
      if (!onlyKeys(raw, ["t", "at"]) || !isNum(raw.at)) return null;
      return { t: "ping", at: raw.at };
    case "random":
    case "respawn":
    case "leave":
      return onlyKeys(raw, ["t"]) ? { t: raw.t } : null;
    default:
      return null;
  }
}
