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
import { NetSession } from "../src/net/client.ts";
import { mergeInputs, parseClientMsg, sanitizeInput, serverUrls, PROTOCOL, type ServerMsg, type SnapMsg } from "../src/net/protocol.ts";
import { ARMOR_SPECS, GUN_SPECS as SPECS, SKINS } from "../src/entities/specs.ts";
import { TEAMS } from "../src/entities/team.ts";
import { idleInput } from "../src/engine/command.ts";
import { dist, vec } from "../src/engine/vec.ts";
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
  const snap = roundTrip(mirror.encode(game, alice, 0, game.world.events));
  net.receive(snap);
  net.interpolate(performance.now() + 1000); // long past the snapshot: at the target
  const expected = inRange(game.characters);
  check("every character in range is mirrored", net.characters.length === expected.length, `${net.characters.length} vs ${expected.length}`);
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

  // Interpolation: a moved character reads between the two snapshots.
  // A bot well inside range, so its 100 px step can't carry it out of the snapshot.
  const bot = expected.find((c) => c !== alice.char && dist(c.pos, alice.char.pos) < CULL_R - 500)!;
  const x0 = bot.pos.x;
  bot.pos = vec(x0 + 100, bot.pos.y);
  const t0 = performance.now();
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])));
  const m = net.characters.find((x) => x.id === bot.id)!;
  net.interpolate(t0);
  const early = m.pos.x;
  net.interpolate(t0 + 1000 / 30 / 2);
  const mid = m.pos.x;
  net.interpolate(t0 + 1000);
  const late = m.pos.x;
  check("a moved character interpolates from where it was to where it is", Math.abs(early - x0) < 1 && Math.abs(mid - (x0 + 50)) < 2 && Math.abs(late - (x0 + 100)) <= 0.051, `${early.toFixed(1)} ${mid.toFixed(1)} ${late.toFixed(1)}`);

  // Events reach the effects pipeline once, on the next step.
  const withEvents = roundTrip(mirror.encode(game, alice, 0, [{ kind: "hit", victim: alice.char.id, attacker: bot.id }, { kind: "decal", near: vec(1, 2), on: game.world.obstacles[0], z: 0, heft: 1 }]));
  check("a decal event names its obstacle by index on the wire", withEvents.events.some((e) => e.kind === "decal" && (e as any).oi === 0));
  net.receive(withEvents);
  net.step(idleInput());
  const kinds = net.world.events.map((e) => e.kind);
  check("...and comes back as an obstacle on the client", kinds.includes("hit") && kinds.includes("decal") && (net.world.events.find((e) => e.kind === "decal") as any).on === net.world.obstacles[0], kinds.join(","));
  net.step(idleInput());
  check("events play once: the next step has none", net.world.events.length === 0);

  // The HUD arrives in two parts (rows on their own) and reads as one.
  check("the HUD's scoreboard rows are put back on it", (net.hud()?.players?.length ?? 0) > 0, `rows=${net.hud()?.players?.length}`);

  // Our own facing: the aim we send, at once, while we're in control.
  const aim = vec(Math.SQRT1_2, Math.SQRT1_2);
  net.step({ ...idleInput(), aim });
  net.interpolate(performance.now());
  check("in control, our facing is our aim before the server has heard", net.controllable && net.player.forward.x === aim.x && net.player.forward.y === aim.y, `ctrl=${net.controllable} f=${JSON.stringify(net.player.forward)}`);
  net.controllable = false;
  net.interpolate(performance.now() + 1000);
  const srv = alice.char.forward;
  check("...and out of control (dead, match over), the server's facing", Math.abs(net.player.forward.x - srv.x) < 0.002 && Math.abs(net.player.forward.y - srv.y) < 0.002);

  // Ages run on here between the snapshots that carry them.
  const it = net.world.items.find((x) => x.id === dropped.id)!;
  const age0 = it.age;
  game.tick += 8;
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])));
  check("an item ages by the server ticks between snapshots", it.age === age0 + 8, `${age0} -> ${it.age}`);

  // A round the local geometry stopped comes back when the server lists it
  // again, its look from the cache (the listing carries only where it is).
  const shooter = expected.find((c) => c !== alice.char && dist(c.pos, alice.char.pos) < CULL_R - 500)!;
  game.world.bullets.push({
    id: 990002, pos: vec(shooter.pos.x, shooter.pos.y), prev: vec(shooter.pos.x, shooter.pos.y), vel: vec(30, 0), z: shooter.z, life: 600,
    origin: vec(shooter.pos.x, shooter.pos.y), renderAfter: 20, owner: shooter, damage: 10, tracerWidth: 3, tracerLength: 200,
    tracerColor: "#abcdef", armorPen: { l1: 1, l2: 1, l3: 1, l4: 1 }, penetration: 0, penUsed: 0, penSkip: 0, gun: null,
  });
  net.receive(roundTrip(mirror.encode(game, alice, 0, [])));
  check("a round is mirrored with its look", net.world.bullets.some((b) => b.id === 990002 && b.tracerColor === "#abcdef"));
  net.world.bullets = net.world.bullets.filter((b) => b.id !== 990002); // as if it hit a wall here
  (net as unknown as { bulletById: Map<number, unknown> }).bulletById.delete(990002);
  const again = roundTrip(mirror.encode(game, alice, 0, []));
  check("...the server's next listing of it is position only", again.bullets.find((b) => b.id === 990002)?.c === undefined);
  net.receive(again);
  check("...and the client puts it back looking the same", net.world.bullets.some((b) => b.id === 990002 && b.tracerColor === "#abcdef" && b.tracerWidth === 3));
  game.world.bullets = game.world.bullets.filter((b) => b.id !== 990002);
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
  const near = g.world.items.filter((x) => dist(x.pos, me.char.pos) < CULL_R).length;
  check("...so after a snapshot there is exactly one of each", net.world.items.length === near, `${net.world.items.length} vs ${near}`);
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
