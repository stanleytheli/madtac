/**
 * The server's side of the wire: what ONE client is told about a tick. A
 * ClientMirror remembers what its client has been shown, so each snapshot
 * carries a character's full record only when it changed, an item / corpse /
 * vehicle only when it moved or appeared, the HUD only when it differs — and,
 * with the level's sight mask on, nothing the player couldn't see: enemies,
 * their corpses, items and rounds outside the same line-of-sight polygon the
 * client draws are simply not sent, so a modified client learns nothing the
 * honest one wouldn't show. Teammates, their corpses and vehicles are always
 * sent, because the client draws those through the mask too.
 *
 * Numbers go out rounded to what the eye can tell apart (positions to 0.1 px,
 * angles to 0.001 rad), which is also what lets a standing character compare
 * equal from one snapshot to the next and stay off the wire.
 */
import { BODY_RADIUS } from "../entities/character.ts";
import type { Character } from "../entities/actor.ts";
import { ArmorItem, GunItem, UtilityItem, type GroundItem } from "../entities/item.ts";
import { ALL_GUN_SPECS, ARMOR_SPECS, UTILITY_SPECS } from "../entities/specs.ts";
import { VEHICLE_SPECS } from "../entities/vehicles.ts";
import { areHostile } from "../entities/team.ts";
import type { GameEvent } from "../engine/events.ts";
import { vec, type Vec2 } from "../engine/vec.ts";
import type { Game, PlayerSlot } from "../game.ts";
import type { GamemodeHud, PlayerRow } from "../gamemodes/gamemode.ts";
import { visibilityPolygon } from "../world/sight.ts";
import type { Body } from "../entities/body.ts";
import type {
  BodySnap,
  BulletSnap,
  CharFull,
  CharSnap,
  ItemSnap,
  MeSnap,
  ProjSnap,
  SnapMsg,
  VehicleSnap,
  WireEvent,
  WireFeed,
} from "./protocol.ts";

/** How far from a player anything is worth sending at all (world px). Also the
 *  reach of their sight polygon. Wider than any screen at any zoom. */
export const CULL_R = 3000;

/** Every this many snapshots each visible character's pose is sent whether it
 *  changed or not (once a second at the default rate), so a client whose
 *  local timers drifted from a standing character's is put right. */
export const POSE_REFRESH = 30;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
/** A world position, to 0.1 px. */
const rp = (v: Vec2): Vec2 => ({ x: r1(v.x), y: r1(v.y) });
/** A unit direction, to 0.001. */
const rd = (v: Vec2): Vec2 => ({ x: r3(v.x), y: r3(v.y) });

/** A record's JSON with its age zeroed: two sends that differ only in how old
 *  the thing is compare equal, since the client ages it on its own. */
const ageless = (r: { ag: number }): string => JSON.stringify({ ...r, ag: 0 });
const agelessList = (rs: readonly { age: number }[]): string => JSON.stringify(rs.map((r) => ({ ...r, age: 0 })));

/** The registry key a spec is filed under, or null. */
function keyOf<T>(specs: Record<string, T>, spec: T | null | undefined): string | null {
  if (!spec) return null;
  for (const k in specs) if (specs[k] === spec) return k;
  return null;
}

/** Ray-casting point-in-polygon (any simple polygon, not just convex). */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Remembers what was last sent for a set of ids, and reports what changed.
 *  `key` is what "the same" means (default: the whole record's JSON). */
class DiffSet<T extends { id: number }> {
  private last = new Map<number, string>();

  constructor(private readonly key: (r: T) => string = (r) => JSON.stringify(r)) {}

  /** `changed`: records whose key differs from what was sent (or are new);
   *  `gone`: ids sent before and absent now. Updates the memory. */
  diff(records: readonly T[]): { changed: T[]; gone: number[] } {
    const changed: T[] = [];
    const seen = new Set<number>();
    for (const r of records) {
      seen.add(r.id);
      const j = this.key(r);
      if (this.last.get(r.id) !== j) {
        this.last.set(r.id, j);
        changed.push(r);
      }
    }
    const gone: number[] = [];
    for (const id of this.last.keys()) if (!seen.has(id)) gone.push(id);
    for (const id of gone) this.last.delete(id);
    return { changed, gone };
  }

  /** Count everything as unsent: the next diff reports every record still
   *  present as changed. Ids are kept, so `gone` still sees the ones that left. */
  forget(): void {
    for (const id of this.last.keys()) this.last.set(id, "");
  }
}

/** A GameEvent as sent: obstacles by index (see WireEvent), positions and
 *  directions rounded. */
export function toWire(e: GameEvent, obstacleIndex: Map<object, number>): WireEvent | null {
  switch (e.kind) {
    case "decal": {
      const oi = obstacleIndex.get(e.on);
      return oi === undefined ? null : { kind: "decal", near: rp(e.near), oi, z: e.z, heft: r2(e.heft) };
    }
    case "sound":
      return e.pos ? { ...e, pos: rp(e.pos) } : e;
    case "particles":
      return { ...e, pos: rp(e.pos), dir: rd(e.dir), heft: r2(e.heft) };
    case "scorch":
      return { ...e, pos: rp(e.pos) };
    case "blood":
      return { ...e, pos: rp(e.pos), dir: rd(e.dir), damage: r1(e.damage) };
    default:
      return e;
  }
}

/** A character's pose as sent (see CharSnap): rounded, resting fields left out. */
function charSnap(c: Character): CharSnap {
  const g = c.gun;
  // Health rounds UP, so a sliver of it never reads as dead.
  const hp = c.hp > 0 ? Math.ceil(c.hp * 10) / 10 : c.hp;
  const s: CharSnap = { id: c.id, x: r1(c.pos.x), y: r1(c.pos.y), f: r3(Math.atan2(c.forward.y, c.forward.x)), hp };
  if (c.z) s.z = c.z;
  const k = r1(g.kickback);
  if (k) s.k = k;
  if (g.flashTicks) s.fl = r1(g.flashTicks);
  if (g.fireCooldown) s.co = r1(g.fireCooldown);
  if (g.reloadTicks) s.re = r1(g.reloadTicks);
  if (g.drawTicks) s.dr = r1(g.drawTicks);
  if (g.punch) s.pu = g.punch;
  if (c.useTicks) s.us = c.useTicks;
  if (c.useTotalTicks) s.ut = c.useTotalTicks;
  if (c.vehicle) s.vh = c.vehicle.id;
  if (c.seatIndex !== -1) s.st = c.seatIndex;
  return s;
}

function charFull(c: Character): CharFull {
  return {
    name: "",
    team: c.team,
    skin: c.skin,
    maxHp: c.maxHp,
    slot: c.equippedSlot,
    primary: keyOf(ALL_GUN_SPECS, c.slots.primary?.spec),
    secondary: keyOf(ALL_GUN_SPECS, c.slots.secondary?.spec),
    hand: keyOf(ALL_GUN_SPECS, c.slots.hand?.spec) ?? "UNARMED",
    armor: keyOf(ARMOR_SPECS, c.armor?.spec),
    util: keyOf(UTILITY_SPECS, c.currentUtility),
    utilN: c.currentUtilityCount,
  };
}

function itemSnap(it: GroundItem): ItemSnap | null {
  const base = { id: it.id, x: r1(it.pos.x), y: r1(it.pos.y), z: it.z, lt: it.lifetime, ag: it.age };
  if (it instanceof GunItem) {
    const key = keyOf(ALL_GUN_SPECS, it.gun.spec);
    return key ? { ...base, kind: "gun", key } : null;
  }
  if (it instanceof ArmorItem) {
    const key = keyOf(ARMOR_SPECS, it.armor.spec);
    return key ? { ...base, kind: "armor", key } : null;
  }
  if (it instanceof UtilityItem) {
    const key = keyOf(UTILITY_SPECS, it.spec);
    return key ? { ...base, kind: "util", key, n: it.count } : null;
  }
  return null;
}

function bodySnap(b: Body): BodySnap {
  return {
    id: b.id, x: r1(b.pos.x), y: r1(b.pos.y), z: b.z, a: r3(b.angle), skin: b.skin, team: b.team, lt: b.lifetime, ag: b.age,
  };
}

export class ClientMirror {
  /** Full records (kit, team, name) and poses, diffed separately: a full
   *  record changes rarely, a pose whenever its character moves. */
  private readonly chars = new DiffSet<{ id: number; full: CharFull }>();
  private readonly poses = new DiffSet<CharSnap>();
  private readonly items = new DiffSet<ItemSnap>(ageless);
  private readonly bodies = new DiffSet<BodySnap>(ageless);
  private readonly vehicles = new DiffSet<VehicleSnap>();
  /** Rounds the last snapshot listed: this client has their look already. */
  private sentBullets = new Set<number>();
  private sentProjs = new Set<number>();
  private snaps = 0;
  private lastHud = "";
  private lastPlayers = "";
  private lastFeed = "";
  private lastDeaths = "";
  /** Obstacle -> its index in the level, for decal events. */
  private readonly obstacleIndex: Map<object, number>;

  /** `sight`: the level renders with the line-of-sight mask, so cull by it. */
  constructor(game: Game, private readonly sight: boolean) {
    this.obstacleIndex = new Map(game.world.obstacles.map((o, i) => [o, i]));
  }

  /** Everything `slot`'s client should learn about the tick. `events` are the
   *  world's since the last snapshot (the server accumulates them; a snapshot
   *  is every other tick). `seq` is the last input seq applied for this slot. */
  encode(game: Game, slot: PlayerSlot, seq: number, events: readonly GameEvent[]): SnapMsg {
    const me = slot.char;
    const w = game.world;
    // The sight polygon from where they stand, on their level, out to CULL_R.
    const poly = this.sight
      ? visibilityPolygon(w, me.pos, me.z, {
          minx: me.pos.x - CULL_R,
          miny: me.pos.y - CULL_R,
          maxx: me.pos.x + CULL_R,
          maxy: me.pos.y + CULL_R,
        })
      : null;
    const near = (p: Vec2): boolean => Math.hypot(p.x - me.pos.x, p.y - me.pos.y) < CULL_R;
    /** Can the player see a point? Their own level, inside the polygon; or,
     *  with no mask, anything within reach. */
    const seen = (p: Vec2, z: number): boolean => {
      if (!near(p)) return false;
      if (!poly) return true;
      return z === me.z && pointInPolygon(p, poly);
    };
    /** A body-sized thing: seen if any part of its outline pokes into the
     *  polygon. With no mask it is just the reach test on its centre. */
    const seenBody = (p: Vec2, z: number): boolean =>
      !poly
        ? near(p)
        : seen(p, z) ||
          seen(vec(p.x + BODY_RADIUS, p.y), z) ||
          seen(vec(p.x - BODY_RADIUS, p.y), z) ||
          seen(vec(p.x, p.y + BODY_RADIUS), z) ||
          seen(vec(p.x, p.y - BODY_RADIUS), z);
    const friendly = (team: string): boolean => !areHostile(me.team, team as never);

    // Characters: teammates always, enemies only in view.
    const visible: Character[] = [];
    for (const c of game.characters) {
      if (c === me || friendly(c.team) ? near(c.pos) : seenBody(c.pos, c.z)) visible.push(c);
    }
    // Each one's pose if it moved, with its full record if that changed (a
    // character coming into view is new to both, so it gets both).
    const fulls = this.chars.diff(visible.map((c) => ({ id: c.id, full: this.fullOf(game, c) })));
    const fullById = new Map(fulls.changed.map((r) => [r.id, r.full]));
    this.snaps += 1;
    if (this.snaps % POSE_REFRESH === 0) this.poses.forget();
    const poses = visible.map(charSnap);
    const moved = new Set(this.poses.diff(poses).changed.map((s) => s.id));
    const chars: CharSnap[] = poses.filter((s) => moved.has(s.id) || fullById.has(s.id));
    for (const s of chars) {
      const full = fullById.get(s.id);
      if (full) s.full = full;
    }
    const gone = fulls.gone;

    // Rounds: complete each time, so a missing one has landed or left view.
    // Their look goes only with the first listing; a round the last snapshot
    // listed is one this client already has.
    const bullets: BulletSnap[] = [];
    const sentBullets = new Set<number>();
    for (const b of w.bullets) {
      if (!seen(b.pos, b.z) && !seen(b.prev, b.z)) continue;
      const s: BulletSnap = { id: b.id, x: r1(b.pos.x), y: r1(b.pos.y), vx: r2(b.vel.x), vy: r2(b.vel.y), z: b.z };
      if (b.owner === me) s.o = 1;
      if (!this.sentBullets.has(b.id)) {
        s.w = b.tracerWidth;
        s.l = b.tracerLength;
        s.c = b.tracerColor;
        s.ra = r1(b.renderAfter);
        s.ox = r1(b.origin.x);
        s.oy = r1(b.origin.y);
      }
      sentBullets.add(b.id);
      bullets.push(s);
    }
    this.sentBullets = sentBullets;
    const projs: ProjSnap[] = [];
    const sentProjs = new Set<number>();
    for (const p of w.projectiles) {
      if (!seen(p.pos, p.z) && !seen(p.prev, p.z)) continue;
      const s: ProjSnap = { id: p.id, x: r1(p.pos.x), y: r1(p.pos.y), vx: r2(p.vel.x), vy: r2(p.vel.y), z: p.z };
      if (p.owner === me) s.o = 1;
      if (!this.sentProjs.has(p.id)) {
        s.ra = r1(p.renderAfter);
        s.ox = r1(p.origin.x);
        s.oy = r1(p.origin.y);
        s.br = p.bodyRadius;
        s.c = p.color;
        s.tc = p.trailColor;
        s.sp = p.sprite;
        s.ss = p.spriteScale;
      }
      sentProjs.add(p.id);
      projs.push(s);
    }
    this.sentProjs = sentProjs;

    // Items, corpses, vehicles: diffs against what this client has.
    const items: ItemSnap[] = [];
    for (const it of w.items) {
      if (!seen(it.pos, it.z)) continue;
      const s = itemSnap(it);
      if (s) items.push(s);
    }
    const itemDiff = this.items.diff(items);
    const bodies: BodySnap[] = [];
    for (const b of game.bodies) {
      if (friendly(b.team) ? near(b.pos) : seenBody(b.pos, b.z)) bodies.push(bodySnap(b));
    }
    const bodyDiff = this.bodies.diff(bodies);
    const vehicles: VehicleSnap[] = [];
    for (const v of w.vehicles) {
      if (!near(v.pos)) continue;
      const key = keyOf(VEHICLE_SPECS, v.spec);
      if (key) vehicles.push({ id: v.id, key, x: r1(v.pos.x), y: r1(v.pos.y), a: r3(v.angle), z: v.z, ta: v.turretAngle.map(r3) });
    }
    const vehDiff = this.vehicles.diff(vehicles);

    // Events: a hit is for everyone (tiny), a sound for anyone in earshot (it
    // carries through walls by design), debris and holes only for the eyes.
    const wire: WireEvent[] = [];
    for (const e of events) {
      let send: boolean;
      if (e.kind === "hit" || e.kind === "stopSound") send = true;
      else if (e.kind === "sound") send = !e.pos || near(e.pos);
      else if (e.kind === "particles") send = seen(e.pos, e.z);
      // For the eyes, like the puff that came with it: it says someone was hit.
      else if (e.kind === "blood") send = seen(e.pos, e.z);
      // In earshot, like the boom that came with it: it tells no more than the
      // sound did, and the mark is there to find once you walk over to it.
      else if (e.kind === "scorch") send = near(e.pos);
      else send = seen(e.near, e.z);
      if (!send) continue;
      const we = toWire(e, this.obstacleIndex);
      if (we) wire.push(we);
    }

    const meSnap: MeSnap = {
      mag: me.gun.mag,
      res: me.gun.reserveMags,
      armorHp: me.armor?.hp ?? 0,
      regenTicks: me.regenTicks,
      regenRate: me.regenRate,
      marks: me.damageMarks,
      zoom: game.zoomTarget(slot),
      spread: game.spreadTarget(slot),
      cone: game.visionConeTarget(slot),
      ctrl: slot.controllable,
      label: game.interactLabel(slot),
      item: slot.interactable?.id ?? null,
      seat: slot.enterable ? { vh: slot.enterable.vehicle.id, st: slot.enterable.seat } : null,
      // Where a predicting client rewinds to (see MeSnap): finer than the
      // poses everyone else gets, so its replay starts where the server is.
      px: r2(me.pos.x),
      py: r2(me.pos.y),
      vx: r3(me.vel.x),
      vy: r3(me.vel.y),
      pz: me.z,
      stg: me.staggerTicks,
      stm: me.staggerMul,
      sl: me.equippedSlot,
      co: me.gun.fireCooldown,
      re: me.gun.reloadTicks,
      dr: me.gun.drawTicks,
      us: me.useTicks,
    };

    const msg: SnapMsg = {
      t: "snap",
      tick: game.tick,
      seq,
      chars,
      gone,
      bullets,
      projs,
      items: itemDiff.changed,
      goneItems: itemDiff.gone,
      bodies: bodyDiff.changed,
      goneBodies: bodyDiff.gone,
      vehicles: vehDiff.changed,
      goneVehicles: vehDiff.gone,
      events: wire,
      me: meSnap,
    };
    // The HUD, its scoreboard rows, the feed and the minimap marks only when
    // they differ from last time (the feed and marks: ignoring their ages).
    const hud = game.gamemode.hud(game, me);
    let head: GamemodeHud | null = null;
    let players: PlayerRow[] | null = null;
    if (hud) {
      const { players: rows, ...rest } = hud;
      head = rest;
      players = rows ?? null;
    }
    const hudJ = JSON.stringify(head);
    if (hudJ !== this.lastHud) {
      this.lastHud = hudJ;
      msg.hud = head;
    }
    const playersJ = JSON.stringify(players);
    if (playersJ !== this.lastPlayers) {
      this.lastPlayers = playersJ;
      msg.players = players;
    }
    const feed: WireFeed[] = slot.killFeed.map((f) => ({ ...f, gun: keyOf(ALL_GUN_SPECS, f.gun) }));
    const feedJ = agelessList(feed);
    if (feedJ !== this.lastFeed) {
      this.lastFeed = feedJ;
      msg.feed = feed;
    }
    const deathsJ = agelessList(slot.minimapDeaths);
    if (deathsJ !== this.lastDeaths) {
      this.lastDeaths = deathsJ;
      msg.deaths = slot.minimapDeaths;
    }
    return msg;
  }

  private fullOf(game: Game, c: Character): CharFull {
    const f = charFull(c);
    f.name = game.slotOf(c)?.name ?? "";
    return f;
  }
}
