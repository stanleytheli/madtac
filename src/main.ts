import { Character } from "./actor.ts";
import * as Armors from "./armor.ts";
import { Body } from "./body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./character.ts";
import { hasLineOfSight, pointInBox, resolveCircleVsBox, resolveCircleVsCircle } from "./collision.ts";
import { Editor } from "./editor.ts";
import { Gun } from "./gun.ts";
import * as Guns from "./guns.ts";
import { ArmorItem, GunItem, separateItems, type GroundItem } from "./item.ts";
import { spawnEnemy } from "./enemies.ts";
import {
  ARMOR_SPECS,
  DEFAULT_PLAYER_PRIMARY,
  DEFAULT_PLAYER_SECONDARY,
  GUN_SPECS,
  SKINS,
  loadLevel,
  type EnemySpawn,
  type PlayerSpawn,
} from "./level.ts";
import { LEVELS } from "./levels.ts";
import { NavGraph } from "./nav.ts";
import { Robot, type AiContext } from "./robot.ts";
import { initInput, isDown, mouse, moveAxis, pointer } from "./input.ts";
import { drawParticles } from "./particle.ts";
import { drawHud, HealthBar, hudHitTest, type SlotKind } from "./ui.ts";
import { dist, fromAngle, norm, scale, sub, vec, type Vec2 } from "./vec.ts";
import {
  createWorld,
  enclosureCap,
  floorVisible,
  stairsVisible,
  stairZ,
  updateBullets,
  updateSurfaceAlphas,
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

// The map: ?level=<name> picks a JSON from src/levels/; with no param a file
// named default.json is used if the folder has one; otherwise the hand-coded
// demo map below. (?edit composes: ?edit=true&level=foo edits that level.)
const DEFAULT_LEVEL = "arena-teamfight-skins"

const levelName = params.get("level");
if (levelName && !(levelName in LEVELS)) {
  console.warn(`unknown level "${levelName}" — falling back to the default map`);
}
const levelText = LEVELS[levelName ?? DEFAULT_LEVEL] ?? null;
const loaded = levelText ? loadLevel(levelText) : null;
const world = loaded ? loaded.world : createWorld();

// Where — and as what — the player starts: a singleton entity in the editor,
// so saved levels carry the position, loadout, armor, and skin. Levels without
// one fall back to the origin at ground level with the classic kit.
const playerSpawn: PlayerSpawn[] = loaded ? loaded.playerSpawn : [{ pos: vec(0, 0), z: 0 }];
const start = playerSpawn[0] ?? { pos: vec(0, 0), z: 0 };

/** The gun for a player slot: "none" = empty, omitted/unknown = the default. */
function slotGun(key: string | undefined, fallback: string): Gun | undefined {
  if (key === "none") return undefined;
  const spec = GUN_SPECS[key ?? fallback] ?? GUN_SPECS[fallback];
  return spec ? new Gun(spec) : undefined;
}

const player = new Character(vec(start.pos.x, start.pos.y), SKINS[start.skin ?? ""] ?? DEFAULT_SKIN, {
  primary: slotGun(start.primary, DEFAULT_PLAYER_PRIMARY),
  secondary: slotGun(start.secondary, DEFAULT_PLAYER_SECONDARY),
  hand: new Gun(Guns.UNARMED),
});
if (start.armor && ARMOR_SPECS[start.armor]) {
  player.equipArmor(new Armors.Armor(ARMOR_SPECS[start.armor]));
}
player.z = start.z;
player.team = "player";

// Enemy spawns as *data* (type keys ENEMY_TYPES in enemies.ts) so the editor can
// read/write them like any other entity. The demo cast: two grunts in the open,
// one in the balcony doorway (straddling the hidden second story and the
// always-visible balcony — from the ground you see only its balcony half), one
// in the sealed bunker, one in the open-air trench (visible from the surface,
// unlike the bunker guard), and one under the cake building's stickout
// (revealed the moment you step in the door). They only engage — and can only
// be hit — once you share their level.
const spawns: EnemySpawn[] = loaded
  ? loaded.spawns
  : [
      { type: "robot", gun: "M16", pos: vec(320, -260), z: 0 },
      { type: "oracle", gun: "M16", pos: vec(450, -400), z: 0 },
      { type: "tacoracle", gun: "M16", pos: vec(560, -260), z: 0 },
      // { type: "elite", gun: "M16", armor: "ARMOR_L3", pos: vec(-500, 0), z: 0 },
      { type: "robot", gun: "M9", pos: vec(-640, -450), z: 1 },
      { type: "robot", gun: "M16", pos: vec(880, -140), z: -1 },
      { type: "robot", gun: "M9", pos: vec(260, 480), z: -1 },
      { type: "robot", gun: "M9", pos: vec(60, -720), z: 0 },
    ];

let characters: Character[] = [player];
if (!EDIT) {
  for (const s of spawns) characters.push(spawnEnemy(s));
}
const bodies: Body[] = [];

// The level's baked path cache (Dijkstra over the node graph), for mobile AIs.
// The editor doesn't simulate, so it skips the build (and previews link sets
// live instead — see Editor.drawWorld).
const nav = EDIT ? null : new NavGraph(world);

// Demo pickups for the hand-coded map (a saved level carries its own items).
if (!loaded) {
  // Some guns lying around to pick up.
  world.items.push(new GunItem(vec(-120, -80), new Gun(Guns.Deagle)));
  world.items.push(new GunItem(vec(80, 120), new Gun(Guns.M249)));

  // ...and some armor to try on.
  world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L1)));
  world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L2)));
  world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L3)));
  world.items.push(new ArmorItem(vec(170, -40), new Armors.Armor(Armors.ARMOR_L4)));

  // Bunker loot: worth braving the dark (and its guard) for.
  world.items.push(new GunItem(vec(760, -100), new Gun(Guns.Golden_Deagle), vec(0, 0), -1));
}

// Start surface fades at their correct values so nothing fades in on frame one.
updateSurfaceAlphas(world, player.z, player.pos, true);

// In edit mode the Editor owns input, camera zoom, and the spawn markers.
const editor = EDIT ? new Editor({ world, spawns, playerSpawn }, player, canvas) : null;

// Camera: position follows the player; `size` eases toward the weapon's zoom.
const camera = { size: player.gun.spec.zoom };
const ZOOM_EASE = 0.12;

/**
 * The camera's zoom target: the equipped gun's zoom, modified by whatever floor
 * the player is standing on (inside its rect, at its level) — an absolute floor
 * `zoom` replaces it outright (interiors that limit vision), `deltaZoom`s add
 * to it (balcony lookout points). Absolute wins if a spot somehow has both.
 */
function zoomTarget(): number {
  let abs: number | null = null;
  let delta = 0;
  for (const f of world.floors) {
    if (f.level !== player.z || (f.zoom === undefined && f.deltaZoom === undefined)) continue;
    if (!f.infinite && !pointInBox(player.pos, f)) continue;
    if (f.zoom !== undefined) abs = f.zoom;
    if (f.deltaZoom !== undefined) delta += f.deltaZoom;
  }
  return Math.max(0.3, abs ?? player.gun.spec.zoom + delta);
}

const PICKUP_RANGE = 75; // world px the player can reach a ground item from
let interactable: GroundItem | null = null; // nearest reachable item this tick (for prompt + E)

/** Nearest ground item on the player's level, within reach and line of sight.
 *  Items lying on a staircase are grabbable across levels — a gun dropped on
 *  the upper flight shouldn't need item-falling physics to be reachable. */
function findInteractable(): GroundItem | null {
  let best: GroundItem | null = null;
  let bestD = Infinity;
  for (const it of world.items) {
    const onStairs = world.stairs.some((s) => stairZ(s, it.pos) !== null);
    if (it.z !== player.z && !onStairs) continue; // can't grab across levels
    const d = dist(player.pos, it.pos);
    if (d > PICKUP_RANGE || d >= bestD) continue;
    if (!hasLineOfSight(player.pos, it.pos, world.obstacles, player.z)) continue; // can't reach through walls
    best = it;
    bestD = d;
  }
  return best;
}

/** A small random outward toss impulse for anything spawned on the player. */
function tossVel(): Vec2 {
  return fromAngle(Math.random() * Math.PI * 2, 9.5);
}

/** Pick up a ground item: guns go into their slot, armor gets worn. Whatever was
 *  displaced (a gun in that slot, or the previously worn armor) drops back out. */
function pickUp(item: GroundItem): void {
  const idx = world.items.indexOf(item);
  if (idx >= 0) world.items.splice(idx, 1);
  const here = (): Vec2 => vec(player.pos.x, player.pos.y);

  if (item instanceof GunItem) {
    const dropped = player.holster(item.gun);
    // Physics slides the tossed item clear of anything it might spawn inside of.
    if (dropped) world.items.push(new GunItem(here(), dropped, tossVel(), player.z));
  } else if (item instanceof ArmorItem) {
    const prev = player.equipArmor(item.armor);
    if (prev) world.items.push(new ArmorItem(here(), prev, tossVel(), player.z));
  }
  interactable = null;
}

/** Drop the player's currently equipped weapon into the world (Q). Fists can't be dropped. */
function dropEquippedWeapon(): void {
  const dropped = player.dropEquipped();
  if (!dropped) return;
  const vel = fromAngle(Math.random() * Math.PI * 2, 9.5);
  world.items.push(new GunItem(vec(player.pos.x, player.pos.y), dropped, vel, player.z));
}

/** Drop whatever the player right-clicked in the HUD: a specific weapon slot, or
 *  the worn armor. No-op if that slot is empty. */
function dropFromHud(kind: SlotKind): void {
  const at = vec(player.pos.x, player.pos.y);
  if (kind === "armor") {
    const a = player.dropArmor();
    if (a) world.items.push(new ArmorItem(at, a, tossVel(), player.z));
  } else {
    const g = player.dropSlot(kind);
    if (g) world.items.push(new GunItem(at, g, tossVel(), player.z));
  }
}

const healthBar = new HealthBar({ width: 450, height: 35 });
// Slightly shorter cyan bar for armor, stacked above the health bar.
const armorBar = new HealthBar({ width: 450, height: 20, fillColor: "#33d6e0", radius: 0, displayLoss: false,});

let prevDown = false; // pointer state last tick, for semi-auto edge detection

const screenCenter = (): Vec2 => vec(window.innerWidth / 2, window.innerHeight / 2);

// Aim direction is scale/translation-invariant, so screen-space mouse works directly.
function aimForward(): Vec2 {
  const t = sub(mouse, screenCenter());
  return t.x === 0 && t.y === 0 ? vec(0, -1) : norm(t);
}

// --- fixed-timestep loop: 60 physics ticks/s, render every frame ---
const STEP = 1000 / 60;
let accumulator = 0;
let last = performance.now();

function resolveCollisions(c: Character): void {
  let pos = c.pos;
  // Two passes so corners (crate + crate, or crate + character) settle. Only
  // things on the character's level are solid to them.
  for (let i = 0; i < 2; i++) {
    for (const o of world.obstacles) {
      if (o.z !== c.z) continue;
      pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
    }
    for (const other of characters) {
      if (other === c || other.z !== c.z) continue;
      pos = resolveCircleVsCircle(pos, BODY_RADIUS, other.pos, BODY_RADIUS);
    }
  }
  c.pos = pos;
}

/** Convert any character that hit 0 HP into a Body, dropping its weapons, and remove it. */
function reapDead(): void {
  for (let i = characters.length - 1; i >= 0; i--) {
    const c = characters[i];
    if (c.hp <= 0) {
      // Scatter the dead character's weapons from its body, on its level.
      for (const gun of c.dropWeapons()) {
        const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
        world.items.push(new GunItem(vec(c.pos.x, c.pos.y), gun, vel, c.z));
      }
      const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
      const a = c.dropArmor()
      if (a) world.items.push(new ArmorItem(vec(c.pos.x, c.pos.y), a, vel, c.z));

      bodies.push(Body.fromCharacter(c));
      characters.splice(i, 1);
    }
  }
}

let jDown = false
let kDown = false
let eDown = false
let qDown = false
let rmbDown = false // right mouse button last tick, for click-edge detection

function update(): void {
  // Edit mode replaces the whole simulation: fly, edit, nothing shoots or ticks.
  if (editor) {
    editor.update();
    return;
  }

  const playerAlive = player.hp > 0;
  interactable = playerAlive ? findInteractable() : null;

  if (playerAlive) {
    if (isDown("1")) player.equip("primary");
    if (isDown("2")) player.equip("secondary");
    if (isDown("3")) player.equip("hand");
    if (isDown("r")) player.reload();

    if (isDown("e")) {
      if (!eDown && interactable) pickUp(interactable);
      eDown = true;
    } else eDown = false;

    if (isDown("q")) {
      if (!qDown) dropEquippedWeapon();
      qDown = true;
    } else qDown = false;

    // Right-click a HUD weapon/armor slot to drop that item.
    if (pointer.rightDown) {
      if (!rmbDown) {
        const kind = hudHitTest(mouse, window.innerWidth, window.innerHeight, player);
        if (kind) dropFromHud(kind);
      }
      rmbDown = true;
    } else rmbDown = false;

    if (isDown("j")) {
      if (!jDown) player._takeDamage(22);
      jDown = true;
    } else jDown = false;
    if (isDown("k")) {
      if (!kDown) player._heal(10);
      kDown = true;
    } else kDown = false;
  }

  // Ease the camera zoom toward its target (gun zoom, bent by the floor underfoot).
  camera.size += (zoomTarget() - camera.size) * ZOOM_EASE;

  if (playerAlive) {
    player.forward = aimForward();
    let speedMult = 1.0;
    speedMult *= player.gun.spec.speed;
    if (player.armor) { // Armor speed value -- NOTE: deliberately not used in player max speed calculations
      speedMult *= player.armor.spec.speed;
    }
    player.move(moveAxis(), speedMult);
    resolveCollisions(player);
  }

  // Stair transitions: crossing a staircase's midpoint flips your level (sharp,
  // by design — the visual ramp comes from the step gradient, not easing).
  for (const c of characters) {
    for (const s of world.stairs) {
      const z = stairZ(s, c.pos);
      if (z !== null) c.z = z;
    }
  }

  // Surface fades (roofs melting away, floors of other levels) chase the view.
  updateSurfaceAlphas(world, player.z, player.pos);

  for (const c of characters) c.tickWeapon();

  // Player firing: held trigger for auto, click edge for semi.
  const f = player.gun.spec.fire;
  if (playerAlive && f) {
    const wantFire = f.auto ? pointer.down : pointer.down && !prevDown;
    if (wantFire) player.fire(world);
  }
  prevDown = pointer.down;

  // NPC AI: pick targets by team hostility, shoot, and (movers) chase.
  const ai: AiContext = { world, characters, nav };
  for (const c of characters) {
    if (c instanceof Robot && c.hp > 0) c.think(ai);
  }
  // Movers walk with direct position steps; settle them out of walls and
  // each other (the player already resolved right after their own move).
  for (const c of characters) {
    if (c !== player) resolveCollisions(c);
  }

  updateBullets(world, characters);

  for (const b of bodies) b.update(world.obstacles);
  for (const it of world.items) it.update(world.obstacles);
  separateItems(world.items); // gently spread out any overlapping pickups
  reapDead();
}

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
  ctx.fillRect(fl.pos.x - fl.w / 2, fl.pos.y - fl.h / 2, fl.w, fl.h);
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
  const minx = s.pos.x - s.w / 2;
  const miny = s.pos.y - s.h / 2;
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
  const x = o.pos.x - o.w / 2;
  const y = o.pos.y - o.h / 2;
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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Hidden rects grow by this before masking, so the clip's antialiased edge
// falls just past content that sits flush against it (walls extend exactly to
// the floor slab's edge) instead of on it — without this, boundary pixels
// render half-covered and every hidden room shows as a faint 1px outline.
const MASK_EPS = 1.5;

// Visible stairs mask generously, covering their edge-mounted railings.
const STAIR_MASK_PAD = 10;

/** Pieces of `a` not covered by `b` (0-4 rects). */
function subtractRect(a: Rect, b: Rect): Rect[] {
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  if (b.x >= ax1 || bx1 <= a.x || b.y >= ay1 || by1 <= a.y) return [a]; // no overlap
  const out: Rect[] = [];
  if (b.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: b.y - a.y }); // band above b
  if (by1 < ay1) out.push({ x: a.x, y: by1, w: a.w, h: ay1 - by1 }); // band below b
  const midY = Math.max(a.y, b.y);
  const midH = Math.min(ay1, by1) - midY;
  if (b.x > a.x) out.push({ x: a.x, y: midY, w: b.x - a.x, h: midH }); // left of b
  if (bx1 < ax1) out.push({ x: bx1, y: midY, w: ax1 - bx1, h: midH }); // right of b
  return out;
}

/**
 * Rewrite `rects` as a disjoint set covering the same union. The subtractive
 * mask uses an even-odd fill, where overlapping rects would cancel each other
 * out — this makes any overlap (tiled floors, the MASK_EPS inflation) safe.
 */
function disjointRects(rects: readonly Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    let pieces: Rect[] = [r];
    for (const d of out) {
      pieces = pieces.flatMap((p) => subtractRect(p, d));
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
  }
  return out;
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
function levelMasks(z: number): {
  visibleInf: boolean;
  hiddenInf: boolean;
  visible: Path2D | null;
  hidden: Path2D | null;
} {
  let visibleInf = false;
  let hiddenInf = false;
  let visible: Path2D | null = null;
  const hiddenRects: Rect[] = [];
  const addVisible = (x: number, y: number, w: number, h: number): void => {
    visible = visible ?? new Path2D();
    visible.rect(x, y, w, h);
  };
  const addHidden = (x: number, y: number, w: number, h: number): void => {
    // Inflated so the mask's AA edge clears flush content (see MASK_EPS).
    hiddenRects.push({
      x: x - MASK_EPS,
      y: y - MASK_EPS,
      w: w + MASK_EPS * 2,
      h: h + MASK_EPS * 2,
    });
  };

  for (const f of world.floors) {
    if (f.level !== z) continue;
    const vis = floorVisible(f, player.z, player.pos);
    if (f.infinite) {
      if (vis) visibleInf = true;
      else hiddenInf = true;
    } else if (vis) {
      addVisible(f.pos.x - f.w / 2, f.pos.y - f.h / 2, f.w, f.h);
    } else {
      addHidden(f.pos.x - f.w / 2, f.pos.y - f.h / 2, f.w, f.h);
    }
  }
  const PAD = STAIR_MASK_PAD;
  for (const s of world.stairs) {
    if (s.zAtMin !== z && s.zAtMax !== z) continue;
    if (stairsVisible(s, player.z)) {
      addVisible(s.pos.x - s.w / 2 - PAD, s.pos.y - s.h / 2 - PAD, s.w + PAD * 2, s.h + PAD * 2);
    } else {
      addHidden(s.pos.x - s.w / 2, s.pos.y - s.h / 2, s.w, s.h);
    }
  }

  let hidden: Path2D | null = null;
  if (hiddenRects.length > 0) {
    hidden = new Path2D();
    for (const r of disjointRects(hiddenRects)) hidden.rect(r.x, r.y, r.w, r.h);
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

  if (showGrid) drawGrid(camPos, center, w, h, zoom, gridColor, gridWidth, gridGap);

  // World-space rect covering the whole screen (padded): the outer boundary the
  // subtractive masks punch their holes in.
  const vpX = camPos.x - center.x * zoom - 64;
  const vpY = camPos.y - center.y * zoom - 64;
  const vpW = w * zoom + 128;
  const vpH = h * zoom + 128;

  // Painter's order by level, lowest first: higher floors composite over lower
  // ones, so walking under a balcony puts it over your head for free.
  for (const z of presentLevels()) {
    // Surfaces draw alpha-eased and unmasked: a fading roof lingers translucent
    // while the objects it hid stay masked sharply below.
    for (const f of world.floors) {
      if (!f.infinite && f.level === z && f.alpha > 0.01 && !f.invisible) drawFloor(f);
    }
    for (const s of world.stairs) {
      if (Math.min(s.zAtMin, s.zAtMax) === z && s.alpha > 0.01) drawStairs(s);
    }

    const drawObjects = (): void => {
      // An obstacle's optional visibleFrom/invisible are purely cosmetic
      // (second-story walls hidden from the ground, invisible barriers) — it
      // still collides either way.
      for (const o of world.obstacles) {
        if (o.z !== z || o.invisible) continue;
        if (!o.visibleFrom || zsetHas(o.visibleFrom, player.z)) drawObstacle(o);
      }
      for (const b of bodies) if (b.z === z) b.draw(ctx); // corpses under the living
      for (const it of world.items) if (it.z === z) it.draw(ctx); // ground pickups
      for (const c of characters) if (c.z === z) c.draw(ctx);
      drawBullets(z);
      drawParticles(ctx, world.particles, z);
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
        shaft.rect(
          s.pos.x - s.w / 2 - STAIR_MASK_PAD,
          s.pos.y - s.h / 2 - STAIR_MASK_PAD,
          s.w + STAIR_MASK_PAD * 2,
          s.h + STAIR_MASK_PAD * 2,
        );
      }
      if (shaft) {
        ctx.save();
        ctx.clip(shaft);
        drawObjects();
        ctx.restore();
      }
      continue;
    }

    const m = levelMasks(z);

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

  // Editor overlay: snap grid, spawn markers, selection outline + handles.
  editor?.drawWorld(ctx);

  ctx.restore();

  if (!editor) {
    drawHud(ctx, {
      w,
      h,
      center,
      player,
      healthBar,
      armorBar,
      mouse,
      interactableLabel: interactable ? interactable.label : null,
    });
  }
}

function frame(now: number): void {
  accumulator += now - last;
  last = now;
  // Guard against huge jumps (e.g. tab was backgrounded).
  if (accumulator > 250) accumulator = 250;

  while (accumulator >= STEP) {
    update();
    accumulator -= STEP;
  }

  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
