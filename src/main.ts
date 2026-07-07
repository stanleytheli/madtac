import { Character } from "./actor.ts";
import type { Body } from "./body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./character.ts";
import { worldAabb, type Box } from "./collision.ts";
import { Editor } from "./editor.ts";
import { Game } from "./game.ts";
import { DEFAULT_MODE, GAMEMODES, type GamemodeHud } from "./gamemodes/gamemode.ts";
import { resolveTdm, type TdmOverrides } from "./gamemodes/tdm.ts";
import { Gun } from "./gun.ts";
import * as Guns from "./guns.ts";
import { ARMOR_SPECS, GUN_SPECS, loadLevel, SKINS, type LevelMeta, type TeamConfig } from "./level.ts";
import { LEVELS } from "./levels.ts";
import { initInput, isDown, mouse } from "./input.ts";
import { drawParticles } from "./particle.ts";
import { disjointPolys, rectCorners, type Poly } from "./poly.ts";
import { profiler } from "./profiler.ts";
import { drawHud, HealthBar } from "./ui.ts";
import { dist, norm, scale, sub, vec, type Vec2 } from "./vec.ts";
import {
  enclosureCap,
  floorVisible,
  stairsVisible,
  zsetHas,
  type Floor,
  type Obstacle,
  type Stairs,
} from "./world.ts";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let dpr = 1;
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}
window.addEventListener("resize", resize);
resize();

initInput(canvas);

// ?edit=true boots the level editor instead of the game: no enemies or combat,
// the player noclips, and the editor drives the camera + all world mutation.
const params = new URLSearchParams(location.search);
const EDIT = params.get("edit") === "true";

// The map: ?level=<name> picks a JSON from src/levels/; with no param the
// arena-teamfight map loads. (?edit composes: ?edit=true&level=foo edits it.)
const DEFAULT_LEVEL = "tdm-arena-big";

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

/** TDM parameter overrides read off the URL, e.g.
 *  ?mode=tdm&killLimit=10&respawnDelay=90&blueTroops=2&redSkill=1&redEquip=4 */
function tdmUrlOverrides(): TdmOverrides {
  const o: TdmOverrides = {};
  const kl = numParam("killLimit");
  if (kl !== undefined) o.killLimit = kl;
  const rd = numParam("respawnDelay");
  if (rd !== undefined) o.respawnDelay = rd;
  for (const side of ["blue", "red"] as const) {
    const s: Partial<TeamConfig> = {};
    const troops = numParam(`${side}Troops`);
    if (troops !== undefined) s.troops = troops;
    const skill = numParam(`${side}Skill`);
    if (skill !== undefined) s.skill = skill;
    const equip = numParam(`${side}Equip`);
    if (equip !== undefined) s.equip = equip;
    if (Object.keys(s).length > 0) o[side] = s;
  }
  return o;
}

// Effective meta for the gamemode: the level's meta with the chosen mode and,
// for TDM, its parameters merged with any URL overrides (URL wins). This stays
// runtime-only — the loaded level (and what the editor would save) is untouched.
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

// Stable references for the renderer: the game's live arrays/objects (mutated in
// place, never reassigned), or the editor's lone player when editing.
const world = game ? game.world : loaded.world;
const player = game ? game.player : editorPlayer!;
const characters = game ? game.characters : [editorPlayer!];
const bodies = game ? game.bodies : editorBodies;
const camera = game ? game.camera : { size: editorPlayer!.gun.spec.zoom };

const healthBar = new HealthBar({ width: 450, height: 35 });
// Slightly shorter cyan bar for armor, stacked above the health bar.
const armorBar = new HealthBar({ width: 450, height: 20, fillColor: "#33d6e0", radius: 0, displayLoss: false });

/**
 * The respawn-screen loadout dropdown (TDM): a small DOM panel with primary /
 * secondary / armor selects, shown only while the player is dead and choosing
 * their next kit. Built once (for modes that support it) and toggled by the HUD.
 */
function buildRespawnMenu(g: Game): (hud: GamemodeHud | null) => void {
  const SELECT_CSS =
    "background:#23262c;color:#dfe2e8;border:1px solid #3a3e46;border-radius:4px;font:inherit;padding:3px 6px;min-width:150px;";
  const addOpts = (sel: HTMLSelectElement, specs: Record<string, { name: string }>): void => {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(none)";
    sel.append(none);
    for (const [key, spec] of Object.entries(specs)) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = spec.name;
      sel.append(o);
    }
  };
  const mkSelect = (specs: Record<string, { name: string }>): HTMLSelectElement => {
    const s = document.createElement("select");
    s.style.cssText = SELECT_CSS;
    addOpts(s, specs);
    return s;
  };
  const primary = mkSelect(GUN_SPECS);
  const secondary = mkSelect(GUN_SPECS);
  const armor = mkSelect(ARMOR_SPECS);

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;left:50%;top:58%;transform:translateX(-50%);display:none;flex-direction:column;" +
    "gap:8px;background:rgba(14,16,20,0.9);color:#dfe2e8;font:13px system-ui,sans-serif;" +
    "padding:14px 16px;border-radius:10px;z-index:20;min-width:260px;";
  const title = document.createElement("div");
  title.textContent = "LOADOUT";
  title.style.cssText = "font-weight:bold;letter-spacing:1px;opacity:0.7;text-align:center;";
  panel.append(title);
  const row = (label: string, sel: HTMLSelectElement): HTMLElement => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;";
    const l = document.createElement("span");
    l.textContent = label;
    r.append(l, sel);
    return r;
  };
  panel.append(row("Primary", primary), row("Secondary", secondary), row("Armor", armor));
  document.body.append(panel);

  const apply = (): void =>
    g.gamemode.setPlayerLoadout?.({
      primary: primary.value || undefined,
      secondary: secondary.value || undefined,
      armor: armor.value || undefined,
    });
  primary.onchange = apply;
  secondary.onchange = apply;
  armor.onchange = apply;

  let shown = false;
  return (hud: GamemodeHud | null): void => {
    const show = !!hud?.choosingLoadout;
    if (show && !shown) {
      // Just opened: reflect the player's current chosen kit in the dropdowns.
      primary.value = hud!.loadout?.primary ?? "";
      secondary.value = hud!.loadout?.secondary ?? "";
      armor.value = hud!.loadout?.armor ?? "";
    }
    panel.style.display = show ? "flex" : "none";
    shown = show;
  };
}

// Only modes with a customizable respawn (TDM) build the menu.
const updateRespawnMenu = game && game.gamemode.setPlayerLoadout ? buildRespawnMenu(game) : null;

const screenCenter = (): Vec2 => vec(window.innerWidth / 2, window.innerHeight / 2);

// --- fixed-timestep loop: 60 physics ticks/s, render every frame ---
const STEP = 1000 / 60;
let accumulator = 0;
let last = performance.now();

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

function drawObstacle(o: Obstacle): void {
  ctx.save();
  ctx.translate(o.pos.x, o.pos.y);
  ctx.rotate(o.angle ?? 0);
  const x = -o.w / 2;
  const y = -o.h / 2;
  ctx.fillStyle = o.fill;
  ctx.fillRect(x, y, o.w, o.h);
  ctx.strokeStyle = o.stroke;
  ctx.lineWidth = o.strokeWidth;
  ctx.strokeRect(x, y, o.w, o.h);
  if (o.cross) {
    // plank "X" detail
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + o.w, y + o.h);
    ctx.moveTo(x + o.w, y);
    ctx.lineTo(x, y + o.h);
    ctx.stroke();
  }
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

    ctx.lineWidth = b.tracerWidth; // cosmetic, from the firing gun's spec

    const dir = norm(b.vel);
    // Streak from the tip back by the gun's tracer length, clamped so it never
    // pokes back out of the muzzle (past origin + renderAfter).
    const tailLen = Math.min(b.tracerLength, traveled - b.renderAfter);
    const tip = b.pos;
    const tail = sub(tip, scale(dir, tailLen));

    // Fade the gun's tracer color from transparent at the tail to solid at the tip.
    const rgb = rgbTriple(b.tracerColor);
    const grad = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},0.95)`);
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
}

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
  const zoom = editor ? editor.zoom : camera.size; // editor: free wheel-zoom
  const camPos = player.pos; // camera centers on the player

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
  const rectInView = (o: Box): boolean => {
    const a = worldAabb(o);
    return a.maxx >= vminx && a.minx <= vmaxx && a.maxy >= vminy && a.miny <= vmaxy;
  };
  const pointInView = (p: Vec2, r: number): boolean =>
    p.x + r >= vminx && p.x - r <= vmaxx && p.y + r >= vminy && p.y - r <= vmaxy;

  // Painter's order by level, lowest first: higher floors composite over lower
  // ones, so walking under a balcony puts it over your head for free.
  profiler.begin("render.levels");
  for (const z of presentLevels()) {
    // Surfaces draw alpha-eased and unmasked: a fading roof lingers translucent
    // while the objects it hid stay masked sharply below.
    for (const f of world.floors) {
      if (!f.infinite && f.level === z && f.alpha > 0.01 && !f.invisible && rectInView(f)) drawFloor(f);
    }
    for (const s of world.stairs) {
      if (Math.min(s.zAtMin, s.zAtMax) === z && s.alpha > 0.01 && rectInView(s)) drawStairs(s);
    }

    const drawObjects = (): void =>
      profiler.measure("render.draw", () => {
        // An obstacle's optional visibleFrom/invisible are purely cosmetic
        // (second-story walls hidden from the ground, invisible barriers) — it
        // still collides either way.
        for (const o of world.obstacles) {
          if (o.z !== z || o.invisible || !rectInView(o)) continue;
          if (!o.visibleFrom || zsetHas(o.visibleFrom, player.z)) drawObstacle(o);
        }
        for (const b of bodies) if (b.z === z && pointInView(b.pos, BODY_RADIUS)) b.draw(ctx);
        for (const it of world.items) if (it.z === z && pointInView(it.pos, it.radius)) it.draw(ctx);
        for (const c of characters) if (c.z === z && pointInView(c.pos, BODY_RADIUS)) c.draw(ctx);
        drawBullets(z);
        drawParticles(ctx, world.particles, z);
      });

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
      continue;
    }

    const m = profiler.measure("render.mask", () => levelMasks(z, rectInView));

    if (m.visibleInf) {
      // A visible infinite floor (the ground) backs the whole level: no masking.
      drawObjects();
      continue;
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
  }

  profiler.end("render.levels");

  // Editor overlay: snap grid, spawn markers, selection outline + handles.
  editor?.drawWorld(ctx);

  ctx.restore();

  if (!editor) {
    const gh = game!.gamemode.hud(game!);
    profiler.begin("render.hud");
    drawHud(ctx, {
      w,
      h,
      center,
      player,
      healthBar,
      armorBar,
      mouse,
      interactableLabel: game!.interactable ? game!.interactable.label : null,
      gamemode: gh ?? undefined,
      showScoreboard: isDown("tab"),
    });
    profiler.end("render.hud");
    updateRespawnMenu?.(gh);
  }

  if (profiler.enabled) drawProfilerOverlay(ctx, window.innerWidth);
}

// --- profiler overlay (toggle with P) ---------------------------------------
let profReport: { label: string; msPerFrame: number; calls: number }[] = [];
let pDown = false;

function drawProfilerOverlay(ctx: CanvasRenderingContext2D, w: number): void {
  const pad = 8;
  const lineH = 15;
  const rows = profReport;
  const boxW = 240;
  const boxH = pad * 2 + lineH * (rows.length + 2);
  const x = w - boxW - 10;
  const y = 10;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.font = "12px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#8fd6ff";
  ctx.fillText("PROFILER (P)  ms/frame", x + pad, y + pad);
  let ly = y + pad + lineH * 2 - 4;
  for (const r of rows) {
    // update/render are totals; indent the sub-spans under them.
    const sub = r.label.includes(".");
    ctx.fillStyle = sub ? "#9aa4af" : "#e6e9ee";
    ctx.fillText((sub ? "  " : "") + r.label, x + pad, ly);
    ctx.textAlign = "right";
    ctx.fillText(r.msPerFrame.toFixed(2), x + boxW - pad, ly);
    ctx.textAlign = "left";
    ly += lineH;
  }
  ctx.restore();
}

function frame(now: number): void {
  // P toggles the profiler overlay (and resets the accumulators).
  if (isDown("p")) {
    if (!pDown) {
      profiler.enabled = !profiler.enabled;
      profiler.reset();
      profReport = [];
    }
    pDown = true;
  } else pDown = false;

  accumulator += now - last;
  last = now;
  // Guard against huge jumps (e.g. tab was backgrounded).
  if (accumulator > 250) accumulator = 250;

  profiler.begin("update");
  while (accumulator >= STEP) {
    if (editor) editor.update();
    else game!.update();
    accumulator -= STEP;
  }
  profiler.end("update");

  profiler.begin("render");
  render();
  profiler.end("render");

  profiler.endFrame();
  // Refresh the on-screen averages about once a second.
  if (profiler.enabled && profiler.frameCount >= 60) {
    profReport = profiler.rows();
    profiler.reset();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
