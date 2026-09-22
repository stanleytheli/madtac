/**
 * One tick of a player's intent, as data. The client builds one of these from
 * its keyboard/mouse (see ui/controls.ts: bindings, edge detection, the HUD
 * hit-test for right-click drops, screen-space aim) and hands it to
 * Game.update; the sim reads nothing but this. Bots never build one — they
 * drive their Character directly from Robot.think — so this is the human's
 * lane only, and the one thing a client would send a server each tick.
 *
 * Held vs pressed: `fire` and `reload` report the key's STATE (an automatic
 * weapon fires while held; holding R keeps asking for a reload, which is a
 * no-op mid-reload); everything else is a PRESS — true on the tick the key
 * went down and false while it stays down. The client does the edge detection,
 * so a press held across a lag spike's catch-up ticks still fires once.
 */
import type { EquipSlot } from "../entities/actor.ts";
import type { SlotKind } from "../ui/ui.ts";
import { vec, type Vec2 } from "./vec.ts";

export interface PlayerInput {
  /** Raw movement axis, each component in {-1, 0, 1}; x = right, y = down. */
  move: Vec2;
  /** Unit aim direction, world frame. */
  aim: Vec2;
  /** Trigger held this tick. */
  fire: boolean;
  /** Trigger went down this tick (the semi-auto / utility-use edge). */
  firePressed: boolean;
  /** Reload key held. */
  reload: boolean;
  /** A slot key pressed this tick: switch to it (the belt key on the belt
   *  cycles to the next carried utility instead). Null = none. */
  equip: EquipSlot | null;
  /** X pressed: abort a timed action (reload, utility use). */
  cancel: boolean;
  /** E pressed: board / exit / pick up. */
  interact: boolean;
  /** Q pressed: drop what's in hand. */
  drop: boolean;
  /** Right-click pressed on a HUD slot: drop that slot. Resolved by the client
   *  against ITS HUD layout — the sim has no screen. Null = none. */
  dropHud: SlotKind | null;
  /** Enter pressed: restart a decided match. */
  restart: boolean;
  /** Debug keys pressed: J hurts the player, K heals them. */
  debugDamage: boolean;
  debugHeal: boolean;
}

/** No input at all: standing still, aiming up, touching nothing. What a headless
 *  script's player does, and what Game.update assumes when handed nothing. */
export function idleInput(): PlayerInput {
  return {
    move: vec(0, 0),
    aim: vec(0, -1),
    fire: false,
    firePressed: false,
    reload: false,
    equip: null,
    cancel: false,
    interact: false,
    drop: false,
    dropHud: null,
    restart: false,
    debugDamage: false,
    debugHeal: false,
  };
}
