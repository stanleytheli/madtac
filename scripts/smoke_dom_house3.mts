/** Instrument house-3: what site does each DomOracle actually pick, and where is
 *  it physically? Answers "are bots targeting B but stuck in mid, or targeting
 *  A/C?" siteChoice is a (TS-private) field on DominationOracle — reachable at
 *  runtime through the bundle. */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Robot } from "../src/ai/robot.ts";
import { DominationOracle } from "../src/ai/domoracle.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";

const TEXT = readFileSync("src/world/levels/house-3.json", "utf8");
(Robot as unknown as { nextPhase: number }).nextPhase = 0;
const mode = new DominationMode({ blue: { troops: 4 }, red: { troops: 4 } });
const game = new Game(loadLevel(TEXT), mode);

// site center -> name
const SITES: [string, number, number, number][] = [
  ["A", -650, 0, 0],
  ["B", 0, 0, 1],
  ["C", 660, 0, 0],
];
const siteName = (c: { pos: { x: number }; z: number } | null): string => {
  if (!c) return "-";
  for (const [n, x, , z] of SITES) if (c.z === z && Math.abs(c.pos.x - x) < 1) return n;
  return "?";
};
// physical zone on the map
const zone = (x: number, z: number): string => {
  if (z === 1) return "Bflr"; // up on B's level
  if (x <= -340) return "Arm "; // A room
  if (x >= 340) return "Crm "; // C room
  return "MID "; // central room / stairs approach
};

const objs = () => mode.objectives(game as never);
const TICKS = 6000;
let firstBluePickB = -1;

// Follow ONE blue bot closely through the A-locked -> retarget window to see if
// its pick oscillates at the B/C boundary and where it physically sits.
const trackId = () => game.characters.find((c) => c instanceof DominationOracle && c.team === "blue" && c.hp > 0);

for (let t = 0; t < TICKS; t++) {
  game.update();
  if (t >= 2200 && t <= 3600 && t % 60 === 0) {
    const b = trackId();
    if (b) {
      const pick = siteName((b as unknown as { siteChoice: { pos: { x: number }; z: number } | null }).siteChoice);
      console.log(`   [trace t=${t}] blue bot: pick=${pick} zone=${zone(b.pos.x, b.z)} x=${b.pos.x.toFixed(0)} z=${b.z}`);
    }
  }
  if (t % 500 === 0 || t === TICKS - 1) {
    const rows: Record<string, { pick: Record<string, number>; zn: Record<string, number> }> = {
      blue: { pick: {}, zn: {} },
      red: { pick: {}, zn: {} },
    };
    let bStuck = 0; // bots that PICKED B but are stuck at z=0 in MID
    for (const c of game.characters) {
      if (!(c instanceof DominationOracle) || c.hp <= 0) continue;
      const pick = siteName((c as unknown as { siteChoice: { pos: { x: number }; z: number } | null }).siteChoice);
      const zn = zone(c.pos.x, c.z);
      const r = rows[c.team];
      if (!r) continue;
      r.pick[pick] = (r.pick[pick] ?? 0) + 1;
      r.zn[zn] = (r.zn[zn] ?? 0) + 1;
      if (c.team === "blue" && pick === "B" && c.z === 0 && zone(c.pos.x, c.z) === "MID ") bStuck++;
      if (c.team === "blue" && pick === "B" && firstBluePickB < 0) firstBluePickB = t;
    }
    const fmt = (m: Record<string, number>) =>
      ["A", "B", "C", "-", "?"].filter((k) => m[k]).map((k) => `${k}${m[k]}`).join(" ") || "·";
    const own = objs().map((o, i) => `${SITES[i][0]}:${o.owner[0]}${o.progress.toFixed(1)}`).join(" ");
    console.log(
      `t=${String(t).padStart(4)} | ${own} | ` +
        `BLUE pick[${fmt(rows.blue.pick)}] at[${Object.entries(rows.blue.zn).map(([k, v]) => k + v).join(" ")}] ` +
        `| RED pick[${fmt(rows.red.pick)}]`,
    );
  }
}
console.log(`\nfirst tick a blue bot picked B: ${firstBluePickB}`);
