/**
 * Domination. Sides fight over fixed capture points (DomPoints authored in the
 * editor). Each point tracks a single "max-progress" team and its PROGRESS in
 * [0, 2] — a multi-team-ready model with one moving part:
 *   - [0, 1): gray (unowned) but being captured BY the max team — progress is
 *     how far along that capture is.
 *   - [1, 2]: captured by the max team and strengthening (2 = fully locked in).
 * Every agent ON the max team raises progress; every agent NOT on it (any other
 * team) lowers it — net = (on max) − (not on max), scaled by CAPTURE_RATE. When
 * progress hits 0 the point is up for grabs: the strict-plurality team present
 * (if any) becomes the new max team and starts climbing; with no plurality the
 * max team is arbitrary and progress just sits at 0. Points start at 0.
 *
 * A point counts as CONTROLLED by its max team once progress ≥ 1. Every second,
 * each controlled point drains one ticket from the OTHER team (own 2 of 3 points
 * → the enemy bleeds 2/s while you bleed 1/s). A team whose tickets hit 0 loses.
 * Everything else (roster, spawns, respawns, scoreboard) comes from TeamMatchMode.
 */
import type { ObjectivePoint } from "../ai/robot.ts";
import type { DomConfig, TeamConfig } from "../world/level.ts";
import { TEAMS, type TeamId } from "../entities/team.ts";
import { dist } from "../engine/vec.ts";
import type { GameCtx, GamemodeHud, TeamScore } from "./gamemode.ts";
import { DEFAULT_EQUIP, resolveEquip, TeamMatchMode } from "./teammatch.ts";

/** Applied when a domination level omits some or all of `meta.domination`. */
export const DEFAULT_DOM: DomConfig = {
  scoreLimit: 100,
  respawnDelay: 120, // ticks (~2s) — objective mode, faster back into the fight
  blue: { troops: 4, skill: 0.6, equip: DEFAULT_EQUIP },
  red: { troops: 4, skill: 0.6, equip: DEFAULT_EQUIP },
};

/** A partial config (a level's `meta.domination`) before defaults. */
export interface DomOverrides {
  scoreLimit?: number;
  respawnDelay?: number;
  blue?: Partial<TeamConfig>;
  red?: Partial<TeamConfig>;
}

/** Fill any missing field of a partial domination config from DEFAULT_DOM,
 *  normalizing each side's equip to a canonical tier name (accepts legacy nums). */
export function resolveDom(o?: DomOverrides): DomConfig {
  const blue = { ...DEFAULT_DOM.blue, ...o?.blue };
  const red = { ...DEFAULT_DOM.red, ...o?.red };
  blue.equip = resolveEquip(blue.equip);
  red.equip = resolveEquip(red.equip);
  return {
    scoreLimit: o?.scoreLimit ?? DEFAULT_DOM.scoreLimit,
    respawnDelay: o?.respawnDelay ?? DEFAULT_DOM.respawnDelay,
    blue,
    red,
  };
}

/** Per-tick progress change one net agent applies (progress spans [0,2], so at
 *  0.0025 a lone capper takes a point in ~6.7s and locks it fully in ~13s). */
const CAPTURE_RATE = 0.0025;

const clamp02 = (n: number): number => Math.max(0, Math.min(2, n));

/** Live control state of one capture point: the leading ("max progress") team and
 *  its progress in [0,2] — gray-being-captured on [0,1), owned/strengthening on
 *  [1,2]. The team is meaningless while progress is 0 (arbitrary until a plurality
 *  claims it); rendering shows plain gray there. */
interface DomState {
  maxTeam: TeamId;
  progress: number;
}

const neutral = (): DomState => ({ maxTeam: "blue", progress: 0 });

/** The team with STRICTLY more agents present than any other, or null (a tie for
 *  the lead, or nobody present). */
function strictPlurality(counts: Map<TeamId, number>): TeamId | null {
  let top: TeamId | null = null;
  let topN = 0;
  let secondN = 0;
  for (const [team, n] of counts) {
    if (n > topN) {
      secondN = topN;
      topN = n;
      top = team;
    } else if (n > secondN) {
      secondN = n;
    }
  }
  return top && topN > secondN ? top : null;
}

export class DominationMode extends TeamMatchMode {
  readonly id = "domination";
  readonly label = "Domination";

  private readonly limit: number;
  private tickets = { blue: 0, red: 0 };
  /** Control state per DomPoint (index-aligned with ctx.level.domPoints). */
  private states: DomState[] = [];

  constructor(dom?: DomOverrides) {
    const cfg = resolveDom(dom);
    super({ respawnDelay: cfg.respawnDelay, blue: cfg.blue, red: cfg.red });
    this.limit = cfg.scoreLimit;
  }

  /** Domination bots seek objectives (points), not just the nearest enemy. */
  protected override get botAi(): "domination" {
    return "domination";
  }

  protected override onInit(ctx: GameCtx): void {
    this.tickets = { blue: this.limit, red: this.limit };
    this.states = ctx.level.domPoints.map(neutral);
  }

  protected override rules(ctx: GameCtx): void {
    const pts = ctx.level.domPoints;
    if (this.states.length !== pts.length) this.states = pts.map(neutral); // safety

    for (let i = 0; i < pts.length; i++) {
      this.capture(this.states[i], pts[i], ctx);
    }

    // Every second, each controlled point (progress ≥ 1) drains a ticket from
    // the other team.
    if (ctx.tick % 60 === 0) {
      let blueOwned = 0;
      let redOwned = 0;
      for (const st of this.states) {
        if (st.progress < 1) continue;
        if (st.maxTeam === "blue") blueOwned += 1;
        else if (st.maxTeam === "red") redOwned += 1;
      }
      this.tickets.red -= blueOwned;
      this.tickets.blue -= redOwned;
      if (this.tickets.blue <= 0 || this.tickets.red <= 0) this.phase = "over";
    }
  }

  /** Advance one point's control state for this tick from who's standing on it. */
  private capture(st: DomState, p: { pos: { x: number; y: number }; z: number; radius: number }, ctx: GameCtx): void {
    // Head-count live agents on the point, per team.
    const counts = new Map<TeamId, number>();
    let total = 0;
    for (const c of ctx.characters) {
      if (c.hp <= 0 || c.z !== p.z) continue;
      if (dist(c.pos, p.pos) > p.radius) continue;
      counts.set(c.team, (counts.get(c.team) ?? 0) + 1);
      total++;
    }

    // Up for grabs at rock bottom: whoever holds a strict plurality claims the
    // lead and starts climbing. No plurality → the lead stays put (arbitrary).
    if (st.progress <= 0) {
      const claimant = strictPlurality(counts);
      if (claimant) st.maxTeam = claimant;
    }

    // The max team pushes progress up; everyone else pushes it down.
    const onMax = counts.get(st.maxTeam) ?? 0;
    const net = onMax - (total - onMax);
    if (net !== 0) st.progress = clamp02(st.progress + net * CAPTURE_RATE);
  }

  protected override teamScores(): TeamScore[] {
    return (["blue", "red"] as const).map((t) => ({
      team: t,
      label: TEAMS[t].label,
      color: TEAMS[t].color,
      remaining: Math.max(0, this.tickets[t]),
      limit: this.limit,
    }));
  }

  protected override blueLost(): boolean {
    // Over means a side hit 0; blue lost if it's the one at (or below) the other.
    return this.tickets.blue <= this.tickets.red;
  }

  /** Feed the capture points to objective-seeking bots (DominationOracle). Owner
   *  is the max team once controlled (progress ≥ 1), else "gray". */
  objectives(ctx: GameCtx): ObjectivePoint[] {
    const pts = ctx.level.domPoints;
    return pts.map((p, i) => {
      const st = this.states[i] ?? neutral();
      const owner = st.progress >= 1 ? st.maxTeam : "gray";
      return { pos: p.pos, z: p.z, radius: p.radius, owner, progress: st.progress };
    });
  }

  protected override extraHud(ctx: GameCtx): Partial<GamemodeHud> {
    const pts = ctx.level.domPoints;
    return {
      points: pts.map((p, i) => {
        const st = this.states[i] ?? neutral();
        return { name: p.name, pos: p.pos, z: p.z, radius: p.radius, team: st.maxTeam, progress: st.progress };
      }),
    };
  }
}
