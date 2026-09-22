/**
 * Generate src/world/levels/house.json — a Domination map set in a two-storey
 * house with a wraparound yard. Blue assaults from the west, Red from the east;
 * they fight over three points: the west Living Room (A) and east Kitchen (C)
 * on the ground floor, and the central upstairs Landing (B), reached by a stair
 * at each end of the great hall. Built with the real world factories + level
 * serializer so the output is exactly the editor's save format.
 *
 *   npx tsx scripts/gen_house.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  makeBarrelMetal,
  makeBarrelWood,
  makeCrate,
  makeFence,
  makeFloor,
  makeNode,
  makeStairs,
  makeWall,
  type World,
} from "../src/world/world.ts";
import { serializeLevel, type LevelState } from "../src/world/level.ts";
import { vec, type Vec2 } from "../src/engine/vec.ts";

/** A fresh, empty world (createWorld() ships the hand-coded demo map). */
const emptyWorld = (): World => ({
  obstacles: [], floors: [], stairs: [], nodes: [], items: [], vehicles: [], bullets: [], projectiles: [], particles: [], decals: [],
});

const T = 26; // wall thickness

// House footprint (outer wall centre-lines).
const XMIN = -980, XMAX = 980, YMIN = -620, YMAX = 620;
const DIV_W = -340, DIV_E = 340; // interior dividers: west | hall | east

const state: LevelState = {
  world: emptyWorld(),
  spawns: [],
  playerSpawn: [{ pos: vec(-1200, 0), z: 0, primary: "M16", secondary: "M9" }],
  spawnZones: [
    { pos: vec(-1220, 0), w: 320, h: 760, z: 0, team: "blue" },
    { pos: vec(1220, 0), w: 320, h: 760, z: 0, team: "red" },
  ],
  domPoints: [
    { pos: vec(-650, 0), z: 0, radius: 175, name: "A" }, // Living room (west)
    { pos: vec(0, 0), z: 1, radius: 175, name: "B" }, // Upstairs landing (centre)
    { pos: vec(650, 0), z: 0, radius: 175, name: "C" }, // Kitchen (east)
  ],
  meta: {
    mode: "domination",
    minimapSize: 3000,
    domination: {
      scoreLimit: 200,
      respawnDelay: 300,
      blue: { troops: 5, skill: 0.6, equip: "random" },
      red: { troops: 5, skill: 0.6, equip: "random" },
    },
  },
};

const W = state.world;
const wall = (p: Vec2, w: number, h: number, z = 0) => W.obstacles.push(makeWall(p, w, h, z));

/** Horizontal wall run along y, spanning [x0,x1], minus door gaps [a,b]. */
function hrun(y: number, x0: number, x1: number, gaps: [number, number][], z = 0): void {
  const cuts = [x0, ...gaps.flat(), x1];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a > 1) wall(vec((a + b) / 2, y), b - a, T, z);
  }
}
/** Vertical wall run along x, spanning [y0,y1], minus door gaps [a,b]. */
function vrun(x: number, y0: number, y1: number, gaps: [number, number][], z = 0): void {
  const cuts = [y0, ...gaps.flat(), y1];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a > 1) wall(vec(x, (a + b) / 2), T, b - a, z);
  }
}

// --- exterior shell (z0): front(N)/back(S) flank doors, W/E main doors --------
const FLANK_W: [number, number] = [-740, -540];
const FLANK_E: [number, number] = [540, 740];
const MAIN_DOOR: [number, number] = [-150, 150];
hrun(YMIN, XMIN, XMAX, [FLANK_W, FLANK_E]); // north wall
hrun(YMAX, XMIN, XMAX, [FLANK_W, FLANK_E]); // south wall
vrun(XMIN, YMIN, YMAX, [MAIN_DOOR]); // west wall  (Blue entry)
vrun(XMAX, YMIN, YMAX, [MAIN_DOOR]); // east wall  (Red entry)

// --- interior dividers (z0), door into the hall from each side room -----------
const INNER_DOOR: [number, number] = [-140, 140];
vrun(DIV_W, YMIN, YMAX, [INNER_DOOR]);
vrun(DIV_E, YMIN, YMAX, [INNER_DOOR]);

// A short interior stub in each side room for cover / a second sightline break
// (narrow enough that a node column passes each side of it).
wall(vec(-660, -300), 240, T); // living-room half-wall (north)
wall(vec(-660, 300), 240, T); // living-room half-wall (south)
wall(vec(660, -300), 240, T); // kitchen half-wall (north)
wall(vec(660, 300), 240, T); // kitchen half-wall (south)

// --- upstairs: a central mezzanine over the hall's middle (z1) ----------------
// The loft spans only the hall's middle (y in [-LOFT,LOFT]); the hall's north
// and south ends stay single-storey, and a staircase in each climbs up to the
// loft edge. Keeping the stairs OUTSIDE the loft footprint means each landing
// has open floor beyond it, so nav links never re-cross a stair midpoint.
const LOFT = 300;
const railing = (p: Vec2, w: number, h: number) => W.obstacles.push(makeFence(p, w, h, 1));
railing(vec(DIV_W, 0), 14, 2 * LOFT); // west ledge
railing(vec(DIV_E, 0), 14, 2 * LOFT); // east ledge
railing(vec(-230, -LOFT), 220, 14); // north edge, west of the stair gap
railing(vec(230, -LOFT), 220, 14); // north edge, east of the stair gap
railing(vec(-230, LOFT), 220, 14); // south edge
railing(vec(230, LOFT), 220, 14);

// --- staircases (hall z0 <-> loft z1), one at each end of the hall ------------
const STAIR = "#7c6034", STAIR2 = "#c2a06e";
// North stair: ground at its outer (north) end, loft at its inner (south) end.
W.stairs.push(makeStairs(vec(0, -410), 240, 180, "y", 0, 1, [0, 1], STAIR, STAIR2));
// South stair: loft at its inner (north) end, ground at its outer (south) end.
W.stairs.push(makeStairs(vec(0, 410), 240, 180, "y", 1, 0, [0, 1], STAIR, STAIR2));

// --- furniture / cover (z0) ---------------------------------------------------
const wood = (p: Vec2) => W.obstacles.push(makeBarrelWood(p, 30, 0));
const metal = (p: Vec2) => W.obstacles.push(makeBarrelMetal(p, 30, 0));
const crate = (p: Vec2, s = 62) => W.obstacles.push(makeCrate(p, s, s, 0));
// Living room (A) — sofa-ish crates + a barrel, off the capture centre.
crate(vec(-820, -420)); crate(vec(-500, 430)); wood(vec(-870, 380));
// Kitchen (C) — mirrored.
crate(vec(820, 420)); crate(vec(500, -430)); wood(vec(870, -380));
// Great hall — a little cover by each main entry and mid-room.
metal(vec(-250, -140)); metal(vec(250, 140));
crate(vec(0, -130)); crate(vec(0, 130));

// --- floors -------------------------------------------------------------------
// Yard (background).
W.floors.push(makeFloor(vec(0, 0), 0, 0, "#6ea866", { level: 0, visibleFrom: { atLeast: 0 }, infinite: true, grid: true, gridColor: "#5f9459" }));
// Ground-floor rooms (visible from z0, mild zoom-in for the indoor feel).
const roomOpts = { level: 0 as const, visibleFrom: [0], zoom: 1.35 };
const sideW = DIV_W - XMIN; // 640 — both side rooms
const fullH = YMAX - YMIN; // 1240 — house depth
W.floors.push(makeFloor(vec(-660, 0), sideW, fullH, "#7b5a3c", roomOpts)); // west room
W.floors.push(makeFloor(vec(660, 0), sideW, fullH, "#6f5540", roomOpts)); // east room
W.floors.push(makeFloor(vec(0, 0), DIV_E - DIV_W, fullH, "#8a6a44", roomOpts)); // hall
// Upstairs mezzanine (visible from z1) — over the hall's middle only.
W.floors.push(makeFloor(vec(0, 0), DIV_E - DIV_W, 2 * LOFT, "#b39064", { level: 1, visibleFrom: [1], deltaZoom: 0.4 }));
// Roof over the whole house: shows from outside, melts once you step inside.
W.floors.push(makeFloor(vec(0, 0), XMAX - XMIN + 80, fullH + 80, "#7a3f34", { level: 2, visibleFrom: [0, 1], hideWhenUnder: true }));

// --- nav nodes ----------------------------------------------------------------
// Hand-placed and room-aware: the marched walkability test (buildNodeSets) only
// links pairs a body can actually walk between, so a dense-enough scatter with
// clear runs through every doorway keeps the graph connected without stray links.
const node = (x: number, y: number, z = 0) => W.nodes.push(makeNode(vec(x, y), z));
const grid = (xs: number[], ys: number[], z = 0) => { for (const x of xs) for (const y of ys) node(x, y, z); };
const doorPair = (x: number, y: number, dx: number, dy: number, z = 0) => { node(x - dx, y - dy, z); node(x + dx, y + dy, z); };

// Side rooms (columns flank the half-walls so each has a clear N-S run).
grid([-880, -650, -420], [-500, -250, 0, 250, 500]); // living (A)
grid([420, 650, 880], [-500, -250, 0, 250, 500]); // kitchen (C)
// Ground hall: side columns (clear of the central stairs) + a centre link.
grid([-200, 200], [-540, -300, 0, 300, 540]);
node(0, 0, 0); // hall centre, ties the two columns together E-W

// Doorways (a node just inside and just outside each gap).
doorPair(-980, 0, 130, 0); // Blue main door (W)
doorPair(980, 0, 130, 0); // Red main door (E)
doorPair(-640, -620, 0, 120); // NW flank
doorPair(-640, 620, 0, 120); // SW flank
doorPair(640, -620, 0, 120); // NE flank
doorPair(640, 620, 0, 120); // SE flank
doorPair(-340, 0, 120, 0); // living <-> hall
doorPair(340, 0, 120, 0); // kitchen <-> hall

// Yard ring for outside flanking + spawn approaches.
grid([-1220, 1220], [-450, 0, 450]); // spawn depths
grid([-1180, 1180], [-820, 820]); // yard corners
grid([-640, 0, 640], [-880, 880]); // front/back yard lanes

// Stairs + mezzanine: a z0 node just beyond each stair's ground end and a z1
// node just inside the loft past its high end; the link between them spans the
// stair midpoint. Loft interior nodes stay between the two landings.
node(0, -560, 0); node(0, -250, 1); // north stair: ground -> loft landing
node(0, 560, 0); node(0, 250, 1); // south stair
node(0, 0, 1); node(-200, 0, 1); node(200, 0, 1); // loft interior

mkdirSync("src/world/levels", { recursive: true });
writeFileSync("src/world/levels/house.json", serializeLevel(state) + "\n");
console.log(`wrote src/world/levels/house.json  (${W.obstacles.length} obstacles, ${W.nodes.length} nodes)`);
