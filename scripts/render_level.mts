/**
 * Top-down level previewer. Reads a level JSON (the editor's save format) and
 * emits one SVG panel per z-level so you can eyeball a map's geometry without
 * booting the game — floors, walls/crates/fences/barrels, stairs, spawn zones,
 * spawns, and domination points, each drawn roughly as the game draws it.
 *
 *   npx tsx scripts/render_level.mts src/world/levels/house.json out.svg
 *
 * Convert to a PNG with `qlmanage -t -s 1600 -o <dir> out.svg` (macOS) if you
 * want a raster to look at. Purely a dev/authoring aid — not shipped or imported.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Ent { kind: string; x: number; y: number; w?: number; h?: number; angle?: number; z?: number; level?: number; [k: string]: any; }

const [, , inPath, outPath = "level.svg", onlyZ] = process.argv; // onlyZ: render just that level
if (!inPath) { console.error("usage: render_level.mts <level.json> [out.svg]"); process.exit(1); }

const doc = JSON.parse(readFileSync(inPath, "utf8")) as { entities: Ent[] };
const ents = doc.entities;

const TEAM_COLOR: Record<string, string> = { blue: "#4a9de0", red: "#c94f4f", enemy: "#c94f4f", ally: "#3dba6f", player: "#ffd94a" };

// --- bounds over everything with a footprint (skip the infinite background) ---
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const e of ents) {
  if (e.kind === "floor" && e.infinite) continue;
  const hw = (e.w ?? 0) / 2, hh = (e.h ?? 0) / 2;
  const r = Math.max(hw, hh) || 40; // points get a small halo
  minX = Math.min(minX, e.x - r); maxX = Math.max(maxX, e.x + r);
  minY = Math.min(minY, e.y - r); maxY = Math.max(maxY, e.y + r);
}
const pad = 120;
minX -= pad; minY -= pad; maxX += pad; maxY += pad;
const W = maxX - minX, H = maxY - minY;

// z-levels present, ascending.
let zs = [...new Set(ents.map((e) => (e.kind === "floor" ? e.level : e.z) ?? 0))].sort((a, b) => a - b);
if (onlyZ !== undefined) zs = zs.filter((z) => z === Number(onlyZ));
const bg = ents.find((e) => e.kind === "floor" && e.infinite);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// A rect in world space -> an SVG group honoring center + rotation (deg).
function rect(e: Ent, attrs: string, extra = ""): string {
  const w = e.w ?? 0, h = e.h ?? 0;
  const t = e.angle ? ` transform="rotate(${e.angle} ${e.x} ${e.y})"` : "";
  return `<g${t}><rect x="${e.x - w / 2}" y="${e.y - h / 2}" width="${w}" height="${h}" ${attrs}/>${extra}</g>`;
}

function panel(z: number): string {
  const parts: string[] = [];
  // Background: the infinite floor's color, else dark.
  parts.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="${bg?.color ?? "#2b2b2b"}"/>`);

  // Floors at this level (painter's order = array order).
  for (const e of ents) {
    if (e.kind !== "floor" || e.infinite || (e.level ?? 0) !== z) continue;
    const op = e.hideWhenUnder || e.hideWhenIn ? 0.55 : 1; // roofs drawn translucent
    parts.push(rect(e, `fill="${e.color}" opacity="${op}"`));
  }
  // Stairs touching this level.
  for (const e of ents) {
    if (e.kind !== "stairs") continue;
    if (e.zAtMin !== z && e.zAtMax !== z) continue;
    parts.push(rect(e, `fill="${e.color ?? "#7c6034"}" stroke="#222" stroke-width="3"`));
  }
  // Obstacles at this level.
  for (const e of ents) {
    const oz = e.z ?? 0;
    if (oz !== z) continue;
    if (e.kind === "wall") parts.push(rect(e, `fill="${e.fill ?? "#6b7076"}" stroke="${e.stroke ?? "#3a3d40"}" stroke-width="${e.strokeWidth ?? 6}"`));
    else if (e.kind === "fence") parts.push(rect(e, `fill="${e.fill ?? "#a9946e"}" stroke="${e.stroke ?? "#615139"}" stroke-width="${e.strokeWidth ?? 5}" opacity="0.85"`));
    else if (e.kind === "crate") {
      const w = e.w ?? 64, h = e.h ?? 64;
      const x0 = e.x - w / 2, y0 = e.y - h / 2;
      const x = `<path d="M${x0} ${y0} L${x0 + w} ${y0 + h} M${x0 + w} ${y0} L${x0} ${y0 + h}" stroke="${e.stroke ?? "#412b04"}" stroke-width="4" fill="none"/>`;
      parts.push(rect(e, `fill="${e.fill ?? "#92632d"}" stroke="${e.stroke ?? "#412b04"}" stroke-width="${e.strokeWidth ?? 9}"`, x));
    } else if (e.kind === "circle" || e.kind === "barrel_metal" || e.kind === "barrel_wood") {
      const r = (e.w ?? 64) / 2;
      parts.push(`<circle cx="${e.x}" cy="${e.y}" r="${r}" fill="${e.fill ?? "#8a929b"}" stroke="${e.stroke ?? "#3f474d"}" stroke-width="${e.strokeWidth ?? 5}"/>`);
    }
  }
  // Spawn zones at this level.
  for (const e of ents) {
    if (e.kind !== "spawnzone" || (e.z ?? 0) !== z) continue;
    const c = TEAM_COLOR[e.team ?? "blue"] ?? "#888";
    parts.push(rect(e, `fill="${c}" opacity="0.16" stroke="${c}" stroke-width="4" stroke-dasharray="18 12"`));
  }
  // Domination points at this level.
  for (const e of ents) {
    if (e.kind !== "dompoint" || (e.z ?? 0) !== z) continue;
    const r = e.radius ?? 150;
    parts.push(`<circle cx="${e.x}" cy="${e.y}" r="${r}" fill="#d8d8d8" opacity="0.18" stroke="#f5f5f5" stroke-width="5" stroke-dasharray="14 10"/>`);
    parts.push(`<text x="${e.x}" y="${e.y + 26}" font-size="72" font-family="sans-serif" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(e.name ?? "?")}</text>`);
  }
  // Spawns at this level.
  for (const e of ents) {
    const sz = e.z ?? 0;
    if (sz !== z) continue;
    if (e.kind === "spawn") parts.push(`<circle cx="${e.x}" cy="${e.y}" r="22" fill="#ffd94a" stroke="#000" stroke-width="3"/>`);
    else if (e.kind === "enemy") parts.push(`<circle cx="${e.x}" cy="${e.y}" r="18" fill="${TEAM_COLOR[e.team ?? "enemy"] ?? "#c94f4f"}" stroke="#000" stroke-width="3"/>`);
    else if (e.kind === "node") parts.push(`<circle cx="${e.x}" cy="${e.y}" r="7" fill="#35d0c5" opacity="0.7"/>`);
    else if (e.kind === "gun") parts.push(`<rect x="${e.x - 12}" y="${e.y - 12}" width="24" height="24" fill="#e0c24a" stroke="#000" stroke-width="2"/>`);
    else if (e.kind === "armor") parts.push(`<rect x="${e.x - 12}" y="${e.y - 12}" width="24" height="24" fill="#5aa0e0" stroke="#000" stroke-width="2"/>`);
  }
  const title = `<text x="${minX + 24}" y="${minY + 70}" font-size="60" font-family="sans-serif" font-weight="700" fill="#fff" stroke="#000" stroke-width="2">z = ${z}</text>`;
  return `<g>${parts.join("")}${title}</g>`;
}

// Lay panels out in a column (one row per z-level), top = highest z.
const gap = 60;
const ordered = [...zs].reverse();
const svgH = ordered.length * H + (ordered.length - 1) * gap;
const inner = ordered.map((z, i) => `<g transform="translate(${-minX} ${i * (H + gap) - minY})">${panel(z)}</g>`).join("");
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W / 2)}" height="${Math.round(svgH / 2)}" viewBox="0 0 ${W} ${svgH}">` +
  `<rect width="${W}" height="${svgH}" fill="#111"/>${inner}</svg>`;
writeFileSync(outPath, svg);
console.log(`wrote ${outPath}  (${zs.length} level(s): ${zs.join(", ")}; bounds ${Math.round(W)}x${Math.round(H)})`);
