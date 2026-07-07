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
import { ARMOR_SPECS, GUN_SPECS, SKINS } from "../specs.ts";
import { TEAMS } from "../team.ts";
import type { GameCtx, Gamemode, GamemodeHud, PlayerLoadout, PlayerRow, TeamScore } from "./gamemode.ts";

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
 *  so callsign and K/D survive respawns. */
interface Agent {
  name: string;
  team: "blue" | "red";
  isPlayer: boolean;
  skill: number;
  /** Equipment tier. Bots re-roll a gun+armor from it every (re)spawn. */
  equip: number;
  /** The player's chosen kit (sampled once at start, then edited at the respawn
   *  screen). Bots have none — they re-roll from `equip` each life. */
  loadout?: PlayerLoadout;
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
  /** The player's identity, kept for the respawn-screen loadout dropdown. */
  private playerAgent: Agent | null = null;

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
    // The player's kit is sampled from blue's tier ONCE; thereafter it persists
    // and is edited at the respawn screen (setPlayerLoadout).
    const pe = rollEquip(this.cfg.blue.equip);
    const player: Agent = {
      name: nextName(), team: "blue", isPlayer: true, skill: this.cfg.blue.skill,
      equip: this.cfg.blue.equip, loadout: { primary: pe.gun, armor: pe.armor },
      kills: 0, deaths: 0, char: ctx.player,
    };
    this.agents.push(player);
    this.playerAgent = player;
    this.spawnAgent(ctx, player);

    const makeBots = (team: "blue" | "red", cfg: TeamConfig, count: number): void => {
      for (let i = 0; i < count; i++) {
        const a: Agent = {
          name: nextName(), team, isPlayer: false, skill: cfg.skill,
          equip: cfg.equip, kills: 0, deaths: 0, char: null,
        };
        this.agents.push(a);
        this.spawnAgent(ctx, a);
      }
    };
    makeBots("blue", this.cfg.blue, Math.max(0, this.cfg.blue.troops - 1));
    makeBots("red", this.cfg.red, this.cfg.red.troops);
  }

  /** (Re)spawn an agent's character at one of its team's zones. The player is
   *  re-armed to its chosen `loadout` (persists across lives); a bot re-rolls a
   *  fresh gun+armor from its equip tier every spawn. */
  private spawnAgent(ctx: GameCtx, agent: Agent): void {
    const sp = ctx.spawnPoint(agent.team);
    if (!sp) {
      console.warn(`TDM: no ${agent.team} spawn zone — ${agent.name} couldn't spawn`);
      return;
    }
    if (agent.isPlayer) {
      ctx.revivePlayer(sp.pos, sp.z, agent.loadout);
      agent.char = ctx.player;
    } else {
      const e = rollEquip(agent.equip); // sampled fresh each life
      const p = skillParams(agent.skill);
      const c = makeTroop(sp.pos, {
        team: agent.team,
        z: sp.z,
        gun: e.gun,
        armor: e.armor,
        skin: TEAM_SKIN[agent.team],
        reactionTime: p.reactionTime,
        lambda: p.lambda,
        strafeOffsets: p.strafeOffsets,
      });
      agent.char = c;
      ctx.addCharacter(c);
    }
  }

  /** Store the player's next-life kit (respawn-screen dropdown), keeping only
   *  keys that exist so a stale/garbage value can't break a spawn. */
  setPlayerLoadout(loadout: PlayerLoadout): void {
    if (!this.playerAgent) return;
    this.playerAgent.loadout = {
      primary: loadout.primary && loadout.primary in GUN_SPECS ? loadout.primary : undefined,
      secondary: loadout.secondary && loadout.secondary in GUN_SPECS ? loadout.secondary : undefined,
      armor: loadout.armor && loadout.armor in ARMOR_SPECS ? loadout.armor : undefined,
    };
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
      else this.spawnAgent(ctx, p.agent); // player: chosen kit; bot: freshly re-rolled
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

    // Player awaiting respawn: it's dead (no live char) while the match plays on.
    const choosingLoadout = this.phase === "playing" && !!this.playerAgent && this.playerAgent.char === null;

    let banner: string | undefined;
    if (this.phase === "over") {
      const blueLost = this.teamDeaths("blue") >= this.cfg.killLimit;
      banner = `${blueLost ? "Defeat" : "Victory"}\nPress Enter to restart`;
    } else if (choosingLoadout) {
      const mine = this.queue.find((p) => p.agent.isPlayer);
      const secs = mine ? Math.max(1, Math.ceil((mine.at - ctx.tick) / 60)) : 1;
      banner = `Respawning in ${secs}`;
    }

    return {
      scores,
      banner,
      over: this.phase === "over",
      players,
      choosingLoadout,
      loadout: this.playerAgent?.loadout,
    };
  }
}
