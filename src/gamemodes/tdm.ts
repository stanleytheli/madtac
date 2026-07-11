/**
 * Team Deathmatch, ticket style. Two sides — blue (the player + blue bots) and
 * red — spawn from their zones and fight. Each death drains that team's ticket
 * bar (killLimit down to 0); a team that reaches 0 loses.
 *
 * All the roster/spawn/respawn/loadout/scoreboard machinery lives in the shared
 * `TeamMatchMode` base (teammatch.ts); TDM adds only the kill-ticket rule.
 */
import type { TdmConfig, TeamConfig } from "../world/level.ts";
import { TEAMS } from "../entities/team.ts";
import type { TeamScore } from "./gamemode.ts";
import { DEFAULT_EQUIP, resolveEquip, TeamMatchMode } from "./teammatch.ts";

/** Applied when a TDM level omits some or all of `meta.tdm`. */
export const DEFAULT_TDM: TdmConfig = {
  killLimit: 20,
  respawnDelay: 180, // ticks (~3s at 60 Hz)
  blue: { troops: 4, skill: 0.6, equip: DEFAULT_EQUIP },
  red: { troops: 4, skill: 0.6, equip: DEFAULT_EQUIP },
};

/** A partial config (a level's `meta.tdm`, or URL overrides) before defaults. */
export interface TdmOverrides {
  killLimit?: number;
  respawnDelay?: number;
  blue?: Partial<TeamConfig>;
  red?: Partial<TeamConfig>;
}

/** Fill any missing field of a partial TDM config from DEFAULT_TDM, normalizing
 *  each side's equip to a canonical tier name (accepts legacy numeric tiers). */
export function resolveTdm(o?: TdmOverrides): TdmConfig {
  const blue = { ...DEFAULT_TDM.blue, ...o?.blue };
  const red = { ...DEFAULT_TDM.red, ...o?.red };
  blue.equip = resolveEquip(blue.equip);
  red.equip = resolveEquip(red.equip);
  return {
    killLimit: o?.killLimit ?? DEFAULT_TDM.killLimit,
    respawnDelay: o?.respawnDelay ?? DEFAULT_TDM.respawnDelay,
    blue,
    red,
  };
}

export class TeamDeathmatchMode extends TeamMatchMode {
  readonly id = "tdm";
  readonly label = "Team Deathmatch";

  private readonly killLimit: number;

  constructor(tdm?: TdmOverrides) {
    const cfg = resolveTdm(tdm);
    super({ respawnDelay: cfg.respawnDelay, blue: cfg.blue, red: cfg.red });
    this.killLimit = cfg.killLimit;
  }

  /** A death spends a ticket; the team whose tickets run out loses. */
  protected override afterDeath(): void {
    if (this.teamDeaths("blue") >= this.killLimit || this.teamDeaths("red") >= this.killLimit) {
      this.phase = "over";
    }
  }

  protected override teamScores(): TeamScore[] {
    return (["blue", "red"] as const).map((t) => ({
      team: t,
      label: TEAMS[t].label,
      color: TEAMS[t].color,
      remaining: Math.max(0, this.killLimit - this.teamDeaths(t)),
      limit: this.killLimit,
    }));
  }

  protected override blueLost(): boolean {
    return this.teamDeaths("blue") >= this.killLimit;
  }
}
