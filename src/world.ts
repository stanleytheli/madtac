import { BODY_RADIUS } from "./character.ts";
import { pointInBox } from "./collision.ts";
import {
  BLOOD,
  CRATE_SHRAPNEL,
  WALL_SHRAPNEL,
  spawnParticles,
  updateParticles,
  type Particle,
  type ParticleStyle,
} from "./particle.ts";
import type { GroundItem } from "./item.ts";
import type { ArmorPen } from "./guns.ts";
import { add, dist, norm, scale, vec, type Vec2 } from "./vec.ts";

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
 *  obstacles and floors). Used as a viewer-position trigger — see hideWhenIn. */
export interface Region {
  pos: Vec2;
  w: number;
  h: number;
}

/**
 * A solid, axis-aligned box that blocks movement, bullets, and line of sight —
 * but only against things on its own z level. Crates and walls are both
 * Obstacles, differing only in appearance + shrapnel.
 */
export interface Obstacle {
  pos: Vec2; // center
  w: number;
  h: number;
  z: number; // the level it sits on
  /** Fence-like: still solid to movement, but bullets and sight pass through, so
   *  same-level firefights work across it. (Bullets stay z-bound regardless —
   *  a fence never enables shooting between levels.) */
  permeable?: boolean;
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
  color: string;
  /** The z level the surface physically sits at. */
  level: number;
  /** Which viewer z values can see it (e.g. a balcony: [0, 1]; the ground: z >= 0). */
  visibleFrom: ZSet;
  /** Also hide it while the viewer is beneath it and inside its footprint (roofs). */
  hideWhenUnder?: boolean;
  /** Also hide it while the viewer is beneath its *level* and inside any of
   *  these regions — hideWhenUnder with the trigger decoupled from the
   *  surface's own rect. This is how a wedding-cake building's lower roof
   *  works: it lists the whole ground-story interior, so it clears out when
   *  you're anywhere inside that room (not just directly under the overhang),
   *  yet stays put while you look down on it from the story above. */
  hideWhenIn?: readonly Region[];
  /** A solid ceiling: while the viewer is beneath it and inside its footprint,
   *  the *whole world* at this level and above is hidden — background included
   *  (see enclosureCap). This is the "sealed underground" rule: a bunker is
   *  just a room at z=-1 whose enclosing ceiling sits at level 0, while an
   *  open-air trench has no ceiling and keeps the surface world in view. */
  enclosing?: boolean;
  /** Covers the whole map (the ground): drawn as the screen background, and its
   *  level needs no clip mask — everything at that level is backed by it. */
  infinite?: boolean;
  /** Grid line color when this is drawn as the background (infinite floors). */
  grid?: string;
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
  /** The axis you climb along; z changes as you cross the rect's midpoint. */
  axis: "x" | "y";
  /** z at the min-coordinate end / max-coordinate end along `axis`. */
  zAtMin: number;
  zAtMax: number;
  visibleFrom: ZSet;
  steps: number;
  /** Base step color; steps lighten toward the higher-z end. */
  color: string;
  /** Eased render opacity, like a floor's. */
  alpha: number;
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

export interface FloorOptions {
  level: number;
  visibleFrom: ZSet;
  hideWhenUnder?: boolean;
  hideWhenIn?: readonly Region[];
  enclosing?: boolean;
  infinite?: boolean;
  grid?: string;
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
  steps = 8,
): Stairs {
  return { pos, w, h, axis, zAtMin, zAtMax, visibleFrom, color, steps, alpha: 1 };
}

/**
 * The z a point standing on these stairs belongs to, or null if it's outside the
 * stair rect. Sharp: the near half of the rect is one level, the far half the
 * other, so walking across the midpoint is the transition.
 */
export function stairZ(s: Stairs, p: Vec2): number | null {
  const minx = s.pos.x - s.w / 2;
  const miny = s.pos.y - s.h / 2;
  if (p.x < minx || p.x > minx + s.w || p.y < miny || p.y > miny + s.h) return null;
  const t = s.axis === "x" ? (p.x - minx) / s.w : (p.y - miny) / s.h;
  return t < 0.5 ? s.zAtMin : s.zAtMax;
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
 *  roof-style hiding (by the surface's own footprint, or by explicit regions). */
export function floorVisible(f: Floor, viewerZ: number, viewerPos: Vec2, cap = Infinity): boolean {
  if (f.level >= cap) return false;
  if (!zsetHas(f.visibleFrom, viewerZ)) return false;
  if (viewerZ < f.level) {
    if (f.hideWhenUnder && pointInBox(viewerPos, f)) return false;
    if (f.hideWhenIn && f.hideWhenIn.some((r) => pointInBox(viewerPos, r))) return false;
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
  registerHit(dir: Vec2, point: Vec2, damage: number, armorPen: ArmorPen): void;
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

/** Static map data plus live projectiles, particle debris, and ground items. */
export interface World {
  obstacles: Obstacle[]; // solid: crates + walls
  floors: Floor[]; // walkable surfaces (incl. the infinite ground) + roofs
  stairs: Stairs[]; // z-level connectors
  items: GroundItem[]; // pickups lying on the ground
  bullets: Bullet[];
  particles: Particle[];
}

export const WALL_T = 26; // shared wall thickness (demo map + editor defaults)

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
      grid: "#5ca76c",
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
      makeWall(vec(-900, -650), 500 + WALL_T, WALL_T, 1), // north
      makeWall(vec(-1150, -450), WALL_T, 400 + WALL_T, 1), // west
      makeWall(vec(-900, -250), 500 + WALL_T, WALL_T, 1), // south (no door up here)
      makeWall(vec(-650, -570), WALL_T, 160, 1), // east, north of the balcony door
      makeWall(vec(-650, -330), WALL_T, 160, 1), // east, south of the balcony door
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
      // ground-floor interior (hidden by the roof until you walk in)
      makeFloor(vec(-900, -450), 500 + 2 * EXT, 400 + 2 * EXT, "#9c7444", {
        level: 0,
        visibleFrom: [0],
      }),
      // second-story floor: the footprint minus the stairwell hole (three rects)
      makeFloor(vec(-822, -450), 376, 400 + 2 * EXT, "#b99664", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-1088, -573), 156, 186, "#b99664", { level: 1, visibleFrom: [1] }),
      makeFloor(vec(-1088, -257), 156, 46, "#b99664", { level: 1, visibleFrom: [1] }),
      // the balcony: z=1, seen from the ground and from up there (the overhang);
      // extends slightly past its railings' outer faces
      makeFloor(vec(-550, -450), 170, 180, "#b5ab97", { level: 1, visibleFrom: [0, 1], hideWhenUnder: false }),
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
  // and wears its own roof one level down. Both roofs hide via hideWhenIn keyed
  // on the shared building region: the stickout roof (level 1) clears whenever
  // the viewer is anywhere inside at z=0, while the same region hides the tower
  // roof (level 2) from z=0 *and* z=1 — the viewerZ < level test does the
  // per-story split for free. From the tower you look down onto the lower roof,
  // cake-style; from outside, both roofs seal the building normally.
  {
    // The shared trigger region: the ground story's slab (walls included), so
    // the roofs start melting a step before you fully clear the doorway.
    const footprint: Region = { pos: vec(-100, -805), w: 500 + 2 * EXT, h: 350 + 2 * EXT };

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
      makeWall(vec(-235, -980), 230 + WALL_T, WALL_T, 1), // north
      makeWall(vec(-350, -805), WALL_T, 350 + WALL_T, 1), // west
      makeWall(vec(-235, -630), 230 + WALL_T, WALL_T, 1), // south
      makeWall(vec(-120, -805), WALL_T, 350 + WALL_T, 1), // east, along the cake edge
    );
    // stair rails, same reasoning as the west building's: cap the top end and
    // the open east side's upper half at z=0, the whole east side at z=1
    obstacles.push(
      makeFence(vec(-204, -815), 14, 110, 0),
      makeFence(vec(-280, -875), 110, 14, 0),
      makeFence(vec(-204, -760), 14, 210, 1),
    );

    floors.push(
      // ground-story interior: tower + stickout as one room
      makeFloor(footprint.pos, footprint.w, footprint.h, "#a08050", {
        level: 0,
        visibleFrom: [0],
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
        hideWhenIn: [footprint],
      }),
      // the tower roof: same trigger — hidden from anywhere inside, z=0 or z=1
      makeFloor(vec(-235, -805), 262, 350 + 2 * EXT, "#8a4f3d", {
        level: 2,
        visibleFrom: [0, 1],
        hideWhenIn: [footprint],
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

  return { obstacles, floors, stairs, items: [], bullets: [], particles: [] };
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
      // (permeable) never stop bullets.
      for (const o of w.obstacles) {
        if (o.z !== b.z || o.permeable) continue;
        if (pointInBox(sample, o)) {
          const at = backOut(sample, backDir, (p) => pointInBox(p, o));
          spawnParticles(w.particles, at, backDir, o.particle, b.z);
          consumed = true;
          break;
        }
      }
      if (consumed) break;

      // Then characters on this level (never the shooter).
      for (const t of targets) {
        if (t === b.owner || t.z !== b.z) continue;
        if (dist(sample, t.pos) < BODY_RADIUS) {
          t.registerHit(norm(b.vel), sample, b.damage, b.armorPen);
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
