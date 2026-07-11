/**
 * The DominationOracle: a TacOracle that fights the same way but, with no enemy
 * currently in its sights, works the objective instead of hunting the nearest
 * hostile. It's a thin override — combat, run, heal, and crowd behaviour are all
 * inherited; only the out-of-combat destination changes.
 *
 * The loop it wants: walk to the nearest capture point that still needs work,
 * stand on it to capture/strengthen, then move to the next — fighting any enemy
 * it sees along the way (the base's selectTarget engages visible hostiles before
 * bestChase is ever consulted, so that's free). The one twist: if enemies are
 * on (or right around) the point it's headed for, they contest the capture, so
 * it hunts them down like a plain TacOracle (returns the enemy as the chase
 * target) instead of walking onto a point it can't hold. "Around" is the radius
 * plus a pad, so an enemy can't flip the behaviour by dancing across the edge.
 *
 * "Needs work" = any point we don't already own at full strength (gray,
 * enemy-held, or ours but not yet locked in). Once we own everything outright
 * there's nothing to capture, so it falls back to the base's hunt-the-nearest.
 *
 * The point destination is a throwaway marker Character parked on the objective,
 * so the base's navChase/RUN can steer toward a position; `inContact` is
 * overridden to never treat that marker as a live fight, so contact metrics keep
 * measuring real hostiles and the bot still heals when safe / re-arms when
 * enemies close on the way there.
 */
import { Character } from "../entities/actor.ts";
import { BODY_RADIUS } from "../entities/character.ts";
import { Gun } from "../entities/gun.ts";
import { UNARMED } from "../entities/guns.ts";
import { TacOracle } from "./tacoracle.ts";
import type { AiContext, ObjectivePoint } from "./robot.ts";
import { dist, vec, type Vec2 } from "../engine/vec.ts";

/** An enemy counts as contesting a point out to its radius plus this pad, so a
 *  hostile can't flip the bot between capture/hunt by dancing across the exact
 *  edge — it has to actually clear the area. */
const CONTEST_PAD = 4 * BODY_RADIUS;

/** How far outside a point's radius the bot will still let it pull its COMBAT
 *  maneuvering toward it (so a firefight near a point drags onto the point).
 *  Deliberately generous — the pull only ever picks among spots that can still
 *  shoot/cover, so a large trigger just means "fight on the point when near it". */
const OBJ_PULL_MARGIN = 10 * BODY_RADIUS; // ~300px past the ring

export class DominationOracle extends TacOracle {
  /** A throwaway waypoint (never in the world/roster) parked on the target
   *  objective, so the base's navChase can steer toward a position. */
  private objMarker: Character | null = null;

  /** Never treat the objective marker as a live enemy contact (that would zero
   *  the contact metrics and stop the bot healing/running on the way there). */
  protected override inContact(ai: AiContext, chase: Character): boolean {
    if (chase === this.objMarker) return false;
    return super.inContact(ai, chase);
  }

  /** Walk right onto the capture point — no combat standoff for the objective
   *  marker, so the bot ends up inside the radius instead of stopping ~gun-range
   *  short and hovering just off the node. */
  protected override standoffFor(chase: Character): number {
    return chase === this.objMarker ? 0 : super.standoffFor(chase);
  }

  /** Bias combat maneuvering toward the nearest point that still needs work when
   *  we're fighting near it — so an engagement on/around a capture point is waged
   *  FROM the point (capturing while shooting) rather than wherever the enemy
   *  happens to pull us. Null when the nearest workable point is too far, or we
   *  already hold it outright. */
  protected override biasObjective(ai: AiContext): { pos: Vec2; radius: number } | null {
    const objs = ai.objectives;
    if (!objs || objs.length === 0) return null;
    let best: ObjectivePoint | null = null;
    let bestD = Infinity;
    for (const o of objs) {
      if (o.owner === this.team && o.progress >= 2) continue; // fully ours: nothing to gain
      const d = dist(this.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best || bestD > best.radius + OBJ_PULL_MARGIN) return null;
    return { pos: best.pos, radius: best.radius };
  }

  /** Out-of-combat destination: the nearest capture point that still needs work.
   *  If enemies are contesting that point, hunt them down (plain TacOracle);
   *  otherwise walk onto the point to capture it. Everything owned outright →
   *  the base's nearest-enemy chase (defend). No objectives → same. */
  protected override bestChase(ai: AiContext): Character | null {
    const objs = ai.objectives;
    if (!objs || objs.length === 0) return super.bestChase(ai);

    // Nearest (straight-line) point we don't already hold at full strength.
    let best: ObjectivePoint | null = null;
    let bestD = Infinity;
    for (const o of objs) {
      if (o.owner === this.team && o.progress >= 2) continue; // already ours, fully locked
      const d = dist(this.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best) return super.bestChase(ai); // we own it all — go hunt/defend

    // Enemies on (or right around) that point contest the capture: hunt the
    // nearest one down like a normal TacOracle rather than crowding onto a point
    // we can't hold. The pad past the radius stops an enemy from toggling us by
    // stepping across the exact edge.
    const contestRange = best.radius + CONTEST_PAD;
    let contester: Character | null = null;
    let contesterD = Infinity;
    for (const h of this.hostiles(ai)) {
      if (h.z !== best.z || dist(h.pos, best.pos) > contestRange) continue;
      const d = dist(this.pos, h.pos);
      if (d < contesterD) {
        contesterD = d;
        contester = h;
      }
    }
    if (contester) return contester;

    // Clear point: walk onto it. The marker steers navChase to a spot, but the
    // base navigates by routing to the nearest graph node that can SEE the goal —
    // and a point's exact centre can sit in a wall with no node that sees or even
    // walks to it (a stranding freeze). So aim at the nearest nav node on the
    // point's level instead: standing there is inside the radius (so it captures)
    // and a real graph node always has a route.
    const spot = this.captureSpot(ai, best);
    const m = (this.objMarker ??= new Character(vec(0, 0), this.skin, { hand: new Gun(UNARMED) }));
    m.pos = vec(spot.x, spot.y);
    m.z = best.z;
    m.hp = 1; // kept "alive" so it's a valid chase target
    return m;
  }

  /** Where to stand to work `pt`: the nearest nav node on its level (navigation
   *  needs a real graph node as its goal), falling back to the centre only if the
   *  graph has no node on that level. */
  private captureSpot(ai: AiContext, pt: ObjectivePoint): Vec2 {
    let bestPos: Vec2 = pt.pos;
    let bestD = Infinity;
    if (ai.nav) {
      for (const n of ai.nav.nodes) {
        if (n.z !== pt.z) continue;
        const d = dist(n.pos, pt.pos);
        if (d < bestD) {
          bestD = d;
          bestPos = n.pos;
        }
      }
    }
    return bestPos;
  }
}
