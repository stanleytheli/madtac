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

/** Remembers what was last sent for a set of ids, and reports what changed. */
class DiffSet<T extends { id: number }> {
  private last = new Map<number, string>();

  /** `changed`: records whose JSON differs from what was sent (or are new);
   *  `gone`: ids sent before and absent now. Updates the memory. */
  diff(records: readonly T[]): { changed: T[]; gone: number[] } {
    const changed: T[] = [];
    const seen = new Set<number>();
    for (const r of records) {
      seen.add(r.id);
      const j = JSON.stringify(r);
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
}

/** A GameEvent as sent: obstacles by index (see WireEvent). */
export function toWire(e: GameEvent, obstacleIndex: Map<object, number>): WireEvent | null {
  if (e.kind !== "decal") return e;
  const oi = obstacleIndex.get(e.on);
  return oi === undefined ? null : { kind: "decal", near: e.near, oi, z: e.z, heft: e.heft };
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
  const base = { id: it.id, x: it.pos.x, y: it.pos.y, z: it.z, lt: it.lifetime, ag: it.age };
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
  return { id: b.id, x: b.pos.x, y: b.pos.y, z: b.z, a: b.angle, skin: b.skin, team: b.team, lt: b.lifetime, ag: b.age };
}

export class ClientMirror {
  private readonly chars = new DiffSet<{ id: number; full: CharFull }>();
  private readonly shownChars = new Set<number>();
  private readonly items = new DiffSet<ItemSnap>();
  private readonly bodies = new DiffSet<BodySnap>();
  private readonly vehicles = new DiffSet<VehicleSnap>();
  private lastHud = "";
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
    const fulls = this.chars.diff(visible.map((c) => ({ id: c.id, full: this.fullOf(game, c) })));
    const fullById = new Map(fulls.changed.map((r) => [r.id, r.full]));
    const chars: CharSnap[] = visible.map((c) => {
      const g = c.gun;
      const s: CharSnap = {
        id: c.id,
        x: c.pos.x,
        y: c.pos.y,
        fx: c.forward.x,
        fy: c.forward.y,
        z: c.z,
        hp: c.hp,
        k: g.kickback,
        fl: g.flashTicks,
        co: g.fireCooldown,
        re: g.reloadTicks,
        dr: g.drawTicks,
        pu: g.punch,
        us: c.useTicks,
        ut: c.useTotalTicks,
        vh: c.vehicle ? c.vehicle.id : 0,
        st: c.seatIndex,
      };
      const full = fullById.get(c.id);
      if (full) s.full = full;
      return s;
    });
    const gone = fulls.gone;
    for (const id of gone) this.shownChars.delete(id);
    for (const c of visible) this.shownChars.add(c.id);

    // Rounds: complete each time, so a missing one has landed or left view.
    const bullets: BulletSnap[] = [];
    for (const b of w.bullets) {
      if (!seen(b.pos, b.z) && !seen(b.prev, b.z)) continue;
      bullets.push({
        id: b.id, x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, z: b.z,
        w: b.tracerWidth, l: b.tracerLength, c: b.tracerColor, ra: b.renderAfter, ox: b.origin.x, oy: b.origin.y,
      });
    }
    const projs: ProjSnap[] = [];
    for (const p of w.projectiles) {
      if (!seen(p.pos, p.z) && !seen(p.prev, p.z)) continue;
      projs.push({
        id: p.id, x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, z: p.z, ra: p.renderAfter,
        ox: p.origin.x, oy: p.origin.y, br: p.bodyRadius, c: p.color, tc: p.trailColor, sp: p.sprite, ss: p.spriteScale,
      });
    }

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
      if (key) vehicles.push({ id: v.id, key, x: v.pos.x, y: v.pos.y, a: v.angle, z: v.z, ta: v.turretAngle.slice() });
    }
    const vehDiff = this.vehicles.diff(vehicles);

    // Events: a hit is for everyone (tiny), a sound for anyone in earshot (it
    // carries through walls by design), debris and holes only for the eyes.
    const wire: WireEvent[] = [];
    for (const e of events) {
      if (e.kind === "hit" || e.kind === "stopSound") {
        wire.push(e);
      } else if (e.kind === "sound") {
        if (!e.pos || near(e.pos)) wire.push(e);
      } else if (e.kind === "particles") {
        if (seen(e.pos, e.z)) wire.push(e);
      } else if (e.kind === "scorch") {
        // In earshot, like the boom that came with it: it tells no more than the
        // sound did, and the mark is there to find once you walk over to it.
        if (near(e.pos)) wire.push(e);
      } else if (seen(e.near, e.z)) {
        const we = toWire(e, this.obstacleIndex);
        if (we) wire.push(we);
      }
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
    // The HUD, feed and minimap marks only when they differ from last time.
    const hud = game.gamemode.hud(game, me);
    const hudJ = JSON.stringify(hud);
    if (hudJ !== this.lastHud) {
      this.lastHud = hudJ;
      msg.hud = hud;
    }
    const feed: WireFeed[] = slot.killFeed.map((f) => ({ ...f, gun: keyOf(ALL_GUN_SPECS, f.gun) }));
    const feedJ = JSON.stringify(feed);
    if (feedJ !== this.lastFeed) {
      this.lastFeed = feedJ;
      msg.feed = feed;
    }
    const deathsJ = JSON.stringify(slot.minimapDeaths);
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
