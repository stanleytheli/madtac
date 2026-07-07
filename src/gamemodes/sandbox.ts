/**
 * The default mode: no rules. Spawns the level's authored enemies once and
 * otherwise does nothing — the game plays exactly as it did before the gamemode
 * layer existed. Used whenever a level names no mode.
 */
import { spawnEnemy } from "../enemies.ts";
import type { GameCtx, Gamemode, GamemodeHud } from "./gamemode.ts";

export class SandboxMode implements Gamemode {
  readonly id = "sandbox";
  readonly label = "Sandbox";

  init(ctx: GameCtx): void {
    ctx.player.team = "player";
    for (const s of ctx.level.spawns) ctx.addCharacter(spawnEnemy(s));
  }

  update(): void {}
  onDeath(): void {}
  hud(): GamemodeHud | null {
    return null;
  }
}
