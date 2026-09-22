/**
 * Entity identity. Assigned once at construction; a client MIRROR of a server
 * object overwrites it with the server's, so the two sides agree on names. Every live game object — a character, a gun, a ground item,
 * a vehicle, a bullet, a projectile — takes a number here when it is built, so
 * anything that has to NAME one across a boundary (a network snapshot, an event
 * that says who hit whom, a save) has something better than an object reference
 * to say it with. In-process code still holds references; the id is the name a
 * reference gets when it has to leave the process.
 *
 * One counter, never reused within a session. In a client/server build the
 * server is the only allocator and the client learns ids from snapshots.
 */
let next = 1;

/** The next fresh entity id. */
export function nextEntityId(): number {
  return next++;
}

/** Restart the counter (headless tests that want stable ids across runs). */
export function resetEntityIds(): void {
  next = 1;
}
