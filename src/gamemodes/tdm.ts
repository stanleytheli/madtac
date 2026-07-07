/**
 * Team Deathmatch, ticket style. Two sides — blue (the player + blue bots) and
 * red — spawn from their teams' spawn zones and fight. Each death drains that
 * team's ticket bar (killLimit down to 0); a team that reaches 0 loses. Downed
 * combatants respawn from their zones after a delay until their tickets run out.
 *
 * Maps are authored with nothing but spawn zones: troop counts, per-side skill
 * and equipment quality, the kill limit, and the respawn delay all come from the
 * level's `meta.tdm` (with the defaults below when omitted).
 */
import type { Character } from "../actor.ts";
import { makeTroop } from "../enemies.ts";
import type { TdmConfig, TeamConfig } from "../level.ts";
import { SKINS } from "../specs.ts";
import { TEAMS } from "../team.ts";
import type { GameCtx, Gamemode, GamemodeHud, PlayerRow, TeamScore } from "./gamemode.ts";

/** Applied when a TDM level omits some or all of `meta.tdm`. */
export const DEFAULT_TDM: TdmConfig = {
  killLimit: 20,
  respawnDelay: 180, // ticks (~3s at 60 Hz)
  blue: { troops: 4, skill: 0.6, equip: 2 },
  red: { troops: 4, skill: 0.6, equip: 2 },
};

/** A partial config (a level's `meta.tdm`, or URL overrides) before defaults. */
export interface TdmOverrides {
  killLimit?: number;
  respawnDelay?: number;
  blue?: Partial<TeamConfig>;
  red?: Partial<TeamConfig>;
}

/** Fill any missing field of a partial TDM config from DEFAULT_TDM. */
export function resolveTdm(o?: TdmOverrides): TdmConfig {
  return {
    killLimit: o?.killLimit ?? DEFAULT_TDM.killLimit,
    respawnDelay: o?.respawnDelay ?? DEFAULT_TDM.respawnDelay,
    blue: { ...DEFAULT_TDM.blue, ...o?.blue },
    red: { ...DEFAULT_TDM.red, ...o?.red },
  };
}

/** Each side's body skin (SKINS keys), so blue and red read at a glance. */
const TEAM_SKIN: Record<"blue" | "red", string> = { blue: "BLUE_SKIN", red: "RED_SKIN" };

/** Equipment ladder: tier -> a set of possible guns (rolled per agent, uniform)
 *  plus that tier's armor (GUN_SPECS / ARMOR_SPECS keys). */
const EQUIP: { guns: string[]; armor?: string }[] = [
  { guns: ["M9"] },
  { guns: ["USPS", "M9"], armor: "ARMOR_L1" },
  { guns: ["M16", "AK47"], armor: "ARMOR_L2" },
  { guns: ["AK47", "M16", "M249"], armor: "ARMOR_L3" },
  { guns: ["M249", "AK47"], armor: "ARMOR_L4" },
];

/** Callsign pool. Shuffled once per match then handed out in order, so names are
 *  unique until the pool is exhausted (then good-faith numbered duplicates). */
const NAMES = [
  "Vegas", "Ghost", "Raptor", "Slate", "Nyx", "Comet", "Bishop", "Wren", "Dash", "Koa",
  "Ranger", "Echo", "Frost", "Talon", "Onyx", "Blaze", "Rook",
  "Jinx", "Ace", "Storm", "Piper", "Kilo", "Nova", "Tech", "Fable", "Halo", "Vita",
  "Knight", "Phantom", "Red", "Twig", "Ozymandias", "J", "October", "Delta", "Gamma", "Nova",
  "Bull", "Shellie",
];

/** The full strafe fan a max-skill soldier explores (matches tacoracle's own
 *  default); lower skill uses a coarser, wider subset. */
const FULL_STRAFE = [15, 30, 45, 60, 90, 120];

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

/** In-place Fisher–Yates shuffle (returns the same array). */
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Map a skill scalar in [0,1] to concrete TacOracle knobs: sharper reactions,
 *  braver bursts, and more lateral lane exploration as skill rises. */
function skillParams(skill: number): { reactionTime: number; lambda: number; strafeOffsets: number[] } {
  const s = clamp01(skill);
  const n = 2 + Math.round(4 * s); // 2..6 candidate offsets
  return {
    reactionTime: Math.round(30 - 27 * s), // 30 sluggish -> ~3 sharp
    lambda: 2.5 + 5.5 * s, // timid taps -> long brave bursts
    strafeOffsets: FULL_STRAFE.slice(FULL_STRAFE.length - n),
  };
}

/** Roll a random gun from an equip tier (plus that tier's armor). */
function rollEquip(tier: number): { gun: string; armor?: string } {
  const t = EQUIP[Math.max(0, Math.min(EQUIP.length - 1, Math.round(tier)))];
  return { gun: pick(t.guns), armor: t.armor };
}

/** A persistent combatant identity — outlives the Character objects it drives,
 *  so a bot keeps its callsign, K/D, and rolled weapon across respawns. */
interface Agent {
  name: string;
  team: "blue" | "red";
  isPlayer: boolean;
  skill: number;
  /** GUN_SPECS key rolled once: a bot keeps it every life; the player starts
   *  with it (but then keeps whatever it scavenges — see spawnAgent). */
  gun: string;
  /** ARMOR_SPECS key for this agent's equip tier (bots only; the player keeps
   *  its own armor — deliberately left un-normalized for now). */
  armor?: string;
  kills: number;
  deaths: number;
  /** The live character this agent currently drives, or null while awaiting respawn. */
  char: Character | null;
}

export class TeamDeathmatchMode implements Gamemode {
  readonly id = "tdm";
  readonly label = "Team Deathmatch";
  // Respawns would otherwise bury the map in corpses and dropped gear, so both
  // clear on a timer (blinking out over their last second).
  readonly bodyTtl = 360; // ~6s
  readonly itemTtl = 600; // ~10s

  private readonly cfg: TdmConfig;
  private phase: "playing" | "over" = "playing";
  private agents: Agent[] = [];
  private queue: { agent: Agent; at: number }[] = [];

  constructor(tdm?: TdmOverrides) {
    this.cfg = resolveTdm(tdm);
  }

  init(ctx: GameCtx): void {
    this.phase = "playing";
    this.agents = [];
    this.queue = [];

    const names = shuffle(NAMES.slice());
    let n = 0;
    const nextName = (): string => {
      const base = names[n % names.length];
      const dup = n >= names.length ? ` ${Math.floor(n / names.length) + 1}` : "";
      n += 1;
      return base + dup;
    };

    // The player IS blue's first combatant (fills one slot, so blue also fields
    // blueTroops - 1 bots), wears the blue skin, and starts on blue's equip tier.
    ctx.player.team = "blue";
    const blueSkin = SKINS[TEAM_SKIN.blue];
    if (blueSkin) ctx.player.skin = blueSkin;
    const pe = rollEquip(this.cfg.blue.equip);
    const player: Agent = {
      name: nextName(), team: "blue", isPlayer: true, skill: this.cfg.blue.skill,
      gun: pe.gun, kills: 0, deaths: 0, char: ctx.player,
    };
    this.agents.push(player);
    this.spawnAgent(ctx, player, { primary: pe.gun });

    const makeBots = (team: "blue" | "red", cfg: TeamConfig, count: number): void => {
      for (let i = 0; i < count; i++) {
        const e = rollEquip(cfg.equip);
        const a: Agent = {
          name: nextName(), team, isPlayer: false, skill: cfg.skill,
          gun: e.gun, armor: e.armor, kills: 0, deaths: 0, char: null,
        };
        this.agents.push(a);
        this.spawnAgent(ctx, a);
      }
    };
    makeBots("blue", this.cfg.blue, Math.max(0, this.cfg.blue.troops - 1));
    makeBots("red", this.cfg.red, this.cfg.red.troops);
  }

  /** (Re)spawn an agent's character at one of its team's zones. `playerLoadout`
   *  (initial spawn only) arms the player to a kit; omitted, the player keeps its
   *  current weapons (refreshed). Bots are always rebuilt with their rolled gun. */
  private spawnAgent(ctx: GameCtx, agent: Agent, playerLoadout?: { primary?: string }): void {
    const sp = ctx.spawnPoint(agent.team);
    if (!sp) {
      console.warn(`TDM: no ${agent.team} spawn zone — ${agent.name} couldn't spawn`);
      return;
    }
    if (agent.isPlayer) {
      ctx.revivePlayer(sp.pos, sp.z, playerLoadout);
      agent.char = ctx.player;
    } else {
      const p = skillParams(agent.skill);
      const c = makeTroop(sp.pos, {
        team: agent.team,
        z: sp.z,
        gun: agent.gun,
        armor: agent.armor,
        skin: TEAM_SKIN[agent.team],
        reactionTime: p.reactionTime,
        lambda: p.lambda,
        strafeOffsets: p.strafeOffsets,
      });
      agent.char = c;
      ctx.addCharacter(c);
    }
  }

  /** A team's total deaths = its ticket count spent. */
  private teamDeaths(team: "blue" | "red"): number {
    return this.agents.reduce((s, a) => (a.team === team ? s + a.deaths : s), 0);
  }

  onDeath(dead: Character, ctx: GameCtx): void {
    if (this.phase === "over") return;
    const victim = this.agents.find((a) => a.char === dead);
    if (!victim) return; // not a TDM combatant

    victim.deaths += 1;
    victim.char = null;

    // Credit the kill to whoever fired the fatal shot (if still identifiable).
    const killer = dead.lastAttacker ? this.agents.find((a) => a.char === dead.lastAttacker) : undefined;
    if (killer && killer !== victim) killer.kills += 1;

    if (this.teamDeaths(victim.team) >= this.cfg.killLimit) {
      this.phase = "over"; // this team's tickets are spent — it loses
      return;
    }
    this.queue.push({ agent: victim, at: ctx.tick + this.cfg.respawnDelay });
  }

  update(ctx: GameCtx): void {
    if (this.phase === "over") return;
    // Respawn everyone whose timer is up; keep the not-yet-due ones for later.
    const waiting: { agent: Agent; at: number }[] = [];
    for (const p of this.queue) {
      if (ctx.tick < p.at) waiting.push(p);
      else this.spawnAgent(ctx, p.agent); // player keeps its weapons; bots re-arm with their gun
    }
    this.queue = waiting;
  }

  hud(ctx: GameCtx): GamemodeHud {
    const scores: TeamScore[] = (["blue", "red"] as const).map((t) => ({
      team: t,
      label: TEAMS[t].label,
      color: TEAMS[t].color,
      remaining: Math.max(0, this.cfg.killLimit - this.teamDeaths(t)),
      limit: this.cfg.killLimit,
    }));

    const players: PlayerRow[] = this.agents.map((a) => ({
      name: a.name,
      team: a.team,
      color: TEAMS[a.team].color,
      kills: a.kills,
      deaths: a.deaths,
      isPlayer: a.isPlayer,
    }));

    let banner: string | undefined;
    if (this.phase === "over") {
      const blueLost = this.teamDeaths("blue") >= this.cfg.killLimit;
      banner = `${blueLost ? "Defeat" : "Victory"}\nPress Enter to restart`;
    } else {
      const mine = this.queue.find((p) => p.agent.isPlayer);
      if (mine) banner = `Respawning in ${Math.max(1, Math.ceil((mine.at - ctx.tick) / 60))}`;
    }

    return { scores, banner, over: this.phase === "over", players };
  }
}
