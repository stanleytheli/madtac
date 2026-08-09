/**
 * Sound playback — the audio sibling of the lazy image loader in
 * entities/item.ts. Files live in public/audio/ and are referenced by bare
 * filename (e.g. "gunshot.wav" -> /audio/gunshot.wav), decoded once and cached.
 *
 * Positional: a sound may carry a world position + floor (`z`); playSound pans
 * it left/right and attenuates it by distance from the listener (the player,
 * fed in each frame via setListener). Events with no position play centered at
 * full volume.
 *
 * Browsers keep an AudioContext "suspended" until a user gesture, so nothing is
 * audible until unlockAudio() runs from inside a real key/mouse handler.
 */
import type { Vec2 } from "./vec.ts";

/** 1 m = 50 world px, matching the killfeed's PX_PER_METER. */
const PX_PER_METER = 50;
/** Full volume within this distance of the listener (world px). */
const FULL_PX = 7.5 * PX_PER_METER;
/** Distance falloff: every this many px past FULL_PX, loudness halves (−6 dB).
 *  Smaller = sounds die off faster with distance. */
const HALF_LIFE_PX = 15 * PX_PER_METER;
/** Below this gain a sound is inaudible — skip it (also bounds how far a sound
 *  carries: ~5.6 half-lives past FULL_PX). */
const MIN_GAIN = 0.02;
/** Lateral offset (world px) that maps to a fully hard L/R pan. */
const PAN_PX = 18 * PX_PER_METER;
/** A sound on another floor is muffled to this fraction of its volume. */
const OFFLEVEL_GAIN = 0.3;
/** Max simultaneously-playing voices. At the cap a new sound steals the quietest
 *  active voice — but only if it's louder, so a close gunshot is never crowded out
 *  by a swarm of faint, distant ones (which read as "the audio just cut out"). */
const MAX_VOICES = 32;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** A currently-playing sound and its post-attenuation gain, for priority stealing. */
interface Voice {
  src: AudioBufferSourceNode;
  g: GainNode;
  panner: StereoPannerNode;
  gain: number;
}
const active: Voice[] = [];

/** Stop tracking and tear down a voice. Idempotent, so a steal and the source's
 *  own onended can both call it without double-freeing. */
function release(v: Voice): void {
  const i = active.indexOf(v);
  if (i < 0) return;
  active.splice(i, 1);
  v.src.disconnect();
  v.g.disconnect();
  v.panner.disconnect();
}

/** The listener (player) position + floor, updated once per frame. */
const listener = { x: 0, y: 0, z: 0 };

/** Point positional audio at the player. Call each frame from render(). */
export function setListener(pos: Vec2, z: number): void {
  listener.x = pos.x;
  listener.y = pos.y;
  listener.z = z;
}

/**
 * Create/resume the AudioContext. MUST be reached from a user gesture (key or
 * mouse handler) or the browser leaves it suspended and nothing plays. Idempotent
 * and cheap to call repeatedly — after the first unlock it's a no-op.
 */
export function unlockAudio(): void {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  for (const f of preloadQueue) load(f);
}

// Decoded buffers by filename. null = load failed (don't retry); a buffer =
// ready; absent = not yet started. `loading` guards against double-fetching.
const buffers = new Map<string, AudioBuffer | null>();
const loading = new Map<string, Promise<void>>();
const preloadQueue = new Set<string>();

function load(file: string): void {
  if (!ctx || buffers.has(file) || loading.has(file)) return;
  const p = fetch(`/audio/${file}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
    .then((data) => ctx!.decodeAudioData(data))
    .then((decoded) => void buffers.set(file, decoded))
    .catch(() => void buffers.set(file, null))
    .finally(() => void loading.delete(file));
  loading.set(file, p);
}

/** Warm the cache for sounds you know you'll need (e.g. the default gunshot), so
 *  the first play isn't silent while it decodes. Loads now if audio is unlocked,
 *  otherwise on the first unlock. */
export function preload(...files: string[]): void {
  for (const f of files) {
    preloadQueue.add(f);
    load(f);
  }
}

export interface PlayOpts {
  /** World position of the event; omit for a non-positional (centered) sound. */
  pos?: Vec2;
  /** The event's floor; when it differs from the listener's, the sound is muffled. */
  z?: number;
  /** Base volume multiplier (default 1). */
  volume?: number;
  /** ± this fraction of random pitch wobble (0.06 = ±6%) so repeats don't sound
   *  identical. */
  pitchVar?: number;
}

/**
 * Play `file` once. No-op until audio is unlocked. On the very first request for
 * a file the load is kicked off and this instance is skipped (silent), so the
 * sound is ready by the next play — preload() the ones that matter.
 */
export function playSound(file: string, opts: PlayOpts = {}): void {
  if (!ctx || ctx.state !== "running" || !master) return;

  let gain = opts.volume ?? 1;
  let pan = 0;
  if (opts.pos) {
    const dx = opts.pos.x - listener.x;
    const dy = opts.pos.y - listener.y;
    const d = Math.hypot(dx, dy);
    // Exponential (half-life) falloff: full volume within FULL_PX, then loudness
    // halves every HALF_LIFE_PX — a natural, clearly-audible sense of distance.
    if (d > FULL_PX) gain *= 2 ** (-(d - FULL_PX) / HALF_LIFE_PX);
    if (opts.z !== undefined && opts.z !== listener.z) gain *= OFFLEVEL_GAIN;
    pan = Math.max(-1, Math.min(1, dx / PAN_PX));
  }
  if (gain < MIN_GAIN) return; // inaudible — don't spend a voice on it

  const buf = buffers.get(file);
  if (buf === undefined) return void load(file); // first hit: start the load, skip this play
  if (buf === null) return; // known-missing file

  // At the voice cap, evict the quietest active sound to make room — but only if
  // this one is louder. Without this, a firefight full of faint distant shots
  // fills every slot and starves out the loud gun right next to you.
  if (active.length >= MAX_VOICES) {
    let quietest = active[0];
    for (const v of active) if (v.gain < quietest.gain) quietest = v;
    if (quietest.gain >= gain) return; // nothing quieter than us is playing — drop this one
    quietest.src.stop();
    release(quietest);
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (opts.pitchVar) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * opts.pitchVar;
  const g = ctx.createGain();
  g.gain.value = gain;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  src.connect(g).connect(panner).connect(master);

  const voice: Voice = { src, g, panner, gain };
  active.push(voice);
  src.onended = () => release(voice);
  src.start();
}

// Dev-only (Vite HMR): when this module is hot-swapped, its state resets to a
// fresh `ctx = null`, but the old AudioContext keeps living in the browser. Left
// unclosed they pile up, and browsers cap how many can exist — past the cap new
// contexts come up silent, which looks exactly like "audio randomly went quiet
// until a full reload." Closing the old one on dispose prevents that. No-op in a
// production build, where import.meta.hot is undefined.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
hot?.dispose(() => {
  for (const v of active.slice()) release(v);
  void ctx?.close();
  ctx = null;
  master = null;
});
