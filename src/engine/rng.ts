/**
 * Randomness that two machines can agree on.
 *
 * A shot's spread (and a shotgun's pellet scatter) is random. Online, the
 * server fires the real shot and the shooter's client predicts it the instant
 * the trigger is pulled (net/client.ts): for the predicted tracer and impacts
 * to land where the server's do, both must draw the same random numbers. So a
 * human's shot draws from a generator seeded by the match's salt (sent in the
 * welcome) and the number of the input that fired it, which both sides know.
 * Bots and single player use Math.random as before.
 *
 * (Anyone holding the salt can work out a shot's spread ahead of time. A
 * cheat that could do that could also just aim for you; the salt is per match
 * so nothing carries over.)
 */
export type Rng = () => number;

/** mulberry32: small, fast, and good enough for spread. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generator for the shot fired by input `seq` (`repeat` > 0: a held
 *  trigger firing again on a tick that brought no new input). */
export function shotRng(salt: number, seq: number, repeat = 0): Rng {
  return mulberry32(salt ^ Math.imul(seq | 0, 0x9e3779b1) ^ Math.imul((repeat | 0) + 1, 0x85ebca6b));
}
