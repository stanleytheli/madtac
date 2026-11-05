/**
 * The named enemy types levels can spawn, and the spawner that builds a live
 * NPC from a spawn record. This is the single place a new enemy *behaviour* is
 * registered: add an entry and it shows up in the level editor's palette and in
 * level strings (keyed by the record key) automatically.
 *
 * A type is a behaviour + stat archetype only — its gun, armor, and team are
 * per-spawn fields chosen in the editor (see the enemy EntityDef in level.ts),
 * so any type can wear any loadout.
 *
 * Lives apart from robot.ts so it can name every AI class (Robot, Oracle, ...)
 * without creating a module cycle with the subclasses.
 */
import { Armor } from "../entities/armor.ts";
import type { UtilityStack } from "../entities/consumable.ts";
import type { EnemySpawn } from "../world/level.ts";
import { Oracle } from "./oracle.ts";
import { ELITE_ROBOT_SKIN, Robot, type RobotOptions } from "./robot.ts";
import { ARMOR_SPECS, GUN_SPECS, SKINS } from "../entities/specs.ts";
import { TacOracle, type TacOracleOptions } from "./tacoracle.ts";
import { DominationOracle } from "./domoracle.ts";
import { TEAMS, type TeamId } from "../entities/team.ts";
import { vec, type Vec2 } from "../engine/vec.ts";
import { registry } from "../engine/registry.ts";

export interface EnemyTypeDef {
  /** Human-readable name (editor palette / inspector dropdown). */
  label: string;
  /** Construction options baked into the type; the spawn's z/gun/team override. */
  options: RobotOptions;
  /** Build the live NPC (which AI class this type is). */
  make(pos: Vec2, options: RobotOptions): Robot;
  /** Fallback marker color in the level editor (team color usually wins). */
  color: string;
}

/** GUN_SPECS key of the weapon a spawn gets when none is chosen. Matches
 *  ROBOT_DEFAULTS.gun in robot.ts. */
export const DEFAULT_ENEMY_GUN = "M16";

export const ENEMY_TYPES: Record<string, EnemyTypeDef> = registry<EnemyTypeDef>({
  robot: {
    label: "Robot",
    options: {},
    make: (pos, opts) => new Robot(pos, opts),
    color: "#c94f4f",
  },
  elite: {
    label: "Elite Robot",
    options: { health: 200, spreadDeg: 10, skin: ELITE_ROBOT_SKIN },
    make: (pos, opts) => new Robot(pos, opts),
    color: "#8a4ad0",
  },
  oracle: {
    label: "Oracle",
    options: {},
    make: (pos, opts) => new Oracle(pos, opts),
    color: "#35d0c5",
  },
  tacoracle: {
    label: "TacOracle",
    options: {},
    make: (pos, opts) => new TacOracle(pos, opts),
    color: "#d9a441",
  },
});

/** Pre-loadout type names from old level strings, mapped onto the new
 *  type + per-spawn gun scheme so those levels keep loading. */
export const LEGACY_ENEMY_TYPES: Record<string, { type: string; gun?: string }> = registry({
  grunt: { type: "robot", gun: "M16" },
  pistol: { type: "robot", gun: "M9" },
});

/** Options for a gamemode-generated combatant (see makeTroop). Unlike an
 *  EnemySpawn these carry the fine AI knobs a gamemode derives from "skill". */
export interface TroopOptions {
  team: TeamId;
  z?: number;
  /** GUN_SPECS key. Omitted = the type default. */
  gun?: string;
  /** ARMOR_SPECS key. Omitted = unarmored. */
  armor?: string;
  reactionTime?: number;
  lambda?: number;
  strafeOffsets?: number[];
  aimSigma?: number;
  skin?: string;
  /** Belt consumables to carry — bots don't use them, but they drop on death so
   *  healing items circulate on the map. */
  utilities?: UtilityStack[];
  /** Which soldier AI to build: the plain TacOracle (default) or the
   *  objective-seeking DominationOracle. */
  ai?: "tacoracle" | "domination";
}

/** Build a soldier for a gamemode (TDM/Domination). Bypasses the authored-spawn
 *  data path so modes can pass the full skill knobs, not just the level fields. */
export function makeTroop(pos: Vec2, o: TroopOptions): Robot {
  const opts: TacOracleOptions = {
    team: o.team,
    z: o.z ?? 0,
    reactionTime: o.reactionTime,
    lambda: o.lambda,
    strafeOffsets: o.strafeOffsets,
    aimSigma: o.aimSigma,
  };
  if (o.gun && GUN_SPECS[o.gun]) opts.gun = GUN_SPECS[o.gun];
  if (o.skin && SKINS[o.skin]) opts.skin = SKINS[o.skin];
  const r = o.ai === "domination"
    ? new DominationOracle(vec(pos.x, pos.y), opts)
    : new TacOracle(vec(pos.x, pos.y), opts);
  if (o.armor && ARMOR_SPECS[o.armor]) r.equipArmor(new Armor(ARMOR_SPECS[o.armor]));
  if (o.utilities) for (const u of o.utilities) r.addUtility(u.spec, u.count);
  return r;
}

/** Instantiate a live NPC from a spawn record (type, position, loadout, team). */
export function spawnEnemy(s: EnemySpawn): Robot {
  const legacy = LEGACY_ENEMY_TYPES[s.type];
  const t = ENEMY_TYPES[legacy?.type ?? s.type] ?? ENEMY_TYPES.robot;

  const opts: RobotOptions = { ...t.options, z: s.z };
  const gunKey = s.gun ?? legacy?.gun;
  if (gunKey && GUN_SPECS[gunKey]) opts.gun = GUN_SPECS[gunKey];
  if (s.team && s.team in TEAMS) opts.team = s.team;
  if (s.skin && SKINS[s.skin]) opts.skin = SKINS[s.skin];

  const r = t.make(vec(s.pos.x, s.pos.y), opts); // pos copied: live NPCs move
  if (s.armor && ARMOR_SPECS[s.armor]) r.equipArmor(new Armor(ARMOR_SPECS[s.armor]));
  return r;
}
