import { Character } from "./entities/actor.ts";
import type { Body } from "./entities/body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./entities/character.ts";
import { worldAabb, type AABB, type Box, borderFit } from "./engine/collision.ts";
import type { VehiclePartSpec } from "./entities/vehicle.ts";
import { Editor } from "./ui/editor.ts";
import { Game } from "./game.ts";
import { DEFAULT_MODE, GAMEMODES, type DomPointView, type GamemodeHud } from "./gamemodes/gamemode.ts";
import { resolveTdm, type TdmOverrides } from "./gamemodes/tdm.ts";
import { resolveDom, type DomOverrides } from "./gamemodes/domination.ts";
import { Gun } from "./entities/gun.ts";
import * as Guns from "./entities/guns.ts";
import { loadLevel, SKINS, type LevelMeta, type TeamConfig } from "./world/level.ts";
import { LEVELS } from "./world/levels.ts";
import { initInput, isAction, isDown, keyLabel, mouse } from "./engine/input.ts";
import {
  audioLatencyMs,
  preload,
  setAudioLive,
  setListener,
  unlockAudio,
  updateAudio,
} from "./engine/audio.ts";
import { DEFAULT_FIRE_SOUND } from "./entities/gun.ts";
import { ALL_GUN_SPECS } from "./entities/specs.ts";
import { drawParticles } from "./engine/particle.ts";
import { drawDecals } from "./engine/decal.ts";
import { disjointPolys, rectCorners, type Poly } from "./engine/poly.ts";
import { profiler } from "./engine/profiler.ts";
import { drawHud, HealthBar } from "./ui/ui.ts";
import { buildRespawnMenu, teardownRespawnMenu } from "./ui/respawn.ts";
import { buildSettingsMenu, type SettingsMenu } from "./ui/settings.ts";
import { loadSettings, settings } from "./settings.ts";
import { domPointStyle, Minimap } from "./ui/minimap.ts";
import { add, angleOf, dist, norm, rotate, scale, sub, vec, type Vec2 } from "./engine/vec.ts";
import { assetImage } from "./entities/item.ts";
import { areHostile } from "./entities/team.ts";
import { VISION_GRACE_R, visibilityPolygon, type SightCone } from "./world/sight.ts";
import {
  enclosureCap,
  floorVisible,
  stairsVisible,
  wallbangDamageMul,
  zsetHas,
  type Floor,
  type Obstacle,
  type Stairs,
} from "./world/world.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const mainCtx = canvas.getContext("2d")!;
// The context every draw helper paints to. Normally the screen; the sight mask
// (see render) points it at an offscreen canvas for one level at a time, so
// that level can be darkened exactly where it painted before it is composited.
let ctx: CanvasRenderingContext2D = mainCtx;
const offCanvas = document.createElement("canvas");
const offCtx = offCanvas.getContext("2d")!;

let dpr = 1;
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  offCanvas.width = canvas.width;
  offCanvas.height = canvas.height;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}
window.addEventListener("resize", resize);
resize();

initInput(canvas);
// Stored player settings (volume, crosshair) — applied before the first sound.
loadSettings();

// The browser keeps audio suspended until a user gesture, so unlock on the first
// key/click (idempotent thereafter) and warm the default gunshot so shot one isn't
// silent while it decodes.
preload(DEFAULT_FIRE_SOUND);
// Warm each weapon's fire + explosion sound (filenames live only on the specs) so
// the first shot / detonation isn't silent while it decodes.
for (const spec of Object.values(ALL_GUN_SPECS)) {
  if (spec.fireSound) preload(spec.fireSound);
  if (spec.reloadSound) preload(spec.reloadSound);
  if (spec.cycleSound) preload(spec.cycleSound);
  if (spec.projectile?.explosionSound) preload(spec.projectile.explosionSound);
}
window.addEventListener("keydown", unlockAudio);
window.addEventListener("mousedown", unlockAudio);

// ?edit=true boots the level editor instead of the game: no enemies or combat,
// the player noclips, and the editor drives the camera + all world mutation.
const params = new URLSearchParams(location.search);
const EDIT = params.get("edit") === "true";

// The map: ?level=<name> picks a JSON from src/world/levels/; with no param the
// arena-teamfight map loads. (?edit composes: ?edit=true&level=foo edits it.)
const DEFAULT_LEVEL = "dom-arena-big-fix";

const levelName = params.get("level");
if (levelName && !(levelName in LEVELS)) {
  console.warn(`unknown level "${levelName}" — falling back to the default map`);
}
const levelText = LEVELS[levelName ?? DEFAULT_LEVEL] ?? null;
const loaded = loadLevel(levelText ?? `{ "version": 1, "entities": [] }`);

// The active gamemode: a ?mode= override wins, else the level's own meta.mode,
// else the sandbox default. (Only the play path uses it; the editor doesn't.)
const modeId = params.get("mode") ?? loaded.meta.mode ?? DEFAULT_MODE;
const makeMode = GAMEMODES[modeId] ?? GAMEMODES[DEFAULT_MODE];

// Case-insensitive view of the query string, so ?blueTroops= and ?bluetroops=
// (and ?BLUETROOPS=) all work.
const lowerParams = new Map<string, string>();
for (const [k, v] of params) lowerParams.set(k.toLowerCase(), v);

/** A finite number from a URL param (case-insensitive), or undefined. */
function numParam(key: string): number | undefined {
  const v = lowerParams.get(key.toLowerCase());
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A raw string URL param (case-insensitive), or undefined. */
function strParam(key: string): string | undefined {
  return lowerParams.get(key.toLowerCase());
}

/** Per-side troop/skill/equip overrides for `side` off the URL, or undefined
 *  when none were given (shared by TDM and Domination — same param names).
 *  `equip` is a tier NAME (e.g. ?blueEquip=elite); resolveTdm/resolveDom
 *  validate it, falling back to the default tier if it isn't a known name. */
function sideUrlOverrides(side: "blue" | "red"): Partial<TeamConfig> | undefined {
  const s: Partial<TeamConfig> = {};
  const troops = numParam(`${side}Troops`);
  if (troops !== undefined) s.troops = troops;
  const skill = numParam(`${side}Skill`);
  if (skill !== undefined) s.skill = skill;
  const equip = strParam(`${side}Equip`);
  if (equip !== undefined) s.equip = equip;
  return Object.keys(s).length > 0 ? s : undefined;
}

/** TDM parameter overrides read off the URL, e.g.
 *  ?mode=tdm&killLimit=10&respawnDelay=90&blueTroops=2&redSkill=1&redEquip=4 */
function tdmUrlOverrides(): TdmOverrides {
  const o: TdmOverrides = {};
  const kl = numParam("killLimit");
  if (kl !== undefined) o.killLimit = kl;
  const rd = numParam("respawnDelay");
  if (rd !== undefined) o.respawnDelay = rd;
  const blue = sideUrlOverrides("blue");
  if (blue) o.blue = blue;
  const red = sideUrlOverrides("red");
  if (red) o.red = red;
  return o;
}

/** Domination parameter overrides read off the URL, e.g.
 *  ?mode=domination&scoreLimit=150&respawnDelay=90&blueTroops=3&redSkill=1&redEquip=4 */
function domUrlOverrides(): DomOverrides {
  const o: DomOverrides = {};
  const sl = numParam("scoreLimit");
  if (sl !== undefined) o.scoreLimit = sl;
  const rd = numParam("respawnDelay");
  if (rd !== undefined) o.respawnDelay = rd;
  const blue = sideUrlOverrides("blue");
  if (blue) o.blue = blue;
  const red = sideUrlOverrides("red");
  if (red) o.red = red;
  return o;
}

// Effective meta for the gamemode: the level's meta with the chosen mode and, for
// the team modes, their parameters merged with any URL overrides (URL wins). This
// stays runtime-only — the loaded level (and what the editor would save) is
// untouched.
const meta: LevelMeta = { ...loaded.meta, mode: modeId };
if (modeId === "tdm") {
  const u = tdmUrlOverrides();
  const base = loaded.meta.tdm;
  meta.tdm = resolveTdm({
    killLimit: u.killLimit ?? base?.killLimit,
    respawnDelay: u.respawnDelay ?? base?.respawnDelay,
    blue: { ...base?.blue, ...u.blue },
    red: { ...base?.red, ...u.red },
  });
} else if (modeId === "domination") {
  const u = domUrlOverrides();
  const base = loaded.meta.domination;
  meta.domination = resolveDom({
    scoreLimit: u.scoreLimit ?? base?.scoreLimit,
    respawnDelay: u.respawnDelay ?? base?.respawnDelay,
    blue: { ...base?.blue, ...u.blue },
    red: { ...base?.red, ...u.red },
  });
}

// --- session vs editor -------------------------------------------------------
let game: Game | null = null;
let editor: Editor | null = null;
let editorPlayer: Character | null = null;
const editorBodies: Body[] = [];

if (EDIT) {
  const start = loaded.playerSpawn[0] ?? { pos: vec(0, 0), z: 0 };
  editorPlayer = new Character(vec(start.pos.x, start.pos.y), SKINS[start.skin ?? ""] ?? DEFAULT_SKIN, {
    hand: new Gun(Guns.UNARMED),
  });
  editorPlayer.z = start.z;
  editor = new Editor(loaded, editorPlayer, canvas);
} else {
  game = new Game(loaded, makeMode(meta));
}

// References the renderer reads every frame. Normally bound once (the game's live
// arrays, or the editor's lone player), but the editor's playtest toggle swaps
// them between the edit session and a throwaway live match — every render helper
// closes over these module bindings by name, so reassigning here is all it takes.
// See startPlaytest / stopPlaytest.
let world = game ? game.world : loaded.world;
let player = game ? game.player : editorPlayer!;
let characters = game ? game.characters : [editorPlayer!];
let bodies = game ? game.bodies : editorBodies;
let camera = game ? game.camera : { size: editorPlayer!.gun.spec.zoom };

const healthBar = new HealthBar({ width: 450, height: 35 });
// Slightly shorter cyan bar for armor, stacked above the health bar.
const armorBar = new HealthBar({ width: 450, height: 20, fillColor: "#33d6e0", radius: 0, displayLoss: false });
// Bottom-left minimap: baked once from the (static) world, sized by the level's
// meta or auto-fit. Play mode only — the editor has its own world overview.
let minimap = game ? new Minimap(world, meta.minimapSize) : null;

/** Whether a match renders with the line-of-sight mask: the level's
 *  meta.visibility, or a ?visibility=true|false override for trying it out. */
function sightFlag(m: LevelMeta): boolean {
  const o = strParam("visibility");
  return o !== undefined ? o === "true" : !!m.visibility;
}
let sightMask = game ? sightFlag(meta) : false;

// The post-death loadout screen (see ui/respawn.ts). Only modes with a
// customizable respawn (the team modes) build one. Rebound per playtest, so the
// throwaway match gets its own respawn menu (or none).
let updateRespawnMenu = game && game.gamemode.setPlayerLoadout ? buildRespawnMenu(game) : null;

// --- editor playtest ---------------------------------------------------------
// The editor hands the level as it stands to a live match with no reload: build a
// Game on a THROWAWAY copy (the sim rebuilds items/vehicles/bodies and moves the
// player, so it must never touch the authored world), point the renderer's
// bindings at it, and suspend the editor. Esc tears the match down and restores
// editing exactly where it left off (the editorPlayer camera never moved). All of
// this is inert outside an editor session — `editor` is null in pure play mode.

/** A gamemode meta resolved from a level's own meta alone — no URL overrides, so
 *  a playtest reflects exactly the mode + params the editor has set/would save. */
function playtestMeta(base: LevelMeta): LevelMeta {
  const mId = base.mode ?? DEFAULT_MODE;
  const m: LevelMeta = { ...base, mode: mId };
  if (mId === "tdm") m.tdm = resolveTdm({ ...base.tdm });
  else if (mId === "domination") m.domination = resolveDom({ ...base.domination });
  return m;
}

// A transient bottom-center message (e.g. "place a spawn"), auto-hiding.
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
function toast(msg: string): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText =
      "position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(150,40,40,0.94);" +
      "color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:8px;z-index:40;pointer-events:none;";
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.display = "";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl && (toastEl.style.display = "none"), 2200);
}

// The "▶ PLAYTEST — Esc to stop" chip shown while a match is running from the editor.
let playChip: HTMLElement | null = null;
function showPlayChip(on: boolean): void {
  if (on && !playChip) {
    playChip = document.createElement("div");
    playChip.textContent = "▶ PLAYTEST — Esc to stop";
    playChip.style.cssText =
      "position:fixed;top:8px;right:8px;background:rgba(31,111,58,0.92);color:#eaffef;" +
      "font:bold 12px ui-monospace,Consolas,monospace;padding:6px 10px;border-radius:8px;z-index:30;pointer-events:none;";
    document.body.append(playChip);
  }
  if (playChip) playChip.style.display = on ? "" : "none";
}

/**
 * Hide the OS pointer whenever a match is live, and only then: the HUD draws its
 * own crosshair (see drawCrosshair), and the arrow sitting on top of it — hotspot
 * at the tip, body hanging down-right across the centre dot — is just clutter.
 *
 * `game` is precisely the right test. It is set at boot in play mode and never
 * cleared; in an editor session it is null while editing and non-null only for
 * the duration of a playtest. So the editor keeps its pointer (it is a
 * mouse-driven tool) and a playtest looks exactly like the real game.
 *
 * Set on the canvas rather than the page, so the editor's panels and the respawn
 * menu — separate DOM, drawn over the top — keep a normal cursor to click with.
 */
function syncCursor(): void {
  canvas.style.cursor = game ? "none" : "";
}
syncCursor();

function startPlaytest(): void {
  if (!editor || game) return; // only from an idle editor session
  if (loaded.playerSpawn.length === 0) {
    toast("Place a player spawn before playtesting");
    return;
  }
  const copy = loadLevel(editor.currentLevel()); // deep copy — the match owns this world
  const pmeta = playtestMeta(copy.meta);
  const makePlay = GAMEMODES[pmeta.mode ?? DEFAULT_MODE] ?? GAMEMODES[DEFAULT_MODE];
  const g = new Game(copy, makePlay(pmeta));
  game = g;
  world = g.world;
  player = g.player;
  characters = g.characters;
  bodies = g.bodies;
  camera = g.camera;
  minimap = new Minimap(g.world, pmeta.minimapSize);
  sightMask = sightFlag(pmeta);
  updateRespawnMenu = g.gamemode.setPlayerLoadout ? buildRespawnMenu(g) : null;
  editor.setSuspended(true);
  showPlayChip(true);
  syncCursor();
}

function stopPlaytest(): void {
  if (!editor || !game) return;
  game = null;
  world = loaded.world;
  player = editorPlayer!;
  characters = [editorPlayer!];
  bodies = editorBodies;
  camera = { size: editorPlayer!.gun.spec.zoom };
  minimap = null;
  sightMask = false;
  updateRespawnMenu = null;
  teardownRespawnMenu(); // drop the match's respawn menu if it built one
  showPlayChip(false);
  editor.setSuspended(false);
  syncCursor();
}

if (editor) {
  editor.onPlaytest = startPlaytest;
  // Esc ends a playtest and returns to editing (the editor's own Esc is gated
  // off while suspended, so this is the only Esc handler active during a match).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && game) stopPlaytest();
  });
}

// The settings menu (Esc), play mode only: in an editor session Esc already
// means "stop the playtest" / "cancel", and the editor is a dev tool anyway.
// The match pauses while it is open — see frame().
const settingsMenu: SettingsMenu | null = editor ? null : buildSettingsMenu();

// The top-left controls hint, written from the live bindings so it never
// shows a key the player has moved. Redone whenever the menu closes.
const hintEl = document.getElementById("hud");
function renderHint(): void {
  if (!hintEl) return;
  const b = settings.binds;
  const k = keyLabel;
  const moveKeys = [b.moveUp, b.moveLeft, b.moveDown, b.moveRight].map(k);
  const move = moveKeys.every((n) => n.length === 1) ? moveKeys.join("") : moveKeys.join(" ");
  const lines = [
    `${move} to move · ${k(b.fire)} to shoot · ${k(b.reload)} to reload · ${k(b.drop)}/${k(b.dropHud)} to drop`,
    `${k(b.primary)} primary / ${k(b.secondary)} secondary / ${k(b.melee)} melee`,
    "Esc settings",
    "made by stanley li",
  ];
  hintEl.replaceChildren();
  lines.forEach((text, i) => {
    if (i > 0) hintEl.append(document.createElement("br"));
    hintEl.append(document.createTextNode(text));
  });
}
renderHint();
let settingsWasOpen = false;

const screenCenter = (): Vec2 => vec(window.innerWidth / 2, window.innerHeight / 2);

// --- fixed-timestep loop: 60 physics ticks/s, render every frame ---
const STEP = 1000 / 60;
let accumulator = 0;
let last = performance.now();

// --- audio-latency watchdog + lag-spike diagnostics ---
// The bug being chased: an occasional lag spike leaves ALL later sounds with a
// persistent ~0.1–0.3s delay. audioLatencyMs() measures the browser's output
// pipeline itself, so these logs separate "our engine started sounds late"
// from "the browser grew its output buffer and never gave it back".
let latencyBaseline = Infinity; // lowest latency seen — the healthy floor
let lastStuckLog = 0;
let lastSpikeLog = 0;
// The previous frame's measured update/render cost. A spike shows up as a big
// gap between THIS RAF and the last one, so the work that caused it was
// measured last frame; whatever the gap doesn't account for is GC, paint, or
// the browser itself.
let prevUpdateMs = 0;
let prevRenderMs = 0;

function watchAudio(frameGapMs: number, ticks: number, now: number): void {
  const lat = audioLatencyMs();
  if (lat === undefined) return;
  if (lat < latencyBaseline) latencyBaseline = lat;
  if (frameGapMs > 100 || ticks >= 4) {
    // Throttled: with the inspector open, console.warn itself costs frame time,
    // and a warning per spiky frame can feed the very spikes it reports.
    if (now - lastSpikeLog > 2000) {
      lastSpikeLog = now;
      const unaccounted = frameGapMs - prevUpdateMs - prevRenderMs;
      console.warn(
        `[audio] lag spike: ${frameGapMs.toFixed(0)}ms frame ` +
          `(last frame: update ${prevUpdateMs.toFixed(0)}ms, render ${prevRenderMs.toFixed(0)}ms, ` +
          `unaccounted ${unaccounted.toFixed(0)}ms), ${ticks} ticks replayed`,
      );
    }
  } else if (lat - latencyBaseline > 30 && now - lastStuckLog > 2000) {
    // Sustained step above the healthy floor — the sticky-delay bug itself.
    // (Switching output to Bluetooth mid-game also trips this; that's real
    // added latency, not a false positive.)
    lastStuckLog = now;
    console.warn(
      `[audio] output latency stuck at ${lat.toFixed(1)}ms (baseline ${latencyBaseline.toFixed(1)}ms)`,
    );
  }
}

// Console knobs for reproducing the bug and testing the suspected fix:
//   lagSpike(300)    — block the main thread for 300ms (the suspected trigger)
//   setMaxCatchup(3) — spread catch-up over frames, at most n sim ticks per
//                      frame, instead of replaying up to ~15 in one burst
let maxCatchup = Infinity;
Object.assign(globalThis as object, {
  lagSpike(ms = 300): void {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      // busy-wait — simulates a GC pause / heavy frame
    }
  },
  setMaxCatchup(n: number): void {
    maxCatchup = n;
  },
});

const GRID = 512; // default background grid spacing (world px)
// Draw the grid covering the (zoom-enlarged) visible world region. `width` is
// in screen px, `gap` in world px — both per-floor settings on the background.
function drawGrid(
  camPos: Vec2,
  center: Vec2,
  w: number,
  h: number,
  zoom: number,
  color: string,
  width = 1,
  gap = GRID,
): void {
  // Screen edges mapped back to world: world = (screenPx - center) * zoom + camPos.
  const left = camPos.x - center.x * zoom;
  const right = camPos.x + (w - center.x) * zoom;
  const top = camPos.y - center.y * zoom;
  const bottom = camPos.y + (h - center.y) * zoom;

  ctx.strokeStyle = color;
  ctx.lineWidth = zoom * width; // 1/zoom context scale -> `width` px on screen
  ctx.beginPath();
  for (let x = Math.ceil(left / gap) * gap; x <= right; x += gap) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = Math.ceil(top / gap) * gap; y <= bottom; y += gap) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
}

function drawFloor(fl: Floor): void {
  ctx.save();
  ctx.globalAlpha = fl.alpha; // eased: floors fade out as they stop being visible
  ctx.fillStyle = fl.color;
  ctx.translate(fl.pos.x, fl.pos.y);
  ctx.rotate(fl.angle ?? 0);
  ctx.fillRect(-fl.w / 2, -fl.h / 2, fl.w, fl.h);
  ctx.restore();
}

/** Mix a #rrggbb color toward white by `t` (0..1). */
function lighten(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const ch = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * t);
  };
  return `rgb(${ch(0)}, ${ch(2)}, ${ch(4)})`;
}

/** Lerp between two #rrggbb colors by `t` (0..1). */
function mixColor(a: string, b: string, t: number): string {
  const ha = a.replace("#", "");
  const hb = b.replace("#", "");
  const ch = (i: number) => {
    const va = parseInt(ha.slice(i, i + 2), 16);
    const vb = parseInt(hb.slice(i, i + 2), 16);
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(0)}, ${ch(2)}, ${ch(4)})`;
}

// Stairs render as a run of step rectangles blending from `color` at the low-z
// end to `color2` at the high-z end (legacy single-color stairs lighten toward
// white instead), so the climb reads at a glance.
function drawStairs(s: Stairs): void {
  ctx.save();
  ctx.globalAlpha = s.alpha;
  // Step slices are laid out in the stairs' local frame, so a rotated flight
  // just rotates the whole run of steps with it.
  ctx.translate(s.pos.x, s.pos.y);
  ctx.rotate(s.angle ?? 0);
  const minx = -s.w / 2;
  const miny = -s.h / 2;
  for (let i = 0; i < s.steps; i++) {
    // 0..1 from the min end to the max end, flipped so the higher-z end is lightest.
    const frac = (i + 0.5) / s.steps;
    const up = s.zAtMax > s.zAtMin ? frac : 1 - frac;
    ctx.fillStyle = s.color2 ? mixColor(s.color, s.color2, up) : lighten(s.color, up * 0.5);
    // +0.5 px of overlap per slice hides hairline seams between steps.
    if (s.axis === "x") {
      ctx.fillRect(minx + (i * s.w) / s.steps, miny, s.w / s.steps + 0.5, s.h);
    } else {
      ctx.fillRect(minx, miny + (i * s.h) / s.steps, s.w, s.h / s.steps + 0.5);
    }
  }
  ctx.restore();
}

// --- per-style obstacle art --------------------------------------------------
// Each of these draws in the obstacle's OWN local frame: drawObstacle has already
// translated to its centre, applied its rotation, and set fill/stroke/lineWidth,
// so a renderer just draws around the origin out to radius `r`. This is where
// custom barrel art goes — they're deliberately separate functions rather than
// flags on the generic circle, so either can grow without touching the other.

/** Metal barrel: filled body plus the concentric lid rim. */

//  return { pos, w: d, h: d, z, round: true, style: "barrel_metal", fill: "#8a929b", stroke: "#3f474d", strokeWidth: 5, cross: false, particle: METAL_SHRAPNEL };


/** A wooden barrel: same circular collider, but splinters like a crate. Drawn by
 *  its own renderer (see drawObstacle). */
//  return { pos, w: d, h: d, z, round: true, style: "barrel_wood", fill: "#9a6a2f", stroke: "#4a300f", strokeWidth: 5, cross: false, particle: CRATE_SHRAPNEL };


function drawBarrelMetal(r: number): void {

  ctx.fillStyle = "#73787c";
  ctx.strokeStyle = "#3f474d";
  ctx.lineWidth = r * 0.125;

  // Body out to the collider's radius, rim stroked just inside it (see borderInset).
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r - borderFit(r * 0.125, 2 * r).inset, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#8b8c8e";
  ctx.beginPath();
  ctx.arc(0, 0, r * (1 - 0.125), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#3f474d"
  ctx.beginPath();
  ctx.arc(r * -0.3, r * -0.3, r * 0.2, 0, Math.PI * 2);
  ctx.fill();

  // ctx.beginPath();
  // ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
  // ctx.stroke();
}

/** Wooden barrel: the same body and rim, with planking across the lid. */
function drawBarrelWood(r: number): void {
  ctx.fillStyle = "#9a6a2f";
  ctx.strokeStyle = "#4a300f";
  ctx.lineWidth = r * 0.125;

  // Body out to the collider's radius, rim stroked just inside it (see borderInset).
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r - borderFit(r * 0.125, 2 * r).inset, 0, Math.PI * 2);
  ctx.stroke();

  const innerR = r * 0.7;

  ctx.fillStyle = "#ba8443";
  //ctx.strokeStyle = "#4a300f";
  ctx.beginPath();
  ctx.arc(0, 0, innerR, 0, Math.PI * 2);
  ctx.fill();
  //ctx.stroke();

  const numLines = 5;

  ctx.strokeStyle = "#9a6a2f";
  ctx.lineWidth = r * 0.05;
  for (let i = 0; i < numLines; i++) {
    const y = (i + 0.5) / numLines * 2 - 1;
    const x1 = Math.sqrt(1 - y ** 2) * 1.1;
    ctx.beginPath();
    ctx.moveTo(innerR * x1, innerR * y);
    ctx.lineTo(innerR * -x1, innerR * y);
    ctx.stroke();
  }
  // ctx.strokeStyle = "#4a300f";
  // ctx.stroke();

}

/**
 * Does this obstacle have a border to draw at all?
 *
 * Canvas will not let you turn a stroke off by setting it to nothing: assigning
 * 0, a negative, NaN or an invalid colour to lineWidth/strokeStyle is IGNORED
 * and the previous value stays in force. So an obstacle authored with no border
 * doesn't come out borderless — it comes out wearing whatever the last thing
 * drawn happened to be using, which changes with draw order. The only way to
 * mean it is to skip the stroke call.
 */
const hasBorder = (o: Obstacle): boolean => o.strokeWidth > 0 && !!o.stroke;

function drawObstacle(o: Obstacle): void {
  ctx.save();
  ctx.translate(o.pos.x, o.pos.y);
  ctx.rotate(o.angle ?? 0);
  ctx.fillStyle = o.fill;
  const bordered = hasBorder(o);
  if (bordered) ctx.strokeStyle = o.stroke;
  if (o.round) {
    // Radius matches the collider: half the smaller extent.
    const r = Math.min(o.w, o.h) / 2;
    if (o.style === "barrel_metal") drawBarrelMetal(r);
    else if (o.style === "barrel_wood") drawBarrelWood(r);
    else {
      // The generic circle: a filled disc with an edge stroke, and nothing else.
      // The fill runs to the collider's own radius; the stroke rides just inside it.
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      if (bordered) {
        const edge = borderFit(o.strokeWidth, 2 * r);
        ctx.lineWidth = edge.width;
        ctx.beginPath();
        ctx.arc(0, 0, r - edge.inset, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }
  const x = -o.w / 2;
  const y = -o.h / 2;
  ctx.fillRect(x, y, o.w, o.h);
  if (!bordered) {
    ctx.restore(); // no border, and the plank X is drawn with the same pen
    return;
  }
  const { width, inset } = borderFit(o.strokeWidth, Math.min(o.w, o.h));
  ctx.lineWidth = width;
  ctx.strokeRect(x + inset, y + inset, o.w - 2 * inset, o.h - 2 * inset);
  if (o.cross) {
    // Plank "X", corner to corner of the INSET rect: a diagonal's stroke sticks
    // out perpendicular to itself, and those components are (w/2)·sin and (w/2)·cos
    // — never more than the inset — so pulling the ends in by it keeps the planks
    // inside the box at whatever aspect ratio the crate has.
    ctx.beginPath();
    ctx.moveTo(x + inset, y + inset);
    ctx.lineTo(x + o.w - inset, y + o.h - inset);
    ctx.moveTo(x + o.w - inset, y + inset);
    ctx.lineTo(x + inset, y + o.h - inset);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A domination capture point on the ground: an unfilled circular border in the
 * owner's color (gray when neutral), with capture/strengthen progress stroked as
 * an arc from 12 o'clock, plus the point's name centered in the owner's color
 * (see domPointStyle for the color/arc scheme). Drawn in the world transform, on
 * the ground under the units.
 */
/**
 * A domination point's ring: the owner-coloured circle plus the capture/
 * strengthen progress arc from 12 o'clock. Ground marking, so it draws FIRST in
 * a level's pass, under everything standing on it (see drawDomLabel for the
 * other half).
 */
function drawDomRing(view: DomPointView): void {
  const { pos, radius } = view;
  const style = domPointStyle(view);
  const start = -Math.PI / 2; // 12 o'clock
  ctx.save();
  ctx.lineWidth = 10;
  // Base ring: owner's color (no fill).
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = style.ring;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  // Progress arc on top, from 12 o'clock.
  if (style.arc && style.arc.frac > 0) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = style.arc.color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, start, start + Math.PI * 2 * style.arc.frac);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A domination point's letter. Drawn LAST in a level's pass, over everything —
 * it is a label, not scenery, and an objective you can't find because somebody
 * is standing on it is worse than one drawn slightly wrong.
 */
function drawDomLabel(view: DomPointView): void {
  const { pos, radius, name } = view;
  const style = domPointStyle(view);
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = style.letter;
  ctx.font = `bold ${Math.max(12, Math.round(radius * 0.7))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, pos.x, pos.y);
  ctx.restore();
}

/** "#rrggbb" -> "r,g,b" for building rgba() strings with a chosen alpha. */
function rgbTriple(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

function drawBullets(z: number): void {
  ctx.lineCap = "round";
  for (const b of world.bullets) {
    if (b.z !== z) continue; // each level's render pass draws its own tracers
    // Only draw the part of the tracer that has cleared the muzzle.
    const traveled = dist(b.pos, b.origin);
    if (traveled <= b.renderAfter) continue;

    if (b.tracerWidth <= 0) continue; // no tracer means none drawn, not one inherited
    ctx.lineWidth = b.tracerWidth; // cosmetic, from the firing gun's spec

    const dir = norm(b.vel);
    // Streak from the tip back by the gun's tracer length, clamped so it never
    // pokes back out of the muzzle (past origin + renderAfter).
    const tailLen = Math.min(b.tracerLength, traveled - b.renderAfter);
    const tip = b.pos;
    const tail = sub(tip, scale(dir, tailLen));

    // Fade the gun's tracer color from transparent at the tail to solid at the tip,
    // the whole streak scaled by the damage the round has left — the SAME number
    // that will be applied when it lands, so a wallbanged shot looks exactly as
    // weak as it hits. See wallbangDamageMul.
    const rgb = rgbTriple(b.tracerColor);
    const grad = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},${(0.95 * wallbangDamageMul(b)).toFixed(3)})`);
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
}

/** Draw one vehicle part: a filled (optionally stroked) rounded-less rect in its
 *  world frame. Turret parts arrive already rotated to their aim angle. */
function drawVehiclePart(box: Box, spec: VehiclePartSpec): void {
  ctx.save();
  ctx.translate(box.pos.x, box.pos.y);
  ctx.rotate(box.angle ?? 0);
  ctx.fillStyle = spec.fill;
  ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
  if (spec.stroke && spec.strokeWidth) {
    const edge = borderFit(spec.strokeWidth, Math.min(box.w, box.h));
    ctx.strokeStyle = spec.stroke;
    ctx.lineWidth = edge.width;
    ctx.strokeRect(
      -box.w / 2 + edge.inset,
      -box.h / 2 + edge.inset,
      box.w - 2 * edge.inset,
      box.h - 2 * edge.inset,
    );
  }
  ctx.restore();
}

// AoE rounds (rockets): a solid body with a fading exhaust trail behind it. Like
// tracers, hidden until they clear the muzzle. The blast itself is particles.
function drawProjectiles(z: number): void {
  ctx.lineCap = "round";
  for (const p of world.projectiles) {
    if (p.z !== z) continue;
    const traveled = dist(p.pos, p.origin);
    if (traveled <= p.renderAfter) continue;

    const dir = norm(p.vel);
    const tailLen = Math.min(80, traveled - p.renderAfter);
    const tail = sub(p.pos, scale(dir, tailLen));
    const rgb = rgbTriple(p.trailColor);
    const grad = ctx.createLinearGradient(tail.x, tail.y, p.pos.x, p.pos.y);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},0.85)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = p.bodyRadius * 1.4;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(p.pos.x, p.pos.y);
    ctx.stroke();

    // Sprite body if the round carries one and it's decoded; otherwise a plain
    // disc in the body colour. The sprite art points +x, so rotating by the
    // heading aims its nose down-range.
    const img = p.sprite ? assetImage(`${p.sprite}.png`) : null;
    if (img) {
      const k = p.spriteScale ?? DEFAULT_PROJECTILE_SPRITE_SCALE;
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.rotate(angleOf(p.vel));
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, p.bodyRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Fallback sprite scale (native px -> world px) when a projectile sets a sprite
// but no spriteScale.
const DEFAULT_PROJECTILE_SPRITE_SCALE = 0.5;

// The backdrop when the surface world isn't visible: dark-brown "underground"
// dirt for below-ground levels, near-black void otherwise (shouldn't happen).
const UNDERGROUND_BG = "#3f3226";
const UNDERGROUND_GRID = "#4b3d2d";
const VOID_BG = "#22262a";
const VOID_GRID = "#2b3034";

/** Every z level with anything to draw this frame, ascending (lowest first). */
function presentLevels(): number[] {
  const set = new Set<number>();
  for (const f of world.floors) if (!f.infinite) set.add(f.level);
  for (const s of world.stairs) {
    set.add(s.zAtMin);
    set.add(s.zAtMax);
  }
  for (const o of world.obstacles) set.add(o.z);
  for (const v of world.vehicles) set.add(v.z);
  for (const b of bodies) set.add(b.z);
  for (const it of world.items) set.add(it.z);
  for (const c of characters) set.add(c.z);
  for (const b of world.bullets) set.add(b.z);
  for (const p of world.particles) set.add(p.z);
  return [...set].sort((a, b) => a - b);
}

// Hidden shapes grow by this before masking, so the clip's antialiased edge
// falls just past content that sits flush against it (walls extend exactly to
// the floor slab's edge) instead of on it — without this, boundary pixels
// render half-covered and every hidden room shows as a faint 1px outline.
const MASK_EPS = 1.5;

// Visible stairs mask generously, covering their edge-mounted railings.
const STAIR_MASK_PAD = 10;

/** What the sight mask paints over everything the player can't see. */
const UNSEEN_TINT = "rgba(0, 0, 0, 0.35)";

/** The half of a flight that is NOT on level `z` (see stairZ: the rect splits
 *  at its midpoint along the climb axis, the min-coordinate half being zAtMin).
 *  The sight mask darkens this half — a flight is half on your level and half
 *  off it, and you can't see the off half any more than the level it leads to. */
function stairOffHalf(s: Stairs, z: number): Poly {
  const farIsMax = z === s.zAtMin; // standing at the min end: the max half is away
  const sign = farIsMax ? 1 : -1;
  const off = s.axis === "x" ? vec((sign * s.w) / 4, 0) : vec(0, (sign * s.h) / 4);
  const center = add(s.pos, s.angle ? rotate(off, s.angle) : off);
  return s.axis === "x"
    ? rectCorners(center, s.w / 2, s.h, s.angle)
    : rectCorners(center, s.w, s.h / 2, s.angle);
}

/** Append a convex poly (a surface's — possibly rotated — rect) to a path. */
function addPoly(path: Path2D, poly: Poly): void {
  path.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
  path.closePath();
}

/**
 * The mask geometry for objects at level `z`, from the player's viewpoint.
 * Objects render everywhere EXCEPT where a *hidden* same-level surface backs
 * them (subtractive), with visible surfaces winning where the two overlap — so
 * a character straddling a hidden second story and a visible balcony loses only
 * its interior half, while anything over open air (a body overhanging the
 * balcony lip, a bullet flying off the deck) stays visible. Infinite floors
 * (the ground) blanket their whole level instead of contributing rects.
 */
function levelMasks(
  z: number,
  inView: (o: Box) => boolean,
): {
  visibleInf: boolean;
  hiddenInf: boolean;
  visible: Path2D | null;
  hidden: Path2D | null;
} {
  let visibleInf = false;
  let hiddenInf = false;
  let visible: Path2D | null = null;
  const hiddenPolys: Poly[] = [];
  const addVisible = (poly: Poly): void => {
    visible = visible ?? new Path2D();
    addPoly(visible, poly);
  };

  for (const f of world.floors) {
    if (f.level !== z) continue;
    const vis = floorVisible(f, player.z, player.pos);
    if (f.infinite) {
      // Infinite floors blanket the whole level — never cull them.
      if (vis) visibleInf = true;
      else hiddenInf = true;
      continue;
    }
    if (!inView(f)) continue; // off-screen: no effect on visible pixels
    if (vis) {
      addVisible(rectCorners(f.pos, f.w, f.h, f.angle));
    } else {
      // Inflated so the mask's AA edge clears flush content (see MASK_EPS).
      hiddenPolys.push(rectCorners(f.pos, f.w, f.h, f.angle, MASK_EPS));
    }
  }
  for (const s of world.stairs) {
    if (s.zAtMin !== z && s.zAtMax !== z) continue;
    if (!inView(s)) continue;
    if (stairsVisible(s, player.z)) {
      addVisible(rectCorners(s.pos, s.w, s.h, s.angle, STAIR_MASK_PAD));
    } else {
      hiddenPolys.push(rectCorners(s.pos, s.w, s.h, s.angle, MASK_EPS));
    }
  }

  let hidden: Path2D | null = null;
  if (hiddenPolys.length > 0) {
    hidden = new Path2D();
    for (const p of disjointPolys(hiddenPolys)) addPoly(hidden, p);
  }
  return { visibleInf, hiddenInf, visible, hidden };
}

function render(): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const center = screenCenter();
  // A match (booted-in OR a playtest) drives the gun/floor zoom; a bare editor
  // session uses its own free wheel-zoom. `game` is the "a match is live"
  // discriminator everywhere below — during a playtest both game and editor exist.
  const zoom = game ? camera.size : editor!.zoom;
  const camPos = player.pos; // camera centers on the player
  setListener(camPos, player.z); // positional audio hears from where the camera sits

  // The enclosure cap: inside a sealed room (a bunker under its ceiling), the
  // world at the ceiling's level and above is hidden — background included.
  const cap = enclosureCap(world.floors, player.z, player.pos);

  // Background: the visible infinite floor (the ground), or the underground
  // backdrop once you're below the surface and can't see it. An *invisible*
  // infinite floor still backs its level in the masks (levelMasks doesn't
  // consult this) — it just doesn't paint the screen.
  const bgFloor = world.floors.find(
    (f) => f.infinite && !f.invisible && floorVisible(f, player.z, player.pos, cap),
  );
  ctx.fillStyle = bgFloor ? bgFloor.color : player.z < 0 ? UNDERGROUND_BG : VOID_BG;
  ctx.fillRect(0, 0, w, h);
  // Grid settings come from the background floor; the fallback backdrops
  // (underground dirt / void) keep their fixed faint grids.
  const showGrid = bgFloor ? bgFloor.grid === true : true;
  const gridColor = bgFloor
    ? (bgFloor.gridColor ?? "#5ca76c")
    : player.z < 0
      ? UNDERGROUND_GRID
      : VOID_GRID;
  const gridWidth = bgFloor ? (bgFloor.gridWidth ?? 1) : 1;
  const gridGap = bgFloor ? (bgFloor.gridGap ?? GRID) : GRID;

  // Camera transform: world -> screen, scaled by 1/zoom around the screen center.
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.translate(-camPos.x, -camPos.y);

  profiler.begin("render.grid");
  if (showGrid) drawGrid(camPos, center, w, h, zoom, gridColor, gridWidth, gridGap);
  profiler.end("render.grid");

  // World-space rect covering the whole screen (padded): the outer boundary the
  // subtractive masks punch their holes in.
  const vpX = camPos.x - center.x * zoom - 64;
  const vpY = camPos.y - center.y * zoom - 64;
  const vpW = w * zoom + 128;
  const vpH = h * zoom + 128;

  // Viewport culling: skip anything whose bounds fall entirely off-screen. The
  // vp rect is already padded (64px), so nothing near an edge pops. Turns the
  // "draw the whole map every frame" cost into "draw what's on screen".
  const vminx = vpX;
  const vmaxx = vpX + vpW;
  const vminy = vpY;
  const vmaxy = vpY + vpH;
  const aabbInView = (a: AABB): boolean =>
    a.maxx >= vminx && a.minx <= vmaxx && a.maxy >= vminy && a.miny <= vmaxy;
  const rectInView = (o: Box): boolean => aabbInView(worldAabb(o));
  const pointInView = (p: Vec2, r: number): boolean =>
    p.x + r >= vminx && p.x - r <= vmaxx && p.y + r >= vminy && p.y - r <= vmaxy;

  // The active gamemode's HUD data, computed once and reused for the in-world
  // overlay (domination points), the minimap, and the HUD panel.
  const gh: GamemodeHud | null = game ? game.gamemode.hud(game) : null;

  // Sight mask (meta.visibility): the player sees only what a straight line on
  // their own level reaches. Everything else — their level outside that
  // polygon, and every other level whole — draws static (no enemies, items or
  // rounds) and darkened. Each level renders to an offscreen canvas so the
  // darkening lands exactly on what that level painted, once; see sight.ts.
  let sight: Path2D | null = null;
  let unseen: Path2D | null = null;
  let offHalves: Path2D | null = null;
  const nearHalves = new Map<number, Path2D>();
  if (game && sightMask) {
    // The vision cone, eased toward the aimed weapon's (see Game.visionCone).
    // Within half a degree of all round it is no cone at all.
    const coneDeg = game.visionCone;
    const cone: SightCone | undefined =
      coneDeg < 359.5
        ? { dir: player.forward, halfAngle: (coneDeg * Math.PI) / 360, grace: VISION_GRACE_R }
        : undefined;
    const poly = profiler.measure("render.sight", () =>
      visibilityPolygon(world, player.pos, player.z, { minx: vpX, miny: vpY, maxx: vpX + vpW, maxy: vpY + vpH }, cone),
    );
    sight = new Path2D();
    addPoly(sight, poly);
    unseen = new Path2D(sight);
    unseen.rect(vpX, vpY, vpW, vpH); // with evenodd: the viewport minus the polygon
    // A flight touching the player's level is half on it and half off it,
    // whichever level's pass draws it (always its lower end's — moving it up
    // to the player's pass would paint it over whoever stands on its lower
    // half). Drawn in the player's pass: darken the far half. Drawn in a lower
    // level's pass: spare the near half from that level's blanket darkening
    // and treat it like the player's level instead (dark only outside the
    // polygon).
    for (const s of world.stairs) {
      if ((s.zAtMin !== player.z && s.zAtMax !== player.z) || !rectInView(s)) continue;
      const lower = Math.min(s.zAtMin, s.zAtMax);
      if (lower === player.z) {
        offHalves = offHalves ?? new Path2D();
        addPoly(offHalves, stairOffHalf(s, player.z));
      } else {
        let near = nearHalves.get(lower);
        if (!near) nearHalves.set(lower, (near = new Path2D()));
        addPoly(near, stairOffHalf(s, lower)); // the half NOT on the lower level = the player's
      }
    }
    // The background is a level too (its infinite floor's): unseen outside the
    // polygon when that is the player's level, unseen entirely otherwise.
    ctx.fillStyle = UNSEEN_TINT;
    if (bgFloor && bgFloor.level === player.z) ctx.fill(unseen, "evenodd");
    else ctx.fillRect(vpX, vpY, vpW, vpH);
  }
  // Painter's order by level, lowest first: higher floors composite over lower
  // ones, so walking under a balcony puts it over your head for free.
  profiler.begin("render.levels");
  const drawLevel = (z: number): void => {
    // Surfaces draw alpha-eased and unmasked: a fading roof lingers translucent
    // while the objects it hid stay masked sharply below.
    for (const f of world.floors) {
      if (!f.infinite && f.level === z && f.alpha > 0.01 && !f.invisible && rectInView(f)) drawFloor(f);
    }
    for (const s of world.stairs) {
      if (Math.min(s.zAtMin, s.zAtMax) === z && s.alpha > 0.01 && rectInView(s)) drawStairs(s);
    }
    // `live`: the pass that draws everything. The sight mask's other pass draws
    // only what the player could know is there without seeing it — the level
    // itself, vehicles, teammates and their corpses — and no enemies, enemy
    // corpses, items or rounds.
    const drawObjectsIn = (live: boolean): void =>
      profiler.measure("render.draw", () => {
        const showChar = (c: Character): boolean => live || c === player || !areHostile(c.team, player.team);
        // An obstacle's optional visibleFrom/invisible are purely cosmetic
        // (second-story walls hidden from the ground, invisible barriers) — it
        // still collides either way.

        // Objective rings are painted ON the ground, so they go under everything
        // that stands on it — corpses included.
        if (gh?.points) for (const v of gh.points) if (v.z === z) drawDomRing(v);

        for (const b of bodies) {
          if (b.z === z && (live || !areHostile(b.team, player.team)) && pointInView(b.pos, BODY_RADIUS)) b.draw(ctx);
        }

        // Ground items, each highlighting itself when it's the one the player would
        // grab with E (drawn by the item, so the ring sits between its backdrop
        // disc and its sprite).
        if (live)
          for (const it of world.items)
            if (it.z === z && pointInView(it.pos, it.radius)) it.draw(ctx, it === game?.interactable);

        // Rounds sit between the two kinds of obstacle: OVER what they fly
        // through, UNDER what stops them. A fence (permeable) never stops a bullet
        // or a rocket, so a tracer crossing one belongs in front of it; a wall does
        // stop them, so it hides what it swallowed — and a wallbanging round
        // disappears into the near face and reappears past the far one, which is
        // exactly what it did.
        //
        // Authored `depth` still orders each group internally (both passes walk
        // the same depth-sorted array); what this gives up is depth ordering
        // BETWEEN a fence and a wall, which now always resolves fence-first.
        const drawObstaclesWhere = (permeable: boolean): void => {
          for (const o of world.obstacles) {
            if (o.z !== z || o.invisible || !rectInView(o)) continue;
            if (!!o.permeable !== permeable) continue;
            if (!o.visibleFrom || zsetHas(o.visibleFrom, player.z)) drawObstacle(o);
          }
        };


        drawObstaclesWhere(true);


        // Arms, hands and gun go UNDER the rounds: cosmetic reach with no hitbox
        // behind it, so a tracer crossing them belongs in front. The heads —
        // which are the hitbox — come after, further down this pass.
        for (const c of characters) {
          if (c.z === z && showChar(c) && pointInView(c.pos, BODY_RADIUS)) c.draw(ctx, "limbs");
        }
        if (live) {
          drawBullets(z);
          drawProjectiles(z);
        }
        drawObstaclesWhere(false);
        // Bullet holes on the walls just drawn. In BOTH passes, like the walls
        // they're on: a hole bites into the wall's footprint, which the sight
        // polygon stops at, so a live-only draw would clip it to nothing.
        const holeImg = world.decals.length ? assetImage("bullethole.png") : null;
        if (holeImg) {
          drawDecals(ctx, world.decals.filter((d) =>
            (!d.on.visibleFrom || zsetHas(d.on.visibleFrom, player.z)) && rectInView(d.on)), holeImg, z);
        }
        // ...and the heads on top of the rounds, since that is what stops them.
        for (const c of characters) {
          if (c.z === z && showChar(c) && pointInView(c.pos, BODY_RADIUS)) c.draw(ctx, "head");
        }



        // Vehicle chassis (parts drawn UNDER occupants); the turret/roof parts
        // (`over`) draw after the characters below, so occupants sit inside the hull.
        for (const v of world.vehicles) {
          if (v.z !== z || !aabbInView(v.aabb())) continue;
          for (const pw of v.worldParts()) if (!pw.spec.over) drawVehiclePart(pw.box, pw.spec);
        }

        // Enter-prompt ring on the seat the player would board with E.
        if (live && game?.enterable && game.enterable.vehicle.z === z) {
          const sp = game.enterable.vehicle.seatWorld(game.enterable.seat);
          ctx.strokeStyle = "#3ddcff";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, BODY_RADIUS + 6, 0, Math.PI * 2);
          ctx.stroke();
        }


        // Turret/roof parts on top of the occupants.
        for (const v of world.vehicles) {
          if (v.z !== z || !aabbInView(v.aabb())) continue;
          for (const pw of v.worldParts()) if (pw.spec.over) drawVehiclePart(pw.box, pw.spec);
        }
        if (live) drawParticles(ctx, world.particles, z);
        // ...and the letters over the top of the whole level, so a body standing
        // on a point never hides which point it is.
        if (gh?.points) for (const v of gh.points) if (v.z === z) drawDomLabel(v);
      });
    /** One draw of this level's objects, under whatever clip the caller set.
     *  With the sight mask on, the player's level is drawn live inside the
     *  polygon and static outside it; any other level is static throughout. */
    const drawObjects = (): void => {
      if (!sight) {
        drawObjectsIn(true);
      } else if (z !== player.z) {
        drawObjectsIn(false);
      } else {
        ctx.save();
        ctx.clip(sight);
        drawObjectsIn(true);
        ctx.restore();
        ctx.save();
        ctx.clip(unseen!, "evenodd");
        drawObjectsIn(false);
        ctx.restore();
      }
    };

    // At and above the enclosure cap the world is hidden, except through the
    // stairwell shafts that pierce it — so from inside a bunker you still see
    // someone coming down the stairs before they cross the midpoint.
    if (z >= cap) {
      let shaft: Path2D | null = null;
      for (const s of world.stairs) {
        if (s.zAtMin !== z && s.zAtMax !== z) continue;
        if (!stairsVisible(s, player.z, cap)) continue; // its low end must be below the cap
        shaft = shaft ?? new Path2D();
        addPoly(shaft, rectCorners(s.pos, s.w, s.h, s.angle, STAIR_MASK_PAD));
      }
      if (shaft) {
        ctx.save();
        ctx.clip(shaft);
        drawObjects();
        ctx.restore();
      }
      return;
    }

    const m = profiler.measure("render.mask", () => levelMasks(z, rectInView));

    if (m.visibleInf) {
      // A visible infinite floor (the ground) backs the whole level: no masking.
      drawObjects();
      return;
    }

    // Pass A: draw everywhere except hidden-surface regions. An infinite hidden
    // floor (the ground seen from underground) blankets the level: skip to B.
    if (!m.hiddenInf) {
      ctx.save();
      if (m.hidden) {
        const cut = new Path2D(m.hidden);
        cut.rect(vpX, vpY, vpW, vpH);
        ctx.clip(cut, "evenodd"); // viewport minus the hidden rects
      }
      drawObjects();
      ctx.restore();
    }

    // Pass B: visible wins over hidden — redraw the parts pass A subtracted
    // that a visible surface backs (the stairwell sliver seen from underground,
    // doorway overlap strips). Consecutive clips intersect.
    if (m.visible && (m.hiddenInf || m.hidden)) {
      ctx.save();
      ctx.clip(m.visible);
      // Against an infinite hidden floor the intersection is just `visible`.
      if (!m.hiddenInf && m.hidden) ctx.clip(m.hidden);
      drawObjects();
      ctx.restore();
    }
  };
  for (const z of presentLevels()) {
    if (!sight) {
      drawLevel(z);
      continue;
    }
    // Paint the level offscreen, same size and camera transform as the screen.
    ctx = offCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    ctx.setTransform(mainCtx.getTransform());
    drawLevel(z);
    // Darken it where it can't be seen — source-atop only touches what it drew.
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = UNSEEN_TINT;
    const near = nearHalves.get(z);
    if (z !== player.z && !near) {
      ctx.fillRect(vpX, vpY, vpW, vpH);
    } else if (z !== player.z) {
      // Another level, but it drew flights whose near half is the player's:
      // blanket-darken everything except those halves...
      ctx.save();
      const rest = new Path2D(near!);
      rest.rect(vpX, vpY, vpW, vpH);
      ctx.clip(rest, "evenodd");
      ctx.fillRect(vpX, vpY, vpW, vpH);
      ctx.restore();
      // ...and darken the halves only where the polygon doesn't reach.
      ctx.save();
      ctx.clip(near!);
      ctx.fill(unseen!, "evenodd");
      ctx.restore();
    } else {
      ctx.fill(unseen!, "evenodd");
      // The off halves of the flights, where they fall INSIDE the polygon (the
      // fill above already took care of the rest, and nothing darkens twice).
      if (offHalves) {
        ctx.save();
        ctx.clip(sight);
        ctx.fill(offHalves);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    // ...and composite it onto the screen.
    ctx = mainCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offCanvas, 0, 0);
    ctx.restore();
  }

  profiler.end("render.levels");

  // Editor overlay: snap grid, spawn markers, selection outline + handles. Only
  // while actually editing — a playtest suppresses it (editor exists but game is live).
  if (editor && !game) editor.drawWorld(ctx);

  ctx.restore();

  if (game) {
    profiler.begin("render.hud");
    drawHud(ctx, {
      w,
      h,
      center,
      player,
      healthBar,
      armorBar,
      mouse,
      spread: game.crosshairSpread,
      interactableLabel: game.interactLabel(),
      gamemode: gh ?? undefined,
      showScoreboard: isAction("scoreboard"),
      killFeed: game.killFeed,
      damageMarks: player.damageMarks,
      minimap: minimap ?? undefined,
      characters,
      deaths: game.minimapDeaths,
    });
    profiler.end("render.hud");
    updateRespawnMenu?.(gh, isAction("scoreboard"));
  }

  if (profiler.enabled) drawProfilerOverlay(ctx, window.innerWidth);
}

// --- profiler overlay (toggle with P) ---------------------------------------
let profReport: { label: string; msPerFrame: number; calls: number }[] = [];
let pDown = false;

function drawProfilerOverlay(ctx: CanvasRenderingContext2D, w: number): void {
  const pad = 8;
  const lineH = 15;

  // Group by section (the label prefix before the first "."). A dotless label is
  // its section's header (e.g. "ai", "render"); dotted labels are that section's
  // children. Flattening everything and sorting purely by time — the old way —
  // let a sub-span like "ai.route" render directly beneath an unrelated section's
  // header (or above its own), which read as it belonging to the wrong section.
  // Build a cost TREE from the flat spans. Dotted labels nest under their prefix
  // (ai.route -> ai, render.hud -> render); the per-tick phases (ai, collide, ...)
  // nest under "update" — begun inside the update span but not prefixed.
  // Everything else is a root. The tree drives indentation and ordering; EVERY
  // row's % is of the grand TOTAL (not its parent), so a number reads directly as
  // "this much of the frame" — the share you'd claw back by optimizing it. Rows
  // are contained in their parent, so a parent's % >= the sum of its children's.
  const UPDATE_PHASES = new Set(["surfaces", "ai", "collide", "bullets", "items", "rules"]);
  const parentOf = (label: string): string | null => {
    const dot = label.indexOf(".");
    if (dot >= 0) return label.slice(0, dot);
    return UPDATE_PHASES.has(label) ? "update" : null;
  };
  interface Node {
    label: string;
    ms: number;
    kids: Node[];
  }
  const nodes = new Map<string, Node>();
  for (const r of profReport) nodes.set(r.label, { label: r.label, ms: r.msPerFrame, kids: [] });
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const p = parentOf(n.label);
    const parent = p ? nodes.get(p) : undefined;
    if (parent) parent.kids.push(n);
    else roots.push(n);
  }
  const total = roots.reduce((s, n) => s + n.ms, 0);

  // Fixed order so rows keep their place frame-to-frame: roots then phases by
  // execution order, everything else alphabetical.
  const ROOT_ORDER = ["update", "render"];
  const PHASE_ORDER = ["surfaces", "ai", "collide", "bullets", "items", "rules"];
  const orderBy = (order: string[]) => (a: Node, b: Node): number => {
    const ia = order.indexOf(a.label);
    const ib = order.indexOf(b.label);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.label.localeCompare(b.label);
  };
  roots.sort(orderBy(ROOT_ORDER));

  // Flatten depth-first; a child drops its parent prefix for a compact label.
  const leaf = (label: string): string => {
    const dot = label.indexOf(".");
    return dot < 0 ? label : label.slice(dot + 1);
  };
  interface Line {
    text: string;
    ms: number;
    pct: number;
    depth: number;
  }
  const lines: Line[] = [];
  const walk = (n: Node, depth: number): void => {
    lines.push({ text: leaf(n.label), ms: n.ms, pct: total > 0 ? (100 * n.ms) / total : 0, depth });
    n.kids.sort(n.label === "update" ? orderBy(PHASE_ORDER) : orderBy([]));
    for (const k of n.kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  const boxW = 264;
  const boxH = pad * 2 + lineH * (lines.length + 3); // title + TOTAL + rows
  const x = w - boxW - 10;
  const y = 10;
  const msX = x + boxW - pad - 52; // right edge of the ms column
  const pctX = x + boxW - pad; // right edge of the % column
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.font = "12px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#8fd6ff";
  ctx.fillText("PROFILER (P)      ms   %total", x + pad, y + pad);

  let ly = y + pad + lineH * 2 - 4;
  // TOTAL first — the frame's measured cost; every root's % is a share of it.
  ctx.fillStyle = "#8fd6ff";
  ctx.textAlign = "left";
  ctx.fillText("TOTAL", x + pad, ly);
  ctx.textAlign = "right";
  ctx.fillText(total.toFixed(2), msX, ly);
  ctx.fillText("100%", pctX, ly);
  ly += lineH;

  for (const l of lines) {
    ctx.fillStyle = l.depth === 0 ? "#e6e9ee" : l.depth === 1 ? "#c3c9d0" : "#9aa4af";
    ctx.textAlign = "left";
    ctx.fillText("  ".repeat(l.depth) + l.text, x + pad, ly);
    ctx.textAlign = "right";
    ctx.fillText(l.ms.toFixed(2), msX, ly);
    ctx.fillText(l.pct.toFixed(0) + "%", pctX, ly);
    ly += lineH;
  }
  ctx.restore();
}

// A bad edit must never take the editor down. frame() is the RAF callback, so
// an uncaught throw in the bare-editor update/render kills the loop for good —
// instead, catch it: the loop and the DOM panel stay alive (so the offending
// field can be fixed), the canvas save()/clip() stack a mid-render throw
// strands is unwound, and the error is logged, throttled. Play mode is not
// guarded — a broken match should fail loudly, not limp.
let lastEditorErrAt = 0;
function editorGuard(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    for (let i = 0; i < 64; i++) ctx.restore(); // no-op once the stack is empty
    const t = performance.now();
    if (t - lastEditorErrAt > 2000) {
      lastEditorErrAt = t;
      console.error("[editor] error (editor kept alive — fix or undo the last edit):", err);
    }
  }
}

function frame(now: number): void {
  // P toggles the profiler overlay (and resets the accumulators).
  if (isDown("KeyP")) {
    if (!pDown) {
      profiler.enabled = !profiler.enabled;
      profiler.reset();
      profReport = [];
    }
    pDown = true;
  } else pDown = false;

  const frameGap = now - last;
  accumulator += frameGap;
  last = now;
  // Guard against huge jumps (e.g. tab was backgrounded).
  if (accumulator > 250) accumulator = 250;
  // Settings open: the match is paused. Drop the time rather than bank it, so
  // closing the menu doesn't replay a burst of catch-up ticks.
  const settingsOpen = settingsMenu?.isOpen() ?? false;
  if (settingsOpen) accumulator = 0;
  if (settingsWasOpen && !settingsOpen) renderHint(); // bindings may have changed
  settingsWasOpen = settingsOpen;

  profiler.begin("update");
  const tUpdate = performance.now();
  let ticks = 0;
  while (accumulator >= STEP && ticks < maxCatchup) {
    accumulator -= STEP;
    ticks++;
    // Sound is live for the last couple of ticks of a frame and silent for
    // deep catch-up. A 2-tick frame is ordinary vsync jitter, not a lag spike
    // — muting its first tick was randomly eating the player's own shot
    // sounds — and a sound from a tick ≤2 ticks stale plays ≤33ms late,
    // below the ear's ~40ms fusion threshold (and same-file overlaps merge in
    // the coalescer anyway). Only a real spike's replay (~15 ticks) must stay
    // silent, so nothing stacks 15 ticks of gunfire into one instant.
    setAudioLive(accumulator < STEP * 2.5);
    // A live match (booted-in or a playtest) steps the game; otherwise the editor.
    if (game) game.update();
    else editorGuard(() => editor!.update());
  }
  setAudioLive(true);
  profiler.end("update");
  const updateMs = performance.now() - tUpdate;
  // Survev-style per-frame audio housekeeping: re-resume a suspended context,
  // reclaim finished voices (stopTime polling).
  updateAudio();
  watchAudio(frameGap, ticks, now);

  profiler.begin("render");
  const tRender = performance.now();
  if (game) render();
  else editorGuard(render);
  profiler.end("render");
  prevUpdateMs = updateMs;
  prevRenderMs = performance.now() - tRender;

  profiler.endFrame();
  // Refresh the on-screen averages about once a second.
  if (profiler.enabled && profiler.frameCount >= 60) {
    profReport = profiler.rows();
    profiler.reset();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
