/**
 * The in-game level editor (?edit=true). The game still simulates nothing while
 * it's up — main.ts routes update/render through here instead — but the world
 * renders through the normal pipeline, so what you see is what plays.
 *
 * Everything placeable comes from ENTITY_DEFS (level.ts): the palette, the
 * property inspector, hit-testing, and (de)serialization are all generic over
 * the registry, so new guns/armors/enemies/kinds appear here with no editor
 * changes. This file only knows about "rect entities" and "point entities".
 *
 * Controls: WASD fly (shift = fast) · wheel zoom · [ / ] change z · click
 * select · drag move · corner/edge handles resize · Del delete · Esc / right
 * click cancel tool & deselect · G toggle snap.
 */
import type { Character } from "../entities/actor.ts";
import { BODY_RADIUS } from "../entities/character.ts";
import { borderFit, pointInBox } from "../engine/collision.ts";
import { GAMEMODES } from "../gamemodes/gamemode.ts";
import { DEFAULT_TDM } from "../gamemodes/tdm.ts";
import { DEFAULT_DOM } from "../gamemodes/domination.ts";
import { EQUIP_NAMES } from "../gamemodes/teammatch.ts";
import { isDown, mouse, moveAxis } from "../engine/input.ts";
import {
  ENTITY_DEFS,
  applyLevel,
  entityFromJSON,
  entityToJSON,
  serializeLevel,
  type DomConfig,
  type EntityDef,
  type FieldDef,
  type LevelState,
  type TdmConfig,
  type TeamConfig,
} from "../world/level.ts";
import { LEVELS } from "../world/levels.ts";
import { TEAMS } from "../entities/team.ts";
import { DOM_GRAY } from "./minimap.ts";
import { MOVE_RADIUS, nodeEdge } from "../world/nav.ts";
import { add, angleOf, deg2rad, dist, norm, rad2deg, rotate, scale, sub, vec, type Vec2 } from "../engine/vec.ts";
import {
  makeFloor,
  sortRenderDepth,
  updateSurfaceAlphas,
  zsetHas,
  type Floor,
  type PathNode,
  type Region,
} from "../world/world.ts";

const POINT_R = 45; // selection radius around point entities (items, spawns)
const MIN_SIZE = 8; // smallest rect a drag-draw or resize can produce
const SEL_COLOR = "#3ddcff";
const ROT_HANDLE_OFF = 26; // rotate-knob distance past the top edge, screen px
const ROT_SNAP = Math.PI / 12; // rotate-drag snap step (15°) while snap is on

/** A fresh TDM config for when a level first switches to Team Deathmatch in the
 *  editor — a deep clone of the gamemode's own defaults (never share the object). */
const defaultTdm = (): TdmConfig => ({
  ...DEFAULT_TDM,
  blue: { ...DEFAULT_TDM.blue },
  red: { ...DEFAULT_TDM.red },
});

/** A fresh Domination config for when a level first switches to Domination in the
 *  editor — a deep clone of the gamemode's own defaults (never share the object). */
const defaultDom = (): DomConfig => ({
  ...DEFAULT_DOM,
  blue: { ...DEFAULT_DOM.blue },
  red: { ...DEFAULT_DOM.red },
});

type Drag =
  | { mode: "draw"; start: Vec2; cur: Vec2 }
  | { mode: "move"; grab: Vec2 } // entity pos minus mouse, at grab time
  | { mode: "resize"; ex: -1 | 0 | 1; ey: -1 | 0 | 1 } // which edges follow
  | { mode: "rotate" }; // dragging the lollipop knob

/** World point -> a rect entity's local (unrotated) frame about its center. */
const toLocal = (p: Vec2, e: { pos: Vec2; angle?: number }): Vec2 =>
  e.angle ? add(e.pos, rotate(sub(p, e.pos), -e.angle)) : p;

interface Selection {
  def: EntityDef;
  e: any;
}

export class Editor {
  /** Camera scale (world px per screen px); main.ts reads this instead of the gun zoom. */
  zoom = 2.2;

  /** Set by main.ts: start a playtest of the level as it stands. Wired to the
   *  Play button; if unset the button does nothing. */
  onPlaytest?: () => void;

  /** While suspended the editor ignores every input and hides its panel — main
   *  has swapped a live playtest onto the same canvas. Toggled by setSuspended. */
  private suspended = false;

  private readonly state: LevelState;
  private readonly player: Character;

  private snapOn = true;
  private gridSize = 20;
  /** Draw/select nav nodes. Off declutters map editing; the node tool being
   *  armed always counts as on (placing invisible nodes helps no one). */
  private showNodes = true;
  private tool: EntityDef | null = null; // null = select/move mode
  private sel: Selection | null = null;
  private drag: Drag | null = null;
  /** The floor whose hideWhenIn region is currently selected (regions are
   *  sub-entities: they live inside a floor, not in any world array). */
  private regionFloor: Floor | null = null;
  /** Ctrl+C stores the selection as its JSON record; Ctrl+V rebuilds from it. */
  private clipboard: { def: EntityDef; json: Record<string, unknown> } | null = null;
  private prevZUp = false;
  private prevZDown = false;

  // DOM
  private panel!: HTMLElement;
  private status!: HTMLElement;
  private inspector!: HTMLElement;
  private matchFields!: HTMLElement;
  private ta!: HTMLTextAreaElement;
  private snapBox!: HTMLInputElement;
  private nodesBox!: HTMLInputElement;
  private nameIn!: HTMLInputElement;
  private readonly toolButtons = new Map<string | null, HTMLButtonElement>();
  /** Inspector geometry inputs, refreshed live while dragging. */
  private geomRefs: { input: HTMLInputElement; get: () => number }[] = [];

  constructor(state: LevelState, player: Character, canvas: HTMLCanvasElement) {
    this.state = state;
    this.player = player;
    this.buildPanel();

    // Every listener short-circuits while suspended, so a live playtest owns the
    // canvas + keyboard without the editor stealing clicks or shortcuts.
    canvas.addEventListener("mousedown", (e) => {
      if (this.suspended) return;
      if (e.button === 0) this.onDown();
      else if (e.button === 2) this.cancel(); // right click: drop tool + selection
    });
    window.addEventListener("mousemove", () => {
      if (!this.suspended) this.onMove();
    });
    window.addEventListener("mouseup", (e) => {
      if (this.suspended) return;
      if (e.button === 0) this.onUp();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.suspended) return;
        e.preventDefault();
        this.zoom = Math.min(14, Math.max(0.4, this.zoom * Math.exp(e.deltaY * 0.0012)));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if (!this.suspended) this.onKey(e);
    });
  }

  // --- per-tick (called from main's update in edit mode) ----------------------

  update(): void {
    // Fly (noclip): direct position control, scaled so it feels the same at any zoom.
    const axis = moveAxis();
    if (axis.x !== 0 || axis.y !== 0) {
      const sp = ((isDown("ShiftLeft") || isDown("ShiftRight")) ? 26 : 11) * this.zoom;
      this.player.pos = add(this.player.pos, scale(norm(axis), sp));
    }

    // z level: [ down, ] up (edge-triggered so one press = one level).
    const up = isDown("BracketRight");
    const down = isDown("BracketLeft");
    if (up && !this.prevZUp) this.setZ(this.player.z + 1);
    if (down && !this.prevZDown) this.setZ(this.player.z - 1);
    this.prevZUp = up;
    this.prevZDown = down;

    updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos);
    this.status.textContent =
      `z ${this.player.z}   zoom ${this.zoom.toFixed(2)}   ` +
      `grid ${this.snapOn ? this.gridSize : "off"}`;
  }

  /** The level as it stands right now, as a level string — main deep-copies this
   *  (via loadLevel) so a playtest runs on a throwaway world and never mutates
   *  the authored one. */
  currentLevel(): string {
    return serializeLevel(this.state);
  }

  /** Suspend/resume editing. While suspended the panel is hidden and all input
   *  is ignored (main runs a playtest); resuming restores the panel and snaps
   *  the edited world's surface visibility back to the editor camera. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    this.panel.style.display = on ? "none" : "";
    if (!on) updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos, true);
  }

  private setZ(z: number): void {
    this.player.z = z;
    // Snap surface visibility so the level you flew to reads instantly.
    updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos, true);
  }

  /** Re-resolve surface visibility + render order after any edit. (The game
   *  sorts once per level load; only the editor re-sorts on the fly, so depth
   *  edits preview live.) */
  private refreshWorld(): void {
    sortRenderDepth(this.state.world);
    updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos, true);
  }

  // --- coordinates & snapping --------------------------------------------------

  private worldMouse(): Vec2 {
    return vec(
      (mouse.x - window.innerWidth / 2) * this.zoom + this.player.pos.x,
      (mouse.y - window.innerHeight / 2) * this.zoom + this.player.pos.y,
    );
  }

  private sn(v: number): number {
    return this.snapOn ? Math.round(v / this.gridSize) * this.gridSize : v;
  }

  private snv(p: Vec2): Vec2 {
    return vec(this.sn(p.x), this.sn(p.y));
  }

  // --- mouse -------------------------------------------------------------------

  private onDown(): void {
    const m = this.worldMouse();

    if (this.tool) {
      if (this.tool.shape === "point") {
        // Point kinds place immediately; the tool stays armed for the next one.
        const e = this.tool.create(this.snv(m), this.player.z);
        if (this.tool.singleton) this.tool.list(this.state).length = 0;
        this.tool.list(this.state).push(e);
        this.select({ def: this.tool, e });
        this.refreshWorld();
      } else {
        this.drag = { mode: "draw", start: this.snv(m), cur: this.snv(m) };
      }
      return;
    }

    // Select mode. Resize handles win over re-selection so grabbing a corner
    // of the current selection never selects what's underneath it.
    if (this.sel && this.sel.def.shape === "rect") {
      const h = this.handleAt(m);
      if (h) {
        this.drag = h === "rotate" ? { mode: "rotate" } : { mode: "resize", ex: h.ex, ey: h.ey };
        return;
      }
    }
    // While a hide region is selected it stays grabbable (hitTest only knows
    // world entities): clicking inside it — or a sibling region — drags it,
    // instead of reselecting whatever entity lies underneath.
    if (this.sel?.def.kind === "hideRegion" && this.regionFloor) {
      const r = (this.regionFloor.hideWhenIn ?? []).find((rg) => pointInBox(m, rg));
      if (r) {
        if (r !== this.sel.e) this.selectRegion(this.regionFloor, r);
        this.drag = { mode: "move", grab: sub(r.pos, m) };
        return;
      }
    }
    const hit = this.hitTest(m);
    this.select(hit);
    if (hit) this.drag = { mode: "move", grab: sub(hit.e.pos, m) };
  }

  private onMove(): void {
    if (!this.drag) return;
    const m = this.worldMouse();
    const d = this.drag;

    if (d.mode === "draw") {
      d.cur = this.snv(m);
    } else if (d.mode === "move" && this.sel) {
      const e = this.sel.e;
      const target = add(m, d.grab);
      if (this.sel.def.shape === "rect" && !e.angle) {
        // Snap the rect's min corner, not its center, so edges land on grid
        // lines. Rotated rects have no grid-aligned edges — snap the center.
        const minx = this.sn(target.x - e.w / 2);
        const miny = this.sn(target.y - e.h / 2);
        e.pos = vec(minx + e.w / 2, miny + e.h / 2);
      } else {
        e.pos = this.snv(target);
      }
      this.refreshGeom();
    } else if (d.mode === "resize" && this.sel) {
      const e = this.sel.e;
      // Resize in the entity's local frame: min/max edge math is only
      // meaningful where the rect is axis-aligned. The mouse maps in through
      // the rotation about the (old) center, and the resized center maps back
      // out through the same rotation. Snapping the local mouse keeps w/h on
      // grid multiples even when the edges themselves aren't on grid lines.
      const c0 = e.pos;
      const lm = toLocal(m, e);
      let minx = c0.x - e.w / 2;
      let maxx = c0.x + e.w / 2;
      let miny = c0.y - e.h / 2;
      let maxy = c0.y + e.h / 2;
      const mx = this.sn(lm.x);
      const my = this.sn(lm.y);
      if (d.ex === -1) minx = Math.min(mx, maxx - MIN_SIZE);
      if (d.ex === 1) maxx = Math.max(mx, minx + MIN_SIZE);
      if (d.ey === -1) miny = Math.min(my, maxy - MIN_SIZE);
      if (d.ey === 1) maxy = Math.max(my, miny + MIN_SIZE);
      const c = vec((minx + maxx) / 2, (miny + maxy) / 2);
      e.pos = e.angle ? add(c0, rotate(sub(c, c0), e.angle)) : c;
      e.w = maxx - minx;
      e.h = maxy - miny;
      this.refreshGeom();
    } else if (d.mode === "rotate" && this.sel) {
      const e = this.sel.e;
      // The knob sits at local -y, 90° short of the +x bearing the mouse
      // reports — so the rect's angle is the mouse bearing plus 90°. The snap
      // toggle snaps in 15° steps; exact 0 stores as "unrotated" so an
      // axis-aligned rect serializes exactly as before.
      let a = angleOf(sub(m, e.pos)) + Math.PI / 2;
      if (this.snapOn) a = Math.round(a / ROT_SNAP) * ROT_SNAP;
      if (a > Math.PI) a -= Math.PI * 2;
      e.angle = Math.abs(a) < 1e-9 ? undefined : a;
      this.refreshGeom();
    }
  }

  private onUp(): void {
    if (this.drag?.mode === "draw" && this.tool) {
      const { start, cur } = this.drag;
      const w = Math.abs(cur.x - start.x);
      const h = Math.abs(cur.y - start.y);
      const e = this.tool.create(vec((start.x + cur.x) / 2, (start.y + cur.y) / 2), this.player.z);
      if (w >= MIN_SIZE && h >= MIN_SIZE) {
        e.w = w;
        e.h = h;
      } else {
        e.pos = start; // a bare click: default-sized entity at the click point
      }
      if (this.tool.singleton) this.tool.list(this.state).length = 0;
      this.tool.list(this.state).push(e);
      this.select({ def: this.tool, e });
      this.refreshWorld();
    }
    this.drag = null;
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.key === "Escape") {
      this.cancel();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.sel) {
      e.preventDefault();
      this.deleteSel();
    } else if (e.key === "g") {
      this.snapOn = !this.snapOn;
      this.snapBox.checked = this.snapOn;
    } else if (e.key === "n") {
      this.setShowNodes(!this.showNodes);
    } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      // Copy: snapshot the selection as JSON (hide regions are sub-entities
      // with no standalone identity — copy their parent floor instead).
      if (this.sel && this.sel.def.kind !== "hideRegion") {
        this.clipboard = {
          def: this.sel.def,
          json: JSON.parse(JSON.stringify(entityToJSON(this.sel.def, this.sel.e))),
        };
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      this.paste();
    }
  }

  /** Rebuild the copied entity at the (snapped) mouse position, settings and
   *  all, and select the new copy. */
  private paste(): void {
    const clip = this.clipboard;
    if (!clip) return;
    const j = JSON.parse(JSON.stringify(clip.json)) as Record<string, any>;
    const p = this.snv(this.worldMouse());
    // Nested hideWhenIn regions travel with the part.
    if (Array.isArray(j.hideWhenIn)) {
      for (const r of j.hideWhenIn) {
        if (r?.pos) {
          r.pos.x += p.x - j.x;
          r.pos.y += p.y - j.y;
        }
      }
    }
    j.x = p.x;
    j.y = p.y;
    const e = entityFromJSON(clip.def, j);
    if (clip.def.singleton) clip.def.list(this.state).length = 0;
    clip.def.list(this.state).push(e);
    this.select({ def: clip.def, e });
    this.refreshWorld();
  }

  private cancel(): void {
    this.drag = null;
    this.setTool(null);
    this.select(null);
  }

  /** Are nav nodes currently drawn/selectable? */
  private nodesVisible(): boolean {
    return this.showNodes || this.tool?.kind === "node";
  }

  private setShowNodes(on: boolean): void {
    this.showNodes = on;
    this.nodesBox.checked = on;
    // Hiding them shouldn't leave an invisible selection (with its link
    // overlay) on screen.
    if (!this.nodesVisible() && this.sel?.def.kind === "node") this.select(null);
  }

  private deleteSel(): void {
    if (!this.sel) return;
    const arr = this.sel.def.list(this.state);
    const i = arr.indexOf(this.sel.e);
    if (i >= 0) arr.splice(i, 1);
    this.select(null);
    this.refreshWorld();
  }

  // --- picking -------------------------------------------------------------------

  /** Registry order is the priority order (points first, floors last); entities
   *  on the player's current z win over other levels; among overlapping rects
   *  of one kind the smallest wins (a patch on a big floor stays selectable). */
  private hitTest(m: Vec2): Selection | null {
    for (const sameZOnly of [true, false]) {
      for (const def of ENTITY_DEFS) {
        if (def.kind === "node" && !this.nodesVisible()) continue; // hidden = unclickable
        let best: any = null;
        let bestArea = Infinity;
        for (const e of def.list(this.state)) {
          if (!def.match(e)) continue;
          if (sameZOnly && def.zOf(e) !== this.player.z) continue;
          const hit =
            def.shape === "point"
              ? dist(m, e.pos) <= POINT_R
              : e.w > 0 && e.h > 0 && pointInBox(m, e); // infinite floors (w=0) aren't clickable
          if (!hit) continue;
          const area = def.shape === "point" ? 0 : e.w * e.h;
          if (area < bestArea) {
            best = e;
            bestArea = area;
          }
        }
        if (best) return { def, e: best };
      }
    }
    return null;
  }

  private handles(e: any): { ex: -1 | 0 | 1; ey: -1 | 0 | 1; p: Vec2 }[] {
    const out: { ex: -1 | 0 | 1; ey: -1 | 0 | 1; p: Vec2 }[] = [];
    for (const ex of [-1, 0, 1] as const) {
      for (const ey of [-1, 0, 1] as const) {
        if (ex === 0 && ey === 0) continue;
        const local = vec((ex * e.w) / 2, (ey * e.h) / 2);
        out.push({ ex, ey, p: add(e.pos, e.angle ? rotate(local, e.angle) : local) });
      }
    }
    return out;
  }

  /** The rotate knob: a lollipop off the rect's top edge, rotating with it. */
  private rotHandle(e: any): Vec2 {
    const local = vec(0, -e.h / 2 - ROT_HANDLE_OFF * this.zoom);
    return add(e.pos, e.angle ? rotate(local, e.angle) : local);
  }

  private handleAt(m: Vec2): { ex: -1 | 0 | 1; ey: -1 | 0 | 1 } | "rotate" | null {
    if (!this.sel || this.sel.e.w <= 0 || this.sel.e.h <= 0) return null;
    const r = 10 * this.zoom; // ~10 screen px of grab slop
    if (dist(m, this.rotHandle(this.sel.e)) <= r) return "rotate";
    for (const h of this.handles(this.sel.e)) {
      if (dist(m, h.p) <= r) return h;
    }
    return null;
  }

  // --- world-space overlay (called inside main's camera transform) ---------------

  drawWorld(ctx: CanvasRenderingContext2D): void {
    const z = this.zoom; // multiply widths by this for screen-constant lines
    const px = this.player.pos.x;
    const py = this.player.pos.y;
    const halfW = (window.innerWidth / 2) * z;
    const halfH = (window.innerHeight / 2) * z;

    // The snap grid, when it's coarse enough to be legible.
    const g = this.gridSize;
    if (this.snapOn && g / z >= 7) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = z;
      ctx.beginPath();
      for (let x = Math.floor((px - halfW) / g) * g; x <= px + halfW; x += g) {
        ctx.moveTo(x, py - halfH);
        ctx.lineTo(x, py + halfH);
      }
      for (let y = Math.floor((py - halfH) / g) * g; y <= py + halfH; y += g) {
        ctx.moveTo(px - halfW, y);
        ctx.lineTo(px + halfW, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Ghosts of ground items on other levels (the normal render hides them).
    for (const it of this.state.world.items) {
      if (it.z === this.player.z) continue;
      ctx.save();
      ctx.globalAlpha = 0.3;
      it.draw(ctx);
      ctx.restore();
    }

    // Ghosts of same-z obstacles the normal render skips — hidden by their
    // visibleFrom, or flagged invisible — so they stay findable and selectable.
    for (const o of this.state.world.obstacles) {
      if (o.z !== this.player.z) continue;
      const hidden = o.invisible || (o.visibleFrom && !zsetHas(o.visibleFrom, this.player.z));
      if (!hidden) continue;
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.translate(o.pos.x, o.pos.y);
      ctx.rotate(o.angle ?? 0);
      ctx.fillStyle = o.fill;
      ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
      if (o.strokeWidth > 0 && o.stroke) {
        ctx.strokeStyle = o.stroke;
        const ghost = borderFit(o.strokeWidth, Math.min(o.w, o.h));
        ctx.lineWidth = ghost.width;
        ctx.strokeRect(-o.w / 2 + ghost.inset, -o.h / 2 + ghost.inset,
                       o.w - 2 * ghost.inset, o.h - 2 * ghost.inset);
      }
      ctx.restore();
    }

    // Same for invisible floors on the current level: faint fill + dashed edge.
    for (const f of this.state.world.floors) {
      if (!f.invisible || f.infinite || f.level !== this.player.z) continue;
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.translate(f.pos.x, f.pos.y);
      ctx.rotate(f.angle ?? 0);
      ctx.fillStyle = f.color;
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2 * z;
      ctx.setLineDash([8 * z, 6 * z]);
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.restore();
    }

    // Spawn zones (gamemode data, not part of the world): team-colored
    // translucent rects, brighter on the current level. This is their only
    // rendering — they're invisible in play.
    for (const zone of this.state.spawnZones) {
      const col = TEAMS[zone.team]?.color ?? "#888888";
      const onLevel = zone.z === this.player.z;
      ctx.save();
      ctx.translate(zone.pos.x, zone.pos.y);
      ctx.rotate(zone.angle ?? 0);
      ctx.globalAlpha = onLevel ? 0.16 : 0.06;
      ctx.fillStyle = col;
      ctx.fillRect(-zone.w / 2, -zone.h / 2, zone.w, zone.h);
      ctx.globalAlpha = onLevel ? 0.85 : 0.3;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2 * z;
      ctx.setLineDash([8 * z, 6 * z]);
      ctx.strokeRect(-zone.w / 2, -zone.h / 2, zone.w, zone.h);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = onLevel ? 0.9 : 0.35;
      ctx.fillStyle = col;
      ctx.font = `${12 * z}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(`${zone.team} spawn`, zone.pos.x, zone.pos.y);
      ctx.restore();
    }

    // Domination points: the gray circular border at the capture radius, so the
    // authored footprint is visible (play draws the same ring with the live
    // capture progress stroked over it). The name comes from the marker pass.
    for (const p of this.state.domPoints) {
      const onLevel = p.z === this.player.z;
      ctx.save();
      ctx.globalAlpha = onLevel ? 0.8 : 0.3;
      ctx.strokeStyle = DOM_GRAY;
      ctx.lineWidth = Math.max(4, p.radius * 0.09);
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // hideWhenIn regions of the selected floor (or of a selected region's
    // parent): plain rectangle borders with their trigger z labeled.
    const rf =
      this.sel?.def.kind === "hideRegion"
        ? this.regionFloor
        : this.sel?.def.kind === "floor"
          ? (this.sel.e as Floor)
          : null;
    if (rf?.hideWhenIn) {
      ctx.save();
      ctx.strokeStyle = "#ff9d3d";
      ctx.lineWidth = 2 * z;
      ctx.font = `${11 * z}px monospace`;
      ctx.fillStyle = "#ff9d3d";
      ctx.textAlign = "left";
      for (const r of rf.hideWhenIn) {
        ctx.strokeRect(r.pos.x - r.w / 2, r.pos.y - r.h / 2, r.w, r.h);
        ctx.fillText(`hide @ z${r.z}`, r.pos.x - r.w / 2 + 4 * z, r.pos.y - r.h / 2 - 5 * z);
      }
      ctx.restore();
    }

    // Nav-node links: with a node selected, preview the graph the game will
    // bake — movable links solid, sight-only links dashed & faint, plus the
    // movable radius. Recomputed live, so dragging the node or a wall updates it.
    if (this.sel?.def.kind === "node") {
      const a = this.sel.e as PathNode;
      ctx.save();
      ctx.strokeStyle = "rgba(53,208,197,0.45)";
      ctx.lineWidth = 1.5 * z;
      ctx.setLineDash([5 * z, 5 * z]);
      ctx.beginPath();
      ctx.arc(a.pos.x, a.pos.y, MOVE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      for (const b of this.state.world.nodes) {
        if (b === a) continue;
        const e = nodeEdge(this.state.world, a, b);
        if (!e.visible && !e.movable) continue;
        ctx.setLineDash(e.movable ? [] : [6 * z, 6 * z]);
        ctx.strokeStyle = e.movable ? "#35d0c5" : "rgba(255,255,255,0.35)";
        ctx.lineWidth = (e.movable ? 2.5 : 1.5) * z;
        ctx.beginPath();
        ctx.moveTo(a.pos.x, a.pos.y);
        ctx.lineTo(b.pos.x, b.pos.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Labeled marker discs for entities with no in-world rendering (player and
    // enemy spawns — anything whose def declares a marker).
    ctx.save();
    ctx.font = `${11 * z}px monospace`;
    ctx.textAlign = "center";
    for (const def of ENTITY_DEFS) {
      if (!def.marker) continue;
      if (def.kind === "node" && !this.nodesVisible()) continue;
      for (const e of def.list(this.state)) {
        if (!def.match(e)) continue;
        const m = def.marker(e);
        const ez = def.zOf(e);
        ctx.globalAlpha = ez === this.player.z ? 0.95 : 0.35;
        ctx.beginPath();
        ctx.arc(e.pos.x, e.pos.y, BODY_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.lineWidth = 2 * z;
        ctx.strokeStyle = "#16181c";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillText(`${m.label} z${ez}`, e.pos.x, e.pos.y - BODY_RADIUS - 6 * z);
      }
    }
    ctx.restore();

    // Selection outline + resize handles.
    if (this.sel) {
      const e = this.sel.e;
      ctx.save();
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 2 * z;
      ctx.setLineDash([6 * z, 4 * z]);
      // A zero-size rect (the infinite background floor) gets the point-style
      // ring — there's no rectangle to outline or resize.
      if (this.sel.def.shape === "rect" && e.w > 0 && e.h > 0) {
        // Everything draws in the entity's rotated frame, so outline, resize
        // handles, and the rotate lollipop all follow the rect around.
        ctx.translate(e.pos.x, e.pos.y);
        ctx.rotate(e.angle ?? 0);
        ctx.strokeRect(-e.w / 2, -e.h / 2, e.w, e.h);
        ctx.setLineDash([]);
        // Rotate lollipop: a stem off the top edge ending in a grab knob
        // (rotHandle computes the same spot for hit-testing).
        const knobY = -e.h / 2 - ROT_HANDLE_OFF * z;
        ctx.beginPath();
        ctx.moveTo(0, -e.h / 2);
        ctx.lineTo(0, knobY);
        ctx.stroke();
        ctx.fillStyle = SEL_COLOR;
        ctx.beginPath();
        ctx.arc(0, knobY, 5 * z, 0, Math.PI * 2);
        ctx.fill();
        const hs = 4.5 * z;
        for (const h of this.handles(e)) {
          ctx.fillRect((h.ex * e.w) / 2 - hs, (h.ey * e.h) / 2 - hs, hs * 2, hs * 2);
        }
      } else {
        ctx.beginPath();
        ctx.arc(e.pos.x, e.pos.y, POINT_R, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Drag-to-draw preview, or the snapped placement cursor while a tool is armed.
    ctx.save();
    ctx.strokeStyle = SEL_COLOR;
    ctx.lineWidth = 2 * z;
    if (this.drag?.mode === "draw") {
      const { start, cur } = this.drag;
      ctx.setLineDash([6 * z, 4 * z]);
      ctx.strokeRect(
        Math.min(start.x, cur.x),
        Math.min(start.y, cur.y),
        Math.abs(cur.x - start.x),
        Math.abs(cur.y - start.y),
      );
    } else if (this.tool) {
      const p = this.snv(this.worldMouse());
      ctx.beginPath();
      ctx.moveTo(p.x - 9 * z, p.y);
      ctx.lineTo(p.x + 9 * z, p.y);
      ctx.moveTo(p.x, p.y - 9 * z);
      ctx.lineTo(p.x, p.y + 9 * z);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- DOM panel -------------------------------------------------------------------

  private mk<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  private static readonly INPUT_CSS =
    "background:#23262c;color:#dfe2e8;border:1px solid #3a3e46;border-radius:4px;" +
    "font:inherit;padding:2px 5px;";

  private btn(label: string, onClick: () => void): HTMLButtonElement {
    const b = this.mk("button", Editor.INPUT_CSS + "cursor:pointer;padding:4px 8px;");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  private header(text: string): HTMLElement {
    return this.mk("div", "opacity:0.55;letter-spacing:1px;margin-top:4px;", text.toUpperCase());
  }

  private buildPanel(): void {
    const panel = this.mk(
      "div",
      "position:fixed;top:8px;right:8px;width:280px;max-height:calc(100vh - 16px);" +
        "overflow-y:auto;background:rgba(14,16,20,0.93);color:#dfe2e8;" +
        "font:12px ui-monospace,Consolas,monospace;padding:10px;border-radius:8px;" +
        "display:flex;flex-direction:column;gap:6px;z-index:10;",
    );

    this.panel = panel;
    panel.append(this.mk("div", "font-weight:bold;font-size:13px;", "LEVEL EDITOR"));
    this.status = this.mk("div", "opacity:0.8;");
    panel.append(this.status);

    // Playtest: hand the level as it stands to a live match; Esc returns here.
    const play = this.btn("▶ Playtest", () => this.onPlaytest?.());
    play.style.cssText +=
      "background:#1f6f3a;border-color:#2f9b53;color:#eaffef;font-weight:bold;width:100%;";
    panel.append(play);
    panel.append(
      this.mk(
        "div",
        "opacity:0.5;font-size:11px;line-height:1.5;",
        "wasd fly · shift fast · wheel zoom · [ ] z-level · click select · " +
          "drag move · handles resize · ctrl+c/v copy/paste · del delete · " +
          "esc/right-click cancel · g snap · n nodes",
      ),
    );

    // Palette: Select + one button per registered kind.
    panel.append(this.header("place"));
    const pal = this.mk("div", "display:flex;flex-wrap:wrap;gap:4px;");
    const addTool = (key: string | null, label: string, def: EntityDef | null): void => {
      const b = this.btn(label, () => this.setTool(def));
      this.toolButtons.set(key, b);
      pal.append(b);
    };
    addTool(null, "Select", null);
    for (const def of ENTITY_DEFS) addTool(def.kind, def.label, def);
    panel.append(pal);
    this.setTool(null);

    // Grid controls.
    panel.append(this.header("grid"));
    const gridRow = this.mk("div", "display:flex;align-items:center;gap:6px;");
    this.snapBox = this.mk("input", "");
    this.snapBox.type = "checkbox";
    this.snapBox.checked = this.snapOn;
    this.snapBox.onchange = () => {
      this.snapOn = this.snapBox.checked;
    };
    const gridIn = this.mk("input", Editor.INPUT_CSS + "width:64px;");
    gridIn.type = "number";
    gridIn.min = "1";
    gridIn.value = String(this.gridSize);
    gridIn.oninput = () => {
      const v = parseFloat(gridIn.value);
      if (Number.isFinite(v) && v >= 1) this.gridSize = v;
    };
    gridRow.append(this.snapBox, this.mk("span", "", "snap"), gridIn, this.mk("span", "opacity:0.6", "px"));
    panel.append(gridRow);

    // View toggles.
    panel.append(this.header("view"));
    const viewRow = this.mk("div", "display:flex;align-items:center;gap:6px;");
    this.nodesBox = this.mk("input", "");
    this.nodesBox.type = "checkbox";
    this.nodesBox.checked = this.showNodes;
    this.nodesBox.onchange = () => this.setShowNodes(this.nodesBox.checked);
    viewRow.append(this.nodesBox, this.mk("span", "", "nav nodes (n)"));
    panel.append(viewRow);

    // Match: gamemode picker + its per-mode parameters. Writes state.meta, which
    // serializeLevel bakes into the level string (nothing for sandbox).
    panel.append(this.header("match"));
    const modeRow = this.mk("div", "display:flex;align-items:center;gap:6px;");
    const modeSel = this.mk("select", Editor.INPUT_CSS + "flex:1;min-width:0;");
    for (const key of Object.keys(GAMEMODES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      modeSel.append(opt);
    }
    modeSel.value = this.state.meta.mode ?? "sandbox";
    modeSel.onchange = () => {
      // Sandbox is the implicit default: clear meta.mode so the level stays clean.
      this.state.meta.mode = modeSel.value === "sandbox" ? undefined : modeSel.value;
      this.renderMatchFields();
    };
    modeRow.append(this.mk("span", "opacity:0.8;", "mode"), modeSel);
    panel.append(modeRow);
    this.matchFields = this.mk("div", "display:flex;flex-direction:column;gap:4px;");
    panel.append(this.matchFields);
    this.renderMatchFields();

    // Minimap: the world-space side the bottom-left minimap covers (blank/0 =
    // auto-fit to the level's extent). Level-wide, not mode-specific.
    panel.append(this.header("minimap"));
    const mmRow = this.mk("div", "display:flex;align-items:center;gap:6px;");
    const mmIn = this.mk("input", Editor.INPUT_CSS + "width:80px;");
    mmIn.type = "number";
    mmIn.min = "0";
    mmIn.value = this.state.meta.minimapSize ? String(this.state.meta.minimapSize) : "";
    mmIn.placeholder = "auto";
    mmIn.oninput = () => {
      const v = parseFloat(mmIn.value);
      this.state.meta.minimapSize = Number.isFinite(v) && v > 0 ? v : undefined;
    };
    mmRow.append(this.mk("span", "opacity:0.8;", "size"), mmIn, this.mk("span", "opacity:0.6;", "world px (blank=auto)"));
    panel.append(mmRow);

    // Visibility: line-of-sight rendering (see LevelMeta.visibility). Level-wide.
    panel.append(this.header("visibility"));
    const visRow = this.mk("div", "display:flex;align-items:center;gap:6px;");
    const visIn = this.mk("input", "");
    visIn.type = "checkbox";
    visIn.checked = !!this.state.meta.visibility;
    visIn.onchange = () => {
      this.state.meta.visibility = visIn.checked ? true : undefined;
    };
    visRow.append(visIn, this.mk("span", "opacity:0.8;", "line-of-sight mask (hide what the player can't see)"));
    panel.append(visRow);

    // Inspector (rebuilt per selection).
    panel.append(this.header("selection"));
    // The infinite background floor has no rect to click in the world, so it
    // gets a dedicated way in — its fields (fill color, grid settings) are
    // ordinary floor fields once selected.
    panel.append(this.btn("Select background", () => this.selectBackground()));
    this.inspector = this.mk("div", "display:flex;flex-direction:column;gap:4px;");
    panel.append(this.inspector);
    this.renderInspector();

    // Level file I/O. Save downloads <name>.json — drop it into src/world/levels/ and
    // it's bundled + bootable as ?level=<name> (default.json = the startup map).
    panel.append(this.header("level file"));
    const nameRow = this.mk("div", "display:flex;align-items:center;gap:4px;");
    this.nameIn = this.mk("input", Editor.INPUT_CSS + "flex:1;min-width:0;");
    this.nameIn.type = "text";
    this.nameIn.value = new URLSearchParams(location.search).get("level") ?? "level";
    this.nameIn.spellcheck = false;
    nameRow.append(this.nameIn, this.mk("span", "opacity:0.6;", ".json"));
    panel.append(nameRow);

    const fileIn = this.mk("input", "display:none;");
    fileIn.type = "file";
    fileIn.accept = ".json,application/json";
    fileIn.onchange = () => {
      const f = fileIn.files?.[0];
      if (f) this.doLoadFile(f);
      fileIn.value = ""; // so re-picking the same file fires onchange again
    };
    const fileRow = this.mk("div", "display:flex;gap:4px;");
    fileRow.append(
      this.btn("Save", () => this.doSave()),
      this.btn("Load file…", () => fileIn.click()),
      fileIn,
    );
    panel.append(fileRow);

    // Bundled levels (everything already in src/world/levels/), openable in place.
    const bundled = Object.keys(LEVELS);
    if (bundled.length > 0) {
      const openRow = this.mk("div", "display:flex;gap:4px;");
      const sel = this.mk("select", Editor.INPUT_CSS + "flex:1;min-width:0;");
      for (const name of bundled) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.append(opt);
      }
      openRow.append(sel, this.btn("Open", () => this.doOpenBundled(sel.value)));
      panel.append(openRow);
    }

    // The raw string, as an escape hatch (clipboard sharing, quick tweaks).
    panel.append(this.header("level string"));
    const io = this.mk("div", "display:flex;gap:4px;");
    io.append(
      this.btn("Export", () => this.doExport()),
      this.btn("Import", () => this.doImport()),
    );
    panel.append(io);
    this.ta = this.mk(
      "textarea",
      Editor.INPUT_CSS + "width:100%;height:96px;resize:vertical;font-size:10px;box-sizing:border-box;",
    );
    this.ta.spellcheck = false;
    this.ta.placeholder = "Export fills this (and your clipboard); paste here and Import to load.";
    panel.append(this.ta);

    // Flex children default to shrink-to-fit, which squashes the bottom
    // sections into nothing (the textarea especially) instead of letting the
    // panel overflow and scroll — pin every section to its natural height.
    for (const c of Array.from(panel.children)) (c as HTMLElement).style.flexShrink = "0";

    document.body.append(panel);
  }

  /** A labeled number input bound to a getter/setter, for the match panel. */
  private matchNumRow(
    label: string,
    get: () => number,
    set: (v: number) => void,
    opts: { min?: number; step?: number } = {},
  ): HTMLElement {
    const row = this.mk("div", "display:flex;align-items:center;justify-content:space-between;gap:6px;");
    row.append(this.mk("span", "opacity:0.8;", label));
    const inp = this.mk("input", Editor.INPUT_CSS + "width:80px;");
    inp.type = "number";
    if (opts.min !== undefined) inp.min = String(opts.min);
    if (opts.step !== undefined) inp.step = String(opts.step);
    inp.value = String(get());
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) set(v);
    };
    row.append(inp);
    return row;
  }

  /** A labeled dropdown bound to a getter/setter, for the match panel. */
  private matchSelectRow(label: string, options: readonly string[], get: () => string, set: (v: string) => void): HTMLElement {
    const row = this.mk("div", "display:flex;align-items:center;justify-content:space-between;gap:6px;");
    row.append(this.mk("span", "opacity:0.8;", label));
    const sel = this.mk("select", Editor.INPUT_CSS + "width:110px;");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      sel.append(opt);
    }
    sel.value = get();
    sel.onchange = () => set(sel.value);
    row.append(sel);
    return row;
  }

  /** (Re)build the mode-specific parameter inputs under the mode picker. Both
   *  team modes share the per-side troop/skill/equip block; they differ only in
   *  their one top-level ticket field (kill limit vs score limit). */
  private renderMatchFields(): void {
    this.matchFields.replaceChildren();
    const mode = this.state.meta.mode;
    if (mode === "tdm") {
      const t = (this.state.meta.tdm ??= defaultTdm());
      this.matchFields.append(
        this.matchNumRow("kill limit", () => t.killLimit, (v) => (t.killLimit = Math.max(1, Math.round(v))), { min: 1, step: 1 }),
        this.matchNumRow("respawn delay", () => t.respawnDelay, (v) => (t.respawnDelay = Math.max(0, Math.round(v))), { min: 0, step: 1 }),
      );
      this.appendTeamFields(t);
    } else if (mode === "domination") {
      const d = (this.state.meta.domination ??= defaultDom());
      this.matchFields.append(
        this.matchNumRow("score limit", () => d.scoreLimit, (v) => (d.scoreLimit = Math.max(1, Math.round(v))), { min: 1, step: 1 }),
        this.matchNumRow("respawn delay", () => d.respawnDelay, (v) => (d.respawnDelay = Math.max(0, Math.round(v))), { min: 0, step: 1 }),
      );
      this.appendTeamFields(d);
    } else {
      return;
    }
    for (const child of Array.from(this.matchFields.children)) (child as HTMLElement).style.flexShrink = "0";
  }

  /** The blue/red troop/skill/equip inputs shared by the team gamemodes. */
  private appendTeamFields(cfg: { blue: TeamConfig; red: TeamConfig }): void {
    for (const side of ["blue", "red"] as const) {
      const c = cfg[side];
      this.matchFields.append(this.header(`${side} team`));
      this.matchFields.append(
        this.matchNumRow("troops", () => c.troops, (v) => (c.troops = Math.max(0, Math.round(v))), { min: 0, step: 1 }),
        this.matchNumRow("skill 0-1", () => c.skill, (v) => (c.skill = Math.max(0, Math.min(1, v))), { min: 0, step: 0.1 }),
        this.matchSelectRow("equip", EQUIP_NAMES, () => c.equip, (v) => (c.equip = v)),
      );
    }
  }

  private setTool(def: EntityDef | null): void {
    this.tool = def;
    for (const [key, b] of this.toolButtons) {
      const active = (def ? def.kind : null) === key;
      b.style.background = active ? SEL_COLOR : "#23262c";
      b.style.color = active ? "#10140f" : "#dfe2e8";
    }
    // Disarming the node tool while nodes are hidden: drop any node selection
    // too, or an invisible entity keeps its selection ring + link overlay.
    if (!this.nodesVisible() && this.sel?.def.kind === "node") this.select(null);
  }

  private select(sel: Selection | null): void {
    if (!sel || sel.def.kind !== "hideRegion") this.regionFloor = null;
    this.sel = sel;
    this.renderInspector();
  }

  /** A pseudo-def binding a floor's hideWhenIn array into the normal selection
   *  machinery — move/resize/delete/inspector all work on regions unchanged. */
  private regionDef(floor: Floor): EntityDef {
    return {
      kind: "hideRegion",
      label: "Hide region",
      shape: "rect",
      fields: [
        {
          key: "z",
          type: "number",
          get: (r) => r.z,
          set: (r, v) => {
            r.z = v;
          },
        },
      ],
      list: () => floor.hideWhenIn ?? [],
      match: () => true,
      create: (pos, z) => ({ pos, w: 200, h: 200, z }),
      zOf: (r) => r.z,
    };
  }

  private selectRegion(floor: Floor, r: Region): void {
    this.regionFloor = floor;
    this.sel = { def: this.regionDef(floor), e: r };
    this.renderInspector();
  }

  /** Select the level's background (infinite) floor, creating one if the level
   *  doesn't have any yet — new editor-built maps start with no ground at all. */
  private selectBackground(): void {
    const floors = this.state.world.floors;
    let bg = floors.find((f) => f.infinite);
    if (!bg) {
      bg = makeFloor(vec(0, 0), 0, 0, "#70c575", {
        level: 0,
        visibleFrom: { atLeast: -1 },
        infinite: true,
        grid: true,
        gridColor: "#5ca76c",
      });
      floors.push(bg);
      this.refreshWorld();
    }
    const def = ENTITY_DEFS.find((d) => d.kind === "floor")!;
    this.setTool(null);
    this.select({ def, e: bg });
  }

  /** Download the level as <name>.json (the browser can't write into the repo,
   *  so the workflow is: save, then move the file into src/world/levels/). */
  private doSave(): void {
    const text = serializeLevel(this.state);
    const blob = new Blob([text + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.nameIn.value.trim() || "level"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private doLoadFile(file: File): void {
    void file.text().then((text) => {
      try {
        applyLevel(this.state, text);
        this.select(null);
        this.refreshWorld();
        this.nameIn.value = file.name.replace(/\.json$/i, "");
      } catch (err) {
        alert(`Load failed: ${err}`);
      }
    });
  }

  private doOpenBundled(name: string): void {
    const text = LEVELS[name];
    if (!text) return;
    try {
      applyLevel(this.state, text);
      this.select(null);
      this.refreshWorld();
      this.nameIn.value = name;
    } catch (err) {
      alert(`Open failed: ${err}`);
    }
  }

  private doExport(): void {
    const text = serializeLevel(this.state);
    this.ta.value = text;
    this.ta.select();
    void navigator.clipboard?.writeText(text).catch(() => {});
  }

  private doImport(): void {
    try {
      applyLevel(this.state, this.ta.value);
      this.select(null);
      this.refreshWorld();
    } catch (err) {
      alert(`Import failed: ${err}`);
    }
  }

  // --- inspector ---------------------------------------------------------------

  private row(label: string, input: HTMLElement): HTMLElement {
    const row = this.mk("div", "display:flex;align-items:center;gap:6px;");
    row.append(this.mk("span", "width:96px;flex:none;opacity:0.75;", label), input);
    return row;
  }

  /** A live-updating number input bound to a getter/setter (used for geometry). */
  private numRow(label: string, get: () => number, set: (v: number) => void): HTMLElement {
    const i = this.mk("input", Editor.INPUT_CSS + "flex:1;min-width:0;");
    i.type = "number";
    i.step = "any";
    i.value = String(Math.round(get() * 100) / 100);
    i.oninput = () => {
      const v = parseFloat(i.value);
      if (Number.isFinite(v)) {
        set(v);
        this.refreshWorld();
      }
    };
    this.geomRefs.push({ input: i, get });
    return this.row(label, i);
  }

  /** Push live geometry back into the inspector while the mouse drags it around. */
  private refreshGeom(): void {
    for (const g of this.geomRefs) {
      if (document.activeElement !== g.input) g.input.value = String(Math.round(g.get() * 100) / 100);
    }
    this.refreshWorld();
  }

  private renderInspector(): void {
    this.inspector.replaceChildren();
    this.geomRefs = [];
    if (!this.sel) {
      this.inspector.append(this.mk("div", "opacity:0.5;", "nothing selected"));
      return;
    }
    const { def, e } = this.sel;
    this.inspector.append(this.mk("div", "font-weight:bold;", def.label));

    // A hide region is a sub-entity: offer the way back up to its floor.
    if (def.kind === "hideRegion" && this.regionFloor) {
      const fl = this.regionFloor;
      const fdef = ENTITY_DEFS.find((d) => d.kind === "floor")!;
      this.inspector.append(this.btn("◀ back to floor", () => this.select({ def: fdef, e: fl })));
    }

    this.inspector.append(
      this.numRow("x", () => e.pos.x, (v) => (e.pos = vec(v, e.pos.y))),
      this.numRow("y", () => e.pos.y, (v) => (e.pos = vec(e.pos.x, v))),
    );
    if (def.shape === "rect") {
      this.inspector.append(
        this.numRow("w", () => e.w, (v) => (e.w = Math.max(MIN_SIZE, v))),
        this.numRow("h", () => e.h, (v) => (e.h = Math.max(MIN_SIZE, v))),
        // Degrees for the humans, radians in memory, 0 stored as "unrotated".
        this.numRow("angle°", () => rad2deg(e.angle ?? 0), (v) => (e.angle = v ? deg2rad(v) : undefined)),
      );
    }
    for (const f of def.fields) this.inspector.append(this.fieldRow(f, e));

    this.inspector.append(this.btn("Delete", () => this.deleteSel()));
  }

  /** Build the input widget for one FieldDef — the inspector is fully schema-driven. */
  private fieldRow(f: FieldDef, e: any): HTMLElement {
    const css = Editor.INPUT_CSS + "flex:1;min-width:0;";
    // Validation by execution: apply the value, then immediately run the same
    // depth/visibility refresh rendering depends on. If that throws (e.g. a
    // parseable-but-structurally-wrong JSON value), roll the field back so a
    // bad input can never wedge the world, and flag the widget red.
    const commit = (v: unknown, el?: HTMLElement): boolean => {
      const prev = f.get(e);
      f.set(e, v);
      try {
        this.refreshWorld();
        if (el) el.style.borderColor = "#3a3e46";
        return true;
      } catch (err) {
        f.set(e, prev);
        try {
          this.refreshWorld();
        } catch {
          // prev was live a moment ago; if even it refuses now, leave it to the
          // frame guard rather than dying inside an input handler.
        }
        if (el) el.style.borderColor = "#d05050";
        console.warn(`[editor] rejected ${f.key} value`, v, err);
        return false;
      }
    };

    switch (f.type) {
      case "number": {
        const i = this.mk("input", css);
        i.type = "number";
        i.step = "any";
        i.value = String((f.get(e) as number) ?? 0);
        i.oninput = () => {
          const v = parseFloat(i.value);
          if (Number.isFinite(v)) commit(v, i);
        };
        return this.row(f.key, i);
      }
      case "checkbox": {
        const i = this.mk("input", "");
        i.type = "checkbox";
        i.checked = !!f.get(e);
        i.onchange = () => {
          if (!commit(i.checked)) i.checked = !!f.get(e);
        };
        return this.row(f.key, i);
      }
      case "color": {
        const i = this.mk("input", css + "padding:0;height:22px;");
        i.type = "color";
        i.value = String(f.get(e) ?? "#ffffff");
        i.oninput = () => commit(i.value, i);
        return this.row(f.key, i);
      }
      case "text": {
        const i = this.mk("input", css);
        i.type = "text";
        i.value = String(f.get(e) ?? "");
        i.oninput = () => commit(i.value, i);
        return this.row(f.key, i);
      }
      case "select": {
        const s = this.mk("select", css);
        for (const o of f.options?.() ?? []) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          s.append(opt);
        }
        s.value = String(f.get(e));
        s.onchange = () => {
          if (!commit(s.value, s)) s.value = String(f.get(e));
        };
        return this.row(f.key, s);
      }
      case "regions": {
        // Region list: each row selects its region (drag/resize/Del like any
        // entity, plus a z field); "+ add" starts one covering the floor.
        const col = this.mk("div", "flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;");
        const regions = (f.get(e) as Region[] | undefined) ?? [];
        regions.forEach((r, i) => {
          const row = this.mk("div", "display:flex;gap:3px;");
          const pick = this.btn(
            `#${i + 1} @ z${r.z} · ${Math.round(r.w)}×${Math.round(r.h)}`,
            () => this.selectRegion(e, r),
          );
          pick.style.flex = "1";
          const rm = this.btn("×", () => {
            const arr = f.get(e) as Region[];
            arr.splice(arr.indexOf(r), 1);
            this.refreshWorld();
            this.renderInspector();
          });
          row.append(pick, rm);
          col.append(row);
        });
        const addBtn = this.btn("+ add region", () => {
          let arr = f.get(e) as Region[] | undefined;
          if (!arr) {
            arr = [];
            f.set(e, arr);
          }
          const r: Region = {
            pos: vec(e.pos.x, e.pos.y),
            w: e.w > 0 ? e.w : 200,
            h: e.h > 0 ? e.h : 200,
            z: this.player.z,
          };
          arr.push(r);
          this.refreshWorld();
          this.selectRegion(e, r);
        });
        col.append(addBtn);
        return this.row(f.key, col);
      }
      case "json": {
        // The escape hatch for structured values (ZSets, hideWhenIn regions):
        // edited as raw JSON, red border while it doesn't parse.
        const i = this.mk("input", css);
        i.type = "text";
        const v = f.get(e);
        i.value = v === undefined ? "" : JSON.stringify(v);
        i.onchange = () => {
          const txt = i.value.trim();
          let parsed: unknown;
          try {
            parsed = txt === "" ? undefined : JSON.parse(txt);
          } catch {
            i.style.borderColor = "#d05050";
            return;
          }
          commit(parsed, i); // red border on structural rejection, too
        };
        return this.row(f.key, i);
      }
    }
  }
}
