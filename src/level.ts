/**
 * Level (de)serialization + the entity registry the level editor is built on.
 *
 * A level is a JSON string: `{ "version": 1, "entities": [{kind, x, y, ...}] }`.
 * Everything placeable — map geometry, ground items, enemy spawns — is described
 * once as an `EntityDef`: which world array it lives in, how to create a default
 * one, and its editable `fields`. The serializer AND the editor UI (palette,
 * inspector) are both generic over the defs, so new game content costs little
 * to no editor work:
 *   - new gun / armor:   export the spec from guns.ts / armor.ts (auto-discovered)
 *   - new enemy flavour: add one entry to ENEMY_TYPES in robot.ts
 *   - new entity kind:   add one EntityDef to ENTITY_DEFS below
 */
import { Armor, type ArmorSpec } from "./armor.ts";
import * as Armors from "./armor.ts";
import { Gun } from "./gun.ts";
import type { GunSpec } from "./guns.ts";
import * as Guns from "./guns.ts";
import { ArmorItem, GunItem } from "./item.ts";
import { ENEMY_TYPES } from "./robot.ts";
import { vec, type Vec2 } from "./vec.ts";
import {
  WALL_T,
  makeCrate,
  makeFence,
  makeFloor,
  makeStairs,
  makeWall,
  type Floor,
  type Obstacle,
  type Stairs,
  type World,
} from "./world.ts";

/** Where an enemy appears when the level starts. `type` keys ENEMY_TYPES. */
export interface EnemySpawn {
  type: string;
  pos: Vec2;
  z: number;
}

/** Everything a level owns: the world's static arrays plus the spawn table. */
export interface LevelState {
  world: World;
  spawns: EnemySpawn[];
}

// --- spec registries (auto-discovered) ---------------------------------------
// Keyed by the spec's export name, which is what gets serialized — so renaming
// an export breaks old level strings, but adding one is free.

/** Every exported GunSpec with a ground icon (icon-less specs like fists can't
 *  lie on the ground anyway). */
export const GUN_SPECS: Record<string, GunSpec> = {};
for (const [k, v] of Object.entries(Guns)) {
  if (v && typeof v === "object" && "armorPen" in v && (v as GunSpec).icon) {
    GUN_SPECS[k] = v as GunSpec;
  }
}

/** Every exported ArmorSpec. */
export const ARMOR_SPECS: Record<string, ArmorSpec> = {};
for (const [k, v] of Object.entries(Armors)) {
  if (v && typeof v === "object" && "border" in v && "level" in v) {
    ARMOR_SPECS[k] = v as ArmorSpec;
  }
}

const firstKey = (rec: Record<string, unknown>): string => Object.keys(rec)[0];
const keyOf = <T>(rec: Record<string, T>, val: T): string =>
  Object.keys(rec).find((k) => rec[k] === val) ?? firstKey(rec);

// --- field + entity definitions ----------------------------------------------

export type FieldType = "number" | "checkbox" | "text" | "color" | "select" | "json";

/** One editable/serializable property of an entity. The inspector renders it
 *  from `type`; the serializer stores whatever `get` returns (must be JSON-able
 *  for `json` fields — that type is the escape hatch for structured values like
 *  a floor's visibleFrom ZSet or its hideWhenIn regions). */
export interface FieldDef {
  key: string;
  type: FieldType;
  /** Choices for `select` fields. A function so registries can grow first. */
  options?: () => { value: string; label: string }[];
  get(e: any): unknown;
  set(e: any, v: any): void;
}

/** A plain mutable property: e[key], edited/serialized as-is. */
const prop = (key: string, type: FieldType): FieldDef => ({
  key,
  type,
  get: (e) => e[key],
  set: (e, v) => {
    e[key] = v;
  },
});

export interface EntityDef {
  kind: string;
  label: string;
  /** rect = has w/h (drag-to-draw, resize handles); point = position only. */
  shape: "rect" | "point";
  fields: FieldDef[];
  /** The state array this kind lives in (may be shared, e.g. all obstacles). */
  list(state: LevelState): any[];
  /** Whether an element of that shared array belongs to this kind. */
  match(e: any): boolean;
  /** A fresh default entity at `pos` on level `z` (not yet added to the list). */
  create(pos: Vec2, z: number): any;
  /** The z the entity "is at" — for the editor's same-level selection priority. */
  zOf(e: any): number;
}

const zField = prop("z", "number");

/**
 * The registry. Array order is meaningful twice over: it's the editor's
 * hit-test priority (points before rects, small before large), and the order
 * kinds are written to the level string (floors last keeps their relative
 * painter's order intact within the floors array on reload).
 */
export const ENTITY_DEFS: EntityDef[] = [
  {
    kind: "enemy",
    label: "Enemy",
    shape: "point",
    fields: [
      zField,
      {
        key: "type",
        type: "select",
        options: () => Object.entries(ENEMY_TYPES).map(([value, t]) => ({ value, label: t.label })),
        get: (e) => e.type,
        set: (e, v) => {
          if (v in ENEMY_TYPES) e.type = v;
        },
      },
    ],
    list: (s) => s.spawns,
    match: () => true,
    create: (pos, z) => ({ type: firstKey(ENEMY_TYPES), pos, z }),
    zOf: (e) => e.z,
  },
  {
    kind: "gun",
    label: "Gun",
    shape: "point",
    fields: [
      zField,
      {
        key: "gun",
        type: "select",
        options: () => Object.entries(GUN_SPECS).map(([value, g]) => ({ value, label: g.name })),
        get: (e) => keyOf(GUN_SPECS, e.gun.spec),
        set: (e, v) => {
          if (v in GUN_SPECS) e.setGun(new Gun(GUN_SPECS[v]));
        },
      },
    ],
    list: (s) => s.world.items,
    match: (e) => e instanceof GunItem,
    create: (pos, z) => new GunItem(pos, new Gun(GUN_SPECS[firstKey(GUN_SPECS)]), vec(0, 0), z),
    zOf: (e) => e.z,
  },
  {
    kind: "armor",
    label: "Armor",
    shape: "point",
    fields: [
      zField,
      {
        key: "armor",
        type: "select",
        options: () => Object.entries(ARMOR_SPECS).map(([value, a]) => ({ value, label: a.name })),
        get: (e) => keyOf(ARMOR_SPECS, e.armor.spec),
        set: (e, v) => {
          if (v in ARMOR_SPECS) e.setArmor(new Armor(ARMOR_SPECS[v]));
        },
      },
    ],
    list: (s) => s.world.items,
    match: (e) => e instanceof ArmorItem,
    create: (pos, z) => new ArmorItem(pos, new Armor(ARMOR_SPECS[firstKey(ARMOR_SPECS)]), vec(0, 0), z),
    zOf: (e) => e.z,
  },
  {
    kind: "wall",
    label: "Wall",
    shape: "rect",
    fields: [zField],
    list: (s) => s.world.obstacles,
    match: (e: Obstacle) => !e.cross && !e.permeable,
    create: (pos, z) => makeWall(pos, 140, WALL_T, z),
    zOf: (e) => e.z,
  },
  {
    kind: "crate",
    label: "Crate",
    shape: "rect",
    fields: [zField],
    list: (s) => s.world.obstacles,
    match: (e: Obstacle) => !!e.cross,
    create: (pos, z) => makeCrate(pos, 64, 64, z),
    zOf: (e) => e.z,
  },
  {
    kind: "fence",
    label: "Fence",
    shape: "rect",
    fields: [zField],
    list: (s) => s.world.obstacles,
    match: (e: Obstacle) => !!e.permeable,
    create: (pos, z) => makeFence(pos, 140, 14, z),
    zOf: (e) => e.z,
  },
  {
    kind: "stairs",
    label: "Stairs",
    shape: "rect",
    fields: [
      {
        key: "axis",
        type: "select",
        options: () => [
          { value: "x", label: "x (climb east-west)" },
          { value: "y", label: "y (climb north-south)" },
        ],
        get: (e) => e.axis,
        set: (e, v) => {
          if (v === "x" || v === "y") e.axis = v;
        },
      },
      prop("zAtMin", "number"),
      prop("zAtMax", "number"),
      prop("visibleFrom", "json"),
      prop("color", "color"),
      prop("steps", "number"),
    ],
    list: (s) => s.world.stairs,
    match: () => true,
    create: (pos, z) => makeStairs(pos, 120, 200, "y", z + 1, z, [z, z + 1], "#7c6034"),
    zOf: (e: Stairs) => Math.min(e.zAtMin, e.zAtMax),
  },
  {
    kind: "floor",
    label: "Floor",
    shape: "rect",
    fields: [
      prop("level", "number"),
      prop("color", "color"),
      prop("visibleFrom", "json"),
      prop("hideWhenUnder", "checkbox"),
      prop("hideWhenIn", "json"),
      prop("enclosing", "checkbox"),
      prop("infinite", "checkbox"),
      {
        key: "grid",
        type: "text",
        get: (e) => e.grid ?? "",
        set: (e, v) => {
          e.grid = v || undefined;
        },
      },
    ],
    list: (s) => s.world.floors,
    match: () => true,
    create: (pos, z) => makeFloor(pos, 200, 200, "#9c7444", { level: z, visibleFrom: [z] }),
    zOf: (e: Floor) => e.level,
  },
];

const defByKind = new Map(ENTITY_DEFS.map((d) => [d.kind, d]));

// --- (de)serialization ---------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One entity -> a flat JSON record: kind + geometry + every non-default field. */
export function entityToJSON(def: EntityDef, e: any): Record<string, unknown> {
  const j: Record<string, unknown> = { kind: def.kind, x: round2(e.pos.x), y: round2(e.pos.y) };
  if (def.shape === "rect") {
    j.w = round2(e.w);
    j.h = round2(e.h);
  }
  for (const f of def.fields) {
    const v = f.get(e);
    // Omit unset/default-y values to keep the strings short. (false and "" are
    // indistinguishable from absent for every field we have.)
    if (v !== undefined && v !== "" && v !== false) j[f.key] = v;
  }
  return j;
}

/** The whole level as a string — one entity per line, for readable diffs. */
export function serializeLevel(state: LevelState): string {
  const lines: string[] = [];
  for (const def of ENTITY_DEFS) {
    for (const e of def.list(state)) {
      if (def.match(e)) lines.push("  " + JSON.stringify(entityToJSON(def, e)));
    }
  }
  return `{ "version": 1, "entities": [\n${lines.join(",\n")}\n] }`;
}

/**
 * Replace `state`'s contents with the level in `text` (mutates the arrays in
 * place, so live references — main's `world` — see the swap). Throws on
 * malformed JSON; unknown kinds/fields are skipped, not fatal, so levels stay
 * loadable across content changes.
 */
export function applyLevel(state: LevelState, text: string): void {
  const doc = JSON.parse(text) as { entities?: unknown[] };
  const ents = Array.isArray(doc.entities) ? doc.entities : [];
  const w = state.world;
  w.obstacles.length = 0;
  w.floors.length = 0;
  w.stairs.length = 0;
  w.items.length = 0;
  w.bullets.length = 0;
  w.particles.length = 0;
  state.spawns.length = 0;

  for (const raw of ents) {
    const j = raw as Record<string, any>;
    const def = defByKind.get(j.kind);
    if (!def || typeof j.x !== "number" || typeof j.y !== "number") continue;
    const z =
      typeof j.z === "number" ? j.z
      : typeof j.level === "number" ? j.level
      : typeof j.zAtMax === "number" ? j.zAtMax
      : 0;
    const e = def.create(vec(j.x, j.y), z);
    if (def.shape === "rect") {
      if (typeof j.w === "number") e.w = j.w;
      if (typeof j.h === "number") e.h = j.h;
    }
    for (const f of def.fields) if (f.key in j) f.set(e, j[f.key]);
    def.list(state).push(e);
  }
}

/** Parse a level string into a fresh, self-contained LevelState. */
export function loadLevel(text: string): LevelState {
  const state: LevelState = {
    world: { obstacles: [], floors: [], stairs: [], items: [], bullets: [], particles: [] },
    spawns: [],
  };
  applyLevel(state, text);
  return state;
}
