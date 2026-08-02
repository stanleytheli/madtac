import { BODY_RADIUS } from "../entities/character.ts";
import { hasLineOfSight, pointInBox, pointInObstacle, type Box, type ObstacleGrid } from "../engine/collision.ts";
import {
  BLOOD,
  CRATE_SHRAPNEL,
  METAL_SHRAPNEL,
  STANDARD_EXPLOSION,
  WALL_SHRAPNEL,
  spawnParticles,
  updateParticles,
  type Particle,
  type ParticleStyle,
} from "../engine/particle.ts";
import type { GroundItem } from "../entities/item.ts";
import type { Vehicle } from "../entities/vehicle.ts";
import type { ArmorPen } from "../entities/guns.ts";
import { add, dist, norm, rotate, scale, sub, vec, type Vec2 } from "../engine/vec.ts";

// --- verticality ------------------------------------------------------------
// Everything in the world (characters, obstacles, items, bullets, ...) lives at
// an integer z level. Floors are the *surfaces* of those levels: each declares
// the set of viewer z values that can see it. Objects render everywhere EXCEPT
// where a hidden surface at their own level backs them, with visible surfaces
// winning where the two overlap (see render() in main.ts). So a character
// straddling a hidden second story and its visible balcony loses only the
// interior half, while anything over open air — a body overhanging the balcony
// lip, a bullet flying off the deck — stays visible.

/** The set of viewer z values a surface is visible from. */
export type ZSet = readonly number[] | "all" | { atLeast: number } | { atMost: number };

export function zsetHas(s: ZSet, z: number): boolean {
  if (s === "all") return true;
  if (Array.isArray(s)) return (s as readonly number[]).includes(z);
  // A range: one of atLeast/atMost is present (Array.isArray can't narrow
  // readonly arrays out of the union, hence the cast).
  const r = s as { atLeast?: number; atMost?: number };
  return r.atLeast !== undefined ? z >= r.atLeast : z <= r.atMost!;
}

/** An axis-aligned region of the map (the same centered {pos,w,h} shape as
 *  obstacles and floors), pinned to one z level. Used as a viewer-position
 *  trigger — see hideWhenIn. */
export interface Region {
  pos: Vec2;
  w: number;
  h: number;
  /** The viewer z this region applies to (inside the box at another z ≠ inside). */
  z: number;
}

/**
 * A solid box that blocks movement, bullets, and line of sight — but only
 * against things on its own z level. Crates and walls are both Obstacles,
 * differing only in appearance + shrapnel.
 */
export interface Obstacle {
  pos: Vec2; // center
  w: number;
  h: number;
  /** Rotation about `pos` in radians (absent/0 = axis-aligned). Collision,
   *  sight, and rendering all honor it — see collision.ts's local-frame Box. */
  angle?: number;
  /** Barrel-like: a CIRCLE (radius = half the smaller of w/h; the factories keep
   *  w === h) instead of a box, for collision, sight, bullets, and rendering. See
   *  collision.ts's obstacle-shape dispatch. `cross` still splits the two barrel
   *  looks (wood planks vs bare metal), exactly as it splits crate from wall. */
  round?: boolean;
  z: number; // the level it sits on
  /** Fence-like: still solid to movement, but bullets and sight pass through, so
   *  same-level firefights work across it. (Bullets stay z-bound regardless —
   *  a fence never enables shooting between levels.) */
  permeable?: boolean;
  /** Which viewer z values it *renders* for (e.g. [1] for second-story walls
   *  that shouldn't show from the ground). Purely cosmetic — collision, bullets
   *  and sight only ever care about `z`. Omitted = visible from everywhere. */
  visibleFrom?: ZSet;
  /** Never drawn at all, but still fully solid (or fence-permeable): invisible
   *  barriers, out-of-bounds walls. Cosmetic only, like visibleFrom. */
  invisible?: boolean;
  /** Render depth among same-level obstacles (default 0, higher = on top; ties
   *  keep authoring order). Sorted once at load — see sortRenderDepth. */
  depth?: number;
  // appearance
  fill: string;
  stroke: string;
  strokeWidth: number;
  cross: boolean; // draw the diagonal plank "X" (crates) or not (walls)
  /** The shrapnel burst thrown when a bullet hits it. */
  particle: ParticleStyle;
}

/**
 * A walkable surface at a z level. No collision of its own — it decides what the
 * viewer can see: while *hidden*, it erases the objects at its level that it
 * backs (a hidden second story swallows whoever's standing on it); while
 * visible it protects them from other hidden surfaces it overlaps. A roof is
 * just a floor at the level above with `hideWhenUnder`, so it melts away once
 * you walk in beneath it.
 */
export interface Floor {
  pos: Vec2; // center
  w: number;
  h: number;
  /** Rotation about `pos` in radians, like an Obstacle's. Render masks
   *  decompose rotated surfaces into disjoint convex quads (see poly.ts). */
  angle?: number;
  color: string;
  /** The z level the surface physically sits at. */
  level: number;
  /** Which viewer z values can see it (e.g. a balcony: [0, 1]; the ground: z >= 0). */
  visibleFrom: ZSet;
  /** Also hide it while the viewer is beneath it and inside its footprint (roofs). */
  hideWhenUnder?: boolean;
  /** Also hide it while the viewer is inside any of these regions *at the
   *  region's z* — hideWhenUnder with the trigger decoupled from the surface's
   *  own rect. This is how a wedding-cake building's lower roof works: it
   *  lists the whole ground-story interior at z 0, so it clears out when
   *  you're anywhere inside that room (not just directly under the overhang),
   *  yet stays put while you look down on it from the story above. */
  hideWhenIn?: Region[];
  /** A solid ceiling: while the viewer is beneath it and inside its footprint,
   *  the *whole world* at this level and above is hidden — background included
   *  (see enclosureCap). This is the "sealed underground" rule: a bunker is
   *  just a room at z=-1 whose enclosing ceiling sits at level 0, while an
   *  open-air trench has no ceiling and keeps the surface world in view. */
  enclosing?: boolean;
  /** Covers the whole map (the ground): drawn as the screen background, and its
   *  level needs no clip mask — everything at that level is backed by it. */
  infinite?: boolean;
  /** Draw grid lines over it while it's the background (infinite floors). */
  grid?: boolean;
  /** Grid line color (default "#5ca76c"). */
  gridColor?: string;
  /** Grid line thickness in *screen* px (default 1). */
  gridWidth?: number;
  /** Grid line spacing in world px (default 512). */
  gridGap?: number;
  /** While the player stands on it (inside the rect at its level), the camera
   *  zoom becomes this instead of the gun's — building interiors that limit
   *  vision. Overrides deltaZoom wherever both would apply. */
  zoom?: number;
  /** While the player stands on it, added to the gun's zoom — a balcony
   *  lookout point that boosts vision. */
  deltaZoom?: number;
  /** Never drawn, but still a full citizen of every other system: it backs
   *  objects in the render masks, drives zoom/enclosing/hideWhenIn triggers,
   *  and counts for visibility. The clean way to build trigger zones and
   *  walkable areas that shouldn't paint anything over the background. */
  invisible?: boolean;
  /** Render depth among same-level floors (default 0, higher = on top; ties
   *  keep authoring order) — decorative patches over base slabs, overlapping
   *  roofs. Sorted once at load — see sortRenderDepth. */
  depth?: number;
  /** Eased render opacity: fades toward 1 while visible, 0 while not. */
  alpha: number;
}

/**
 * A staircase connecting two z levels across its rect. Characters crossing the
 * midpoint flip z sharply (by design). Rendered as `steps` slices whose color
 * lightens toward the higher end; joins the clip mask of both levels it touches.
 */
export interface Stairs {
  pos: Vec2; // center
  w: number;
  h: number;
  /** Rotation about `pos` in radians, like an Obstacle's. The climb axis and
   *  midpoint rule live in the stairs' local frame, so they rotate along. */
  angle?: number;
  /** The axis you climb along; z changes as you cross the rect's midpoint. */
  axis: "x" | "y";
  /** z at the min-coordinate end / max-coordinate end along `axis`. */
  zAtMin: number;
  zAtMax: number;
  visibleFrom: ZSet;
  steps: number;
  /** Step color at the low-z end. */
  color: string;
  /** Step color at the high-z end: steps blend color -> color2 across the
   *  flight. Omitted = the legacy look (color lightened 50% toward white). */
  color2?: string;
  /** Render depth among same-level stairs, like a floor's. */
  depth?: number;
  /** Eased render opacity, like a floor's. */
  alpha: number;
}

/**
 * A hand-placed pathfinding node (see nav.ts for the graph built over them).
 * The pos/z pair is authored in the level editor; `id` and the two link sets
 * are derived at load time by buildNodeSets and never serialized:
 *   - `visible`: node id -> straight-line distance, for every same-z node with
 *     clear line of sight.
 *   - `movable`: node id -> distance, for every node a body can actually walk
 *     straight to (swept as a body-radius circle against obstacles, z tracked
 *     across stairs) within nav.ts's MOVE_RADIUS. On flat ground this is a subset of
 *     `visible`; a stair link is the one case that's movable without being
 *     visible (the far end is on another z).
 */
export interface PathNode {
  pos: Vec2;
  z: number;
  id: number;
  visible: Map<number, number>;
  movable: Map<number, number>;
}

export function makeNode(pos: Vec2, z = 0): PathNode {
  return { pos, z, id: -1, visible: new Map(), movable: new Map() };
}

export function makeCrate(pos: Vec2, w: number, h: number, z = 0): Obstacle {
  return { pos, w, h, z, fill: "#92632d", stroke: "#412b04", strokeWidth: 9, cross: true, particle: CRATE_SHRAPNEL };
}

export function makeWall(pos: Vec2, w: number, h: number, z = 0): Obstacle {
  return { pos, w, h, z, fill: "#6b7076", stroke: "#3a3d40", strokeWidth: 6, cross: false, particle: WALL_SHRAPNEL };
}

/** A fence/railing: blocks movement, but bullets and sight pass through it. */
export function makeFence(pos: Vec2, w: number, h: number, z = 0): Obstacle {
  return { pos, w, h, z, permeable: true, fill: "#a9946e", stroke: "#615139", strokeWidth: 5, cross: false, particle: WALL_SHRAPNEL };
}

/** A metal barrel: a solid CIRCLE (radius `r`) that blocks like a wall and
 *  showers steel sparks when shot. `cross: false` marks the bare-metal look. */
export function makeBarrelMetal(pos: Vec2, r = BARREL_R, z = 0): Obstacle {
  const d = 2 * r;
  return { pos, w: d, h: d, z, round: true, fill: "#8a929b", stroke: "#3f474d", strokeWidth: 5, cross: false, particle: METAL_SHRAPNEL };
}

/** A wooden barrel: same circular collider, but splinters like a crate.
 *  `cross: true` marks the planked-wood look (as it does for crates). */
export function makeBarrelWood(pos: Vec2, r = BARREL_R, z = 0): Obstacle {
  const d = 2 * r;
  return { pos, w: d, h: d, z, round: true, fill: "#9a6a2f", stroke: "#4a300f", strokeWidth: 5, cross: true, particle: CRATE_SHRAPNEL };
}

/**
 * Bake the static render order: stable-sort each static array by depth
 * (default 0), so ties keep authoring order. The render loop just walks the
 * arrays — call this ONCE after the world is built or a level is loaded (the
 * editor re-calls it after edits; the game never needs to re-sort). Depth
 * orders within a category on the same z level; z levels still partition
 * everything first, and floors always draw under stairs under objects.
 */
export function sortRenderDepth(w: World): void {
  const d = (e: { depth?: number }): number => e.depth ?? 0;
  w.floors.sort((a, b) => d(a) - d(b));
  w.stairs.sort((a, b) => d(a) - d(b));
  w.obstacles.sort((a, b) => d(a) - d(b));
}

export interface FloorOptions {
  level: number;
  visibleFrom: ZSet;
  hideWhenUnder?: boolean;
  hideWhenIn?: Region[];
  enclosing?: boolean;
  infinite?: boolean;
  grid?: boolean;
  gridColor?: string;
  gridWidth?: number;
  gridGap?: number;
  zoom?: number;
  deltaZoom?: number;
  invisible?: boolean;
}

export function makeFloor(
  pos: Vec2,
  w: number,
  h: number,
  color: string,
  opts: FloorOptions = { level: 0, visibleFrom: { atLeast: 0 } },
): Floor {
  return { pos, w, h, color, alpha: 1, ...opts };
}

export function makeStairs(
  pos: Vec2,
  w: number,
  h: number,
  axis: "x" | "y",
  zAtMin: number,
  zAtMax: number,
  visibleFrom: ZSet,
  color: string,
  color2?: string,
  steps = 8,
): Stairs {
  return { pos, w, h, axis, zAtMin, zAtMax, visibleFrom, color, color2, steps, alpha: 1 };
}

/**
 * The z a point standing on these stairs belongs to, or null if it's outside the
 * stair rect. Sharp: the near half of the rect is one level, the far half the
 * other, so walking across the midpoint is the transition.
 */
export function stairZ(s: Stairs, p: Vec2): number | null {
  // Rotated flights: the rect test and the climb axis live in the stairs'
  // local frame, so transform the walker's position into it first.
  if (s.angle) p = add(s.pos, rotate(sub(p, s.pos), -s.angle));
  const minx = s.pos.x - s.w / 2;
  const miny = s.pos.y - s.h / 2;
  if (p.x < minx || p.x > minx + s.w || p.y < miny || p.y > miny + s.h) return null;
  const t = s.axis === "x" ? (p.x - minx) / s.w : (p.y - miny) / s.h;
  return t < 0.5 ? s.zAtMin : s.zAtMax;
}

/** Unit vector along a flight's climb axis in WORLD space — the direction z
 *  changes along, rotated by the flight's `angle`. Sign is arbitrary; callers use
 *  it only as an axis (e.g. the stair movement slowdown in Character.move). */
export function stairClimbDir(s: Stairs): Vec2 {
  const local = s.axis === "x" ? vec(1, 0) : vec(0, 1);
  return s.angle ? rotate(local, s.angle) : local;
}

/**
 * The viewer's enclosure cap: the lowest `enclosing` ceiling covering them from
 * above, or Infinity in the open. Everything at or above the cap is hidden —
 * background included — except what shows through stairwell shafts (see the
 * render loop in main.ts). This is what distinguishes a sealed bunker from an
 * open-air trench: both viewers are at z=-1, but only the bunker has a ceiling.
 */
export function enclosureCap(floors: readonly Floor[], viewerZ: number, viewerPos: Vec2): number {
  let cap = Infinity;
  for (const f of floors) {
    if (!f.enclosing || viewerZ >= f.level || f.level >= cap) continue;
    if (pointInBox(viewerPos, f)) cap = f.level;
  }
  return cap;
}

/** Sharp floor visibility for a viewer: the enclosure cap, the z-set check, and
 *  roof-style hiding (by the surface's own footprint, or by explicit regions —
 *  each region is pinned to a viewer z, so the author has full control). */
export function floorVisible(f: Floor, viewerZ: number, viewerPos: Vec2, cap = Infinity): boolean {
  if (f.level >= cap) return false;
  if (!zsetHas(f.visibleFrom, viewerZ)) return false;
  if (f.hideWhenUnder && viewerZ < f.level && pointInBox(viewerPos, f)) return false;
  if (f.hideWhenIn && f.hideWhenIn.some((r) => r.z === viewerZ && pointInBox(viewerPos, r))) {
    return false;
  }
  return true;
}

/** A staircase stays visible while any level it touches is below the cap (you
 *  can see your bunker's exit stairs from inside). */
export function stairsVisible(s: Stairs, viewerZ: number, cap = Infinity): boolean {
  if (Math.min(s.zAtMin, s.zAtMax) >= cap) return false;
  return zsetHas(s.visibleFrom, viewerZ);
}

const FADE_OUT_RATE = 0.1; // surface alpha lost per tick (~10 ticks per full fade)

/**
 * Drive every surface's alpha from its sharp visibility. Appearing surfaces snap
 * straight to full opacity — an eased fade-in would let the background peek
 * through while two stacked floors crossfade (e.g. climbing to the second story).
 * Disappearing ones get the eased fade-out, per the design.
 */
export function updateSurfaceAlphas(w: World, viewerZ: number, viewerPos: Vec2, snap = false): void {
  const cap = enclosureCap(w.floors, viewerZ, viewerPos);
  const ease = (alpha: number, target: number): number =>
    snap || target > alpha ? target : Math.max(target, alpha - FADE_OUT_RATE);
  for (const f of w.floors) f.alpha = ease(f.alpha, floorVisible(f, viewerZ, viewerPos, cap) ? 1 : 0);
  for (const s of w.stairs) s.alpha = ease(s.alpha, stairsVisible(s, viewerZ, cap) ? 1 : 0);
}

/**
 * Anything a bullet can strike and damage. Characters satisfy this structurally
 * (declared here, not imported, to keep world.ts free of an actor.ts cycle).
 */
export interface Hittable {
  pos: Vec2;
  z: number;
  registerHit(dir: Vec2, point: Vec2, damage: number, armorPen: ArmorPen, attacker: Hittable | null): void;
}

export interface Bullet {
  pos: Vec2;
  prev: Vec2; // position last tick (for tracer drawing)
  vel: Vec2;
  z: number; // the shooter's level: only hits obstacles/characters on it
  life: number; // ticks remaining
  origin: Vec2; // spawn position (head center)
  renderAfter: number; // don't draw until this far from origin (hides it inside the gun)
  owner: Hittable | null; // who fired it; never collides with its own owner
  damage: number; // damage dealt on hit (from the firing gun)
  tracerWidth: number; // cosmetic streak thickness (from the firing gun)
  tracerLength: number; // cosmetic streak length behind the bullet (from the firing gun)
  tracerColor: string; // cosmetic streak color "#rrggbb" (from the firing gun)
  armorPen: ArmorPen; // per-tier penetration (from the firing gun), applied on hit
}

/**
 * A slow, visible round that flies like a fat bullet but detonates into an
 * area-of-effect blast instead of dealing single-target damage — the basis for
 * launcher weapons (rockets today; grenades once z-arcing is designed). It lives
 * entirely on the shooter's z, exactly like a bullet. On striking a wall or a
 * (non-owner) body, or when its `life` runs out mid-air, it calls `explode`.
 */
export interface Projectile {
  pos: Vec2;
  prev: Vec2; // position last tick (for trail drawing)
  vel: Vec2; // constant; rockets don't arc
  z: number; // the shooter's level
  life: number; // ticks until it self-detonates (also caps range = speed * life)
  origin: Vec2; // spawn position (head center)
  renderAfter: number; // don't draw until this far from origin (hides it in the tube)
  owner: Hittable | null; // shooter; the round won't *impact* them, but the blast still can
  damage: number; // blast damage at the center (falls off to 0 at radius)
  radius: number; // blast radius (world px)
  armorPen: ArmorPen; // per-tier penetration, applied to each body caught in the blast
  bodyRadius: number; // the round's own collision + draw radius
  color: string; // body color "#rrggbb" (fallback when sprite is unset/undecoded)
  trailColor: string; // exhaust-trail color "#rrggbb"
  sprite?: string; // optional /assets basename drawn in place of the body disc
  spriteScale?: number; // sprite native px -> world px (aspect preserved)
  explosion?: readonly ParticleStyle[]; // particle bursts at detonation (default: STANDARD_EXPLOSION)
}

/** Static map data plus live projectiles, particle debris, and ground items. */
export interface World {
  obstacles: Obstacle[]; // solid: crates + walls
  floors: Floor[]; // walkable surfaces (incl. the infinite ground) + roofs
  stairs: Stairs[]; // z-level connectors
  nodes: PathNode[]; // hand-placed pathfinding nodes (see nav.ts)
  items: GroundItem[]; // pickups lying on the ground
  vehicles: Vehicle[]; // drivable multi-part rigid bodies (see entities/vehicle.ts)
  bullets: Bullet[];
  projectiles: Projectile[]; // AoE rounds in flight (rockets etc.)
  particles: Particle[];
  /** Spatial index over sight-blocking obstacles (see ObstacleGrid), built once
   *  from the static geometry. Absent in the editor / before it's built — then
   *  losClear falls back to scanning the obstacle array. */
  grid?: ObstacleGrid;
}

/** Clear line of sight from `a` to `b` on level `z`, using the world's spatial
 *  index when it's been built (the fast path) and scanning obstacles otherwise.
 *  A solid vehicle hull blocks sight too — matching the (bidirectional) way it
 *  blocks rounds — so the AI treats a parked vehicle as real cover: it won't pick
 *  a sighting node *through* a hull, try to shoot through one, or path straight
 *  into one. (Guarded on an empty vehicle list, so the common case is unchanged;
 *  the nav baseline is built vehicle-free, so static `visible` sets are unaffected.) */
export function losClear(world: World, a: Vec2, b: Vec2, z: number): boolean {
  const clear = world.grid ? !world.grid.blocked(a, b, z) : hasLineOfSight(a, b, world.obstacles, z);
  if (!clear) return false;
  return !(world.vehicles.length > 0 && vehicleBlocksSegment(world.vehicles, a, b, z));
}

export const WALL_T = 26; // shared wall thickness (demo map + editor defaults)
export const BARREL_R = 32; // default barrel radius (editor + factories)

export function createWorld(): World {
  const obstacles: Obstacle[] = [
    // crates (outdoors, z=0)
    makeCrate(vec(160, -120), 64, 64),
    makeCrate(vec(240, -120), 64, 64),
    makeCrate(vec(-200, 80), 80, 80),
    makeCrate(vec(-40, 220), 64, 64),
    makeCrate(vec(120, 200), 64, 64),
    makeCrate(vec(-260, -180), 64, 64),
    // walls (long thin boxes forming a partial enclosure)
    makeWall(vec(40, -340), 520, 28),
    makeWall(vec(-300, -120), 28, 460),
    makeWall(vec(360, 60), 28, 320),
  ];

  const floors: Floor[] = [
    // The ground itself: an infinite grass surface at z=0, seen from z >= -1 —
    // including from open-air trenches one level down. Sealed bunkers hide it
    // via their enclosing ceiling (the cap), not via this set. (Drawn as the
    // screen background; its level never needs a clip mask.)
    makeFloor(vec(0, 0), 0, 0, "#70c575", {
      level: 0,
      visibleFrom: { atLeast: -1 },
      infinite: true,
      grid: true,
      gridColor: "#5ca76c",
    }),
    // decorative patches on the ground
    makeFloor(vec(0, 0), 260, 260, "#46603f", { level: 0, visibleFrom: { atLeast: -1 } }),
    makeFloor(vec(220, 220), 180, 180, "#5a4a6a", { level: 0, visibleFrom: { atLeast: -1 } }),
  ];

  const stairs: Stairs[] = [];

  // Floor slabs extend past their walls' center lines to the walls' *outer*
  // faces (half thickness + stroke). Obstacles render inside their level's clip
  // mask, so a wall not fully backed by a surface gets its outer half sliced off.
  const EXT = WALL_T / 2 + 3;

  // Second-story walls are drawn only for z=1 viewers: roofs/masking hide them
  // from other levels anyway, so this just kills the unbacked AA slivers (e.g.
  // alongside stairwells). Purely cosmetic — collision is unaffected.
  const wall2 = (pos: Vec2, w: number, h: number): Obstacle => ({
    ...makeWall(pos, w, h, 1),
    visibleFrom: [1],
  });

  // --- two-story building (west) --------------------------------------------
  // Footprint x:[-1150,-650], y:[-650,-250] (wall center lines). Interior stairs
  // on the west side climb z 0 -> 1; a balcony pokes out the east face at z=1,
  // visible from the ground and its own level (not from the basement); the roof
  // (a floor at z=2) fades out while you're inside.
  {
    // ground floor (z=0): walls with a door gap on the south face x:[-830,-750]
    obstacles.push(
      makeWall(vec(-900, -650), 500 + WALL_T, WALL_T, 0), // north
      makeWall(vec(-1150, -450), WALL_T, 400 + WALL_T, 0), // west
      makeWall(vec(-650, -450), WALL_T, 400 + WALL_T, 0), // east
      makeWall(vec(-990, -250), 320, WALL_T, 0), // south, west of the door
      makeWall(vec(-700, -250), 100, WALL_T, 0), // south, east of the door
    );
    // second story (z=1): same perimeter, balcony door gap on the east y:[-490,-410]
    obstacles.push(
      wall2(vec(-900, -650), 500 + WALL_T, WALL_T), // north
      wall2(vec(-1150, -450), WALL_T, 400 + WALL_T), // west
      wall2(vec(-900, -250), 500 + WALL_T, WALL_T), // south (no door up here)
      wall2(vec(-650, -570), WALL_T, 160), // east, north of the balcony door
      wall2(vec(-650, -330), WALL_T, 160), // east, south of the balcony door
      // balcony railings: fences, so you can shoot over them (same level only)
      makeFence(vec(-565, -530), 170, 14, 1), // north railing
      makeFence(vec(-565, -370), 170, 14, 1), // south railing
      makeFence(vec(-480, -450), 14, 174, 1), // east railing
    );
    // Rail the staircase's open (east) side along its *upper* half, at both its
    // levels: stepping sideways into the z=1 half from the ground floor would
    // teleport you up a story. The lower half needs no rail — side-entering it
    // is z-consistent (you're just stepping onto the bottom of the flight).
    obstacles.push(
      makeFence(vec(-990, -425), 14, 110, 0),
      makeFence(vec(-1080, -485), 110, 14, 0),
      makeFence(vec(-990, -370), 14, 210, 1),
    );

    floors.push(
      // ground-floor interior (hidden by the roof until you walk in); indoors
      // the camera pulls in — cramped rooms shouldn't grant open-field vision
      makeFloor(vec(-900, -450), 500 + 2 * EXT, 400 + 2 * EXT, "#9c7444", {
        level: 0,
        visibleFrom: [0],
        zoom: 1.6,
      }),
      // second-story floor: the footprint minus the stairwell hole (three rects)
      makeFloor(vec(-822, -450), 376, 400 + 2 * EXT, "#b99664", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-1088, -573), 156, 186, "#b99664", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-1088, -257), 156, 46, "#b99664", { level: 1, visibleFrom: [1] }),
      // the balcony: z=1, seen from the ground and from up there (the overhang);
      // extends slightly past its railings' outer faces. A lookout point: the
      // camera zooms out a bit further while you stand on it.
      makeFloor(vec(-550, -450), 170, 180, "#b5ab97", {
        level: 1,
        visibleFrom: [0, 1],
        hideWhenUnder: false,
        deltaZoom: 0.6,
      }),
      // the roof: covers the walls too (but stops at the east wall line so it
      // doesn't overhang the balcony doorway); melts away while you're under it
      makeFloor(vec(-908, -450), 500 + EXT, 400 + 2 * EXT, "#8a4f3d", {
        level: 2,
        visibleFrom: [0, 1],
        hideWhenUnder: true,
      }),
    );

    // interior staircase along the west wall: north end is upstairs (z=1)
    stairs.push(makeStairs(vec(-1070, -380), 120, 200, "y", 1, 0, [0, 1], "#7c6034"));
  }

  // --- cake building (north) -------------------------------------------------
  // Wedding-cake shape: the ground story spans the whole footprint, but the
  // second story is only the west "tower" — the east half sticks out below it
  // and wears its own roof one level down. Both roofs hide via hideWhenIn
  // regions over the building's footprint: the stickout roof (level 1) clears
  // for a viewer inside at z 0 only, the tower roof (level 2) for z 0 and z 1.
  // From the tower you look down onto the lower roof, cake-style; from outside,
  // both roofs seal the building normally.
  {
    // The shared trigger footprint: the ground story's slab (walls included), so
    // the roofs start melting a step before you fully clear the doorway. Each
    // region gets its own pos (the editor moves regions by mutating pos).
    const fpr = (z: number): Region => ({
      pos: vec(-100, -805),
      w: 500 + 2 * EXT,
      h: 350 + 2 * EXT,
      z,
    });

    // ground story (z=0): footprint x:[-350,150], y:[-980,-630], door on the
    // south face x:[-60,20]
    obstacles.push(
      makeWall(vec(-100, -980), 500 + WALL_T, WALL_T, 0), // north
      makeWall(vec(-350, -805), WALL_T, 350 + WALL_T, 0), // west
      makeWall(vec(150, -805), WALL_T, 350 + WALL_T, 0), // east
      makeWall(vec(-205, -630), 290, WALL_T, 0), // south, west of the door
      makeWall(vec(85, -630), 130, WALL_T, 0), // south, east of the door
    );
    // second story (z=1): just the tower, x:[-350,-120]
    obstacles.push(
      wall2(vec(-235, -980), 230 + WALL_T, WALL_T), // north
      wall2(vec(-350, -805), WALL_T, 350 + WALL_T), // west
      wall2(vec(-235, -630), 230 + WALL_T, WALL_T), // south
      wall2(vec(-120, -805), WALL_T, 350 + WALL_T), // east, along the cake edge
    );
    // stair rails, same reasoning as the west building's: cap the top end and
    // the open east side's upper half at z=0, the whole east side at z=1
    obstacles.push(
      makeFence(vec(-204, -815), 14, 110, 0),
      makeFence(vec(-280, -875), 110, 14, 0),
      makeFence(vec(-204, -760), 14, 210, 1),
    );

    floors.push(
      // ground-story interior: tower + stickout as one room (same slab rect the
      // trigger regions cover); indoor zoom limit, like the west building's
      makeFloor(vec(-100, -805), 500 + 2 * EXT, 350 + 2 * EXT, "#a08050", {
        level: 0,
        visibleFrom: [0],
        zoom: 1.6,
      }),
      // tower's second-story floor: its footprint minus the stairwell hole
      makeFloor(vec(-157, -805), 106, 350 + 2 * EXT, "#c2a06e", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-288, -933), 156, 126, "#c2a06e", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-288, -642), 156, 56, "#c2a06e", { level: 1, visibleFrom: [1] }),
      // the stickout's roof, one level below the tower's: visible from the
      // ground and from the tower (the cake view) — hidden only from inside the
      // ground story, which its own footprint can't express (hence hideWhenIn)
      makeFloor(vec(23, -805), 286, 350 + 2 * EXT, "#96593f", {
        level: 1,
        visibleFrom: [0, 1],
        hideWhenIn: [fpr(0)],
      }),
      // the tower roof: same footprint — hidden from anywhere inside, z 0 or 1
      makeFloor(vec(-235, -805), 262, 350 + 2 * EXT, "#8a4f3d", {
        level: 2,
        visibleFrom: [0, 1],
        hideWhenIn: [fpr(0), fpr(1)],
      }),
    );

    // interior staircase in the tower: north end is upstairs (z=1)
    stairs.push(makeStairs(vec(-270, -770), 120, 200, "y", 1, 0, [0, 1], "#7c6034"));
  }

  // --- bunker (east) ---------------------------------------------------------
  // A building sunk one level down: outdoor stairs descend north into a room at
  // z=-1 whose "roof" is an *enclosing* ceiling at ground level. Step under it
  // and the cap hides the entire surface world (underground backdrop takes
  // over); from above (or from a trench) the ceiling seals the interior.
  {
    stairs.push(makeStairs(vec(700, 160), 120, 200, "y", -1, 0, [-1, 0], "#6e6e74"));
    floors.push(
      makeFloor(vec(760, -90), 480 + 2 * EXT, 300 + 2 * EXT, "#5b5e66", {
        level: -1,
        visibleFrom: [-1],
      }),
      // the ceiling: a dirt slab at ground level covering the room (not the stairs)
      makeFloor(vec(760, -90), 480 + 2 * EXT, 300 + 2 * EXT, "#57503f", {
        level: 0,
        visibleFrom: { atLeast: -1 },
        enclosing: true,
      }),
    );
    obstacles.push(
      makeWall(vec(760, -240), 480 + WALL_T, WALL_T, -1), // north
      makeWall(vec(520, -90), WALL_T, 300 + WALL_T, -1), // west
      makeWall(vec(1000, -90), WALL_T, 300 + WALL_T, -1), // east
      makeWall(vec(580, 60), 120, WALL_T, -1), // south, west of the stair opening
      makeWall(vec(880, 60), 240, WALL_T, -1), // south, east of the stair opening
    );
    // Rail both open sides of the descent, at both levels it touches — without
    // these you could sidestep off the flight at z=-1 into the open ground and
    // vanish. (This is the map-design answer to "walked sideways off the stairs".)
    obstacles.push(
      makeFence(vec(640, 160), 14, 200, 0),
      makeFence(vec(640, 160), 14, 200, -1),
      makeFence(vec(760, 160), 14, 200, 0),
      makeFence(vec(760, 160), 14, 200, -1),
    );
  }

  // --- trench (south) --------------------------------------------------------
  // An *open-air* dig at z=-1: no ceiling, so the cap never engages and the
  // surface world stays visible from inside (and the trench floor is visible
  // from above — you can look right down into it). Stairs descend eastward at
  // the west end; fences rim the hole so nobody walks in off the grass.
  {
    stairs.push(makeStairs(vec(-50, 480), 200, 120, "x", 0, -1, [-1, 0], "#6e6349"));
    floors.push(
      makeFloor(vec(200, 480), 300 + 2 * EXT, 120 + 2 * EXT, "#7a5f3a", {
        level: -1,
        visibleFrom: { atLeast: -1 },
      }),
    );
    // trench sides (z=-1) hold the occupants in...
    obstacles.push(
      makeWall(vec(200, 420), 300 + WALL_T, WALL_T, -1), // north
      makeWall(vec(200, 540), 300 + WALL_T, WALL_T, -1), // south
      makeWall(vec(350, 480), WALL_T, 120 + WALL_T, -1), // east
    );
    // ...and a fence rims the hole at ground level (shoot across, don't fall in)
    obstacles.push(
      makeFence(vec(200, 420), 300, 14, 0),
      makeFence(vec(200, 540), 300, 14, 0),
      makeFence(vec(350, 480), 14, 120, 0),
    );
    // stair rails, at both levels the flight touches
    obstacles.push(
      makeFence(vec(-50, 420), 200, 14, 0),
      makeFence(vec(-50, 420), 200, 14, -1),
      makeFence(vec(-50, 540), 200, 14, 0),
      makeFence(vec(-50, 540), 200, 14, -1),
    );
  }

  // --- pathfinding nodes -------------------------------------------------------
  // A coarse hand-placed mesh: the open field, each building interior, the
  // stair mouths (a node on a stair's half belongs to that half's z), the
  // bunker, and the trench. Neighbors are kept within nav.ts's MOVE_RADIUS and
  // clear of obstacle corners by more than a body radius, so the movable graph
  // connects the whole map. Select a node in the editor to see its links.
  const N = (x: number, y: number, z = 0): PathNode => makeNode(vec(x, y), z);
  const nodes: PathNode[] = [
    // open field (z=0), routed around the three freestanding walls + crates
    N(0, 60), N(250, 320), N(-200, 340), N(-450, 200), N(-480, -100), N(-480, -350),
    N(-600, -200), N(-150, -100), N(140, -250), N(450, -150), N(450, -450),
    N(110, -470), N(-230, -420),
    // cake building (north): door approach, stickout interior, stair base, tower top
    N(-20, -560), N(-30, -750), N(-270, -690), N(-270, -900, 1),
    // west building: door approach, interior (x2 — the second threads past the
    // stair railing), stair base, upstairs landing, second story, balcony
    N(-790, -180), N(-790, -400), N(-900, -330), N(-1070, -310), N(-1070, -560, 1),
    N(-822, -450, 1), N(-550, -450, 1),
    // bunker (east): field approaches, stair mouth, interior
    N(500, 150), N(550, 350), N(700, 280), N(700, -60, -1), N(760, -150, -1),
    // trench (south): west approach, inside
    N(-220, 480), N(120, 480, -1), N(280, 480, -1),
  ];

  const world: World = { obstacles, floors, stairs, nodes, items: [], vehicles: [], bullets: [], projectiles: [], particles: [] };
  sortRenderDepth(world); // bake the render order once (all default depths here)
  return world;
}

/** Does any vehicle on level `z` have a solid, non-permeable part crossing the
 *  segment a->b? Used to shield a blast (and reusable for any hull-occlusion
 *  test). Guarded on an empty vehicle list by the callers. */
export function vehicleBlocksSegment(vehicles: readonly Vehicle[], a: Vec2, b: Vec2, z: number): boolean {
  for (const v of vehicles) {
    if (v.z === z && v.blocksSegment(a, b)) return true;
  }
  return false;
}

const BACKOUT_STEPS = 10; // max steps to walk a bullet out of what it hit
const BACKOUT_STEP = 4; // world px per back-out step

/**
 * Walk `pos` backward along `back` (a unit vector) until it's no longer `inside`
 * the thing it hit, so debris spawns on the surface rather than buried in it.
 * Capped at `BACKOUT_STEPS` to avoid pathological loops.
 */
function backOut(pos: Vec2, back: Vec2, inside: (p: Vec2) => boolean): Vec2 {
  let p = pos;
  for (let i = 0; i < BACKOUT_STEPS && inside(p); i++) {
    p = add(p, scale(back, BACKOUT_STEP));
  }
  return p;
}

const SUBSTEPS = 10; // sub-tick collision samples along each bullet's path

/**
 * Advance all bullets one tick and drop any that expire or hit something. To stop
 * fast bullets tunneling through thin walls / past characters, collision is sampled
 * at SUBSTEPS points along the path this tick (not just at the endpoint).
 *
 * `targets` are the hittable characters; a bullet never collides with its own
 * owner (you can't shoot yourself), and only interacts with obstacles/characters
 * on its own z level.
 */
export function updateBullets(w: World, targets: readonly Hittable[]): void {
  const alive: Bullet[] = [];
  for (const b of w.bullets) {
    b.life -= 1;
    if (b.life <= 0) continue;

    const start = b.pos;
    const step = scale(b.vel, 1 / SUBSTEPS);
    const backDir = norm(scale(b.vel, -1)); // debris flies back toward the shooter

    let consumed = false;
    for (let i = 1; i <= SUBSTEPS && !consumed; i++) {
      const sample = add(start, scale(step, i));

      // Obstacles (walls/crates) on this bullet's level block first. Fences
      // (permeable) never stop bullets. The spatial index finds the struck wall
      // in one cell lookup; without it (editor/no index), scan the array.
      let struck: Obstacle | null = null;
      if (w.grid) {
        struck = w.grid.hit(sample, b.z);
      } else {
        for (const o of w.obstacles) {
          if (o.z !== b.z || o.permeable) continue;
          if (pointInObstacle(sample, o)) {
            struck = o;
            break;
          }
        }
      }
      if (struck) {
        const at = backOut(sample, backDir, (p) => pointInObstacle(p, struck!));
        spawnParticles(w.particles, at, backDir, struck.particle, b.z);
        consumed = true;
        break;
      }

      // Vehicle hulls (solid, non-permeable parts) stop rounds — for EVERYONE,
      // including the shooter's own vehicle. Cover is bidirectional: a round that
      // can't get IN can't get OUT, so an enclosed seat is bulletproof but also
      // can't fire a personal weapon out (the turret muzzle sits outside the hull).
      if (w.vehicles.length) {
        let hb: Box | null = null;
        for (const v of w.vehicles) {
          if (v.z !== b.z) continue;
          hb = v.roundPartAt(sample);
          if (hb) break;
        }
        if (hb) {
          const at = backOut(sample, backDir, (p) => pointInBox(p, hb!));
          spawnParticles(w.particles, at, backDir, WALL_SHRAPNEL, b.z);
          consumed = true;
          break;
        }
      }

      // Then characters on this level (never the shooter).
      for (const t of targets) {
        if (t === b.owner || t.z !== b.z) continue;
        if (dist(sample, t.pos) < BODY_RADIUS) {
          t.registerHit(norm(b.vel), sample, b.damage, b.armorPen, b.owner);
          const at = backOut(sample, backDir, (p) => dist(p, t.pos) < BODY_RADIUS);
          spawnParticles(w.particles, at, backDir, BLOOD, b.z);
          consumed = true;
          break;
        }
      }
    }

    if (consumed) continue;

    // No hit along the path: commit the full move.
    b.prev = start;
    b.pos = add(start, b.vel);
    alive.push(b);
  }
  w.bullets = alive;

  w.particles = updateParticles(w.particles);
}

/**
 * Spawn a bullet travelling along `dir` at `speed` from `origin`, at level `z`
 * (the shooter's). `renderAfter` is how far it must travel before it's drawn (so
 * it stays hidden inside the gun). `owner` is the shooter, protected from its
 * own bullet until it clears them.
 */
export function spawnBullet(
  w: World,
  origin: Vec2,
  dir: Vec2,
  speed: number,
  life: number,
  renderAfter: number,
  owner: Hittable | null,
  damage: number,
  tracerWidth: number,
  tracerLength: number,
  tracerColor: string,
  armorPen: ArmorPen,
  z: number,
): void {
  w.bullets.push({
    pos: origin,
    prev: origin,
    vel: scale(dir, speed),
    z,
    life,
    origin,
    renderAfter,
    owner,
    damage,
    tracerWidth,
    tracerLength,
    tracerColor,
    armorPen,
  });
}

/** The 8 evenly-spaced offsets on the body's silhouette (radius BODY_RADIUS about
 *  the head centre). With the centre itself these are the 9 points explode() rays
 *  toward to measure how exposed a target is — see the v/9 coverage factor. */
const BLAST_SAMPLES: readonly Vec2[] = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2;
  return vec(Math.cos(a) * BODY_RADIUS, Math.sin(a) * BODY_RADIUS);
});

/**
 * Detonate an area-of-effect blast at `at` on level `z`. Every character on that
 * level within `radius` of its near edge takes damage on two independent scales:
 *   - RANGE: a linear falloff `1 - edge/radius`, measured to the body's near edge
 *     (`edge = max(0, dist - BODY_RADIUS)`), so it's full while the body circle
 *     overlaps the centre and tapers to 0 at the radius.
 *   - COVER: `v / 9`, where v is how many of 9 points on the target (its centre
 *     plus 8 around its silhouette) have clear line of sight back to the blast —
 *     so a target with only a shoulder poking past a wall takes a sliver, and one
 *     fully behind cover takes nothing. Walls and solid vehicle hulls block a ray;
 *     fences (permeable) don't, matching the bullet/sight rule.
 * Damage = `damage * (1 - edge/radius) * (v/9)`, dealt through the normal hit
 * pipeline so kill crediting works exactly as for a bullet, with the shooter as
 * attacker.
 *
 * Friendly fire is intentional and total: the owner and their teammates are NOT
 * spared — anyone in the radius is hit. (Kill *crediting* still filters to hostile
 * teams; see the gamemode's onDeath.)
 */
export function explode(
  w: World,
  at: Vec2,
  z: number,
  damage: number,
  radius: number,
  armorPen: ArmorPen,
  owner: Hittable | null,
  targets: readonly Hittable[],
  blast: readonly ParticleStyle[] = STANDARD_EXPLOSION,
): void {
  // A ray from the blast to `p` is clear unless a wall or a solid vehicle hull
  // stands in it (grid.blocked / hasLineOfSight both skip permeable fences).
  const rayClear = (p: Vec2): boolean =>
    !(w.grid ? w.grid.blocked(at, p, z) : !hasLineOfSight(at, p, w.obstacles, z)) &&
    !vehicleBlocksSegment(w.vehicles, at, p, z);

  for (const t of targets) {
    // Cheap discards first, before any raycasting: wrong level, or too far for the
    // range falloff to leave anything (near edge at/beyond the radius => frac <= 0).
    if (t.z !== z) continue;
    const d = dist(at, t.pos);
    const edge = Math.max(0, d - BODY_RADIUS);
    if (edge >= radius) continue;
    const frac = 1 - edge / radius;

    // Coverage: count how many of the 9 sample points can see the blast.
    let v = rayClear(t.pos) ? 1 : 0;
    for (const off of BLAST_SAMPLES) {
      if (rayClear(vec(t.pos.x + off.x, t.pos.y + off.y))) v++;
    }
    if (v === 0) continue; // fully behind cover

    const dir = d > 1e-6 ? norm(sub(t.pos, at)) : vec(1, 0); // knockback points outward
    t.registerHit(dir, t.pos, damage * frac * (v / 9), armorPen, owner);
  }
  // Detonation visuals: each burst in the round's blast preset (see ProjectileSpec
  // .explosion). spread is a full circle, so the ejection direction is irrelevant.
  for (const style of blast) spawnParticles(w.particles, at, vec(1, 0), style, z);
}

/**
 * Advance all projectiles one tick, detonating any that hit a wall / a non-owner
 * body (sub-stepped like bullets so a fast round can't tunnel) or that reach the
 * end of their life mid-air. Mirrors updateBullets, but every terminal event is an
 * `explode` rather than a single-target hit.
 */
export function updateProjectiles(w: World, targets: readonly Hittable[]): void {
  const alive: Projectile[] = [];
  for (const p of w.projectiles) {
    p.life -= 1;
    if (p.life <= 0) {
      explode(w, p.pos, p.z, p.damage, p.radius, p.armorPen, p.owner, targets, p.explosion); // airburst at max range
      continue;
    }

    const start = p.pos;
    const step = scale(p.vel, 1 / SUBSTEPS);
    const backDir = norm(scale(p.vel, -1)); // toward the shooter, to back out of a wall
    let detonated = false;
    for (let i = 1; i <= SUBSTEPS && !detonated; i++) {
      const sample = add(start, scale(step, i));

      // Walls/crates on this level detonate it (fences are permeable, like bullets).
      let struck: Obstacle | null = null;
      if (w.grid) {
        struck = w.grid.hit(sample, p.z);
      } else {
        for (const o of w.obstacles) {
          if (o.z !== p.z || o.permeable) continue;
          if (pointInObstacle(sample, o)) {
            struck = o;
            break;
          }
        }
      }
      if (struck) {
        // Detonate at the wall's face, not embedded in it — otherwise the blast's
        // own cover check would read the struck wall as shielding everything in
        // front of it. (Same back-out updateBullets does for its impact debris.)
        const at = backOut(sample, backDir, (pt) => pointInObstacle(pt, struck!));
        explode(w, at, p.z, p.damage, p.radius, p.armorPen, p.owner, targets, p.explosion);
        detonated = true;
        break;
      }

      // Vehicle hulls detonate a rocket too (so you can shell a tank), any hull
      // included — a turret round already spawns from a muzzle OUTSIDE its own hull,
      // so it clears without needing an owner exemption (cover is bidirectional).
      if (w.vehicles.length) {
        for (const v of w.vehicles) {
          if (v.z !== p.z) continue;
          const hb = v.roundPartAt(sample);
          if (hb) {
            const at = backOut(sample, backDir, (pt) => pointInBox(pt, hb));
            explode(w, at, p.z, p.damage, p.radius, p.armorPen, p.owner, targets, p.explosion);
            detonated = true;
            break;
          }
        }
        if (detonated) break;
      }

      // A body other than the shooter detonates it on contact.
      for (const t of targets) {
        if (t === p.owner || t.z !== p.z) continue;
        if (dist(sample, t.pos) < BODY_RADIUS + p.bodyRadius) {
          explode(w, sample, p.z, p.damage, p.radius, p.armorPen, p.owner, targets, p.explosion);
          detonated = true;
          break;
        }
      }
    }

    if (detonated) continue;

    p.prev = start;
    p.pos = add(start, p.vel);
    alive.push(p);
  }
  w.projectiles = alive;
}

/**
 * Spawn an AoE projectile travelling along `dir` at `speed` from `origin`, on the
 * shooter's level `z`. Blast is described by `damage`/`radius`/`armorPen`; `life`
 * caps both fuse and range (speed * life). See spawnBullet for the shared
 * origin/renderAfter/owner conventions.
 */
export function spawnProjectile(
  w: World,
  origin: Vec2,
  dir: Vec2,
  speed: number,
  life: number,
  renderAfter: number,
  owner: Hittable | null,
  damage: number,
  radius: number,
  armorPen: ArmorPen,
  bodyRadius: number,
  color: string,
  trailColor: string,
  z: number,
  sprite?: string,
  spriteScale?: number,
  explosion?: readonly ParticleStyle[],
): void {
  w.projectiles.push({
    pos: origin,
    prev: origin,
    vel: scale(dir, speed),
    z,
    life,
    origin,
    renderAfter,
    owner,
    damage,
    radius,
    armorPen,
    bodyRadius,
    color,
    trailColor,
    sprite,
    spriteScale,
    explosion,
  });
}
