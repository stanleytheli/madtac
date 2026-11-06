/**
 * A hosted match, whatever carries its sockets: one Game (src/game.ts) ticking
 * at SIM_HZ, a connection per human, and everything that keeps it standing in
 * front of the open internet. Two thin transports drive it: server/server.ts
 * (Node, `npm run server`) and worker/index.ts (a Cloudflare Durable Object).
 * Each hands over sockets as HostSocket and passes their messages and closes
 * along; nothing here knows which runtime it is in.
 *
 * Everything that reaches a match is assumed hostile:
 *   - A join password (MatchConfig.password), checked before any game code
 *     runs, compared in constant time. Five wrong ones from an address in a
 *     minute lock it out for a minute.
 *   - Every message must parse as exactly one of the shapes the protocol
 *     defines (parseClientMsg); anything else, and anything but a join before
 *     joining, hangs up.
 *   - Caps on message size, messages per second per connection, open sockets
 *     in total and per address, and how long a socket may take to join.
 *   - An exception while handling one client's message drops that client. A
 *     tick that throws is logged and the match goes on; a match that has
 *     thrown on every tick for five seconds is handed to the transport's
 *     onFatal, which starts it fresh.
 *
 * The match ticks only while someone is connected (or held for a reconnect):
 * an empty match costs nothing, which a Durable Object needs, and it is built
 * on the first join, so a find-game probe of /info doesn't build a world.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Game, type PlayerSlot } from "../src/game.ts";
import { DEFAULT_MODE, GAMEMODES, type Gamemode } from "../src/gamemodes/gamemode.ts";
import { resolveDom } from "../src/gamemodes/domination.ts";
import { resolveTdm } from "../src/gamemodes/tdm.ts";
import { loadLevel, type LevelMeta, type LevelState, type TeamConfig } from "../src/world/level.ts";
import type { GameEvent } from "../src/engine/events.ts";
import { idleInput, type PlayerInput } from "../src/engine/command.ts";
import { ClientMirror } from "../src/net/snapshot.ts";
import {
  DEFAULT_SNAP_HZ,
  PROTOCOL,
  SIM_HZ,
  WS_PATH,
  mergeInputs,
  parseClientMsg,
  type ClientMsg,
  type ServerInfo,
  type ServerMsg,
} from "../src/net/protocol.ts";

// ----------------------------------------------------------------- limits ----

/** Largest message accepted (characters). The largest real one, an input, is
 *  ~300. (Node's ws also refuses bigger frames before they get here.) */
export const MAX_PAYLOAD = 1024;
/** Messages per second a connection may keep up, and the burst it may save
 *  up. A client sends at most one input a tick (60/s) and a ping every 2 s. */
const MSG_RATE = 120;
const MSG_BURST = 240;
/** Spare sockets beyond maxPlayers (joining, reconnecting, probing). */
const SPARE_SOCKETS = 16;
/** A socket that hasn't joined by now is hung up on (ms). */
const JOIN_TIMEOUT_MS = 5000;
/** Wrong passwords from one address before it is locked out, within / for (ms). */
const AUTH_FAILS = 5;
const AUTH_WINDOW_MS = 60_000;
/** How long a dropped connection's slot is held for a reconnect (ms). */
const GRACE_MS = 30_000;

// ----------------------------------------------------------------- config ----

/** Per-mode knobs a host may set over the level's own (each optional). */
export interface MatchOverrides {
  killLimit?: number;
  scoreLimit?: number;
  respawnDelay?: number;
  blueTroops?: number;
  redTroops?: number;
  blueSkill?: number;
  redSkill?: number;
  blueEquip?: string;
  redEquip?: string;
}

export interface MatchConfig {
  /** The level's file name (what /info reports) and its JSON text. */
  levelName: string;
  levelText: string;
  /** Gamemode id; default the level's own, else the sandbox. */
  mode?: string;
  overrides?: MatchOverrides;
  maxPlayers?: number;
  /** Open sockets allowed from one address. Friends behind one router share
   *  one, so not 1. */
  maxPerAddr?: number;
  snapHz?: number;
  /** Joining takes this password (empty / absent = open). */
  password?: string;
  /** The match has thrown on every tick for five seconds: start it fresh
   *  (Node exits for a supervisor; a Durable Object rebuilds its host). */
  onFatal?: () => void;
}

/** What a transport hands over for each socket. */
export interface HostSocket {
  /** Still open; a closed socket is skipped, not an error. */
  readonly open: boolean;
  send(text: string): void;
  /** Close with a code and a reason (an honest client is told why). */
  close(code: number, reason: string): void;
  /** Drop at once, no closing handshake (abuse). */
  terminate(): void;
}

/** One human in the match: their slot, and the socket they play through
 *  (null while dropped and held for a reconnect). */
interface Client {
  socket: HostSocket | null;
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

/** One open socket: where it comes from, its message budget, and the client
 *  it joined as (none yet = only a join is accepted). Opaque to transports. */
export interface Conn {
  readonly socket: HostSocket;
  readonly addr: string;
  client: Client | null;
  budget: number;
  budgetAt: number;
  joinTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** A display name: printable, at most 24 characters. Control characters and
 *  the invisible / direction-flipping ones that could garble a scoreboard go. */
const cleanName = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").slice(0, 24).trim();

/** The match's resolved meta: the level's own, with the mode and overrides. */
function resolveMeta(level: LevelState, modeId: string, o: MatchOverrides): LevelMeta {
  const side = (name: "blue" | "red", base?: Partial<TeamConfig>): Partial<TeamConfig> => {
    const s: Partial<TeamConfig> = { ...base };
    const troops = o[`${name}Troops`];
    if (troops !== undefined) s.troops = troops;
    const skill = o[`${name}Skill`];
    if (skill !== undefined) s.skill = skill;
    const equip = o[`${name}Equip`];
    if (equip !== undefined) s.equip = equip;
    return s;
  };
  const meta: LevelMeta = { ...level.meta, mode: modeId };
  if (modeId === "tdm") {
    meta.tdm = resolveTdm({
      killLimit: o.killLimit ?? level.meta.tdm?.killLimit,
      respawnDelay: o.respawnDelay ?? level.meta.tdm?.respawnDelay,
      blue: side("blue", level.meta.tdm?.blue),
      red: side("red", level.meta.tdm?.red),
    });
  } else if (modeId === "domination") {
    meta.domination = resolveDom({
      scoreLimit: o.scoreLimit ?? level.meta.domination?.scoreLimit,
      respawnDelay: o.respawnDelay ?? level.meta.domination?.respawnDelay,
      blue: side("blue", level.meta.domination?.blue),
      red: side("red", level.meta.domination?.red),
    });
  }
  return meta;
}

export class MatchHost {
  readonly levelName: string;
  readonly modeId: string;
  readonly maxPlayers: number;
  readonly locked: boolean;
  private readonly levelText: string;
  private readonly meta: LevelMeta;
  private readonly makeMode: (meta: LevelMeta) => Gamemode;
  private readonly sight: boolean;
  private readonly snapHz: number;
  private readonly maxPerAddr: number;
  private readonly password: Buffer | null;
  private readonly onFatal: () => void;

  /** Built on the first join (see the file comment). */
  private game: Game | null = null;
  private readonly clients = new Map<string, Client>(); // by token
  private readonly conns = new Set<Conn>();
  private readonly perAddr = new Map<string, number>();
  private readonly authFails = new Map<string, { n: number; since: number }>();
  private readonly seenErrors = new Map<string, number>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private due = 0;
  private failing = 0;
  /** Events since the last snapshot, across the ticks in between. */
  private sinceSnap: GameEvent[] = [];
  private ticksSinceSnap = 0;

  constructor(cfg: MatchConfig) {
    this.levelName = cfg.levelName;
    this.levelText = cfg.levelText;
    // Parsed now so a broken level fails at startup, not at the first join.
    const level = loadLevel(cfg.levelText);
    this.modeId = cfg.mode ?? level.meta.mode ?? DEFAULT_MODE;
    this.makeMode = GAMEMODES[this.modeId] ?? GAMEMODES[DEFAULT_MODE];
    this.meta = resolveMeta(level, this.modeId, cfg.overrides ?? {});
    this.sight = !!this.meta.visibility;
    this.maxPlayers = cfg.maxPlayers ?? 16;
    this.maxPerAddr = cfg.maxPerAddr ?? 8;
    this.snapHz = cfg.snapHz ?? DEFAULT_SNAP_HZ;
    this.password = cfg.password ? digest(cfg.password) : null;
    this.locked = !!this.password;
    this.onFatal = cfg.onFatal ?? (() => {});
  }

  /** What GET /info answers. */
  info(): ServerInfo {
    return {
      level: this.levelName, mode: this.modeId, players: this.game?.humans.length ?? 0, maxPlayers: this.maxPlayers,
      tick: this.game?.tick ?? 0, protocol: PROTOCOL, path: WS_PATH, locked: this.locked,
    };
  }

  // ------------------------------------------------------------ sockets ----

  /** A socket opened from `addr`. Returns its Conn, or null if refused (the
   *  socket is closed already). */
  connect(socket: HostSocket, addr: string): Conn | null {
    if (this.conns.size >= this.maxPlayers + SPARE_SOCKETS) {
      socket.close(1013, "server busy");
      return null;
    }
    const open = (this.perAddr.get(addr) ?? 0) + 1;
    if (open > this.maxPerAddr) {
      socket.close(1008, "too many connections");
      return null;
    }
    this.perAddr.set(addr, open);
    const conn: Conn = { socket, addr, client: null, budget: MSG_BURST, budgetAt: Date.now(), joinTimer: null, closed: false };
    conn.joinTimer = setTimeout(() => {
      conn.joinTimer = null;
      if (!conn.client) socket.terminate();
    }, JOIN_TIMEOUT_MS);
    this.conns.add(conn);
    return conn;
  }

  /** A message arrived on `conn`: its text, or null if it was binary. */
  message(conn: Conn, text: string | null): void {
    if (conn.closed || !conn.socket.open) return; // hanging up already
    // The message budget refills at MSG_RATE a second, up to MSG_BURST.
    const now = Date.now();
    conn.budget = Math.min(MSG_BURST, conn.budget + ((now - conn.budgetAt) / 1000) * MSG_RATE);
    conn.budgetAt = now;
    if (conn.budget < 1) {
      conn.socket.terminate();
      return;
    }
    conn.budget -= 1;
    if (text !== null && text.length > MAX_PAYLOAD) {
      conn.socket.close(1009, "message too big");
      return;
    }
    let msg: ClientMsg | null = null;
    if (text !== null) {
      try {
        msg = parseClientMsg(JSON.parse(text));
      } catch {
        msg = null;
      }
    }
    if (!msg) {
      conn.socket.close(1008, "bad message");
      return;
    }
    try {
      this.handle(conn, msg);
    } catch (e) {
      // Whatever this message did half-way, the client that sent it goes.
      this.report(`message "${msg.t}"`, e);
      const c = conn.client;
      conn.client = null;
      if (c) this.safely("leave", () => this.leave(c));
      conn.socket.terminate();
    }
  }

  /** `conn`'s socket closed (safe to call more than once). */
  closed(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    if (conn.joinTimer) clearTimeout(conn.joinTimer);
    const left = (this.perAddr.get(conn.addr) ?? 1) - 1;
    if (left > 0) this.perAddr.set(conn.addr, left);
    else this.perAddr.delete(conn.addr);
    const c = conn.client;
    if (!c || c.socket !== conn.socket) return;
    c.socket = null;
    c.droppedAt = Date.now();
    console.log(`[server] ${c.slot.name} dropped; holding the slot ${GRACE_MS / 1000}s`);
  }

  /** Stop ticking and drop every socket (a transport starting afresh). */
  shutdown(): void {
    this.stopLoop();
    for (const conn of [...this.conns]) conn.socket.terminate();
  }

  // ------------------------------------------------------------ joining ----

  private send(socket: HostSocket | null, msg: ServerMsg): void {
    if (socket && socket.open) socket.send(JSON.stringify(msg));
  }

  /** Tell them why, then close. */
  private refuse(conn: Conn, reason: string): void {
    this.send(conn.socket, { t: "reject", reason });
    conn.socket.close(1008, reason.slice(0, 100));
  }

  private passwordOk(given: string | undefined): boolean {
    return !this.password || timingSafeEqual(digest(given ?? ""), this.password);
  }

  private lockedOut(addr: string): boolean {
    const f = this.authFails.get(addr);
    if (!f) return false;
    if (Date.now() - f.since > AUTH_WINDOW_MS) {
      this.authFails.delete(addr);
      return false;
    }
    return f.n >= AUTH_FAILS;
  }

  private failedAuth(addr: string): void {
    if (this.authFails.size > 10_000) this.authFails.clear();
    const f = this.authFails.get(addr);
    if (!f || Date.now() - f.since > AUTH_WINDOW_MS) this.authFails.set(addr, { n: 1, since: Date.now() });
    else f.n += 1;
  }

  private ensureGame(): Game {
    if (!this.game) this.game = new Game(loadLevel(this.levelText), this.makeMode(this.meta), { humans: 0 });
    return this.game;
  }

  private attach(socket: HostSocket, c: Client): void {
    const game = this.ensureGame();
    c.socket = socket;
    c.droppedAt = null;
    this.send(socket, {
      t: "welcome",
      protocol: PROTOCOL,
      id: c.slot.char.id,
      token: c.token,
      level: this.levelText,
      meta: this.meta,
      tick: game.tick,
      snapHz: this.snapHz,
    });
    // What this client saw before (if anything) is stale after a rebuild.
    c.mirror = new ClientMirror(game, this.sight);
    this.startLoop();
  }

  private join(conn: Conn, msg: Extract<ClientMsg, { t: "join" }>): void {
    if (msg.protocol !== PROTOCOL) return this.refuse(conn, `protocol ${msg.protocol}, server speaks ${PROTOCOL}`);
    if (this.lockedOut(conn.addr)) return this.refuse(conn, "too many wrong passwords; try again in a minute");
    // A reconnect: the slot is still held for them. The token came from a join
    // that already passed the password, so it stands in for one.
    const held = msg.token ? this.clients.get(msg.token) : undefined;
    if (held && held.socket === null) {
      conn.client = held;
      this.attach(conn.socket, held);
      console.log(`[server] ${held.slot.name} reconnected`);
      return;
    }
    if (!this.passwordOk(msg.password)) {
      this.failedAuth(conn.addr);
      return this.refuse(conn, msg.password ? "wrong password" : "this server needs a password");
    }
    const game = this.ensureGame();
    if (game.humans.length >= this.maxPlayers) return this.refuse(conn, "match is full");
    const name = cleanName(msg.name) || `Player ${game.humans.length + 1}`;
    const slot = game.addHuman(name);
    const token = randomBytes(12).toString("hex");
    const c: Client = { socket: conn.socket, slot, token, mirror: new ClientMirror(game, this.sight), pending: null, seq: 0, droppedAt: null };
    this.clients.set(token, c);
    conn.client = c;
    this.attach(conn.socket, c);
    console.log(`[server] ${slot.name} joined as #${slot.char.id} (${game.humans.length} humans)`);
  }

  private leave(c: Client): void {
    this.clients.delete(c.token);
    if (this.game) {
      this.game.removeHuman(c.slot);
      console.log(`[server] ${c.slot.name} left (${this.game.humans.length} humans)`);
    }
  }

  private handle(conn: Conn, msg: ClientMsg): void {
    const c = conn.client;
    if (msg.t === "join") {
      if (!c) this.join(conn, msg);
      if (conn.client && conn.joinTimer) {
        clearTimeout(conn.joinTimer);
        conn.joinTimer = null;
      }
      return;
    }
    if (!c) return this.refuse(conn, "join first");
    const game = this.ensureGame();
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
        this.send(conn.socket, { t: "pong", at: msg.at });
        break;
      case "leave":
        conn.client = null;
        this.leave(c);
        conn.socket.close(1000, "left");
        break;
    }
  }

  // --------------------------------------------------------------- loop ----

  /** A fixed-rate loop that catches up after a stall (a few ticks at most, so
   *  a long pause doesn't burst the whole backlog). */
  private startLoop(): void {
    if (this.loop) return;
    const step = 1000 / SIM_HZ;
    this.due = performance.now();
    this.loop = setInterval(() => {
      const now = performance.now();
      if (now - this.due > step * 10) this.due = now - step; // too far behind: drop the backlog
      let n = 0;
      while (this.loop && this.due <= now && n < 4) {
        this.safeTick();
        this.due += step;
        n += 1;
      }
    }, Math.floor(step / 2));
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private tick(): void {
    const game = this.ensureGame();
    // Apply what arrived: several inputs since the last tick were merged into
    // one so no press is lost; none at all means the held state carries.
    for (const c of this.clients.values()) {
      if (c.pending) {
        c.slot.input = c.pending;
        c.pending = null;
      }
      // A dropped player stands still rather than running into a wall forever.
      if (c.socket === null) c.slot.input = idleInput();
      if (c.droppedAt !== null && Date.now() - c.droppedAt > GRACE_MS) this.leave(c);
    }
    // Nobody connected or held: rest until someone joins.
    if (this.clients.size === 0) {
      this.stopLoop();
      return;
    }
    game.update();
    this.sinceSnap.push(...game.world.events);
    this.ticksSinceSnap += 1;
    if (this.ticksSinceSnap < Math.max(1, Math.round(SIM_HZ / this.snapHz))) return;
    this.ticksSinceSnap = 0;
    for (const c of this.clients.values()) {
      const socket = c.socket;
      if (!socket) continue;
      try {
        this.send(socket, c.mirror.encode(game, c.slot, c.seq, this.sinceSnap));
      } catch (e) {
        // One client's snapshot failing shouldn't starve the others: drop
        // their socket (they reconnect to a fresh mirror).
        this.report("snapshot", e);
        socket.terminate();
      }
    }
    this.sinceSnap = [];
  }

  private safeTick(): void {
    try {
      this.tick();
      this.failing = 0;
    } catch (e) {
      this.report("tick", e);
      this.failing += 1;
      if (this.failing >= SIM_HZ * 5) {
        console.error("[server] every tick has failed for 5 s; starting the match fresh");
        this.failing = 0;
        this.shutdown();
        this.onFatal();
      }
    }
  }

  // ------------------------------------------------------------- errors ----

  /** Each distinct error once in full, then a count every 600 repeats, so a
   *  fault that fires every tick doesn't bury the log. */
  private report(where: string, e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    const key = `${where}: ${err.message}`;
    if (this.seenErrors.size > 200) this.seenErrors.clear();
    const n = (this.seenErrors.get(key) ?? 0) + 1;
    this.seenErrors.set(key, n);
    if (n === 1) console.error(`[server] error in ${key}\n${err.stack ?? ""}`);
    else if (n % 600 === 0) console.error(`[server] error in ${key} (x${n})`);
  }

  private safely(where: string, f: () => void): void {
    try {
      f();
    } catch (e) {
      this.report(where, e);
    }
  }
}
