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
import type { Character } from "./actor.ts";
import { BODY_RADIUS } from "./character.ts";
import { pointInBox } from "./collision.ts";
import { isDown, mouse, moveAxis } from "./input.ts";
import {
  ENTITY_DEFS,
  applyLevel,
  serializeLevel,
  type EntityDef,
  type FieldDef,
  type LevelState,
} from "./level.ts";
import { ENEMY_TYPES } from "./robot.ts";
import { add, dist, norm, scale, sub, vec, type Vec2 } from "./vec.ts";
import { updateSurfaceAlphas } from "./world.ts";

const POINT_R = 45; // selection radius around point entities (items, spawns)
const MIN_SIZE = 8; // smallest rect a drag-draw or resize can produce
const SEL_COLOR = "#3ddcff";

type Drag =
  | { mode: "draw"; start: Vec2; cur: Vec2 }
  | { mode: "move"; grab: Vec2 } // entity pos minus mouse, at grab time
  | { mode: "resize"; ex: -1 | 0 | 1; ey: -1 | 0 | 1 }; // which edges follow

interface Selection {
  def: EntityDef;
  e: any;
}

export class Editor {
  /** Camera scale (world px per screen px); main.ts reads this instead of the gun zoom. */
  zoom = 2.2;

  private readonly state: LevelState;
  private readonly player: Character;

  private snapOn = true;
  private gridSize = 20;
  private tool: EntityDef | null = null; // null = select/move mode
  private sel: Selection | null = null;
  private drag: Drag | null = null;
  private prevZUp = false;
  private prevZDown = false;

  // DOM
  private status!: HTMLElement;
  private inspector!: HTMLElement;
  private ta!: HTMLTextAreaElement;
  private snapBox!: HTMLInputElement;
  private readonly toolButtons = new Map<string | null, HTMLButtonElement>();
  /** Inspector geometry inputs, refreshed live while dragging. */
  private geomRefs: { input: HTMLInputElement; get: () => number }[] = [];

  constructor(state: LevelState, player: Character, canvas: HTMLCanvasElement) {
    this.state = state;
    this.player = player;
    this.buildPanel();

    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.onDown();
      else if (e.button === 2) this.cancel(); // right click: drop tool + selection
    });
    window.addEventListener("mousemove", () => this.onMove());
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.onUp();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(14, Math.max(0.4, this.zoom * Math.exp(e.deltaY * 0.0012)));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  // --- per-tick (called from main's update in edit mode) ----------------------

  update(): void {
    // Fly (noclip): direct position control, scaled so it feels the same at any zoom.
    const axis = moveAxis();
    if (axis.x !== 0 || axis.y !== 0) {
      const sp = (isDown("shift") ? 26 : 11) * this.zoom;
      this.player.pos = add(this.player.pos, scale(norm(axis), sp));
    }

    // z level: [ down, ] up (edge-triggered so one press = one level).
    const up = isDown("]");
    const down = isDown("[");
    if (up && !this.prevZUp) this.setZ(this.player.z + 1);
    if (down && !this.prevZDown) this.setZ(this.player.z - 1);
    this.prevZUp = up;
    this.prevZDown = down;

    updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos);
    this.status.textContent =
      `z ${this.player.z}   zoom ${this.zoom.toFixed(2)}   ` +
      `grid ${this.snapOn ? this.gridSize : "off"}`;
  }

  private setZ(z: number): void {
    this.player.z = z;
    // Snap surface visibility so the level you flew to reads instantly.
    updateSurfaceAlphas(this.state.world, this.player.z, this.player.pos, true);
  }

  /** Re-resolve surface visibility after any edit that could change it. */
  private refreshWorld(): void {
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
        this.drag = { mode: "resize", ex: h.ex, ey: h.ey };
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
      if (this.sel.def.shape === "rect") {
        // Snap the rect's min corner, not its center, so edges land on grid lines.
        const minx = this.sn(target.x - e.w / 2);
        const miny = this.sn(target.y - e.h / 2);
        e.pos = vec(minx + e.w / 2, miny + e.h / 2);
      } else {
        e.pos = this.snv(target);
      }
      this.refreshGeom();
    } else if (d.mode === "resize" && this.sel) {
      const e = this.sel.e;
      let minx = e.pos.x - e.w / 2;
      let maxx = e.pos.x + e.w / 2;
      let miny = e.pos.y - e.h / 2;
      let maxy = e.pos.y + e.h / 2;
      const mx = this.sn(m.x);
      const my = this.sn(m.y);
      if (d.ex === -1) minx = Math.min(mx, maxx - MIN_SIZE);
      if (d.ex === 1) maxx = Math.max(mx, minx + MIN_SIZE);
      if (d.ey === -1) miny = Math.min(my, maxy - MIN_SIZE);
      if (d.ey === 1) maxy = Math.max(my, miny + MIN_SIZE);
      e.pos = vec((minx + maxx) / 2, (miny + maxy) / 2);
      e.w = maxx - minx;
      e.h = maxy - miny;
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
    }
  }

  private cancel(): void {
    this.drag = null;
    this.setTool(null);
    this.select(null);
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
        out.push({ ex, ey, p: vec(e.pos.x + (ex * e.w) / 2, e.pos.y + (ey * e.h) / 2) });
      }
    }
    return out;
  }

  private handleAt(m: Vec2): { ex: -1 | 0 | 1; ey: -1 | 0 | 1 } | null {
    if (!this.sel) return null;
    const r = 10 * this.zoom; // ~10 screen px of grab slop
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

    // Enemy spawn markers (never live Robots in edit mode).
    ctx.save();
    ctx.font = `${11 * z}px monospace`;
    ctx.textAlign = "center";
    for (const s of this.state.spawns) {
      ctx.globalAlpha = s.z === this.player.z ? 0.95 : 0.35;
      const t = ENEMY_TYPES[s.type];
      ctx.beginPath();
      ctx.arc(s.pos.x, s.pos.y, BODY_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = t ? t.color : "#e05555";
      ctx.fill();
      ctx.lineWidth = 2 * z;
      ctx.strokeStyle = "#16181c";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.fillText(`${s.type} z${s.z}`, s.pos.x, s.pos.y - BODY_RADIUS - 6 * z);
    }
    ctx.restore();

    // Selection outline + resize handles.
    if (this.sel) {
      const e = this.sel.e;
      ctx.save();
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 2 * z;
      ctx.setLineDash([6 * z, 4 * z]);
      if (this.sel.def.shape === "rect") {
        ctx.strokeRect(e.pos.x - e.w / 2, e.pos.y - e.h / 2, e.w, e.h);
        ctx.setLineDash([]);
        ctx.fillStyle = SEL_COLOR;
        const hs = 4.5 * z;
        for (const h of this.handles(e)) ctx.fillRect(h.p.x - hs, h.p.y - hs, hs * 2, hs * 2);
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

    panel.append(this.mk("div", "font-weight:bold;font-size:13px;", "LEVEL EDITOR"));
    this.status = this.mk("div", "opacity:0.8;");
    panel.append(this.status);
    panel.append(
      this.mk(
        "div",
        "opacity:0.5;font-size:11px;line-height:1.5;",
        "wasd fly · shift fast · wheel zoom · [ ] z-level · click select · " +
          "drag move · handles resize · del delete · esc/right-click cancel · g snap",
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

    // Inspector (rebuilt per selection).
    panel.append(this.header("selection"));
    this.inspector = this.mk("div", "display:flex;flex-direction:column;gap:4px;");
    panel.append(this.inspector);
    this.renderInspector();

    // Level string I/O.
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

    document.body.append(panel);
  }

  private setTool(def: EntityDef | null): void {
    this.tool = def;
    for (const [key, b] of this.toolButtons) {
      const active = (def ? def.kind : null) === key;
      b.style.background = active ? SEL_COLOR : "#23262c";
      b.style.color = active ? "#10140f" : "#dfe2e8";
    }
  }

  private select(sel: Selection | null): void {
    this.sel = sel;
    this.renderInspector();
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

    this.inspector.append(
      this.numRow("x", () => e.pos.x, (v) => (e.pos = vec(v, e.pos.y))),
      this.numRow("y", () => e.pos.y, (v) => (e.pos = vec(e.pos.x, v))),
    );
    if (def.shape === "rect") {
      this.inspector.append(
        this.numRow("w", () => e.w, (v) => (e.w = Math.max(MIN_SIZE, v))),
        this.numRow("h", () => e.h, (v) => (e.h = Math.max(MIN_SIZE, v))),
      );
    }
    for (const f of def.fields) this.inspector.append(this.fieldRow(f, e));

    this.inspector.append(this.btn("Delete", () => this.deleteSel()));
  }

  /** Build the input widget for one FieldDef — the inspector is fully schema-driven. */
  private fieldRow(f: FieldDef, e: any): HTMLElement {
    const css = Editor.INPUT_CSS + "flex:1;min-width:0;";
    const commit = (v: unknown): void => {
      f.set(e, v);
      this.refreshWorld();
    };

    switch (f.type) {
      case "number": {
        const i = this.mk("input", css);
        i.type = "number";
        i.step = "any";
        i.value = String((f.get(e) as number) ?? 0);
        i.oninput = () => {
          const v = parseFloat(i.value);
          if (Number.isFinite(v)) commit(v);
        };
        return this.row(f.key, i);
      }
      case "checkbox": {
        const i = this.mk("input", "");
        i.type = "checkbox";
        i.checked = !!f.get(e);
        i.onchange = () => commit(i.checked);
        return this.row(f.key, i);
      }
      case "color": {
        const i = this.mk("input", css + "padding:0;height:22px;");
        i.type = "color";
        i.value = String(f.get(e) ?? "#ffffff");
        i.oninput = () => commit(i.value);
        return this.row(f.key, i);
      }
      case "text": {
        const i = this.mk("input", css);
        i.type = "text";
        i.value = String(f.get(e) ?? "");
        i.oninput = () => commit(i.value);
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
        s.onchange = () => commit(s.value);
        return this.row(f.key, s);
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
          try {
            commit(txt === "" ? undefined : JSON.parse(txt));
            i.style.borderColor = "#3a3e46";
          } catch {
            i.style.borderColor = "#d05050";
          }
        };
        return this.row(f.key, i);
      }
    }
  }
}
