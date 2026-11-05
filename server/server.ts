/**
 * The dedicated server: one match, one Game (src/game.ts) ticking at SIM_HZ in
 * this process, a WebSocket per human. Bots live here. Each connection gets a
 * PlayerSlot in the Game; its inputs come off the wire (see net/protocol.ts),
 * its snapshots go back through a ClientMirror (net/snapshot.ts) that sends
 * only what that player can see.
 *
 *   npm run server -- --level dust2-15 --mode tdm --port 7777
 *   MADTAC_PASSWORD=hunter2 npm run server      # joining takes a password
 *
 * Options: --level <name> (src/world/levels/<name>.json), --mode <id>, --port,
 * --host (default 127.0.0.1), --snap <hz>, --maxPlayers, --maxPerAddr,
 * --blueTroops/--redTroops, --blueSkill/--redSkill, --blueEquip/--redEquip,
 * --killLimit, --scoreLimit, --respawnDelay.
 * GET /info on the same port describes the match (a find-game endpoint).
 *
 * Everything that reaches this process is assumed hostile:
 *   - It listens on 127.0.0.1 only, so the one way in is the tunnel
 *     (cloudflared) running beside it. --host 0.0.0.0 opens it to the local
 *     network too, for playing over LAN with no tunnel.
 *   - MADTAC_PASSWORD (an environment variable, not a flag: flags show up in
 *     `ps`) makes joining take a password, checked before any game code runs.
 *     Five wrong ones from an address in a minute lock it out for a minute.
 *   - Every message must parse as exactly one of the shapes the protocol
 *     defines (parseClientMsg); anything else, and any message before a join,
 *     hangs up.
 *   - Caps on message size, messages per second per connection, open
 *     connections in total and per address, and how long a connection may
 *     take to join.
 *   - A socket error (an oversized frame, say) closes that socket. An
 *     exception while handling one client's message drops that client. A tick
 *     that throws is logged and the match goes on; a match that has thrown on
 *     every tick for five seconds exits, for a supervisor to start it fresh.
 * `npm run server` also runs Node with eval disabled and file reads limited
 * to the server bundle, its `ws` dependency and the levels folder.
 */
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { Game, type PlayerSlot } from "../src/game.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { resolveDom } from "../src/gamemodes/domination.ts";
import { resolveTdm } from "../src/gamemodes/tdm.ts";
import { loadLevel, type LevelMeta, type TeamConfig } from "../src/world/level.ts";
import type { GameEvent } from "../src/engine/events.ts";
import { idleInput, type PlayerInput } from "../src/engine/command.ts";
import { ClientMirror } from "../src/net/snapshot.ts";
import {
  DEFAULT_PORT,
  DEFAULT_SNAP_HZ,
  INFO_PATH,
  PROTOCOL,
  SIM_HZ,
  WS_PATH,
  mergeInputs,
  parseClientMsg,
  type ClientMsg,
  type ServerInfo,
  type ServerMsg,
} from "../src/net/protocol.ts";

// ------------------------------------------------------------- arguments ----

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq > 0) args.set(a.slice(2, eq).toLowerCase(), a.slice(eq + 1));
  else args.set(a.slice(2).toLowerCase(), process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true");
}
const str = (k: string): string | undefined => args.get(k.toLowerCase());
const num = (k: string): number | undefined => {
  const v = str(k);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

const LEVEL = str("level") ?? "dom-arena-big-fix";
if (!/^[\w-]+$/.test(LEVEL)) {
  console.error(`[server] --level takes a level's file name (letters, digits, - and _), not "${LEVEL}"`);
  process.exit(1);
}
const PORT = num("port") ?? DEFAULT_PORT;
const HOST = str("host") ?? "127.0.0.1";
const SNAP_HZ = num("snap") ?? DEFAULT_SNAP_HZ;
const MAX_PLAYERS = num("maxPlayers") ?? 16;
/** How long a dropped connection's slot is held for a reconnect (ms). */
const GRACE_MS = 30_000;

// ----------------------------------------------------------------- limits ----

/** Largest message accepted (bytes). The largest real one, an input, is ~300. */
const MAX_PAYLOAD = 1024;
/** Messages per second a connection may keep up, and the burst it may save
 *  up. A client sends at most one input a tick (60/s) and a ping every 2 s. */
const MSG_RATE = 120;
const MSG_BURST = 240;
/** Open sockets in total, and from one address (friends behind one router
 *  share an address, so not 1). */
const MAX_SOCKETS = MAX_PLAYERS + 16;
const MAX_PER_ADDR = num("maxPerAddr") ?? 8;
/** A connection that hasn't joined by now is hung up on (ms). */
const JOIN_TIMEOUT_MS = 5000;
/** Wrong passwords from one address before it is locked out, within / for (ms). */
const AUTH_FAILS = 5;
const AUTH_WINDOW_MS = 60_000;

/** Only on loopback can CF-Connecting-IP be believed: the sole peer is then
 *  cloudflared on this machine, while on an open interface anyone could
 *  write the header. */
const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

// --------------------------------------------------------------- password ----

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const PASSWORD = process.env.MADTAC_PASSWORD ? digest(process.env.MADTAC_PASSWORD) : null;
/** The password matches, compared in constant time (fixed-length digests). */
const passwordOk = (given: string | undefined): boolean => !PASSWORD || timingSafeEqual(digest(given ?? ""), PASSWORD);

// ---------------------------------------------------------------- errors -----

/** Each distinct error once in full, then a count every 600 repeats, so a
 *  fault that fires every tick doesn't bury the log. */
const seenErrors = new Map<string, number>();
function report(where: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  const key = `${where}: ${err.message}`;
  if (seenErrors.size > 200) seenErrors.clear();
  const n = (seenErrors.get(key) ?? 0) + 1;
  seenErrors.set(key, n);
  if (n === 1) console.error(`[server] error in ${key}\n${err.stack ?? ""}`);
  else if (n % 600 === 0) console.error(`[server] error in ${key} (x${n})`);
}
/** Run `f`, reporting rather than throwing. */
function safely(where: string, f: () => void): void {
  try {
    f();
  } catch (e) {
    report(where, e);
  }
}

// ---------------------------------------------------------------- match -----

const levelText = readFileSync(new URL(`../src/world/levels/${LEVEL}.json`, import.meta.url), "utf8");
const level = loadLevel(levelText);
const modeId = str("mode") ?? level.meta.mode ?? DEFAULT_MODE;
const makeMode = GAMEMODES[modeId] ?? GAMEMODES[DEFAULT_MODE];

function side(name: "blue" | "red", base?: Partial<TeamConfig>): Partial<TeamConfig> {
  const s: Partial<TeamConfig> = { ...base };
  const troops = num(`${name}Troops`);
  if (troops !== undefined) s.troops = troops;
  const skill = num(`${name}Skill`);
  if (skill !== undefined) s.skill = skill;
  const equip = str(`${name}Equip`);
  if (equip !== undefined) s.equip = equip;
  return s;
}
const meta: LevelMeta = { ...level.meta, mode: modeId };
if (modeId === "tdm") {
  meta.tdm = resolveTdm({
    killLimit: num("killLimit") ?? level.meta.tdm?.killLimit,
    respawnDelay: num("respawnDelay") ?? level.meta.tdm?.respawnDelay,
    blue: side("blue", level.meta.tdm?.blue),
    red: side("red", level.meta.tdm?.red),
  });
} else if (modeId === "domination") {
  meta.domination = resolveDom({
    scoreLimit: num("scoreLimit") ?? level.meta.domination?.scoreLimit,
    respawnDelay: num("respawnDelay") ?? level.meta.domination?.respawnDelay,
    blue: side("blue", level.meta.domination?.blue),
    red: side("red", level.meta.domination?.red),
  });
}

const game = new Game(level, makeMode(meta), { humans: 0 });
const sight = !!meta.visibility;

// -------------------------------------------------------------- clients -----

interface Client {
  ws: WebSocket | null;
  slot: PlayerSlot;
  token: string;
  mirror: ClientMirror;
  /** Inputs received since the last tick, merged as they arrive (so a flood
   *  can't pile them up) and applied at the next tick. */
  pending: PlayerInput | null;
  seq: number;
  /** When the socket dropped, for the reconnect grace; null while connected. */
  droppedAt: number | null;
}
const clients = new Map<string, Client>(); // by token

/** One open socket: where it comes from, its message budget, and the client
 *  it joined as (none yet = only a join is accepted). */
interface Conn {
  ws: WebSocket;
  addr: string;
  client: Client | null;
  budget: number;
  budgetAt: number;
  joinTimer: ReturnType<typeof setTimeout> | null;
}

const send = (ws: WebSocket | null, msg: ServerMsg): void => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
/** Tell them why, then close. */
function refuse(conn: Conn, reason: string): void {
  send(conn.ws, { t: "reject", reason });
  conn.ws.close(1008, reason.slice(0, 100));
}

/** Recent wrong passwords per address. */
const authFails = new Map<string, { n: number; since: number }>();
function lockedOut(addr: string): boolean {
  const f = authFails.get(addr);
  if (!f) return false;
  if (Date.now() - f.since > AUTH_WINDOW_MS) {
    authFails.delete(addr);
    return false;
  }
  return f.n >= AUTH_FAILS;
}
function failedAuth(addr: string): void {
  if (authFails.size > 10_000) authFails.clear();
  const f = authFails.get(addr);
  if (!f || Date.now() - f.since > AUTH_WINDOW_MS) authFails.set(addr, { n: 1, since: Date.now() });
  else f.n += 1;
}

/** A display name: printable, at most 24 characters. Control characters and
 *  the invisible / direction-flipping ones that could garble a scoreboard go. */
const cleanName = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").slice(0, 24).trim();

function attach(ws: WebSocket, c: Client): void {
  c.ws = ws;
  c.droppedAt = null;
  send(ws, {
    t: "welcome",
    protocol: PROTOCOL,
    id: c.slot.char.id,
    token: c.token,
    level: levelText,
    meta,
    tick: game.tick,
    snapHz: SNAP_HZ,
  });
  // What this client saw before (if anything) is stale after a rebuild.
  c.mirror = new ClientMirror(game, sight);
}

function join(conn: Conn, msg: Extract<ClientMsg, { t: "join" }>): void {
  if (msg.protocol !== PROTOCOL) return refuse(conn, `protocol ${msg.protocol}, server speaks ${PROTOCOL}`);
  if (lockedOut(conn.addr)) return refuse(conn, "too many wrong passwords; try again in a minute");
  // A reconnect: the slot is still held for them. The token came from a join
  // that already passed the password, so it stands in for one.
  const held = msg.token ? clients.get(msg.token) : undefined;
  if (held && held.ws === null) {
    conn.client = held;
    attach(conn.ws, held);
    console.log(`[server] ${held.slot.name} reconnected`);
    return;
  }
  if (!passwordOk(msg.password)) {
    failedAuth(conn.addr);
    return refuse(conn, msg.password ? "wrong password" : "this server needs a password");
  }
  if (game.humans.length >= MAX_PLAYERS) return refuse(conn, "match is full");
  const name = cleanName(msg.name) || `Player ${game.humans.length + 1}`;
  const slot = game.addHuman(name);
  const token = randomBytes(12).toString("hex");
  const c: Client = { ws: conn.ws, slot, token, mirror: new ClientMirror(game, sight), pending: null, seq: 0, droppedAt: null };
  clients.set(token, c);
  conn.client = c;
  attach(conn.ws, c);
  console.log(`[server] ${slot.name} joined as #${slot.char.id} (${game.humans.length} humans)`);
}

function leave(c: Client): void {
  clients.delete(c.token);
  game.removeHuman(c.slot);
  console.log(`[server] ${c.slot.name} left (${game.humans.length} humans)`);
}

function handle(conn: Conn, msg: ClientMsg): void {
  const c = conn.client;
  if (msg.t === "join") {
    if (!c) join(conn, msg);
    if (conn.client && conn.joinTimer) {
      clearTimeout(conn.joinTimer);
      conn.joinTimer = null;
    }
    return;
  }
  if (!c) return refuse(conn, "join first");
  switch (msg.t) {
    case "input":
      c.pending = c.pending ? mergeInputs(c.pending, msg.in) : msg.in;
      c.seq = msg.seq;
      break;
    case "loadout":
      game.gamemode.setPlayerLoadout?.(c.slot.char, msg.loadout);
      break;
    case "random":
      game.gamemode.randomizePlayerLoadout?.(c.slot.char);
      break;
    case "respawn":
      game.gamemode.requestRespawn?.(game, c.slot.char);
      break;
    case "ping":
      send(conn.ws, { t: "pong", at: msg.at });
      break;
    case "leave":
      conn.client = null;
      leave(c);
      conn.ws.close(1000, "left");
      break;
  }
}

// ------------------------------------------------------------------ loop -----

/** Events since the last snapshot, across the ticks in between. */
let sinceSnap: GameEvent[] = [];
let ticksSinceSnap = 0;
const ticksPerSnap = Math.max(1, Math.round(SIM_HZ / SNAP_HZ));

function tick(): void {
  // Apply what arrived: several inputs since the last tick were merged into
  // one so no press is lost; none at all means the held state carries.
  for (const c of clients.values()) {
    if (c.pending) {
      c.slot.input = c.pending;
      c.pending = null;
    }
    // A dropped player stands still rather than running into a wall forever.
    if (c.ws === null) c.slot.input = idleInput();
    if (c.droppedAt !== null && Date.now() - c.droppedAt > GRACE_MS) leave(c);
  }
  game.update();
  sinceSnap.push(...game.world.events);
  ticksSinceSnap += 1;
  if (ticksSinceSnap < ticksPerSnap) return;
  ticksSinceSnap = 0;
  for (const c of clients.values()) {
    if (!c.ws) continue;
    const ws = c.ws;
    try {
      send(ws, c.mirror.encode(game, c.slot, c.seq, sinceSnap));
    } catch (e) {
      // One client's snapshot failing shouldn't starve the others: drop
      // their socket (they reconnect to a fresh mirror).
      report("snapshot", e);
      ws.terminate();
    }
  }
  sinceSnap = [];
}

/** Ticks in a row that threw. */
let failing = 0;
function safeTick(): void {
  try {
    tick();
    failing = 0;
  } catch (e) {
    report("tick", e);
    failing += 1;
    if (failing >= SIM_HZ * 5) {
      console.error("[server] every tick has failed for 5 s; exiting so a supervisor can start the match fresh");
      process.exit(1);
    }
  }
}

// A fixed-rate loop that catches up after a stall (a few ticks at most, so a
// long GC pause doesn't burst the whole backlog).
const STEP_MS = 1000 / SIM_HZ;
let due = performance.now();
setInterval(() => {
  const now = performance.now();
  if (now - due > STEP_MS * 10) due = now - STEP_MS; // too far behind: drop the backlog
  let n = 0;
  while (due <= now && n < 4) {
    safeTick();
    due += STEP_MS;
    n += 1;
  }
}, Math.floor(STEP_MS / 2));

// ------------------------------------------------------------- transport -----

const http = createServer((req, res) => {
  if (req.method === "GET" && req.url === INFO_PATH) {
    const info: ServerInfo = {
      level: LEVEL, mode: modeId, players: game.humans.length, maxPlayers: MAX_PLAYERS,
      tick: game.tick, protocol: PROTOCOL, path: WS_PATH, locked: !!PASSWORD,
    };
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify(info));
    return;
  }
  res.statusCode = 404;
  res.end();
});
// A request that dawdles over its headers is dropped (a slow-loris holds
// sockets open that way). An upgraded websocket is past this and unaffected.
http.headersTimeout = 10_000;
http.requestTimeout = 10_000;

/** Where a connection comes from: the player's own address as the tunnel
 *  reports it, when it can be believed (see LOOPBACK), else the socket's. */
function addressOf(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (LOOPBACK && typeof cf === "string" && cf.length > 0 && cf.length <= 64) return cf;
  return req.socket.remoteAddress ?? "?";
}
const perAddr = new Map<string, number>();

const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
wss.on("connection", (ws, req) => {
  // First, before anything can fail: a socket error with no listener would
  // be thrown, and take the whole process with it. ws closes the socket
  // itself after an error (an oversized frame, bad UTF-8, a broken frame).
  ws.on("error", () => {});
  const addr = addressOf(req);
  if (wss.clients.size > MAX_SOCKETS) {
    ws.close(1013, "server busy");
    return;
  }
  const open = (perAddr.get(addr) ?? 0) + 1;
  if (open > MAX_PER_ADDR) {
    ws.close(1008, "too many connections");
    return;
  }
  perAddr.set(addr, open);
  const conn: Conn = { ws, addr, client: null, budget: MSG_BURST, budgetAt: Date.now(), joinTimer: null };
  conn.joinTimer = setTimeout(() => {
    conn.joinTimer = null;
    if (!conn.client) ws.terminate();
  }, JOIN_TIMEOUT_MS);

  ws.on("message", (data, isBinary) => {
    if (ws.readyState !== ws.OPEN) return; // hanging up already
    // The message budget refills at MSG_RATE a second, up to MSG_BURST.
    const now = Date.now();
    conn.budget = Math.min(MSG_BURST, conn.budget + ((now - conn.budgetAt) / 1000) * MSG_RATE);
    conn.budgetAt = now;
    if (conn.budget < 1) {
      ws.terminate();
      return;
    }
    conn.budget -= 1;
    let msg: ClientMsg | null = null;
    if (!isBinary) {
      try {
        msg = parseClientMsg(JSON.parse(String(data)));
      } catch {
        msg = null;
      }
    }
    if (!msg) {
      ws.close(1008, "bad message");
      return;
    }
    try {
      handle(conn, msg);
    } catch (e) {
      // Whatever this message did half-way, the client that sent it goes.
      report(`message "${msg.t}"`, e);
      const c = conn.client;
      conn.client = null;
      if (c) safely("leave", () => leave(c));
      ws.terminate();
    }
  });
  ws.on("close", () => {
    if (conn.joinTimer) clearTimeout(conn.joinTimer);
    const left = (perAddr.get(addr) ?? 1) - 1;
    if (left > 0) perAddr.set(addr, left);
    else perAddr.delete(addr);
    const c = conn.client;
    if (!c || c.ws !== ws) return;
    c.ws = null;
    c.droppedAt = Date.now();
    console.log(`[server] ${c.slot.name} dropped; holding the slot ${GRACE_MS / 1000}s`);
  });
});
http.listen(PORT, HOST, () => {
  const where = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`[server] ${LEVEL} (${modeId}) on ws://${where}:${PORT}${WS_PATH} — ${SIM_HZ} tps, ${SNAP_HZ} snaps/s${PASSWORD ? ", password required" : ""}`);
  if (!LOOPBACK) console.warn(`[server] listening on ${HOST}: anything that can reach this machine can connect directly, not just the tunnel`);
});
