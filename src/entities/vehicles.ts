/**
 * Vehicle specs (immutable data) + the auto-discovered `VEHICLE_SPECS` registry,
 * keyed by export name — the key is what serializes into level strings, so
 * adding a vehicle is free and renaming an export breaks old levels (same rule
 * as GUN_SPECS in specs.ts). The live `Vehicle` class is in vehicle.ts.
 *
 * Two shipped examples exercise the general model:
 *   - JEEP: a fast open car. Its body is ONE `permeable` solid box — solid to
 *     driving/walking-through, but rounds and sight pass, so both seats are
 *     exposed (you can shoot the driver, and passengers can fire out).
 *   - TANK: a slow hull that pivots in place. The hull is a solid, non-permeable
 *     box enclosing the driver, so incoming rounds die on it (the driver can't be
 *     shot from outside). A rectangular turret rotates and fires an RPG round from
 *     a muzzle beyond the hull; the round clears its own hull (owner-vehicle skip).
 */
import { vec } from "../engine/vec.ts";
import type { VehicleSpec } from "./vehicle.ts";

export const JEEP: VehicleSpec = {
  name: "Jeep",
  parts: [
    // open body: solid (blocks movement) but permeable (rounds/sight pass).
    { lpos: vec(0, 0), w: 150, h: 84, solid: true, permeable: true, fill: "#5a6b3f", stroke: "#333d22", strokeWidth: 5 },
    // a low hood up front that DOES stop rounds — a sliver of frontal cover.
    { lpos: vec(58, 0), w: 34, h: 84, solid: true, fill: "#4c5b35", stroke: "#333d22", strokeWidth: 4 },
  ],
  seats: [
    { lpos: vec(20, -20), role: "driver" },
    { lpos: vec(20, 20), role: "passenger" },
    { lpos: vec(-35, 0), role: "passenger" },
  ],
  accel: 0.6,
  maxSpeed: 9,
  reverseMul: 0.5,
  friction: 0.9,
  turnRate: 0.05,
  turnAtRest: false,
};

export const TANK: VehicleSpec = {
  name: "Tank",
  parts: [
    // enclosed hull: solid + non-permeable → seals the driver from outside fire.
    { lpos: vec(0, 0), w: 170, h: 112, solid: true, fill: "#4b5240", stroke: "#2c3025", strokeWidth: 6 },
    // rotating turret: fires an RPG from a muzzle past the hull; drawn over the driver.
    {
      lpos: vec(0, 0),
      w: 96,
      h: 50,
      solid: true,
      over: true,
      turret: { gun: "RPG", muzzle: 100 },
      fill: "#3a4030",
      stroke: "#22261c",
      strokeWidth: 5,
    },
  ],
  seats: [{ lpos: vec(0, 0), role: "driver", turret: 1 }],
  accel: 0.35,
  maxSpeed: 5,
  reverseMul: 0.5,
  friction: 0.9,
  turnRate: 0.03,
  turnAtRest: true,
};

/** Every exported VehicleSpec, keyed by export name. */
export const VEHICLE_SPECS: Record<string, VehicleSpec> = {};
for (const [k, v] of Object.entries({ JEEP, TANK } as Record<string, VehicleSpec>)) {
  VEHICLE_SPECS[k] = v;
}
