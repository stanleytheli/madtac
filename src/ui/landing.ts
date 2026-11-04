/**
 * The landing screen: what the page shows before any match exists. Two ways
 * to play — a bot match run in this tab, or a PvP server — and a link to the
 * level editor. It is plain DOM over the (still empty) game canvas and knows
 * nothing about the game itself: boot.ts loads main.ts only once a choice is
 * made, so this screen costs no more than its own few kilobytes.
 *
 * The PvP card asks the server's GET /info whether it is up, and what it is
 * running, as the address is typed. The name and address are remembered.
 */
import { PROTOCOL, serverUrls, type ServerInfo } from "../net/protocol.ts";

const LANDING_CSS = `
#landing {
  position: fixed; inset: 0; z-index: 50; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px;
  padding: 32px 16px; box-sizing: border-box;
  color: #dfe2e8; font: 13px system-ui, sans-serif;
  background: radial-gradient(ellipse at center, rgba(27, 31, 36, 0.72), rgba(14, 16, 20, 0.96)),
    url("assets/madtac_screenshot_0.png") center / cover no-repeat, #1b1f24;
}
.ld-title { text-align: center; user-select: none; }
.ld-title h1 { margin: 0; font: bold 44px system-ui, sans-serif; letter-spacing: 10px; text-shadow: 0 3px 18px rgba(0, 0, 0, 0.6); }
.ld-title p { margin: 6px 0 0; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; opacity: 0.55; }
.ld-cards { display: flex; flex-wrap: wrap; justify-content: center; gap: 18px; }
.ld-card {
  display: flex; flex-direction: column; gap: 12px; width: 300px; padding: 20px 22px; box-sizing: border-box;
  background: rgba(14, 16, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); border-top: 3px solid var(--accent);
}
.ld-card h2 { margin: 0; font: bold 15px system-ui, sans-serif; letter-spacing: 3px; text-transform: uppercase; }
.ld-card .ld-blurb { margin: 0; line-height: 1.5; opacity: 0.7; flex: 1; }
.ld-field { display: flex; flex-direction: column; gap: 5px; }
.ld-field label { font-size: 11px; font-weight: bold; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.55; }
.ld-field input {
  padding: 9px 10px; font: 13px ui-monospace, Menlo, Consolas, monospace; color: #fff;
  background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; outline: none;
}
.ld-field input:focus { border-color: var(--accent); background: rgba(255, 255, 255, 0.1); }
.ld-status { min-height: 18px; font-size: 12px; line-height: 1.5; opacity: 0.85; }
.ld-status::before { content: "●"; margin-right: 6px; color: var(--dot, #6b7280); }
.ld-status.is-up { --dot: #3dba6f; }
.ld-status.is-warn { --dot: #ffb347; }
.ld-status.is-down { --dot: #c94f4f; }
.ld-go {
  padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
  font: bold 15px system-ui, sans-serif; letter-spacing: 1.5px; text-transform: uppercase;
  background: var(--accent); color: #fff;
}
.ld-go:hover { filter: brightness(1.15); }
.ld-go:disabled { opacity: 0.4; cursor: default; filter: none; }
.ld-links { display: flex; gap: 18px; font-size: 12px; }
.ld-links a { color: #cdd3da; opacity: 0.55; text-decoration: none; }
.ld-links a:hover { opacity: 1; text-decoration: underline; }
`;

const NAME_KEY = "madtac.name";
const SERVER_KEY = "madtac.server";
/** Longest name the server keeps (see server/server.ts). */
const NAME_MAX = 24;

export interface LandingChoice {
  /** A bot match in this tab. */
  bots(): void;
  /** Join the server at `address` as `name` ("" = let the server pick). */
  join(address: string, name: string): void;
}

/** The server to offer: the last one joined, else the build's VITE_SERVER,
 *  else (developing locally) a dedicated server on this machine. */
function defaultServer(): string {
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved;
  if (import.meta.env.VITE_SERVER) return import.meta.env.VITE_SERVER;
  return import.meta.env.DEV ? `${location.hostname || "localhost"}:7777` : "";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** A labelled text input. */
function field(label: string, input: HTMLInputElement): HTMLDivElement {
  const id = `ld-${label.toLowerCase().replace(/\W+/g, "-")}`;
  input.id = id;
  return el("div", { className: "ld-field" }, el("label", { htmlFor: id, textContent: label }), input);
}

/** Show the landing screen. Picking either option removes it and calls back. */
export function showLanding(choose: LandingChoice): void {
  const style = el("style", { textContent: LANDING_CSS });
  document.head.append(style);

  const close = (): void => {
    root.remove();
    style.remove();
  };

  // --- bot match -------------------------------------------------------------
  const play = el("button", { type: "button", className: "ld-go", textContent: "Play" });
  play.onclick = () => {
    close();
    choose.bots();
  };
  const botCard = el(
    "section",
    { className: "ld-card" },
    el("h2", { textContent: "Bot match" }),
    el("p", {
      className: "ld-blurb",
      textContent: "You and your squad of bots against the red team. Runs right here in your browser; no server needed.",
    }),
    play,
  );
  botCard.style.setProperty("--accent", "#1f6f3a");

  // --- PvP server ------------------------------------------------------------
  const name = el("input", {
    type: "text", maxLength: NAME_MAX, placeholder: "a callsign is picked if empty",
    value: localStorage.getItem(NAME_KEY) ?? "", spellcheck: false,
  });
  const server = el("input", {
    type: "text", placeholder: "host:port", value: defaultServer(), spellcheck: false, autocomplete: "off",
  });
  const status = el("div", { className: "ld-status" });
  const join = el("button", { type: "button", className: "ld-go", textContent: "Join" });

  const setStatus = (kind: "up" | "warn" | "down" | "idle", text: string): void => {
    status.className = `ld-status${kind === "idle" ? "" : ` is-${kind}`}`;
    status.textContent = text;
  };

  // Ask the server what it is running, at most one question in flight; a reply
  // to an address that has since been edited is ignored.
  let asked = 0;
  let pending: AbortController | null = null;
  let debounce = 0;
  const check = async (): Promise<void> => {
    const address = server.value.trim();
    join.disabled = !address;
    pending?.abort();
    if (!address) {
      setStatus("idle", "Enter the server's address.");
      return;
    }
    const mine = ++asked;
    const ctl = new AbortController();
    pending = ctl;
    const timer = window.setTimeout(() => ctl.abort(), 3000);
    setStatus("idle", "Checking…");
    try {
      const res = await fetch(serverUrls(address, location.protocol === "https:").info, { signal: ctl.signal });
      const info = (await res.json()) as ServerInfo;
      if (mine !== asked) return;
      if (info.protocol !== PROTOCOL) {
        setStatus("warn", `Online, but it runs version ${info.protocol} of the game and this page is version ${PROTOCOL}.`);
      } else {
        setStatus("up", `Online: ${info.level} (${info.mode}), ${info.players}/${info.maxPlayers} players`);
      }
    } catch {
      if (mine !== asked) return;
      const insecure = location.protocol === "https:" && /^ws:\/\//i.test(address);
      setStatus("down", insecure ? "This page is https, so the server must be wss:// too." : "Can't reach that server.");
    } finally {
      window.clearTimeout(timer);
      if (pending === ctl) pending = null;
    }
  };
  server.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void check(), 400);
  });

  const go = (): void => {
    const address = server.value.trim();
    if (!address) return;
    const who = name.value.trim().slice(0, NAME_MAX);
    localStorage.setItem(SERVER_KEY, address);
    if (who) localStorage.setItem(NAME_KEY, who);
    else localStorage.removeItem(NAME_KEY);
    pending?.abort();
    close();
    choose.join(address, who);
  };
  join.onclick = go;
  for (const input of [name, server]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }

  const pvpCard = el(
    "section",
    { className: "ld-card" },
    el("h2", { textContent: "PvP server" }),
    el("p", { className: "ld-blurb", textContent: "Players split between blue and red, with bots filling out both teams." }),
    field("Name", name),
    field("Server", server),
    status,
    join,
  );
  pvpCard.style.setProperty("--accent", "#a63d3d");

  const root = el(
    "div",
    { id: "landing" },
    el("div", { className: "ld-title" }, el("h1", { textContent: "MADNESS TACTICA" }), el("p", { textContent: "top-down tactical shooter" })),
    el("div", { className: "ld-cards" }, botCard, pvpCard),
    el("nav", { className: "ld-links" }, el("a", { href: "?edit=true", textContent: "Level editor" })),
  );
  document.body.append(root);
  void check();
}
