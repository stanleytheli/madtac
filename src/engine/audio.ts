/**
 * Sound playback on native Web Audio — a small one-shot SFX engine, the same
 * shape survev.io uses: one persistent AudioContext, decoded AudioBuffers
 * cached in memory, and a fresh source → gain → stereo-pan node chain per play,
 * fully configured BEFORE start() and torn down when the sound ends.
 *
 * Why not a library: Howler 2.2.4's per-instance stereo() pauses and restarts
 * an already-playing source to splice in its panner node (setupPanner →
 * `pause(id, true).play(id, true)`), so our play-then-pan hot path rebuilt the
 * graph on every positional shot — bad for latency, especially on Safari.
 * Here nothing touches a source's graph after it starts.
 *
 * Files live in public/audio/ and are referenced by bare filename
 * (e.g. "gunshot.wav" -> /audio/gunshot.wav). Call sites are unchanged:
 *   playSound(file, { pos, z, volume, pitchVar })
 */
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
/** Global ceiling on concurrent voices across all sounds. A firefight can
 *  otherwise stack enough overlapping sounds to overload the audio thread, at
 *  which point the browser grows its output buffer and the added latency
 *  sticks. At the cap the quietest playing voice is stolen, but only if the
 *  newcomer is louder, so close sounds always win. */
const MAX_VOICES = 32;

/** The listener (player) position + floor, updated once per frame. */
const listener = { x: 0, y: 0, z: 0 };

/** Point positional audio at the player. Call each frame from render(). */
export function setListener(pos: Vec2, z: number): void {
  listener.x = pos.x;
  listener.y = pos.y;
  listener.z = z;
}

/** False during a fixed-step catch-up: after a lag spike the loop replays up to
 *  ~15 sim ticks in one frame, and without this each would (re)fire its sounds,
 *  dumping a burst that overloads the audio thread. The loop keeps this false on
 *  every catch-up tick and true only on the final, live one — so the sim advances
 *  silently and only the current moment is heard. */
let emitting = true;
export function setAudioLive(on: boolean): void {
  emitting = on;
}

// ---------------------------------------------------------------------------
// Context. Exactly one per page: browsers cap live AudioContexts (~6) and the
// autoplay unlock is earned per context via a user gesture, so it's stashed on
// globalThis to survive a Vite HMR swap of this module. All context/master
// creation goes through getAudio() so a hard reset stays possible.
// ---------------------------------------------------------------------------

interface SharedAudio {
  ctx: AudioContext;
  master: GainNode;
  /** True once the context has ever reached "running" (autoplay unlocked). */
  unlocked: boolean;
}

const G_KEY = "__madtacAudio";

function getAudio(): SharedAudio {
  const g = globalThis as Record<string, unknown>;
  let a = g[G_KEY] as SharedAudio | undefined;
  if (!a) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const shared: SharedAudio = { ctx, master, unlocked: false };
    ctx.onstatechange = () => {
      if (ctx.state === "running") shared.unlocked = true;
    };
    g[G_KEY] = shared;
    a = shared;
  }
  return a;
}

/** Nudge the context back to running. Called from our key/mouse handlers: the
 *  first gesture satisfies the autoplay policy, and later calls recover from
 *  Safari suspending or interrupting the context (tab blur, lost audio focus). */
export function unlockAudio(): void {
  const { ctx } = getAudio();
  if (ctx.state !== "running") void ctx.resume();
}

// ---------------------------------------------------------------------------
// Decoded-buffer cache. AudioBuffers are context-independent, so they survive
// a context reset. A file is fetched + decoded at most once; failures are
// remembered so a bad filename doesn't refetch every shot.
// ---------------------------------------------------------------------------

const buffers = new Map<string, AudioBuffer>();
const loading = new Set<string>();
const failed = new Set<string>();

function load(file: string): void {
  if (buffers.has(file) || loading.has(file) || failed.has(file)) return;
  loading.add(file);
  const { ctx } = getAudio();
  fetch(`/audio/${file}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then((buf) => {
      buffers.set(file, buf);
    })
    .catch((err: unknown) => {
      failed.add(file);
      console.warn(`audio: failed to load /audio/${file}`, err);
    })
    .finally(() => loading.delete(file));
}

/** Warm sounds ahead of first use so there's no fetch/decode gap on first play. */
export function preload(...files: string[]): void {
  for (const f of files) load(f);
}

// ---------------------------------------------------------------------------
// Voices.
// ---------------------------------------------------------------------------

/** A currently-playing source chain + its post-attenuation gain, for the cap's
 *  priority stealing. */
interface Voice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  gain: number;
  ended: boolean;
}
const active: Voice[] = [];

/** Idempotent: runs from `onended` after natural end AND after a manual stop()
 *  (which also fires onended), whichever comes first. */
function cleanupVoice(v: Voice): void {
  if (v.ended) return;
  v.ended = true;
  const i = active.indexOf(v);
  if (i >= 0) active.splice(i, 1);
  v.source.disconnect();
  v.gainNode.disconnect();
  v.panNode.disconnect();
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
  if (!emitting) return; // catch-up tick — advance the sim silently, don't stack sounds

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

  const buf = buffers.get(file);
  if (!buf) {
    load(file); // kick off the fetch, but never queue: a late one-shot is worse than a missing one
    return;
  }

  const { ctx, master, unlocked } = getAudio();
  // Before the first unlock, start anyway: the unlock gesture is resolving this
  // same frame and the browser holds the source until the context runs. After
  // that, a non-running context means suspension/interruption — drop the sound
  // rather than queue a stale burst for whenever it resumes.
  if (ctx.state !== "running" && unlocked) return;

  // Global cap: at the ceiling, steal the quietest playing voice — but only if
  // this one is louder, so a close shot is never crowded out by distant ones.
  if (active.length >= MAX_VOICES) {
    let qi = 0;
    for (let i = 1; i < active.length; i++) if (active[i].gain < active[qi].gain) qi = i;
    if (active[qi].gain >= gain) return; // nothing quieter than us is playing — drop this
    const stolen = active[qi];
    stolen.source.stop();
    cleanupVoice(stolen); // free the slot now; the async onended is a no-op
  }

  // Fresh chain per play: source -> gain -> pan -> master. Everything is
  // configured before start(); the graph is never touched again until cleanup.
  const source = ctx.createBufferSource();
  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  source.buffer = buf;
  if (opts.pitchVar) source.playbackRate.value = 1 + (Math.random() * 2 - 1) * opts.pitchVar;
  gainNode.gain.value = gain;
  panNode.pan.value = pan;
  source.connect(gainNode);
  gainNode.connect(panNode);
  panNode.connect(master);

  const voice: Voice = { source, gainNode, panNode, gain, ended: false };
  active.push(voice);
  source.onended = () => cleanupVoice(voice);
  source.start();
}

// ---------------------------------------------------------------------------
// Dev-only diagnostics, reachable from the browser console. audioDebug() tells
// apart "our engine is slow" from "the context's output pipeline degraded"
// (gapMs growing = the browser stretched its output buffer); audioBeep() plays
// a raw oscillator through the same context to test the pipeline without any
// game SFX involved; resetAudioContext() hard-replaces a poisoned context.
// ---------------------------------------------------------------------------

const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;

function stopAllVoices(): void {
  for (const v of [...active]) {
    try {
      v.source.stop();
    } catch {
      // already stopped — fine
    }
    cleanupVoice(v);
  }
}

if (hot) {
  const audioDebug = (): void => {
    const { ctx } = getAudio();
    const ts = ctx.getOutputTimestamp?.();
    console.log({
      state: ctx.state,
      currentTime: ctx.currentTime,
      outputContextTime: ts?.contextTime,
      gapMs: ts?.contextTime !== undefined ? (ctx.currentTime - ts.contextTime) * 1000 : undefined,
      baseLatencyMs: ctx.baseLatency * 1000,
      activeVoices: active.length,
      buffersCached: buffers.size,
    });
  };
  const audioBeep = (): void => {
    const { ctx, master } = getAudio();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 440;
    g.gain.value = 0.15;
    osc.connect(g);
    g.connect(master);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  };
  const resetAudioContext = (): void => {
    stopAllVoices();
    const g = globalThis as Record<string, unknown>;
    const a = g[G_KEY] as SharedAudio | undefined;
    if (a) void a.ctx.close();
    delete g[G_KEY];
    getAudio(); // decoded buffers are context-independent, so the cache carries over
  };
  Object.assign(globalThis, { audioDebug, audioBeep, resetAudioContext });

  // Vite HMR: silence voices started by this module instance so nothing keeps
  // playing with no owner. The context itself is a page-global and survives.
  hot.dispose(stopAllVoices);
}
