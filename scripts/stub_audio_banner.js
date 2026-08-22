// Headless stand-ins that let src/engine/audio.ts run under node. The context is
// a real (fake) AudioContext rather than a pre-seeded one, so getAudio() builds
// the master + voice pool exactly as it does in a browser — which is where the
// master volume gets applied. Nothing plays: the buffer cache stays empty, so
// every playSound() ends at the cache miss that kicks off load(), and load()'s
// fetch is our recorder.
globalThis.window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {} };

class FakeParam {
  constructor(v) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.value = v; this.events.push(["set", v, t]); return this; }
  setTargetAtTime(v, t, tc) { this.value = v; this.events.push(["target", v, t, tc]); return this; }
}
class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.gain = new FakeParam(1);
    this.pan = new FakeParam(0);
    this.outputs = [];
  }
  connect(n) { this.outputs.push(n); return n; }
  disconnect() { this.outputs.length = 0; }
  start() {} stop() {}
}
globalThis.__gains = []; // every gain node ever created; [0] is the master
globalThis.AudioContext = class {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.baseLatency = 0;
    this.destination = new FakeNode("destination");
    globalThis.__gains.length = 0;
  }
  createGain() { const n = new FakeNode("gain"); globalThis.__gains.push(n); return n; }
  createStereoPanner() { return new FakeNode("panner"); }
  createBufferSource() { return new FakeNode("source"); }
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
  decodeAudioData() { return Promise.reject(new Error("stub")); }
  suspend() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};
/** The master gain node of the live context (the first one built). */
globalThis.__master = () => globalThis.__gains[0];
/** Throw the context away so the next play rebuilds one from scratch. */
globalThis.__dropContext = () => { delete globalThis.__madtacAudio; };

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
