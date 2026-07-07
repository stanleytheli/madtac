/**
 * A dead-simple frame profiler: name a span with begin()/end(), tick the frame
 * counter with endFrame(), and read per-frame averages with rows(). Everything
 * short-circuits when `enabled` is false, so the begin/end calls left in hot
 * loops cost a single boolean check in normal play.
 *
 * Toggled in-game with the P key (see main.ts), which also draws a live overlay.
 * The same singleton is used by the headless profiling harness.
 */
const now = (): number => performance.now();

interface Span {
  ms: number;
  n: number;
}

class Profiler {
  enabled = false;
  private acc = new Map<string, Span>();
  private open = new Map<string, number>();
  private frames = 0;

  begin(label: string): void {
    if (this.enabled) this.open.set(label, now());
  }

  end(label: string): void {
    if (!this.enabled) return;
    const start = this.open.get(label);
    if (start === undefined) return;
    const span = this.acc.get(label) ?? { ms: 0, n: 0 };
    span.ms += now() - start;
    span.n += 1;
    this.acc.set(label, span);
  }

  /** Time `fn` under `label` and return its result. */
  measure<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const start = now();
    try {
      return fn();
    } finally {
      const span = this.acc.get(label) ?? { ms: 0, n: 0 };
      span.ms += now() - start;
      span.n += 1;
      this.acc.set(label, span);
    }
  }

  endFrame(): void {
    if (this.enabled) this.frames += 1;
  }

  get frameCount(): number {
    return this.frames;
  }

  reset(): void {
    this.acc.clear();
    this.open.clear();
    this.frames = 0;
  }

  /** Per-frame averages (ms), busiest first. */
  rows(): { label: string; msPerFrame: number; ms: number; calls: number }[] {
    const fr = Math.max(1, this.frames);
    return [...this.acc.entries()]
      .map(([label, s]) => ({ label, msPerFrame: s.ms / fr, ms: s.ms, calls: s.n }))
      .sort((a, b) => b.msPerFrame - a.msPerFrame);
  }
}

export const profiler = new Profiler();
