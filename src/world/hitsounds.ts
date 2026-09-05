/**
 * Impact sounds. One place for the names so the world (which plays them), the
 * obstacle factories (which default them) and scripts/fit_audio.mts (which
 * converts the raw clips into public/audio) all agree.
 *
 * Map objects: every bullet makes the object's own `hitSound` (see
 * Obstacle.hitSound), else a default by kind — metal barrels clang, crates and
 * wooden barrels knock, everything else is stone (obstacleHitSound, world.ts). The player: one sound when a round
 * of theirs lands on someone, another when someone's lands on them — played
 * flat, in their ears, not at the impact point.
 */
export const OBSTACLE_HIT_SOUND = "stone_bullet_hit_01.wav";
export const METAL_HIT_SOUND = "metal_bullet_hit_01.wav";
export const WOOD_HIT_SOUND = "wood_bullet_hit_03.wav";
/** You hit someone. */
export const PLAYER_HIT_SOUND = "player_bullet_hit_01.wav";
/** Someone hit you. */
export const PLAYER_HURT_SOUND = "punch_hit_01.wav";

/** Everything above, for the audio fitting script to convert. */
export const HIT_SOUNDS = [OBSTACLE_HIT_SOUND, METAL_HIT_SOUND, WOOD_HIT_SOUND, PLAYER_HIT_SOUND, PLAYER_HURT_SOUND];
