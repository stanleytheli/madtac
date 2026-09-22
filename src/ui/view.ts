/**
 * What the CLIENT smooths for the eye, per tick, from targets the sim states
 * outright: the camera zoom (the gun's, bent by the floor underfoot), the HUD
 * crosshair's spread, the sight mask's vision cone, and the floor/stair fades
 * that depend on where the viewer stands. None of it is game state — a server
 * would never compute it — which is why it left Game.update for here.
 */
import type { Game } from "../game.ts";
import { updateSurfaceAlphas } from "../world/world.ts";

const ZOOM_EASE = 0.12;
/** How fast the crosshair's displayed spread chases the gun's real spread. Eased
 *  per tick, like the camera zoom above, so it doesn't snap open on the first
 *  shot of a burst or snap shut the instant recoil resets. */
const CROSSHAIR_EASE = 1.0;
/** How fast the sight mask's vision cone (see GunSpec.visionCone) follows the
 *  aimed weapon's, per tick — a weapon switch closes or opens the cone over
 *  about a third of a second instead of snapping. Same shape as ZOOM_EASE. */
const VISION_CONE_EASE = 0.12;

export class ClientView {
  /** Camera zoom (world px per screen px), eased toward Game.zoomTarget. */
  zoom: number;
  /** Smoothed maximum aim spread of the weapon being aimed (radians), for the
   *  HUD crosshair. The raw value comes from the gun itself. */
  crosshairSpread = 0;
  /** Smoothed full width, in degrees, of the vision cone the sight mask draws
   *  (360 = all round), eased toward the aimed weapon's. */
  visionCone = 360;
  private lastTick = -1;

  /** `zoom` is where the camera starts (the held gun's, normally). With a
   *  `game`, the floor fades are snapped to the player's spot right away, so
   *  the first frame doesn't fade in from wherever the level was authored. */
  constructor(zoom: number, game?: Game) {
    this.zoom = zoom;
    if (game) this.snapSurfaces(game);
  }

  private snapSurfaces(game: Game): void {
    updateSurfaceAlphas(game.world, game.player.z, game.player.pos, true);
    this.lastTick = game.tick;
  }

  /** Once per sim tick, after Game.update. */
  update(game: Game): void {
    const p = game.player;
    this.zoom += (game.zoomTarget() - this.zoom) * ZOOM_EASE;

    // Crosshair spread, eased toward whatever the aimed gun says it would do at
    // the player's current speed. Asked of the gun rather than recomputed here.
    const spreadTarget = game.controllable ? game.aimingGun().maxSpread(p.speedRatio) : 0;
    this.crosshairSpread += (spreadTarget - this.crosshairSpread) * CROSSHAIR_EASE;
    const coneTarget = game.aimingGun().spec.visionCone ?? 360;
    this.visionCone += (coneTarget - this.visionCone) * VISION_CONE_EASE;

    // Floor/stair fades follow the viewer. A restart (the tick went backwards)
    // teleports the player to spawn, so snap rather than fade from the old spot.
    if (game.tick < this.lastTick) this.snapSurfaces(game);
    else updateSurfaceAlphas(game.world, p.z, p.pos);
    this.lastTick = game.tick;
  }
}
