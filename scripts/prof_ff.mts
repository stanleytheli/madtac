/**
 * prof_ff.mts — how much friendly fire do bots actually commit, and where does
 * it come from? Runs headless TDM matches and attributes every point of damage
 * a bot deals to a teammate, classifying WHY the shot was taken:
 *
 *   overshoot  the mate was beyond the target (past it down the same line)
 *   spread     the mate was inside the lane but outside FRIENDLY_MARGIN
 *   walked-in  the lane was clear when the trigger went, the mate moved into it
 *   in-lane    the mate was in the lane at fire time and the bot fired anyway
 *   blast      splash from an explosion, not a bullet
 *   melee      a swing
 *
 * The classification is what tells you which fix is worth making; the totals are
 * the baseline any fix has to beat.
 *
 * Run: node_modules/.bin/esbuild scripts/prof_ff.mts --bundle --platform=node
 *   --format=esm --banner:js='globalThis.window={innerWidth:1920,innerHeight:1080};'
 *   --outfile=<tmp>/pf.mjs && node <tmp>/pf.mjs [matches] [ticks] [level]
 */
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/world/level.ts";
import { Game } from "../src/game.ts";
import { Character } from "../src/entities/actor.ts";
import { TeamDeathmatchMode } from "../src/gamemodes/tdm.ts";
import { BODY_RADIUS } from "../src/entities/character.ts";
import { areHostile } from "../src/entities/team.ts";
import type { GunSpec } from "../src/entities/guns.ts";
import type { Hittable } from "../src/world/world.ts";
import type { Vec2 } from "../src/engine/vec.ts";

const MATCHES = Number(process.argv[2] ?? 6);
const TICKS = Number(process.argv[3] ?? 4000);
const LEVEL = process.argv[4] ?? "tdm-arena-big";
// Seeded from argv (see the banner in the run line): bot fights are chaotic, and
// an unseeded before/after comparison of a ~1%-of-damage effect is noise.
const SEED = Number(process.argv[5] ?? 1);
const TEXT = readFileSync(`src/world/levels/${LEVEL}.json`, "utf8");

const FRIENDLY_MARGIN = BODY_RADIUS * 2; // mirrors tacoracle's constant

type Kind = "overshoot" | "spread" | "walked-in" | "in-lane" | "blast" | "melee" | "unknown";
interface Tally { damage: number; hits: number; kills: number }
const zero = (): Tally => ({ damage: 0, hits: 0, kills: 0 });

const friendly: Record<Kind, Tally> = {
  overshoot: zero(), spread: zero(), "walked-in": zero(), "in-lane": zero(),
  blast: zero(), melee: zero(), unknown: zero(),
};
const byWeapon = new Map<string, Tally>();
// Leading indicators: friendly HITS are rare, so counting the risky trigger pulls
// that produce them gives far more signal per tick than waiting for damage.
let shotsFired = 0;
let shotsMateInLane = 0; // a mate downrange within FRIENDLY_MARGIN — the lane rule's own test
let shotsMateNearLane = 0; // ...within 2x that: outside the rule, inside a spray
let shotsMateBeyond = 0; // a mate past the target on the same line (overshoot risk)
let hostileDamage = 0;
let hostileKills = 0;
let friendlyTotal = 0;
let friendlyKills = 0;

/** Where each bot was aiming when it last pulled the trigger, so a friendly hit
 *  can be classified against the lane the shooter actually believed in. */
const lastShot = new Map<Character, {
  from: Vec2; at: Vec2; tick: number; laneWasClear: boolean;
  /** How fast the SHOOTER was moving when it pulled (0..1 of its top speed) and
   *  how wide its rounds could go at that speed — movePenalty widens spread, so a
   *  moving gunner sprays outside the lane its own rule cleared. */
  speed: number; spread: number;
}>();
// Base rates, so "friendly hits happen while moving" can be compared against
// "most shots happen while moving" instead of being read as a cause on its own.
let shotsMoving = 0;
let ffFromMoving = 0;
let ffFromStill = 0;
let ffMateMoving = 0;
let ffMateStill = 0;
let ffOutsideOwnSpread = 0; // the mate was further off the lane than the gun could spray
const MOVING = 0.25; // speedRatio above which we call a shooter "on the move"
let tick = 0;

/** Was `mate` inside the firing lane from -> at, and where along it? */
function laneGeometry(from: Vec2, at: Vec2, mate: Vec2): { t: number; off: number } {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  const len2 = dx * dx + dy * dy || 1e-6;
  const t = ((mate.x - from.x) * dx + (mate.y - from.y) * dy) / len2;
  const ex = mate.x - (from.x + dx * t);
  const ey = mate.y - (from.y + dy * t);
  return { t, off: Math.hypot(ex, ey) };
}

function classify(victim: Character, attacker: Character, gun: GunSpec | null): Kind {
  if (gun?.projectile) return "blast";
  if (gun?.melee) return "melee";
  const shot = lastShot.get(attacker);
  if (!shot) return "unknown";
  const g = laneGeometry(shot.from, shot.at, victim.pos);
  if (g.t > 1) return "overshoot";
  if (g.off > FRIENDLY_MARGIN) return "spread";
  return shot.laneWasClear ? "walked-in" : "in-lane";
}

// --- instrument: every damaging hit, with the shooter's last-known lane -------
const realRegister = Character.prototype.registerHit;
Character.prototype.registerHit = function (
  this: Character,
  dir: Vec2, point: Vec2, damage: number, armorPen: never,
  attacker: Hittable | null = null, gun: GunSpec | null = null, marks?: never,
): void {
  const before = this.hp;
  realRegister.call(this, dir, point, damage, armorPen, attacker, gun, marks);
  const dealt = before - this.hp;
  const died = before > 0 && this.hp <= 0;
  if (!(attacker instanceof Character) || attacker === this || dealt <= 0) {
    if (died && attacker instanceof Character && !areHostile(attacker.team, this.team)) friendlyKills += 1;
    return;
  }
  if (areHostile(attacker.team, this.team)) {
    hostileDamage += dealt;
    if (died) hostileKills += 1;
    return;
  }
  friendlyTotal += dealt;
  if (died) friendlyKills += 1;
  const shot = lastShot.get(attacker);
  if (shot) {
    if (shot.speed > MOVING) ffFromMoving += 1;
    else ffFromStill += 1;
    // Was this hit even reachable by the gun's own dispersion from where it aimed?
    const g = laneGeometry(shot.from, shot.at, this.pos);
    const reachable = Math.tan(shot.spread) * Math.max(1, g.t * 800) + BODY_RADIUS;
    if (g.off > reachable) ffOutsideOwnSpread += 1;
  }
  if (this.speed > 0.4) ffMateMoving += 1;
  else ffMateStill += 1;
  const kind = classify(this, attacker, gun);
  friendly[kind].damage += dealt;
  friendly[kind].hits += 1;
  if (died) friendly[kind].kills += 1;
  const key = gun?.name ?? "(none)";
  const t = byWeapon.get(key) ?? zero();
  t.damage += dealt;
  t.hits += 1;
  if (died) t.kills += 1;
  byWeapon.set(key, t);
};

// --- instrument: record the lane a bot believed in as it fired ---------------
const realFire = Character.prototype.fire;
Character.prototype.fire = function (this: Character, world: never, targets: never): boolean {
  const fired = realFire.call(this, world, targets);
  if (fired) {
    // The bot's aim point is its facing; project it out to a target-ish range.
    const at = { x: this.pos.x + this.forward.x * 800, y: this.pos.y + this.forward.y * 800 };
    const mates = (targets as unknown as Character[]).filter(
      (c) => c !== this && c.hp > 0 && c.z === this.z && !areHostile(this.team, c.team),
    );
    shotsFired += 1;
    let inLane = false;
    let nearLane = false;
    let beyond = false;
    for (const m of mates) {
      const g = laneGeometry(this.pos, at, m.pos);
      if (g.t <= 0) continue; // behind the muzzle
      if (g.t < 1 && g.off < FRIENDLY_MARGIN) inLane = true;
      else if (g.t < 1 && g.off < 2 * FRIENDLY_MARGIN) nearLane = true;
      else if (g.t >= 1 && g.off < FRIENDLY_MARGIN) beyond = true;
    }
    if (inLane) shotsMateInLane += 1;
    if (nearLane) shotsMateNearLane += 1;
    if (beyond) shotsMateBeyond += 1;
    const laneWasClear = !inLane;
    const speed = this.speedRatio;
    if (speed > MOVING) shotsMoving += 1;
    lastShot.set(this, {
      from: { x: this.pos.x, y: this.pos.y }, at, tick, laneWasClear,
      speed, spread: this.gun.maxSpread(speed),
    });
  }
  return fired;
};

// --- run ---------------------------------------------------------------------
for (let m = 0; m < MATCHES; m++) {
  const game = new Game(loadLevel(TEXT), new TeamDeathmatchMode({ blue: { troops: 5 }, red: { troops: 5 } }));
  for (let i = 0; i < TICKS; i++) {
    tick = i;
    game.update();
  }
}

const pct = (x: number, of: number): string => (of > 0 ? `${((100 * x) / of).toFixed(1)}%` : "—");
const totalDamage = hostileDamage + friendlyTotal;
console.log(`\n${MATCHES} matches x ${TICKS} ticks on ${LEVEL} (5v5), seed ${SEED}\n`);
console.log(`damage to enemies   ${hostileDamage.toFixed(0).padStart(9)}`);
console.log(`damage to teammates ${friendlyTotal.toFixed(0).padStart(9)}   ${pct(friendlyTotal, totalDamage)} of all damage dealt`);
console.log(`kills of enemies    ${String(hostileKills).padStart(9)}`);
console.log(`kills of teammates  ${String(friendlyKills).padStart(9)}   ${pct(friendlyKills, hostileKills + friendlyKills)} of all kills`);

console.log(`\nrisky trigger pulls (of ${shotsFired} shots):`);
console.log(`  mate IN the lane      ${String(shotsMateInLane).padStart(7)}   ${pct(shotsMateInLane, shotsFired)}`);
console.log(`  mate just outside it  ${String(shotsMateNearLane).padStart(7)}   ${pct(shotsMateNearLane, shotsFired)}   (inside a spray, outside the rule)`);
console.log(`  mate BEYOND the target${String(shotsMateBeyond).padStart(7)}   ${pct(shotsMateBeyond, shotsFired)}   (overshoot risk — the rule stops at the target)`);

const ffHits = ffFromMoving + ffFromStill;
console.log(`\nwas the SHOOTER moving? (>${MOVING} of its top speed)`);
console.log(`  shots taken on the move   ${String(shotsMoving).padStart(7)} of ${shotsFired}   ${pct(shotsMoving, shotsFired)}   <- base rate`);
console.log(`  friendly hits from those  ${String(ffFromMoving).padStart(7)} of ${ffHits}   ${pct(ffFromMoving, ffHits)}`);
console.log(`  friendly hits while still ${String(ffFromStill).padStart(7)} of ${ffHits}   ${pct(ffFromStill, ffHits)}`);
console.log(`  hit rate per shot: moving ${(shotsMoving ? ffFromMoving / shotsMoving : 0).toExponential(2)}   still ${(shotsFired - shotsMoving ? ffFromStill / (shotsFired - shotsMoving) : 0).toExponential(2)}`);
console.log(`  the VICTIM was moving in  ${String(ffMateMoving).padStart(7)} of ${ffMateMoving + ffMateStill} hits`);
console.log(`  further off the lane than the gun could spray: ${ffOutsideOwnSpread} of ${ffHits}`);

console.log(`\nfriendly damage by cause:`);
const kinds = (Object.keys(friendly) as Kind[]).sort((a, b) => friendly[b].damage - friendly[a].damage);
for (const k of kinds) {
  const t = friendly[k];
  if (t.hits === 0) continue;
  console.log(`  ${k.padEnd(11)} ${t.damage.toFixed(0).padStart(8)}  ${pct(t.damage, friendlyTotal).padStart(6)}   ${String(t.hits).padStart(5)} hits, ${t.kills} kills`);
}

console.log(`MOV\t${SEED}\t${shotsFired}\t${shotsMoving}\t${ffFromMoving}\t${ffFromStill}\t${ffMateMoving}\t${ffMateStill}\t${ffOutsideOwnSpread}\t${shotsMateNearLane}`);
console.log(`\nTSV\t${SEED}\t${friendlyTotal.toFixed(1)}\t${friendlyKills}\t${hostileDamage.toFixed(1)}\t${hostileKills}\t${shotsFired}\t${shotsMateInLane}\t${shotsMateBeyond}`);

console.log(`\nfriendly damage by weapon:`);
for (const [name, t] of [...byWeapon].sort((a, b) => b[1].damage - a[1].damage).slice(0, 10)) {
  console.log(`  ${name.padEnd(16)} ${t.damage.toFixed(0).padStart(8)}  ${pct(t.damage, friendlyTotal).padStart(6)}   ${String(t.hits).padStart(5)} hits, ${t.kills} kills`);
}
