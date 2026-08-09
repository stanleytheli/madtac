import { readFileSync, writeFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { DominationMode } from "../src/gamemodes/domination.ts";
const TEXT = readFileSync("src/world/levels/house-sidesites-3.json", "utf8");
const g = new Game(loadLevel(TEXT), new DominationMode({ blue: { troops: 1 }, red: { troops: 1 } }));
const nav: any = (g as any).nav, world: any = (g as any).world;
const V = (x: number, y: number) => ({ x, y });
const from = nav.nearestWalkable(world, V(-1200, 0), 0);
const toA = nav.nearestWalkable(world, V(0, -960), 0);
const mid = nav.routePath(from, toA, null).nodes;
for (let i = 0; i < 30; i++) nav.setRoute({ i }, mid, "blue"); // simulate crowd on mid
const out = nav.routePath(from, toA, "blue").nodes;
const geo = (ns: number[]) => { let s = 0; for (let i = 0; i + 1 < ns.length; i++) { const a = nav.nodes[ns[i]].pos, b = nav.nodes[ns[i + 1]].pos; s += Math.hypot(a.x - b.x, a.y - b.y); } return s; };
const poly = (ns: number[]) => ns.map((n: number) => `${nav.nodes[n].pos.x},${nav.nodes[n].pos.y}`).join(" ");
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1320 -1300 2640 2600" font-family="sans-serif">`;
s += `<rect x="-1320" y="-1300" width="2640" height="2600" fill="#6a9a5e"/>`;
for (const o of world.obstacles) {
  const op = o.z === 1 ? 0.35 : 1;
  if (o.round) s += `<circle cx="${o.pos.x}" cy="${o.pos.y}" r="${o.w / 2}" fill="${o.fill}" stroke="${o.stroke}" stroke-width="${o.strokeWidth}" opacity="${op}"/>`;
  else s += `<rect x="${o.pos.x - o.w / 2}" y="${o.pos.y - o.h / 2}" width="${o.w}" height="${o.h}" fill="${o.fill}" stroke="${o.stroke}" stroke-width="${o.strokeWidth}" opacity="${op}"/>`;
}
for (const n of nav.nodes) if ((n.z || 0) === 0) s += `<circle cx="${n.pos.x}" cy="${n.pos.y}" r="9" fill="#2a2a2a" opacity="0.4"/>`;
s += `<polyline points="${poly(mid)}" fill="none" stroke="#e02020" stroke-width="22" opacity="0.9"/>`;
s += `<polyline points="${poly(out)}" fill="none" stroke="#2050e0" stroke-width="22" stroke-dasharray="40 25" opacity="0.9"/>`;
s += `<circle cx="-1200" cy="0" r="45" fill="#20c040" stroke="#000" stroke-width="4"/><text x="-1200" y="90" font-size="70" text-anchor="middle">spawn</text>`;
s += `<circle cx="0" cy="-960" r="45" fill="#f0a020" stroke="#000" stroke-width="4"/><text x="0" y="-1030" font-size="70" text-anchor="middle" fill="#fff">A</text>`;
s += `<text x="-1300" y="1230" font-size="60" fill="#e02020">MID (plain ${geo(mid).toFixed(0)})</text><text x="-1300" y="1290" font-size="60" fill="#2050e0">diverted (${geo(out).toFixed(0)})</text>`;
s += `</svg>`;
writeFileSync("/tmp/rv.svg", s);
console.log("mid geo", geo(mid).toFixed(0), "out geo", geo(out).toFixed(0), "mid xs", mid.map((n:number)=>nav.nodes[n].pos.x.toFixed(0)+","+nav.nodes[n].pos.y.toFixed(0)).join(" "));
console.log("out pts", out.map((n:number)=>nav.nodes[n].pos.x.toFixed(0)+","+nav.nodes[n].pos.y.toFixed(0)).join(" "));
