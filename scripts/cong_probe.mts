import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
const TEXT = readFileSync("src/world/levels/house-sidesites-3.json", "utf8");
(Robot as unknown as { nextPhase: number }).nextPhase = 0;
const g = new Game(loadLevel(TEXT), new DominationMode({ blue: { troops: 12 }, red: { troops: 12 } }));
const nav: any = (g as any).nav;
// classify each REAL arc by how central its midpoint is
const arcMidX = (a: number) => { const lo = nav.nodes[nav.aLo[a]].pos, hi = nav.nodes[nav.aHi[a]].pos; return { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: nav.nodes[nav.aLo[a]].z }; };
for (let t = 0; t <= 1200; t++) {
  g.update();
  if (t % 400 === 0 && t > 0) {
    const c: Float64Array = nav.congByTeam.get("blue")?.congestion;
    if (!c) { console.log(t, "no field"); continue; }
    let cen = 0, out = 0, cenA = 0, outA = 0;
    for (let a = 0; a < c.length; a++) {
      if (c[a] <= 0 || !Number.isFinite(nav.aBase[a])) continue;
      const m = arcMidX(a);
      if (Math.abs(m.x) < 250) { cen += c[a]; cenA++; } else { out += c[a]; outA++; }
    }
    console.log(`t=${t}  blue congestion:  CENTRAL(|x|<250)=${cen.toFixed(0)} on ${cenA} arcs   OUTER=${out.toFixed(0)} on ${outA} arcs   central-share=${(100*cen/(cen+out)).toFixed(0)}%`);
  }
}
