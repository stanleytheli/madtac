/**
 * Generate src/world/levels/harbor.json — "Harbor": a Domination / TDM map on a
 * container port. Blue holds the west quay, Red the east; three points sit on
 * the map's centre line so both sides reach each equally:
 *
 *   A  Warehouse  — a corrugated steel shed on the north side (indoor fight,
 *                   roller doors south, side doors east/west, a back alley).
 *   C  Yard       — the container yard in the middle (open ground, lanes of
 *                   shipping containers for cover).
 *   B  Ship deck  — a cargo ship moored along the south quay. Its deck is a
 *                   separate level (z1) reached by a gangway either side of the
 *                   yard's centre, so it's a second battlefield like the
 *                   house's mezzanine — and the approach runs through C.
 *
 * Mirror-symmetric in x (every piece of gameplay geometry is placed for one
 * side and reflected), decorated asymmetrically (bow east, bridge west).
 * Container "screens" beside each spawn and across the north/south lanes keep
 * the long quay from being one 3400px sightline. Built with the real world
 * factories + level serializer, so the output is the editor's own save format.
 *
 *   npx tsx scripts/gen_harbor.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  makeBarrelMetal,
  makeBarrelWood,
  makeCircle,
  makeCrate,
  makeFence,
  makeFloor,
  makeNode,
  makeStairs,
  makeWall,
  type FloorOptions,
  type Obstacle,
  type World,
} from "../src/world/world.ts";
import { serializeLevel, type LevelState } from "../src/world/level.ts";
import { deg2rad, vec, type Vec2 } from "../src/engine/vec.ts";
import { circleIntersectsObstacle } from "../src/engine/collision.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";

const emptyWorld = (): World => ({
  obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [], bullets: [], projectiles: [], particles: [], decals: [], scorches: [], bloodSplats: [], events: [],
});

const T = 26; // wall thickness

// --- the map's skeleton -------------------------------------------------------
const XEDGE = 1740; // chain-link fence line, east/west
const YNORTH = -1340; // chain-link fence line behind the warehouse
const QUAY = 620; // the quay edge: water south of this line
// Warehouse outer wall centre-lines.
const WH_X = 800, WH_N = -1200, WH_S = -720;
// Ship hull (z1 deck): playable deck between the two cross-railings at ±DECK_X.
const HULL_W = -1300, HULL_E = 1150, HULL_N = 690, HULL_S = 1150;
const DECK_X = 1060;
const GANGWAY_X = 330; // gangways at ±GANGWAY_X, straddling the quay edge
const hullCy = (HULL_N + HULL_S) / 2; // 920

const state: LevelState = {
  world: emptyWorld(),
  spawns: [],
  playerSpawn: [{ pos: vec(-1560, -100), z: 0, primary: "M16", secondary: "M9" }],
  spawnZones: [
    { pos: vec(-1570, -300), w: 260, h: 1400, z: 0, team: "blue" },
    { pos: vec(1570, -300), w: 260, h: 1400, z: 0, team: "red" },
  ],
  domPoints: [
    { pos: vec(0, -960), z: 0, radius: 170, name: "A" }, // warehouse
    { pos: vec(0, hullCy), z: 1, radius: 170, name: "B" }, // ship deck
    { pos: vec(0, 0), z: 0, radius: 170, name: "C" }, // container yard
  ],
  meta: {
    mode: "domination",
    minimapSize: 3700,
    tdm: {
      killLimit: 100,
      respawnDelay: 300,
      blue: { troops: 8, skill: 0.6, equip: "random" },
      red: { troops: 8, skill: 0.6, equip: "random" },
    },
    domination: {
      scoreLimit: 300,
      respawnDelay: 300,
      blue: { troops: 8, skill: 0.6, equip: "random" },
      red: { troops: 8, skill: 0.6, equip: "random" },
    },
  },
};
const W = state.world;

// --- palette ------------------------------------------------------------------
const P = {
  water: "#2c5d78", waterGrid: "#30637f", wave: "#3f7591",
  quay: "#9c9e99", quayEdge: "#7e827f", apron: "#8d908c", stain: "#94968f",
  paint: "#c9a52c", rail: "#4f5356",
  hull: "#1f252b", deck: "#5d6b76", deckLine: "#526069",
  shed: "#6f7a85", shedStroke: "#3a424a", shedFloor: "#6e6a63",
  roof: "#4b545c", roofRidge: "#59636c", skylight: "#7b8b99",
  cage: "#8a939a", cageStroke: "#3f464c",
  crane: "#b4392a", craneStroke: "#4d160f", craneDark: "#3a3f44",
  hatch: "#46525c", hatchStroke: "#222930",
  bridge: "#d6dadd", bridgeStroke: "#7a8288", funnel: "#b73f30", funnelStroke: "#4f1b14",
  boat: "#e9e3cc", boatStroke: "#8a836c",
  bollard: "#33383c", bollardStroke: "#15181a",
  stair: "#4e565d", stair2: "#98a2ab",
};
// Shipping containers: [fill, stroke].
const CONTAINER: Record<string, [string, string]> = {
  rust: ["#a8452c", "#5c2416"],
  blue: ["#2f6ea6", "#173a5c"],
  green: ["#3f8a4f", "#1f4a28"],
  yellow: ["#d0a02b", "#6e5210"],
  grey: ["#7d8489", "#3c4247"],
  orange: ["#d4692a", "#6e3210"],
  maroon: ["#7a2f3a", "#3d1620"],
  teal: ["#2f8a8a", "#164545"],
};

// --- helpers ------------------------------------------------------------------
const styled = (o: Obstacle, fill: string, stroke: string, strokeWidth?: number): Obstacle => {
  o.fill = fill; o.stroke = stroke; if (strokeWidth !== undefined) o.strokeWidth = strokeWidth; return o;
};
const wall = (p: Vec2, w: number, h: number, z = 0, fill = P.shed, stroke = P.shedStroke) =>
  W.obstacles.push(styled(makeWall(p, w, h, z), fill, stroke));
const fence = (p: Vec2, w: number, h: number, z = 0, fill = P.cage, stroke = P.cageStroke) =>
  W.obstacles.push(styled(makeFence(p, w, h, z), fill, stroke));
/** A shipping container: a solid steel box, long axis along x unless rotated. */
const container = (p: Vec2, color: keyof typeof CONTAINER, z = 0, angleDeg = 0, w = 300, h = 72) => {
  const [fill, stroke] = CONTAINER[color];
  const o = styled(makeWall(p, w, h, z), fill, stroke, 7);
  o.shrapnel = "sparks";
  o.hitSound = "metal";
  if (angleDeg) o.angle = deg2rad(angleDeg);
  W.obstacles.push(o);
};
const crate = (p: Vec2, s = 64, z = 0) => W.obstacles.push(makeCrate(p, s, s, z));
const wood = (p: Vec2, z = 0) => W.obstacles.push(makeBarrelWood(p, 30, z));
const metal = (p: Vec2, z = 0) => W.obstacles.push(makeBarrelMetal(p, 30, z));
const disc = (p: Vec2, r: number, fill: string, stroke: string, z = 0, depth?: number) => {
  const o = styled(makeCircle(p, r, z), fill, stroke);
  if (depth) o.depth = depth;
  W.obstacles.push(o);
};
const floor = (p: Vec2, w: number, h: number, color: string, opts: FloorOptions & { angleDeg?: number; depth?: number }) => {
  const { angleDeg, depth, ...rest } = opts;
  const f = makeFloor(p, w, h, color, rest);
  if (angleDeg) f.angle = deg2rad(angleDeg);
  if (depth) f.depth = depth;
  W.floors.push(f);
};
/** Horizontal wall run along y over [x0,x1] minus gaps; vertical likewise. */
function hrun(y: number, x0: number, x1: number, gaps: [number, number][], mk = wall, t = T, z = 0): void {
  const cuts = [x0, ...gaps.flat(), x1];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a > 1) mk(vec((a + b) / 2, y), b - a, t, z);
  }
}
function vrun(x: number, y0: number, y1: number, gaps: [number, number][], mk = wall, t = T, z = 0): void {
  const cuts = [y0, ...gaps.flat(), y1];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a > 1) mk(vec(x, (a + b) / 2), t, b - a, z);
  }
}
/** Run `f` for the east side (sign +1) and its mirror (sign -1). */
const mirror = (f: (s: number) => void): void => { f(1); f(-1); };
const span = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

// =============================================================================
// FLOORS (painter's order = push order within a level; `depth` breaks ties)
// =============================================================================
const ground = { level: 0, visibleFrom: { atLeast: 0 } as const };
// Water: the whole background, with a faint grid for a rippled look.
floor(vec(0, 0), 0, 0, P.water, { ...ground, infinite: true, grid: true, gridColor: P.waterGrid, gridGap: 384 });
// Pale streaks on the water: wake along the hull, a few further out.
for (const [x, y, a] of [[-1500, 900, -8], [-1450, 1080, 5], [1520, 780, 10], [1600, 1020, -6], [-900, 1200, 3], [200, 1210, -3], [900, 1200, 4], [1450, 1150, -12], [-300, 1340, 6], [700, 1360, -4]] as const) {
  floor(vec(x, y), 220, 8, P.wave, { ...ground, angleDeg: a });
}
// The quay: one concrete slab from the north fence to a lip past the edge.
floor(vec(0, (YNORTH + QUAY + 12) / 2), 2 * XEDGE + 40, QUAY + 12 - YNORTH, P.quay, ground);
// Darker apron along the water, and in front of the warehouse doors.
floor(vec(0, QUAY - 20), 2 * XEDGE + 40, 64, P.quayEdge, { ...ground, depth: 1 });
floor(vec(0, -640), 1760, 150, P.apron, { ...ground, depth: 1 });
// Grime: a few skewed stains.
for (const [x, y, w, h, a] of [[-950, -230, 260, 170, 12], [1010, 330, 230, 150, -25], [-300, 540, 300, 90, 4], [420, -600, 180, 120, 30], [1250, -900, 200, 140, -15], [-1250, -1000, 160, 110, 20]] as const) {
  floor(vec(x, y), w, h, P.stain, { ...ground, depth: 2, angleDeg: a });
}
// Yard paint: a yellow boundary around the container yard + lane hatching at C.
const YARD_X = 1290, YARD_Y = 430;
floor(vec(0, -YARD_Y), 2 * YARD_X, 10, P.paint, { ...ground, depth: 3 });
floor(vec(0, YARD_Y), 2 * YARD_X, 10, P.paint, { ...ground, depth: 3 });
floor(vec(-YARD_X, 0), 10, 2 * YARD_Y, P.paint, { ...ground, depth: 3 });
floor(vec(YARD_X, 0), 10, 2 * YARD_Y, P.paint, { ...ground, depth: 3 });
for (let i = -3; i <= 3; i++) floor(vec(i * 50, 0), 10, 150, P.paint, { ...ground, depth: 3, angleDeg: 45 });
// Bay stripes where each team walks in from its spawn.
mirror((s) => { for (let i = 0; i < 4; i++) floor(vec(s * 1500, -760 + i * 300), 12, 120, P.paint, { ...ground, depth: 3 }); });
// Crane rails along the quay.
floor(vec(0, 440), 2 * XEDGE, 10, P.rail, { ...ground, depth: 4 });
floor(vec(0, 560), 2 * XEDGE, 10, P.rail, { ...ground, depth: 4 });

// Warehouse interior (limits vision indoors) — only seen from the ground.
const WH_W_IN = 2 * WH_X, WH_H_IN = WH_S - WH_N;
floor(vec(0, (WH_N + WH_S) / 2), WH_W_IN, WH_H_IN, P.shedFloor, { level: 0, visibleFrom: [0], zoom: 1.35 });
// Its roof: a level-2 lid that melts away while you're anywhere inside.
const inside = [{ pos: vec(0, (WH_N + WH_S) / 2), w: WH_W_IN, h: WH_H_IN, z: 0 }];
const roofOpts = { level: 2, visibleFrom: [0, 1] as const, hideWhenIn: inside };
floor(vec(0, (WH_N + WH_S) / 2), WH_W_IN + 90, WH_H_IN + 90, P.roof, roofOpts);
floor(vec(0, (WH_N + WH_S) / 2), WH_W_IN + 90, 26, P.roofRidge, { ...roofOpts, depth: 1 });
for (const x of [-600, -250, 250, 600]) floor(vec(x, (WH_N + WH_S) / 2), 160, 100, P.skylight, { ...roofOpts, depth: 2 });

// The ship: dark hull, lighter deck inset, a diamond bow to the east.
const hullOpts = { level: 1, visibleFrom: [0, 1] as const };
const hullCx = (HULL_W + HULL_E) / 2;
floor(vec(hullCx, hullCy), HULL_E - HULL_W, HULL_S - HULL_N, P.hull, hullOpts);
floor(vec(HULL_E, hullCy), 325, 325, P.hull, { ...hullOpts, angleDeg: 45 });
floor(vec(hullCx, hullCy), HULL_E - HULL_W - 48, HULL_S - HULL_N - 48, P.deck, { ...hullOpts, depth: 1 });
floor(vec(HULL_E, hullCy), 291, 291, P.deck, { ...hullOpts, angleDeg: 45, depth: 1 });
// Deck plating seams.
for (const x of [-800, -400, 0, 400, 800]) floor(vec(x, hullCy), 6, HULL_S - HULL_N - 48, P.deckLine, { ...hullOpts, depth: 2 });
// A lookout bonus on the deck (it's high up).
floor(vec(0, hullCy), 2 * DECK_X, HULL_S - HULL_N - 48, P.deck, { ...hullOpts, depth: 3, deltaZoom: 0.35 });

// Gantry crane: a girder overhead (level 2, always drawn) between four legs.
floor(vec(0, 500), 3100, 36, P.crane, { level: 2, visibleFrom: [0, 1] });
floor(vec(0, 500), 3100, 8, P.craneStroke, { level: 2, visibleFrom: [0, 1], depth: 1 });
floor(vec(320, 500), 90, 64, P.craneDark, { level: 2, visibleFrom: [0, 1], depth: 2 });

// =============================================================================
// OBSTACLES
// =============================================================================
// Perimeter: chain-link east/west, behind the warehouse, and a curb at the quay
// edge (bollards on it), all permeable so rounds fly through.
const gwGap = (s: number) => span(s * GANGWAY_X - 115, s * GANGWAY_X + 115);
vrun(-XEDGE, YNORTH, QUAY, [], fence, 14);
vrun(XEDGE, YNORTH, QUAY, [], fence, 14);
hrun(YNORTH, -XEDGE, XEDGE, [], fence, 14);
hrun(QUAY, -XEDGE, XEDGE, [gwGap(-1), gwGap(1)], (p, w, h) => fence(p, w, h, 0, "#8f9497", "#4f5457"), 14);
for (let x = -1500; x <= 1500; x += 300) {
  if (Math.abs(Math.abs(x) - GANGWAY_X) < 160) continue;
  disc(vec(x, QUAY), 13, P.bollard, P.bollardStroke);
}

// Warehouse shell: three roller doors south, a side door each end, solid north.
const DOOR_S: [number, number][] = [[-570, -330], [-120, 120], [330, 570]];
const DOOR_SIDE: [number, number] = [-1020, -880];
hrun(WH_N, -WH_X, WH_X, []);
hrun(WH_S, -WH_X, WH_X, DOOR_S);
vrun(-WH_X, WH_N, WH_S, [DOOR_SIDE]);
vrun(WH_X, WH_N, WH_S, [DOOR_SIDE]);
// Inside: a chain-link tool cage in each north corner, a shelving rack on the
// north wall, pallet stacks flanking the open middle (point A).
mirror((s) => {
  const cx = s * 520; // cage's inner fence line
  vrun(cx, WH_N + T / 2, -1000, [], fence, 12);
  hrun(-1000, Math.min(cx, s * (WH_X - T / 2)), Math.max(cx, s * (WH_X - T / 2)), [span(s * 720, s * 560)], fence, 12);
  crate(vec(s * 750, -1140), 56); wood(vec(s * 760, -1050)); // stock in the cage
  crate(vec(s * 330, -1085), 110); crate(vec(s * 330, -835), 110); // pallet stacks
  metal(vec(s * 200, -1100)); wood(vec(s * 250, -800));
});
wall(vec(0, -1162), 400, 30, 0, "#5f6b76", "#333b43"); // shelving rack

// Loading dock: cover outside the roller doors, and a pallet stack + container
// screen that break the apron lane's sightline on each side.
mirror((s) => {
  crate(vec(s * 230, -660), 70); wood(vec(s * 290, -660));
  crate(vec(s * 1000, -650), 90);
  container(vec(s * 830, -495), s > 0 ? "grey" : "teal", 0, 0, 72, 230);
});

// Container yard — C sits between two upright containers; the lanes around it
// are shaped by paired stacks, an upright further out, and a skewed straggler
// each side. A tall screen shields each spawn from the yard's sightlines.
mirror((s) => {
  container(vec(s * 260, 0), s > 0 ? "rust" : "blue", 0, 0, 72, 300);
  container(vec(s * 560, -370), s > 0 ? "green" : "orange");
  container(vec(s * 560, -292), s > 0 ? "grey" : "maroon");
  container(vec(s * 560, 292), s > 0 ? "teal" : "yellow");
  container(vec(s * 560, 370), s > 0 ? "maroon" : "grey");
  container(vec(s * 860, 0), s > 0 ? "yellow" : "green", 0, 0, 72, 300);
  container(vec(s * 1120, -300), s > 0 ? "blue" : "rust", 0, s * 20);
  container(vec(s * 1120, 300), s > 0 ? "orange" : "teal", 0, -s * 20);
  container(vec(s * 1400, 0), s > 0 ? "rust" : "blue", 0, 0, 72, 520); // spawn screen
  container(vec(s * 830, 505), s > 0 ? "yellow" : "orange", 0, 0, 72, 210); // south lane screen
  // small cover in the gaps
  metal(vec(s * 380, -130)); metal(vec(s * 380, 130));
  wood(vec(s * 720, -520)); wood(vec(s * 760, -560));
  crate(vec(s * 1500, -560), 64); crate(vec(s * 1520, 260), 64); metal(vec(s * 1250, 260)); metal(vec(s * 1100, 520));
  container(vec(s * 1200, -1060), s > 0 ? "grey" : "teal", 0, 0, 260, 72); crate(vec(s * 1300, -820), 90); metal(vec(s * 1000, -1100)); // beside the shed
});
// Crane legs.
for (const [x, y] of [[-1500, 440], [1500, 440], [-1500, 560], [1500, 560]] as const) wall(vec(x, y), 48, 48, 0, P.crane, P.craneStroke);

// Ship (z1). Railings ring the playable deck, with gaps where the gangways land.
const RAIL_N = HULL_N + 36, RAIL_S = HULL_S - 36;
const railing = (p: Vec2, w: number, h: number) => fence(p, w, h, 1, "#c8ced3", "#6d757c");
hrun(RAIL_N, -DECK_X, DECK_X, [gwGap(-1), gwGap(1)], railing, 12, 1);
hrun(RAIL_S, -DECK_X, DECK_X, [], railing, 12, 1);
vrun(-DECK_X, RAIL_N, RAIL_S, [], railing, 12, 1);
vrun(DECK_X, RAIL_N, RAIL_S, [], railing, 12, 1);
// Cargo on deck: two hatch covers, a container each end, barrels around B.
mirror((s) => {
  wall(vec(s * 620, hullCy), 300, 160, 1, P.hatch, P.hatchStroke);
  container(vec(s * 960, hullCy), s > 0 ? "rust" : "blue", 1, 0, 160, 72);
  metal(vec(s * 120, hullCy - 60), 1); metal(vec(s * 120, hullCy + 60), 1);
});
// Bridge superstructure at the stern (west, off the playable deck) + funnel + lifeboats.
wall(vec(-1180, hullCy), 200, 380, 1, P.bridge, P.bridgeStroke);
disc(vec(-1180, hullCy + 100), 40, P.funnel, P.funnelStroke, 1, 1);
for (const y of [hullCy - 150, hullCy + 150]) {
  const o = styled(makeWall(vec(-1140, y), 90, 32, 1), P.boat, P.boatStroke, 4);
  o.depth = 2; W.obstacles.push(o);
}
// Forecastle: a windlass at the bow.
disc(vec(1190, hullCy), 30, "#8e969c", "#3f464c", 1);

// Gangways: quay (z0) at the north end, deck (z1) at the south end; midpoint on
// the quay edge, so a walker's z flips exactly where the concrete ends.
mirror((s) => W.stairs.push(makeStairs(vec(s * GANGWAY_X, QUAY), 170, 260, "y", 0, 1, [0, 1], P.stair, P.stair2, 10)));

// =============================================================================
// NAV NODES — region grids, pruned to body clearance; a few hand-placed links.
// =============================================================================
const CLEAR = BODY_RADIUS + 14;
const blocked = (p: Vec2, z: number): boolean => W.obstacles.some((o) => o.z === z && circleIntersectsObstacle(p, CLEAR, o));
const node = (x: number, y: number, z = 0): void => {
  const p = vec(x, y);
  if (blocked(p, z)) return;
  if (W.nodes.some((n) => n.z === z && Math.hypot(n.pos.x - x, n.pos.y - y) < 40)) return;
  W.nodes.push(makeNode(p, z));
};
const range = (a: number, b: number, step: number): number[] => { const out: number[] = []; for (let v = a; v <= b + 1e-6; v += step) out.push(v); return out; };
const grid = (xs: number[], ys: number[], z = 0) => { for (const x of xs) for (const y of ys) node(x, y, z); };

const XS = range(-1650, 1650, 150);
grid(XS, [-1273]); // back alley
grid(range(-700, 700, 140), [-1100, -950, -800]); // warehouse interior
grid(XS.filter((x) => Math.abs(x) > WH_X + 80), [-1100, -950, -800]); // beside the shed
grid(XS, range(-650, 550, 150)); // quay + yard
mirror((s) => { node(s * 450, -640); node(s * 450, -790); node(0, -640); node(0, -790); }); // roller doors
mirror((s) => { node(s * 640, -1120); node(s * 640, -1050); node(s * 640, -940); }); // cages + their doors
mirror((s) => { node(s * 880, -950); node(s * 720, -950); }); // side doors
mirror((s) => { node(s * 750, -650); node(s * 920, -650); node(s * 920, -350); node(s * 1320, -330); node(s * 1320, 330); }); // lane breaks
mirror((s) => { node(s * GANGWAY_X, QUAY - 160, 0); node(s * GANGWAY_X, QUAY + 170, 1); }); // gangways (330 apart < MOVE_RADIUS)
grid(range(-1000, 1000, 200), [hullCy - 135, hullCy + 135], 1); // deck
mirror((s) => { node(s * 820, hullCy - 135, 1); node(s * 820, hullCy + 135, 1); }); // past the hatch covers

mkdirSync("src/world/levels", { recursive: true });
writeFileSync("src/world/levels/harbor.json", serializeLevel(state) + "\n");
console.log(`wrote src/world/levels/harbor.json  (${W.obstacles.length} obstacles, ${W.floors.length} floors, ${W.nodes.length} nodes)`);
