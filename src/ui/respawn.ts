/**
 * The respawn screen: the centered panel the player picks their next kit on
 * while dead. Lives here rather than in ui.ts because it is DOM, not canvas —
 * a grid of real buttons is a far better fit for "pick one of sixteen guns"
 * than hit-testing hand-drawn rectangles.
 *
 * Respawning is voluntary: the button counts down and stays disabled until the
 * gamemode's respawn delay is up, so there is always time to choose. The whole
 * panel is driven from the gamemode HUD (see GamemodeHud.choosingLoadout /
 * respawnIn) — it holds no state the mode does not already own, beyond the
 * selection it is mirroring back via the host's setLoadout.
 */
import type { GamemodeHud } from "../gamemodes/gamemode.ts";
import { ARMOR_SPECS, GUN_SPECS } from "../entities/specs.ts";
import type { RespawnHost } from "./session.ts";

// The single respawn panel in the DOM, and the Enter-to-respawn listener bound
// alongside it. Both are torn down before a rebuild (and when a playtest stops),
// so repeated playtests don't stack panels or leave a listener holding a dead Game.
let respawnPanelEl: HTMLElement | null = null;
let respawnKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Remove the panel and unbind its key listener. Called before a rebuild, and by
 *  the editor when a playtest ends. */
export function teardownRespawnMenu(): void {
  respawnPanelEl?.remove();
  respawnPanelEl = null;
  if (respawnKeyHandler) window.removeEventListener("keydown", respawnKeyHandler);
  respawnKeyHandler = null;
}

/** Thickness, in CSS px, of the white keyline around every item icon — tune here.
 *  Each step costs four drop-shadow passes (see ICON_OUTLINE). */
const ICON_OUTLINE_PX = 3;

/**
 * The keyline filter chain, built rather than hand-written because CSS can't loop.
 *
 * A drop-shadow's output alpha is `A ∪ shift(A, d)`, and a filter chain feeds each
 * pass the *previous* pass's output — so these four unit offsets compose into a
 * full 3x3 dilation: a gap-free 1px ring, diagonals included. Repeating the quad
 * dilates again, growing the ring exactly one px per repeat.
 *
 * Two reasons not to reach for a wider offset instead. A single quad at `Npx`
 * dilates by {0, ±N} per axis, stamping copies N px apart — wherever the sprite is
 * thinner than that stride (gun barrels, sight rails) the stamps miss each other
 * and the edge scallops. And because chained dilations compose by Minkowski sum,
 * radii ADD: piling on offsets doesn't paint a wider ring, it runs away into a
 * blob. Passes are also flat-cost — every one reprocesses the whole bitmap whether
 * or not it's already white — so a bigger stride buys nothing but the gaps.
 */
const ICON_OUTLINE = Array.from(
  { length: Math.max(0, ICON_OUTLINE_PX) },
  () =>
    "drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) " +
    "drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff)",
).join(" ");

/** The panel's stylesheet, injected once on first build. Kept as a sheet (rather
 *  than inline styles) so the buttons can carry hover/selected/disabled states. */
const RESPAWN_CSS = `
#respawn-panel {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: none; flex-direction: column; gap: 14px; z-index: 20;
  width: min(760px, 94vw); max-height: 92vh;
  padding: 18px 20px 16px; box-sizing: border-box;
  background: rgba(14, 16, 20, 0.93);
  border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  color: #dfe2e8; font: 13px system-ui, sans-serif; user-select: none;
}
#respawn-panel.is-open { display: flex; }
/* Tab is held. The scoreboard is canvas-drawn and this panel is DOM, so it sits
   over the canvas no matter what z-index says — stepping out of the way entirely
   is the only way to put the player list on top. */
#respawn-panel.is-behind { display: none; }
.rs-title { font: bold 30px system-ui, sans-serif; letter-spacing: 4px; text-align: center; color: #ff6b6b; }
.rs-title.rs-title--detail { font-size: 19px; letter-spacing: 1px; }
.rs-sub { text-align: center; letter-spacing: 1px; opacity: 0.5; margin-top: 3px; }

/* Three side-by-side slot columns. Each scrolls on its own, so the action bar
   below them never leaves the screen no matter how long the weapon lists get. */
.rs-columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; min-height: 0; }
.rs-col { display: flex; flex-direction: column; min-width: 0; }
.rs-label { font-weight: bold; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.5; margin-bottom: 7px; }
.rs-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
  /* Rows keep their content height and pack to the top rather than stretching to
     fill a short column, so a button is the same size in all three. The vh term
     shrinks the scrollers on a short screen — the action bar below never goes
     off-screen to make room for the lists. */
  align-content: start;
  /* Tall enough that the armor column's three taller rows don't scroll; the two
     weapon columns show ~3.5 of their shorter rows, which still reads as scrollable. */
  height: min(312px, 40vh); padding: 2px 8px 2px 2px;
  --rs-icon-h: 40px;
  /* 'scroll', not 'auto': the track is always there, so a column that scrolls
     looks like one before you touch it (macOS overlay scrollbars hide on idle). */
  overflow-y: scroll; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.32) rgba(255, 255, 255, 0.06);
}
.rs-grid::-webkit-scrollbar { width: 9px; }
.rs-grid::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.06); border-radius: 5px; }
.rs-grid::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.32); border-radius: 5px; }
.rs-grid::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.45); }

.rs-item {
  display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 6px;
  padding: 9px 6px 8px; font: inherit; color: #dde1e7; cursor: pointer;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px;
}
.rs-item:hover { background: rgba(255, 255, 255, 0.26); color: #fff; }
.rs-item.is-selected { background: rgba(61, 220, 255, 0.3); border-color: #3ddcff; color: #fff; }
/* Random is on: the picks below it still exist but aren't what you'll spawn with. */
.rs-grid.is-overridden { opacity: 0.4; }
/* Armor sprites are near-square (319x325) where guns are long and thin (~300x100),
   so a shared 40px icon box wastes most of an armor button's width — the sprite is
   height-limited there but width-limited on a gun. Give that column more vertical
   room so the armor actually fills its button. */
.rs-grid.rs-armor { --rs-icon-h: 60px; }
.rs-icon { height: var(--rs-icon-h); display: flex; align-items: center; justify-content: center; }
.rs-icon img {
  max-width: 100%; max-height: var(--rs-icon-h); object-fit: contain;
  /* Sprite palettes vary a lot across the set (black rifles, gold pistols, olive
     armor), so every icon gets the same white keyline to sit on and reads at a
     glance whatever its own colors are. See ICON_OUTLINE for how the chain works. */
  filter: ${ICON_OUTLINE};
}
.rs-none { font-size: 22px; line-height: 40px; opacity: 0.45; }
.rs-name { font-size: 11.5px; line-height: 1.2; text-align: center; }

/* Fixed action bar: dice on the left in its own privileged slot, Respawn taking
   the rest. Outside the scrollers, so both are always reachable. */
.rs-actions { display: grid; grid-template-columns: auto 1fr; gap: 10px; }
.rs-random {
  display: flex; align-items: center; gap: 9px; padding: 0 18px;
  font: bold 14px system-ui, sans-serif; letter-spacing: 1px; cursor: pointer;
  color: #dde1e7; background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px;
}
.rs-random img { width: 26px; height: 26px; filter: invert(1); opacity: 0.85; }
.rs-random:hover { background: rgba(255, 255, 255, 0.26); color: #fff; }
.rs-random.is-selected { background: rgba(61, 220, 255, 0.3); border-color: #3ddcff; color: #fff; }
.rs-random.is-selected img { opacity: 1; }
.rs-respawn {
  padding: 14px; border: 0; border-radius: 10px;
  font: bold 16px system-ui, sans-serif; letter-spacing: 1px;
  background: #1f6f3a; color: #eaffef; cursor: pointer;
}
.rs-respawn:hover:not(:disabled) { background: #2a8c4b; }
.rs-respawn:disabled { background: rgba(255, 255, 255, 0.07); color: rgba(255, 255, 255, 0.35); cursor: default; }
.rs-hint { text-align: center; font-size: 11px; opacity: 0.4; }
`;

function installRespawnCss(): void {
  if (document.getElementById("respawn-css")) return;
  const style = document.createElement("style");
  style.id = "respawn-css";
  style.textContent = RESPAWN_CSS;
  document.head.append(style);
}

/** One button in a slot's grid: a spec key (`""` = leave the slot empty), the
 *  label under the icon, and the /assets file to show (null = the "—" glyph). */
interface LoadoutChoice {
  key: string;
  name: string;
  icon: string | null;
}

/** The three slots' choice lists, each led by an explicit "none" option. Weapons
 *  are split by their spec's `primary` flag so rifles and sidearms land in the
 *  slot they'd actually be carried in; an empty weapon slot shows the fists it
 *  really leaves you with. */
function loadoutChoices(): { primary: LoadoutChoice[]; secondary: LoadoutChoice[]; armor: LoadoutChoice[] } {
  const guns = (wantPrimary: boolean): LoadoutChoice[] =>
    Object.entries(GUN_SPECS)
      .filter(([, s]) => s.primary === wantPrimary)
      .map(([key, s]) => ({ key, name: s.name, icon: `/assets/${s.icon}.png` }));
  return {
    primary: [{ key: "", name: "None", icon: "/assets/fists.svg" }, ...guns(true)],
    secondary: [{ key: "", name: "None", icon: "/assets/fists.svg" }, ...guns(false)],
    armor: [
      { key: "", name: "None", icon: null },
      // "Level II Armor" -> "Level II": the section heading already says armor.
      ...Object.entries(ARMOR_SPECS).map(([key, s]) => ({
        key,
        name: s.name.replace(/ Armor$/, ""),
        icon: `/assets/${s.icon}.png`,
      })),
    ],
  };
}

/**
 * Build the panel for a match and return the per-frame updater: hand it the
 * gamemode HUD each render and it opens/closes itself, seeds the selection when
 * it opens, and keeps the Respawn button's countdown current.
 */
export function buildRespawnMenu(
  g: RespawnHost,
): (hud: GamemodeHud | null, showScoreboard?: boolean) => void {
  installRespawnCss();
  const choices = loadoutChoices();
  /** The live selection, mirrored into the gamemode on every click. */
  const picked: Record<"primary" | "secondary" | "armor", string> = { primary: "", secondary: "", armor: "" };
  /** Dice mode: a rolled kit each life, overriding everything in `picked`. */
  let random = false;
  /** Each slot's buttons and its scroller, kept so the highlight and the
   *  overridden-by-dice dimming can be repainted. */
  const buttons: Record<string, HTMLButtonElement[]> = {};
  const grids: Record<string, HTMLElement> = {};

  const panel = document.createElement("div");
  panel.id = "respawn-panel";

  const head = document.createElement("div");
  const titleEl = document.createElement("div");
  titleEl.className = "rs-title";
  titleEl.textContent = "YOU DIED";
  const subEl = document.createElement("div");
  subEl.className = "rs-sub";
  subEl.textContent = "Pick your loadout";
  head.append(titleEl, subEl);
  panel.append(head);

  // The action bar's two buttons are built up front so `paint` can close over
  // the dice button; they're appended below the columns further down.
  const randomBtn = document.createElement("button");
  randomBtn.className = "rs-random";
  randomBtn.type = "button";
  randomBtn.title = "Spawn with a random kit, rerolled every life";
  randomBtn.innerHTML = `<img src="/assets/dice.png" alt=""><span>RANDOM</span>`;

  const respawnBtn = document.createElement("button");
  respawnBtn.className = "rs-respawn";
  respawnBtn.type = "button";
  respawnBtn.disabled = true;

  const apply = (): void => {
    g.setLoadout({
      primary: picked.primary || undefined,
      secondary: picked.secondary || undefined,
      armor: picked.armor || undefined,
    });
  };

  /** Repaint every grid: the picked button in each slot reads as selected, and
   *  all three dim out while the dice override them. */
  const paint = (): void => {
    for (const slot of ["primary", "secondary", "armor"] as const) {
      for (const b of buttons[slot]) {
        b.classList.toggle("is-selected", !random && b.dataset.key === picked[slot]);
      }
      grids[slot].classList.toggle("is-overridden", random);
    }
    randomBtn.classList.toggle("is-selected", random);
  };

  const section = (slot: keyof typeof picked, label: string, items: LoadoutChoice[]): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "rs-col";
    const heading = document.createElement("div");
    heading.className = "rs-label";
    heading.textContent = label;
    const grid = document.createElement("div");
    grid.className = `rs-grid rs-${slot}`; // rs-armor gets the taller icon box
    grids[slot] = grid;

    buttons[slot] = items.map((c) => {
      const b = document.createElement("button");
      b.className = "rs-item";
      b.type = "button";
      b.dataset.key = c.key;
      b.title = c.name;
      const icon = document.createElement("span");
      icon.className = "rs-icon";
      if (c.icon) {
        const img = document.createElement("img");
        img.src = c.icon;
        img.alt = "";
        icon.append(img);
      } else {
        const dash = document.createElement("span");
        dash.className = "rs-none";
        dash.textContent = "—";
        icon.append(dash);
      }
      const name = document.createElement("span");
      name.className = "rs-name";
      name.textContent = c.name;
      b.append(icon, name);
      b.onclick = () => {
        picked[slot] = c.key;
        random = false; // an explicit pick takes the dice off
        paint();
        apply();
      };
      grid.append(b);
      return b;
    });

    wrap.append(heading, grid);
    return wrap;
  };

  const columns = document.createElement("div");
  columns.className = "rs-columns";
  columns.append(
    section("primary", "Primary", choices.primary),
    section("secondary", "Secondary", choices.secondary),
    section("armor", "Armor", choices.armor),
  );

  const actions = document.createElement("div");
  actions.className = "rs-actions";
  actions.append(randomBtn, respawnBtn);

  const hint = document.createElement("div");
  hint.className = "rs-hint";
  hint.textContent = "Enter to respawn";
  panel.append(columns, actions, hint);

  randomBtn.onclick = () => {
    random = true;
    paint();
    g.randomize();
  };

  teardownRespawnMenu(); // a previous playtest's menu, if any — don't leak it
  respawnPanelEl = panel;
  document.body.append(panel);

  let open = false;
  let ready = false;
  let btnLabel = "";

  const respawn = (): void => {
    if (!open || !ready) return;
    if (g.respawn()) {
      panel.classList.remove("is-open");
      open = false;
    }
  };
  respawnBtn.onclick = respawn;
  // Enter also respawns, so a hand on the keyboard doesn't have to find the
  // button. Skipped when the button itself has focus — it fires its own click.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" || !open || e.target === respawnBtn) return;
    e.preventDefault();
    respawn();
  };
  respawnKeyHandler = onKey;
  window.addEventListener("keydown", onKey);

  return (hud: GamemodeHud | null, showScoreboard = false): void => {
    const show = !!hud?.choosingLoadout;
    // Yield to the Tab player list. Tracked separately from `show` so holding Tab
    // doesn't count as a close/reopen — the selection and scroll positions stay put.
    panel.classList.toggle("is-behind", showScoreboard);
    if (show && !open) {
      // Just opened: reflect the kit the player is set to spawn with (their picks,
      // or the dice) and drop any leftover keyboard focus, so a stray Enter can't
      // re-trigger the button that closed the panel last time. Each column also
      // goes back to the top, since the selection it's showing just changed.
      picked.primary = hud!.loadout?.primary ?? "";
      picked.secondary = hud!.loadout?.secondary ?? "";
      picked.armor = hud!.loadout?.armor ?? "";
      random = !!hud!.randomLoadout;
      // Headline the death with who/what/how-far, or the plain "YOU DIED" if we
      // have no attacker on record. The detail line runs longer, so it drops to a
      // smaller weight (rs-title--detail) to fit the panel.
      const title = hud!.deathTitle;
      titleEl.textContent = title ?? "YOU DIED";
      titleEl.classList.toggle("rs-title--detail", !!title);
      paint();
      for (const slot of ["primary", "secondary", "armor"] as const) grids[slot].scrollTop = 0;
      respawnBtn.blur();
    }
    panel.classList.toggle("is-open", show);
    open = show;
    if (!show) return;

    // Countdown on the button itself, to one decimal, until the delay is up.
    // Rounded UP so the label never reads "0.0s" on a button that's still
    // disabled — it goes 0.1s -> enabled.
    const left = hud!.respawnIn ?? 0;
    ready = left <= 0;
    const label = ready ? "Respawn" : `Respawn in ${(Math.ceil(left * 10) / 10).toFixed(1)}s`;
    if (label !== btnLabel) {
      respawnBtn.textContent = label;
      btnLabel = label;
    }
    respawnBtn.disabled = !ready;
    hint.style.visibility = ready ? "" : "hidden";
  };
}
