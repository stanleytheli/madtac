/**
 * The bottom-left minimap: a simplified, static top-down of the level — every
 * floor, stair, and obstacle as a flat filled rect (no borders), in the world's
 * painter order (z ascending; floors under stairs under obstacles within a
 * level) but ignoring hide-when-in, so the whole map always shows — with a live
 * overlay of friendly positions (dots) and recent friendly deaths (X's). Enemy
 * positions are never shown.
 *
 * The obstacle geometry is baked once at construction (the world's static), so
 * per-frame cost is just the fills + a handful of markers. Drawn in the HUD's
 * logical (pre-UI_SCALE) space, like the rest of the HUD.
 */
import type { Character } from "../entities/actor.ts";
import { rectCorners, type Poly } from "../engine/poly.ts";
import { areHostile, TEAMS } from "../entities/team.ts";
import { vec, type Vec2 } from "../engine/vec.ts";
import type { World } from "../world/world.ts";
import type { DomPointView } from "../gamemodes/gamemode.ts";

/** Neutral (unowned) domination-point color, shared by the minimap + in-world. */
export const DOM_GRAY = "#9aa0a6";

/** A darker shade of a "#rrggbb" color — the "owned & strengthening" arc. */
export function domDarken(hex: string): string {
  const h = hex.replace("#", "");
  const ch = (i: number) =>
    Math.round(parseInt(h.slice(i, i + 2), 16) * 0.5)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/**
 * How to render a capture point from its owner + strength (see gamemodes/
 * domination.ts). Two regimes:
 *  - Owned by team T: ring & letter in T's color; a growing DARK-T arc = the
 *    strength [0,1] (just-taken shows no arc; fully locked-in fills the ring).
 *  - Gray (neutral): ring & letter gray; if a team is currently capturing, a
 *    growing REGULAR arc in that team's color = 1 - strength (progress toward
 *    taking it, so the flip-in reads before the color changes).
 */
export function domPointStyle(view: DomPointView): {
  ring: string;
  letter: string;
  arc: { color: string; frac: number } | null;
} {
  if (view.owner !== "gray") {
    const col = TEAMS[view.owner]?.color ?? DOM_GRAY;
    return { ring: col, letter: col, arc: { color: domDarken(col), frac: view.strength } };
  }
  const capCol = view.capturing ? (TEAMS[view.capturing]?.color ?? null) : null;
  return { ring: DOM_GRAY, letter: DOM_GRAY, arc: capCol ? { color: capCol, frac: 1 - view.strength } : null };
}

/** Ticks a recent-death X lingers on the minimap before it's pruned/faded. */
export const MINIMAP_DEATH_TTL = 600; // ~10s

/** Default on-screen side of the widget (logical HUD px) when the level doesn't
 *  set one. */
const DEFAULT_PX = 190;
/** Auto-fit padding: the covered region is this × the map's bounding extent. */
const AUTO_PAD = 1.12;
const RADIUS = 8; // widget corner rounding
const DOT_R = 2.6; // ally / player dot radius
const X_R = 3; // death-X arm length

/** A recent friendly death to mark. `age` ticks up; the mark fades then is
 *  pruned past MINIMAP_DEATH_TTL (owned/aged by the Game). */
export interface DeathMark {
  pos: Vec2;
  z: number;
  age: number;
}

export class Minimap {
  /** Baked floor/stair/obstacle fills, in painter order (z ascending, then
   *  floor→stair→obstacle within a level). */
  private readonly polys: { corners: Poly; fill: string }[] = [];
  /** World point the widget centre maps to, and the world side it spans. */
  private readonly center: Vec2;
  private readonly worldSize: number;
  /** On-screen widget side (logical HUD px). */
  readonly px: number;

  constructor(world: World, sizeOverride?: number, px = DEFAULT_PX) {
    this.px = px;

    // Collect every drawable surface + obstacle as a flat rect, tagged with its
    // painter key: (z, category) where category orders floor < stair < obstacle,
    // matching the world's per-level draw order (floors and stairs under the
    // objects on top). Skip infinite floors (they're the global backdrop, not a
    // map feature) and anything flagged invisible. Hide-when-in is ignored — the
    // whole map always shows on the minimap.
    type Part = { z: number; cat: number; corners: Poly; fill: string };
    const parts: Part[] = [];
    for (const f of world.floors) {
      if (f.infinite || f.invisible) continue;
      parts.push({ z: f.level, cat: 0, corners: rectCorners(f.pos, f.w, f.h, f.angle), fill: f.color });
    }
    for (const s of world.stairs) {
      parts.push({
        z: Math.min(s.zAtMin, s.zAtMax),
        cat: 1,
        corners: rectCorners(s.pos, s.w, s.h, s.angle),
        fill: s.color,
      });
    }
    for (const o of world.obstacles) {
      if (o.invisible) continue;
      parts.push({ z: o.z, cat: 2, corners: rectCorners(o.pos, o.w, o.h, o.angle), fill: o.fill });
    }

    // Cover the level's bounds: AABB over everything we'll draw.
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of parts) {
      for (const c of p.corners) {
        if (c.x < minx) minx = c.x;
        if (c.x > maxx) maxx = c.x;
        if (c.y < miny) miny = c.y;
        if (c.y > maxy) maxy = c.y;
      }
    }
    if (!Number.isFinite(minx)) {
      minx = miny = -500; // empty map: some sane default region
      maxx = maxy = 500;
    }
    this.center = vec((minx + maxx) / 2, (miny + maxy) / 2);
    const extent = Math.max(maxx - minx, maxy - miny, 1);
    this.worldSize = sizeOverride && sizeOverride > 0 ? sizeOverride : extent * AUTO_PAD;

    // Painter order: z ascending, then floor/stair/obstacle. A stable sort keeps
    // authoring/depth order within a (z, category) bucket.
    parts.sort((a, b) => a.z - b.z || a.cat - b.cat);
    for (const p of parts) this.polys.push({ corners: p.corners, fill: p.fill });
  }

  /** World -> widget-local pixel (relative to the widget's top-left at x0,y0). */
  private toWidget(w: Vec2, x0: number, y0: number): Vec2 {
    const s = this.px / this.worldSize;
    return vec(x0 + this.px / 2 + (w.x - this.center.x) * s, y0 + this.px / 2 + (w.y - this.center.y) * s);
  }

  /**
   * Draw the widget with its top-left at (x0, y0). `chars` is the live roster;
   * friendlies (non-hostile to the player) show as dots, the player as a distinct
   * marker, enemies not at all. `deaths` are recent friendly death marks.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    chars: readonly Character[],
    deaths: readonly DeathMark[],
    player: Character,
    points: readonly DomPointView[] = [],
  ): void {
    const px = this.px;
    const friendly = TEAMS[player.team]?.color ?? "#4a9de0";

    ctx.save();
    // Backdrop + clip so nothing spills past the rounded frame.
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(x0, y0, px, px, RADIUS);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0, y0, px, px, RADIUS);
    ctx.clip();

    // Static geometry: flat fills, no borders, in render order.
    for (const p of this.polys) {
      const c0 = this.toWidget(p.corners[0], x0, y0);
      ctx.fillStyle = p.fill;
      ctx.beginPath();
      ctx.moveTo(c0.x, c0.y);
      for (let i = 1; i < p.corners.length; i++) {
        const c = this.toWidget(p.corners[i], x0, y0);
        ctx.lineTo(c.x, c.y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Domination points: the name on a control-colored highlight (blue/red/gray).
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 10px system-ui, sans-serif";
    for (const pt of points) {
      const p = this.toWidget(pt.pos, x0, y0);
      const tw = ctx.measureText(pt.name).width;
      const w = tw + 7;
      const h = 13;
      ctx.fillStyle = domPointStyle(pt).ring;
      ctx.beginPath();
      ctx.roundRect(p.x - w / 2, p.y - h / 2, w, h, 3);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(pt.name, p.x, p.y + 0.5);
    }

    // Recent friendly deaths: X's, fading over their last quarter of life.
    ctx.strokeStyle = friendly;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    for (const d of deaths) {
      const p = this.toWidget(d.pos, x0, y0);
      ctx.globalAlpha = Math.max(0, Math.min(1, ((MINIMAP_DEATH_TTL - d.age) / (MINIMAP_DEATH_TTL * 0.25))));
      ctx.beginPath();
      ctx.moveTo(p.x - X_R, p.y - X_R);
      ctx.lineTo(p.x + X_R, p.y + X_R);
      ctx.moveTo(p.x + X_R, p.y - X_R);
      ctx.lineTo(p.x - X_R, p.y + X_R);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Friendly dots (never enemies).
    ctx.fillStyle = friendly;
    for (const c of chars) {
      if (c.hp <= 0 || c === player || areHostile(player.team, c.team)) continue;
      const p = this.toWidget(c.pos, x0, y0);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
      ctx.fill();
    }

    // The player: a brighter, outlined dot so you can pick yourself out.
    if (player.hp > 0) {
      const p = this.toWidget(player.pos, x0, y0);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = friendly;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_R + 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore(); // clip
    // Frame.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x0, y0, px, px, RADIUS);
    ctx.stroke();
    ctx.restore();
  }
}
