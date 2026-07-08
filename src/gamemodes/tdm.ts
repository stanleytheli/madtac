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
import type { Character } from "../entities/actor.ts";
import { makeTroop } from "../ai/enemies.ts";
import type { TdmConfig, TeamConfig } from "../world/level.ts";
import { ARMOR_SPECS, GUN_SPECS, SKINS } from "../entities/specs.ts";
import { TEAMS } from "../entities/team.ts";
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

/** Equipment ladder: per tier, pools for the primary slot, the secondary slot,
 *  and armor (GUN_SPECS / ARMOR_SPECS keys). A loadout roll draws one of each at
 *  random, so slots hold class-appropriate guns (rifle up top, sidearm below)
 *  and armor varies too. A `""` entry means "empty" — include it in a pool to
 *  roll a chance of no armor / no gun (e.g. `["", "ARMOR_L1"]` = 50/50 L1 or
 *  bare). An empty pool `[]` always yields empty.
 *
 *  `both: false` hands out only ONE weapon — a random draw from a randomly
 *  chosen pool, dropped in the equipped (primary) slot so a lone sidearm is
 *  still in hand. The "spawn with an M9 and scramble for something better" tier.
 *  Omitted/`true` = a full primary + secondary kit. */
const EQUIP: { primaries: string[]; secondaries: string[]; armors: string[]; both?: boolean }[] = [
  { primaries: ["M9"], secondaries: [], armors: [], both: false },
  { primaries: ["M16", "AK47"], secondaries: ["M9", "USPS"], armors: ["", "ARMOR_L1"], both: false },
  { primaries: ["M16", "AK47"], secondaries: ["M9", "USPS"], armors: ["ARMOR_L1", "ARMOR_L2"] },
  { primaries: ["M16", "AK47"], secondaries: ["Deagle"], armors: ["ARMOR_L2", "ARMOR_L3"] },
  { primaries: ["AK47", "M249"], secondaries: ["Deagle", "Golden_Deagle"], armors: ["ARMOR_L3", "ARMOR_L4"] },
  { primaries: ["M249", "AK47", "M16"], secondaries: ["Deagle", "USPS", "M9", "Golden_Deagle"], armors: ["", "ARMOR_L1", "ARMOR_L2", "ARMOR_L3"], both: false },
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
function skillParams(skill: number): { reactionTime: number; lambda: number; strafeOffsets: number[]; aimSigma: number } {
  const s = clamp01(skill);
  const n = 2 + Math.round(4 * s); // 2..6 candidate offsets
  return {
    reactionTime: Math.round(30 - 27 * s), // 30 sluggish -> ~3 sharp
    lambda: 2.5 + 5.5 * s, // timid taps -> long brave bursts
    strafeOffsets: FULL_STRAFE.slice(FULL_STRAFE.length - n),
    aimSigma: 48 - 42 * s, // ~48px wobble at skill 0 -> ~6px at skill 1
  };
}

/** Roll a random loadout from an equip tier: a primary + secondary + armor, each
 *  drawn from its pool — or, when the tier is `both: false`, just one weapon
 *  (random pool, equipped slot) plus armor. Any field may be empty. */
function rollLoadout(tier: number): PlayerLoadout {
  const t = EQUIP[Math.max(0, Math.min(EQUIP.length - 1, Math.round(tier)))];
  const armor = t.armors.length ? pick(t.armors) : undefined;
  if (t.both === false) {
    // One weapon, from a randomly chosen non-empty pool, placed in ITS class's
    // slot — a lone sidearm goes to the secondary slot (Character then equips it
    // since there's no primary), not jammed into the primary slot.
    const pools = [t.primaries, t.secondaries].filter((p) => p.length > 0);
    const gun = pools.length ? pick(pick(pools)) : undefined;
    if (!gun) return { armor };
    return GUN_SPECS[gun]?.primary ? { primary: gun, armor } : { secondary: gun, armor };
  }
  return {
    primary: t.primaries.length ? pick(t.primaries) : undefined,
    secondary: t.secondaries.length ? pick(t.secondaries) : undefined,
    armor,
  };
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
  /** The player's chosen kit, edited at the respawn screen. Empty (no weapon) =
   *  "auto": re-roll from `equip` each spawn like a bot. Bots leave this unset. */
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
  /** Character -> its Agent, kept even after the character dies. A bullet holds
   *  its (now-dead) shooter's Character alive, so a kill that lands after the
   *  shooter died — or respawned as a new Character — still credits the right
   *  agent, instead of failing to match any agent's current `char`. */
  private charAgent = new WeakMap<Character, Agent>();

  constructor(tdm?: TdmOverrides) {
    this.cfg = resolveTdm(tdm);
  }

  init(ctx: GameCtx): void {
    this.phase = "playing";
    this.agents = [];
    this.queue = [];
    this.charAgent = new WeakMap();

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
    // The player starts on an EMPTY loadout = "auto": with neither weapon chosen
    // it re-rolls a fresh kit from blue's tier every spawn, exactly like a bot.
    // Once the respawn screen sets either weapon, that fixed kit is used instead.
    const player: Agent = {
      name: nextName(), team: "blue", isPlayer: true, skill: this.cfg.blue.skill,
      equip: this.cfg.blue.equip, loadout: {},
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

  /** (Re)spawn an agent's character at one of its team's zones. Bots re-roll a
   *  fresh full kit from their equip tier every spawn; the player does the same
   *  while its loadout is empty ("auto"), or gets its fixed chosen kit once a
   *  weapon is set at the respawn screen. */
  private spawnAgent(ctx: GameCtx, agent: Agent): void {
    const sp = ctx.spawnPoint(agent.team);
    if (!sp) {
      console.warn(`TDM: no ${agent.team} spawn zone — ${agent.name} couldn't spawn`);
      return;
    }
    if (agent.isPlayer) {
      // Empty loadout (neither weapon chosen) = auto: re-roll a fresh kit each
      // spawn like a bot; choosing either weapon at the respawn screen locks it.
      const auto = !agent.loadout?.primary && !agent.loadout?.secondary;
      ctx.revivePlayer(sp.pos, sp.z, auto ? rollLoadout(agent.equip) : agent.loadout);
      agent.char = ctx.player;
    } else {
      const e = rollLoadout(agent.equip); // full kit, sampled fresh each life
      const p = skillParams(agent.skill);
      const c = makeTroop(sp.pos, {
        team: agent.team,
        z: sp.z,
        gun: e.primary || e.secondary, // wield the primary (rifle); sidearm if that's all
        armor: e.armor,
        skin: TEAM_SKIN[agent.team],
        reactionTime: p.reactionTime,
        lambda: p.lambda,
        strafeOffsets: p.strafeOffsets,
        aimSigma: p.aimSigma,
      });
      agent.char = c;
      ctx.addCharacter(c);
    }
    if (agent.char) this.charAgent.set(agent.char, agent);
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
    const victim = this.charAgent.get(dead);
    if (!victim) return; // not a TDM combatant

    victim.deaths += 1;
    victim.char = null;

    // Credit the kill to whoever fired the fatal shot — resolved through the
    // persistent map, so it counts even if the shooter has since died/respawned.
    const killer = dead.lastAttacker ? this.charAgent.get(dead.lastAttacker as Character) : undefined;
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
      name: "Team Deathmatch",
      scores,
      banner,
      over: this.phase === "over",
      players,
      choosingLoadout,
      loadout: this.playerAgent?.loadout,
    };
  }
}
