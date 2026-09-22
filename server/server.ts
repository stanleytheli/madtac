/**
 * The dedicated server: one match, one Game (src/game.ts) ticking at SIM_HZ in
 * this process, a WebSocket per human. Bots live here. Each connection gets a
 * PlayerSlot in the Game; its inputs come off the wire (see net/protocol.ts),
 * its snapshots go back through a ClientMirror (net/snapshot.ts) that sends
 * only what that player can see.
 *
 *   npm run server -- --level dust2-15 --mode tdm --port 7777
 *
 * Options: --level <name> (src/world/levels/<name>.json), --mode <id>, --port,
 * --snap <hz>, --blueTroops/--redTroops, --blueSkill/--redSkill,
 * --blueEquip/--redEquip, --killLimit, --scoreLimit, --respawnDelay.
 * GET /info on the same port describes the match (a find-game endpoint).
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  PROTOCOL,
  SIM_HZ,
  WS_PATH,
  mergeInputs,
  sanitizeInput,
  type ClientMsg,
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
const PORT = num("port") ?? DEFAULT_PORT;
const SNAP_HZ = num("snap") ?? DEFAULT_SNAP_HZ;
const MAX_PLAYERS = num("maxPlayers") ?? 16;
/** How long a dropped connection's slot is held for a reconnect (ms). */
const GRACE_MS = 30_000;

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
  /** Inputs received since the last tick, applied (merged) at the next. */
  pending: PlayerInput[];
  seq: number;
  /** When the socket dropped, for the reconnect grace; null while connected. */
  droppedAt: number | null;
}
const clients = new Map<string, Client>(); // by token

const send = (ws: WebSocket | null, msg: ServerMsg): void => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

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

function join(ws: WebSocket, msg: Extract<ClientMsg, { t: "join" }>): void {
  if (msg.protocol !== PROTOCOL) {
    send(ws, { t: "reject", reason: `protocol ${msg.protocol}, server speaks ${PROTOCOL}` });
    ws.close();
    return;
  }
  // A reconnect: the slot is still held for them.
  const held = msg.token ? clients.get(msg.token) : undefined;
  if (held && held.ws === null) {
    attach(ws, held);
    console.log(`[server] ${held.slot.name} reconnected`);
    return;
  }
  if (game.humans.length >= MAX_PLAYERS) {
    send(ws, { t: "reject", reason: "match is full" });
    ws.close();
    return;
  }
  const name = String(msg.name ?? "").slice(0, 24).trim() || `Player ${game.humans.length + 1}`;
  const slot = game.addHuman(name);
  const token = randomBytes(12).toString("hex");
  const c: Client = { ws, slot, token, mirror: new ClientMirror(game, sight), pending: [], seq: 0, droppedAt: null };
  clients.set(token, c);
  attach(ws, c);
  console.log(`[server] ${name} joined as #${slot.char.id} (${game.humans.length} humans)`);
}

function leave(c: Client): void {
  clients.delete(c.token);
  game.removeHuman(c.slot);
  console.log(`[server] ${c.slot.name} left (${game.humans.length} humans)`);
}

function handle(ws: WebSocket, c: Client | undefined, msg: ClientMsg): Client | undefined {
  if (msg.t === "join") {
    if (c) return c; // already in
    join(ws, msg);
    return [...clients.values()].find((x) => x.ws === ws);
  }
  if (!c) return undefined; // nothing else before a join
  switch (msg.t) {
    case "input":
      c.pending.push(sanitizeInput(msg.in));
      if (typeof msg.seq === "number") c.seq = msg.seq;
      break;
    case "loadout":
      game.gamemode.setPlayerLoadout?.(c.slot.char, msg.loadout ?? {});
      break;
    case "random":
      game.gamemode.randomizePlayerLoadout?.(c.slot.char);
      break;
    case "respawn":
      game.gamemode.requestRespawn?.(game, c.slot.char);
      break;
    case "ping":
      send(ws, { t: "pong", at: msg.at });
      break;
  }
  return c;
}

// ------------------------------------------------------------------ loop -----

/** Events since the last snapshot, across the ticks in between. */
let sinceSnap: GameEvent[] = [];
let ticksSinceSnap = 0;
const ticksPerSnap = Math.max(1, Math.round(SIM_HZ / SNAP_HZ));

function tick(): void {
  // Apply what arrived: several inputs since the last tick merge into one so
  // no press is lost; none at all means the held state carries (see heldOnly).
  for (const c of clients.values()) {
    if (c.pending.length) {
      c.slot.input = c.pending.reduce(mergeInputs);
      c.pending.length = 0;
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
    send(c.ws, c.mirror.encode(game, c.slot, c.seq, sinceSnap));
  }
  sinceSnap = [];
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
    tick();
    due += STEP_MS;
    n += 1;
  }
}, Math.floor(STEP_MS / 2));

// ------------------------------------------------------------- transport -----

const http = createServer((req, res) => {
  if (req.url === "/info") {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify({
      level: LEVEL, mode: modeId, players: game.humans.length, maxPlayers: MAX_PLAYERS,
      tick: game.tick, protocol: PROTOCOL, path: WS_PATH,
    }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: 4096 });
wss.on("connection", (ws) => {
  let client: Client | undefined;
  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      ws.close();
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    client = handle(ws, client, msg);
  });
  ws.on("close", () => {
    if (!client || client.ws !== ws) return;
    client.ws = null;
    client.droppedAt = Date.now();
    console.log(`[server] ${client.slot.name} dropped; holding the slot ${GRACE_MS / 1000}s`);
  });
});
http.listen(PORT, () => {
  console.log(`[server] ${LEVEL} (${modeId}) on ws://localhost:${PORT}${WS_PATH} — ${SIM_HZ} tps, ${SNAP_HZ} snaps/s`);
});
