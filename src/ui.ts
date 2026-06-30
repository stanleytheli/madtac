/**
 * Screen-space HUD primitives. Drawn unscaled (after the camera transform is
 * restored), in CSS pixels around the screen center.
 */

import type { Character } from "./actor.ts";
import type { Gun } from "./gun.ts";
import { gunIcon } from "./item.ts";
import type { Vec2 } from "./vec.ts";

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
  bg: "rgba(0, 0, 0, 0.55)",
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
  ctx.font = "bold 15px system-ui, sans-serif";
  const labelW = ctx.measureText(label).width + 28;
  // const totalW = keyW + gap + labelW;
  const left = cx;
  const top = cy - h / 2;

  fillSquircle(ctx, left - 5, top - 5, keyW + 10, h + 10, 10, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 25px system-ui, sans-serif";
  ctx.fillText(key, left + keyW / 2, cy + 1);

  fillSquircle(ctx, left + keyW + gap, top, labelW, h, 7, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px system-ui, sans-serif";
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
    this.style = { width: 450, height: 28, radius: 10, pad: 4, ...style };
    this.displayFrac = 1;
  }


  /** Draw centered horizontally at `cx`, with the bar's vertical center at `cy`. */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, frac: number): void {
    const f = clamp01(frac);
    const { width, height, radius, pad } = this.style;
    const x = cx - width / 2;
    const y = cy - height / 2;

    fillSquircle(ctx, x, y, width, height, radius, "rgba(0, 0, 0, 0.6)");

    const innerH = height - pad * 2;
    const innerR = Math.max(0, radius - pad);

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

    const fillW = (width - pad * 2) * f;
    if (fillW > 0) {
      fillSquircle(ctx, x + pad, y + pad, fillW, innerH, innerR, hpColor(f));
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
  mouse: Vec2;
  /** Label for the "press E" pickup prompt, or null when nothing is reachable. */
  interactableLabel: string | null;
}

/**
 * Draw the whole screen-space HUD: pickup prompt, the bottom health bar with the
 * ammo readout above it, the crosshair (at the mouse) with the reload/draw timer
 * under it, and the bottom-right loadout panel.
 */
export function drawHud(ctx: CanvasRenderingContext2D, o: HudOptions): void {
  const { w, h, center, player, healthBar, mouse } = o;
  const gun = player.gun;

  // Pickup prompt, just above the player (who is at screen center).
  if (o.interactableLabel) {
    drawKeyPrompt(ctx, center.x + 15, center.y + 60, "E", o.interactableLabel);
  }

  // Bottom block: health bar with ammo above it.
  const barCx = w / 2;
  const barCy = h - 28 - healthBar.style.height / 2;
  const barTop = barCy - healthBar.style.height / 2;

  healthBar.draw(ctx, barCx, barCy, player.hp / player.maxHp);
  drawAmmo(ctx, gun, barCx, barTop - 12);

  // Crosshair tracks the mouse; the reload/draw timer sits just under it.
  drawCrosshair(ctx, mouse.x, mouse.y);
  if (gun.reloading) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.reloadProgress);
  else if (gun.drawing) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.drawProgress);

  drawLoadout(ctx, player, w, h);
}

// Loadout panel, bottom-right: the primary and secondary slots stacked, with the
// equipped one outlined. Empty slots show only their hotkey number.
const SLOT_W = 190;
const SLOT_H = 72;
const SLOT_GAP = 8;
const SLOT_MARGIN = 22;

function drawLoadout(ctx: CanvasRenderingContext2D, player: Character, w: number, h: number): void {
  const rows: { key: string; gun: Gun | null }[] = [
    { key: "1", gun: player.slots.primary },
    { key: "2", gun: player.slots.secondary },
  ];
  const x = w - SLOT_MARGIN - SLOT_W;
  let y = h - SLOT_MARGIN - (SLOT_H * rows.length + SLOT_GAP * (rows.length - 1));
  for (const row of rows) {
    drawLoadoutSlot(ctx, x, y, row.key, row.gun, row.gun !== null && row.gun === player.gun);
    y += SLOT_H + SLOT_GAP;
  }
}

function drawLoadoutSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  key: string,
  gun: Gun | null,
  equipped: boolean,
): void {
  fillSquircle(ctx, x, y, SLOT_W, SLOT_H, 10, "rgba(0, 0, 0, 0.5)");
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
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.fillStyle = equipped ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
  ctx.fillText(key, x + 12, cy + 1);

  if (gun) {
    // Weapon name, centered under the icon.
    ctx.font = "bold 15px system-ui, sans-serif";
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
  ctx.font = "bold 34px system-ui, sans-serif";
  const magText = String(gun.mag);
  const magW = Math.max(magH, ctx.measureText(magText).width + 28);
  const magLeft = cx - magW / 2;

  fillSquircle(ctx, magLeft, magTop, magW, magH, 12, "rgba(0, 0, 0, 0.5)");
  ctx.textAlign = "center";
  ctx.fillStyle = gun.mag === 0 ? "#ff6b6b" : "#ffffff";
  ctx.fillText(magText, cx, magTop + magH / 2 + 1);

  // Reserve squircle to the right, sharing the same bottom edge.
  if (gun.reserveMags > 0) {
    const resH = 32;
    const resTop = bottom - resH;
    ctx.font = "bold 22px system-ui, sans-serif";
    const resText = String(gun.reserveMags);
    const resW = Math.max(resH, ctx.measureText(resText).width + 20);
    const resLeft = magLeft + magW + 10;

    fillSquircle(ctx, resLeft, resTop, resW, resH, 9, "rgba(0, 0, 0, 0.5)");
    ctx.fillStyle = "#ffffff";
    ctx.fillText(resText, resLeft + resW / 2, resTop + resH / 2 + 1);
  }
  ctx.restore();
}
