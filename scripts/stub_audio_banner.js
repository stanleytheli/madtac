// Headless stand-ins that let src/engine/audio.ts run under node. Nothing ever
// plays: the buffer cache stays empty, so every playSound() ends at the cache
// miss that kicks off load() — and load()'s fetch is our recorder.
globalThis.window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {} };
globalThis.AudioContext = class {};
globalThis.__madtacAudio = {
  ctx: { state: "running", currentTime: 0, sampleRate: 48000, baseLatency: 0 },
  master: null,
  voices: [],
  allocs: 0,
  unlocked: false,
};
globalThis.__played = [];
globalThis.fetch = (url) => {
  globalThis.__played.push(String(url).replace(/^\/audio\//, ""));
  // Fail rather than hang: the rejection runs load()'s catch/finally, which
  // clears the in-flight set so the NEXT play of the same file records again.
  return Promise.reject(new Error("stub: headless, nothing to decode"));
};
// A clock that always reads "long ago" defeats load()'s failed-fetch retry
// backoff, which would otherwise mute every repeat within 5s of the first.
let clock = 0;
globalThis.performance = { now: () => (clock += 10_000) };
const realWarn = console.warn.bind(console);
console.warn = (msg, ...rest) => {
  if (typeof msg === "string" && msg.startsWith("audio: failed to load")) return; // expected
  realWarn(msg, ...rest);
};
