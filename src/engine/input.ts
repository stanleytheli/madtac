/**
 * Keyboard + mouse state, polled by the game each tick.
 *
 * Keys are tracked by PHYSICAL position (`KeyboardEvent.code`: "KeyW",
 * "Digit1", "Tab"...) and mouse buttons as "Mouse0".."Mouse2", one set for
 * both. The game asks for ACTIONS ("reload", "fire"), which the player's
 * bindings (settings.binds) map to those codes — so the settings menu can
 * rebind anything, and WASD stays under the same fingers on any layout.
 */
import { settings, type Action } from "../settings.ts";
import { vec, type Vec2 } from "./vec.ts";

const down = new Set<string>();
/** Mouse position in screen pixels. */
export const mouse: Vec2 = vec(0, 0);

/** True for the editor's text/number inputs, where Tab should still move focus. */
function isFormField(t: EventTarget | null): boolean {
  const tag = (t as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function initInput(canvas: HTMLCanvasElement): void {
  window.addEventListener("keydown", (e) => {
    // Tab holds up the scoreboard; keep it from tabbing focus around the page
    // (but leave the editor's form fields alone).
    if (e.key === "Tab" && !isFormField(e.target)) e.preventDefault();
    if (e.code) down.add(e.code);
  });
  window.addEventListener("keyup", (e) => down.delete(e.code));
  // Avoid stuck keys / held fire when focus is lost.
  window.addEventListener("blur", () => down.clear());

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
  });

  // Buttons go down only on the canvas — a click on a DOM panel over it (the
  // respawn or settings menu) is not a shot — but come up anywhere.
  canvas.addEventListener("mousedown", (e) => down.add(`Mouse${e.button}`));
  window.addEventListener("mouseup", (e) => down.delete(`Mouse${e.button}`));
  // Suppress the right-click menu so it doesn't interrupt play.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Whether a physical key (by `KeyboardEvent.code`) or "Mouse<n>" is held. */
export const isDown = (code: string): boolean => down.has(code);

/** Whether the key bound to `action` is held. */
export const isAction = (action: Action): boolean => down.has(settings.binds[action]);

/** Raw movement axis (not normalized), x = right, y = down. */
export function moveAxis(): Vec2 {
  let x = 0;
  let y = 0;
  if (isAction("moveLeft")) x -= 1;
  if (isAction("moveRight")) x += 1;
  if (isAction("moveUp")) y -= 1;
  if (isAction("moveDown")) y += 1;
  return vec(x, y);
}

const KEY_NAMES: Record<string, string> = {
  Mouse0: "Left click",
  Mouse1: "Middle click",
  Mouse2: "Right click",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  ControlLeft: "L Ctrl",
  ControlRight: "R Ctrl",
  AltLeft: "L Alt",
  AltRight: "R Alt",
  MetaLeft: "L Cmd",
  MetaRight: "R Cmd",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  CapsLock: "Caps Lock",
  PageUp: "Page Up",
  PageDown: "Page Down",
};

/** A short human name for a key code, for the controls menu and the hint. */
export function keyLabel(code: string): string {
  const named = KEY_NAMES[code];
  if (named) return named;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return `${code.slice(5)} arrow`;
  if (code.startsWith("Mouse")) return `Mouse ${Number(code.slice(5)) + 1}`;
  return code;
}
