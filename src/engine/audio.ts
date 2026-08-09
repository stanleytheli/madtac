/**
 * Sound playback, on top of Howler.js. Howler owns the fragile part — creating
 * the AudioContext, unlocking it on the first user gesture, and resuming it after
 * the browser suspends or interrupts it (tab blur, lost audio focus, Safari's
 * aggressive suspend). We keep only the game-specific bit on top: positional
 * volume + stereo pan relative to the listener (the player).
 *
 * Files live in public/audio/ and are referenced by bare filename
 * (e.g. "gunshot.wav" -> /audio/gunshot.wav). Call sites are unchanged:
 *   playSound(file, { pos, z, volume, pitchVar })
 */
import { Howl, Howler } from "howler";
import type { Vec2 } from "./vec.ts";

/** 1 m = 50 world px, matching the killfeed's PX_PER_METER. */
const PX_PER_METER = 50;
/** Full volume within this distance of the listener (world px). */
const FULL_PX = 7.5 * PX_PER_METER;
/** Distance falloff: every this many px past FULL_PX, loudness halves (−6 dB). */
const HALF_LIFE_PX = 15 * PX_PER_METER;
/** Below this gain a sound is inaudible — skip it entirely. */
const MIN_GAIN = 0.02;
/** Lateral offset (world px) that maps to a fully hard L/R pan. */
const PAN_PX = 18 * PX_PER_METER;
/** A sound on another floor is muffled to this fraction of its volume. */
const OFFLEVEL_GAIN = 0.3;
/** Concurrent instances Howler keeps per sound before recycling the oldest —
 *  generous so overlapping full-auto shots don't cut each other short. */
const POOL = 12;

/** The listener (player) position + floor, updated once per frame. */
const listener = { x: 0, y: 0, z: 0 };

/** Point positional audio at the player. Call each frame from render(). */
export function setListener(pos: Vec2, z: number): void {
  listener.x = pos.x;
  listener.y = pos.y;
  listener.z = z;
}

// One Howl per file, created lazily. Howler fetches, decodes, and caches the
// buffer, and pools instances for overlapping plays.
const sounds = new Map<string, Howl>();
function get(file: string): Howl {
  let h = sounds.get(file);
  if (!h) {
    h = new Howl({ src: [`/audio/${file}`], preload: true, pool: POOL });
    sounds.set(file, h);
  }
  return h;
}

/** Warm sounds ahead of first use so there's no decode hitch on the first play. */
export function preload(...files: string[]): void {
  for (const f of files) get(f);
}

/** Nudge the context back to running. Howler auto-unlocks on the first gesture
 *  and auto-resumes on its own, but calling this from our key/mouse handlers is a
 *  cheap belt-and-suspenders against Safari suspending it out from under us. */
export function unlockAudio(): void {
  const ctx = Howler.ctx;
  if (ctx && ctx.state !== "running") void ctx.resume();
}

export interface PlayOpts {
  /** World position of the event; omit for a non-positional (centered) sound. */
  pos?: Vec2;
  /** The event's floor; when it differs from the listener's, the sound is muffled. */
  z?: number;
  /** Base volume multiplier (default 1). */
  volume?: number;
  /** ± this fraction of random pitch wobble (0.06 = ±6%) so repeats differ. */
  pitchVar?: number;
}

/** Play `file` once, positioned relative to the listener. */
export function playSound(file: string, opts: PlayOpts = {}): void {
  let gain = opts.volume ?? 1;
  let pan = 0;
  if (opts.pos) {
    const dx = opts.pos.x - listener.x;
    const dy = opts.pos.y - listener.y;
    const d = Math.hypot(dx, dy);
    // Exponential (half-life) falloff: full within FULL_PX, halving every HALF_LIFE_PX.
    if (d > FULL_PX) gain *= 2 ** (-(d - FULL_PX) / HALF_LIFE_PX);
    if (opts.z !== undefined && opts.z !== listener.z) gain *= OFFLEVEL_GAIN;
    if (gain < MIN_GAIN) return; // inaudible — don't spend a voice on it
    pan = Math.max(-1, Math.min(1, dx / PAN_PX));
  }

  const h = get(file);
  const id = h.play();
  h.volume(gain, id);
  if (opts.pos) h.stereo(pan, id);
  if (opts.pitchVar) h.rate(1 + (Math.random() * 2 - 1) * opts.pitchVar, id);
}

// Dev-only (Vite HMR): free this module's Howls on hot-swap so their decoded
// buffers don't pile up. Howler's single AudioContext is a library global that
// survives the swap, so there's no context to orphan (the old failure mode).
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
hot?.dispose(() => {
  for (const h of sounds.values()) h.unload();
  sounds.clear();
});
