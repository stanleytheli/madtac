import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import { dist } from "../src/engine/vec.ts";

const text = readFileSync("src/world/levels/dom-arena-big.json", "utf8");
const TRIALS = 40, TICKS = 2500, CLUSTER = 3, NEAR = 90, STILL = 0.6, WINDOW = 120;
let events = 0, trials = 0, maxCluster = 0;
for (let trial = 0; trial < TRIALS; trial++) {
  const loaded = loadLevel(text);
  const game = new Game(loaded, GAMEMODES.domination({ ...loaded.meta, mode: "domination" }));
  let prev = new Map<any, { x: number; y: number }>();
  const streak = new Map<any, number>();
  let hit = false;
  for (let t = 1; t <= TICKS; t++) {
    game.update();
    const cs = game.characters.filter((c) => c.hp > 0 && c !== game.player);
    const spd = (c: any) => { const p = prev.get(c); return p ? dist(c.pos, p) : 99; };
    for (const c of cs as any[]) {
      // size of the stationary same-team cluster around c (incl c)
      const near = cs.filter((o: any) => o.team === c.team && o.z === c.z && dist(c.pos, o.pos) < NEAR && spd(o) < STILL);
      const clustered = spd(c) < STILL && near.length >= CLUSTER;
      const s = clustered ? (streak.get(c) ?? 0) + 1 : 0;
      streak.set(c, s);
      if (s === WINDOW) { events++; hit = true; maxCluster = Math.max(maxCluster, near.length); }
    }
    prev = new Map(cs.map((c) => [c, { x: c.pos.x, y: c.pos.y }]));
  }
  if (hit) trials++;
}
console.log(`TRIALS=${TRIALS}: sustained >=${CLUSTER}-clusters events=${events}, trials with=${trials}, maxCluster=${maxCluster}`);
