/**
 * The settings menu: a centered DOM panel (like the respawn screen — real
 * sliders and colour pickers beat hit-testing canvas rectangles) that edits
 * the live `settings` object in place. Escape toggles it; the match pauses
 * while it is open (see frame() in main.ts).
 *
 * Three tabs: Audio, Crosshair, Controls. Every control writes straight into
 * `settings`, saves, and repaints. The HUD reads `settings.crosshair` each
 * frame, so the real crosshair under the panel updates live too; the preview
 * box just makes the change easy to see on both a dark and a pale ground.
 */
import { drawCrosshair, UI_SCALE } from "./ui.ts";
import { keyLabel } from "../engine/input.ts";
import {
  ACTIONS,
  applySettings,
  CROSSHAIR_RANGES,
  CROSSHAIR_SHAPES,
  resetSettings,
  saveSettings,
  settings,
  type Action,
  type CrosshairShape,
  type CrosshairStyle,
} from "../settings.ts";

const SETTINGS_CSS = `
#settings-panel {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: none; flex-direction: column; gap: 14px; z-index: 30;
  width: min(560px, 94vw); max-height: 92vh;
  padding: 18px 22px 16px; box-sizing: border-box;
  background: rgba(14, 16, 20, 0.93);
  border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  color: #dfe2e8; font: 13px system-ui, sans-serif; user-select: none;
}
#settings-panel.is-open { display: flex; }
.st-title { font: bold 26px system-ui, sans-serif; letter-spacing: 4px; text-align: center; }
.st-tabs { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; }
.st-tab {
  padding: 8px; font: bold 12px system-ui, sans-serif; letter-spacing: 1.5px; text-transform: uppercase;
  color: #dde1e7; cursor: pointer; background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
}
.st-tab:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
.st-tab.is-active { background: rgba(61, 220, 255, 0.3); border-color: #3ddcff; color: #fff; }
/* One page per tab; the pages share a fixed-height scroller so the panel
   doesn't resize as you switch. */
.st-pages { height: min(400px, 60vh); overflow-y: auto; overscroll-behavior: contain; padding-right: 6px;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.32) rgba(255, 255, 255, 0.06); }
.st-page { display: none; flex-direction: column; gap: 12px; }
.st-page.is-active { display: flex; }
.st-section { font-weight: bold; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.5; margin-top: 4px; }
.st-row { display: grid; grid-template-columns: 150px 1fr 52px; align-items: center; gap: 12px; }
.st-row.is-off { opacity: 0.35; pointer-events: none; }
.st-row label { font-size: 12.5px; }
.st-row .st-val { text-align: right; font-variant-numeric: tabular-nums; opacity: 0.75; }
.st-row input[type=range] { width: 100%; accent-color: #3ddcff; }
.st-row input[type=checkbox] { justify-self: start; width: 16px; height: 16px; accent-color: #3ddcff; }
.st-colors { display: grid; grid-template-columns: 150px auto 1fr auto; align-items: center; gap: 12px; }
.st-colors label { font-size: 12.5px; }
.st-colors .st-sub { text-align: right; font-size: 12.5px; }
.st-colors input[type=color] {
  width: 46px; height: 26px; padding: 0; border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px; background: none; cursor: pointer;
}
.st-choices { display: flex; gap: 8px; flex-wrap: wrap; }
.st-choice {
  padding: 7px 12px; font: inherit; color: #dde1e7; cursor: pointer;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px;
}
.st-choice:hover { background: rgba(255, 255, 255, 0.26); color: #fff; }
.st-choice.is-selected { background: rgba(61, 220, 255, 0.3); border-color: #3ddcff; color: #fff; }
.st-shape { padding: 4px; }
.st-shape canvas { display: block; width: 72px; height: 48px; border-radius: 5px; }
.st-preview { display: block; width: 100%; height: 110px; border-radius: 9px; flex: none; }
/* A binding: the key on a button; click it, press the new key. */
.st-key { justify-self: start; min-width: 110px; text-align: center; }
.st-key.is-capturing { background: rgba(255, 200, 61, 0.3); border-color: #ffc83d; color: #fff; }
.st-actions { display: grid; grid-template-columns: auto 1fr; gap: 10px; margin-top: 4px; }
.st-reset {
  padding: 0 16px; font: bold 13px system-ui, sans-serif; letter-spacing: 1px; cursor: pointer;
  color: #dde1e7; background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px;
}
.st-reset:hover { background: rgba(255, 255, 255, 0.26); color: #fff; }
.st-close {
  padding: 12px; border: 0; border-radius: 10px;
  font: bold 15px system-ui, sans-serif; letter-spacing: 1px;
  background: #1f6f3a; color: #eaffef; cursor: pointer;
}
.st-close:hover { background: #2a8c4b; }
.st-hint { text-align: center; font-size: 11px; opacity: 0.4; }
`;

function installSettingsCss(): void {
  if (document.getElementById("settings-css")) return;
  const style = document.createElement("style");
  style.id = "settings-css";
  style.textContent = SETTINGS_CSS;
  document.head.append(style);
}

export interface SettingsMenu {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

/** Preview spread sweep: 0 -> this and back, so "weapon spread" mode shows what
 *  it means without having to fire anything. Roughly a rifle mid-spray. */
const PREVIEW_SPREAD_RAD = 0.12;
const PREVIEW_PERIOD_MS = 2400;

/** Size `cv`'s bitmap to its CSS box at device resolution and return a context
 *  working in CSS px, or null while the canvas is not laid out (tab hidden). */
function fitCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w === 0 || h === 0) return null;
  const bw = Math.floor(w * dpr);
  const bh = Math.floor(h * dpr);
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** Draw `style` at (cx, cy) in CSS px, at the HUD's UI scale so it is the size
 *  it will be in play. */
function drawStyleAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, style: CrosshairStyle, spread: number): void {
  ctx.save();
  ctx.scale(UI_SCALE, UI_SCALE);
  drawCrosshair(ctx, cx / UI_SCALE, cy / UI_SCALE, spread, style);
  ctx.restore();
}

/**
 * Build the panel (once), bind Escape to it, and return its controller.
 * Nothing here touches the game: the match pauses while the panel is open
 * because main's frame loop asks isOpen(), not because the panel tells it to.
 */
export function buildSettingsMenu(): SettingsMenu {
  installSettingsCss();
  const c: CrosshairStyle = settings.crosshair;
  /** Every control's "read the settings back into the widget" step. */
  const painters: (() => void)[] = [];
  const paint = (): void => {
    for (const p of painters) p();
  };
  /** After any edit: persist, push to the engine, refresh the widgets. */
  const changed = (): void => {
    saveSettings();
    applySettings();
    paint();
  };

  const panel = document.createElement("div");
  panel.id = "settings-panel";
  // A game menu: no browser context menu, so right-click can be bound.
  panel.addEventListener("contextmenu", (e) => e.preventDefault());

  const title = document.createElement("div");
  title.className = "st-title";
  title.textContent = "SETTINGS";
  panel.append(title);

  // --- tabs ------------------------------------------------------------------
  const tabBar = document.createElement("div");
  tabBar.className = "st-tabs";
  const pages = document.createElement("div");
  pages.className = "st-pages";
  panel.append(tabBar, pages);
  const tabs: { btn: HTMLButtonElement; page: HTMLElement }[] = [];
  let activeTab = 0;
  const showTab = (i: number): void => {
    activeTab = i;
    tabs.forEach((t, j) => {
      t.btn.classList.toggle("is-active", j === i);
      t.page.classList.toggle("is-active", j === i);
    });
    paint(); // canvases on the page just shown had no layout box until now
  };
  /** Where the widget builders below append: the page being built. */
  let into: HTMLElement = panel;
  const tab = (name: string): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "st-tab";
    btn.textContent = name;
    const page = document.createElement("div");
    page.className = "st-page";
    const i = tabs.length;
    btn.onclick = () => showTab(i);
    tabs.push({ btn, page });
    tabBar.append(btn);
    pages.append(page);
    into = page;
  };

  // --- widget builders -------------------------------------------------------
  const section = (label: string): void => {
    const el = document.createElement("div");
    el.className = "st-section";
    el.textContent = label;
    into.append(el);
  };

  /** A labelled slider with a live readout. `get`/`set` bind it to a settings
   *  field; `fmt` renders the readout; `enabled` greys the row out when the
   *  field doesn't apply (the fixed gap in spread mode). */
  const slider = (
    label: string,
    [min, max, step]: [number, number, number],
    get: () => number,
    set: (v: number) => void,
    fmt: (v: number) => string = (v) => String(v),
    enabled: () => boolean = () => true,
  ): void => {
    const row = document.createElement("div");
    row.className = "st-row";
    const lab = document.createElement("label");
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = document.createElement("span");
    val.className = "st-val";
    input.oninput = () => {
      set(Number(input.value));
      changed();
    };
    row.append(lab, input, val);
    into.append(row);
    painters.push(() => {
      input.value = String(get());
      val.textContent = fmt(get());
      row.classList.toggle("is-off", !enabled());
    });
  };

  /** A labelled checkbox bound to a boolean field. */
  const checkbox = (label: string, get: () => boolean, set: (v: boolean) => void): void => {
    const row = document.createElement("div");
    row.className = "st-row";
    const lab = document.createElement("label");
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.onchange = () => {
      set(input.checked);
      changed();
    };
    row.append(lab, input);
    into.append(row);
    painters.push(() => {
      input.checked = get();
    });
  };

  /** A row of mutually exclusive buttons bound to a string field. */
  const choices = <T extends string>(
    items: { key: T; name: string }[],
    get: () => T,
    set: (v: T) => void,
  ): void => {
    const row = document.createElement("div");
    row.className = "st-choices";
    const buttons = items.map((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "st-choice";
      b.textContent = it.name;
      b.onclick = () => {
        set(it.key);
        changed();
      };
      row.append(b);
      return b;
    });
    into.append(row);
    painters.push(() => {
      for (let i = 0; i < items.length; i++) buttons[i].classList.toggle("is-selected", items[i].key === get());
    });
  };

  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const px = (v: number): string => `${v}px`;

  // --- Audio -----------------------------------------------------------------
  tab("Audio");
  section("Volume");
  slider(
    "Master volume",
    [0, 1, 0.01],
    () => settings.volume,
    (v) => (settings.volume = v),
    pct,
  );

  // --- Crosshair -------------------------------------------------------------
  tab("Crosshair");
  section("Shape");
  // Shape picker: each preset drawn on its own button in the current style,
  // so the choice is made by eye. Repainted with the rest, since colour, dot
  // and widths all show in the thumbnails.
  {
    const row = document.createElement("div");
    row.className = "st-choices";
    const thumbs = CROSSHAIR_SHAPES.map((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "st-choice st-shape";
      b.title = it.name;
      const cv = document.createElement("canvas");
      b.append(cv);
      b.onclick = () => {
        c.shape = it.key;
        changed();
      };
      row.append(b);
      return { b, cv, key: it.key as CrosshairShape };
    });
    into.append(row);
    painters.push(() => {
      for (const t of thumbs) {
        t.b.classList.toggle("is-selected", t.key === c.shape);
        const fit = fitCanvas(t.cv);
        if (!fit) continue;
        fit.ctx.fillStyle = "#2b2f36";
        fit.ctx.fillRect(0, 0, fit.w, fit.h);
        drawStyleAt(fit.ctx, fit.w / 2, fit.h / 2, { ...c, shape: t.key }, 0);
      }
    });
  }

  // Preview: the crosshair drawn exactly as the HUD draws it (same routine, same
  // UI scale), over a dark/pale split so the border's job is visible.
  const preview = document.createElement("canvas");
  preview.className = "st-preview";
  into.append(preview);
  const drawPreview = (now: number): void => {
    const fit = fitCanvas(preview);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.fillStyle = "#2b2f36";
    ctx.fillRect(0, 0, w / 2, h);
    ctx.fillStyle = "#d8d2c4";
    ctx.fillRect(w / 2, 0, w / 2, h);
    // Spread sweeps only in spread mode; fixed mode is, well, fixed.
    const phase = (now % PREVIEW_PERIOD_MS) / PREVIEW_PERIOD_MS;
    const sweep = 1 - Math.abs(phase * 2 - 1); // triangle 0 -> 1 -> 0
    const spread = c.gapMode === "spread" ? PREVIEW_SPREAD_RAD * sweep : 0;
    drawStyleAt(ctx, w / 4, h / 2, c, spread);
    drawStyleAt(ctx, (3 * w) / 4, h / 2, c, spread);
  };

  section("Size");
  const R = CROSSHAIR_RANGES;
  checkbox("Center dot", () => c.dot, (v) => (c.dot = v));
  slider("Dot size", R.dotSize, () => c.dotSize, (v) => (c.dotSize = v), (v) => v.toFixed(1), () => c.dot);
  slider("Cross size", R.tickLen, () => c.tickLen, (v) => (c.tickLen = v), px);
  slider("Line width", R.tickWidth, () => c.tickWidth, (v) => (c.tickWidth = v), (v) => v.toFixed(1));

  section("Colour");
  {
    // Two colour pickers on one row.
    const colors = document.createElement("div");
    colors.className = "st-colors";
    const colorPicker = (label: string, get: () => string, set: (v: string) => void, sub = false): void => {
      const lab = document.createElement("label");
      lab.textContent = label;
      if (sub) lab.className = "st-sub";
      const input = document.createElement("input");
      input.type = "color";
      input.oninput = () => {
        set(input.value);
        changed();
      };
      colors.append(lab, input);
      painters.push(() => {
        input.value = get();
      });
    };
    colorPicker("Colour", () => c.color, (v) => (c.color = v));
    colorPicker("Border colour", () => c.borderColor, (v) => (c.borderColor = v), true);
    into.append(colors);
  }
  slider("Border size", R.border, () => c.border, (v) => (c.border = v), (v) => v.toFixed(2));
  slider("Border opacity", R.borderAlpha, () => c.borderAlpha, (v) => (c.borderAlpha = v), pct);

  section("Separation");
  choices<CrosshairStyle["gapMode"]>(
    [
      { key: "spread", name: "Weapon spread" },
      { key: "fixed", name: "Fixed" },
    ],
    () => c.gapMode,
    (v) => (c.gapMode = v),
  );
  slider("Gap", R.gap, () => c.gap, (v) => (c.gap = v), px, () => c.gapMode === "fixed");

  // --- Controls --------------------------------------------------------------
  tab("Controls");
  /** The action whose key is being captured, if any. */
  let capturing: Action | null = null;
  const endCapture = (): void => {
    capturing = null;
    paint();
  };
  /** Bind `action` to `code`. A key already on another action swaps over, so
   *  no two actions ever share a key. */
  const bind = (action: Action, code: string): void => {
    const b = settings.binds;
    const prev = b[action];
    for (const a of ACTIONS) if (a.key !== action && b[a.key] === code) b[a.key] = prev;
    b[action] = code;
    changed();
  };
  {
    let group = "";
    for (const a of ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        section(group);
      }
      const row = document.createElement("div");
      row.className = "st-row";
      const lab = document.createElement("label");
      lab.textContent = a.name;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "st-choice st-key";
      btn.onclick = () => {
        capturing = a.key;
        btn.blur(); // so Space/Enter go to the capture, not the button
        paint();
      };
      row.append(lab, btn);
      into.append(row);
      painters.push(() => {
        const on = capturing === a.key;
        btn.classList.toggle("is-capturing", on);
        btn.textContent = on ? "Press a key…" : keyLabel(settings.binds[a.key]);
      });
    }
    const note = document.createElement("div");
    note.className = "st-hint";
    note.textContent = "Click a key, then press the new one (mouse buttons work too). Esc cancels.";
    into.append(note);
  }
  // Capture listeners run in the capture phase and stop the event there, so
  // the key being bound doesn't also register as a press for the game.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key !== "Escape" && e.code) bind(capturing, e.code);
      endCapture();
    },
    { capture: true },
  );
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      bind(capturing, `Mouse${e.button}`);
      endCapture();
    },
    { capture: true },
  );

  // --- actions ---------------------------------------------------------------
  into = panel;
  const actions = document.createElement("div");
  actions.className = "st-actions";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "st-reset";
  resetBtn.textContent = "RESET ALL";
  resetBtn.title = "Back to the default settings on every tab";
  resetBtn.onclick = () => {
    resetSettings();
    paint();
  };
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "st-close";
  closeBtn.textContent = "Resume";
  actions.append(resetBtn, closeBtn);
  const hint = document.createElement("div");
  hint.className = "st-hint";
  hint.textContent = "Esc to resume";
  panel.append(actions, hint);

  document.body.append(panel);

  let open = false;
  let raf = 0;
  const tick = (now: number): void => {
    if (!open) return;
    drawPreview(now);
    raf = requestAnimationFrame(tick);
  };

  const menu: SettingsMenu = {
    isOpen: () => open,
    open() {
      if (open) return;
      open = true;
      panel.classList.add("is-open"); // before showTab: canvases need a layout box
      showTab(activeTab);
      raf = requestAnimationFrame(tick);
    },
    close() {
      if (!open) return;
      open = false;
      capturing = null;
      panel.classList.remove("is-open");
      cancelAnimationFrame(raf);
      // Drop focus from whatever slider was last touched, so play keys don't
      // land in a form field afterwards.
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    toggle() {
      if (open) menu.close();
      else menu.open();
    },
  };
  closeBtn.onclick = menu.close;
  // Esc opens/closes the menu. While a key is being captured the capture
  // listener above eats the Escape first, so it cancels the capture instead.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.toggle();
  });
  return menu;
}
