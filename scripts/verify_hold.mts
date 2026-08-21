/**
 * Verifies the TacOracle HOLD posture's geometry, headless, on real levels:
 *   - ENTRY: the chosen entry point is a node we can actually see from where we
 *     stand, and it lies on the enemy's route to us.
 *   - COVER: the covered point is genuinely hidden from the entry point.
 *   - PREDECESSOR: the node the peek slides back toward is more exposed than the
 *     cover. This is the assumption the whole sidestep rests on — it holds
 *     because the search settles nodes in distance order, so anything reached
 *     before the covered node was rejected for being visible.
 *   - PEEK: the peek spot's CENTRE can see the entry point (the centre is the eye
 *     every sight/fire check rays from), while still being partial cover.
 *   - THREAT: the enemy a hold digs in against is chosen by nav route, never by
 *     straight line — on a multi-storey map those differ wildly.
 *   - DOMINATION: a hold on an un-reinforced point never picks a spot outside
 *     the capture radius.
 *   - Integration: a full Game of bots runs without throwing, and holding bots
 *     neither freeze off-map nor jitter.
 *
 * Run: node_modules/.bin/esbuild scripts/verify_hold.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/vh.mjs && node <tmp>/vh.mjs
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { DEFAULT_MODE, GAMEMODES } from "../src/gamemodes/gamemode.ts";
import { Game } from "../src/game.ts";
import { NavGraph } from "../src/world/nav.ts";
import { ObstacleGrid } from "../src/engine/collision.ts";
import { losClear, shotClear, type World } from "../src/world/world.ts";
import { TacOracle } from "../src/ai/tacoracle.ts";
import { DominationOracle } from "../src/ai/domoracle.ts";
import { Robot, type AiContext, type ObjectivePoint } from "../src/ai/robot.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { add, dist, norm, scale, sub, vec, type Vec2 } from "../src/engine/vec.ts";

/** Slop allowed on top of the cover<->peek slide: body separation shoves and the
 *  arrival epsilon both move a bot a little without it having gone anywhere. */
const BODY_SLOP = 40;

/** Sub-pixel float noise at the exact BODY_SLOP boundary isn't a behaviour;
 *  anything a bot could actually be seen doing is far larger than this. */
const STRAY_EPS = 1;

/** HOLD_PEEK_STEP in tacoracle.ts — the granularity the peek is placed on. */
const HOLD_STEP = 8;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? `   ${detail}` : ""}`);
}

/** Deterministic RNG so a failure is reproducible. */
let seed = 987654321;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function loadWorld(name: string): { world: World; nav: NavGraph } {
  const loaded = loadLevel(readFileSync(`src/world/levels/${name}.json`, "utf8"));
  const world = loaded.world;
  world.grid = new ObstacleGrid(world.obstacles);
  return { world, nav: new NavGraph(world) };
}

// ---------------------------------------------------------------- geometry --
/** Force a bot at `botPos` to plan a hold against an enemy at `foePos`, and
 *  check every invariant the design depends on. Returns whether a plan was made
 *  (many random spots legitimately have no cover in range). */
function checkPlan(
  world: World,
  nav: NavGraph,
  botPos: Vec2,
  foePos: Vec2,
  z: number,
  tally: { planned: number; noPlan: number; predSeen: number; predBlind: number; peeks: number; overshoot: number; offLeg: number },
): void {
  const bot = new TacOracle(vec(botPos.x, botPos.y), { team: "player", z });
  const foe = new Robot(vec(foePos.x, foePos.y), { team: "enemy", z });
  const ai: AiContext = { world, characters: [bot, foe], nav, tick: 0 };

  const any = bot as unknown as {
    planHold(ai: AiContext, threat: Robot): boolean;
    holdEntry: Vec2 | null;
    holdCover: Vec2 | null;
    holdPeek: Vec2 | null;
    holdPath: Vec2[];
  };
  if (!any.planHold(ai, foe)) {
    tally.noPlan += 1;
    return;
  }
  tally.planned += 1;

  const entry = any.holdEntry!;
  const cover = any.holdCover!;
  const peek = any.holdPeek!;

  // ENTRY is somewhere the bot can put a ROUND from where the plan was made —
  // which since wallbang is not the same as somewhere it can see: a weapon with a
  // penetration budget will happily hold an angle through a thin partition,
  // because that is a lane its bullets really do cross (see shootingLaneClear).
  const budget: number = any.wallbangBudget ?? 0;
  const reaches = (from: Vec2, to: Vec2): boolean =>
    budget > 0 ? shotClear(world, from, to, z, budget) : losClear(world, from, to, z);
  if (!reaches(botPos, entry)) {
    check("entry point is a lane the anchor can shoot down", false,
      `bot=${fmt(botPos)} entry=${fmt(entry)} budget=${budget}`);
  }
  // COVER is out of SIGHT of the entry point — geometric on purpose. Cover is
  // cover: a spot is hidden if nobody can see it, whatever a rifle might punch
  // through (the deliberate asymmetry, see Obstacle.thicknessMul callers).
  if (losClear(world, cover, entry, z)) {
    check("covered point cannot see the entry point", false,
      `cover=${fmt(cover)} entry=${fmt(entry)}`);
  }
  // PREDECESSOR (what the peek slides toward) must SEE the entry point —
  // otherwise sliding that way never opens the sight line. It holds because the
  // search settles in distance order, so everything reached before the covered
  // node was rejected for being visible from the entry.
  const path = any.holdPath;
  const pred = path.length >= 2 ? path[path.length - 2] : path.length === 1 ? botPos : null;
  if (pred) {
    if (reaches(pred, entry)) tally.predSeen += 1;
    else tally.predBlind += 1;
  }
  // PEEK must be able to COVER the entry point — same reading as the anchor.
  if (!reaches(peek, entry)) {
    check("peek spot covers the entry point", false,
      `peek=${fmt(peek)} entry=${fmt(entry)} budget=${budget}`);
  }
  tally.peeks += 1;
  // The walk must END at the peek, never at the cover — otherwise the bot walks
  // all the way in and visibly backtracks out to the spot it actually wants.
  if (path.length > 0 && dist(path[path.length - 1], peek) > 1e-6) tally.overshoot += 1;
  // ...and the peek must sit on the final leg, between the approach node and the
  // cover, so heading straight for it can't stray off the route.
  const legFrom = path.length >= 2 ? path[path.length - 2] : botPos;
  if (dist(legFrom, peek) + dist(peek, cover) > dist(legFrom, cover) + 2 * HOLD_STEP) {
    tally.offLeg += 1;
  }
}

const fmt = (v: Vec2): string => `(${v.x.toFixed(0)},${v.y.toFixed(0)})`;

function geometrySuite(level: string): void {
  console.log(`\n--- geometry: ${level} ---`);
  const { world, nav } = loadWorld(level);
  const nodes = nav.nodes;
  check("level has nav nodes", nodes.length > 0, `nodes=${nodes.length}`);
  if (nodes.length === 0) return;

  const tally = { planned: 0, noPlan: 0, predSeen: 0, predBlind: 0, peeks: 0, overshoot: 0, offLeg: 0 };
  const TRIALS = 300;
  for (let i = 0; i < TRIALS; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)];
    const b = nodes[Math.floor(rnd() * nodes.length)];
    if (a.z !== b.z || a === b) continue;
    checkPlan(world, nav, a.pos, b.pos, a.z, tally);
  }
  console.log(`      plans=${tally.planned} no-plan=${tally.noPlan}`);
  check("HOLD finds cover on a real level more often than not", tally.planned > tally.noPlan,
    `planned=${tally.planned} vs none=${tally.noPlan}`);
  check("the peek-toward node always covers the entry point",
    tally.predBlind === 0, `sees=${tally.predSeen} blind=${tally.predBlind}`);
  check("every committed hold can watch its entry point", tally.peeks === tally.planned,
    `peeks=${tally.peeks} plans=${tally.planned}`);
  check("the walk ends at the peek, with no trip out to cover and back",
    tally.overshoot === 0, `overshoot=${tally.overshoot}/${tally.planned}`);
  check("the peek lies on the final approach leg", tally.offLeg === 0,
    `off-leg=${tally.offLeg}/${tally.planned}`);
}

// ------------------------------------------------------------- domination ---
function dominationSuite(level: string): void {
  console.log(`\n--- domination point constraint: ${level} ---`);
  const { world, nav } = loadWorld(level);
  // Search the level for a point/enemy pairing that actually yields an on-point
  // hold, so the containment assertion isn't vacuous. Radius is generous (a real
  // dom ring) and the enemy sits a long way off.
  const RADIUS = 320;
  let exercised = 0;
  let escaped = 0;
  for (const centre of nav.nodes) {
    if (centre.z !== 0) continue;
    const objs: ObjectivePoint[] = [
      { pos: centre.pos, z: 0, radius: RADIUS, owner: "gray", progress: 0 },
    ];
    const bot = new DominationOracle(vec(centre.pos.x, centre.pos.y), { team: "player", z: 0 });
    const foe = nav.nodes.find((n) => n.z === 0 && dist(n.pos, centre.pos) > 900);
    if (!foe) continue;
    const enemy = new Robot(vec(foe.pos.x, foe.pos.y), { team: "enemy", z: 0 });
    const ai: AiContext = { world, characters: [bot, enemy], nav, tick: 0, objectives: objs };
    const any = bot as unknown as {
      planHold(ai: AiContext, threat: Robot): boolean;
      holdCover: Vec2 | null;
      holdPeek: Vec2 | null;
    };
    if (!any.planHold(ai, enemy)) continue;
    exercised += 1;
    const out = (p: Vec2): boolean => dist(p, centre.pos) > RADIUS;
    if (out(any.holdCover!) || out(any.holdPeek!)) escaped += 1;
  }
  check("on-point holds were actually exercised", exercised > 0, `cases=${exercised}`);
  check("cover and peek never leave an un-reinforced point", escaped === 0,
    `cases=${exercised} escaped=${escaped}`);

  // Entry rule: ours, uncontested, nobody in sight.
  const bot = new DominationOracle(vec(20, 20), { team: "player", z: 0 });
  const farFoe = new Robot(vec(2400, 2400), { team: "enemy", z: 0 });
  const onPointFoe = new Robot(vec(60, 60), { team: "enemy", z: 0 });
  const any = bot as unknown as { wantsHold(ai: AiContext, target: null): boolean };
  const ctx = (objs: ObjectivePoint[], foes: Robot[]): AiContext => ({
    world, characters: [bot, ...foes], nav, tick: 0, objectives: objs,
  });
  const ring = (owner: string, progress: number): ObjectivePoint[] => [
    { pos: vec(0, 0), z: 0, radius: 160, owner, progress },
  ];

  check("holds a point that is already ours",
    any.wantsHold(ctx(ring("player", 1), [farFoe]), null));
  check("holds a neutral point it is still capturing",
    any.wantsHold(ctx(ring("gray", 0), [farFoe]), null));
  check("holds an enemy-held point it is standing on",
    any.wantsHold(ctx(ring("enemy", 2), [farFoe]), null));
  check("does NOT hold our own point while an enemy is on it",
    !any.wantsHold(ctx(ring("player", 2), [onPointFoe]), null));
  // Just outside the ring but inside CONTEST_PAD (4*30=120) still counts.
  const edgeFoe = new Robot(vec(0, 240), { team: "enemy", z: 0 });
  check("an enemy just past the ring edge still contests it",
    !any.wantsHold(ctx(ring("player", 2), [edgeFoe]), null));

  // Off the point entirely: no hold, whoever owns it.
  const far = new DominationOracle(vec(4000, 4000), { team: "player", z: 0 });
  const farAny = far as unknown as { wantsHold(ai: AiContext, target: null): boolean };
  check("does not hold when off the point", !farAny.wantsHold(
    { world, characters: [far, farFoe], nav, tick: 0, objectives: ring("gray", 0) }, null));

  // Fully ours + reinforced: free to take real cover anywhere.
  const aiOwned: AiContext = ctx(ring("player", 2), [farFoe]);
  const ai: AiContext = ctx(ring("player", 1), [farFoe]);
  const okAny = bot as unknown as { holdSpotOk(ai: AiContext, p: Vec2, z: number): boolean };
  check("reinforced point releases the on-point cover constraint",
    okAny.holdSpotOk(aiOwned, vec(1200, 1200), 0));
  check("un-reinforced point still refuses cover outside the ring",
    !okAny.holdSpotOk(ai, vec(1200, 1200), 0));

  // HOLD_MAX vigil: a fully-ours, quiet point is held for ~8s then released so
  // the bot goes to work elsewhere. Called directly, enemyVisDist sits at its
  // Infinity default (no scan run), so "enemies far" holds every tick and the
  // clock is what ends it.
  const timed = new DominationOracle(vec(20, 20), { team: "player", z: 0 });
  const timedAny = timed as unknown as { wantsHold(ai: AiContext, target: null): boolean };
  const ownedCtx = (b: DominationOracle): AiContext => ({
    world, characters: [b, farFoe], nav, tick: 0, objectives: ring("player", 2),
  });
  let held = 0;
  while (held < 1200 && timedAny.wantsHold(ownedCtx(timed), null)) held++;
  // ~8s == 480 ticks; allow a tick of slack around the boundary.
  check("a won, quiet point is released after ~8s", held >= 479 && held <= 481,
    `held ${held} ticks (~${(held / 60).toFixed(1)}s) before release`);
  check("and stays released while still on the ring",
    !timedAny.wantsHold(ownedCtx(timed), null));

  // Leaving the ring rearms a fresh vigil: off-point resets, back on-point holds.
  timed.pos = vec(4000, 4000);
  check("off the ring clears the vigil", !timedAny.wantsHold(ownedCtx(timed), null));
  timed.pos = vec(20, 20);
  let heldAgain = 0;
  while (heldAgain < 1200 && timedAny.wantsHold(ownedCtx(timed), null)) heldAgain++;
  check("returning to the point rearms a full vigil", heldAgain >= 479 && heldAgain <= 481,
    `held ${heldAgain} ticks on the second visit`);

  // A nearby enemy (enemyVisDist inside the safe distance) suspends the clock —
  // the point is worth defending, so it holds indefinitely. Simulate by forcing
  // enemyVisDist below the threshold on a fresh bot.
  const defended = new DominationOracle(vec(20, 20), { team: "player", z: 0 });
  (defended as unknown as { enemyVisDist: number }).enemyVisDist = 200;
  const defAny = defended as unknown as { wantsHold(ai: AiContext, target: null): boolean };
  let defHeld = 0;
  for (let i = 0; i < 1200; i++) if (defAny.wantsHold(ownedCtx(defended), null)) defHeld++;
  check("a threat near a won point suspends the vigil (holds indefinitely)",
    defHeld === 1200, `held ${defHeld}/1200 ticks`);
}

// ------------------------------------------------------------------ threat --
/** Who a hold digs in against must be measured over the GRAPH, not in a straight
 *  line: on a multi-storey map the straight-line nearest enemy is routinely one
 *  standing directly overhead who'd have to cross the map to reach a staircase,
 *  and the whole plan is derived from that pick. */
function threatSuite(level: string): void {
  console.log(`\n--- hold threat pick: ${level} ---`);
  const { world, nav } = loadWorld(level);
  const zs = new Set(nav.nodes.map((n) => n.z));
  check("level is multi-storey (exercises the cross-z case)", zs.size > 1, `levels=${[...zs]}`);

  /** True nav-route distance from `from` (on `fz`) to a body at `to` (on `tz`). */
  const routeCost = (from: Vec2, fz: number, to: Vec2, tz: number): number => {
    const curr = nav.nearestWalkable(world, from, fz);
    const goal = nav.nearestInSight(world, to, tz);
    if (curr < 0 || goal < 0) return Infinity;
    const step = nav.route(curr, goal);
    if (!step) return Infinity;
    return dist(from, nav.nodes[curr].pos) + step.dist + dist(nav.nodes[goal].pos, to);
  };

  // Build the trap: a bot on one level, a decoy that is NEAR in a straight line
  // but on another level, and a real threat FURTHER in a straight line but on
  // the bot's own level. Crucially, only count the case once the decoy is
  // VERIFIED to be the longer walk — a node one floor up can sit right beside a
  // staircase, in which case preferring it is correct, not a bug.
  let built = 0;
  let pickedDecoy = 0;
  let skippedNotATrap = 0;
  for (const home of nav.nodes) {
    if (built >= 25) break;
    const decoy = nav.nodes.find((n) => n.z !== home.z && dist(n.pos, home.pos) < 260);
    if (!decoy) continue;
    const real = nav.nodes.find(
      (n) => n.z === home.z && n !== home &&
        dist(n.pos, home.pos) > dist(decoy.pos, home.pos) + 200 &&
        dist(n.pos, home.pos) < 900,
    );
    if (!real) continue;
    const decoyWalk = routeCost(home.pos, home.z, decoy.pos, decoy.z);
    const realWalk = routeCost(home.pos, home.z, real.pos, real.z);
    if (!(decoyWalk > realWalk + 200)) {
      skippedNotATrap += 1;
      continue; // the overhead enemy really is closer by foot — picking it is right
    }
    built += 1;
    const bot = new TacOracle(vec(home.pos.x, home.pos.y), { team: "player", z: home.z });
    const decoyFoe = new Robot(vec(decoy.pos.x, decoy.pos.y), { team: "enemy", z: decoy.z });
    const realFoe = new Robot(vec(real.pos.x, real.pos.y), { team: "enemy", z: real.z });
    const ai: AiContext = { world, characters: [bot, decoyFoe, realFoe], nav, tick: 0 };
    const picked = (bot as unknown as {
      holdThreat(ai: AiContext): Robot | null;
    }).holdThreat(ai);
    if (picked === decoyFoe) pickedDecoy += 1;
  }
  check("verified trap cases were constructed", built > 0,
    `traps=${built} rejected-as-not-traps=${skippedNotATrap}`);
  check("never digs in against a nearer-LOOKING enemy that is a longer walk",
    pickedDecoy === 0, `traps=${built} picked-the-overhead-decoy=${pickedDecoy}`);
}

// ----------------------------------------------------------------- refresh --
/** The planted refresh: a settled bot must pick up a threat that has moved to a
 *  different approach, and must NOT re-plan while it is still walking (that's
 *  the feedback loop the freeze exists to prevent). */
function refreshSuite(level: string): void {
  console.log(`\n--- planted refresh: ${level} ---`);
  const { world, nav } = loadWorld(level);

  type Held = {
    holdEntry: Vec2 | null;
    holdEntryNode: number;
    holdCover: Vec2 | null;
    holdPeek: Vec2 | null;
    holdPath: Vec2[];
    holdReplanIn: number;
    mode: string;
    holdMove(ai: AiContext, threat: Robot | null): void;
    planHold(ai: AiContext, threat: Robot): boolean;
  };

  // Find a start/threat pair that yields a plan, then a second threat position
  // whose approach enters from a different node.
  let checkedMoved = 0;
  let missedMove = 0;
  let unbuildable = 0;
  let replannedWhileWalking = 0;
  let walkSamples = 0;

  const pick3 = (): [Vec2, Vec2, Vec2] | null => {
    const a = nav.nodes[Math.floor(rnd() * nav.nodes.length)];
    const b = nav.nodes[Math.floor(rnd() * nav.nodes.length)];
    const c = nav.nodes[Math.floor(rnd() * nav.nodes.length)];
    if (a.z !== 0 || b.z !== 0 || c.z !== 0 || a === b || b === c || a === c) return null;
    return [a.pos, b.pos, c.pos];
  };

  // (a) Still walking: the refresh must never fire, even with the timer forced
  //     due every tick and the threat relocating under it.
  for (let t = 0; t < 400; t++) {
    const p = pick3();
    if (!p) continue;
    const [start, foePos, newFoePos] = p;
    const bot = new TacOracle(vec(start.x, start.y), { team: "player", z: 0 });
    const foe = new Robot(vec(foePos.x, foePos.y), { team: "enemy", z: 0 });
    const h = bot as unknown as Held;
    const ai: AiContext = { world, characters: [bot, foe], nav, tick: 0 };
    if (!h.planHold(ai, foe) || h.holdPath.length === 0) continue;
    h.mode = "hold";
    const beforeEntry = h.holdEntryNode;
    const beforeCover = h.holdCover!;
    for (let i = 0; i < 40 && h.holdPath.length > 0; i++) {
      h.holdReplanIn = 1; // due now
      foe.pos = vec(newFoePos.x, newFoePos.y); // and they've gone another way
      h.holdMove(ai, foe);
      walkSamples += 1;
      if (h.holdEntryNode !== beforeEntry || dist(h.holdCover!, beforeCover) > 1e-6) {
        replannedWhileWalking += 1;
        break;
      }
    }
  }

  // (b) Planted (walked out, standing on the peek): a threat that now approaches
  //     via a different entry node must be picked up when the timer fires.
  for (let t = 0; t < 600 && checkedMoved < 20; t++) {
    const p = pick3();
    if (!p) continue;
    const [start, foePos, newFoePos] = p;
    const bot = new TacOracle(vec(start.x, start.y), { team: "player", z: 0 });
    const foe = new Robot(vec(foePos.x, foePos.y), { team: "enemy", z: 0 });
    const h = bot as unknown as Held;
    const ai: AiContext = { world, characters: [bot, foe], nav, tick: 0 };
    if (!h.planHold(ai, foe)) continue;

    // Arrive: stand on the committed peek spot with the route walked out.
    bot.pos = vec(h.holdPeek!.x, h.holdPeek!.y);
    h.holdPath = [];
    const settledEntry = h.holdEntryNode;

    foe.pos = vec(newFoePos.x, newFoePos.y);
    const freshEntry = (bot as unknown as {
      findEntry(ai: AiContext, threat: Robot): { node: number; pos: Vec2 } | null;
    }).findEntry(ai, foe);
    if (freshEntry === null || freshEntry.node === settledEntry) continue; // same angle: nothing to update
    checkedMoved += 1;
    h.mode = "hold";
    h.holdReplanIn = 1;
    h.holdMove(ai, foe);
    if (h.holdEntryNode !== settledEntry) continue; // updated as intended

    // It kept the old plan. That is only correct if no plan could be built
    // around the new entry at all (a rebuild that fails must not throw away
    // working cover). Probe with a fresh bot at the same spot to tell the two
    // apart — a rebuildable entry that was ignored is a real miss.
    const probe = new TacOracle(vec(bot.pos.x, bot.pos.y), { team: "player", z: 0 });
    const probeAi: AiContext = { world, characters: [probe, foe], nav, tick: 0 };
    const rebuildable = (probe as unknown as {
      planFromEntry(ai: AiContext, entry: { node: number; pos: Vec2 }): boolean;
    }).planFromEntry(probeAi, freshEntry);
    if (rebuildable) missedMove += 1;
    else unbuildable += 1;
  }

  check("a planted hold picks up a threat that changed approach",
    checkedMoved > 0 && missedMove === 0,
    `cases=${checkedMoved} missed=${missedMove} kept-old-plan-because-unbuildable=${unbuildable}`);
  check("a hold never re-plans while still walking to cover",
    replannedWhileWalking === 0, `samples=${walkSamples} replans=${replannedWhileWalking}`);
}

// ----------------------------------------------------------- oscillation ---
/** RUN and HOLD move in opposite directions, so any condition that flips between
 *  them produces a visible back-and-forth: run in, dig in, walk back to cover,
 *  run in again. Bounded chain length is the property that matters — isolated
 *  hold->run->hold pairs are ordinary posture changes, a long alternating chain
 *  is the bug. */
function oscillationSuite(level: string): void {
  console.log(`\n--- run/hold oscillation: ${level} ---`);
  let worstChain = 0;
  let flips = 0;
  for (let run = 0; run < 4; run++) {
    const loaded = loadLevel(readFileSync(`src/world/levels/${level}.json`, "utf8"));
    const mode = loaded.meta?.mode ?? DEFAULT_MODE;
    const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
    const last = new Map<TacOracle, string>();
    const chain = new Map<TacOracle, number>();
    for (let i = 0; i < 3000; i++) {
      game.update();
      for (const c of game.characters) {
        if (!(c instanceof TacOracle) || c.hp <= 0) continue;
        const m = (c as unknown as { mode: string }).mode;
        const prev = last.get(c);
        if (prev && prev !== m) {
          if ((prev === "run" && m === "hold") || (prev === "hold" && m === "run")) {
            flips += 1;
            const n = (chain.get(c) ?? 0) + 1;
            chain.set(c, n);
            worstChain = Math.max(worstChain, n);
          } else if (m !== "hold" && m !== "run") {
            chain.set(c, 0); // a real fight broke the pattern
          }
        }
        last.set(c, m);
      }
    }
  }
  check("no run<->hold ping-pong", worstChain <= 3,
    `flips=${flips} longest alternating chain=${worstChain}`);
}

// ------------------------------------------------------------- spot claims --
/** Two bots must never commit to the same cover — including while one is still
 *  walking to it, which a body-position check alone can't see. */
function claimSuite(level: string): void {
  console.log(`\n--- cover spot claims: ${level} ---`);
  let clashes = 0;
  let samples = 0;
  let holders = 0;
  for (let run = 0; run < 3; run++) {
    const loaded = loadLevel(readFileSync(`src/world/levels/${level}.json`, "utf8"));
    const mode = loaded.meta?.mode ?? DEFAULT_MODE;
    const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
    for (let i = 0; i < 3000; i++) {
      game.update();
      // Everyone with a live hold plan, grouped by team (only teammates contend).
      const held = game.characters.filter(
        (c) => c instanceof TacOracle && c.hp > 0 &&
          (c as unknown as { mode: string }).mode === "hold" &&
          (c as unknown as { holdCover: Vec2 | null }).holdCover !== null,
      ) as TacOracle[];
      if (held.length > 1) samples += 1;
      holders = Math.max(holders, held.length);
      for (let a = 0; a < held.length; a++) {
        for (let b = a + 1; b < held.length; b++) {
          const A = held[a] as unknown as { holdCover: Vec2; holdPeek: Vec2 | null };
          const B = held[b] as unknown as { holdCover: Vec2; holdPeek: Vec2 | null };
          if (held[a].team !== held[b].team || held[a].z !== held[b].z) continue;
          if (dist(A.holdCover, B.holdCover) < 2 * BODY_RADIUS) clashes += 1;
        }
      }
    }
  }
  check("teammates never claim the same cover spot", clashes === 0,
    `ticks with 2+ holders=${samples} most simultaneous holders=${holders} clashes=${clashes}`);
}

// ------------------------------------------------------------ friendly lane --
/** The angle a hold watches has to be one it could SHOOT down, so a teammate
 *  standing in the line disqualifies it exactly as a wall does. (Cover is the
 *  opposite question and must stay pure geometry — a teammate is never cover.) */
function laneSuite(level: string): void {
  console.log(`\n--- teammates in the hold's lane: ${level} ---`);
  const { world, nav } = loadWorld(level);
  type H = {
    findEntry(ai: AiContext, t: Robot): { node: number; pos: Vec2 } | null;
    planHold(ai: AiContext, t: Robot): boolean;
    holdCover: Vec2 | null;
  };
  let cases = 0;
  let refused = 0;
  let stillBlocked = 0;
  let coverStillHidden = 0;
  for (let t = 0; t < 500 && cases < 60; t++) {
    const a = nav.nodes[Math.floor(rnd() * nav.nodes.length)];
    const b = nav.nodes[Math.floor(rnd() * nav.nodes.length)];
    if (a.z !== 0 || b.z !== 0 || a === b) continue;
    const bot = new TacOracle(vec(a.pos.x, a.pos.y), { team: "player", z: 0 });
    const foe = new Robot(vec(b.pos.x, b.pos.y), { team: "enemy", z: 0 });
    const h = bot as unknown as H;
    const solo: AiContext = { world, characters: [bot, foe], nav, tick: 0 };
    const baseEntry = h.findEntry(solo, foe);
    if (baseEntry === null) continue;

    // Park a teammate squarely in the middle of the lane it just chose.
    const entryPos = baseEntry.pos;
    const mid = add(a.pos, scale(norm(sub(entryPos, a.pos)), dist(a.pos, entryPos) / 2));
    const mate = new Robot(vec(mid.x, mid.y), { team: "player", z: 0 });
    const crowded: AiContext = { world, characters: [bot, foe, mate], nav, tick: 0 };
    cases += 1;

    const picked = h.findEntry(crowded, foe);
    if (picked === null) {
      refused += 1;
      continue;
    }
    if (inLane(a.pos, picked.pos, mate.pos)) stillBlocked += 1;
    // Cover must still be judged on geometry alone — a body doesn't hide anyone.
    if (h.planHold(crowded, foe) && h.holdCover) {
      if (losClear(world, h.holdCover, picked.pos, 0)) coverStillHidden += 1;
    }
  }
  check("teammate-blocked lane cases were built", cases > 0, `cases=${cases}`);
  check("never holds an angle a teammate is standing in", stillBlocked === 0,
    `cases=${cases} blocked=${stillBlocked} (refused to plan: ${refused})`);
  check("a teammate in the lane doesn't cost the hold entirely", refused < cases / 2,
    `refused=${refused}/${cases}`);
  check("cover is still judged on geometry, not bodies", coverStillHidden === 0,
    `cover visible from entry in ${coverStillHidden} cases`);
}

/** Is `p` within a body-ish margin of the segment from->to, and between the ends? */
function inLane(from: Vec2, to: Vec2, p: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return false;
  const t = ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2;
  if (t <= 0 || t >= 1) return false;
  const ex = p.x - (from.x + dx * t);
  const ey = p.y - (from.y + dy * t);
  return Math.hypot(ex, ey) < 2 * BODY_RADIUS;
}

// ----------------------------------------------------------------- ambush ---
/** RUN holsters the weapon, so the contact metrics must be measured with the gun
 *  the bot would DRAW, not the fists in its hands — otherwise its own
 *  distance-until-contact stays huge all the way in and it re-arms on seeing
 *  someone rather than on a fight becoming imminent. The symptom is bots caught
 *  holstered. */
function ambushSuite(level: string): void {
  console.log(`\n--- ambush while holstered: ${level} ---`);
  let holsteredHits = 0;
  let hits = 0;
  for (let run = 0; run < 4; run++) {
    const loaded = loadLevel(readFileSync(`src/world/levels/${level}.json`, "utf8"));
    const mode = loaded.meta?.mode ?? DEFAULT_MODE;
    const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));
    const hp = new Map<TacOracle, number>();
    for (let i = 0; i < 3000; i++) {
      game.update();
      for (const c of game.characters) {
        if (!(c instanceof TacOracle)) continue;
        const was = hp.get(c);
        if (was !== undefined && c.hp < was && c.hp > 0) {
          hits += 1;
          if ((c as unknown as { mode: string }).mode === "run") holsteredHits += 1;
        }
        hp.set(c, c.hp);
      }
    }
  }
  const pct = (100 * holsteredHits) / Math.max(1, hits);
  // ~5% with the bug, ~1% without; 3% separates them with room for variance.
  check("runners are rarely caught holstered", pct < 3,
    `${holsteredHits}/${hits} hits taken while sprinting = ${pct.toFixed(1)}%`);
}

// ------------------------------------------------------------ integration ---
function integrationSuite(level: string): void {
  console.log(`\n--- integration: ${level} ---`);
  const text = readFileSync(`src/world/levels/${level}.json`, "utf8");
  const loaded = loadLevel(text);
  const mode = loaded.meta?.mode ?? DEFAULT_MODE;
  const game = new Game(loaded, GAMEMODES[mode]({ ...loaded.meta, mode }));

  let threw: unknown = null;
  let heldTicks = 0;
  // "Stays there" precisely: once a holding bot has actually REACHED its spot,
  // it should never again be further from its covered point than the
  // cover<->peek slide — the only movement the posture licenses. (An empty
  // holdPath is not "arrived": when the covered node is the bot's own nearest
  // node the path is empty from the start, with the walk still to do.) The
  // arrival latch resets whenever the plan itself changes.
  const arrivedAt = new Map<Robot, { cover: Vec2; peek: Vec2 }>();
  let settledSamples = 0;
  let restless = 0;
  let worstExcess = 0;
  try {
    for (let i = 0; i < 2400; i++) {
      game.update();
      for (const c of game.characters) {
        if (!(c instanceof TacOracle) || c.hp <= 0) continue;
        const m = (c as unknown as { mode: string }).mode;
        if (!Number.isFinite(c.pos.x) || !Number.isFinite(c.pos.y)) {
          throw new Error(`non-finite position on a ${m} bot at tick ${i}`);
        }
        if (m !== "hold") {
          arrivedAt.delete(c);
          continue;
        }
        heldTicks += 1;
        const h = c as unknown as {
          holdCover: Vec2 | null;
          holdPeek: Vec2 | null;
          holdPath: Vec2[];
        };
        if (!h.holdCover || !h.holdPeek) {
          arrivedAt.delete(c);
          continue;
        }
        // Route outstanding = walking, not settled. A refresh can hand back a
        // fresh walk-back path even when cover and peek are unchanged (parked on
        // the peek, the bot's nearest node isn't the cover node), so this has to
        // be checked as well as the plan endpoints.
        if (h.holdPath.length > 0) {
          arrivedAt.delete(c);
          continue;
        }
        // A new plan restarts the walk — and "new" means EITHER end moved, since
        // a refresh can keep the covered node while relocating the peek.
        const latched = arrivedAt.get(c);
        if (latched && (dist(latched.cover, h.holdCover) > 1 || dist(latched.peek, h.holdPeek) > 1)) {
          arrivedAt.delete(c);
          continue;
        }
        const licensed = dist(h.holdCover, h.holdPeek) + BODY_SLOP;
        if (!latched) {
          if (dist(c.pos, h.holdCover) <= licensed) {
            arrivedAt.set(c, { cover: h.holdCover, peek: h.holdPeek });
          }
          continue; // still walking there
        }
        settledSamples += 1;
        const excess = dist(c.pos, h.holdCover) - licensed;
        if (excess > worstExcess) worstExcess = excess;
        if (excess > STRAY_EPS) restless += 1;
      }
    }
  } catch (e) {
    threw = e;
  }
  check("2400 ticks of live bots without throwing", threw === null, threw ? String(threw) : "");
  check("bots entered HOLD during the match", heldTicks > 0, `hold ticks=${heldTicks}`);
  check("a settled hold never leaves its spot", restless === 0,
    `samples=${settledSamples} strayed=${restless} worst excess=${worstExcess.toFixed(2)}px`);
}

// ------------------------------------------------------------ give-up timer --
/** A base TacOracle that holds without ever seeing an enemy must give up after a
 *  bit and go hunt, rather than freezing on a dead angle forever. */
/** Soldiers no longer dig in on a distance band ("an enemy is vaguely near, so
 *  hold for a few seconds" — the random hold we replaced). They hold ONLY via the
 *  principled reflex watch. This guards that removal: the old give-up-timer and
 *  walk/retreat-settle suites tested exactly the behaviour that's now gone. */
function soldierHoldSuite(level: string): void {
  console.log(`\n--- soldiers hold only via the reflex (no distance-band dig-in): ${level} ---`);
  const { world, nav } = loadWorld(level);
  type T = {
    mode: string;
    visDist: number;
    enemyVisDist: number;
    holdTicks: number;
    updatePosture(ai: AiContext, target: Robot | null): void;
  };

  // A soldier artificially placed in HOLD with contact pinned near (< RUN_DISTANCE)
  // but never seen. Under the old distance-band hold this stayed dug in until the
  // give-up timer; now wantsHold is false, so it drops straight back to combat.
  const bot = new TacOracle(vec(0, 0), { team: "player", z: 0 });
  const t = bot as unknown as T;
  const ai: AiContext = { world, characters: [bot], nav, tick: 0 };
  t.mode = "hold";
  t.holdTicks = 0;
  let held = 0;
  for (let i = 0; i < 120; i++) {
    t.visDist = 500; // both < RUN_DISTANCE and > 0: the old dig-in gate
    t.enemyVisDist = 500;
    t.updatePosture(ai, null);
    if (t.mode === "hold") held++;
    else break;
  }
  check("a soldier does not sustain a distance-band hold", held === 0, `held ${held} ticks`);

  // ...and one that starts in combat never digs in on that gate either. Contact is
  // held at a constant distance, so there's also no asymmetry drop to fire the
  // reflex — the only thing that would legitimately produce a hold here.
  const fresh = new TacOracle(vec(0, 0), { team: "player", z: 0 });
  const f = fresh as unknown as T;
  const ai2: AiContext = { world, characters: [fresh], nav, tick: 0 };
  let everHeld = false;
  for (let i = 0; i < 300; i++) {
    f.visDist = 500;
    f.enemyVisDist = 500;
    f.updatePosture(ai2, null);
    if (f.mode === "hold") { everHeld = true; break; }
  }
  check("a soldier never enters HOLD on the distance band", !everHeld);

  // A DominationOracle still runs its own principled point-defense vigil, opting
  // out of the base give-up timer.
  const dom = new DominationOracle(vec(0, 0), { team: "player", z: 0 });
  check("DominationOracle keeps its own vigil (no base give-up timer)",
    (dom as unknown as { holdMaxTicks(): number }).holdMaxTicks() === Infinity);
}

// -------------------------------------------------------------------- run ---
geometrySuite("tdm-arena-big");
geometrySuite("dom-arena-big");
geometrySuite("arena-teamfight");
threatSuite("dom-arena-big");
laneSuite("tdm-arena-big");
refreshSuite("tdm-arena-big");
dominationSuite("dom-arena-big");
oscillationSuite("dom-arena-big");
soldierHoldSuite("tdm-arena-big");
claimSuite("tdm-arena-big");
ambushSuite("dom-arena-big");
integrationSuite("tdm-arena-big");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
