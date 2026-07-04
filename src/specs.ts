/**
 * The auto-discovered spec registries, keyed by export name — which is what
 * gets serialized into level strings, so renaming an export breaks old levels
 * but adding one is free. Lives in its own module (rather than level.ts) so
 * both the level registry and the enemy system can use the same registries
 * without an import cycle.
 */
import type { ArmorSpec } from "./armor.ts";
import * as Armors from "./armor.ts";
import type { Skin } from "./character.ts";
import * as Characters from "./character.ts";
import type { GunSpec } from "./guns.ts";
import * as Guns from "./guns.ts";
import * as Oracles from "./oracle.ts";
import * as Robots from "./robot.ts";
import * as TacOracles from "./tacoracle.ts";

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

/** Every exported Skin across the character + AI modules (DEFAULT_SKIN,
 *  ROBOT_SKIN, ORACLE_SKIN, ...), so any spawn can wear any look. */
export const SKINS: Record<string, Skin> = {};
for (const mod of [Characters, Robots, Oracles, TacOracles]) {
  for (const [k, v] of Object.entries(mod)) {
    if (v && typeof v === "object" && "head" in v && "rightForearm" in v) {
      SKINS[k] = v as Skin;
    }
  }
}
