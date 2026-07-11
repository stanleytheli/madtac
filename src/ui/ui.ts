/**
 * Screen-space HUD primitives. Drawn unscaled (after the camera transform is
 * restored), in CSS pixels around the screen center.
 */

import type { Character } from "../entities/actor.ts";
import type { Armor } from "../entities/armor.ts";
import type { GamemodeHud, PlayerRow } from "../gamemodes/gamemode.ts";
import type { Gun } from "../entities/gun.ts";
import { armorIcon, assetImage, gunIcon, utilityIcon } from "../entities/item.ts";
import { Minimap, type DeathMark } from "./minimap.ts";
import type { Vec2 } from "../engine/vec.ts";

/** Uniform downscale for the whole screen-space HUD (1 = original size). */
export const UI_SCALE = 0.8;

/** Shared transparency for every dark HUD squircle backdrop — tune here. */
const SQUIRCLE_ALPHA = 0.4;
const SQUIRCLE_BG = `rgba(0, 0, 0, ${SQUIRCLE_ALPHA})`;

/** One font family for all canvas-drawn UI — tune here. (The top-left controls
 *  hint is its own monospace element in index.html and is left alone.) */
const UI_FONT_FAMILY = "system-ui, sans-serif";
/** Build a canvas font string with the shared family, e.g. uiFont("bold 15px"). */
const uiFont = (sizeWeight: string): string => `${sizeWeight} ${UI_FONT_FAMILY}`;

/** A simple static crosshair centered at (cx, cy): four ticks around a gap. */
export function drawCrosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const gap = 5; // empty space at the very center
  const len = 9; // length of each tick
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  // up / down / left / right
  ctx.moveTo(cx, cy - gap);
  ctx.lineTo(cx, cy - gap - len);
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx, cy + gap + len);
  ctx.moveTo(cx - gap, cy);
  ctx.lineTo(cx - gap - len, cy);
  ctx.moveTo(cx + gap, cy);
  ctx.lineTo(cx + gap + len, cy);
  ctx.stroke();
  ctx.restore();
}

export interface ProgressBarStyle {
  width: number;
  height: number;
  fill: string;
  bg: string;
  border: string;
}

const DEFAULT_BAR: ProgressBarStyle = {
  width: 80,
  height: 8,
  fill: "#ffffff",
  bg: SQUIRCLE_BG,
  border: "rgba(255, 255, 255, 0.7)",
};

/**
 * A general horizontal progress bar centered at (cx, cy). `fraction` is clamped
 * to [0, 1]. Reused for anything timed (reloading, healing items, etc.).
 */
export function drawProgressBar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  fraction: number,
  style: Partial<ProgressBarStyle> = {},
): void {
  const s = { ...DEFAULT_BAR, ...style };
  const f = Math.max(0, Math.min(1, fraction));
  const x = cx - s.width / 2;
  const y = cy - s.height / 2;

  ctx.save();
  ctx.fillStyle = s.bg;
  ctx.fillRect(x, y, s.width, s.height);
  ctx.fillStyle = s.fill;
  ctx.fillRect(x, y, s.width * f, s.height);
  ctx.strokeStyle = s.border;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, s.width, s.height);
  ctx.restore();
}

/**
 * Interaction prompt centered at (cx, cy): a key glyph on its own squircle (e.g.
 * "E") with a label squircle (e.g. an item name) to its right. Generic so any
 * "press X to ..." prompt can reuse it.
 */
export function drawKeyPrompt(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  key: string,
  label: string,
): void {
  const h = 30;
  const gap = 10;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const keyW = h; // square glyph
  ctx.font = uiFont("bold 15px");
  const labelW = ctx.measureText(label).width + 28;
  // const totalW = keyW + gap + labelW;
  const left = cx;
  const top = cy - h / 2;

  fillSquircle(ctx, left - 5, top - 5, keyW + 10, h + 10, 10, SQUIRCLE_BG);
  ctx.fillStyle = "#ffffff";
  ctx.font = uiFont("bold 25px");
  ctx.fillText(key, left + keyW / 2, cy + 1);

  fillSquircle(ctx, left + keyW + gap, top, labelW, h, 7, SQUIRCLE_BG);
  ctx.fillStyle = "#ffffff";
  ctx.font = uiFont("bold 15px");
  ctx.fillText(label, left + keyW + gap + labelW / 2, cy + 1);

  ctx.restore();
}

/** Fill a rounded-rect ("squircle"). Shared by the HUD so everything matches. */
export function fillSquircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Color of the health fill as a function of remaining fraction:
 *   - full       -> slightly gray (240) so "full" reads as a distinct state
 *   - 50%..full  -> white
 *   - below 50%  -> lerp white -> balanced red (255, 55, 55) toward empty
 */
function hpColor(frac: number): string {
  if (frac >= 1) return "rgb(240, 240, 240)";
  if (frac >= 0.5) return "rgb(255, 255, 255)";
  const t = 1 - frac / 0.5; // 0 at 50% HP, 1 at empty
  const gb = Math.round(255 - t * 200); // 255 -> 55
  return `rgb(255, ${gb}, ${gb})`;
}

export interface HealthBarStyle {
  width: number;
  height: number;
  radius: number;
  pad: number; // inset of the fill squircle inside the black background
  /** Fixed fill color (e.g. cyan for armor). If unset, the fill uses hpColor(). */
  fillColor?: string;
  displayLoss: boolean;
}

/**
 * The surviv-style health bar: a black squircle background with a colored
 * squircle fill that shrinks with health. Its own object (not the generic
 * progress bar) so it can grow special behaviors later (damage flash, lag bar,
 * smooth drain, etc.).
 */
export class HealthBar {
  readonly style: HealthBarStyle;
  displayFrac: number;

  constructor(style: Partial<HealthBarStyle> = {}) {
    this.style = { width: 450, height: 28, radius: 10, pad: 4, displayLoss: true, ...style };
    this.displayFrac = 1;
  }


  /** Draw centered horizontally at `cx`, with the bar's vertical center at `cy`.
   *  `projFrac` (> `frac`) draws a green "incoming heal" bar behind the fill,
   *  showing where an active regen (a syringe) will bring HP to. */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, frac: number, projFrac = 0): void {
    const f = clamp01(frac);
    const { width, height, radius, pad } = this.style;
    const x = cx - width / 2;
    const y = cy - height / 2;

    fillSquircle(ctx, x, y, width, height, radius, SQUIRCLE_BG);

    const innerH = height - pad * 2;
    const innerR = Math.max(0, radius - pad);

    if (this.style.displayLoss) {
      const fillWdisplay = (width - pad * 2) * this.displayFrac;
      if (fillWdisplay > 0) {
        fillSquircle(ctx, x + pad, y + pad, fillWdisplay, innerH, innerR, "rgb(255, 255, 255, 0.5)");
      }

      if (this.displayFrac < frac) {
        this.displayFrac = frac
      } else {
        this.displayFrac += (frac - this.displayFrac) * 0.05
        this.displayFrac -= 0.0005
      }
    }

    // Projected-heal bar (behind the fill): green up to where regen will land.
    const p = clamp01(projFrac);
    if (p > f) {
      const projW = (width - pad * 2) * p;
      fillSquircle(ctx, x + pad, y + pad, projW, innerH, innerR, "rgba(91, 214, 107, 0.2)");
    }

    const fillW = (width - pad * 2) * f;
    if (fillW > 0) {
      fillSquircle(ctx, x + pad, y + pad, fillW, innerH, innerR, this.style.fillColor ?? hpColor(f));
    }

  }
}

// --- full HUD layout -------------------------------------------------------
// Everything the HUD needs to draw a frame, passed in so ui.ts stays decoupled
// from the game loop's module-level state.
export interface HudOptions {
  w: number;
  h: number;
  center: Vec2;
  player: Character;
  healthBar: HealthBar;
  /** Cyan bar shown above the health bar when the player is wearing armor. */
  armorBar: HealthBar;
  mouse: Vec2;
  /** Label for the "press E" pickup prompt, or null when nothing is reachable. */
  interactableLabel: string | null;
  /** The active gamemode's scoreboard + banner, or undefined for no gamemode UI. */
  gamemode?: GamemodeHud;
  /** Whether to show the full K/D player list (Tab held). */
  showScoreboard?: boolean;
  /** Bottom-left minimap (built once at load), plus the live roster + recent
   *  friendly deaths it overlays. Undefined in the editor / when unavailable. */
  minimap?: Minimap;
  characters?: readonly Character[];
  deaths?: readonly DeathMark[];
}

/** Logical-px margin of the bottom-left minimap from the screen edges. */
const MINIMAP_MARGIN = 16;

/**
 * Draw the whole screen-space HUD: pickup prompt, the bottom health bar with the
 * ammo readout above it, the crosshair (at the mouse) with the reload/draw timer
 * under it, and the bottom-right loadout panel.
 */
export function drawHud(ctx: CanvasRenderingContext2D, o: HudOptions): void {
  const { player, healthBar, armorBar } = o;
  const gun = player.gun;

  // Everything is drawn in "logical" units then uniformly scaled down. Working in
  // logical space (screen / UI_SCALE) keeps each element anchored to its screen edge
  // — bottom-center stays centered, bottom-right stays in the corner — just smaller.
  ctx.save();
  ctx.scale(UI_SCALE, UI_SCALE);
  const w = o.w / UI_SCALE;
  const h = o.h / UI_SCALE;
  const center = { x: o.center.x / UI_SCALE, y: o.center.y / UI_SCALE };
  const mouse = { x: o.mouse.x / UI_SCALE, y: o.mouse.y / UI_SCALE };

  // Pickup prompt, just above the player (who is at screen center).
  if (o.interactableLabel) {
    drawKeyPrompt(ctx, center.x + 15, center.y + 60, "E", o.interactableLabel);
  }

  // Bottom block, stacked upward: health bar, then the armor bar (only when worn),
  // then the ammo readout above whichever bar is topmost.
  const BAR_GAP = 5;
  const barCx = w / 2;
  const healthCy = h - 28 - healthBar.style.height / 2;
  let topEdge = healthCy - healthBar.style.height / 2;

  // Green "incoming heal" projection from an active regen (syringe).
  const projFrac =
    player.regenTicks > 0 ? (player.hp + player.regenRate * player.regenTicks) / player.maxHp : 0;
  healthBar.draw(ctx, barCx, healthCy, player.hp / player.maxHp, projFrac);

  const armor = player.armor;
  const armorCy = topEdge - BAR_GAP - armorBar.style.height / 2;
  topEdge = armorCy - armorBar.style.height / 2;

  if (armor) {
    armorBar.draw(ctx, barCx, armorCy, armor.hp / armor.spec.maxHp);
  }

  drawAmmo(ctx, gun, barCx, topEdge - 12);

  // Crosshair tracks the mouse; the reload/draw/heal timer sits just under it.
  drawCrosshair(ctx, mouse.x, mouse.y);
  if (player.usingUtility) drawProgressBar(ctx, mouse.x, mouse.y + 30, player.useProgress, { fill: "#5bd66b" });
  else if (gun.reloading) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.reloadProgress);
  else if (gun.drawing) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.drawProgress);

  drawLoadout(ctx, player, w, h);

  // Bottom-left minimap; the gamemode ticket bars stack above it.
  let gamemodeInset = 0;
  if (o.minimap && o.characters) {
    const px = o.minimap.px;
    o.minimap.draw(ctx, MINIMAP_MARGIN, h - MINIMAP_MARGIN - px, o.characters, o.deaths ?? [], player, o.gamemode?.points);
    gamemodeInset = px + MINIMAP_MARGIN;
  }

  if (o.gamemode) drawGamemodeHud(ctx, o.gamemode, w, h, gamemodeInset);
  if (o.showScoreboard && o.gamemode?.players) drawScoreboard(ctx, o.gamemode.players, w, h);

  ctx.restore();
}

/**
 * The Tab scoreboard: a centered panel listing every combatant's callsign and
 * K/D, grouped by team (blue then red) and ranked by kills. The human's own row
 * is highlighted. Drawn in logical HUD units.
 */
function drawScoreboard(ctx: CanvasRenderingContext2D, players: PlayerRow[], w: number, h: number): void {
  const rows = [...players].sort((a, b) => {
    if (a.team !== b.team) return a.team < b.team ? -1 : 1; // blue before red
    return b.kills - a.kills;
  });

  const PANEL_W = 460;
  const ROW_H = 26;
  const HEAD_H = 40;
  const panelH = HEAD_H + rows.length * ROW_H + 14;
  const x = (w - PANEL_W) / 2;
  const y = (h - panelH) / 2;

  fillSquircle(ctx, x, y, PANEL_W, panelH, 0, "rgba(0,0,0,0.78)");

  const padX = 22;
  const kCol = x + PANEL_W - 130;
  const dCol = x + PANEL_W - 60;

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = uiFont("bold 13px");
  ctx.fillText("SCOREBOARD", x + padX, y + 20);
  ctx.textAlign = "right";
  ctx.fillText("K", kCol + 14, y + 20);
  ctx.fillText("D", dCol + 14, y + 20);

  let ry = y + HEAD_H + ROW_H / 2;
  let i = 0;
  for (const r of rows) {
    if (r.isPlayer) {
      fillSquircle(ctx, x + 8, ry - ROW_H / 2 + 2, PANEL_W - 16, ROW_H - 4, 0, "rgba(255,255,255,0.10)");
    }
    if (i % 2 == 0) {
      fillSquircle(ctx, x + 8, ry - ROW_H / 2, PANEL_W - 16, ROW_H, 0, "rgba(255,255,255,0.05)");
    }
    
    // Team color dot + name.
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(x + padX + 5, ry, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = r.isPlayer ? "#ffffff" : "#d7dbe2";
    ctx.font = uiFont(`${r.isPlayer ? "bold " : ""}15px`);
    ctx.fillText(r.isPlayer ? `${r.name} (you)` : r.name, x + padX + 18, ry + 1);
    ctx.textAlign = "right";
    ctx.fillStyle = "#d7dbe2";
    ctx.font = uiFont("15px");
    ctx.fillText(String(r.kills), kCol + 14, ry + 1);
    ctx.fillText(String(r.deaths), dCol + 14, ry + 1);
    ry += ROW_H;

    i++;
  }
}

/**
 * The gamemode overlay: bare-bones ticket bars stacked in the bottom-left (one
 * per team, filled to remaining/limit in the team color with a numeric label)
 * and a centered banner for win/lose + respawn text. Drawn in logical HUD units.
 */
function drawGamemodeHud(
  ctx: CanvasRenderingContext2D,
  hud: GamemodeHud,
  w: number,
  h: number,
  bottomInset = 0,
): void {
  const BAR_W = 240;
  const BAR_H = 18;
  const GAP = 8;
  const MARGIN = 24;
  // Bottom-anchored bits stack up from here — lifted above the minimap when one
  // is present (the centered banner still uses the true screen center).
  const bottom = h - bottomInset;

  ctx.font = uiFont("bold 17px");
  ctx.textAlign = "left";
  ctx.fillStyle = "rgb(0,0,0)";
  ctx.fillText(`${hud.name}`, MARGIN + 1, bottom - MARGIN - BAR_H * hud.scores.length - 19)
  ctx.fillStyle = "rgb(255,255,255)";
  ctx.fillText(`${hud.name}`, MARGIN, bottom - MARGIN - BAR_H * hud.scores.length - 20)

  ctx.textBaseline = "middle";
  // First score on top: lay them out upward from the bottom edge.
  let y = bottom - MARGIN - BAR_H;
  for (let i = hud.scores.length - 1; i >= 0; i--) {
    const s = hud.scores[i];
    const frac = s.limit > 0 ? clamp01(s.remaining / s.limit) : 0;
    
    // fillSquircle(ctx, MARGIN, y, BAR_W, BAR_H, 0, SQUIRCLE_BG);
    if (frac > 0) fillSquircle(ctx, MARGIN, y, BAR_W * frac, BAR_H, 0, s.color);
    ctx.font = uiFont("bold 17px");
    ctx.textAlign = "left";
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillText(`${s.remaining}`, MARGIN + BAR_W * frac + 9, y + BAR_H / 2 + 2);
    ctx.fillStyle = s.color;
    ctx.fillText(`${s.remaining}`, MARGIN + BAR_W * frac + 8, y + BAR_H / 2 + 1);
    y -= BAR_H + GAP;
  }

  if (hud.banner) {
    const lines = hud.banner.split("\n");
    ctx.textAlign = "center";
    let ly = h / 2 - (lines.length - 1) * 18;
    for (let i = 0; i < lines.length; i++) {
      ctx.font = uiFont(i === 0 ? "bold 52px" : "bold 20px");
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(lines[i], w / 2 + 2, ly + 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(lines[i], w / 2, ly);
      ly += i === 0 ? 46 : 26;
    }
  }
}

// Loadout panel, bottom-right: primary + secondary weapon slots stacked. The
// worn-armor slot (when armed) is a small square just left of that column, sitting
// in the gap between the centered health bar and the weapons.
const SLOT_W = 190;
const SLOT_H = 72;
const SLOT_GAP = 8;
const SLOT_MARGIN = 22;
const ARMOR_SQ = 68; // side length of the square armor slot
const HALF_H = 54; // height of the compact melee/utility row (slots 3 & 4)

/** Which panel slot a point is over (see hudHitTest). The weapon slots (1/2) and
 *  armor are droppable; melee (3, fists) is not; utility (4) drops one. */
export type SlotKind = "primary" | "secondary" | "armor" | "melee" | "utility";

interface SlotRect {
  kind: SlotKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The panel slot rectangles in *logical* HUD units (pre-UI_SCALE): the two weapon
 * slots stacked in the bottom-right corner (primary on top), plus — when worn — a
 * small square armor slot just to their left, bottom-aligned. Shared by drawing and
 * hit-testing so they can't drift apart.
 */
function loadoutRects(player: Character, w: number, h: number): SlotRect[] {
  const wx = w - SLOT_MARGIN - SLOT_W; // weapon-column left edge
  const rects: SlotRect[] = [];

  // Bottom-aligned column, top to bottom: primary (1), secondary (2), then a
  // compact row holding melee (3) and utility (4) side-by-side at half width.
  const halfW = (SLOT_W - SLOT_GAP) / 2;
  const halfY = h - SLOT_MARGIN - HALF_H;
  const secY = halfY - SLOT_GAP - SLOT_H;
  const priY = secY - SLOT_GAP - SLOT_H;

  rects.push({ kind: "primary", x: wx, y: priY, w: SLOT_W, h: SLOT_H });
  rects.push({ kind: "secondary", x: wx, y: secY, w: SLOT_W, h: SLOT_H });
  rects.push({ kind: "melee", x: wx, y: halfY, w: halfW, h: HALF_H });
  rects.push({ kind: "utility", x: wx + halfW + SLOT_GAP, y: halfY, w: halfW, h: HALF_H });

  if (player.armor) {
    rects.push({
      kind: "armor",
      x: wx - SLOT_GAP - ARMOR_SQ - 100, // just left of the weapon column
      y: h - SLOT_MARGIN - ARMOR_SQ, // bottom-aligned with the panel
      w: ARMOR_SQ,
      h: ARMOR_SQ,
    });
  }
  return rects;
}

function drawLoadout(ctx: CanvasRenderingContext2D, player: Character, w: number, h: number): void {
  const eq = player.equippedSlot;
  for (const r of loadoutRects(player, w, h)) {
    if (r.kind === "armor") {
      drawArmorSlot(ctx, r.x, r.y, r.w, player.armor!);
    } else if (r.kind === "primary" || r.kind === "secondary") {
      const gun = player.slots[r.kind];
      const key = r.kind === "primary" ? "1" : "2";
      drawLoadoutSlot(ctx, r.x, r.y, key, gun, eq === r.kind);
    } else if (r.kind === "melee") {
      drawMeleeSlot(ctx, r.x, r.y, r.w, r.h, eq === "hand");
    } else {
      drawUtilitySlot(ctx, r.x, r.y, r.w, r.h, player, eq === "utility");
    }
  }
}

/** Shared chrome for a compact (half-size) slot: backdrop, equipped outline, and
 *  the hotkey badge in the top-left. Returns nothing — the caller fills content. */
function drawCompactSlotChrome(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  key: string,
  equipped: boolean,
): void {
  fillSquircle(ctx, x, y, w, h, 8, SQUIRCLE_BG);
  if (equipped) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, w - 2, h - 2, 8);
    ctx.stroke();
  }
  ctx.save();
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = uiFont("bold 13px");
  ctx.fillStyle = equipped ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
  ctx.fillText(key, x + 8, y + 6);
  ctx.restore();
}

/** Draw a fitted icon centered in a box (longest side = `maxPx`). */
function drawIconCentered(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  maxPx: number,
): void {
  const k = maxPx / Math.max(img.naturalWidth, img.naturalHeight);
  const iw = img.naturalWidth * k;
  const ih = img.naturalHeight * k;
  ctx.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih);
}

/** Slot 3 — melee (the fists). Icon + hotkey; no name/count (there's one melee). */
function drawMeleeSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  equipped: boolean,
): void {
  drawCompactSlotChrome(ctx, x, y, w, h, "3", equipped);
  const img = assetImage("fists.svg");
  if (img) drawIconCentered(ctx, img, x + w / 2, y + h / 2 + 4, h * 0.6);
}

/** Slot 4 — utility belt. The selected item's icon, hotkey, and a carry count. */
function drawUtilitySlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  player: Character,
  equipped: boolean,
): void {
  drawCompactSlotChrome(ctx, x, y, w, h, "4", equipped);
  const spec = player.currentUtility;
  if (!spec) return;
  const img = utilityIcon(spec);
  if (img) drawIconCentered(ctx, img, x + w / 2, y + h / 2 + 4, h * 0.6);

  // Carry count, bottom-right.
  ctx.save();
  ctx.textBaseline = "bottom";
  ctx.textAlign = "right";
  ctx.font = uiFont("bold 14px");
  ctx.fillStyle = equipped ? "#ffffff" : "rgba(255, 255, 255, 0.8)";
  ctx.fillText(`x${player.currentUtilityCount}`, x + w - 8, y + h - 6);
  ctx.restore();
}

/**
 * Which panel slot the screen-space `point` is over, or null. Accounts for UI_SCALE
 * (the panel is drawn scaled), so the caller can pass a raw mouse position.
 */
export function hudHitTest(point: Vec2, w: number, h: number, player: Character): SlotKind | null {
  const px = point.x / UI_SCALE;
  const py = point.y / UI_SCALE;
  for (const r of loadoutRects(player, w / UI_SCALE, h / UI_SCALE)) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.kind;
  }
  return null;
}

/** The worn-armor slot: a small square with the sprite centered and a "Level x" tag. */
function drawArmorSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  armor: Armor,
): void {
  fillSquircle(ctx, x, y - 12, size, size + 12, 8, SQUIRCLE_BG);

  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const cx = x + size / 2;

  // Sprite, centered a little high to leave room for the label.
  const img = armorIcon(armor.spec);
  if (img) {
    const k = 0.22
    const iw = img.naturalWidth * k;
    const ih = img.naturalHeight * k;
    ctx.drawImage(img, cx - iw / 2, y + size / 2 - ih / 2 - 14, iw, ih);
  }

  ctx.font = uiFont("bold 12px");
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";

  let armor_roman = ""
  if (armor.level == 1) armor_roman = "I"
  if (armor.level == 2) armor_roman = "II"
  if (armor.level == 3) armor_roman = "III"
  if (armor.level == 4) armor_roman = "IV"

  ctx.fillText(`Level ${armor_roman}`, cx, y + size - 12);
  ctx.restore();
}

function drawLoadoutSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  key: string,
  gun: Gun | null,
  equipped: boolean,
): void {
  fillSquircle(ctx, x, y, SLOT_W, SLOT_H, 10, SQUIRCLE_BG);
  if (equipped) {
    // Highlight the held weapon with a soft outline.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, SLOT_W - 2, SLOT_H - 2, 10);
    ctx.stroke();
  }

  ctx.save();
  ctx.textBaseline = "middle";
  const cy = y + SLOT_H / 2;

  // Hotkey badge on the left (shown even for empty slots).
  ctx.textAlign = "left";
  ctx.font = uiFont("bold 15px");
  ctx.fillStyle = equipped ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
  ctx.fillText(key, x + 12, cy + 1);

  if (gun) {
    // Weapon name, centered under the icon.
    ctx.font = uiFont("bold 15px");
    ctx.fillStyle = equipped ? "#ffffff" : "rgba(255, 255, 255, 0.8)";
    const gunName = gun.spec.name;
    const gunNameW = ctx.measureText(gunName).width;
    ctx.fillText(gunName, x + SLOT_W / 2 - gunNameW / 2, cy + 18);

    // Icon centered above the name.
    const img = gunIcon(gun.spec);
    if (img) {
      const k = 0.35;
      const iw = img.naturalWidth * k;
      const ih = img.naturalHeight * k;
      ctx.translate(x + SLOT_W / 2, cy);
      ctx.drawImage(img, -iw / 2, -ih + 6, iw, ih);
    }
  }
  ctx.restore();
}

// Ammo readout above the HP bar: the big mag count on a black squircle (centered
// at `cx`), with the spare-mag count on its own smaller squircle to the right,
// bottom-aligned with the mag squircle. `bottom` is the shared bottom edge.
// Melee weapons (fists) carry no ammo, so nothing is drawn for them.
function drawAmmo(ctx: CanvasRenderingContext2D, gun: Gun, cx: number, bottom: number): void {
  if (!gun.spec.fire || gun.spec.melee) return;

  ctx.save();
  ctx.textBaseline = "middle";

  // Mag squircle, centered, width sized to its number (min square-ish).
  const magH = 46;
  const magTop = bottom - magH;
  ctx.font = uiFont("bold 34px");
  const magText = String(gun.mag);
  const magW = Math.max(magH, ctx.measureText(magText).width + 28);
  const magLeft = cx - magW / 2;

  fillSquircle(ctx, magLeft, magTop, magW, magH, 12, SQUIRCLE_BG);
  ctx.textAlign = "center";
  ctx.fillStyle = gun.mag === 0 ? "#ff6b6b" : "#ffffff";
  ctx.fillText(magText, cx, magTop + magH / 2 + 1);

  // Reserve squircle to the right, sharing the same bottom edge.
  if (gun.reserveMags > 0) {
    const resH = 32;
    const resTop = bottom - resH;
    ctx.font = uiFont("bold 22px");
    const resText = String(gun.reserveMags);
    const resW = Math.max(resH, ctx.measureText(resText).width + 20);
    const resLeft = magLeft + magW + 10;

    fillSquircle(ctx, resLeft, resTop, resW, resH, 9, SQUIRCLE_BG);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(resText, resLeft + resW / 2, resTop + resH / 2 + 1);
  }
  ctx.restore();
}
