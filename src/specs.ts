/**
 * The auto-discovered spec registries, keyed by export name — which is what
 * gets serialized into level strings, so renaming an export breaks old levels
 * but adding one is free. Lives in its own module (rather than level.ts) so
 * both the level registry and the enemy system can use the same registries
 * without an import cycle.
 */
import type { ArmorSpec } from "./armor.ts";
import * as Armors from "./armor.ts";
import type { GunSpec } from "./guns.ts";
import * as Guns from "./guns.ts";

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
