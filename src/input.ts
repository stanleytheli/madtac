import { vec, type Vec2 } from "./vec.ts";

const keys = new Set<string>();
/** Mouse position in screen pixels. */
export const mouse: Vec2 = vec(0, 0);
/** Pointer button state: `down` = left held (fire), `rightDown` = right held (drop). */
export const pointer = { down: false, rightDown: false };

export function initInput(canvas: HTMLCanvasElement): void {
  window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  // Avoid stuck keys / held fire when focus is lost.
  window.addEventListener("blur", () => {
    keys.clear();
    pointer.down = false;
    pointer.rightDown = false;
  });

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) pointer.down = true;
    else if (e.button === 2) pointer.rightDown = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) pointer.down = false;
    else if (e.button === 2) pointer.rightDown = false;
  });
  // Suppress the right-click menu so it doesn't interrupt play.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

export const isDown = (k: string): boolean => keys.has(k);

/** Raw WASD axis (not normalized), x = right, y = down. */
export function moveAxis(): Vec2 {
  let x = 0;
  let y = 0;
  if (isDown("a")) x -= 1;
  if (isDown("d")) x += 1;
  if (isDown("w")) y -= 1;
  if (isDown("s")) y += 1;
  return vec(x, y);
}
