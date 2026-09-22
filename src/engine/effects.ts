/**
 * The client's side of the sim's events (see engine/events.ts): what a tick's
 * sounds, impacts and hits look and sound like HERE, on this screen, in these
 * ears. The sim emits; this reacts. Split in two so a headless script can have
 * the debris without the audio:
 *
 *   - spawnEffects: particles and bullet holes into the world's cosmetic arrays
 *     (pure — no browser needed), and tickCosmetics to age them.
 *   - SoundPlayer: the audio engine, plus the ONE thing that needs to know who
 *     the local player is — turning a "hit" event into their hurt sound or
 *     hit-confirm.
 */
import { playSound, stopSound, type SoundHandle } from "./audio.ts";
import { stampBulletHole, updateDecals } from "./decal.ts";
import type { GameEvent } from "./events.ts";
import { spawnParticles, updateParticles } from "./particle.ts";
import { PLAYER_HIT_SOUND, PLAYER_HURT_SOUND } from "../world/hitsounds.ts";
import type { World } from "../world/world.ts";

/** Throw this tick's debris and stamp its bullet holes (from w.events into
 *  w.particles / w.decals). Leaves the events in place for the sound side. */
export function spawnEffects(w: World): void {
  for (const e of w.events) {
    if (e.kind === "particles") spawnParticles(w.particles, e.pos, e.dir, e.burst, e.z, e.heft);
    else if (e.kind === "decal") stampBulletHole(w.decals, e.near, e.on, e.z, e.heft);
  }
}

/** Age the debris and the bullet holes one tick. The sim used to do this
 *  inside updateBullets; it is the client's now, like the arrays themselves. */
export function tickCosmetics(w: World): void {
  w.particles = updateParticles(w.particles);
  w.decals = updateDecals(w.decals);
}

/** A headless script's whole reaction to one sim step it drove itself (an
 *  updateBullets, a fire, an explode): spawn the step's debris and holes, drop
 *  its events, age the cosmetics — everything the client does per tick except
 *  the sounds. Only Game.update clears events on its own, so a script stepping
 *  the world by hand must, or the next spawnEffects throws them all again. */
export function stepEffects(w: World): void {
  spawnEffects(w);
  w.events.length = 0;
  tickCosmetics(w);
}

/**
 * Plays a tick's sound events. Ongoing sounds (a reload clip, a bolt cycle)
 * arrive named by a `voice`; the handle the audio engine gives back is kept
 * under that name so a later `stopSound` event can cut it — the gun that
 * started it never sees a handle.
 */
export class SoundPlayer {
  private readonly voices = new Map<string, SoundHandle>();

  /** Play every sound in `events`. `localPlayerId` is whose ears these are:
   *  a hit ON them is their hurt sound, a hit BY them their hit-confirm, both
   *  flat (feedback, not a sound in the world). Null = nobody's — no feedback. */
  play(events: readonly GameEvent[], localPlayerId: number | null): void {
    for (const e of events) {
      if (e.kind === "sound") {
        const h = playSound(e.sound, { pos: e.pos, z: e.z, pitchVar: e.pitchVar });
        if (e.voice) {
          if (h) this.voices.set(e.voice, h);
          else this.voices.delete(e.voice); // out of earshot / not loaded: nothing to cut later
        }
      } else if (e.kind === "stopSound") {
        const h = this.voices.get(e.voice);
        if (h !== undefined) {
          stopSound(h);
          this.voices.delete(e.voice);
        }
      } else if (e.kind === "hit" && localPlayerId !== null) {
        if (e.victim === localPlayerId) playSound(PLAYER_HURT_SOUND);
        else if (e.attacker === localPlayerId) playSound(PLAYER_HIT_SOUND);
      }
    }
  }
}
