/**
 * Sound playback on native Web Audio — a small one-shot SFX engine modeled
 * directly on survev.io's (client/src/lib/createJS.ts in their repo):
 *
 *  - A fixed pool of persistent voice chains (gain → stereo-pan → master),
 *    created once per context and reused. A play creates exactly ONE fresh
 *    node (the buffer source) and plugs it into an existing chain — per-shot
 *    graph mutation and GC are minimal, which matters on WebKit where node
 *    churn contends with the audio render thread.
 *  - Periodic chain renewal: AudioParam event timelines accumulate ("WebAudio
 *    nodes fill with garbage over time" — survev's words), so a chain that has
 *    absorbed many param events gets fresh nodes on its next allocation.
 *  - Coalescing: a same-file play landing within a few ms of one already
 *    playing merges into it — energy-summed volume (sqrt(v1²+v2²), so five
 *    rifles are genuinely louder than one) and volume-weighted pan — instead
 *    of spending a voice or being dropped.
 *  - Voice stealing fades (20ms) rather than hard-stops: no clicks, no burst
 *    of hard graph ops.
 *  - Voices are reclaimed by polling stopTime against the context clock every
 *    frame (updateAudio), not via onended events.
 *  - The context is nudged back to "running" every frame, not just on input.
 *
 * Files live in public/audio/ and are referenced by bare filename
 * (e.g. "gunshot.wav" -> /audio/gunshot.wav). Call sites are unchanged:
 *   playSound(file, { pos, z, volume, pitchVar })
 * The frame loop must call updateAudio() once per frame.
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
/** Hard audibility cutoff. The falloff alone doesn't cull below MIN_GAIN until
 *  ~92m — the whole map — so with 70+ NPCs nearly every shot anywhere spawned
 *  a voice. Distant fights should go quiet, not degrade the game. */
const MAX_DIST_PX = 40 * PX_PER_METER;
/** Lateral offset (world px) that maps to a fully hard L/R pan. */
const PAN_PX = 18 * PX_PER_METER;
/** A sound on another floor is muffled to this fraction of its volume. */
const OFFLEVEL_GAIN = 0.3;
/** Ceiling on voices PLAYING at once; above it the quietest is faded out, and
 *  only if the newcomer is louder — close sounds always win. */
const MAX_VOICES = 32;
/** Pool size — larger than MAX_VOICES so voices mid-fade still have a slot
 *  while the newcomer takes a fresh one. */
const POOL_VOICES = 48;
/** Same-file plays landing within this window merge into the playing voice. */
const COALESCE_S = 0.04;
/** Time constant for gain glides (setTargetAtTime) — coalesce bumps + steals. */
const GLIDE_TC = 0.02;
/** A stolen (faded) voice is reclaimed this long after its fade begins. */
const STOP_FADE_S = 0.1;
/** Chain renewal thresholds, per survev: past the hard cap the chain's nodes
 *  are rebuilt on next allocation; past the soft cap, rebuilt 1 time in 7. */
const PARAM_EVENTS_HARD = 150;
const PARAM_EVENTS_SOFT = 20;

/** False when there's no Web Audio at all (headless Node — the verify/bench
 *  scripts run game.update() there); every entry point no-ops so a bot firing
 *  in a script doesn't try to construct an AudioContext. */
const HAS_AUDIO = typeof AudioContext !== "undefined";

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

/** True while resetAudioContext() has torn the context down and is waiting out
 *  the idle window before building a fresh one; playback no-ops meanwhile. */
let resetting = false;

// Safari ratchets PERMANENT output latency onto a tab whose AudioContext is
// left "running" through a page suspension (it survives reloads; only closing
// the tab clears it). Suspending the context ourselves whenever the page hides
// costs nothing — RAF is frozen while hidden, so no tick fires sounds anyway.
let hideSuspend = true; // console: setHideSuspend(false) to A/B the trigger
if (HAS_AUDIO && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!hideSuspend || resetting) return;
    const { ctx } = getAudio();
    if (document.hidden) {
      if (ctx.state === "running") void ctx.suspend();
    } else if (ctx.state !== "running") void ctx.resume();
  });
}

// ---------------------------------------------------------------------------
// Context + voice pool. Exactly one context per page: browsers cap live
// AudioContexts (~6) and the autoplay unlock is earned per context via a user
// gesture, so it's stashed on globalThis to survive a Vite HMR swap of this
// module. The pool lives beside it — chains are context-bound, so a context
// reset rebuilds both together.
// ---------------------------------------------------------------------------

/** One persistent voice chain (gain → pan → master) plus the state of whatever
 *  is currently playing through it. `source === null` means the slot is free. */
interface Voice {
  gainNode: GainNode;
  panNode: StereoPannerNode;
  source: AudioBufferSourceNode | null;
  file: string | null;
  /** Effective (post-attenuation, post-coalesce) gain — the steal priority. */
  gain: number;
  pan: number;
  /** ctx.currentTime when the current sound started, for the coalesce window. */
  startedAt: number;
  /** ctx clock time past which the slot is reclaimed by updateAudio(). */
  stopTime: number;
  /** True once the voice was stolen and is fading — no longer coalescable. */
  stopping: boolean;
  /** AudioParam events absorbed by this chain since its nodes were created. */
  paramEvents: number;
}

interface SharedAudio {
  ctx: AudioContext;
  master: GainNode;
  voices: Voice[];
  /** Allocation counter, for the periodic 1-in-7 chain renewal roll. */
  allocs: number;
  /** True once the context has ever reached "running" (autoplay unlocked). */
  unlocked: boolean;
}

const G_KEY = "__madtacAudio";

function makeChain(ctx: AudioContext, master: GainNode): { gainNode: GainNode; panNode: StereoPannerNode } {
  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  gainNode.connect(panNode);
  panNode.connect(master);
  return { gainNode, panNode };
}

function getAudio(): SharedAudio {
  const g = globalThis as Record<string, unknown>;
  let a = g[G_KEY] as SharedAudio | undefined;
  if (!a) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const voices: Voice[] = [];
    for (let i = 0; i < POOL_VOICES; i++) {
      voices.push({
        ...makeChain(ctx, master),
        source: null,
        file: null,
        gain: 0,
        pan: 0,
        startedAt: 0,
        stopTime: 0,
        stopping: false,
        paramEvents: 0,
      });
    }
    const shared: SharedAudio = { ctx, master, voices, allocs: 0, unlocked: false };
    ctx.onstatechange = () => {
      if (ctx.state === "running" && !shared.unlocked) {
        shared.unlocked = true;
        const outLat = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
        console.log(
          `[audio] context running: sampleRate ${ctx.sampleRate}, ` +
            `baseLatency ${(ctx.baseLatency * 1000).toFixed(1)}ms` +
            (outLat !== undefined ? `, outputLatency ${(outLat * 1000).toFixed(1)}ms` : ""),
        );
      }
    };
    g[G_KEY] = shared;
    a = shared;
  }
  return a;
}

/** Nudge the context back to running. Kept on our key/mouse handlers because
 *  the FIRST resume must come from a user gesture (autoplay policy); after
 *  that, updateAudio() re-resumes every frame the way survev does. */
export function unlockAudio(): void {
  if (!HAS_AUDIO || resetting) return;
  const { ctx } = getAudio();
  if (ctx.state !== "running") void ctx.resume();
}

/** Output-pipeline latency estimate (ms) via getOutputTimestamp. NOTE: Safari
 *  reports ~0 here even while objectively delayed (measured via audioEcho) —
 *  useful on Chrome/Firefox, blind on Safari. */
export function audioLatencyMs(): number | undefined {
  if (!HAS_AUDIO || resetting) return undefined;
  const { ctx } = getAudio();
  if (ctx.state !== "running") return undefined;
  const ts = ctx.getOutputTimestamp?.();
  if (!ts || ts.contextTime === undefined) return undefined;
  return (ctx.currentTime - ts.contextTime) * 1000;
}

// ---------------------------------------------------------------------------
// Decoded-buffer cache. AudioBuffers are context-independent, so they survive
// a context reset. A file is fetched + decoded at most once; failures retry
// after a cooldown instead of being blacklisted forever (a fetch can race a
// dev-server restart and decode the HTML fallback).
// ---------------------------------------------------------------------------

const buffers = new Map<string, AudioBuffer>();
const loading = new Set<string>();
const failed = new Map<string, number>();
const FAIL_RETRY_MS = 5000;

function load(file: string): void {
  if (!HAS_AUDIO) return;
  if (buffers.has(file) || loading.has(file)) return;
  const failedAt = failed.get(file);
  if (failedAt !== undefined && performance.now() - failedAt < FAIL_RETRY_MS) return;
  failed.delete(file);
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
      failed.set(file, performance.now());
      console.warn(`audio: failed to load /audio/${file} (retry in ${FAIL_RETRY_MS / 1000}s)`, err);
    })
    .finally(() => loading.delete(file));
}

/** Warm sounds ahead of first use so there's no fetch/decode gap on first play. */
export function preload(...files: string[]): void {
  for (const f of files) load(f);
}

// ---------------------------------------------------------------------------
// Voice lifecycle.
// ---------------------------------------------------------------------------

function setVoiceGain(a: SharedAudio, v: Voice, gain: number, glide: boolean): void {
  if (glide) v.gainNode.gain.setTargetAtTime(gain, a.ctx.currentTime, GLIDE_TC);
  else v.gainNode.gain.setValueAtTime(gain, a.ctx.currentTime);
  v.paramEvents += 1;
}

function setVoicePan(a: SharedAudio, v: Voice, pan: number): void {
  v.panNode.pan.setValueAtTime(pan, a.ctx.currentTime);
  v.paramEvents += 1;
}

/** Free the slot. Safe to call on an already-ended source (stop() then throws
 *  InvalidStateError, which is swallowed — the disconnect is what matters). */
function reclaim(v: Voice): void {
  if (!v.source) return;
  try {
    v.source.stop();
  } catch {
    // already ended/stopped — fine
  }
  v.source.disconnect();
  v.source = null;
  v.file = null;
  v.gain = 0;
  v.stopping = false;
}

/** Steal: fade to silence (no click, no hard graph op) and let updateAudio
 *  reclaim the slot shortly. The newcomer takes a different free slot. */
function fadeStop(a: SharedAudio, v: Voice): void {
  setVoiceGain(a, v, 0, true);
  v.stopTime = a.ctx.currentTime + STOP_FADE_S;
  v.stopping = true;
}

/** Per-frame housekeeping — call once per frame from the game loop.
 *  Survev-style: re-resume a suspended context, and reclaim voices whose
 *  stopTime has passed (polling the context clock; no onended reliance). */
export function updateAudio(): void {
  if (!HAS_AUDIO || resetting) return;
  const a = getAudio();
  // Every frame, not just on input. Suspensions from any source (Safari's
  // aggressive tab management, audio-focus loss) heal within a frame. The
  // deliberate hidden-page suspend isn't fought: RAF doesn't run while hidden.
  if (a.ctx.state === "suspended" && a.unlocked) void a.ctx.resume();
  const now = a.ctx.currentTime;
  for (const v of a.voices) {
    if (v.source && now > v.stopTime) reclaim(v);
  }
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
  if (!HAS_AUDIO) return; // headless script
  if (resetting) return; // context teardown window during resetAudioContext()
  if (!emitting) return; // catch-up tick — advance the sim silently, don't stack sounds

  let gain = opts.volume ?? 1;
  let pan = 0;
  if (opts.pos) {
    const dx = opts.pos.x - listener.x;
    const dy = opts.pos.y - listener.y;
    const d = Math.hypot(dx, dy);
    if (d > MAX_DIST_PX) return; // out of earshot — don't spend a voice on it
    // Exponential (half-life) falloff: full within FULL_PX, halving every HALF_LIFE_PX.
    if (d > FULL_PX) gain *= 2 ** (-(d - FULL_PX) / HALF_LIFE_PX);
    if (opts.z !== undefined && opts.z !== listener.z) gain *= OFFLEVEL_GAIN;
    if (gain < MIN_GAIN) return; // inaudible
    pan = Math.max(-1, Math.min(1, dx / PAN_PX));
  }

  const buf = buffers.get(file);
  if (!buf) {
    load(file); // kick off the fetch, but never queue: a late one-shot is worse than a missing one
    return;
  }

  const a = getAudio();
  // Before the first unlock, start anyway: the unlock gesture is resolving this
  // same frame and the browser holds the source until the context runs. After
  // that, a non-running context means suspension/interruption — drop the sound
  // rather than queue a stale burst for whenever it resumes.
  if (a.ctx.state !== "running" && a.unlocked) return;
  const now = a.ctx.currentTime;

  // Coalesce: merge into a just-started voice of the same file instead of
  // spending a new one. Energy-sum the volume, volume-weight the pan (survev's
  // exact scheme) — overlapping shots get LOUDER rather than dropped.
  for (const v of a.voices) {
    if (v.source && !v.stopping && v.file === file && now - v.startedAt < COALESCE_S) {
      const mergedPan = (v.gain * v.pan + gain * pan) / Math.max(0.001, v.gain + gain);
      const mergedGain = Math.min(1, Math.hypot(v.gain, gain));
      v.gain = mergedGain;
      v.pan = mergedPan;
      setVoiceGain(a, v, mergedGain, true);
      setVoicePan(a, v, mergedPan);
      return;
    }
  }

  // Playing-voice cap: at the ceiling, fade out the quietest — but only if
  // this one is louder, so a close shot is never crowded out by distant ones.
  let playing = 0;
  let quietest: Voice | null = null;
  let free: Voice | null = null;
  for (const v of a.voices) {
    if (!v.source) {
      free ??= v;
    } else if (!v.stopping) {
      playing += 1;
      if (!quietest || v.gain < quietest.gain) quietest = v;
    }
  }
  if (playing >= MAX_VOICES) {
    if (!quietest || quietest.gain >= gain) return; // nothing quieter is playing — drop this
    fadeStop(a, quietest);
  }
  if (!free) return; // whole pool busy (incl. fades) — drop rather than hard-steal

  // Periodic chain renewal (survev: "WebAudio nodes fill with garbage over
  // time") — chains that have absorbed many AudioParam events get fresh nodes.
  a.allocs += 1;
  const renew =
    free.paramEvents > PARAM_EVENTS_HARD ||
    (free.paramEvents > PARAM_EVENTS_SOFT && a.allocs % 7 === 0);
  if (renew) {
    free.gainNode.disconnect();
    free.panNode.disconnect();
    const chain = makeChain(a.ctx, a.master);
    free.gainNode = chain.gainNode;
    free.panNode = chain.panNode;
    free.paramEvents = 0;
  }

  // One fresh node per play: the source. Everything else is the reused chain.
  const source = a.ctx.createBufferSource();
  source.buffer = buf;
  let rate = 1;
  if (opts.pitchVar) {
    rate = 1 + (Math.random() * 2 - 1) * opts.pitchVar;
    source.playbackRate.value = rate;
  }
  source.connect(free.gainNode);
  free.source = source;
  free.file = file;
  free.gain = gain;
  free.pan = pan;
  free.startedAt = now;
  free.stopping = false;
  setVoiceGain(a, free, gain, false);
  setVoicePan(a, free, pan);
  source.start();
  free.stopTime = now + buf.duration / rate;
}

// ---------------------------------------------------------------------------
// Console diagnostics — attached in production builds too, because the sticky
// latency bug shows up on the deployed site. audioEcho() is the objective
// output-latency measure (mic round trip); audioBeep()/audioPing() exercise
// the pipeline without game SFX; resetAudioContext() rebuilds the context and
// voice pool (decoded buffers carry over).
// ---------------------------------------------------------------------------

function stopAllVoices(): void {
  const g = globalThis as Record<string, unknown>;
  const a = g[G_KEY] as SharedAudio | undefined;
  if (!a) return;
  for (const v of a.voices) reclaim(v);
}

function audioDebug(): void {
  const a = getAudio();
  const ts = a.ctx.getOutputTimestamp?.();
  let busy = 0;
  let events = 0;
  for (const v of a.voices) {
    if (v.source) busy += 1;
    events += v.paramEvents;
  }
  console.log({
    state: a.ctx.state,
    currentTime: a.ctx.currentTime,
    outputContextTime: ts?.contextTime,
    gapMs: ts?.contextTime !== undefined ? (a.ctx.currentTime - ts.contextTime) * 1000 : undefined,
    baseLatencyMs: a.ctx.baseLatency * 1000,
    busyVoices: busy,
    pooledParamEvents: events,
    buffersCached: buffers.size,
  });
}

function audioBeep(): void {
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
}

/** Measure control→render scheduling lag: play an inaudible 50ms buffer and
 *  time start()→onended against its duration. High overshoot = sounds are
 *  being STARTED late (our side / main thread). Low overshoot while game audio
 *  is audibly delayed = the delay is downstream, in the OS output pipeline. */
function audioPing(): void {
  const { ctx, master } = getAudio();
  if (ctx.state !== "running") {
    console.log(`[audio] ping: context is "${ctx.state}", not running`);
    return;
  }
  const dur = 0.05;
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * dur), ctx.sampleRate); // silence
  src.connect(master);
  const t0 = performance.now();
  src.onended = () => {
    src.disconnect();
    const overshoot = performance.now() - t0 - dur * 1000;
    console.log(`[audio] ping: start→ended overshoot ${overshoot.toFixed(1)}ms`);
  };
  src.start();
}

/** Play a file through an HTML5 <audio> element — a completely separate
 *  browser pipeline from Web Audio, for comparison while delayed. Safari only
 *  allows media-element play() inside a user gesture, so the first call arms a
 *  one-time click handler; after that it replays directly. */
let tagEl: HTMLAudioElement | undefined;
function audioTag(file = "gunshot.wav"): void {
  const src = `/audio/${file}`;
  if (!tagEl) tagEl = new Audio(src);
  if (!tagEl.src.endsWith(src)) tagEl.src = src;
  tagEl.currentTime = 0;
  tagEl.play().catch(() => {
    console.log("[audio] tag: Safari needs a gesture the first time — click the page to play it");
    window.addEventListener("mousedown", () => void tagEl!.play().catch(() => {}), { once: true });
  });
}

/** Objective output-latency measurement via microphone round trip: schedule a
 *  sharp click at a known audio-clock time, record the mic, and report how many
 *  ms after the scheduled time the click actually arrived. The number includes
 *  mic input latency (~10–20ms) — it's the CHANGE between a healthy tab and a
 *  poisoned tab that matters, not the absolute value.
 *  Needs: mic permission, volume up, built-in mic near built-in speakers. */
async function audioEcho(rounds = 3): Promise<void> {
  const { ctx, master } = getAudio();
  if (ctx.state !== "running") {
    console.log(`[audio] echo: context is "${ctx.state}" — click the page first`);
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const mic = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(1024, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // ScriptProcessor only runs when routed to the destination
  mic.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);

  // 5ms decaying noise burst — sharp enough to peak-detect against room noise.
  const click = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.005), ctx.sampleRate);
  const ch = click.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);

  let peakV = 0;
  let peakT = 0;
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    const t0 = e.playbackTime ?? ctx.currentTime;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peakV) {
        peakV = v;
        peakT = t0 + i / ctx.sampleRate;
      }
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let r = 1; r <= rounds; r++) {
      peakV = 0;
      const src = ctx.createBufferSource();
      src.buffer = click;
      src.connect(master);
      const at = ctx.currentTime + 0.2;
      src.start(at);
      await sleep(2000); // window sized so even a ~1.5s-delayed click lands in its own round
      src.disconnect();
      console.log(
        peakV > 0.01
          ? `[audio] echo ${r}/${rounds}: click arrived ${((peakT - at) * 1000).toFixed(0)}ms after its scheduled time (peak ${peakV.toFixed(2)})`
          : `[audio] echo ${r}/${rounds}: no click detected (peak ${peakV.toFixed(3)}) — volume up? mic blocked?`,
      );
    }
  } finally {
    proc.onaudioprocess = null;
    mic.disconnect();
    proc.disconnect();
    sink.disconnect();
    for (const t of stream.getTracks()) t.stop();
  }
}

/** Escape hatch experiment for the sticky-delay state: tear down, go silent
 *  for `idleMs` so the OS audio unit can fully release, then build fresh
 *  (context AND voice pool; decoded buffers carry over). The new context may
 *  need the next click/keypress to unlock. NOTE: measured NOT to clear
 *  Safari's ratcheted latency — only closing the tab does — kept for testing. */
function resetAudioContext(idleMs = 2500): void {
  stopAllVoices();
  const g = globalThis as Record<string, unknown>;
  const a = g[G_KEY] as SharedAudio | undefined;
  delete g[G_KEY];
  resetting = true;
  const rebuild = (): void => {
    resetting = false;
    getAudio();
    console.log("[audio] fresh context created — click/keypress to unlock if silent");
  };
  if (a) {
    console.log(`[audio] context closed; recreating after ${idleMs}ms of silence`);
    a.ctx.close().then(
      () => setTimeout(rebuild, idleMs),
      () => setTimeout(rebuild, idleMs),
    );
  } else rebuild();
}

if (HAS_AUDIO)
  Object.assign(globalThis, {
    audioDebug,
    audioBeep,
    audioPing,
    audioTag,
    audioEcho,
    resetAudioContext,
    setHideSuspend(on: boolean): void {
      hideSuspend = on;
    },
  });

// Vite HMR (dev only): silence voices started by this module instance so
// nothing keeps playing with no owner. The context + pool are page-globals and
// survive the swap.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
hot?.dispose(stopAllVoices);
