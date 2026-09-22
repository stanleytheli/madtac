/**
 * Keyboard + mouse -> one PlayerInput per tick (see engine/command.ts). This is
 * the only place the human's bindings, key edges, screen-space aim and the HUD
 * right-click hit-test meet the sim: it reads engine/input.ts and hands
 * Game.update pure data. Poll it once per SIM TICK, not per frame, so a press
 * held across a lag spike's catch-up ticks still registers exactly once.
 */
import type { Character } from "../entities/actor.ts";
import type { PlayerInput } from "../engine/command.ts";
import { isAction, isDown, mouse, moveAxis } from "../engine/input.ts";
import { norm, sub, vec, type Vec2 } from "../engine/vec.ts";
import { hudHitTest } from "./ui.ts";

export class LocalControls {
  /** Last tick's state per edge-detected key, so a press reads once. */
  private readonly was = new Map<string, boolean>();

  /** True on the tick `down` first became true for `key`. */
  private press(key: string, down: boolean): boolean {
    const before = this.was.get(key) ?? false;
    this.was.set(key, down);
    return down && !before;
  }

  /** Aim direction from the mouse: screen-space, from the screen centre, so it
   *  is invariant to the camera's scale and translation. */
  private aim(w: number, h: number): Vec2 {
    const t = sub(mouse, vec(w / 2, h / 2));
    return t.x === 0 && t.y === 0 ? vec(0, -1) : norm(t);
  }

  /** The player's input for this tick. `w`/`h` are the screen size in CSS px
   *  (for the aim centre and the HUD layout); `player` is whose HUD it is. */
  poll(player: Character, w: number, h: number): PlayerInput {
    const fire = isAction("fire");
    let equip: PlayerInput["equip"] = null;
    if (this.press("primary", isAction("primary"))) equip = "primary";
    if (this.press("secondary", isAction("secondary"))) equip = "secondary";
    if (this.press("melee", isAction("melee"))) equip = "hand";
    if (this.press("utility", isAction("utility"))) equip = "utility";
    return {
      move: moveAxis(),
      aim: this.aim(w, h),
      fire,
      firePressed: this.press("fire", fire),
      reload: isAction("reload"),
      equip,
      cancel: this.press("cancel", isAction("cancel")),
      interact: this.press("interact", isAction("interact")),
      drop: this.press("drop", isAction("drop")),
      dropHud: this.press("dropHud", isAction("dropHud")) ? hudHitTest(mouse, w, h, player) : null,
      restart: this.press("restart", isDown("Enter")),
      debugDamage: this.press("debugDamage", isDown("KeyJ")),
      debugHeal: this.press("debugHeal", isDown("KeyK")),
    };
  }
}
