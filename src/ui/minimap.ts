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
import { BODY_RADIUS } from "../entities/character.ts";
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
 * How to render a capture point from its (team, progress ∈ [0,2]) — see
 * gamemodes/domination.ts. Two regimes:
 *  - progress ≥ 1 (owned): ring & letter in the team's color; a growing DARK arc
 *    = progress − 1 (just-taken shows no arc; fully locked-in fills the ring).
 *  - progress < 1 (gray): ring & letter gray; if being captured (progress > 0), a
 *    growing REGULAR arc in the capturing team's color = progress, so the claim
 *    reads before the point flips color.
 */
export function domPointStyle(view: DomPointView): {
  ring: string;
  letter: string;
  arc: { color: string; frac: number } | null;
} {
  const col = TEAMS[view.team]?.color ?? DOM_GRAY;
  if (view.progress >= 1) {
    return { ring: col, letter: col, arc: { color: domDarken(col), frac: Math.min(1, view.progress - 1) } };
  }
  return { ring: DOM_GRAY, letter: DOM_GRAY, arc: view.progress > 0 ? { color: col, frac: view.progress } : null };
}

/** Ticks a recent-death X lingers on the minimap before it's pruned/faded. */
export const MINIMAP_DEATH_TTL = 600; // ~10s

/** Default on-screen side of the widget (logical HUD px) when the level doesn't
 *  set one. */
const DEFAULT_PX = 190;
/** Auto-fit padding: the covered region is this × the map's bounding extent. */
const AUTO_PAD = 1.12;
const RADIUS = 0; // widget corner rounding
/** Backdrop when a level has no ground floor to take a color from. */
const NO_GROUND = "rgb(0, 0, 0)";
/** Clamps on the person-markers, which are otherwise drawn at the body's true
 *  size for the map's scale (see markerR): a sprawling level would shrink them to
 *  nothing, a cramped one would blob them over the whole widget. */
const MIN_MARKER_R = 2;
const MAX_MARKER_R = 6;

/** A recent friendly death to mark. `age` ticks up; the mark fades then is
 *  pruned past MINIMAP_DEATH_TTL (owned/aged by the Game). */
export interface DeathMark {
  pos: Vec2;
  z: number;
  age: number;
}

/** One baked piece of static map geometry. Round obstacles keep their circular
 *  footprint rather than being squared off into their bounding box — they collide
 *  as circles in-world, so they should read as circles here too. */
type MapShape =
  | { kind: "poly"; corners: Poly; fill: string }
  | { kind: "circle"; pos: Vec2; r: number; fill: string };

/** Every world point a shape touches, for the map-bounds fit. */
function shapeBounds(s: MapShape): Vec2[] {
  if (s.kind === "poly") return s.corners;
  return [vec(s.pos.x - s.r, s.pos.y - s.r), vec(s.pos.x + s.r, s.pos.y + s.r)];
}

export class Minimap {
  /** Baked floor/stair/obstacle fills, in painter order (z ascending, then
   *  floor→stair→obstacle within a level). */
  private readonly shapes: MapShape[] = [];
  /** World point the widget centre maps to, and the world side it spans. */
  private readonly center: Vec2;
  private readonly worldSize: number;
  /** The level's ground color, so the widget's empty space matches what the
   *  ground actually looks like out there instead of reading as a void. */
  private readonly ground: string;
  /** On-screen widget side (logical HUD px). */
  readonly px: number;

  constructor(world: World, sizeOverride?: number, px = DEFAULT_PX) {
    this.px = px;

    // The ground is the infinite floor the renderer paints as the screen
    // background (see main.ts) — minus the visibility test, since the minimap
    // always shows the whole map regardless of where the player is standing.
    this.ground = world.floors.find((f) => f.infinite && !f.invisible)?.color ?? NO_GROUND;

    // Collect every drawable surface + obstacle as a flat rect, tagged with its
    // painter key: (z, category) where category orders floor < stair < obstacle,
    // matching the world's per-level draw order (floors and stairs under the
    // objects on top). Skip infinite floors (they're the global backdrop, not a
    // map feature) and anything flagged invisible. Hide-when-in is ignored — the
    // whole map always shows on the minimap.
    type Part = { z: number; cat: number; shape: MapShape };
    const parts: Part[] = [];
    for (const f of world.floors) {
      if (f.infinite || f.invisible) continue;
      const shape: MapShape = { kind: "poly", corners: rectCorners(f.pos, f.w, f.h, f.angle), fill: f.color };
      parts.push({ z: f.level, cat: 0, shape });
    }
    for (const s of world.stairs) {
      const shape: MapShape = { kind: "poly", corners: rectCorners(s.pos, s.w, s.h, s.angle), fill: s.color };
      parts.push({ z: Math.min(s.zAtMin, s.zAtMax), cat: 1, shape });
    }
    for (const o of world.obstacles) {
      if (o.invisible) continue;
      // Radius matches the in-world circle collider: half the smaller extent.
      const shape: MapShape = o.round
        ? { kind: "circle", pos: o.pos, r: Math.min(o.w, o.h) / 2, fill: o.fill }
        : { kind: "poly", corners: rectCorners(o.pos, o.w, o.h, o.angle), fill: o.fill };
      parts.push({ z: o.z, cat: 2, shape });
    }

    // Cover the level's bounds: AABB over everything we'll draw.
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of parts) {
      for (const c of shapeBounds(p.shape)) {
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
    for (const p of parts) this.shapes.push(p.shape);
  }

  /** Widget px per world px. */
  private get scale(): number {
    return this.px / this.worldSize;
  }

  /** Radius for a person-marker: the body's true footprint at this map's scale,
   *  so a dot covers about as much ground as the soldier really does — clamped at
   *  both ends so it stays legible whatever the level's size. */
  private get markerR(): number {
    return Math.max(MIN_MARKER_R, Math.min(MAX_MARKER_R, BODY_RADIUS * this.scale));
  }

  /** World -> widget-local pixel (relative to the widget's top-left at x0,y0). */
  private toWidget(w: Vec2, x0: number, y0: number): Vec2 {
    const s = this.scale;
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
    const markerR = this.markerR;

    ctx.save();
    // Backdrop + clip so nothing spills past the rounded frame. The backdrop is
    // the level's own ground color, so bare map reads as ground rather than void.
    ctx.fillStyle = this.ground;
    ctx.beginPath();
    ctx.roundRect(x0, y0, px, px, RADIUS);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0, y0, px, px, RADIUS);
    ctx.clip();

    // Static geometry: flat fills, no borders, in render order.
    const scale = this.scale;
    for (const s of this.shapes) {
      ctx.fillStyle = s.fill;
      ctx.beginPath();
      if (s.kind === "circle") {
        const c = this.toWidget(s.pos, x0, y0);
        ctx.arc(c.x, c.y, s.r * scale, 0, Math.PI * 2);
      } else {
        const c0 = this.toWidget(s.corners[0], x0, y0);
        ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i < s.corners.length; i++) {
          const c = this.toWidget(s.corners[i], x0, y0);
          ctx.lineTo(c.x, c.y);
        }
        ctx.closePath();
      }
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

    // Recent friendly deaths: X's, fading over their last quarter of life. Sized
    // off the same marker radius, so a death and a live ally read as the same
    // "one person" scale on any map.
    const xr = markerR * 1.15;
    ctx.strokeStyle = friendly;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    for (const d of deaths) {
      const p = this.toWidget(d.pos, x0, y0);
      ctx.globalAlpha = Math.max(0, Math.min(1, ((MINIMAP_DEATH_TTL - d.age) / (MINIMAP_DEATH_TTL * 0.25))));
      ctx.beginPath();
      ctx.moveTo(p.x - xr, p.y - xr);
      ctx.lineTo(p.x + xr, p.y + xr);
      ctx.moveTo(p.x + xr, p.y - xr);
      ctx.lineTo(p.x - xr, p.y + xr);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Friendly dots (never enemies).
    ctx.fillStyle = friendly;
    for (const c of chars) {
      if (c.hp <= 0 || c === player || areHostile(player.team, c.team)) continue;
      const p = this.toWidget(c.pos, x0, y0);
      ctx.beginPath();
      ctx.arc(p.x, p.y, markerR, 0, Math.PI * 2);
      ctx.fill();
    }

    // The player: a brighter, outlined dot so you can pick yourself out.
    if (player.hp > 0) {
      const p = this.toWidget(player.pos, x0, y0);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = friendly;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, markerR + 0.6, 0, Math.PI * 2);
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
