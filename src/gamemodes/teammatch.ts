/**
 * Shared machinery for two-sided (blue vs red) team modes: the persistent agent
 * roster, spawning from the level's spawn zones, respawn queue, per-agent
 * loadout rolling, and the scoreboard/banner scaffold. Team Deathmatch and
 * Domination both extend `TeamMatchMode`, supplying only their scoring/win rule
 * (the ticket bars, the loss condition, any per-tick objective logic).
 *
 * Humans are blue's first combatants — each takes one of blue's slots, so blue
 * fields `troops - humans` bots (never fewer than none); a human joining a
 * running match retires a blue bot to make room, and one leaving brings a bot
 * back. Both sides are otherwise AI-filled from the per-side `TeamConfig`
 * (troop count, skill, equipment tier).
 */
import type { Character } from "../entities/actor.ts";
import { BANDAGE, SYRINGE, UtilityStack } from "../entities/consumable.ts";
import { makeTroop } from "../ai/enemies.ts";
import type { TeamConfig } from "../world/level.ts";
import { ARMOR_SPECS, GUN_SPECS, SKINS } from "../entities/specs.ts";
import { TEAMS, areHostile } from "../entities/team.ts";
import { KILLFEED_MAX } from "./gamemode.ts";
import type { GameCtx, Gamemode, GamemodeHud, PlayerLoadout, PlayerRow, TeamScore } from "./gamemode.ts";

/** Kill-feed distance scale: how many world px make one displayed meter. */
const PX_PER_METER = 50;

/** Config common to every team match. Modes add their own win parameter
 *  (killLimit, ticket count, …) on top. */
export interface TeamMatchConfig {
  /** Ticks before a downed slot respawns from its team's zones. */
  respawnDelay: number;
  blue: TeamConfig;
  red: TeamConfig;
}

/** Each side's body skin (SKINS keys), so blue and red read at a glance. */
const TEAM_SKIN: Record<"blue" | "red", string> = { blue: "BLUE_SKIN", red: "RED_SKIN" };

/** Equipment ladder: each tier has a NAME (how it's referenced in the editor,
 *  URL, and level meta) plus pools for the primary slot, the secondary slot, and
 *  armor (GUN_SPECS / ARMOR_SPECS keys). A loadout roll draws one of each at
 *  random, so slots hold class-appropriate guns (rifle up top, sidearm below)
 *  and armor varies too. A `""` entry means "empty"; an empty pool `[]` always
 *  yields empty. `both: false` hands out only ONE weapon (random pool, dropped
 *  in its class's slot) — the "spawn with one gun and scramble" tiers. */
const EQUIP: { name: string; primaries: string[]; secondaries: string[]; armors: string[]; both?: boolean }[] = [
  { name: "m9 only", primaries: ["M9"], secondaries: [], armors: [], both: false },
  { name: "light", primaries: ["M16", "AK47"], secondaries: ["M9", "USPS"], armors: ["", "ARMOR_L1"], both: false },
  { name: "medium", primaries: ["M16", "AK47"], secondaries: ["M9", "USPS"], armors: ["ARMOR_L1", "ARMOR_L2"] },
  { name: "heavy", primaries: ["M16", "AK47"], secondaries: ["Deagle"], armors: ["ARMOR_L2", "ARMOR_L3"] },
  { name: "superheavy", primaries: ["AK47", "M249"], secondaries: ["Deagle", "Golden_Deagle"], armors: ["ARMOR_L3", "ARMOR_L4"] },
  { name: "random", primaries: ["M249", "AK47", "M16", "MP220", "Scout", "RPG", "AWM", "Mossberg500", "M4A1S", "SCAR17", "MP5"], secondaries: ["Deagle", "USPS", "M9", "Golden_Deagle", "Skorpion", "M79", "Uzi", "Colt44"], armors: ["", "ARMOR_L1", "ARMOR_L2", "ARMOR_L3"], both: false },
];

/** The equipment tier names, in ladder order — the editor dropdown + URL/meta
 *  vocabulary. Single source of truth (tracks the table above). */
export const EQUIP_NAMES: readonly string[] = EQUIP.map((t) => t.name);
/** The tier a config falls back to when none is set. */
export const DEFAULT_EQUIP = "medium";

/** The tier for a name, falling back to DEFAULT_EQUIP (then the first tier). */
function equipTier(name: string): (typeof EQUIP)[number] {
  return EQUIP.find((t) => t.name === name) ?? EQUIP.find((t) => t.name === DEFAULT_EQUIP) ?? EQUIP[0];
}

/** Normalize an equip value to a canonical tier NAME: a known name passes
 *  through; a legacy numeric tier index is mapped to its name; anything else
 *  (unknown / missing) becomes DEFAULT_EQUIP. Keeps old numeric levels loading. */
export function resolveEquip(v: string | number | undefined): string {
  if (typeof v === "number") return (EQUIP[Math.max(0, Math.min(EQUIP.length - 1, Math.round(v)))] ?? EQUIP[0]).name;
  return typeof v === "string" && EQUIP.some((t) => t.name === v) ? v : DEFAULT_EQUIP;
}

/** Callsign pool. Shuffled once per match then handed out in order, so names are
 *  unique until the pool is exhausted (then good-faith numbered duplicates). */
const NAMES = [
  "Vegas", "Ghost", "Raptor", "Slate", "Nyx", "Comet", "Bishop", "Wren", "Dash", "Koa",
  "Ranger", "Echo", "Frost", "Talon", "Onyx", "Blaze", "Rook",
  "Jinx", "Ace", "Storm", "Piper", "Kilo", "Nova", "Tech", "Fable", "Halo", "Vita",
  "Knight", "Phantom", "Red", "Twig", "Ozymandias", "J", "October", "Delta", "Gamma", "Nova",
  "Bull", "Shellie", "Wolf", "Rogue", "Twitch", "Butterfinger", "Wildcard", "Wrench", 
  "Newbie", "Art", "Queen", "Viper", "Havoc", "Cipher", "Flint", "Crow", "Zero", "Vex",
  "Drift", "Reaper", "Hex", "Atlas", "Mute", "Mantis", "Switch", "Icarus", "Knox", "Sparrow",
  "Hush", "Grimm", "Cinder", "Moth", "Rhino", "Static", "Maverick", "Coyote", "Cricket", "Jett",
  "Patch", "Mongoose", "Doc", "Stray", "Rocksteady", "Lockpick", "Brick", "Nails", "Buzz", "Chopper",
  "Smoke", "Shade", "Dusk", "Neon", "Chrome", "Carbon", "Motherboard", "Hotpath", "Relay", "Pixel",
  "Ping", "Crash", "Ratchet", "Scrap", "Badger", "Jackal", "Cobra", "Lynx", "Hawk", "Panther", "Fox",
  "Raven", "Priest", "Pilgrim", "Baron", "Jester", "Deacon", "Judge", "Sherriff", "Marshal", "Gunner",
  "Skipper", "Wednesday", "Winter", "Seven", "Nine", "Lucky", "Deuce", "Lefty", "Junior", "Tiny", 
  "Biggs", "Mouse", "Cupcake", "Dozer", "Cowboy", "Bushranger", "Outlaw", "Savage", "Bane", "Nemesis",
  "Grudge", "Sirius", "Orion", "Helion", "Ares", "Anubis", "Midas", "Parable", "Whiskey", "Tango", "Zulu",
  "Sierra", "Foxtrot", "Victor", "Yankee", "Romeo" , "Hotel", "Bravo", "Charlie", "Lima", "Oscar", "Xray",
  "Blackout", "Eagle", "Vulture", "Quickscope", "Overclock", "Church", "Camper", "Dark", "Bucky",
  "Birdshot", "Ruckus", "Oldie", "Queen", "Snake", "Breacher", "Ash", "Cloud", "Sleepy", 
  "Kidd", "Trooper", "Recruit", "Buzzkill", "Shovel", "Graves", "Zombie", "Knob", "Shepherd",
  "Ironsight", "Softie", "Cipher", "Cryptic", "Scramble", "Brainy", "Deadeye", "Daisy", "Wick",
  "Candles", "Skateboard", "Dixie", "Soda", "Window", "Icon", "Idol", "Tomboy", "Miles", "Dreamer",
  "Electro", "Renegade", "Ego", "Harry", "Mountain", "Fireman", "Chef", "Weatherman", "Rabbit",
  "Glass", "Hypnotize", "Syndrome", "Nano", "Tribes", "Luther", "Killshot", "Decade", "Pencil",
  "River", "Tide", "Vandal", "Spectre", "Bandit", "Frenzy", "Bulldog", "Insomniac", "Odin",
  "Peeker", "Ballhog", "Tank", "Seltzer", "Charmer", "Farmboy", "Chopper", "China", "Gymrat",
  "Hollywood", "Monroe", "Doctrine", "Maze", "DJ", "Cocktail", "Thinker", "Philos", "Pileup", "Leo",
  "Bigmouth", "Sinker", "Corny", "Daylight", "Shiny", "Ring", "Necklace", "Icy", "Freeze", "Booster",
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
export function skillParams(skill: number): { reactionTime: number; lambda: number; strafeOffsets: number[]; aimSigma: number } {
  const s = clamp01(skill);
  const n = 2 + Math.round(4 * s); // 2..6 candidate offsets
  return {
    reactionTime: Math.round(30 - 27 * s), // 30 sluggish -> ~3 sharp
    lambda: 2.5 + 5.5 * s, // timid taps -> long brave bursts
    strafeOffsets: FULL_STRAFE.slice(FULL_STRAFE.length - n),
    aimSigma: 48 - 42 * s, // ~48px wobble at skill 0 -> ~6px at skill 1
  };
}

/** Roll a random loadout from a named equip tier: a primary + secondary + armor
 *  (or, when the tier is `both: false`, just one weapon in its class's slot). */
export function rollLoadout(equip: string): PlayerLoadout {
  const t = equipTier(equip);
  const armor = t.armors.length ? pick(t.armors) : undefined;
  if (t.both === false) {
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

/** The registry key a spec object is filed under (identity match), or undefined
 *  for "none" / a spec that isn't in the registry. The inverse of the GUN_SPECS /
 *  ARMOR_SPECS lookup — used to describe gear the player is holding as a
 *  PlayerLoadout. */
function specKey<T>(specs: Record<string, T>, spec: T | undefined | null): string | undefined {
  if (!spec) return undefined;
  return Object.keys(specs).find((k) => specs[k] === spec);
}

/** A small random belt for a bot: 0–2 bandages and a ~40% chance of a syringe.
 *  Bots never use these, but they drop on death, so med kits circulate. */
export function rollUtilities(): UtilityStack[] {
  const out: UtilityStack[] = [];
  const bandages = Math.floor(Math.random() * 3); // 0..2
  if (bandages > 0) out.push(new UtilityStack(BANDAGE, bandages));
  if (Math.random() < 0.4) out.push(new UtilityStack(SYRINGE, 1));
  return out;
}

/** A persistent combatant identity — outlives the Character objects it drives,
 *  so callsign and K/D survive respawns. */
export interface Agent {
  name: string;
  team: "blue" | "red";
  /** A human (see `human`), as opposed to a bot. */
  isPlayer: boolean;
  /** The human's persistent character — revived in place each life, so this
   *  stays the same object while `char` is null between lives. Bots: undefined. */
  human?: Character;
  /** A human's most recent death (killer / weapon / range), to headline their
   *  respawn screen. Null until they first go down. */
  lastDeath?: { killerName: string; gunName: string | null; meters: number } | null;
  skill: number;
  /** Equipment tier name. Bots re-roll a gun+armor from it every (re)spawn. */
  equip: string;
  /** The player's chosen kit, edited at the respawn screen. Bots leave this unset. */
  loadout?: PlayerLoadout;
  /** The player is on "random": roll a fresh kit from `equip` every spawn, exactly
   *  like a bot. On at match start (so the opening life is a roll) and toggled by
   *  the respawn menu's dice button; picking any weapon/armor turns it off. Kept
   *  separate from `loadout` so an empty kit reads as a deliberate "fists only"
   *  rather than "unset". */
  random?: boolean;
  kills: number;
  deaths: number;
  /** The live character this agent currently drives, or null while awaiting respawn. */
  char: Character | null;
}

/** A downed combatant waiting to come back. */
interface RespawnSlot {
  agent: Agent;
  /** Tick the respawn timer is up — bots spawn on it, the player's button unlocks. */
  at: number;
  /** Tick they went down, for the beat before the player's menu opens. */
  diedAt: number;
}

/** Ticks between the player dying and the respawn menu appearing. The camera has
 *  already stopped dead with them; this is a held breath over the corpse before
 *  the UI takes the screen, so the kill reads instead of being cut off. */
const MENU_DELAY = 60;

/**
 * Base for blue-vs-red team modes. Owns the roster, spawning, respawns, K/D, and
 * the HUD scaffold; subclasses fill in the scoring rule via the hooks:
 *   - `teamScores()` — the bottom-left ticket bars.
 *   - `blueLost()` — which side lost, for the win/lose banner.
 *   - `onInit`/`afterDeath`/`rules`/`extraHud` — optional mode state + logic.
 */
export abstract class TeamMatchMode implements Gamemode {
  abstract readonly id: string;
  abstract readonly label: string;
  // Respawns would otherwise bury the map in corpses and dropped gear, so both
  // clear on a timer (blinking out over their last second).
  readonly bodyTtl = 720; // ~12s
  readonly itemTtl = 900; // ~15s

  protected readonly cfg: TeamMatchConfig;
  protected phase: "playing" | "over" = "playing";
  protected agents: Agent[] = [];
  protected queue: RespawnSlot[] = [];
  /** Character -> its Agent, kept even after the character dies, so a kill that
   *  lands after the shooter died/respawned still credits the right agent. */
  protected charAgent = new WeakMap<Character, Agent>();
  /** Hands out the match's callsigns (see NAMES); rebuilt in init. */
  private nextName: () => string = () => "?";

  constructor(cfg: TeamMatchConfig) {
    this.cfg = cfg;
  }

  /** Match decided. A getter (not a direct `phase` read) so the guards re-check
   *  it after the subclass hooks — which set `phase` — rather than TS narrowing
   *  it away. */
  protected get matchOver(): boolean {
    return this.phase === "over";
  }

  init(ctx: GameCtx): void {
    this.phase = "playing";
    this.agents = [];
    this.queue = [];
    this.charAgent = new WeakMap();

    const names = shuffle(NAMES.slice());
    let n = 0;
    this.nextName = (): string => {
      const base = names[n % names.length];
      const dup = n >= names.length ? ` ${Math.floor(n / names.length) + 1}` : "";
      n += 1;
      return base + dup;
    };

    // The humans ARE blue's first combatants (each fills one slot, so blue also
    // fields blueTroops - humans bots), wear the blue skin, and start on blue's
    // equip tier.
    for (const h of ctx.humans) this.enlistHuman(ctx, h.char, h.name);
    this.addBots(ctx, "blue", Math.max(0, this.cfg.blue.troops - ctx.humans.length));
    this.addBots(ctx, "red", this.cfg.red.troops);

    this.onInit(ctx);
  }

  /** Put a human on blue as a fresh agent and spawn them. `name` = their own
   *  (a joined player's), or a callsign from the pool when they have none. */
  private enlistHuman(ctx: GameCtx, who: Character, name?: string): Agent {
    who.team = "blue";
    const blueSkin = SKINS[TEAM_SKIN.blue];
    if (blueSkin) who.skin = blueSkin;
    const a: Agent = {
      name: name && name.trim() && !name.startsWith("Player ") ? name.trim() : this.nextName(),
      team: "blue", isPlayer: true, human: who, skill: this.cfg.blue.skill,
      equip: this.cfg.blue.equip, loadout: {}, random: true, lastDeath: null,
      kills: 0, deaths: 0, char: who,
    };
    this.agents.push(a);
    this.spawnAgent(ctx, a);
    return a;
  }

  private addBots(ctx: GameCtx, team: "blue" | "red", count: number): void {
    const cfg = this.cfg[team];
    for (let i = 0; i < count; i++) {
      const a: Agent = {
        name: this.nextName(), team, isPlayer: false, skill: cfg.skill,
        equip: cfg.equip, kills: 0, deaths: 0, char: null,
      };
      this.agents.push(a);
      this.spawnAgent(ctx, a);
    }
  }

  /** A human joined mid-match: they take a blue slot, and a blue bot (a live
   *  one, else one waiting to respawn) is retired to keep blue's headcount. */
  onHumanJoin(ctx: GameCtx, who: Character): void {
    const slot = ctx.humans.find((h) => h.char === who);
    this.enlistHuman(ctx, who, slot?.name);
    const bot = this.agents.find((a) => a.team === "blue" && !a.isPlayer);
    if (bot) this.retire(ctx, bot);
  }

  /** A human left: their agent goes (no death, no ticket), and a blue bot
   *  takes the slot back. */
  onHumanLeave(ctx: GameCtx, who: Character): void {
    const a = this.charAgent.get(who);
    if (!a) return;
    this.retire(ctx, a);
    if (!this.matchOver) this.addBots(ctx, "blue", 1);
  }

  /** Drop an agent from the roster and the respawn queue, and its character
   *  (if alive) from the world without a death. */
  private retire(ctx: GameCtx, a: Agent): void {
    if (a.char) ctx.removeCharacter(a.char);
    a.char = null;
    this.agents = this.agents.filter((x) => x !== a);
    this.queue = this.queue.filter((q) => q.agent !== a);
  }

  /** The agent a human character belongs to, if it is one. */
  private humanAgent(who: Character | undefined): Agent | undefined {
    const a = who ? this.charAgent.get(who) : undefined;
    return a?.isPlayer ? a : undefined;
  }

  /** (Re)spawn an agent's character at one of its team's zones. Bots re-roll a
   *  fresh full kit every spawn; the player does too while it's on `random`,
   *  otherwise it gets exactly what the respawn menu shows. Subclasses can
   *  override `troopOptions` to build a different AI (e.g. an objective AI). */
  protected spawnAgent(ctx: GameCtx, agent: Agent): void {
    const sp = ctx.spawnPoint(agent.team);
    if (!sp) {
      console.warn(`${this.id}: no ${agent.team} spawn zone — ${agent.name} couldn't spawn`);
      return;
    }
    if (agent.isPlayer) {
      const who = agent.human!;
      ctx.reviveHuman(who, sp.pos, sp.z, agent.random ? rollLoadout(agent.equip) : (agent.loadout ?? {}));
      agent.char = who;
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
        utilities: rollUtilities(),
        ai: this.botAi,
      });
      agent.char = c;
      ctx.addCharacter(c);
    }
    if (agent.char) this.charAgent.set(agent.char, agent);
  }

  /** Which soldier AI the bots use (makeTroop `ai`). Default = plain TacOracle;
   *  Domination overrides this with its objective-seeking subclass. */
  protected get botAi(): "tacoracle" | "domination" | undefined {
    return undefined;
  }

  /** Store a human's next-life kit (respawn-screen menu), keeping only keys
   *  that exist so a stale/garbage value can't break a spawn. */
  setPlayerLoadout(who: Character, loadout: PlayerLoadout): void {
    const a = this.humanAgent(who);
    if (!a) return;
    a.loadout = {
      primary: loadout.primary && loadout.primary in GUN_SPECS ? loadout.primary : undefined,
      secondary: loadout.secondary && loadout.secondary in GUN_SPECS ? loadout.secondary : undefined,
      armor: loadout.armor && loadout.armor in ARMOR_SPECS ? loadout.armor : undefined,
    };
    a.random = false; // an explicit pick overrides the dice
  }

  /** A human hit the dice button: hand them the same roll the bots get from
   *  their side's equip tier, fresh every life, until they pick something. */
  randomizePlayerLoadout(who: Character): void {
    const a = this.humanAgent(who);
    if (a) a.random = true;
  }

  /** A human pressed Respawn. Respawning is voluntary — a human's queue entry
   *  is never spawned by `update`, it just sits there marking when the timer is
   *  up — so this is the only way back in. No-op (false) while the timer still
   *  has time on it. */
  requestRespawn(ctx: GameCtx, who: Character): boolean {
    const agent = this.humanAgent(who);
    if (this.matchOver || !agent || agent.char) return false; // decided, or already alive
    const i = this.queue.findIndex((p) => p.agent === agent);
    if (i >= 0) {
      if (ctx.tick < this.queue[i].at) return false; // timer still running
      this.queue.splice(i, 1);
    }
    // No queue entry but no character either means a spawn already failed (a
    // level with no zone for this team). Retry rather than leave the button dead.
    this.spawnAgent(ctx, agent);
    return true;
  }

  /** Seconds until `agent` may respawn (0 = now), or undefined if it's not
   *  waiting to. */
  private respawnIn(ctx: GameCtx, agent: Agent): number | undefined {
    const mine = this.queue.find((p) => p.agent === agent);
    return mine ? Math.max(0, (mine.at - ctx.tick) / 60) : undefined;
  }

  /** A team's total deaths across the match (TDM's ticket spend). */
  protected teamDeaths(team: "blue" | "red"): number {
    return this.agents.reduce((s, a) => (a.team === team ? s + a.deaths : s), 0);
  }

  onDeath(dead: Character, ctx: GameCtx): void {
    if (this.matchOver) return;
    const victim = this.charAgent.get(dead);
    if (!victim) return; // not a combatant

    victim.deaths += 1;
    victim.char = null;
    // While a human is on random they have no picks of their own, so park the
    // kit they went down with under the dice: the menu opens on something real,
    // and turning random off starts from what they were just carrying. Once they
    // pick for themselves those picks are theirs and this stops overwriting them.
    // Called from reapDead before the corpse drops its gear, so slots are filled.
    if (victim.isPlayer && victim.random) {
      victim.loadout = {
        primary: specKey(GUN_SPECS, dead.slots.primary?.spec),
        secondary: specKey(GUN_SPECS, dead.slots.secondary?.spec),
        armor: specKey(ARMOR_SPECS, dead.armor?.spec),
      };
    }
    // Only a kill against a team you're hostile to counts. Friendly-fire and
    // neutral kills (e.g. rocket splash catching a teammate, or a self-kill) still
    // register the death but credit no kill — mirrors the AI's areHostile targeting.
    const attacker = dead.lastAttacker as Character | null;
    const killer = attacker ? this.charAgent.get(attacker) : undefined;
    if (killer && killer !== victim && areHostile(attacker!.team, dead.team)) killer.kills += 1;

    // Kill feed: any kill a human is part of — as the killer (enemies AND team
    // kills), as the victim, or as both, since blowing yourself up is a death
    // worth reporting even though it credits nobody. Newest on top (unshift); the
    // Game ages them out and a 5th kill evicts the oldest.
    if (attacker && killer) {
      const meters = Math.hypot(attacker.pos.x - dead.pos.x, attacker.pos.y - dead.pos.y) / PX_PER_METER;
      for (const h of ctx.humans) {
        if (attacker !== h.char && dead !== h.char) continue;
        h.killFeed.unshift({
          killerName: killer.name,
          killerColor: TEAMS[killer.team].color,
          victimName: victim.name,
          victimColor: TEAMS[victim.team].color,
          gun: dead.lastAttackerGun,
          meters,
          marks: dead.lastAttackerMarks,
          selfKill: killer === victim,
          age: 0,
        });
        if (h.killFeed.length > KILLFEED_MAX) h.killFeed.length = KILLFEED_MAX;
      }
      // When it's a human who went down, headline their respawn screen with it.
      // (A self-kill names them as their own killer, which reads correctly.)
      if (victim.isPlayer) {
        victim.lastDeath = { killerName: killer.name, gunName: dead.lastAttackerGun?.name ?? null, meters };
      }
    }

    this.afterDeath(victim, ctx); // subclass may end the match (TDM: killLimit)
    if (this.matchOver) return;
    this.queue.push({ agent: victim, at: ctx.tick + this.cfg.respawnDelay, diedAt: ctx.tick });
  }

  update(ctx: GameCtx): void {
    if (this.matchOver) return;
    // Respawn every BOT whose timer is up; keep the not-yet-due ones for later.
    // The player's entry always waits — it respawns only when they press the
    // button (requestRespawn), so there's no rush on the loadout menu.
    const waiting: RespawnSlot[] = [];
    for (const p of this.queue) {
      if (ctx.tick < p.at || p.agent.isPlayer) waiting.push(p);
      else this.spawnAgent(ctx, p.agent);
    }
    this.queue = waiting;
    this.rules(ctx); // subclass per-tick scoring (domination point control)
  }

  hud(ctx: GameCtx, viewer?: Character): GamemodeHud {
    const me = this.humanAgent(viewer);
    const players: PlayerRow[] = this.agents.map((a) => ({
      name: a.name,
      team: a.team,
      color: TEAMS[a.team].color,
      kills: a.kills,
      deaths: a.deaths,
      isPlayer: a === me,
    }));

    // The viewer awaiting respawn: dead (no live char) while the match plays on.
    // Held back for MENU_DELAY ticks after the death so the panel doesn't slam up
    // the instant they go down. A dead human with no queue slot (their spawn
    // failed) has no death tick to wait on, so the menu opens right away — it's
    // their only way back in.
    const dead = this.phase === "playing" && !!me && me.char === null;
    const slot = dead ? this.queue.find((p) => p.agent === me) : undefined;
    const choosingLoadout = dead && (!slot || ctx.tick - slot.diedAt >= MENU_DELAY);

    // No death banner while choosing: the respawn menu is centered over the same
    // space and carries its own "YOU DIED" heading + countdown.
    const banner = this.matchOver
      ? `${this.blueLost() ? "Defeat" : "Victory"}\nPress Enter to restart`
      : undefined;

    return {
      name: this.label,
      scores: this.teamScores(),
      banner,
      over: this.matchOver,
      players,
      choosingLoadout,
      deathTitle: me?.lastDeath
        ? `Killed by ${me.lastDeath.killerName}` +
          (me.lastDeath.gunName ? ` using ${me.lastDeath.gunName}` : "") +
          ` at ${me.lastDeath.meters.toFixed(1)} meters`
        : undefined,
      loadout: me?.loadout,
      randomLoadout: !!me?.random,
      respawnIn: choosingLoadout && me ? (this.respawnIn(ctx, me) ?? 0) : undefined,
      ...this.extraHud(ctx),
    };
  }

  // --- subclass rule hooks -----------------------------------------------------

  /** The bottom-left ticket bars (remaining/limit per team). */
  protected abstract teamScores(): TeamScore[];
  /** Which side lost, once `phase === "over"` — drives the win/lose banner. */
  protected abstract blueLost(): boolean;
  /** Mode state to (re)initialize at match start (after the roster is built). */
  protected onInit(_ctx: GameCtx): void {}
  /** Just-scored a death (K/D already credited); may set `phase = "over"`. */
  protected afterDeath(_victim: Agent, _ctx: GameCtx): void {}
  /** Per-tick scoring, after respawns are processed. */
  protected rules(_ctx: GameCtx): void {}
  /** Extra HUD fields to merge in (e.g. domination `points`). */
  protected extraHud(_ctx: GameCtx): Partial<GamemodeHud> {
    return {};
  }
}
