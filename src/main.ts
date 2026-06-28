import { Character } from "./actor.ts";
import { Body } from "./body.ts";
import { BODY_RADIUS, DEFAULT_SKIN } from "./character.ts";
import { resolveCircleVsCircle, resolveCircleVsCrate } from "./collision.ts";
import { Gun } from "./gun.ts";
import { M16, Deagle, UNARMED } from "./guns.ts";
import { ELITE_ROBOT_SKIN, Robot } from "./robot.ts";
import { initInput, isDown, mouse, moveAxis, pointer } from "./input.ts";
import { drawParticles } from "./particle.ts";
import { drawCrosshair, drawProgressBar, fillSquircle, HealthBar } from "./ui.ts";
import { dist, norm, scale, sub, vec, type Vec2 } from "./vec.ts";
import { createWorld, updateBullets, type Crate } from "./world.ts";

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
  primary: new Gun(M16),
  secondary: new Gun(Deagle),
  hand: new Gun(UNARMED),
});
const enemy_1 = new Robot(vec(-100, 500), {health: 200, damage: 10, spreadDeg: 10, skin: ELITE_ROBOT_SKIN, gun: M16, delay:10})
const enemy_0 = new Robot(vec(320, -260));
const enemy_2 = new Robot(vec(450, -400));

let characters: Character[] = [player, enemy_0, enemy_1, enemy_2];
const bodies: Body[] = [];

const world = createWorld();

// Camera: position follows the player; `size` eases toward the weapon's zoom.
const camera = { size: player.gun.spec.zoom };
const ZOOM_EASE = 0.12;

const healthBar = new HealthBar({ width: 450, height: 35 });

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
    for (const c of world.crates) pos = resolveCircleVsCrate(pos, BODY_RADIUS, c);
    for (const other of characters) {
      if (other === player) continue;
      pos = resolveCircleVsCircle(pos, BODY_RADIUS, other.pos, BODY_RADIUS);
    }
  }
  player.pos = pos;
}

/** Convert any character that hit 0 HP into a Body and remove it from play. */
function reapDead(): void {
  for (let i = characters.length - 1; i >= 0; i--) {
    if (characters[i].hp <= 0) {
      bodies.push(Body.fromCharacter(characters[i]));
      characters.splice(i, 1);
    }
  }
}

let jDown = false
let kDown = false

function update(): void {
  const playerAlive = player.hp > 0;

  if (playerAlive) {
    if (isDown("1")) player.equip("primary");
    if (isDown("2")) player.equip("secondary");
    if (isDown("3")) player.equip("hand");
    if (isDown("r")) player.reload();

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
    player.move(moveAxis(), player.gun.spec.speed);
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

  for (const b of bodies) b.update(world.crates);
  reapDead();
}

const GRID = 64;
// Draw the grid covering the (zoom-enlarged) visible world region.
function drawGrid(camPos: Vec2, center: Vec2, w: number, h: number, zoom: number): void {
  // Screen edges mapped back to world: world = (screenPx - center) * zoom + camPos.
  const left = camPos.x - center.x * zoom;
  const right = camPos.x + (w - center.x) * zoom;
  const top = camPos.y - center.y * zoom;
  const bottom = camPos.y + (h - center.y) * zoom;

  ctx.strokeStyle = "#74c185";
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

function drawCrate(c: Crate): void {
  const x = c.pos.x - c.w / 2;
  const y = c.pos.y - c.h / 2;
  ctx.fillStyle = "#92632d";
  ctx.fillRect(x, y, c.w, c.h);
  ctx.strokeStyle = "#412b04";
  ctx.lineWidth = 9;
  ctx.strokeRect(x, y, c.w, c.h);
  // plank "X" detail
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + c.w, y + c.h);
  ctx.moveTo(x + c.w, y);
  ctx.lineTo(x, y + c.h);
  ctx.stroke();
}

const TRAIL_LEN = 150; // world px the tracer streak extends behind the bullet

function drawBullets(): void {
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const b of world.bullets) {
    // Only draw the part of the tracer that has cleared the muzzle.
    const traveled = dist(b.pos, b.origin);
    if (traveled <= b.renderAfter) continue;

    const dir = norm(b.vel);
    // Streak from the tip back by TRAIL_LEN, clamped so it never pokes back out
    // of the muzzle (past origin + renderAfter).
    const tailLen = Math.min(TRAIL_LEN, traveled - b.renderAfter);
    const tip = b.pos;
    const tail = sub(tip, scale(dir, tailLen));

    const grad = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
    grad.addColorStop(0, "rgba(255,226,107,0)");
    grad.addColorStop(1, "rgba(255,240,160,0.95)");
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
  ctx.fillStyle = "#519655";
  ctx.fillRect(0, 0, w, h);

  // Camera transform: world -> screen, scaled by 1/zoom around the screen center.
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.translate(-camPos.x, -camPos.y);

  drawGrid(camPos, center, w, h, zoom);
  for (const c of world.crates) drawCrate(c);

  for (const b of bodies) b.draw(ctx); // corpses lie under the living
  for (const c of characters) c.draw(ctx);

  drawBullets();
  drawParticles(ctx, world.particles);

  ctx.restore();

  drawHud(w, h, center);
}

// Screen-space overlay: crosshair (at the mouse), reload bar, and the
// surviv-style bottom block (big HP bar with the ammo readout above it).
function drawHud(w: number, h: number, _center: Vec2): void {
  const gun = player.gun;

  // --- bottom block: health bar with ammo above it ---
  const barCx = w / 2;
  const barCy = h - 28 - healthBar.style.height / 2;
  const barTop = barCy - healthBar.style.height / 2;

  healthBar.draw(ctx, barCx, barCy, player.hp / player.maxHp);

  drawAmmo(gun, barCx, barTop - 12);
  // Crosshair tracks the mouse; the reload bar sits just under it.
  drawCrosshair(ctx, mouse.x, mouse.y);

  if (gun.reloading) {
    drawProgressBar(ctx, mouse.x, mouse.y + 30, gun.reloadProgress);
  }

}

// Ammo readout above the HP bar: the big mag count on a black squircle (centered
// at `cx`), with the spare-mag count on its own smaller squircle to the right,
// bottom-aligned with the mag squircle. `bottom` is the shared bottom edge.
function drawAmmo(gun: typeof player.gun, cx: number, bottom: number): void {
  if (!gun.spec.fire) return;

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
