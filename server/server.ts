/**
 * The Node transport for a hosted match (server/host.ts): reads the options,
 * serves GET /info and the websocket on one port, and hands each socket to
 * the MatchHost. worker/index.ts is the same match on Cloudflare.
 *
 *   npm run server -- --level dust2-15 --mode tdm --port 7777
 *   MADTAC_PASSWORD=hunter2 npm run server      # joining takes a password
 *
 * Options: --level <name> (src/world/levels/<name>.json), --mode <id>, --port,
 * --host (default 127.0.0.1), --snap <hz>, --maxPlayers, --maxPerAddr,
 * --blueTroops/--redTroops, --blueSkill/--redSkill, --blueEquip/--redEquip,
 * --killLimit, --scoreLimit, --respawnDelay.
 *
 * What this file adds to the host's own defences (see host.ts):
 *   - It listens on 127.0.0.1 only, so the one way in is the tunnel
 *     (cloudflared) running beside it. --host 0.0.0.0 opens it to the local
 *     network too, for playing over LAN with no tunnel.
 *   - The password comes from MADTAC_PASSWORD, an environment variable rather
 *     than a flag, since flags show up in `ps`.
 *   - Frames over the size cap are refused by ws itself, and every socket gets
 *     an 'error' listener before anything else (without one, ws throws the
 *     error and the process dies).
 *   - A match that keeps failing exits the process, for a supervisor (systemd)
 *     to start it fresh.
 * `npm run server` also runs Node with eval disabled and file reads limited
 * to the server bundle, its `ws` dependency and the levels folder.
 */
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { INFO_PATH, DEFAULT_PORT, SIM_HZ, WS_PATH } from "../src/net/protocol.ts";
import { MAX_PAYLOAD, MatchHost, type HostSocket, type MatchOverrides } from "./host.ts";

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
/** Only on loopback can CF-Connecting-IP be believed: the sole peer is then
 *  cloudflared on this machine, while on an open interface anyone could
 *  write the header. */
const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

const overrides: MatchOverrides = {
  killLimit: num("killLimit"),
  scoreLimit: num("scoreLimit"),
  respawnDelay: num("respawnDelay"),
  blueTroops: num("blueTroops"),
  redTroops: num("redTroops"),
  blueSkill: num("blueSkill"),
  redSkill: num("redSkill"),
  blueEquip: str("blueEquip"),
  redEquip: str("redEquip"),
};

const host = new MatchHost({
  levelName: LEVEL,
  levelText: readFileSync(new URL(`../src/world/levels/${LEVEL}.json`, import.meta.url), "utf8"),
  mode: str("mode"),
  overrides,
  maxPlayers: num("maxPlayers"),
  maxPerAddr: num("maxPerAddr"),
  snapHz: num("snap"),
  password: process.env.MADTAC_PASSWORD || undefined,
  onFatal: () => process.exit(1),
});

// ------------------------------------------------------------- transport -----

const http = createServer((req, res) => {
  if (req.method === "GET" && req.url === INFO_PATH) {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify(host.info()));
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

const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
wss.on("connection", (ws, req) => {
  // First, before anything can fail: a socket error with no listener would
  // be thrown, and take the whole process with it. ws closes the socket
  // itself after an error (an oversized frame, bad UTF-8, a broken frame).
  ws.on("error", () => {});
  const socket: HostSocket = {
    get open() {
      return ws.readyState === ws.OPEN;
    },
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
  const conn = host.connect(socket, addressOf(req));
  if (!conn) return;
  ws.on("message", (data, isBinary) => host.message(conn, isBinary ? null : String(data)));
  ws.on("close", () => host.closed(conn));
});
http.listen(PORT, HOST, () => {
  const where = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`[server] ${LEVEL} (${host.modeId}) on ws://${where}:${PORT}${WS_PATH} — ${SIM_HZ} tps${host.locked ? ", password required" : ""}`);
  if (!LOOPBACK) console.warn(`[server] listening on ${HOST}: anything that can reach this machine can connect directly, not just the tunnel`);
});
