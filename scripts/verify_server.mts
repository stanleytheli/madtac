/**
 * End to end: builds and starts the real dedicated server (server/server.ts)
 * on a spare port, connects with Node's WebSocket, joins, and checks the
 * things a player would notice — a welcome with the level, snapshots flowing,
 * the character moving when told to, /info answering, and a dropped socket
 * reconnecting to the same character with its token.
 *
 * Run: node scripts/verify_server.mts   (no bundling: it spawns esbuild itself)
 */
import { spawn, spawnSync } from "node:child_process";
import { PROTOCOL } from "../src/net/protocol.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 7000 + Math.floor(Math.random() * 900);
const built = spawnSync("node_modules/.bin/esbuild", [
  "server/server.ts", "--bundle", "--platform=node", "--format=esm", "--external:ws",
  "--outfile=dist-server/server.mjs", "--log-level=warning",
]);
if (built.status !== 0) {
  console.error(String(built.stderr));
  process.exit(1);
}
const srv = spawn("node", ["dist-server/server.mjs", "--level", "tdm-arena-big", "--port", String(PORT), "--blueTroops", "3", "--redTroops", "3"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
srv.stdout.on("data", (d) => (log += String(d)));
srv.stderr.on("data", (d) => (log += String(d)));
for (let i = 0; i < 100 && !log.includes("on ws://"); i++) await sleep(50);
check("the server starts and announces its port", log.includes(`ws://localhost:${PORT}/play`), log.trim().split("\n")[0]);

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
check("at about 30 a second", rate >= 4 && rate <= 9, `${rate} in 200ms`);

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
const seesBob = await a.next((m) => m.t === "snap" && m.chars.some((c: any) => c.id === wb.id && c.full)).then(() => true, () => false);
check("the first player's snapshots include the second (no sight mask on this level)", seesBob);

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

srv.kill();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
