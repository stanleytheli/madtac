/**
 * Screen-space HUD primitives. Drawn unscaled (after the camera transform is
 * restored), in CSS pixels around the screen center.
 */

import type { Character } from "../entities/actor.ts";
import type { Armor } from "../entities/armor.ts";
import { KILLFEED_TTL, type GamemodeHud, type KillFeedEntry, type PlayerRow } from "../gamemodes/gamemode.ts";
import type { Gun } from "../entities/gun.ts";
import { armorIcon, assetImage, gunIcon, OUTLINE_PX, outlinedIcon, utilityIcon, whiteIcon } from "../entities/item.ts";
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

/** Logical px the crosshair ticks retreat per radian of the aimed gun's maximum
 *  spread. Deliberately distance-independent — the marks report the weapon's
 *  angular inaccuracy, not where rounds would land at the current aim range, so
 *  the reading means the same thing wherever you point. Real guns span roughly
 *  0.01 rad (rifle at rest) to 0.28 rad (Desert Eagle mid-spray), so this maps
 *  the useful range onto about +1 to +31 px. */
const SPREAD_PX_PER_RAD = 75;
/** Ceiling on that retreat, so a future spec can't fling the marks off-screen. */
const MAX_SPREAD_PX = 60;

/** Tick geometry: white over a dark halo 1.25px wider on each side. The ticks
 *  carry the whole pointer now that the OS cursor is hidden under a match
 *  (see syncCursor in main.ts), so they are thicker than they would need to be
 *  as mere decoration around an arrow. */
const TICK_LEN = 9;
const TICK_WIDTH = 3;
const HALO_WIDTH = TICK_WIDTH + 2.5;
/** Centre dot: white core over its own dark ring, so it survives a pale floor.
 *  This dot IS the mouse pointer — it marks the exact aim point with nothing else
 *  on screen to back it up — so it is sized to be found, not just to be present. */
const DOT_R = 1.8;
const DOT_HALO_R = 3.1;
const XHAIR_INK = "#ffffff";
const XHAIR_HALO = "rgba(0, 0, 0, 0.55)";

/** Centre coordinate that renders TICK_WIDTH crisply (see drawCrosshair). Halves
 *  for an odd width, whole pixels otherwise; a fractional width can't be crisp
 *  either way, so it takes the whole-pixel case. */
function snapToPixel(v: number): number {
  const odd = Number.isInteger(TICK_WIDTH) && TICK_WIDTH % 2 === 1;
  return odd ? Math.round(v - 0.5) + 0.5 : Math.round(v);
}

/**
 * The crosshair: four ticks around a centre dot, the ticks standing off from the
 * centre by the aimed weapon's inaccuracy. `spread` is the gun's maximum aim
 * offset in radians (see Gun.maxSpread) — already smoothed by the caller, since
 * the raw value steps every shot. The centre dot stays put as the true aim point.
 *
 * Everything is drawn twice: a dark halo, then the white on top of it. The map
 * runs from near-black floors to pale concrete, and plain white loses the second
 * one — most of all the centre dot, which is the single mark that matters and was
 * the first thing to disappear. The halo costs one extra stroke and makes the
 * crosshair read the same everywhere.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  spread = 0,
): void {
  const gap = Math.min(MAX_SPREAD_PX, Math.max(0, spread) * SPREAD_PX_PER_RAD);
  // Snap so the ticks land on pixel boundaries. A stroke straddles its own
  // coordinate, so an EVEN width wants a whole-pixel centre and an ODD width
  // wants a half-pixel one; get it backwards and the line renders as two grey
  // half-covered columns instead of one crisp white one. Derived from the width
  // rather than assumed, so retuning the thickness cannot quietly blur it.
  const x = snapToPixel(cx);
  const y = snapToPixel(cy);

  ctx.save();
  ctx.lineCap = "round";
  // The four ticks, as one path stroked twice — halo underneath, ink over it.
  const ticks = new Path2D();
  ticks.moveTo(x, y - gap);
  ticks.lineTo(x, y - gap - TICK_LEN);
  ticks.moveTo(x, y + gap);
  ticks.lineTo(x, y + gap + TICK_LEN);
  ticks.moveTo(x - gap, y);
  ticks.lineTo(x - gap - TICK_LEN, y);
  ticks.moveTo(x + gap, y);
  ticks.lineTo(x + gap + TICK_LEN, y);
  ctx.strokeStyle = XHAIR_HALO;
  ctx.lineWidth = HALO_WIDTH;
  ctx.stroke(ticks);
  ctx.strokeStyle = XHAIR_INK;
  ctx.lineWidth = TICK_WIDTH;
  ctx.stroke(ticks);

  // Centre dot: with the ticks pushed out by spread, this is what still marks the
  // exact point being aimed at — so it gets the same treatment.
  ctx.fillStyle = XHAIR_HALO;
  ctx.beginPath();
  ctx.arc(x, y, DOT_HALO_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = XHAIR_INK;
  ctx.beginPath();
  ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
  ctx.fill();
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
  /** Maximum aim spread of the weapon being aimed (radians), smoothed — drives how
   *  far the crosshair ticks stand off centre. See Game.crosshairSpread. */
  spread?: number;
  /** Label for the "press E" pickup prompt, or null when nothing is reachable. */
  interactableLabel: string | null;
  /** The active gamemode's scoreboard + banner, or undefined for no gamemode UI. */
  gamemode?: GamemodeHud;
  /** Whether to show the full K/D player list (Tab held). */
  showScoreboard?: boolean;
  /** The local player's recent-kills feed (newest first), stacked above the ammo. */
  killFeed?: readonly KillFeedEntry[];
  /** Bottom-left minimap (built once at load), plus the live roster + recent
   *  friendly deaths it overlays. Undefined in the editor / when unavailable. */
  minimap?: Minimap;
  characters?: readonly Character[];
  deaths?: readonly DeathMark[];
}

/** Logical-px inset for the whole bottom-left HUD stack — the minimap and the
 *  gamemode ticket bars sitting above it. One constant so their left edges line
 *  up; nudging it moves the column as a unit. */
const HUD_MARGIN = 24;

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

  // Interaction prompts, just above the player (who is at screen center). The
  // pickup (E) prompt and the cancel (X) prompt can both be live at once — a
  // reload running while stood on an item — so they stack downward instead of
  // overlapping.
  const promptX = center.x + 15;
  let promptY = center.y + 60;
  if (o.interactableLabel) {
    drawKeyPrompt(ctx, promptX, promptY, "E", o.interactableLabel);
    promptY += 50;
  }
  const cancelLabel = player.usingUtility ? "Cancel" : gun.reloading ? "Cancel Reload" : null;
  if (cancelLabel) {
    drawKeyPrompt(ctx, promptX, promptY, "X", cancelLabel);
  }

  // Kill feed: bars centered horizontally, stacked below the interaction prompts
  // and above the bottom-center ammo. Newest on top; older bars sit below it.
  if (o.killFeed && o.killFeed.length) drawKillFeed(ctx, o.killFeed, w, center.y + 200);

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
  drawCrosshair(ctx, mouse.x, mouse.y, o.spread ?? 0);
  if (player.usingUtility) drawProgressBar(ctx, mouse.x, mouse.y + 30, player.useProgress, { fill: "#5bd66b" });
  else if (gun.reloading) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.reloadProgress);
  else if (gun.drawing) drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.drawProgress);

  drawLoadout(ctx, player, w, h);

  // Bottom-left minimap; the gamemode ticket bars stack above it.
  let gamemodeInset = 0;
  if (o.minimap && o.characters) {
    const px = o.minimap.px;
    o.minimap.draw(ctx, HUD_MARGIN, h - HUD_MARGIN - px, o.characters, o.deaths ?? [], player, o.gamemode?.points);
    gamemodeInset = px + HUD_MARGIN;
  }

  if (o.gamemode) drawGamemodeHud(ctx, o.gamemode, w, h, gamemodeInset);
  if (o.showScoreboard && o.gamemode?.players) drawScoreboard(ctx, o.gamemode.players, w, h);

  ctx.restore();
}

/**
 * The Tab scoreboard: a centered panel with one column per team, each listing
 * that team's combatants' callsigns and K/D ranked by kills. The human's own row
 * is highlighted. Drawn in logical HUD units.
 */
function drawScoreboard(ctx: CanvasRenderingContext2D, players: PlayerRow[], w: number, h: number): void {
  // Distinct teams in stable order (blue before red), each ranked by kills.
  const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => (a < b ? -1 : 1));
  const cols = teams.map((team) => ({
    team,
    color: players.find((p) => p.team === team)?.color ?? "#d7dbe2",
    rows: players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills),
  }));

  const COL_W = 300;
  const COL_GAP = 20;
  const PAD = 12; // panel edge padding around the columns
  const ROW_H = 26;
  const HEAD_H = 40;
  const maxRows = cols.reduce((m, c) => Math.max(m, c.rows.length), 0);

  const PANEL_W = PAD * 2 + cols.length * COL_W + (cols.length - 1) * COL_GAP;
  const panelH = HEAD_H + maxRows * ROW_H + 14;
  const x = (w - PANEL_W) / 2;
  const y = (h - panelH) / 2;

  fillSquircle(ctx, x, y, PANEL_W, panelH, 0, "rgba(0,0,0,0.78)");

  ctx.textBaseline = "middle";
  const padX = 22;

  cols.forEach((col, ci) => {
    const cx = x + PAD + ci * (COL_W + COL_GAP);
    const kCol = cx + COL_W - 130;
    const dCol = cx + COL_W - 60;

    // Column header: team name (in team color) + K / D labels.
    ctx.textAlign = "left";
    ctx.fillStyle = col.color;
    ctx.font = uiFont("bold 13px");
    ctx.fillText(col.team.toUpperCase(), cx + padX, y + 20);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "right";
    ctx.fillText("K", kCol + 14, y + 20);
    ctx.fillText("D", dCol + 14, y + 20);

    let ry = y + HEAD_H + ROW_H / 2;
    let i = 0;
    for (const r of col.rows) {
      if (r.isPlayer) {
        fillSquircle(ctx, cx + 8, ry - ROW_H / 2 + 2, COL_W - 16, ROW_H - 4, 0, "rgba(255,255,255,0.10)");
      }
      if (i % 2 == 0) {
        fillSquircle(ctx, cx + 8, ry - ROW_H / 2, COL_W - 16, ROW_H, 0, "rgba(255,255,255,0.05)");
      }

      // Team color dot + name.
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.arc(cx + padX + 5, ry, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = r.isPlayer ? "#ffffff" : "#d7dbe2";
      ctx.font = uiFont(`${r.isPlayer ? "bold " : ""}15px`);
      ctx.fillText(r.isPlayer ? `${r.name} (you)` : r.name, cx + padX + 18, ry + 1);
      ctx.textAlign = "right";
      ctx.fillStyle = "#d7dbe2";
      ctx.font = uiFont("15px");
      ctx.fillText(String(r.kills), kCol + 14, ry + 1);
      ctx.fillText(String(r.deaths), dCol + 14, ry + 1);
      ry += ROW_H;

      i++;
    }
  });
}

/**
 * The kill feed: one squircle bar per recent player kill, centered horizontally
 * and stacked downward from `topY` with the newest on top. Each bar reads
 * "killer  [white gun glyph]  victim  (N meters)". Bars fade out over their last
 * moments before the Game prunes them. Drawn in logical HUD units.
 */
function drawKillFeed(
  ctx: CanvasRenderingContext2D,
  feed: readonly KillFeedEntry[],
  w: number,
  topY: number,
): void {
  const BAR_H = 30;
  const GAP = 6;
  const PAD_X = 14; // squircle inner horizontal padding
  const ITEM_GAP = 10; // spacing between name / icon / name / distance
  const ICON_MAX = 44; // gun glyph's longest side
  const WALLBANG_MAX = 24; // the through-wall mark, deliberately smaller than the gun
  const FADE_TICKS = 40; // fade window before a bar is pruned

  const nameFont = uiFont("bold 15px");
  const distFont = uiFont("13px");

  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  feed.forEach((e, i) => {
    // Measure the row so the squircle hugs its contents.
    ctx.font = nameFont;
    // A self-kill has nobody to name twice: it shows the weapon and the victim,
    // and no distance, since the distance from yourself to yourself is not news.
    const killerW = e.selfKill ? 0 : ctx.measureText(e.killerName).width;
    const victimW = ctx.measureText(e.victimName).width;
    const distText = e.selfKill ? "" : `(${e.meters.toFixed(1)}m)`;
    ctx.font = distFont;
    const distW = distText ? ctx.measureText(distText).width : 0;

    // Melee kills carry the fists spec (no gun icon), so show the hand glyph;
    // ranged kills use the weapon's own icon. Both drawn as white silhouettes.
    const img = e.gun ? (e.gun.melee ? assetImage("fists.svg") : gunIcon(e.gun)) : null;
    const sprite = img ? whiteIcon(img) : null;
    let iconW = 0;
    let iconH = 0;
    if (sprite) {
      const k = ICON_MAX / Math.max(sprite.width, sprite.height);
      iconW = sprite.width * k;
      iconH = sprite.height * k;
    }

    // The through-wall mark rides just after the weapon, as CSGO's does.
    const bangImg = e.wallbang ? assetImage("wallbang_icon.webp") : null;
    const bangSprite = bangImg ? whiteIcon(bangImg) : null;
    let bangW = 0;
    let bangH = 0;
    if (bangSprite) {
      const k = WALLBANG_MAX / Math.max(bangSprite.width, bangSprite.height);
      bangW = bangSprite.width * k;
      bangH = bangSprite.height * k;
    }

    const contentW =
      (killerW ? killerW + ITEM_GAP : 0) +
      iconW +
      (bangW ? ITEM_GAP + bangW : 0) +
      ITEM_GAP +
      victimW +
      (distW ? ITEM_GAP + distW : 0);
    const barW = contentW + PAD_X * 2;
    const x = (w - barW) / 2;
    const y = topY + i * (BAR_H + GAP);
    const cy = y + BAR_H / 2;

    // Fade the bar out over its final FADE_TICKS before the Game removes it.
    ctx.globalAlpha = Math.max(0, Math.min(1, (KILLFEED_TTL - e.age) / FADE_TICKS));

    fillSquircle(ctx, x, y, barW, BAR_H, 8, SQUIRCLE_BG);

    let cursor = x + PAD_X;
    ctx.textAlign = "left";
    if (killerW) {
      ctx.font = nameFont;
      ctx.fillStyle = e.killerColor;
      ctx.fillText(e.killerName, cursor, cy + 1);
      cursor += killerW + ITEM_GAP;
    }

    if (sprite) {
      ctx.drawImage(sprite, cursor, cy - iconH / 2, iconW, iconH);
      cursor += iconW;
    }
    if (bangSprite) {
      cursor += ITEM_GAP;
      ctx.drawImage(bangSprite, cursor, cy - bangH / 2, bangW, bangH);
      cursor += bangW;
    }
    cursor += ITEM_GAP;

    ctx.font = nameFont;
    ctx.fillStyle = e.victimColor;
    ctx.fillText(e.victimName, cursor, cy + 1);
    cursor += victimW;

    if (distW) {
      cursor += ITEM_GAP;
      ctx.font = distFont;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(distText, cursor, cy + 1);
    }
  });

  ctx.restore();
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
  const MARGIN = HUD_MARGIN; // shares the minimap's left edge
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
// Each box is OUTLINE_PX*2 + a little wider/taller than it used to be, so the
// keylined icons keep the same clearance from the slot edges as the bare sprites did.
const SLOT_W = 198;
const SLOT_H = 80;
const SLOT_GAP = 8;
const SLOT_MARGIN = 22;
const ARMOR_SQ = 76; // side length of the square armor slot
const HALF_H = 62; // height of the compact melee/utility row (slots 3 & 4)

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

/** Draw a fitted, white-keylined icon centered in a box (sprite's longest side =
 *  `maxPx`; the outline reaches a few px past that). */
function drawIconCentered(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  maxPx: number,
): void {
  const k = maxPx / Math.max(img.naturalWidth, img.naturalHeight);
  const sprite = outlinedIcon(img, k);
  if (!sprite) return;
  const iw = sprite.width * k;
  const ih = sprite.height * k;
  ctx.drawImage(sprite, cx - iw / 2, cy - ih / 2, iw, ih);
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
  const sprite = img ? outlinedIcon(img, 0.22) : null;
  if (sprite) {
    const k = 0.22
    const iw = sprite.width * k;
    const ih = sprite.height * k;
    ctx.drawImage(sprite, cx - iw / 2, y + size / 2 - ih / 2 - 14, iw, ih);
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

    // Icon centered above the name. Bottom-anchored, so the keyline's padding is
    // added back to keep the sprite itself sitting exactly where it did.
    const img = gunIcon(gun.spec);
    const sprite = img ? outlinedIcon(img, 0.35) : null;
    if (sprite) {
      const k = 0.35;
      const iw = sprite.width * k;
      const ih = sprite.height * k;
      ctx.translate(x + SLOT_W / 2, cy);
      ctx.drawImage(sprite, -iw / 2, -ih + 6 + OUTLINE_PX, iw, ih);
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

  // Reserve squircle to the right, sharing the same bottom edge. Shown only while
  // spares remain (drops out entirely when out of reserve): the spare count (spare
  // *rounds* on a per-round gun, else spare mags) followed by the reload-type icon
  // INSIDE the same squircle, just right of the number — a single round (per-bullet,
  // e.g. a pump shotgun) vs a magazine (whole-mag swap). The squircle grows to fit both.
  if (gun.reserveMags > 0) {
    const resH = 32;
    const resTop = bottom - resH;
    ctx.font = uiFont("bold 22px");
    const resText = String(gun.reserveMags);
    const numW = ctx.measureText(resText).width;

    const icon = assetImage(gun.spec.fire.perBullet ? "bullet-thin.png" : "magazine-thin.png");
    const iconH = icon ? 22 : 0;
    const iconW = icon ? icon.naturalWidth * (iconH / icon.naturalHeight) : 0;

    const padX = 12;
    const gap = icon ? 8 : 0;
    const contentW = numW + gap + iconW;
    const resW = Math.max(resH, contentW + padX * 2);
    const resLeft = magLeft + magW + 10;

    fillSquircle(ctx, resLeft, resTop, resW, resH, 9, SQUIRCLE_BG);

    // Center the number+icon block within the squircle.
    const contentLeft = resLeft + (resW - contentW) / 2;
    const cy = resTop + resH / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(resText, contentLeft, cy + 1);
    if (icon) {
      ctx.drawImage(icon, contentLeft + numW + gap, cy - iconH / 2, iconW, iconH);
    }
  }
  ctx.restore();
}
