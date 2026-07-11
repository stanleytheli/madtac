/**
 * The gamemode layer: the rules that sit *above* the sandbox sim — spawning,
 * respawns, scoring, and win/lose. A Gamemode plugs into the Game session
 * (src/game.ts) through a handful of hooks and reads/drives the match via the
 * GameCtx facade the Game implements.
 *
 * Concrete modes live beside this file (sandbox.ts, tdm.ts). Adding one is a
 * class + a line in GAMEMODES; the level's `meta.mode` (or a ?mode= override)
 * picks it at load.
 */
import type { Character } from "../entities/actor.ts";
import type { ObjectivePoint } from "../ai/robot.ts";
import type { Body } from "../entities/body.ts";
import type { LevelMeta, LevelState } from "../world/level.ts";
import type { NavGraph } from "../world/nav.ts";
import type { TeamId } from "../entities/team.ts";
import type { Vec2 } from "../engine/vec.ts";
import type { World } from "../world/world.ts";
import { SandboxMode } from "./sandbox.ts";
import { TeamDeathmatchMode } from "./tdm.ts";
import { DominationMode } from "./domination.ts";

/** What a gamemode reads and drives, provided by the Game session. */
export interface GameCtx {
  readonly world: World;
  readonly nav: NavGraph | null;
  /** The live roster (player + bots). Mutable — spawn via addCharacter. */
  readonly characters: Character[];
  readonly bodies: Body[];
  readonly player: Character;
  /** The loaded level (spawnZones, playerSpawn, meta). */
  readonly level: LevelState;
  /** Ticks since the match (re)started. */
  readonly tick: number;
  /** Add a freshly built character to the roster. */
  addCharacter(c: Character): void;
  /** A random point inside a random zone of `team`, or null if it has none. */
  spawnPoint(team: TeamId): { pos: Vec2; z: number } | null;
  /** Reset the player object in place and re-add it to the roster (reusing the
   *  object so render/camera refs stay valid). With `loadout` (GUN_SPECS /
   *  ARMOR_SPECS keys) the player is re-armed to that kit with full ammo; without
   *  it, the player keeps whatever it currently holds, ammo refreshed. */
  revivePlayer(pos: Vec2, z: number, loadout?: PlayerLoadout): void;
}

/** A player kit chosen at the respawn screen — GUN_SPECS / ARMOR_SPECS keys
 *  (undefined = empty slot / no armor). */
export interface PlayerLoadout {
  primary?: string;
  secondary?: string;
  armor?: string;
}

/** One team's line on the bottom-left scoreboard. */
export interface TeamScore {
  team: TeamId;
  label: string;
  color: string;
  /** Deaths this team can still take before it loses. */
  remaining: number;
  /** The bar's full length (killLimit). */
  limit: number;
}

/** One combatant's line on the Tab scoreboard. */
export interface PlayerRow {
  name: string;
  team: TeamId;
  color: string;
  kills: number;
  deaths: number;
  /** True for the human's own row (highlighted in the list). */
  isPlayer: boolean;
}

/** A domination capture point's live state, for rendering (in-world circle,
 *  minimap highlight). See gamemodes/domination.ts for the model. */
export interface DomPointView {
  name: string;
  pos: Vec2;
  z: number;
  radius: number;
  /** The leading ("max progress") team — the one capturing or holding the point.
   *  Meaningless (arbitrary) while progress is 0; rendering shows plain gray. */
  team: TeamId;
  /** Progress in [0,2]: gray-being-captured on [0,1), owned/strengthening [1,2]. */
  progress: number;
}

/** What a gamemode wants drawn on top of the normal HUD. */
export interface GamemodeHud {
  name: string;
  /** Bottom-left ticket bars, one per team (empty = draw nothing). */
  scores: TeamScore[];
  /** Centered overlay text (win/lose, respawn countdown). */
  banner?: string;
  /** Match is decided: freeze player input; a keypress restarts. */
  over: boolean;
  /** Per-combatant K/D for the Tab scoreboard (undefined = no player list). */
  players?: PlayerRow[];
  /** The player is dead and picking their next kit — show the respawn-screen
   *  loadout dropdown (see setPlayerLoadout). */
  choosingLoadout?: boolean;
  /** The player's current chosen kit, to populate that dropdown. */
  loadout?: PlayerLoadout;
  /** Domination capture points to render (in-world + minimap); undefined for
   *  modes without them. */
  points?: DomPointView[];
}

export interface Gamemode {
  readonly id: string;
  readonly label: string;
  /** Ticks a corpse lingers before it despawns (undefined = never). */
  readonly bodyTtl?: number;
  /** Ticks a death-dropped weapon/armor lingers before it despawns (undefined =
   *  never). Authored level pickups are never stamped, so they always persist. */
  readonly itemTtl?: number;
  /** Assign teams and do the initial spawns. Called once per match start. */
  init(ctx: GameCtx): void;
  /** Per-tick rule evaluation, run right after the dead are reaped. */
  update(ctx: GameCtx): void;
  /** A character just died (before it leaves the roster). */
  onDeath(dead: Character, ctx: GameCtx): void;
  /** Scoreboard/banner for the HUD, or null for no gamemode UI. */
  hud(ctx: GameCtx): GamemodeHud | null;
  /** Set the player's chosen kit for their next life (respawn-screen dropdown).
   *  Only modes with a customizable respawn (TDM) implement this. */
  setPlayerLoadout?(loadout: PlayerLoadout): void;
  /** The objectives to feed objective-seeking AIs this tick (domination points),
   *  or undefined for modes without them. */
  objectives?(ctx: GameCtx): ObjectivePoint[];
}

/** Every mode, keyed by the id levels put in `meta.mode`. */
export const GAMEMODES: Record<string, (meta: LevelMeta) => Gamemode> = {
  sandbox: () => new SandboxMode(),
  tdm: (meta) => new TeamDeathmatchMode(meta.tdm),
  domination: (meta) => new DominationMode(meta.domination),
};

/** Used when a level names no mode (and for unknown ids). */
export const DEFAULT_MODE = "sandbox";
