import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { DominationOracle } from "../src/ai/domoracle.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
const TEXT = readFileSync("src/world/levels/house-sidesites-3.json", "utf8");
(Robot as unknown as { nextPhase: number }).nextPhase = 0;
const g = new Game(loadLevel(TEXT), new DominationMode({ blue: { troops: 4 }, red: { troops: 4 } }));
const SITES: [string, number, number, number][] = [["A", 0, -960, 0], ["B", 0, 0, 1], ["C", 0, 920, 0]];
const onSite = (c: any) => SITES.find(([, x, y, z]) => c.z === z && Math.hypot(c.pos.x - x, c.pos.y - y) <= 175);
for (let t = 0; t < 3000; t++) {
  g.update();
  if (t >= 2000 && t <= 2600 && t % 30 === 0) {
    // pick one blue bot sitting on a site
    const c: any = (g.characters as any[]).find((c) => c instanceof DominationOracle && c.team === "blue" && c.hp > 0 && onSite(c));
    if (c) {
      const site = onSite(c)![0];
      const seesEnemy = (g.characters as any[]).some((e) => e.team !== c.team && e.hp > 0 && e.z === c.z && c.canSee(g.world, e));
      console.log(`t=${t} site=${site} mode=${c.mode} focus=${c.focus ? "Y" : "-"} holdEntry=${c.holdEntry ? "Y" : "-"} wantsHold=${c.wantsHold(g.aiCtx ?? {}, null) === true} pursueCd=${c.pursueCooldown} sees=${seesEnemy} aim=${(c.aimAngle*57).toFixed(0)}°`);
    }
  }
}
