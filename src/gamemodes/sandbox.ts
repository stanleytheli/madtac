/**
 * The default mode: no rules. Spawns the level's authored enemies once and
 * otherwise does nothing — the game plays exactly as it did before the gamemode
 * layer existed. Used whenever a level names no mode.
 */
import { spawnEnemy } from "../ai/enemies.ts";
import type { Character } from "../entities/actor.ts";
import type { GameCtx, Gamemode, GamemodeHud } from "./gamemode.ts";

export class SandboxMode implements Gamemode {
  readonly id = "sandbox";
  readonly label = "Sandbox";

  init(ctx: GameCtx): void {
    for (const h of ctx.humans) h.char.team = "player";
    for (const s of ctx.level.spawns) ctx.addCharacter(spawnEnemy(s));
  }

  onHumanJoin(_ctx: GameCtx, who: Character): void {
    who.team = "player";
  }

  update(): void {}
  onDeath(): void {}
  hud(): GamemodeHud | null {
    return null;
  }
}
