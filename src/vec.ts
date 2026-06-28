export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** Rotate +90° in screen space (y-down). Points "to the right" of a forward vector. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

/** Rotate by `ang` radians (positive = clockwise on screen, since y points down). */
export const rotate = (a: Vec2, ang: number): Vec2 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

export const fromAngle = (ang: number, r = 1): Vec2 => ({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

export const deg2rad = (d: number): number => (d * Math.PI) / 180;

/**
 * Intersection points of two circles. Returns the two points, or null when the
 * circles are too far apart, one contains the other, or are concentric.
 */
export function circleIntersect(
  c0: Vec2,
  r0: number,
  c1: Vec2,
  r1: number,
): [Vec2, Vec2] | null {
  const d = dist(c0, c1);
  if (d === 0) return null;
  if (d > r0 + r1) return null;
  if (d < Math.abs(r0 - r1)) return null;

  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const hSq = r0 * r0 - a * a;
  if (hSq < 0) return null;
  const h = Math.sqrt(hSq);

  const dir = norm(sub(c1, c0));
  const base = add(c0, scale(dir, a));
  const off = scale(perp(dir), h);
  return [add(base, off), sub(base, off)];
}
