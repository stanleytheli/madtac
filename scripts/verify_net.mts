/**
 * Verifies the netcode without a socket: a server-side Game with human slots,
 * a ClientMirror encoding what each sees, the JSON round trip, and a
 * NetSession rebuilding the match from those messages. The load-bearing claims:
 *   - a human can be added to a running match and removed again, replacing a bot,
 *   - a snapshot is a full picture the first time and a diff after,
 *   - the sight mask culls enemies the viewer can't see, never teammates,
 *   - the mirror shows the same characters at the same places with the same kit,
 *   - the mirror's own player is the character the server said, so hit events
 *     resolve to the right feedback,
 *   - inputs off the wire drive the character; presses aren't repeated.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_net.mts --bundle --platform=node
 *   --format=esm --outfile=<tmp>/vn.mjs && node <tmp>/vn.mjs
 */
import { readFileSync } from "node:fs";
import { Game } from "../src/game.ts";
import { GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { loadLevel } from "../src/world/level.ts";
import { ClientMirror, CULL_R, pointInPolygon } from "../src/net/snapshot.ts";
import { NetSession } from "../src/net/client.ts";
import { mergeInputs, sanitizeInput, PROTOCOL, type ServerMsg, type SnapMsg } from "../src/net/protocol.ts";
import { idleInput } from "../src/engine/command.ts";
import { dist, vec } from "../src/engine/vec.ts";
import { areHostile } from "../src/entities/team.ts";
import { makeWall } from "../src/world/world.ts";
import { Gun } from "../src/entities/gun.ts";
import { GUN_SPECS } from "../src/entities/specs.ts";

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
  check("a second human likewise", game.humans.length === 2 && game.characters.length === before);
  game.update();
  const hudA = game.gamemode.hud(game, a.char)!;
  const rowsA = hudA.players!.filter((r) => r.isPlayer);
  check("each human's HUD highlights only their own row", rowsA.length === 1 && rowsA[0].name === "Alice", JSON.stringify(rowsA));
  game.removeHuman(b);
  check("a human leaving frees the slot and a bot fills it", game.humans.length === 1 && !game.characters.includes(b.char) && game.characters.length === before, `chars=${game.characters.length}`);
}

console.log("\nsnapshots: full first, diffs after, over JSON:");
const alice = game.humans[0];
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
  check("nothing changed: the next snapshot repeats no full record", s2.chars.every((c) => !c.full) && s2.hud === undefined && s2.items.length === 0);
  check("...but still every position", s2.chars.length === s1.chars.length);
  // A kit change shows up as a full record for that character only.
  alice.char.equip("hand");
  const s3 = roundTrip(mirrorA.encode(game, alice, 0, []));
  const fulls = s3.chars.filter((c) => c.full);
  check("a weapon switch re-sends that one character's full record", fulls.length === 1 && fulls[0].id === alice.char.id && fulls[0].full!.slot === "hand", `fulls=${fulls.length}`);
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
    if (Math.abs(m.pos.x - c.pos.x) < 1e-6 && Math.abs(m.pos.y - c.pos.y) < 1e-6 && m.z === c.z && m.hp === c.hp) placed++;
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
  check("a moved character interpolates from where it was to where it is", Math.abs(early - x0) < 1 && Math.abs(mid - (x0 + 50)) < 2 && Math.abs(late - (x0 + 100)) < 1e-6, `${early.toFixed(1)} ${mid.toFixed(1)} ${late.toFixed(1)}`);

  // Events reach the effects pipeline once, on the next step.
  const withEvents = roundTrip(mirror.encode(game, alice, 0, [{ kind: "hit", victim: alice.char.id, attacker: bot.id }, { kind: "decal", near: vec(1, 2), on: game.world.obstacles[0], z: 0, heft: 1 }]));
  check("a decal event names its obstacle by index on the wire", withEvents.events.some((e) => e.kind === "decal" && (e as any).oi === 0));
  net.receive(withEvents);
  net.step(idleInput());
  const kinds = net.world.events.map((e) => e.kind);
  check("...and comes back as an obstacle on the client", kinds.includes("hit") && kinds.includes("decal") && (net.world.events.find((e) => e.kind === "decal") as any).on === net.world.obstacles[0], kinds.join(","));
  net.step(idleInput());
  check("events play once: the next step has none", net.world.events.length === 0);
}

console.log("\ninputs off the wire drive the character:");
{
  const raw = { move: { x: 1, y: 0 }, aim: { x: 3, y: 4 }, fire: false, firePressed: true, reload: "yes", equip: "primary", cancel: 0, restart: true, junk: 1 };
  const inp = sanitizeInput(raw);
  check("sanitizeInput bounds and normalizes", inp.move.x === 1 && Math.abs(Math.hypot(inp.aim.x, inp.aim.y) - 1) < 1e-9 && inp.firePressed && !inp.reload && inp.equip === "primary" && !inp.cancel && inp.restart);
  check("...and garbage becomes idle", sanitizeInput(null).aim.y === -1 && sanitizeInput("x").move.x === 0);
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

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
