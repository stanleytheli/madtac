/**
 * Teams as first-class objects. Every Character carries a `team` id; AI decides
 * who to attack (and later, who to share information with) by asking the
 * registry whether two teams are hostile. Hostility is directional on purpose —
 * a berserk faction could hate everyone while nobody hates it back — though the
 * default teams are symmetric.
 *
 * Adding a team here is all it takes for it to show up in the level editor's
 * enemy inspector (the team field's options are read from this registry).
 */

export type TeamId = string;

export interface Team {
  id: TeamId;
  /** Human-readable name (editor dropdown). */
  label: string;
  /** Marker color in the level editor (and later, team UI). */
  color: string;
  /** Teams whose members this team attacks on sight. */
  hostile: readonly TeamId[];
}

export const TEAMS: Record<TeamId, Team> = {
  player: { id: "player", label: "Player", color: "#4a9de0", hostile: ["enemy"] },
  ally: { id: "ally", label: "Allies", color: "#3dba6f", hostile: ["enemy"] },
  enemy: { id: "enemy", label: "Enemy", color: "#c94f4f", hostile: ["player", "ally"] },
  // The two sides of a Team Deathmatch (see gamemodes/tdm.ts). The player joins
  // "blue"; both sides are AI-filled. Kept separate from player/ally/enemy so
  // sandbox levels are unaffected.
  blue: { id: "blue", label: "Blue", color: "#4a9de0", hostile: ["red"] },
  red: { id: "red", label: "Red", color: "#c94f4f", hostile: ["blue"] },
};

/** Does team `a` attack team `b`? Unknown teams are hostile to no one. */
export function areHostile(a: TeamId, b: TeamId): boolean {
  return TEAMS[a]?.hostile.includes(b) ?? false;
}
