/**
 * Domination. Sides fight over fixed capture points (DomPoints authored in the
 * editor). Each point has an OWNER (a team, or "gray" when neutral) plus a
 * control STRENGTH in [0, 1] — a multi-team-ready model:
 *   - Held by team T: every T member on the point pushes strength up, every
 *     non-member pushes it down (net = members − others). At strength 0 the
 *     point neutralizes — it flips to gray at full strength (1).
 *   - Gray: the team with a STRICT plurality on the point drives strength down
 *     (rate = its lead over the runner-up); a tie makes no progress. At 0 that
 *     team takes the point, becoming its owner at strength 0 (then builds up).
 * Points start gray at strength 1.
 *
 * Every second, each point a team controls drains one ticket from the OTHER
 * team (own 2 of 3 points → the enemy bleeds 2/s while you bleed 1/s). A team
 * whose tickets hit 0 loses. Everything else (roster, spawns, respawns,
 * scoreboard) comes from TeamMatchMode.
 */
import type { ObjectivePoint } from "../ai/robot.ts";
import type { DomConfig, TeamConfig } from "../world/level.ts";
import { TEAMS, type TeamId } from "../entities/team.ts";
import { dist } from "../engine/vec.ts";
import type { GameCtx, GamemodeHud, TeamScore } from "./gamemode.ts";
import { TeamMatchMode } from "./teammatch.ts";

/** Applied when a domination level omits some or all of `meta.domination`. */
export const DEFAULT_DOM: DomConfig = {
  scoreLimit: 100,
  respawnDelay: 120, // ticks (~2s) — objective mode, faster back into the fight
  blue: { troops: 4, skill: 0.6, equip: 2 },
  red: { troops: 4, skill: 0.6, equip: 2 },
};

/** A partial config (a level's `meta.domination`) before defaults. */
export interface DomOverrides {
  scoreLimit?: number;
  respawnDelay?: number;
  blue?: Partial<TeamConfig>;
  red?: Partial<TeamConfig>;
}

/** Fill any missing field of a partial domination config from DEFAULT_DOM. */
export function resolveDom(o?: DomOverrides): DomConfig {
  return {
    scoreLimit: o?.scoreLimit ?? DEFAULT_DOM.scoreLimit,
    respawnDelay: o?.respawnDelay ?? DEFAULT_DOM.respawnDelay,
    blue: { ...DEFAULT_DOM.blue, ...o?.blue },
    red: { ...DEFAULT_DOM.red, ...o?.red },
  };
}

/** Per-tick strength change one net agent applies (0.01 → a lone capper takes a
 *  gray point, or flips a fully-held one, in ~1.7s; faster with a bigger lead). */
const CAPTURE_RATE = 0.0025;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Live control state of one capture point. */
interface DomState {
  owner: TeamId | "gray";
  strength: number;
  /** For a gray point, the team currently capturing it (rendering only). */
  capturing: TeamId | null;
}

const neutral = (): DomState => ({ owner: "gray", strength: 1, capturing: null });

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

    // Every second, each controlled point drains a ticket from the other team.
    if (ctx.tick % 60 === 0) {
      let blueOwned = 0;
      let redOwned = 0;
      for (const st of this.states) {
        if (st.owner === "blue") blueOwned += 1;
        else if (st.owner === "red") redOwned += 1;
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

    if (st.owner !== "gray") {
      // Held: the owner's members strengthen it, everyone else weakens it.
      const support = counts.get(st.owner) ?? 0;
      const net = support - (total - support);
      st.capturing = null;
      if (net !== 0) {
        st.strength = clamp01(st.strength + net * CAPTURE_RATE);
        if (st.strength <= 0) {
          st.owner = "gray"; // neutralized — resets to fully gray
          st.strength = 1;
        }
      }
      return;
    }

    // Gray: the strict-plurality team drives strength down and takes it at 0.
    let topTeam: TeamId | null = null;
    let topCount = 0;
    let secondCount = 0;
    for (const [team, n] of counts) {
      if (n > topCount) {
        secondCount = topCount;
        topCount = n;
        topTeam = team;
      } else if (n > secondCount) {
        secondCount = n;
      }
    }
    const lead = topCount - secondCount; // strict majority ⇒ lead > 0
    if (topTeam && lead > 0) {
      st.capturing = topTeam;
      st.strength = clamp01(st.strength - lead * CAPTURE_RATE);
      if (st.strength <= 0) {
        st.owner = topTeam; // taken — starts owned but unlocked
        st.strength = 0;
      }
    } else {
      st.capturing = null; // no majority: no progress
    }
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

  /** Feed the capture points to objective-seeking bots (DominationOracle). */
  objectives(ctx: GameCtx): ObjectivePoint[] {
    const pts = ctx.level.domPoints;
    return pts.map((p, i) => {
      const st = this.states[i] ?? neutral();
      return { pos: p.pos, z: p.z, radius: p.radius, owner: st.owner, strength: st.strength };
    });
  }

  protected override extraHud(ctx: GameCtx): Partial<GamemodeHud> {
    const pts = ctx.level.domPoints;
    return {
      points: pts.map((p, i) => {
        const st = this.states[i] ?? neutral();
        return {
          name: p.name,
          pos: p.pos,
          z: p.z,
          radius: p.radius,
          owner: st.owner,
          strength: st.strength,
          capturing: st.capturing,
        };
      }),
    };
  }
}
