/**
 * What the client renders and drives, whatever is behind it: a Game running in
 * this process (single player, the editor's playtest) or a NetSession mirroring
 * a server's match (see net/client.ts). main.ts draws from and steps a Session
 * and never asks which it has.
 *
 * Everything here is from ONE human's point of view — the local one: their
 * character, their kill feed, what they can pick up, their HUD.
 */
import type { Body } from "../entities/body.ts";
import type { Character } from "../entities/actor.ts";
import type { GroundItem } from "../entities/item.ts";
import type { Vehicle } from "../entities/vehicle.ts";
import type { PlayerInput } from "../engine/command.ts";
import type { Game } from "../game.ts";
import type { GamemodeHud, KillFeedEntry, PlayerLoadout } from "../gamemodes/gamemode.ts";
import type { DeathMark } from "./minimap.ts";
import type { World } from "../world/world.ts";

/** What the respawn menu talks to (see ui/respawn.ts): the local human's
 *  loadout picks and their Respawn press, wherever the gamemode lives. */
export interface RespawnHost {
  setLoadout(loadout: PlayerLoadout): void;
  randomize(): void;
  /** True if they respawned (the panel closes); false while the timer runs. */
  respawn(): boolean;
}

export interface Session {
  readonly world: World;
  /** The local human's character. */
  readonly player: Character;
  readonly characters: readonly Character[];
  readonly bodies: readonly Body[];
  /** Sim ticks since the match (re)started, as far as this session knows. */
  readonly tick: number;
  /** Whether the local human's input drives them (alive, match not decided). */
  readonly controllable: boolean;
  readonly killFeed: readonly KillFeedEntry[];
  readonly minimapDeaths: readonly DeathMark[];
  /** The item the E prompt is for (highlighted on the ground), if any. */
  readonly interactable: GroundItem | null;
  /** The seat the E prompt is for (ringed on the ground), if any. */
  readonly enterable: { vehicle: Vehicle; seat: number } | null;
  /** The gamemode's HUD from the local human's point of view. */
  hud(): GamemodeHud | null;
  interactLabel(): string | null;
  /** View targets the client eases toward (see ui/view.ts). */
  zoomTarget(): number;
  spreadTarget(): number;
  visionConeTarget(): number;
  /** The respawn menu's host, or null when the mode has no respawn screen. */
  respawnHost(): RespawnHost | null;
  /** One client tick: hand the local human's input over and advance. */
  step(input: PlayerInput): void;
  /** Before a frame is drawn: move what is drawn to where it should read at
   *  wall-clock `nowMs` (a network session smooths between snapshots here). */
  interpolate?(nowMs: number): void;
}

/** A Game in this process, seen by its first human. */
export class LocalSession implements Session {
  constructor(readonly game: Game) {}

  private get slot() {
    return this.game.humans[0];
  }
  get world(): World {
    return this.game.world;
  }
  get player(): Character {
    return this.game.player;
  }
  get characters(): readonly Character[] {
    return this.game.characters;
  }
  get bodies(): readonly Body[] {
    return this.game.bodies;
  }
  get tick(): number {
    return this.game.tick;
  }
  get controllable(): boolean {
    return this.slot.controllable;
  }
  get killFeed(): readonly KillFeedEntry[] {
    return this.slot.killFeed;
  }
  get minimapDeaths(): readonly DeathMark[] {
    return this.slot.minimapDeaths;
  }
  get interactable(): GroundItem | null {
    return this.slot.interactable;
  }
  get enterable(): { vehicle: Vehicle; seat: number } | null {
    return this.slot.enterable;
  }
  hud(): GamemodeHud | null {
    return this.game.gamemode.hud(this.game, this.player);
  }
  interactLabel(): string | null {
    return this.game.interactLabel(this.slot);
  }
  zoomTarget(): number {
    return this.game.zoomTarget(this.slot);
  }
  spreadTarget(): number {
    return this.game.spreadTarget(this.slot);
  }
  visionConeTarget(): number {
    return this.game.visionConeTarget(this.slot);
  }
  respawnHost(): RespawnHost | null {
    const g = this.game;
    const mode = g.gamemode;
    if (!mode.setPlayerLoadout) return null;
    return {
      setLoadout: (l) => mode.setPlayerLoadout?.(g.player, l),
      randomize: () => mode.randomizePlayerLoadout?.(g.player),
      respawn: () => mode.requestRespawn?.(g, g.player) ?? false,
    };
  }
  step(input: PlayerInput): void {
    this.game.update(input);
  }
}
