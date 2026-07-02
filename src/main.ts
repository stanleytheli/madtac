import { Character } from "./actor.ts";
import * as Armors from "./armor.ts";
import { Body } from "./body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./character.ts";
import { hasLineOfSight, resolveCircleVsBox, resolveCircleVsCircle } from "./collision.ts";
import { Gun } from "./gun.ts";
import * as Guns from "./guns.ts";
import { ArmorItem, GunItem, separateItems, type GroundItem } from "./item.ts";
import { ELITE_ROBOT_SKIN, Robot } from "./robot.ts";
import { initInput, isDown, mouse, moveAxis, pointer } from "./input.ts";
import { drawParticles } from "./particle.ts";
import { drawHud, HealthBar, hudHitTest, type SlotKind } from "./ui.ts";
import { dist, fromAngle, norm, scale, sub, vec, type Vec2 } from "./vec.ts";
import { createWorld, updateBullets, type Floor, type Obstacle } from "./world.ts";

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

const player = new Character(vec(0, 0), DEFAULT_SKIN, {
  primary: new Gun(Guns.M16),
  secondary: new Gun(Guns.M9),
  hand: new Gun(Guns.UNARMED),
});
const enemy_1 = new Robot(vec(-500, 0), {health: 200, damage: 10, spreadDeg: 10, skin: ELITE_ROBOT_SKIN, gun: Guns.M16, delay:10})
const enemy_0 = new Robot(vec(320, -260));
const enemy_2 = new Robot(vec(450, -400));

// The elite wears armor, to show it off (and prove enemies use the same pipeline).
enemy_1.equipArmor(new Armors.Armor(Armors.ARMOR_L3));

let characters: Character[] = [player, enemy_0, enemy_1, enemy_2];
const bodies: Body[] = [];

const world = createWorld();

// Some guns lying around to pick up.
world.items.push(new GunItem(vec(-120, -80), new Gun(Guns.Deagle)));
world.items.push(new GunItem(vec(80, 120), new Gun(Guns.M249)));

// ...and some armor to try on.
world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L1)));
world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L2)));
world.items.push(new ArmorItem(vec(-40, 90), new Armors.Armor(Armors.ARMOR_L3)));
world.items.push(new ArmorItem(vec(170, -40), new Armors.Armor(Armors.ARMOR_L4)));

// Camera: position follows the player; `size` eases toward the weapon's zoom.
const camera = { size: player.gun.spec.zoom };
const ZOOM_EASE = 0.12;

const PICKUP_RANGE = 75; // world px the player can reach a ground item from
let interactable: GroundItem | null = null; // nearest reachable item this tick (for prompt + E)

/** Nearest ground item within reach and with a clear line of sight, or null. */
function findInteractable(): GroundItem | null {
  let best: GroundItem | null = null;
  let bestD = Infinity;
  for (const it of world.items) {
    const d = dist(player.pos, it.pos);
    if (d > PICKUP_RANGE || d >= bestD) continue;
    if (!hasLineOfSight(player.pos, it.pos, world.obstacles)) continue; // can't reach through walls
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
    if (dropped) world.items.push(new GunItem(here(), dropped, tossVel()));
  } else if (item instanceof ArmorItem) {
    const prev = player.equipArmor(item.armor);
    if (prev) world.items.push(new ArmorItem(here(), prev, tossVel()));
  }
  interactable = null;
}

/** Drop the player's currently equipped weapon into the world (Q). Fists can't be dropped. */
function dropEquippedWeapon(): void {
  const dropped = player.dropEquipped();
  if (!dropped) return;
  const vel = fromAngle(Math.random() * Math.PI * 2, 9.5);
  world.items.push(new GunItem(vec(player.pos.x, player.pos.y), dropped, vel));
}

/** Drop whatever the player right-clicked in the HUD: a specific weapon slot, or
 *  the worn armor. No-op if that slot is empty. */
function dropFromHud(kind: SlotKind): void {
  const at = vec(player.pos.x, player.pos.y);
  if (kind === "armor") {
    const a = player.dropArmor();
    if (a) world.items.push(new ArmorItem(at, a, tossVel()));
  } else {
    const g = player.dropSlot(kind);
    if (g) world.items.push(new GunItem(at, g, tossVel()));
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

function resolvePlayerCollisions(): void {
  let pos = player.pos;
  // Two passes so corners (crate + crate, or crate + character) settle.
  for (let i = 0; i < 2; i++) {
    for (const o of world.obstacles) pos = resolveCircleVsBox(pos, BODY_RADIUS, o);
    for (const other of characters) {
      if (other === player) continue;
      pos = resolveCircleVsCircle(pos, BODY_RADIUS, other.pos, BODY_RADIUS);
    }
  }
  player.pos = pos;
}

/** Convert any character that hit 0 HP into a Body, dropping its weapons, and remove it. */
function reapDead(): void {
  for (let i = characters.length - 1; i >= 0; i--) {
    const c = characters[i];
    if (c.hp <= 0) {
      // Scatter the dead character's weapons from its body.
      for (const gun of c.dropWeapons()) {
        const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
        world.items.push(new GunItem(vec(c.pos.x, c.pos.y), gun, vel));
      }
      const vel = fromAngle(Math.random() * Math.PI * 2, 3 + Math.random() * 3);
      const a = c.dropArmor()
      if (a) world.items.push(new ArmorItem(vec(c.pos.x, c.pos.y), a, vel));

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

  // Ease the camera zoom toward the equipped weapon's target.
  camera.size += (player.gun.spec.zoom - camera.size) * ZOOM_EASE;

  if (playerAlive) {
    player.forward = aimForward();
    let speedMult = 1.0;
    speedMult *= player.gun.spec.speed;
    if (player.armor) { // Armor speed value -- NOTE: deliberately not used in player max speed calculations
      speedMult *= player.armor.spec.speed;
    }
    player.move(moveAxis(), speedMult);
    resolvePlayerCollisions();
  }

  for (const c of characters) c.tickWeapon();

  // Player firing: held trigger for auto, click edge for semi.
  const f = player.gun.spec.fire;
  if (playerAlive && f) {
    const wantFire = f.auto ? pointer.down : pointer.down && !prevDown;
    if (wantFire) player.fire(world);
  }
  prevDown = pointer.down;

  // Enemy AI: look for the player and shoot.
  if (enemy_0.hp > 0) enemy_0.think(world, player);
  if (enemy_1.hp > 0) enemy_1.think(world, player);
  if (enemy_2.hp > 0) enemy_2.think(world, player);

  updateBullets(world, characters);

  for (const b of bodies) b.update(world.obstacles);
  for (const it of world.items) it.update(world.obstacles);
  separateItems(world.items); // gently spread out any overlapping pickups
  reapDead();
}

const GRID = 512;
// Draw the grid covering the (zoom-enlarged) visible world region.
function drawGrid(camPos: Vec2, center: Vec2, w: number, h: number, zoom: number): void {
  // Screen edges mapped back to world: world = (screenPx - center) * zoom + camPos.
  const left = camPos.x - center.x * zoom;
  const right = camPos.x + (w - center.x) * zoom;
  const top = camPos.y - center.y * zoom;
  const bottom = camPos.y + (h - center.y) * zoom;

  ctx.strokeStyle = "#5ca76c";
  ctx.lineWidth = zoom; // 1/zoom context scale -> ~1px on screen
  ctx.beginPath();
  for (let x = Math.ceil(left / GRID) * GRID; x <= right; x += GRID) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = Math.ceil(top / GRID) * GRID; y <= bottom; y += GRID) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
}

function drawFloor(fl: Floor): void {
  ctx.fillStyle = fl.color;
  ctx.fillRect(fl.pos.x - fl.w / 2, fl.pos.y - fl.h / 2, fl.w, fl.h);
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

function drawBullets(): void {
  ctx.lineCap = "round";
  for (const b of world.bullets) {
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

function render(): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const center = screenCenter();
  const zoom = camera.size;
  const camPos = player.pos; // camera centers on the player

  // Background fill (unscaled, always covers the screen).
  ctx.fillStyle = "#70c575";
  ctx.fillRect(0, 0, w, h);

  // Camera transform: world -> screen, scaled by 1/zoom around the screen center.
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.translate(-camPos.x, -camPos.y);

  drawGrid(camPos, center, w, h, zoom);
  for (const fl of world.floors) drawFloor(fl); // decorative ground, under everything
  for (const o of world.obstacles) drawObstacle(o);
  for (const b of bodies) b.draw(ctx); // corpses lie under the living

  for (const it of world.items) it.draw(ctx); // ground pickups

  for (const c of characters) c.draw(ctx);

  drawBullets();
  drawParticles(ctx, world.particles);

  ctx.restore();

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
