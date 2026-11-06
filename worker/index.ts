/**
 * The Cloudflare transport for a hosted match (server/host.ts): a Worker that
 * routes GET /info and the /play websocket to a Durable Object per room, and
 * the Durable Object (MatchRoom) that runs the room's MatchHost. Rooms come
 * from ?room=<name> (default "main"); each is one match, run in one place.
 *
 * The room's settings come from the Worker's variables (wrangler.jsonc
 * "vars", or the dashboard): LEVEL, MODE, MAX_PLAYERS, MAX_PER_ADDR,
 * KILL_LIMIT, SCORE_LIMIT, RESPAWN_DELAY, BLUE_TROOPS / RED_TROOPS,
 * BLUE_SKILL / RED_SKILL, BLUE_EQUIP / RED_EQUIP; the join password from the
 * secret MADTAC_PASSWORD (`npx wrangler secret put MADTAC_PASSWORD`).
 *
 * The match ticks only while someone is connected (see MatchHost), so an
 * empty room does nothing and Cloudflare can put it away; the next join
 * builds it fresh. A player's address is CF-Connecting-IP, which Cloudflare
 * sets itself, so the per-address limits can trust it.
 */
import { MatchHost, type HostSocket, type MatchOverrides } from "../server/host.ts";
import { INFO_PATH, WS_PATH } from "../src/net/protocol.ts";

// The few Workers runtime types used here. (The full set,
// @cloudflare/workers-types, clashes with the DOM types the game is checked
// against.)
interface CfWebSocket {
  readonly readyState: number;
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", cb: (ev: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close" | "error", cb: () => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface Env {
  MATCH: DurableObjectNamespace;
  LEVEL?: string;
  MODE?: string;
  MAX_PLAYERS?: string;
  MAX_PER_ADDR?: string;
  KILL_LIMIT?: string;
  SCORE_LIMIT?: string;
  RESPAWN_DELAY?: string;
  BLUE_TROOPS?: string;
  RED_TROOPS?: string;
  BLUE_SKILL?: string;
  RED_SKILL?: string;
  BLUE_EQUIP?: string;
  RED_EQUIP?: string;
  MADTAC_PASSWORD?: string;
}

const OPEN = 1;
const ROOM = /^[\w-]{1,32}$/;
const LEVEL_NAME = /^[\w-]+$/;

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== WS_PATH && url.pathname !== INFO_PATH) return text("not found", 404);
    if (request.method !== "GET") return text("method not allowed", 405);
    const room = url.searchParams.get("room") ?? "main";
    if (!ROOM.test(room)) return text("a room is 1-32 letters, digits, - or _", 400);
    return env.MATCH.get(env.MATCH.idFromName(room)).fetch(request);
  },
};

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The level's JSON text. Every file in the levels folder is bundled (esbuild
 *  follows the pattern), and the name is checked before it is used. */
async function levelText(name: string): Promise<string> {
  if (!LEVEL_NAME.test(name)) throw new Error(`LEVEL must be a level's file name, not "${name}"`);
  const mod = (await import(`../src/world/levels/${name}.json`)) as { default: unknown };
  return JSON.stringify(mod.default);
}

/** Close a Workers socket, never throwing (it may be closing already). */
function closeQuietly(ws: CfWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** One room: its MatchHost, built on the first request and rebuilt if the
 *  match ever fails for good. */
export class MatchRoom {
  private host: Promise<MatchHost> | null = null;

  constructor(
    _state: unknown,
    private readonly env: Env,
  ) {}

  private getHost(): Promise<MatchHost> {
    if (!this.host) {
      const env = this.env;
      const levelName = env.LEVEL || "dom-arena-big-fix";
      const overrides: MatchOverrides = {
        killLimit: num(env.KILL_LIMIT),
        scoreLimit: num(env.SCORE_LIMIT),
        respawnDelay: num(env.RESPAWN_DELAY),
        blueTroops: num(env.BLUE_TROOPS),
        redTroops: num(env.RED_TROOPS),
        blueSkill: num(env.BLUE_SKILL),
        redSkill: num(env.RED_SKILL),
        blueEquip: env.BLUE_EQUIP || undefined,
        redEquip: env.RED_EQUIP || undefined,
      };
      this.host = levelText(levelName).then(
        (levelTextValue) =>
          new MatchHost({
            levelName,
            levelText: levelTextValue,
            mode: env.MODE || undefined,
            overrides,
            maxPlayers: num(env.MAX_PLAYERS),
            maxPerAddr: num(env.MAX_PER_ADDR),
            password: env.MADTAC_PASSWORD || undefined,
            // The host has already dropped everyone; the next join builds anew.
            onFatal: () => {
              this.host = null;
            },
          }),
      );
      // A bad LEVEL shouldn't stick: let the next request try again.
      this.host.catch(() => {
        this.host = null;
      });
    }
    return this.host;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let host: MatchHost;
    try {
      host = await this.getHost();
    } catch (e) {
      console.error(`[room] can't start the match: ${(e as Error).message}`);
      return text("this server is misconfigured", 500);
    }
    if (url.pathname === INFO_PATH) {
      return new Response(JSON.stringify(host.info()), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return text("expected a websocket", 426);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const socket: HostSocket = {
      get open() {
        return server.readyState === OPEN;
      },
      send: (t) => server.send(t),
      close: (code, reason) => closeQuietly(server, code, reason),
      // Workers sockets have no hard reset; a close does the same job here.
      terminate: () => closeQuietly(server, 1008, "dropped"),
    };
    const conn = host.connect(socket, request.headers.get("cf-connecting-ip") ?? "unknown");
    if (conn) {
      server.addEventListener("message", (ev) => host.message(conn, typeof ev.data === "string" ? ev.data : null));
      server.addEventListener("close", () => host.closed(conn));
      server.addEventListener("error", () => host.closed(conn));
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}
