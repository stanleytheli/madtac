/**
 * Verifies the netcode without a socket: a server-side Game with human slots,
 * a ClientMirror encoding what each sees, the JSON round trip, and a
 * NetSession rebuilding the match from those messages. The load-bearing claims:
 *   - a human can be added to a running match and removed again, replacing a bot,
 *   - humans split between the sides (PvP), keep them across a restart, and
 *     each reads the result from their own side,
 *   - a snapshot is a full picture the first time and a diff after: a standing
 *     character, a round's look and a corpse's age aren't re-sent,
 *   - the sight mask culls enemies the viewer can't see, never teammates,
 *   - the mirror shows the same characters at the same places with the same kit,
 *   - the mirror's own player is the character the server said, so hit events
 *     resolve to the right feedback,
 *   - the local player's facing is its own aim while in control,
 *   - inputs off the wire drive the character; presses aren't repeated, and
 *     the single-player debug keys don't pass.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_net.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vn.mjs && node <tmp>/vn.mjs
 */
import { readFileSync } from "node:fs";
import { Game } from "../src/game.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { loadLevel } from "../src/world/level.ts";
import { ClientMirror, CULL_R, POSE_REFRESH, pointInPolygon } from "../src/net/snapshot.ts";
import { MatchHost, type HostSocket } from "../server/host.ts";
import { NetSession } from "../src/net/client.ts";
import { mergeInputs, parseClientMsg, sanitizeInput, serverUrls, PROTOCOL, type ServerMsg, type SnapMsg } from "../src/net/protocol.ts";
import { ARMOR_SPECS, GUN_SPECS as SPECS, SKINS } from "../src/entities/specs.ts";
import { TEAMS } from "../src/entities/team.ts";
import { idleInput } from "../src/engine/command.ts";
import { dist, len, norm, vec, type Vec2 } from "../src/engine/vec.ts";
import { areHostile } from "../src/entities/team.ts";
import { makeWall } from "../src/world/world.ts";
import { Gun } from "../src/entities/gun.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";
import { GunItem } from "../src/entities/item.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
  ok ? passed++ : failed++;
};
function roundTrip<T>(m: T): T { return JSON.parse(JSON.stringify(m)) as T; }

const levelText = readFileSync("src/world/levels/tdm-arena-big.json", "utf8");
const level = loadLevel(levelText);
const meta = { ...level.meta, mode: "tdm" };
const game = new Game(level, GAMEMODES.tdm(meta), { humans: 0 });

console.log("a server game starts with no humans and takes them as they join:");
{
  check("no humans, bots only", game.humans.length === 0 && game.characters.length > 0, `chars=${game.characters.length}`);
  check("...and asking for `player` is an error, not a bot", (() => { try { game.player; return false; } catch { return true; } })());
  const before = game.characters.length;
  const a = game.addHuman("Alice");
  check("a human joins as a blue combatant", a.char.team === "blue" && game.characters.includes(a.char));
  check("...replacing a blue bot, so the headcount holds", game.characters.length === before, `${before} -> ${game.characters.length}`);
  const b = game.addHuman("Bob");
  check("a second human joins the other side, replacing a red bot", b.char.team === "red" && game.humans.length === 2 && game.characters.length === before, `team=${b.char.team}`);
  game.update();
  const hudA = game.gamemode.hud(game, a.char)!;
  const rowsA = hudA.players!.filter((r) => r.isPlayer);
  check("each human's HUD highlights only their own row", rowsA.length === 1 && rowsA[0].name === "Alice", JSON.stringify(rowsA));
  game.removeHuman(b);
  check("a human leaving frees the slot and a bot fills it", game.humans.length === 1 && !game.characters.includes(b.char) && game.characters.length === before, `chars=${game.characters.length}`);
}

console.log("\nPvP: humans split between the sides and keep them:");
{
  const lv = loadLevel(levelText);
  const m = { ...lv.meta, mode: "tdm" };
  const g = new Game(lv, GAMEMODES.tdm(m), { humans: 0 });
  const total = g.characters.length;
  const [p1, p2, p3, p4] = ["P1", "P2", "P3", "P4"].map((n) => g.addHuman(n));
  const teams = [p1, p2, p3, p4].map((h) => h.char.team).join(",");
  check("four joiners alternate blue, red, blue, red", teams === "blue,red,blue,red", teams);
  check("...each replacing a bot of their side, so the headcount holds", g.characters.length === total, `${total} -> ${g.characters.length}`);
  check("...and wearing their side's skin", p2.char.skin !== p1.char.skin && p3.char.skin === p1.char.skin);
  g.removeHuman(p2);
  const p5 = g.addHuman("P5");
  check("a joiner fills the side someone left", p5.char.team === "red", p5.char.team);
  g.reset();
  check("a restart keeps everyone on their side", p1.char.team === "blue" && p3.char.team === "blue" && p4.char.team === "red" && p5.char.team === "red", [p1, p3, p4, p5].map((h) => h.char.team).join(","));
  g.removeHuman(p4);
  g.removeHuman(p5);
  g.reset();
  check("...unless it would leave one side two up: then the latest joiner switches", p1.char.team === "blue" && p3.char.team === "red", `${p1.char.team},${p3.char.team}`);
  // The match decided (blue won: no one has spent a ticket): each human reads
  // the result from their own side.
  (g.gamemode as unknown as { phase: string }).phase = "over";
  const b1 = g.gamemode.hud(g, p1.char)?.banner ?? "";
  const b3 = g.gamemode.hud(g, p3.char)?.banner ?? "";
  const nobody = g.gamemode.hud(g)?.banner ?? "";
  check("the winners read Victory, the losers Defeat", b1.startsWith("Victory") && b3.startsWith("Defeat"), `${JSON.stringify(b1)} / ${JSON.stringify(b3)}`);
  check("...and a HUD for no one names the winning side", nobody.startsWith("Blue wins"), JSON.stringify(nobody));
  const solo = new Game(loadLevel(levelText), GAMEMODES.tdm(m));
  check("single player: the lone human is blue, as before", solo.player.team === "blue", solo.player.team);
}

console.log("\nsnapshots: full first, diffs after, over JSON:");
const alice = game.humans[0];
// A dropped gun beside her, on the despawn clock like a death drop.
const dropped = new GunItem(vec(alice.char.pos.x + 60, alice.char.pos.y), new Gun(GUN_SPECS.M16), vec(0, 0), alice.char.z);
dropped.lifetime = 900;
game.world.items.push(dropped);
const mirrorA = new ClientMirror(game, false);
/** What a client with no sight mask is sent: everything within CULL_R. */
const inRange = <T extends { pos: { x: number; y: number } }>(xs: readonly T[]): T[] => xs.filter((x) => dist(x.pos, alice.char.pos) < CULL_R);
{
  const s1 = roundTrip(mirrorA.encode(game, alice, 0, []));
  check("the first snapshot lists every character in range with a full record", s1.chars.length === inRange(game.characters).length && s1.chars.every((c) => c.full), `n=${s1.chars.length}`);
  check("...and the HUD, feed and death marks", s1.hud !== undefined && s1.feed !== undefined && s1.deaths !== undefined);
  check("...and every item/corpse in range", s1.items.length === inRange(game.world.items).length && s1.bodies.length === inRange(game.bodies).length);
  const me = s1.chars.find((c) => c.id === alice.char.id)!;
  check("the viewer's own record carries their name", me.full!.name === "Alice");
  check("...and the private block their ammo", s1.me.mag === alice.char.gun.mag && s1.me.res === alice.char.gun.reserveMags);
  const s2 = roundTrip(mirrorA.encode(game, alice, 0, []));
  check("nothing changed: the next snapshot repeats no full record", s2.chars.every((c) => !c.full) && s2.hud === undefined && s2.players === undefined && s2.items.length === 0);
  check("...and no character at all: none of them moved", s2.chars.length === 0, `n=${s2.chars.length}`);
  // A kit change shows up as a full record for that character only.
  alice.char.equip("hand");
  const s3 = roundTrip(mirrorA.encode(game, alice, 0, []));
  const fulls = s3.chars.filter((c) => c.full);
  check("a weapon switch re-sends that one character's full record", fulls.length === 1 && fulls[0].id === alice.char.id && fulls[0].full!.slot === "hand", `fulls=${fulls.length}`);
  check("...and only that character", s3.chars.length === 1, `n=${s3.chars.length}`);
  const other = inRange(game.characters).find((c) => c !== alice.char)!;
  other.pos = vec(Math.round(other.pos.x * 10) / 10 + 0.01, other.pos.y);
  mirrorA.encode(game, alice, 0, []);
  other.pos = vec(other.pos.x + 0.02, other.pos.y);
  check("a move that rounds to the same 0.1 px isn't sent", roundTrip(mirrorA.encode(game, alice, 0, [])).chars.length === 0);
  other.pos = vec(other.pos.x + 5, other.pos.y);
  const moved = roundTrip(mirrorA.encode(game, alice, 0, []));
  check("a real move sends that character's pose alone, with no full record", moved.chars.length === 1 && moved.chars[0].id === other.id && !moved.chars[0].full);
  other.hp = 0.04;
  const sliver = roundTrip(mirrorA.encode(game, alice, 0, [])).chars.find((c) => c.id === other.id);
  check("a sliver of health is sent as 0.1, never as dead", sliver?.hp === 0.1, `hp=${sliver?.hp}`);
  other.hp = other.maxHp;
  check("...rounded to 0.1 px, resting fields left out", moved.chars[0].x === Math.round(other.pos.x * 10) / 10 && !("k" in moved.chars[0]) && !("vh" in moved.chars[0]), JSON.stringify(moved.chars[0]));
  let refreshed: SnapMsg | null = null;
  for (let i = 0; i < POSE_REFRESH; i++) {
    const sn = roundTrip(mirrorA.encode(game, alice, 0, []));
    if (sn.chars.length) refreshed = sn;
  }
  check(`every ${POSE_REFRESH} snapshots, everyone in view is re-sent anyway`, refreshed?.chars.length === inRange(game.characters).length, `n=${refreshed?.chars.length}`);

  // Rounds: their look once, then only where they are.
  const shooter = inRange(game.characters).find((c) => c !== alice.char)!;
  game.world.bullets.push({
    id: 990001, pos: vec(shooter.pos.x, shooter.pos.y), prev: vec(shooter.pos.x, shooter.pos.y), vel: vec(30, 0), z: shooter.z, life: 600,
    origin: vec(shooter.pos.x, shooter.pos.y), renderAfter: 20, owner: shooter, damage: 10, tracerWidth: 3, tracerLength: 200,
    tracerColor: "#ffe26b", armorPen: { l1: 1, l2: 1, l3: 1, l4: 1 }, penetration: 0, penUsed: 0, penSkip: 0, gun: null,
  });
  const r1 = roundTrip(mirrorA.encode(game, alice, 0, [])).bullets.find((b) => b.id === 990001);
  const r2 = roundTrip(mirrorA.encode(game, alice, 0, [])).bullets.find((b) => b.id === 990001);
  check("a round's first listing carries its look", r1?.c === "#ffe26b" && r1.w === 3 && r1.ox !== undefined);
  check("...and the next only where it is", !!r2 && r2.c === undefined && r2.w === undefined && r2.ox === undefined, JSON.stringify(r2));
  game.world.bullets = game.world.bullets.filter((b) => b.id !== 990001);
  const r3 = roundTrip(mirrorA.encode(game, alice, 0, []));
  check("a round that landed is simply not listed", !r3.bullets.some((b) => b.id === 990001));

  // Aging alone doesn't put a corpse or a drop back on the wire.
  dropped.age += 10;
  check("an item that only aged isn't re-sent", roundTrip(mirrorA.encode(game, alice, 0, [])).items.length === 0);
  dropped.pos = vec(dropped.pos.x + 3, dropped.pos.y);
  check("...but one that slid is", roundTrip(mirrorA.encode(game, alice, 0, [])).items.some((x) => x.id === dropped.id));
}

console.log("\nthe sight mask culls what the viewer can't see:");
{
  // A tiny private world: the viewer, a teammate behind a wall, an enemy behind
  // the same wall, an enemy in the open.
  const lv = loadLevel(`{ "version": 1, "entities": [] }`);
  lv.world.obstacles.push(makeWall(vec(300, 0), 40, 400, 0));
  lv.meta.visibility = true;
  const g = new Game(lv, GAMEMODES.sandbox(lv.meta), { humans: 1 });
  const viewer = g.humans[0];
  viewer.char.pos = vec(0, 0);
  viewer.char.team = "blue";
  const mate = g.addHuman("Mate");
  mate.char.pos = vec(600, 0);
  mate.char.team = "blue";
  const hiddenEnemy = g.addHuman("Hidden");
  hiddenEnemy.char.pos = vec(600, 20);
  hiddenEnemy.char.team = "red";
  const openEnemy = g.addHuman("Open");
  openEnemy.char.pos = vec(0, 400);
  openEnemy.char.team = "red";
  check("the enemies are hostile to the viewer", areHostile(viewer.char.team, "red"));
  const m = new ClientMirror(g, true);
  const s = roundTrip(m.encode(g, viewer, 0, []));
  const ids = new Set(s.chars.map((c) => c.id));
  check("the viewer sees themself", ids.has(viewer.char.id));
  check("...their teammate behind the wall (drawn through the mask)", ids.has(mate.char.id));
  check("...the enemy in the open", ids.has(openEnemy.char.id));
  check("...but NOT the enemy behind the wall", !ids.has(hiddenEnemy.char.id), `sent=${[...ids]}`);
  // The hidden enemy steps into view, then back: sent, then listed as gone.
  hiddenEnemy.char.pos = vec(0, -400);
  const s2 = roundTrip(m.encode(g, viewer, 0, []));
  check("stepping into view sends them, with a full record", s2.chars.some((c) => c.id === hiddenEnemy.char.id && c.full));
  hiddenEnemy.char.pos = vec(600, 20);
  const s3 = roundTrip(m.encode(g, viewer, 0, []));
  check("stepping back out lists them as gone", s3.gone.includes(hiddenEnemy.char.id) && !s3.chars.some((c) => c.id === hiddenEnemy.char.id));
  check("pointInPolygon: a square", pointInPolygon(vec(1, 1), [vec(0, 0), vec(2, 0), vec(2, 2), vec(0, 2)]) && !pointInPolygon(vec(3, 1), [vec(0, 0), vec(2, 0), vec(2, 2), vec(0, 2)]));
}

console.log("\na NetSession rebuilds the match from the messages:");
{
  const net = new NetSession("localhost:1", "Alice", false);
  let ready = 0;
  net.onReady = () => ready++;
  const welcome: ServerMsg = { t: "welcome", protocol: PROTOCOL, id: alice.char.id, token: "tok", level: levelText, meta, tick: game.tick, snapHz: 30 };
  net.receive(roundTrip(welcome));
  check("the welcome builds the level", ready === 1 && net.world.obstacles.length === game.world.obstacles.length);
  check("...and the local player carries the server's id", net.player.id === alice.char.id);
  const mirror = new ClientMirror(game, false);
  // A clock this test drives (ms), kept in step with the server's ticks:
  // arrivals and frames are stamped with it.
  let clock = game.tick * (1000 / 60);
  const later = (ms: number): void => {
    clock += ms;
    game.tick += Math.round(ms / (1000 / 60));
  };
  net.receive(roundTrip(mirror.encode(game, alice, 0, game.world.events)), clock);
  check("the world waits for render time: on arrival, only our own character", net.characters.length === 1 && net.characters[0] === net.player, `n=${net.characters.length}`);
  later(300);
  net.interpolate(clock); // well past the snapshot
  const expected = inRange(game.characters);
  check("then every character in range is mirrored", net.characters.length === expected.length, `${net.characters.length} vs ${expected.length}`);
  let placed = 0;
  let kit = 0;
  for (const c of expected) {
    const m = net.characters.find((x) => x.id === c.id)!;
    // To the wire's 0.1 px / 0.1 hp (health rounded up).
    if (Math.abs(m.pos.x - c.pos.x) <= 0.051 && Math.abs(m.pos.y - c.pos.y) <= 0.051 && m.z === c.z && m.hp >= c.hp && m.hp - c.hp <= 0.1) placed++;
    if (m.gun.spec === c.gun.spec && m.team === c.team && m.equippedSlot === c.equippedSlot && (m.armor?.spec ?? null) === (c.armor?.spec ?? null)) kit++;
  }
  check("...at the same place, level and health", placed === expected.length, `${placed}/${expected.length}`);
  check("...holding the same gun, on the same team, in the same armor", kit === expected.length, `${kit}/${expected.length}`);
  check("the local player's ammo is the private block's", net.player.gun.mag === alice.char.gun.mag);
  check("the HUD arrived", net.hud()?.name === "Team Deathmatch");
  check("items mirrored", net.world.items.length === inRange(game.world.items).length);
  check("the mirror is the session's player", net.player === net.characters.find((c) => c.id === alice.char.id));
  check("the HUD's scoreboard rows are put back on it", (net.hud()?.players?.length ?? 0) > 0, `rows=${net.hud()?.players?.length}`);

  // Events: a hit (feedback) on the next step; the scenery's when render time
  // reaches the snapshot that carried them, once.
  const bot = expected.find((c) => c !== alice.char && dist(c.pos, alice.char.pos) < CULL_R - 500)!;
  later(33);
  const withEvents = roundTrip(mirror.encode(game, alice, 0, [{ kind: "hit", victim: alice.char.id, attacker: bot.id }, { kind: "decal", near: vec(1, 2), on: game.world.obstacles[0], z: 0, heft: 1 }]));
  check("a decal event names its obstacle by index on the wire", withEvents.events.some((e) => e.kind === "decal" && (e as any).oi === 0));
  net.receive(withEvents, clock);
  net.step(idleInput(), clock);
  const early = net.world.events.map((e) => e.kind);
  check("a hit plays on the next step, the decal not yet (render time hasn't reached it)", early.includes("hit") && !early.includes("decal"), early.join(","));
  later(150); // past the interpolation delay (not so far that it counts as a stale catch-up)
  net.step(idleInput(), clock);
  const late = net.world.events.map((e) => e.kind);
  check("...then the decal, as an obstacle on the client", late.includes("decal") && !late.includes("hit") && (net.world.events.find((e) => e.kind === "decal") as any).on === net.world.obstacles[0], late.join(","));
  later(17);
  net.step(idleInput(), clock);
  check("events play once: the next step has none", net.world.events.length === 0);

  // Our own facing and position: our input, at once, while we're in control.
  const aim = vec(Math.SQRT1_2, Math.SQRT1_2);
  const x0 = net.player.pos.x;
  later(17);
  net.step({ ...idleInput(), aim, move: vec(1, 0) }, clock);
  check("in control, our facing is our aim before the server has heard", net.player.forward.x === aim.x && net.player.forward.y === aim.y, `f=${JSON.stringify(net.player.forward)}`);
  check("...and we've already stepped right", net.player.pos.x > x0, `${x0.toFixed(2)} -> ${net.player.pos.x.toFixed(2)}`);
  // Out of control (dead, the match decided), we're drawn from the snapshots.
  alice.controllable = false;
  alice.char.forward = vec(0, 1);
  later(33);
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])), clock);
  later(300);
  net.interpolate(clock);
  check("out of control, our facing is the server's again", Math.abs(net.player.forward.x) < 0.002 && Math.abs(net.player.forward.y - 1) < 0.002, JSON.stringify(net.player.forward));
  alice.controllable = true;

  // Ages run on here between the snapshots that carry them.
  const it = net.world.items.find((x) => x.id === dropped.id)!;
  // A snapshot to measure from, then one 8 ticks later.
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])), clock);
  later(300);
  net.interpolate(clock);
  const age0 = it.age;
  const t0 = game.tick - 18; // that snapshot's tick (later(300) moved 18 on since)
  game.tick = t0;
  clock = t0 * (1000 / 60);
  later(133);
  const ticks = game.tick - t0;
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])), clock);
  later(300);
  net.interpolate(clock);
  check("an item ages by the server ticks between snapshots", it.age === age0 + ticks, `${age0} -> ${it.age} over ${ticks} ticks`);

}

console.log("\nrounds fly on the right clock:");
{
  // An open level (no walls to stop anything), us and another human. Every
  // snapshot arrives exactly on time, so the delayed clock is just the delay.
  const open = `{ "version": 1, "entities": [] }`;
  const g = new Game(loadLevel(open), GAMEMODES.sandbox(loadLevel(open).meta), { humans: 0 });
  const me = g.addHuman("Me");
  const other = g.addHuman("Other");
  other.char.pos = vec(300, 0);
  const mirror = new ClientMirror(g, false);
  const net = new NetSession("localhost:1", "Me", false);
  net.receive(roundTrip<ServerMsg>({ t: "welcome", protocol: PROTOCOL, id: me.char.id, token: "t", level: open, meta: g.level.meta, tick: g.tick, snapHz: 30 }));
  const at = (tick: number) => tick * (1000 / 60);
  const spawn = (id: number, owner: typeof me.char, color: string) =>
    g.world.bullets.push({
      id, pos: vec(owner.pos.x, owner.pos.y), prev: vec(owner.pos.x, owner.pos.y), vel: vec(30, 0), z: owner.z, life: 600,
      origin: vec(owner.pos.x, owner.pos.y), renderAfter: 20, owner, damage: 10, tracerWidth: 3, tracerLength: 200,
      tracerColor: color, armorPen: { l1: 1, l2: 1, l3: 1, l4: 1 }, penetration: 0, penUsed: 0, penSkip: 0, gun: null,
    });
  g.tick = 100;
  net.receive(roundTrip(mirror.encode(g, me, 0, [])), at(g.tick));
  spawn(990002, other.char, "#abcdef");
  spawn(990003, me.char, "#123456");
  g.tick = 102;
  const rs = roundTrip(mirror.encode(g, me, 0, []));
  check("our own round is flagged as ours on the wire, the other not", rs.bullets.find((b) => b.id === 990003)?.o === 1 && rs.bullets.find((b) => b.id === 990002)?.o === undefined);
  net.receive(rs, at(102));
  net.interpolate(at(102));
  check("ours is drawn on arrival; theirs waits for render time", net.world.bullets.some((b) => b.id === 990003) && !net.world.bullets.some((b) => b.id === 990002));
  const t = at(102) + net.delay + 20;
  const r = net.renderTick(t);
  net.interpolate(t);
  const theirs = net.world.bullets.find((b) => b.id === 990002);
  const want = 300 + 30 * (r - 102);
  check("...then theirs, with its look, where render time says it has flown", !!theirs && theirs.tracerColor === "#abcdef" && Math.abs(theirs.pos.x - want) < 0.2,
    theirs ? `${theirs.pos.x.toFixed(1)} vs ${want.toFixed(1)}` : "missing");
  const ours = net.world.bullets.find((b) => b.id === 990003)!;
  check("...and ours is ahead of it on the present clock", ours.pos.x - me.char.pos.x > theirs!.pos.x - 300, `ours flew ${(ours.pos.x - me.char.pos.x).toFixed(0)} px, theirs ${(theirs!.pos.x - 300).toFixed(0)}`);
}

console.log("\neveryone else is drawn smoothly, however unevenly snapshots arrive:");
{
  // A server match with two humans: us, standing, and Other, walking right at
  // a steady speed. Snapshots reach us 2-5 ticks late, at random (in order,
  // as over TCP). Drawn at 60 frames a second, Other must glide: the same
  // step every frame, no stalls, no jumps.
  // An open level: Other spawns beside us and has nothing to walk into.
  const host = new MatchHost({ levelName: "open", levelText: `{ "version": 1, "entities": [] }`, mode: "sandbox", manual: true });
  let tick = 0;
  let lastAt = 0;
  const toClient: { at: number; text: string }[] = [];
  const sock = (deliver: boolean): HostSocket => ({
    open: true,
    send: (t) => {
      if (!deliver) return;
      lastAt = Math.max(lastAt, tick + 2 + Math.floor(Math.random() * 4));
      toClient.push({ at: lastAt, text: t });
    },
    close: () => {},
    terminate: () => {},
  });
  const meConn = host.connect(sock(true), "198.51.100.1")!;
  const otherConn = host.connect(sock(false), "198.51.100.2")!;
  host.message(meConn, JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Me" }));
  host.message(otherConn, JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Other" }));
  const net = new NetSession("localhost:1", "Me", false);
  net.outbox = () => {}; // we stand still; the server needn't hear us
  const ms = (t: number) => t * (1000 / 60);
  const xs: number[] = [];
  let otherId = 0;
  for (let i = 0; i < 400; i++) {
    tick++;
    host.message(otherConn, JSON.stringify({ t: "input", seq: tick, in: { ...idleInput(), move: { x: 1, y: 0 } } }));
    host.advance(1);
    while (toClient.length && toClient[0].at <= tick) net.receive(JSON.parse(toClient.shift()!.text), ms(tick));
    net.step(idleInput(), ms(tick));
    net.interpolate(ms(tick));
    otherId ||= host.match!.humans.find((h) => h.name === "Other")?.char.id ?? 0;
    const o = net.characters.find((c) => c.id === otherId);
    if (o && i >= 150) xs.push(o.pos.x);
  }
  const steps = xs.slice(1).map((x, i) => x - xs[i]);
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const worst = Math.max(...steps.map((d) => Math.abs(d - median)));
  check("Other moves the same distance every frame (within 0.2 px: no stall, no jump)", steps.length > 200 && median > 3 && worst < 0.2, `median ${median.toFixed(3)} px/frame, worst deviation ${worst.toFixed(3)}`);
  check("...drawn a little behind the server: the delay covers the jitter", net.delay > 1000 / 30 && net.delay < 150, `delay ${net.delay.toFixed(0)} ms`);
}

console.log("\nour own player answers at once, and agrees with the server:");
{
  // The real server host on a manual clock, us 3 ticks away each way (a 100 ms
  // round trip), no bots: nothing but our own inputs moves us, so prediction
  // should agree with the server exactly.
  const text = readFileSync("src/world/levels/tdm-arena-big.json", "utf8");
  const host = new MatchHost({ levelName: "tdm-arena-big", levelText: text, mode: "tdm", overrides: { blueTroops: 0, redTroops: 0 }, manual: true });
  const LAT = 3;
  let tick = 0;
  const toClient: { at: number; text: string }[] = [];
  const toServer: { at: number; text: string }[] = [];
  const sock: HostSocket = { open: true, send: (t) => toClient.push({ at: tick + LAT, text: t }), close: () => {}, terminate: () => {} };
  const conn = host.connect(sock, "198.51.100.1")!;
  const net = new NetSession("localhost:1", "Me", false);
  net.outbox = (m) => toServer.push({ at: tick + LAT, text: JSON.stringify(m) });
  host.message(conn, JSON.stringify({ t: "join", protocol: PROTOCOL, name: "Me" }));
  const ms = (t: number) => t * (1000 / 60);
  const smoothNow = () => len((net as unknown as { smooth: { x: number; y: number } }).smooth);
  const run = (n: number, input: (t: number) => ReturnType<typeof idleInput>, each?: () => void) => {
    for (let i = 0; i < n; i++) {
      tick++;
      while (toServer.length && toServer[0].at <= tick) host.message(conn, toServer.shift()!.text);
      host.advance(1);
      while (toClient.length && toClient[0].at <= tick) net.receive(JSON.parse(toClient.shift()!.text), ms(tick));
      net.step(input(tick), ms(tick));
      net.interpolate(ms(tick));
      each?.();
    }
  };
  run(30, () => idleInput());
  const server = () => host.match!.humans[0].char;
  check("joined, in control, predicting", net.controllable && net.player.id === server().id);

  const before = { client: net.player.pos.x, server: server().pos.x };
  run(1, () => ({ ...idleInput(), move: vec(1, 0) }));
  check("a move shows on the very tick it's pressed", net.player.pos.x > before.client, `${before.client.toFixed(2)} -> ${net.player.pos.x.toFixed(2)}`);
  check("...while the server hasn't heard yet", server().pos.x === before.server);

  // A walk around (into walls too) and to a stop: no correction, ever.
  let worst = 0;
  const pattern = (t: number) => {
    const phase = Math.floor(t / 25) % 6;
    const moves = [vec(1, 0), vec(1, -1), vec(0, -1), vec(-1, 1), vec(-1, 0), vec(0, 1)];
    return { ...idleInput(), move: moves[phase], aim: norm(vec(Math.cos(t / 10), Math.sin(t / 10))) };
  };
  run(300, pattern, () => (worst = Math.max(worst, smoothNow())));
  run(40, () => idleInput(), () => (worst = Math.max(worst, smoothNow())));
  check("prediction and the server never disagree by more than 0.05 px", worst < 0.05, `largest correction ${worst.toFixed(4)} px`);
  const gap = dist(net.player.pos, server().pos);
  check("...and at rest they stand in the same place", gap < 0.05, `${gap.toFixed(4)} px apart`);

  // The server shoves us 25 px (as another body would): the correction is
  // melted in over several ticks, not jumped.
  const pos: Vec2[] = [];
  run(20, () => idleInput());
  server().pos = vec(server().pos.x + 25, server().pos.y);
  run(60, () => idleInput(), () => pos.push(net.player.pos));
  const jumps = pos.slice(1).map((p, i) => dist(p, pos[i]));
  check("a shove from the server is eased in: no frame moves more than 4 px", Math.max(...jumps) < 4, `largest frame step ${Math.max(...jumps).toFixed(2)} px`);
  check("...and it ends where the server has us", dist(net.player.pos, server().pos) < 0.05, `${dist(net.player.pos, server().pos).toFixed(3)} px apart`);

  // Firing: give us a loaded rifle on the server, and pull the trigger.
  const sc = server();
  sc.slots.primary = new Gun(GUN_SPECS.M16);
  sc.equip("primary");
  run(90, () => idleInput()); // the kit arrives; the draw finishes
  const g = net.player.gun;
  const magBefore = g.mag;
  const serverMag = sc.gun.mag;
  run(1, () => ({ ...idleInput(), fire: true, firePressed: true }));
  const shotSounds = net.world.events.filter((e) => e.kind === "sound" && e.by === net.player.id).length;
  check("a shot is heard and seen on the tick the trigger is pulled", g.spec === GUN_SPECS.M16 && shotSounds > 0 && g.flashTicks > 0 && g.mag === magBefore - 1,
    `sounds ${shotSounds}, flash ${g.flashTicks}, mag ${magBefore} -> ${g.mag}`);
  let echoes = 0;
  let magBounced = false;
  let ownRound = false;
  run(2 * LAT + 30, () => idleInput(), () => {
    echoes += net.world.events.filter((e) => e.kind === "sound" && e.by === net.player.id).length;
    if (g.mag !== magBefore - 1) magBounced = true;
    if (net.world.bullets.length) ownRound = true;
  });
  check("...the server fired it too", sc.gun.mag === serverMag - 1, `${serverMag} -> ${sc.gun.mag}`);
  check("...its echo of our shot isn't played a second time", echoes === 0, `echoes ${echoes}`);
  check("...and the ammo count never jumps back while the server catches up", !magBounced);
  check("our own round from the server is drawn", ownRound);
}

console.log("\nthe level's own items and vehicles are the server's to say:");
{
  const text = readFileSync("src/world/levels/tdm-arena.json", "utf8");
  check("(the level ships items)", loadLevel(text).world.items.length > 0);
  const g = new Game(loadLevel(text), GAMEMODES.tdm({ ...loadLevel(text).meta, mode: "tdm" }), { humans: 0 });
  const me = g.addHuman("Viewer");
  const net = new NetSession("localhost:1", "Viewer", false);
  net.receive(roundTrip<ServerMsg>({ t: "welcome", protocol: PROTOCOL, id: me.char.id, token: "t", level: text, meta: g.level.meta, tick: g.tick, snapHz: 30 }));
  check("the welcome builds the map with none of the level's items on it", net.world.items.length === 0, `items=${net.world.items.length}`);
  net.receive(roundTrip(new ClientMirror(g, false).encode(g, me, 0, [])));
  net.flush();
  const near = g.world.items.filter((x) => dist(x.pos, me.char.pos) < CULL_R).length;
  check("...so after a snapshot there is exactly one of each", net.world.items.length === near, `${net.world.items.length} vs ${near}`);
}

console.log("\nrespawning over the wire keeps the same player object:");
{
  // main.ts keeps the session's player from the welcome and draws it (the
  // camera, the HUD) forever after. A respawn takes our character out of the
  // snapshots and back: it must come back as that same object, not a new one
  // the screen never sees, which left the camera on the corpse.
  const lv = loadLevel(levelText);
  const g = new Game(lv, GAMEMODES.tdm({ ...lv.meta, mode: "tdm" }), { humans: 0 });
  const me = g.addHuman("Me");
  const mirror = new ClientMirror(g, false);
  const net = new NetSession("localhost:1", "Me", false);
  let held: typeof net.player | null = null;
  net.onReady = () => (held = net.player);
  net.receive(roundTrip<ServerMsg>({ t: "welcome", protocol: PROTOCOL, id: me.char.id, token: "t", level: levelText, meta: g.level.meta, tick: g.tick, snapHz: 30 }));
  const step = (n: number) => {
    for (let i = 0; i < n; i++) {
      g.update();
      if (i % 2) net.receive(roundTrip(mirror.encode(g, me, 0, g.world.events)));
    }
  };
  step(10);
  me.char.hp = 0;
  step(30);
  check("dead: our character leaves the drawn roster and reads as dead", !net.characters.includes(held!) && held!.hp === 0 && net.player === held, `hp=${held!.hp}`);
  let back = false;
  for (let i = 0; i < 3000 && !back; i++) {
    step(2);
    back = g.gamemode.requestRespawn!(g, me.char);
  }
  step(10);
  check("respawned: the session's player is still the object the screen holds", back && net.player === held);
  check("...back in the roster, alive, at the server's spawn point", net.characters.includes(held!) && held!.hp > 0 && dist(held!.pos, me.char.pos) < 1, `${held!.pos.x.toFixed(0)},${held!.pos.y.toFixed(0)} vs ${me.char.pos.x.toFixed(0)},${me.char.pos.y.toFixed(0)}`);
}

console.log("\nserver addresses:");
{
  const a = serverUrls("example.com:7777", false);
  check("host:port on an http page: ws, and /info over http", a.ws === "ws://example.com:7777/play" && a.info === "http://example.com:7777/info", JSON.stringify(a));
  const b = serverUrls("game.example.com", true);
  check("a bare host on an https page: wss on 443", b.ws === "wss://game.example.com/play" && b.info === "https://game.example.com/info", JSON.stringify(b));
  const c = serverUrls("wss://x.trycloudflare.com/play", true);
  const d = serverUrls("https://abc.trycloudflare.com/", true);
  check("the https link a tunnel prints works as pasted", d.ws === "wss://abc.trycloudflare.com/play" && d.info === "https://abc.trycloudflare.com/info", JSON.stringify(d));
  check("a full wss URL is kept, /info beside it", c.ws === "wss://x.trycloudflare.com/play" && c.info === "https://x.trycloudflare.com/info", JSON.stringify(c));
}

console.log("\ninputs off the wire drive the character:");
{
  const raw = { move: { x: 1, y: 0 }, aim: { x: 3, y: 4 }, fire: false, firePressed: true, reload: "yes", equip: "primary", cancel: 0, restart: true, junk: 1 };
  const inp = sanitizeInput(raw);
  check("sanitizeInput bounds and normalizes", inp.move.x === 1 && Math.abs(Math.hypot(inp.aim.x, inp.aim.y) - 1) < 1e-9 && inp.firePressed && !inp.reload && inp.equip === "primary" && !inp.cancel && inp.restart);
  check("...and garbage becomes idle", sanitizeInput(null).aim.y === -1 && sanitizeInput("x").move.x === 0);
  const cheat = sanitizeInput({ debugDamage: true, debugHeal: true });
  check("the single-player debug keys (hurt / heal yourself) never pass", !cheat.debugDamage && !cheat.debugHeal);
  const a = { ...idleInput(), interact: true, fire: true };
  const b = { ...idleInput(), drop: true, fire: false };
  const merged = mergeInputs(a, b);
  check("mergeInputs keeps both presses and the later held state", merged.interact && merged.drop && !merged.fire);

  const x0 = alice.char.pos.x;
  alice.input = { ...idleInput(), move: vec(1, 0) };
  for (let i = 0; i < 30; i++) game.update();
  check("a held move carries across ticks without being re-sent", alice.char.pos.x > x0 + 50, `dx=${(alice.char.pos.x - x0).toFixed(1)}`);
  // A known gun (the roll may have dealt no primary) and a live body (thirty
  // ticks of walking into a TDM match can get you shot).
  alice.char.hp = alice.char.maxHp;
  alice.char.slots.primary = new Gun(GUN_SPECS.M16);
  alice.char.equip("primary");
  while (alice.char.gun.drawing) alice.char.gun.tick();
  alice.char.gun.mag = 0;
  alice.input = { ...idleInput(), reload: true };
  game.update();
  alice.input = idleInput();
  check("a reload request lands", alice.char.gun.reloading);
  alice.input = { ...idleInput(), cancel: true };
  game.update();
  check("a press is consumed after one tick", !alice.input.cancel && !alice.char.gun.reloading);
}

console.log("\nhostile input is refused before it reaches the game:");
{
  const ok = (m: unknown) => parseClientMsg(JSON.parse(JSON.stringify(m))) !== null;
  check("what the client really sends parses: join, input (every field), loadout, ping, the rest",
    ok({ t: "join", protocol: PROTOCOL, name: "Alice", token: "ab12", password: "pw" }) && ok({ t: "join", protocol: PROTOCOL, name: "" }) &&
    ok({ t: "input", seq: 3, in: idleInput() }) && ok({ t: "input", seq: 4, in: { ...idleInput(), equip: "primary", dropHud: "armor" } }) &&
    ok({ t: "loadout", loadout: { primary: "M16", armor: "ARMOR_L2" } }) && ok({ t: "loadout", loadout: {} }) &&
    ok({ t: "ping", at: 1234.5 }) && ok({ t: "random" }) && ok({ t: "respawn" }) && ok({ t: "leave" }));
  const bad: [string, string][] = [
    ["not an object", `[1,2]`],
    ["no type", `{"name":"x"}`],
    ["an unknown type", `{"t":"admin"}`],
    ["an extra field", `{"t":"respawn","x":1}`],
    ["a __proto__ key", `{"t":"leave","__proto__":{"polluted":true}}`],
    ["a non-numeric protocol", `{"t":"join","protocol":"2","name":"x"}`],
    ["an over-long name", `{"t":"join","protocol":2,"name":"${"n".repeat(65)}"}`],
    ["an over-long password", `{"t":"join","protocol":2,"name":"x","password":"${"p".repeat(129)}"}`],
    ["input with a stranger's field", `{"t":"input","seq":1,"in":{"teleport":true}}`],
    ["input with a string flag", `{"t":"input","seq":1,"in":{"fire":"yes"}}`],
    ["input with a vector that isn't one", `{"t":"input","seq":1,"in":{"aim":{"x":"1","y":0}}}`],
    ["input with no seq", `{"t":"input","in":{}}`],
    ["a loadout that's a string", `{"t":"loadout","loadout":"M16"}`],
    ["a loadout with an object slot", `{"t":"loadout","loadout":{"primary":{"name":"M16"}}}`],
    ["a ping at Infinity", `{"t":"ping","at":1e999}`],
  ];
  const leaked = bad.filter(([, j]) => parseClientMsg(JSON.parse(j)) !== null).map(([w]) => w);
  check(`${bad.length} malformed messages are all refused`, leaked.length === 0, leaked.join(", "));
  check("...and nothing polluted Object.prototype on the way", ({} as Record<string, unknown>).polluted === undefined);

  check("the lookup tables have only their own names: \"constructor\", \"__proto__\", \"toString\" aren't weapons, armor, skins or teams",
    ["constructor", "__proto__", "toString"].every((k) => !(k in SPECS) && SPECS[k] === undefined && !(k in ARMOR_SPECS) && SKINS[k] === undefined && TEAMS[k] === undefined && !areHostile(k, "blue")));
  // The crash a hostile client could cause: a kit of built-in names, then a respawn.
  const lv = loadLevel(levelText);
  const g = new Game(lv, GAMEMODES.tdm({ ...lv.meta, mode: "tdm" }), { humans: 0 });
  const h = g.addHuman("Mallory");
  let threw = "";
  try {
    g.gamemode.setPlayerLoadout!(h.char, { primary: "constructor", secondary: "__proto__", armor: "toString" });
    h.char.hp = 0;
    let back = false;
    for (let i = 0; i < 3000 && !back; i++) {
      g.update();
      back = g.gamemode.requestRespawn!(g, h.char);
    }
    for (let i = 0; i < 60; i++) g.update();
    check("a kit of built-in names respawns with empty slots", back && !h.char.slots.primary && !h.char.slots.secondary && !h.char.armor);
  } catch (e) {
    threw = (e as Error).message;
  }
  check("...instead of crashing the match (it used to)", threw === "", threw);
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
