/**
 * The page's entry point: the landing screen, or straight into a match when
 * the URL already says which one — ?play=bots, ?connect=host:port, ?edit=true,
 * ?level= / ?mode= (a shared link, a reload, a dev bookmark).
 *
 * The game (main.ts) reads its whole setup from the query string as it loads,
 * so a choice on the landing screen is written into the URL first and main.ts
 * is loaded after. Back from a match returns to the landing URL; a match can't
 * be torn down in place, so that reloads the page.
 */
import { unlockAudio } from "./engine/audio.ts";
import { showLanding } from "./ui/landing.ts";

/** Query params that already say what to play, skipping the landing screen. */
const DIRECT = ["play", "connect", "edit", "level", "mode"];

function startGame(set: Record<string, string>): void {
  // Inside the click: browsers only let audio start from a user gesture.
  unlockAudio();
  // Keep anything else on the URL (?blueTroops=, ?visibility=, ...).
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(set)) q.set(k, v);
  history.pushState(null, "", `${location.pathname}?${q}`);
  void import("./main.ts");
}

const params = new URLSearchParams(location.search);
if (DIRECT.some((k) => params.has(k))) {
  void import("./main.ts");
} else {
  showLanding({
    bots: () => startGame({ play: "bots" }),
    join: (address, name) => startGame(name ? { connect: address, name } : { connect: address }),
  });
}
window.addEventListener("popstate", () => location.reload());
