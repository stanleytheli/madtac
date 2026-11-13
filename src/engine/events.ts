/**
 * What the simulation TELLS the outside world happened this tick, as data.
 *
 * The sim used to play its own sounds and throw its own particles from inside
 * bullet resolution, gun fire, and the footstep loop. Now it appends one of
 * these to `World.events` instead and the CLIENT decides what a shot, an impact,
 * or a footstep looks and sounds like (see engine/effects.ts). The sim stays
 * pure — runnable headless, and one day on a server — and the event list is
 * exactly what a server would send a client to replicate the tick's cosmetics.
 *
 * Events are the tick's output: Game.update clears the list at the START of
 * every tick, so whoever runs the sim reads them between ticks or loses them.
 */
import type { SoundRef } from "./audio.ts";
import type { ParticleBurst } from "./particle.ts";
import type { Vec2 } from "./vec.ts";
import type { Obstacle } from "../world/world.ts";

export type GameEvent =
  /** A one-shot sound. `pos`/`z` place it in the world; omitted = flat, in the
   *  listener's ears. `voice` names an ONGOING sound (a reload clip, a bolt
   *  cycle) so a later `stopSound` can cut it short — e.g. "reload:<gun id>".
   *  `by` is the character whose own action made it (a shot, a reload, a
   *  footstep): a networked client that plays its own player's actions the
   *  moment they happen skips the server's copy of those. */
  | { kind: "sound"; sound: SoundRef; pos?: Vec2; z?: number; pitchVar?: number; voice?: string; by?: number }
  /** Cut a named ongoing sound short (see `voice` above). */
  | { kind: "stopSound"; voice: string }
  /** Damage landed on `victim` from `attacker` (entity ids; null = no one, e.g.
   *  a test hit). The client turns this into ITS player's hit-confirm or hurt
   *  sound by comparing ids — the sim no longer knows who the local player is.
   *  `round` = landed by a round in flight, which a client predicting its own
   *  shots has already shown (so it skips the server's copy). */
  | { kind: "hit"; victim: number; attacker: number | null; round?: true }
  /** Debris / blood / smoke thrown from `pos` along `dir` (see spawnParticles).
   *  `by` (here and on decal and blood) = the shooter whose round it was, for
   *  the same reason as a sound's. */
  | { kind: "particles"; pos: Vec2; dir: Vec2; burst: ParticleBurst; z: number; heft: number; by?: number }
  /** A bullet hole on `on`, for a round that reached `near` (see stampBulletHole). */
  | { kind: "decal"; near: Vec2; on: Obstacle; z: number; heft: number; by?: number }
  /** A blast's scorch mark, `size` px wide at `opacity`, on the floors at `pos` (see stampScorch). */
  | { kind: "scorch"; pos: Vec2; z: number; size: number; opacity: number }
  /** Blood on the ground from a hit that landed at `pos` and cost the body
   *  `damage` (after armor), sprayed along `dir` (see stampBloodSplatter). */
  | { kind: "blood"; pos: Vec2; dir: Vec2; z: number; damage: number; by?: number };

/** Append a positioned (or flat) sound event. */
export function emitSound(
  events: GameEvent[],
  sound: SoundRef,
  opts: { pos?: Vec2; z?: number; pitchVar?: number; voice?: string; by?: number } = {},
): void {
  events.push({ kind: "sound", sound, ...opts });
}
