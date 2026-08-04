/**
 * Utility items — the belt (slot 4) consumables. Like guns and armor, a utility
 * is split into immutable data (`UtilitySpec`) and the amount carried; the live
 * per-character state (which one is selected, the use timer, any status effect)
 * lives on the Character (see actor.ts). Today they're all healing items, but
 * the shape is deliberately generic so a future grenade/stim/etc. is just
 * another spec with a different `apply`.
 *
 * A use is a timed action (like a reload): the player clicks to start it, moves
 * slower while it runs, and the effect (`apply`) lands when the timer completes,
 * consuming one from the belt.
 */
import type { Character } from "./actor.ts";
import type { HandsAnimation } from "./guns.ts";
import { UtilityItem, type Droppable, type GroundItem } from "./item.ts";
import type { Vec2 } from "../engine/vec.ts";

export interface UtilitySpec {
  readonly name: string;
  /** Icon asset filename in /assets, WITH extension (e.g. "bandage.svg"). Unlike
   *  guns/armor these vary by type (svg/png), so the extension is spelled out. */
  readonly icon: string;
  /** Ticks the use action takes before the effect applies (60 ticks/s). */
  readonly useTime: number;
  /** Most of this item a character may carry at once. */
  readonly maxCarry: number;
  /** Hand keyframes played over the use (elapsed t in [0, useTime]), same shape
   *  as a gun's `reloadAnim`. Omitted = hands hold their default (fists) pose. */
  readonly useAnim?: HandsAnimation;
  /** Land the item's effect on `user` when a use completes. */
  apply(user: Character): void;
}

/** One entry on a character's utility belt: a spec and how many are held. Also a
 *  Droppable — a dropped stack becomes a UtilityItem pile of the same count. */
export class UtilityStack implements Droppable {
  constructor(public spec: UtilitySpec, public count: number) {}

  /** Put this stack on the ground as a UtilityItem pile at (`pos`, `z`), tossed
   *  with `vel` (the Droppable API). */
  getGroundItem(pos: Vec2, vel: Vec2, z: number): GroundItem {
    return new UtilityItem(pos, this.spec, this.count, vel, z);
  }
}

/** Instant patch: heals a flat amount the moment the use completes. */
// Fists rest pose (matches guns.ts UNARMED grips) — the pose the hands return to.
const FIST_R = { f: 50, l: 15 };
const FIST_L = { f: 70, l: -20 };

export const BANDAGE: UtilitySpec = {
  name: "Bandage",
  icon: "bandage_outline.svg",
  useTime: 150, // ~2.5s to wrap
  maxCarry: 5,
  // Both hands draw together in front to wrap, hold, then return.
  useAnim: {
    rightTimes: [0, 25, 95, 120],
    rightPositions: [FIST_R, { f: 58, l: 2 }, { f: 58, l: 2 }, FIST_R],
    leftTimes: [0, 25, 95, 120],
    leftPositions: [FIST_L, { f: 62, l: -4 }, { f: 62, l: -4 }, FIST_L],
  },
  apply: (u) => u._heal(20),
};

// Syringe: a heal-over-time regen. 4 HP/s for 12.5s (50 total) — reapplying
// refreshes the duration but does not stack the rate (see Character.applyRegen).
const SYRINGE_RATE = 5 / 60; // HP per tick
const SYRINGE_TICKS = Math.round(10 * 60); // 750 ticks

export const SYRINGE: UtilitySpec = {
  name: "Syringe",
  icon: "syringe_outline.png",
  useTime: 120, // ~2s to jab
  maxCarry: 1,
  // Right hand thrusts out, pulls in to inject, then returns; left steadies.
  useAnim: {
    rightTimes: [0, 20, 40, 60, 90],
    rightPositions: [FIST_R, { f: 80, l: 8 }, { f: 45, l: 5 }, { f: 45, l: 5 }, FIST_R],
    leftTimes: [0, 20, 90],
    leftPositions: [FIST_L, { f: 55, l: -6 }, FIST_L],
  },
  apply: (u) => u.applyRegen(SYRINGE_RATE, SYRINGE_TICKS),
};

/** The belt a fresh player spawns with. */
const DEFAULT_KIT: readonly UtilityStack[] = [
  new UtilityStack(BANDAGE, 2),
  new UtilityStack(SYRINGE, 1),
];

/** A fresh (independently mutable) copy of the default starting belt. */
export function startingUtilities(): UtilityStack[] {
  return DEFAULT_KIT.map((u) => new UtilityStack(u.spec, u.count));
}
