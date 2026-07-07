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
 *   - new enemy flavour: add one entry to ENEMY_TYPES in enemies.ts
 *   - new entity kind:   add one EntityDef to ENTITY_DEFS below
 */
import { Armor } from "./armor.ts";
import { DEFAULT_ENEMY_GUN, ENEMY_TYPES, LEGACY_ENEMY_TYPES } from "./enemies.ts";
import { Gun } from "./gun.ts";
import { ArmorItem, GunItem } from "./item.ts";
import { ARMOR_SPECS, GUN_SPECS, SKINS } from "./specs.ts";
import { TEAMS } from "./team.ts";
import { deg2rad, rad2deg, vec, type Vec2 } from "./vec.ts";
import {
  WALL_T,
  makeCrate,
  makeFence,
  makeFloor,
  makeNode,
  makeStairs,
  makeWall,
  sortRenderDepth,
  type Floor,
  type Obstacle,
  type Stairs,
  type World,
} from "./world.ts";

// Re-exported for existing importers; the registries themselves live in
// specs.ts so the enemy system can share them without a module cycle.
export { ARMOR_SPECS, GUN_SPECS, SKINS };

/** Where an enemy appears when the level starts. `type` keys ENEMY_TYPES; the
 *  loadout and allegiance are per-spawn (any type can wear any equipment). */
export interface EnemySpawn {
  type: string;
  pos: Vec2;
  z: number;
  /** GUN_SPECS key. Omitted = the type's default weapon. */
  gun?: string;
  /** ARMOR_SPECS key. Omitted = unarmored. */
  armor?: string;
  /** TEAMS key. Omitted = "enemy". */
  team?: string;
  /** SKINS key. Omitted = the type's own look. */
  skin?: string;
}

/** The player's weapons when a level doesn't say otherwise — also what
 *  pre-loadout level strings (no primary/secondary keys) mean. */
export const DEFAULT_PLAYER_PRIMARY = "M16";
export const DEFAULT_PLAYER_SECONDARY = "M9";

/** Where — and as what — the player starts. A singleton entity in the editor. */
export interface PlayerSpawn {
  pos: Vec2;
  z: number;
  /** GUN_SPECS key, or "none" for an empty slot. Omitted = the default gun
   *  above; saves write the choice explicitly either way. */
  primary?: string;
  secondary?: string;
  /** ARMOR_SPECS key. Omitted = unarmored. */
  armor?: string;
  /** SKINS key. Omitted = the standard player look. */
  skin?: string;
}

/** A rectangular region a gamemode spawns combatants inside. Tagged with a team
 *  so TDM maps are authored purely by placing zones (see gamemodes/tdm.ts). */
export interface SpawnZone {
  pos: Vec2;
  w: number;
  h: number;
  /** Rotation in radians (omitted/0 = axis-aligned), like other rect entities. */
  angle?: number;
  z: number;
  /** TEAMS key whose members spawn here. */
  team: string;
}

/** Per-side Team Deathmatch settings. `troops` = AI bots on that side (the
 *  player is an extra combatant on blue). `skill` ∈ [0,1] maps to reaction
 *  time / burst bravery / strafe exploration; `equip` is an equipment tier. */
export interface TeamConfig {
  troops: number;
  skill: number;
  equip: number;
}

export interface TdmConfig {
  /** Deaths a team can take before it loses (the ticket bar's length). */
  killLimit: number;
  /** Ticks before a downed slot respawns from its team's zones. */
  respawnDelay: number;
  blue: TeamConfig;
  red: TeamConfig;
}

/** Top-level, non-entity level configuration. `mode` keys the gamemode registry
 *  (omitted = the default sandbox); mode-specific config hangs off it. */
export interface LevelMeta {
  mode?: string;
  tdm?: TdmConfig;
}

/** Everything a level owns: the world's static arrays plus the spawn tables. */
export interface LevelState {
  world: World;
  spawns: EnemySpawn[];
  /** 0 or 1 entries — an array only so the entity defs stay uniform. */
  playerSpawn: PlayerSpawn[];
  /** Gamemode spawn zones (see SpawnZone). Not part of the world — they never
   *  collide and are invisible in-game, read only by gamemodes + the editor. */
  spawnZones: SpawnZone[];
  /** Top-level match configuration (gamemode + its settings). */
  meta: LevelMeta;
}

const firstKey = (rec: Record<string, unknown>): string => Object.keys(rec)[0];
const keyOf = <T>(rec: Record<string, T>, val: T): string =>
  Object.keys(rec).find((k) => rec[k] === val) ?? firstKey(rec);

// --- field + entity definitions ----------------------------------------------

export type FieldType =
  | "number"
  | "checkbox"
  | "text"
  | "color"
  | "select"
  | "json"
  /** A Region[] (hideWhenIn): the editor renders these as draggable/resizable
   *  rect borders with an add/remove list instead of a raw JSON input. */
  | "regions";

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
  /** At most one may exist: placing a new one replaces the old (player spawn). */
  singleton?: boolean;
  /** Drawn by the editor as a labeled disc, for entities with no in-world look. */
  marker?(e: any): { color: string; label: string };
}

const zField = prop("z", "number");

/** Worn armor by ARMOR_SPECS key ("" = none, omitted from the level string).
 *  Shared by enemy spawns and the player spawn. */
const armorField: FieldDef = {
  key: "armor",
  type: "select",
  options: () => [
    { value: "", label: "(none)" },
    ...Object.entries(ARMOR_SPECS).map(([value, a]) => ({ value, label: a.name })),
  ],
  get: (e) => e.armor ?? "",
  set: (e, v) => {
    e.armor = v in ARMOR_SPECS ? v : undefined;
  },
};

/** "DEFAULT_SKIN" -> "default", "TAC_ORACLE_SKIN" -> "tac oracle". */
const skinLabel = (key: string): string =>
  key.replace(/_?SKIN$/, "").replace(/_/g, " ").toLowerCase() || "default";

/** Cosmetic skin override by SKINS key ("" = whatever the character would
 *  wear anyway). Shared by enemy spawns and the player spawn. */
const skinField: FieldDef = {
  key: "skin",
  type: "select",
  options: () => [
    { value: "", label: "(default)" },
    ...Object.keys(SKINS).map((value) => ({ value, label: skinLabel(value) })),
  ],
  get: (e) => e.skin ?? "",
  set: (e, v) => {
    e.skin = v in SKINS ? v : undefined;
  },
};

/** A player weapon slot: a GUN_SPECS key or "none" for an empty slot. The
 *  current choice serializes explicitly (get never returns ""), so pre-loadout
 *  level strings keep meaning the classic default while new saves self-describe. */
const playerSlotField = (key: "primary" | "secondary", fallback: string): FieldDef => ({
  key,
  type: "select",
  options: () => [
    { value: "none", label: "(none)" },
    ...Object.entries(GUN_SPECS).map(([value, g]) => ({ value, label: g.name })),
  ],
  get: (e) => e[key] ?? fallback,
  set: (e, v) => {
    if (v === "none" || v in GUN_SPECS) e[key] = v;
  },
});

/** Render depth within the entity's category + level (0 = default/unset —
 *  omitted from the JSON, and ties keep authoring order). */
const depthField: FieldDef = {
  key: "depth",
  type: "number",
  get: (e) => e.depth ?? 0,
  set: (e, v) => {
    e.depth = v === 0 ? undefined : v;
  },
};

/** Obstacle appearance: fill + border color/size (factory-set, all overridable),
 *  plus the optional cosmetic visibleFrom z-set (empty = always visible). */
const obstacleLook: FieldDef[] = [
  depthField,
  prop("invisible", "checkbox"),
  prop("visibleFrom", "json"),
  prop("fill", "color"),
  prop("stroke", "color"),
  prop("strokeWidth", "number"),
];

/**
 * The registry. Array order is meaningful twice over: it's the editor's
 * hit-test priority (points before rects, small before large), and the order
 * kinds are written to the level string (floors last keeps their relative
 * painter's order intact within the floors array on reload).
 */
export const ENTITY_DEFS: EntityDef[] = [
  {
    kind: "spawn",
    label: "Player spawn",
    shape: "point",
    singleton: true,
    fields: [
      zField,
      playerSlotField("primary", DEFAULT_PLAYER_PRIMARY),
      playerSlotField("secondary", DEFAULT_PLAYER_SECONDARY),
      armorField,
      skinField,
    ],
    list: (s) => s.playerSpawn,
    match: () => true,
    create: (pos, z) => ({
      pos,
      z,
      primary: DEFAULT_PLAYER_PRIMARY,
      secondary: DEFAULT_PLAYER_SECONDARY,
    }),
    zOf: (e) => e.z,
    marker: () => ({ color: "#ffd94a", label: "player" }),
  },
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
          // Old level strings baked the loadout into the type name ("pistol");
          // translate those into the type + per-spawn gun scheme on load. (A
          // later "gun" key in the record still overrides, fields apply in order.)
          const legacy = LEGACY_ENEMY_TYPES[v];
          if (legacy) {
            e.type = legacy.type;
            if (legacy.gun) e.gun = legacy.gun;
          } else if (v in ENEMY_TYPES) {
            e.type = v;
          }
        },
      },
      {
        key: "team",
        type: "select",
        options: () => Object.values(TEAMS).map((t) => ({ value: t.id, label: t.label })),
        get: (e) => e.team ?? "enemy",
        set: (e, v) => {
          if (v in TEAMS) e.team = v;
        },
      },
      {
        key: "gun",
        type: "select",
        options: () => Object.entries(GUN_SPECS).map(([value, g]) => ({ value, label: g.name })),
        get: (e) => e.gun ?? DEFAULT_ENEMY_GUN,
        set: (e, v) => {
          if (v in GUN_SPECS) e.gun = v;
        },
      },
      armorField,
      skinField,
    ],
    list: (s) => s.spawns,
    match: () => true,
    create: (pos, z) => ({
      type: firstKey(ENEMY_TYPES),
      gun: DEFAULT_ENEMY_GUN,
      team: "enemy",
      pos,
      z,
    }),
    zOf: (e) => e.z,
    marker: (e) => ({
      color: TEAMS[e.team ?? "enemy"]?.color ?? ENEMY_TYPES[e.type]?.color ?? "#e05555",
      label: e.type,
    }),
  },
  {
    kind: "node",
    label: "Nav node",
    shape: "point",
    fields: [zField],
    list: (s) => s.world.nodes,
    match: () => true,
    create: (pos, z) => makeNode(pos, z),
    zOf: (e) => e.z,
    marker: () => ({ color: "#35d0c5", label: "node" }),
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
    kind: "spawnzone",
    label: "Spawn zone",
    shape: "rect",
    fields: [
      zField,
      {
        key: "team",
        type: "select",
        options: () => Object.values(TEAMS).map((t) => ({ value: t.id, label: t.label })),
        get: (e) => e.team ?? "blue",
        set: (e, v) => {
          if (v in TEAMS) e.team = v;
        },
      },
    ],
    list: (s) => s.spawnZones,
    match: () => true,
    create: (pos, z): SpawnZone => ({ pos, w: 300, h: 300, z, team: "blue" }),
    zOf: (e) => e.z,
  },
  {
    kind: "wall",
    label: "Wall",
    shape: "rect",
    fields: [zField, ...obstacleLook],
    list: (s) => s.world.obstacles,
    match: (e: Obstacle) => !e.cross && !e.permeable,
    create: (pos, z) => makeWall(pos, 140, WALL_T, z),
    zOf: (e) => e.z,
  },
  {
    kind: "crate",
    label: "Crate",
    shape: "rect",
    fields: [zField, ...obstacleLook],
    list: (s) => s.world.obstacles,
    match: (e: Obstacle) => !!e.cross,
    create: (pos, z) => makeCrate(pos, 64, 64, z),
    zOf: (e) => e.z,
  },
  {
    kind: "fence",
    label: "Fence",
    shape: "rect",
    fields: [zField, ...obstacleLook],
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
      prop("color2", "color"),
      prop("steps", "number"),
      depthField,
    ],
    list: (s) => s.world.stairs,
    match: () => true,
    create: (pos, z) => makeStairs(pos, 120, 200, "y", z + 1, z, [z, z + 1], "#7c6034", "#beb09a"),
    zOf: (e: Stairs) => Math.min(e.zAtMin, e.zAtMax),
  },
  {
    kind: "floor",
    label: "Floor",
    shape: "rect",
    fields: [
      prop("level", "number"),
      depthField,
      prop("color", "color"),
      prop("visibleFrom", "json"),
      prop("hideWhenUnder", "checkbox"),
      prop("hideWhenIn", "regions"),
      prop("enclosing", "checkbox"),
      prop("infinite", "checkbox"),
      prop("invisible", "checkbox"),
      // Background settings — only consulted while this floor IS the background
      // (infinite + visible), but harmless to set on any floor.
      prop("grid", "checkbox"),
      prop("gridColor", "color"),
      prop("gridWidth", "number"),
      prop("gridGap", "number"),
      // Stand-on camera zoom: absolute override / additive delta. 0 = unset
      // (a 0 zoom is meaningless and a 0 delta is a no-op, so 0 doubles as
      // "clear" — number inputs have no other way to say undefined).
      {
        key: "zoom",
        type: "number",
        get: (e) => e.zoom ?? 0,
        set: (e, v) => {
          e.zoom = v === 0 ? undefined : v;
        },
      },
      {
        key: "deltaZoom",
        type: "number",
        get: (e) => e.deltaZoom ?? 0,
        set: (e, v) => {
          e.deltaZoom = v === 0 ? undefined : v;
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
    // Rotation is geometry like w/h, stored in degrees for readable levels
    // (radians in memory) and omitted while axis-aligned — so pre-rotation
    // level strings and unrotated entities serialize exactly as before.
    if (e.angle) j.angle = round2(rad2deg(e.angle));
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
  // The match config, when set, rides on top of the entity list (compact, one
  // line). Levels with no mode serialize exactly as before.
  const metaLine = state.meta.mode ? `  "meta": ${JSON.stringify(state.meta)},\n` : "";
  return `{ "version": 1,\n${metaLine}  "entities": [\n${lines.join(",\n")}\n] }`;
}

/**
 * Replace `state`'s contents with the level in `text` (mutates the arrays in
 * place, so live references — main's `world` — see the swap). Throws on
 * malformed JSON; unknown kinds/fields are skipped, not fatal, so levels stay
 * loadable across content changes.
 */
export function applyLevel(state: LevelState, text: string): void {
  const doc = JSON.parse(text) as { entities?: unknown[]; meta?: LevelMeta };
  const ents = Array.isArray(doc.entities) ? doc.entities : [];
  const w = state.world;
  w.obstacles.length = 0;
  w.floors.length = 0;
  w.stairs.length = 0;
  w.nodes.length = 0;
  w.items.length = 0;
  w.bullets.length = 0;
  w.particles.length = 0;
  state.spawns.length = 0;
  state.playerSpawn.length = 0;
  state.spawnZones.length = 0;
  state.meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};

  for (const raw of ents) {
    const j = raw as Record<string, any>;
    const def = defByKind.get(j.kind);
    if (!def || typeof j.x !== "number" || typeof j.y !== "number") continue;
    def.list(state).push(entityFromJSON(def, j));
  }

  // Bake the static render order — the one sort the game ever runs per load.
  sortRenderDepth(w);
}

/** Build one entity from its JSON record (not added to any list). The inverse
 *  of entityToJSON — also the editor's paste path, so copies deep-clone through
 *  the same code as level loading. */
export function entityFromJSON(def: EntityDef, j: Record<string, any>): any {
  const z =
    typeof j.z === "number" ? j.z
    : typeof j.level === "number" ? j.level
    : typeof j.zAtMax === "number" ? j.zAtMax
    : 0;
  const e = def.create(vec(j.x, j.y), z);
  if (def.shape === "rect") {
    if (typeof j.w === "number") e.w = j.w;
    if (typeof j.h === "number") e.h = j.h;
    if (typeof j.angle === "number" && j.angle !== 0) e.angle = deg2rad(j.angle);
  }
  for (const f of def.fields) if (f.key in j) f.set(e, j[f.key]);
  return e;
}

/** Parse a level string into a fresh, self-contained LevelState. */
export function loadLevel(text: string): LevelState {
  const state: LevelState = {
    world: { obstacles: [], floors: [], stairs: [], nodes: [], items: [], bullets: [], particles: [] },
    spawns: [],
    playerSpawn: [],
    spawnZones: [],
    meta: {},
  };
  applyLevel(state, text);
  return state;
}
