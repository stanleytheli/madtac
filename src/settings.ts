/**
 * Player settings: the live values the game reads every frame, their defaults,
 * the value ranges the menu's sliders use, and the localStorage round-trip.
 *
 * The settings MENU (src/ui/settings.ts) edits `settings` in place and calls
 * saveSettings(); the HUD (drawCrosshair) and the audio engine read from it
 * directly, so a change shows up on the next frame with no plumbing.
 */
import { setMasterVolume } from "./engine/audio.ts";

/** What is drawn around the centre; the dot is a separate toggle. */
export type CrosshairShape = "cross" | "x" | "sides" | "arcs" | "circle" | "circle-cross" | "none";

/** The shape presets, in menu order. */
export const CROSSHAIR_SHAPES: { key: CrosshairShape; name: string }[] = [
  { key: "cross", name: "Cross" },
  { key: "x", name: "X" },
  { key: "sides", name: "Side ticks" },
  { key: "arcs", name: "Side arcs" },
  { key: "circle", name: "Circle" },
  { key: "circle-cross", name: "Circle + cross" },
  { key: "none", name: "Nothing" },
];

/** Everything the player can rebind. The debug keys (J/K damage, P profiler),
 *  Enter (restart / respawn) and Esc (this menu) are fixed. */
export type Action =
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "fire"
  | "reload"
  | "cancel"
  | "interact"
  | "drop"
  | "dropHud"
  | "primary"
  | "secondary"
  | "melee"
  | "utility"
  | "scoreboard";

/** The actions in menu order, grouped. */
export const ACTIONS: { key: Action; name: string; group: string }[] = [
  { key: "moveUp", name: "Move up", group: "Movement" },
  { key: "moveDown", name: "Move down", group: "Movement" },
  { key: "moveLeft", name: "Move left", group: "Movement" },
  { key: "moveRight", name: "Move right", group: "Movement" },
  { key: "fire", name: "Fire / use item", group: "Combat" },
  { key: "reload", name: "Reload", group: "Combat" },
  { key: "cancel", name: "Cancel reload / use", group: "Combat" },
  { key: "interact", name: "Pick up / enter vehicle", group: "Combat" },
  { key: "drop", name: "Drop held item", group: "Combat" },
  { key: "dropHud", name: "Drop from loadout (on its icon)", group: "Combat" },
  { key: "primary", name: "Primary weapon", group: "Slots" },
  { key: "secondary", name: "Secondary weapon", group: "Slots" },
  { key: "melee", name: "Melee", group: "Slots" },
  { key: "utility", name: "Utility (again to cycle)", group: "Slots" },
  { key: "scoreboard", name: "Scoreboard (hold)", group: "Other" },
];

/** Key codes (KeyboardEvent.code, or "Mouse<n>") — see engine/input.ts. */
export const DEFAULT_BINDS: Record<Action, string> = {
  moveUp: "KeyW",
  moveDown: "KeyS",
  moveLeft: "KeyA",
  moveRight: "KeyD",
  fire: "Mouse0",
  reload: "KeyR",
  cancel: "KeyX",
  interact: "KeyE",
  drop: "KeyQ",
  dropHud: "Mouse2",
  primary: "Digit1",
  secondary: "Digit2",
  melee: "Digit3",
  utility: "Digit4",
  scoreboard: "Tab",
};

export interface CrosshairStyle {
  shape: CrosshairShape;
  /** Whether the centre dot is drawn. */
  dot: boolean;
  /** Centre dot radius, logical px. */
  dotSize: number;
  /** Length of each tick, logical px. For the arcs, half the arc length. */
  tickLen: number;
  /** Stroke width of the ticks (and the ring), logical px. */
  tickWidth: number;
  /** Width of the dark border drawn under every mark, px per side. 0 = none. */
  border: number;
  /** Mark colour, #rrggbb. */
  color: string;
  /** Border colour, #rrggbb; `borderAlpha` (0..1) is its opacity. */
  borderColor: string;
  borderAlpha: number;
  /** "spread": the marks stand off centre by the aimed gun's inaccuracy.
   *  "fixed": they stand off by a constant `gap`, whatever the gun is doing. */
  gapMode: "spread" | "fixed";
  /** The stand-off in fixed mode, logical px. */
  gap: number;
}

export interface Settings {
  /** Master volume, 0..1. */
  volume: number;
  crosshair: CrosshairStyle;
  /** Action -> key code. Every action has exactly one key; no two share one. */
  binds: Record<Action, string>;
}

/** Slider ranges for every numeric crosshair field: [min, max, step]. Shared
 *  by the menu (to build the sliders) and by the loader (to clamp stored
 *  values), so the two can never disagree about what is allowed. */
export const CROSSHAIR_RANGES: Record<
  "dotSize" | "tickLen" | "tickWidth" | "border" | "borderAlpha" | "gap",
  [number, number, number]
> = {
  dotSize: [0, 8, 0.1],
  tickLen: [0, 40, 1],
  tickWidth: [1, 8, 0.5],
  border: [0, 5, 0.25],
  borderAlpha: [0, 1, 0.05],
  gap: [0, 60, 1],
};

/** Ships matching the hand-tuned crosshair the HUD always drew (see the
 *  constants that used to live in ui.ts): white 3px ticks over a 55% black
 *  border 1.25px wide, a 1.8px dot, standing off by the gun's spread. */
export const DEFAULT_SETTINGS: Settings = {
  volume: 0.5,
  crosshair: {
    shape: "cross",
    dot: true,
    dotSize: 1.8,
    tickLen: 9,
    tickWidth: 3,
    border: 1.25,
    color: "#ffffff",
    borderColor: "#000000",
    borderAlpha: 0.55,
    gapMode: "spread",
    gap: 8,
  },
  binds: { ...DEFAULT_BINDS },
};

/** The live settings. Mutate in place; never replace the object (the HUD and
 *  the menu both hold a reference to it). */
export const settings: Settings = structuredClone(DEFAULT_SETTINGS);

const STORAGE_KEY = "madtac.settings";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** `raw[key]` if it is a finite number, clamped to [lo, hi]; else `fallback`. */
function num(raw: Record<string, unknown>, key: string, lo: number, hi: number, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

/** `raw[key]` if it is a #rrggbb string; else `fallback`. */
function hex(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

/** `raw[key]` if it is one of `allowed`; else `fallback`. */
function oneOf<T extends string>(raw: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const v = raw[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Copy `src` into the live settings field by field, checking every value, so
 *  a stale or hand-edited localStorage entry can only ever fall back to a
 *  default — never put NaN or an unknown shape into the HUD. */
function assign(src: unknown): void {
  const raw = (src && typeof src === "object" ? src : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  settings.volume = num(raw, "volume", 0, 1, d.volume);
  const c = (raw.crosshair && typeof raw.crosshair === "object" ? raw.crosshair : {}) as Record<string, unknown>;
  const R = CROSSHAIR_RANGES;
  const dc = d.crosshair;
  const x = settings.crosshair;
  // The first cut baked the dot into the shape name; read those back.
  const legacy: Record<string, [CrosshairShape, boolean]> = {
    "cross-dot": ["cross", true],
    dot: ["none", true],
    "circle-dot": ["circle", true],
  };
  const old = typeof c.shape === "string" ? legacy[c.shape] : undefined;
  x.shape = old ? old[0] : oneOf(c, "shape", CROSSHAIR_SHAPES.map((s) => s.key), dc.shape);
  x.dot = old ? old[1] : typeof c.dot === "boolean" ? c.dot : dc.dot;
  x.dotSize = num(c, "dotSize", R.dotSize[0], R.dotSize[1], dc.dotSize);
  x.tickLen = num(c, "tickLen", R.tickLen[0], R.tickLen[1], dc.tickLen);
  x.tickWidth = num(c, "tickWidth", R.tickWidth[0], R.tickWidth[1], dc.tickWidth);
  x.border = num(c, "border", R.border[0], R.border[1], dc.border);
  x.color = hex(c, "color", dc.color);
  x.borderColor = hex(c, "borderColor", dc.borderColor);
  x.borderAlpha = num(c, "borderAlpha", R.borderAlpha[0], R.borderAlpha[1], dc.borderAlpha);
  x.gapMode = oneOf(c, "gapMode", ["spread", "fixed"] as const, dc.gapMode);
  x.gap = num(c, "gap", R.gap[0], R.gap[1], dc.gap);

  // Bindings: a non-empty string per action, no key used twice. A stored
  // duplicate (or a missing entry) falls back to that action's default.
  const b = (raw.binds && typeof raw.binds === "object" ? raw.binds : {}) as Record<string, unknown>;
  const used = new Set<string>();
  for (const a of ACTIONS) {
    const v = b[a.key];
    let code = typeof v === "string" && v.length > 0 && !used.has(v) ? v : DEFAULT_BINDS[a.key];
    if (used.has(code)) code = DEFAULT_BINDS[a.key]; // keep going; the menu can fix it
    settings.binds[a.key] = code;
    used.add(code);
  }
}

/** Push the settings that live outside this module (the audio level) to where
 *  they take effect. Idempotent; call after any change. */
export function applySettings(): void {
  setMasterVolume(settings.volume);
}

/** Load the stored settings (if any) into `settings` and apply them. Call once
 *  at boot. A missing or broken entry leaves the defaults in place. */
export function loadSettings(): void {
  let stored: unknown = null;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) stored = JSON.parse(text);
  } catch {
    stored = null; // no storage (private mode) or unparseable — defaults it is
  }
  assign(stored);
  applySettings();
}

export function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; the settings still hold for this session.
  }
}

/** Back to the shipped defaults, applied and saved. */
export function resetSettings(): void {
  assign(DEFAULT_SETTINGS);
  applySettings();
  saveSettings();
}
