/**
 * The visibility polygon: the region of level `z` a viewer at `from` has a
 * straight, unblocked line to. The renderer masks everything outside it (see
 * the sight mask in main.ts) on levels flagged `meta.visibility`.
 *
 * Classic corner-raycast construction. Every occluder is a polygon; gather all
 * their edges plus the viewport rect, then cast a ray from the viewer toward
 * every corner and at ±epsilon around it (the corner ray hits the corner, the
 * side rays slide past it to whatever is behind — that pair is what makes
 * shadows have edges). Each ray stops at the nearest edge it crosses; the hit
 * points sorted by angle are the polygon. The viewport rect is in the edge set
 * so every ray lands somewhere.
 *
 * Corners alone are not enough where edges CROSS — a wall running out through
 * the viewport rect, or two overlapping walls — because the visible boundary
 * turns there without a corner to aim at, and the polygon would cut a chord
 * across the turn. So every edge-edge crossing point is a ray target too.
 *
 * An optional vision cone (the weapon's, see GunSpec.visionCone) cuts the
 * region further to a wedge around the aim that curves down into a grace
 * disc (see SHOULDER); it is folded into the cast rather than intersected
 * afterwards — see below.
 *
 * What blocks sight matches the game's own rule (hasLineOfSight / losClear):
 * same-level obstacles that aren't permeable (fences don't block), and solid,
 * non-permeable vehicle parts. Round obstacles are approximated as polygons.
 * Only occluders touching the viewport count: an occluder wholly outside a
 * convex viewport centred on the viewer casts its shadow further out still.
 *
 * Cost is rays x edges (3 rays per corner, ~4 corners per box), so it scales
 * with the square of what's on screen; typical maps land in the low hundreds
 * of edges, well under a millisecond.
 */
import type { AABB } from "../engine/collision.ts";
import { obstacleRadius, worldAabb } from "../engine/collision.ts";
import { rectCorners } from "../engine/poly.ts";
import type { Vec2 } from "../engine/vec.ts";
import type { World } from "./world.ts";

/** Angular offset of the two side rays around each corner ray. */
const EPS = 1e-4;
/** Polygon sides used to stand in for a round obstacle. */
const CIRCLE_SIDES = 12;
/** Angular step between vertices along the grace circle's arc. */
const ARC_STEP = (4 * Math.PI) / 180;
/** Angular step between vertices along the cone's curved shoulders, where
 *  the boundary bends fastest. */
const SHOULDER_STEP = (2 * Math.PI) / 180;
/**
 * How the cone blends into the grace circle. Past the cone's edge the visible
 * radius is grace / sin(angle past the edge)^SHOULDER, down to the grace
 * radius a quarter turn out. At 1 that is a straight line tangent to the
 * circle (the convex "ice-cream cone"); below 1 the boundary bows inward from
 * that line, so the shape stays a cone that fades into the circle rather than
 * one that widens toward the player. Smaller = tighter to the cone edge.
 */
const SHOULDER = 0.5;

/** Radius of the grace circle: what the player sees all round regardless of
 *  the weapon's cone (still not through walls), world px. */
export const VISION_GRACE_R = 80;

/** A vision cone: the polygon is further cut to a wedge of `halfAngle` either
 *  side of `dir` plus a disc of `grace` around the viewer. */
export interface SightCone {
  /** Aim direction (any length). */
  dir: Vec2;
  /** Half the cone's full angular width, radians. */
  halfAngle: number;
  grace: number;
}

/** Wrap an angle into (-π, π]. */
function wrap(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function visibilityPolygon(world: World, from: Vec2, z: number, bounds: AABB, cone?: SightCone): Vec2[] {
  // Edges as flat parallel arrays (a hot loop below runs over them).
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const addPoly = (poly: readonly Vec2[]): void => {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      ax.push(p.x);
      ay.push(p.y);
      bx.push(q.x);
      by.push(q.y);
    }
  };
  const inBounds = (a: AABB): boolean =>
    a.maxx >= bounds.minx && a.minx <= bounds.maxx && a.maxy >= bounds.miny && a.miny <= bounds.maxy;

  for (const o of world.obstacles) {
    if (o.z !== z || o.permeable || !inBounds(worldAabb(o))) continue;
    if (o.round) {
      const r = obstacleRadius(o);
      const poly: Vec2[] = [];
      for (let i = 0; i < CIRCLE_SIDES; i++) {
        const t = (i / CIRCLE_SIDES) * Math.PI * 2;
        poly.push({ x: o.pos.x + r * Math.cos(t), y: o.pos.y + r * Math.sin(t) });
      }
      addPoly(poly);
    } else {
      addPoly(rectCorners(o.pos, o.w, o.h, o.angle));
    }
  }
  for (const v of world.vehicles) {
    if (v.z !== z) continue;
    for (const pw of v.worldParts()) {
      if ((pw.spec.solid ?? true) && !pw.spec.permeable) {
        addPoly(rectCorners(pw.box.pos, pw.box.w, pw.box.h, pw.box.angle));
      }
    }
  }
  addPoly([
    { x: bounds.minx, y: bounds.miny },
    { x: bounds.maxx, y: bounds.miny },
    { x: bounds.maxx, y: bounds.maxy },
    { x: bounds.minx, y: bounds.maxy },
  ]);
  const n = ax.length;

  // Ray targets: every corner (each starts exactly one edge) plus every point
  // where two edges cross in their interiors.
  const tx: number[] = ax.slice();
  const ty: number[] = ay.slice();
  for (let i = 0; i < n; i++) {
    const ex = bx[i] - ax[i];
    const ey = by[i] - ay[i];
    const iminx = Math.min(ax[i], bx[i]);
    const imaxx = Math.max(ax[i], bx[i]);
    const iminy = Math.min(ay[i], by[i]);
    const imaxy = Math.max(ay[i], by[i]);
    for (let j = i + 1; j < n; j++) {
      if (Math.min(ax[j], bx[j]) > imaxx || Math.max(ax[j], bx[j]) < iminx) continue;
      if (Math.min(ay[j], by[j]) > imaxy || Math.max(ay[j], by[j]) < iminy) continue;
      const fx = bx[j] - ax[j];
      const fy = by[j] - ay[j];
      const den = ex * fy - ey * fx;
      if (den > -1e-12 && den < 1e-12) continue;
      const gx = ax[j] - ax[i];
      const gy = ay[j] - ay[i];
      const t = (gx * fy - gy * fx) / den;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const u = (gx * ey - gy * ex) / den;
      if (u <= 1e-9 || u >= 1 - 1e-9) continue;
      tx.push(ax[i] + t * ex);
      ty.push(ay[i] + t * ey);
    }
  }

  // The cone, folded into the same cast: outside the wedge every ray is cut
  // to the cone's radius at that angle (coneCap), so the region stays
  // star-shaped and the vertices are still just ray hits. Extra events: the
  // wedge's two edge rays (with side rays, for the radial cut), where every
  // occluder edge crosses the grace circle (so a wall crossing the round back
  // puts a vertex exactly on the crossing, not a chord), and samples along
  // the curved parts. A wall crossing a shoulder gets no exact event — the
  // shoulder samples are dense enough that the chord error is a few px.
  const coneOn = cone !== undefined && cone.halfAngle < Math.PI;
  const dirA = coneOn ? Math.atan2(cone.dir.y, cone.dir.x) : 0;
  const half = coneOn ? cone.halfAngle : Math.PI;
  const grace = coneOn ? cone.grace : Infinity;
  /** The cone's radius cap along a ray at angle `a`: none inside the wedge,
   *  the curved shoulder just past its edge, the grace radius further round. */
  const coneCap = (a: number): number => {
    if (!coneOn) return Infinity;
    const past = Math.abs(wrap(a - dirA)) - half;
    if (past <= 0) return Infinity;
    if (past >= Math.PI / 2) return grace;
    return grace / Math.pow(Math.sin(past), SHOULDER);
  };
  const angles: number[] = [];
  if (coneOn) {
    for (let i = 0; i < n; i++) {
      const ex = bx[i] - ax[i];
      const ey = by[i] - ay[i];
      const fx = ax[i] - from.x;
      const fy = ay[i] - from.y;
      const qa = ex * ex + ey * ey;
      const qb = 2 * (fx * ex + fy * ey);
      const qc = fx * fx + fy * fy - grace * grace;
      const disc = qb * qb - 4 * qa * qc;
      if (disc <= 0 || qa === 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
        if (t <= 0 || t >= 1) continue;
        tx.push(ax[i] + t * ex);
        ty.push(ay[i] + t * ey);
      }
    }
    for (const edge of [dirA - half, dirA + half]) angles.push(wrap(edge - EPS), wrap(edge), wrap(edge + EPS));
    // Vertices along the curved part: the two shoulders, then the plain arc
    // across the back. Shoulder samples are spaced quadratically — the curve
    // runs off to infinity at the cone edge, so the first steps past it are a
    // few hundredths of a degree and the last are a couple of degrees.
    const shoulder = Math.min(Math.PI / 2, Math.PI - half);
    const shoulderSteps = Math.ceil(shoulder / SHOULDER_STEP);
    for (let k = 1; k <= shoulderSteps; k++) {
      const d = shoulder * (k / shoulderSteps) ** 2;
      angles.push(wrap(dirA + half + d), wrap(dirA - half - d));
    }
    const back = 2 * Math.PI - 2 * half - 2 * shoulder;
    if (back > 0) {
      const steps = Math.max(1, Math.ceil(back / ARC_STEP));
      for (let k = 1; k < steps; k++) angles.push(wrap(dirA + half + shoulder + (k * back) / steps));
    }
  }

  // One ray at each target plus two side rays, sorted by angle.
  for (let i = 0; i < tx.length; i++) {
    const a = Math.atan2(ty[i] - from.y, tx[i] - from.x);
    angles.push(a - EPS, a, a + EPS);
  }
  angles.sort((p, q) => p - q);

  const out: Vec2[] = [];
  let prev = NaN;
  for (const a of angles) {
    if (a === prev) continue; // shared corners cast the same ray twice
    prev = a;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // Nearest edge along the ray: ray = from + t*d, edge = A + u*(B-A).
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const ex = bx[i] - ax[i];
      const ey = by[i] - ay[i];
      const denom = dx * ey - dy * ex;
      if (denom > -1e-12 && denom < 1e-12) continue; // parallel
      const fx = ax[i] - from.x;
      const fy = ay[i] - from.y;
      const t = (fx * ey - fy * ex) / denom;
      if (t <= 0 || t >= best) continue;
      const u = (fx * dy - fy * dx) / denom;
      if (u >= 0 && u <= 1) best = t;
    }
    if (best === Infinity) continue; // can't happen with the bounds rect in play
    const cap = coneCap(a);
    if (best > cap) best = cap;
    out.push({ x: from.x + dx * best, y: from.y + dy * best });
  }
  return out;
}
