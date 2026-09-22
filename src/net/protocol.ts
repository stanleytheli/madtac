/**
 * The wire: what a client and a server say to each other, as JSON.
 *
 * survev-shaped. The client sends its PlayerInput every tick (or when it
 * changes) and a few one-shot requests; the server sends a snapshot at
 * DEFAULT_SNAP_HZ with everything this client can SEE — a partial record per
 * visible character every time, a full record only when it changed, one-shot
 * lists for rounds, diffs for items / corpses / vehicles, the tick's events,
 * and the private block (`me`) only its own player is told. JSON for now: at
 * twenty characters and thirty snapshots a second it is a few kilobytes a
 * second per client, and a binary encoding is a measured decision for later.
 */
import type { EquipSlot, DamageMark } from "../entities/actor.ts";
import type { Skin } from "../entities/character.ts";
import type { TeamId } from "../entities/team.ts";
import type { PlayerInput } from "../engine/command.ts";
import type { GameEvent } from "../engine/events.ts";
import type { Vec2 } from "../engine/vec.ts";
import type { GamemodeHud, KillFeedEntry, PlayerLoadout } from "../gamemodes/gamemode.ts";
import type { LevelMeta } from "../world/level.ts";
import type { DeathMark } from "../ui/minimap.ts";
import { vec } from "../engine/vec.ts";

/** Bumped whenever a message shape changes; a mismatch is rejected at join. */
export const PROTOCOL = 1;
/** Sim ticks per second, both sides. */
export const SIM_HZ = 60;
/** Snapshots per second the server sends by default (every other tick). */
export const DEFAULT_SNAP_HZ = 30;
/** Default listen port, and the websocket route on it. */
export const DEFAULT_PORT = 7777;
export const WS_PATH = "/play";

// ------------------------------------------------------- client -> server ----

export type ClientMsg =
  /** First message on a socket. `token` re-attaches to a slot the server is
   *  still holding for a dropped connection (see WelcomeMsg.token). */
  | { t: "join"; protocol: number; name: string; token?: string }
  /** The player's intent for the coming tick(s). `seq` climbs by one per
   *  message and comes back in snapshots, so the client can measure lag. */
  | { t: "input"; seq: number; in: PlayerInput }
  /** Respawn-screen picks (see Gamemode.setPlayerLoadout / randomize / respawn). */
  | { t: "loadout"; loadout: PlayerLoadout }
  | { t: "random" }
  | { t: "respawn" }
  | { t: "ping"; at: number };

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

/** A visible character, every snapshot: where it is, how it is posed. */
export interface CharSnap {
  id: number;
  x: number;
  y: number;
  /** Facing (unit). */
  fx: number;
  fy: number;
  z: number;
  hp: number;
  /** The held gun's cosmetic timers: kickback px, flash ticks, fire cooldown,
   *  reload ticks left, draw ticks left, punch (signed by hand; see Gun.punch). */
  k: number;
  fl: number;
  co: number;
  re: number;
  dr: number;
  pu: number;
  /** Utility use timer: ticks left / total (0/0 = not using). */
  us: number;
  ut: number;
  /** Seated: the vehicle's id and seat index (0 / -1 on foot). */
  vh: number;
  st: number;
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
}

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

export interface BulletSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  w: number;
  l: number;
  c: string;
  ra: number;
  ox: number;
  oy: number;
}

export interface ProjSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  ra: number;
  ox: number;
  oy: number;
  br: number;
  c: string;
  tc: string;
  sp?: string;
  ss?: number;
}

/** A GameEvent as sent: a decal names its obstacle by index into the level's
 *  obstacle list (both sides load the same level), everything else as is. */
export type WireEvent =
  | Exclude<GameEvent, { kind: "decal" }>
  | { kind: "decal"; near: Vec2; oi: number; z: number; heft: number };

/** A kill-feed line as sent: the gun by spec key. */
export type WireFeed = Omit<KillFeedEntry, "gun"> & { gun: string | null };

export interface SnapMsg {
  t: "snap";
  tick: number;
  /** The last input seq the server had applied when this was built. */
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
  /** Only when changed since the last snapshot. */
  hud?: GamemodeHud | null;
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
 *  the aim a unit vector, the move axis in {-1, 0, 1}. Garbage becomes idle. */
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
    debugDamage: bool(r.debugDamage),
    debugHeal: bool(r.debugHeal),
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
