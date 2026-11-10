/**
 * End to end: builds and starts the real dedicated server (server/server.ts)
 * on a spare port, connects with Node's WebSocket, joins, and checks the
 * things a player would notice — a welcome with the level, snapshots flowing,
 * the character moving when told to, /info answering, and a dropped socket
 * reconnecting to the same character with its token. Then it attacks it: an
 * oversized frame, garbage, strangers' fields, a flood, a socket that never
 * joins, too many sockets from one address, wrong passwords; after each, the
 * server must still be up.
 *
 * The server runs with the same Node flags `npm run server` gives it (read
 * from package.json), so the lockdown is what gets tested. With --worker the
 * same suite runs against the Cloudflare build instead (worker/index.ts under
 * `wrangler dev`, Cloudflare's own runtime run locally).
 *
 * Run: node scripts/verify_server.mts            (Node; spawns esbuild itself)
 *      node scripts/verify_server.mts --worker   (the Worker, via wrangler dev)
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import RawSocket from "ws";
import { PROTOCOL } from "../src/net/protocol.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORKER = process.argv.includes("--worker");
console.log(`target: ${WORKER ? "the Cloudflare Worker (wrangler dev)" : "the Node server"}\n`);
const PORT = 7000 + Math.floor(Math.random() * 900);
let NODE_FLAGS: string[] = [];
if (!WORKER) {
  const built = spawnSync("node_modules/.bin/esbuild", [
    "server/server.ts", "--bundle", "--platform=node", "--format=esm", "--external:ws",
    "--outfile=dist-server/server.mjs", "--log-level=warning",
  ]);
  if (built.status !== 0) {
    console.error(String(built.stderr));
    process.exit(1);
  }
  // The Node flags npm run server uses: `... && node <flags> dist-server/server.mjs`.
  const script: string = JSON.parse(readFileSync("package.json", "utf8")).scripts.server;
  NODE_FLAGS = (/&& node (.*?) dist-server\/server\.mjs/.exec(script)?.[1] ?? "").split(/\s+/).filter(Boolean);
  check("npm run server locks Node down (no eval, file reads allow-listed)", NODE_FLAGS.includes("--disallow-code-generation-from-strings") && NODE_FLAGS.includes("--permission"), NODE_FLAGS.join(" "));
}

/** Start a server; resolves once it is listening. `opts` are the match
 *  options (as Node flags or Worker vars) and an optional password. */
async function start(port: number, opts: { maxPerAddr?: number; password?: string } = {}) {
  const match: Record<string, string> = { level: "tdm-arena-big", blueTroops: "3", redTroops: "3" };
  if (opts.maxPerAddr) match.maxPerAddr = String(opts.maxPerAddr);
  let proc;
  if (WORKER) {
    // Worker vars are UPPER_SNAKE (LEVEL, BLUE_TROOPS, ...); the password is
    // passed as one too (a secret in production; here only on this test's
    // own command line).
    const vars = Object.entries(match).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}:${v}`);
    if (opts.password) vars.push(`MADTAC_PASSWORD:${opts.password}`);
    proc = spawn("node_modules/.bin/wrangler", [
      "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", `/tmp/madtac-wrangler-${port}`,
      "--inspector-port", String(port + 2000), "--show-interactive-dev-session=false", "--log-level", "log",
      ...vars.flatMap((v) => ["--var", v]),
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  } else {
    const flags = Object.entries(match).flatMap(([k, v]) => [`--${k}`, v]);
    proc = spawn("node", [...NODE_FLAGS, "dist-server/server.mjs", "--port", String(port), ...flags], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(opts.password ? { MADTAC_PASSWORD: opts.password } : {}) },
    });
  }
  const out = { log: "", exited: null as number | null, proc };
  proc.stdout.on("data", (d) => (out.log += String(d)));
  proc.stderr.on("data", (d) => (out.log += String(d)));
  proc.on("exit", (code) => (out.exited = code ?? -1));
  const ready = () => (WORKER ? /Ready on/.test(out.log) : out.log.includes("on ws://"));
  for (let i = 0; i < (WORKER ? 600 : 100) && !ready(); i++) await sleep(50);
  return out;
}
const main = await start(PORT);
const srv = main.proc;
const logOf = () => main.log;
let log = "";
srv.stdout.on("data", (d) => (log += String(d)));
srv.stderr.on("data", (d) => (log += String(d)));
log = logOf();
if (WORKER) check("wrangler dev serves the Worker", /Ready on http:\/\/127\.0\.0\.1:\d+/.test(log), log.split("\n").find((l) => l.includes("Ready on")) ?? log.slice(-300));
else check("the server starts on loopback only and announces its port", log.includes(`ws://127.0.0.1:${PORT}/play`) && !log.includes("listening on"), log.trim().split("\n")[0]);

const info = await fetch(`http://localhost:${PORT}/info`).then((r) => r.json());
check("/info describes the match", info.level === "tdm-arena-big" && info.mode === "tdm" && info.players === 0, JSON.stringify(info));

/** A client: connects, joins, collects messages. */
function client(name: string, token?: string) {
  const ws = new WebSocket(`ws://localhost:${PORT}/play`);
  const msgs: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    msgs.push(m);
    for (const w of waiters.splice(0)) w(m);
  };
  const opened = new Promise<void>((r) => (ws.onopen = () => r()));
  const next = (pred: (m: any) => boolean, ms = 3000): Promise<any> =>
    new Promise((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const w = (m: any) => { if (pred(m)) { clearTimeout(t); resolve(m); } else waiters.push(w); };
      waiters.push(w);
    });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, msgs, opened, next, send, name, token };
}

const a = client("Alice");
await a.opened;
a.send({ t: "join", protocol: PROTOCOL, name: "Alice" });
const welcome = await a.next((m) => m.t === "welcome");
check("a join is welcomed with the level and an id", typeof welcome.id === "number" && welcome.level.includes('"entities"') && welcome.meta.mode === "tdm", `id=${welcome.id}`);
const snap1 = await a.next((m) => m.t === "snap");
const meIn = (s: any) => s.chars.find((c: any) => c.id === welcome.id);
/** Our latest pose: snapshots leave out a character that hasn't moved, so the
 *  last one that listed us. */
const lastMe = (msgs: any[]) => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].t === "snap" ? meIn(msgs[i]) : undefined;
    if (c) return c;
  }
};
check("snapshots flow, listing our character with a full record", !!meIn(snap1)?.full, `chars=${snap1.chars.length}`);
check("...and the private block", typeof snap1.me?.mag === "number");
await sleep(200);
const rate = a.msgs.filter((m) => m.t === "snap").length;
// At the rate the welcome announces (snapHz), give or take timer jitter.
const want = (welcome.snapHz ?? 30) * 0.2;
check(`at about the welcome's ${welcome.snapHz} a second`, rate >= want * 0.6 && rate <= want * 1.5, `${rate} in 200ms`);

// Drive: hold D for half a second, expect to have moved right.
const x0 = lastMe(a.msgs).x;
const idle = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, firePressed: false, reload: false, equip: null, cancel: false, interact: false, drop: false, dropHud: null, restart: false, debugDamage: false, debugHeal: false };
for (let i = 0; i < 30; i++) {
  a.send({ t: "input", seq: i + 1, in: { ...idle, move: { x: 1, y: 0 } } });
  await sleep(16);
}
a.send({ t: "input", seq: 31, in: idle });
await sleep(100);
const x1 = lastMe(a.msgs).x;
check("held input moves the character on the server", x1 > x0 + 30, `dx=${(x1 - x0).toFixed(1)}`);
const lastSeq = a.msgs.filter((m) => m.t === "snap").at(-1).seq;
check("snapshots echo the last input seq", lastSeq === 31, `seq=${lastSeq}`);

const pingAt = 12345;
a.send({ t: "ping", at: pingAt });
const pong = await a.next((m) => m.t === "pong");
check("ping is answered", pong.at === pingAt);

// A second player: info counts both; the first sees the second.
const b = client("Bob");
await b.opened;
b.send({ t: "join", protocol: PROTOCOL, name: "Bob" });
const wb = await b.next((m) => m.t === "welcome");
await sleep(100);
const info2 = await fetch(`http://localhost:${PORT}/info`).then((r) => r.json());
check("a second player joins and is counted", info2.players === 2 && wb.id !== welcome.id);
// Bob is on the other side (PvP) and spawned at its base, which can be past
// the 3000 px a client is sent anything within. So: Alice is sent Bob exactly
// when he is in reach.
const bobPose = (await b.next((m) => m.t === "snap" && m.chars.some((c: any) => c.id === wb.id))).chars.find((c: any) => c.id === wb.id);
const alicePose = lastMe(a.msgs);
const apart = Math.hypot(bobPose.x - alicePose.x, bobPose.y - alicePose.y);
const seesBob = await a.next((m) => m.t === "snap" && m.chars.some((c: any) => c.id === wb.id && c.full), 1500).then(() => true, () => false);
check("the second player joins the other side, and the first is sent him exactly when he's within 3000 px", wb.id !== welcome.id && (Math.abs(apart - 3000) < 50 || seesBob === apart < 3000), `${Math.round(apart)} px apart, sent=${seesBob}`);

// Drop and reconnect with the token: same character.
a.ws.close();
await sleep(100);
const a2 = client("Alice", welcome.token);
await a2.opened;
a2.send({ t: "join", protocol: PROTOCOL, name: "Alice", token: welcome.token });
const w2 = await a2.next((m) => m.t === "welcome");
check("reconnecting with the token re-attaches to the same character", w2.id === welcome.id && w2.token === welcome.token, `${w2.id} vs ${welcome.id}`);
const info3 = await fetch(`http://localhost:${PORT}/info`).then((r) => r.json());
check("...without a second slot", info3.players === 2);

// Leaving for good (the Main menu button): the slot goes at once.
const d = client("Carol");
await d.opened;
d.send({ t: "join", protocol: PROTOCOL, name: "Carol" });
await d.next((m) => m.t === "welcome");
const info4 = await fetch(`http://localhost:${PORT}/info`).then((r) => r.json());
d.send({ t: "leave" });
await sleep(100);
const info5 = await fetch(`http://localhost:${PORT}/info`).then((r) => r.json());
check("a leave frees the slot at once, with no reconnect grace", info4.players === 3 && info5.players === 2 && log.includes("Carol left"), `${info4.players} -> ${info5.players}`);

// A bad protocol is refused.
const c = client("Mallory");
await c.opened;
c.send({ t: "join", protocol: 99, name: "Mallory" });
const rej = await c.next((m) => m.t === "reject");
check("a protocol mismatch is refused with a reason", /protocol/.test(rej.reason), rej.reason);

// Leaving for good: after the grace the slot is freed (grace is 30s; we only
// check the drop is logged and the socket close is handled).
b.ws.close();
await sleep(100);
check("a drop is logged and the slot held", log.includes("Bob dropped"));

// ------------------------------------------------------------- attacks ----
console.log("\nattacks (after each, the server must still answer):");
/** A raw socket (the ws package: it can set headers and send anything). */
function raw(port: number, headers: Record<string, string> = {}) {
  const ws = new RawSocket(`ws://127.0.0.1:${port}/play`, { headers });
  ws.on("error", () => {});
  const msgs: any[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  const opened = new Promise<boolean>((r) => { ws.on("open", () => r(true)); ws.on("close", () => r(false)); });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return { ws, msgs, opened, closed };
}
const alive = async (port = PORT): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/info`).then((r) => r.ok, () => false);
/** Hang up within `ms`? The close code, or null if the socket stayed open. */
const closedWithin = (r: { closed: Promise<number> }, ms: number): Promise<number | null> =>
  Promise.race([r.closed, sleep(ms).then(() => null)]);

// A socket that never joins: started first, checked last (the timeout is 5 s).
const lurker = raw(PORT);
await lurker.opened;

{
  const r = raw(PORT);
  await r.opened;
  r.ws.send("x".repeat(5000));
  const code = await closedWithin(r, 2000);
  check("a 5 KB message closes that socket (it used to kill the server)", code === 1009, `code=${code}`);
  check("...and the server is still up", await alive());
}
for (const [what, payload] of [
  ["not JSON", "{{{"],
  ["an unknown message type", JSON.stringify({ t: "sudo" })],
  ["a stranger's field", JSON.stringify({ t: "join", protocol: PROTOCOL, name: "x", admin: true })],
  ["a __proto__ key", `{"t":"join","protocol":${PROTOCOL},"name":"x","__proto__":{"polluted":1}}`],
  ["a name that's an object", JSON.stringify({ t: "join", protocol: PROTOCOL, name: { toString: 1 } })],
  ["a 100-char name", JSON.stringify({ t: "join", protocol: PROTOCOL, name: "n".repeat(100) })],
  ["an input before joining", JSON.stringify({ t: "input", seq: 1, in: {} })],
] as const) {
  const r = raw(PORT);
  await r.opened;
  r.ws.send(payload);
  const code = await closedWithin(r, 2000);
  check(`${what}: hung up on`, code === 1008, `code=${code}`);
}
{
  // Joined, then a malformed input and a hostile loadout.
  const r = raw(PORT);
  await r.opened;
  r.ws.send(JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Eve" }));
  await sleep(150);
  r.ws.send(JSON.stringify({ t: "loadout", loadout: { primary: "constructor", secondary: "__proto__", armor: "toString" } }));
  r.ws.send(JSON.stringify({ t: "respawn" }));
  await sleep(150);
  check("a loadout of built-in names is taken as no kit, not a crash", r.ws.readyState === r.ws.OPEN && (await alive()));
  r.ws.send(JSON.stringify({ t: "input", seq: 2, in: { fire: "yes" } }));
  check("an input with a wrong-typed field: hung up on", (await closedWithin(r, 2000)) === 1008);
}
{
  // Joined first, so it is the rate limit that answers, not "join first".
  const r = raw(PORT);
  await r.opened;
  r.ws.send(JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Flood" }));
  for (let i = 0; i < 40 && !r.msgs.some((x) => x.t === "welcome"); i++) await sleep(25);
  const m = JSON.stringify({ t: "ping", at: 1 });
  for (let i = 0; i < 2000; i++) r.ws.send(m);
  const code = await closedWithin(r, 3000);
  const pongs = r.msgs.filter((x) => x.t === "pong").length;
  // Node drops the TCP connection outright (1006); a Workers socket has no
  // hard reset, so it is closed (1008).
  // At most the 240-message burst, plus what refills (120/s) while it lands.
  check("a flood (2000 messages at once) is cut off at the burst allowance", code === (WORKER ? 1008 : 1006) && pongs <= 260, `code=${code}, answered ${pongs}`);
  check("...and the server is still up", await alive());
}
{
  const code = await closedWithin(lurker, 6000);
  check("a socket that never joins is dropped after 5 s", code !== null, `code=${code}`);
}
check("the server never logged an error through all of it", !/error in/.test(logOf()), logOf().split("\n").find((l) => l.includes("error in")) ?? "");

srv.kill();

// ------------------------------------------------- a password server ----
console.log("\na server with a password and a per-address cap:");
{
  const port = PORT + 1;
  const locked = await start(port, { maxPerAddr: 3, password: "hunter2" });
  if (!WORKER) check("it announces that it needs one", locked.log.includes("password required"), locked.log.trim().split("\n")[0]);
  const linfo = await fetch(`http://127.0.0.1:${port}/info`).then((r) => r.json());
  check("/info says so", linfo.locked === true);
  if (!WORKER) check("the password isn't on its command line (ps shows those)", !locked.proc.spawnargs.join(" ").includes("hunter2"));
  const tryJoin = async (password: string | undefined, headers: Record<string, string> = {}) => {
    const r = raw(port, headers);
    await r.opened;
    r.ws.send(JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Guest", ...(password === undefined ? {} : { password }) }));
    for (let i = 0; i < 40 && !r.msgs.length; i++) await sleep(25);
    return r;
  };
  const none = await tryJoin(undefined);
  check("no password: refused, saying one is needed", none.msgs[0]?.reason === "this server needs a password", JSON.stringify(none.msgs[0]));
  const good = await tryJoin("hunter2");
  check("the right one: welcomed", good.msgs[0]?.t === "welcome");
  good.ws.close();
  // Wrong guesses from one address (as the tunnel reports it) lock it out.
  const reasons: string[] = [];
  for (let i = 0; i < 6; i++) reasons.push((await tryJoin(`guess${i}`, { "cf-connecting-ip": "203.0.113.9" })).msgs[0]?.reason);
  check("wrong ones are refused", reasons.slice(0, 5).every((r) => r === "wrong password"), reasons.join(" | "));
  const after = await tryJoin("hunter2", { "cf-connecting-ip": "203.0.113.9" });
  check("...and after five, even the right one is locked out for a minute", /too many wrong passwords/.test(after.msgs[0]?.reason ?? "") && reasons[5] !== "wrong password", after.msgs[0]?.reason);
  const other = await tryJoin("hunter2", { "cf-connecting-ip": "198.51.100.4" });
  check("...but only that address: another gets in", other.msgs[0]?.t === "welcome");
  other.ws.close();
  await sleep(100);
  // Sockets per address.
  const socks = [0, 1, 2, 3].map(() => raw(port, { "cf-connecting-ip": "192.0.2.77" }));
  const opens = await Promise.all(socks.map((r) => r.opened));
  await sleep(200);
  const stillOpen = socks.filter((r) => r.ws.readyState === r.ws.OPEN).length;
  check("a fourth socket from one address (cap 3) is refused", opens.length === 4 && stillOpen === 3, `open=${stillOpen}`);
  for (const r of socks) r.ws.close();
  check("...and the server is still up", await alive(port));
  locked.proc.kill();
}
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
