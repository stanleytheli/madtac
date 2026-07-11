// Regenerate src/world/levels/demo.json from the hand-coded demo map (world.ts
// plus the spawn/item tables mirrored from main.ts). Run from the repo root:
//   node --experimental-strip-types scripts/gen_demo.mts
import { mkdirSync, writeFileSync } from "node:fs";
import * as Armors from "../src/entities/armor.ts";
import { Gun } from "../src/entities/gun.ts";
import * as Guns from "../src/entities/guns.ts";
import { ArmorItem, GunItem } from "../src/entities/item.ts";
import { serializeLevel, type LevelState } from "../src/world/level.ts";
import { vec } from "../src/engine/vec.ts";
import { createWorld } from "../src/world/world.ts";

const state: LevelState = {
  world: createWorld(),
  spawns: [
    { type: "robot", gun: "M16", pos: vec(320, -260), z: 0 },
    { type: "oracle", gun: "M16", pos: vec(450, -400), z: 0 },
    { type: "tacoracle", gun: "M16", pos: vec(560, -260), z: 0 },
    { type: "robot", gun: "M9", pos: vec(-640, -450), z: 1 },
    { type: "robot", gun: "M16", pos: vec(880, -140), z: -1 },
    { type: "robot", gun: "M9", pos: vec(260, 480), z: -1 },
    { type: "robot", gun: "M9", pos: vec(60, -720), z: 0 },
  ],
  playerSpawn: [{ pos: vec(0, 0), z: 0 }],
  spawnZones: [],
  meta: {},
};

state.world.items.push(new GunItem(vec(-120, -80), new Gun(Guns.Deagle)));
state.world.items.push(new GunItem(vec(80, 120), new Gun(Guns.M249)));
state.world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L1)));
state.world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L2)));
state.world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L3)));
state.world.items.push(new ArmorItem(vec(170, -40), new Armors.Armor(Armors.ARMOR_L4)));
state.world.items.push(new GunItem(vec(760, -100), new Gun(Guns.Golden_Deagle), vec(0, 0), -1));

mkdirSync("src/world/levels", { recursive: true });
writeFileSync("src/world/levels/demo.json", serializeLevel(state) + "\n");
console.log("wrote src/world/levels/demo.json");
