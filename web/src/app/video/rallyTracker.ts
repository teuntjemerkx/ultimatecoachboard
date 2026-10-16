import { CourtFrame } from "../../core/match/court";
import {
  PlayerTracker, TrackedPlayer, type PlayerTrackerSettings, type VideoCamera, type VideoFrameObservation,
} from "../../core/video";

/**
 * The core's tracker with one rule the real footage needs: a person who never sets foot on the court during the clip
 * (a coach, a line judge, an official by the post) is not one of the twelve, even when they stand within the
 * tracker's court margin. Tracks are made without the six-per-side limit; a track seen inside the lines in fewer than
 * `minOnCourt` frames (and a tenth of its frames) is dropped; then the six most persistent per side are kept as the
 * core does.
 */
export class RallyTracker extends PlayerTracker {
  constructor(settings: Partial<PlayerTrackerSettings> = {}, readonly minOnCourt = 3) {
    super(settings);
  }

  /**
   * The tracker for a camera. A jumping player's feet put their floor point farther along the camera's ray; the core
   * lets a track take such points up to a foot height of 1.2 m. From far behind an end line and not very high (a
   * broadcast camera, a phone in the stands) that height moves the point metres along the court, and tracks start to
   * take players across the net; there the allowance is cut to about 2 m along the court (at least 0.4 m of height).
   */
  static forCamera(camera: VideoCamera): RallyTracker {
    const alongPerMetre = Math.abs(camera.center.z) / Math.max(camera.center.y, 0.1);
    return new RallyTracker({ maxFootHeight: Math.min(1.2, Math.max(0.4, 2 / Math.max(alongPerMetre, 1e-3))) });
  }

  override track(input: readonly VideoFrameObservation[], camera?: VideoCamera): TrackedPlayer[] {
    const limit = this.settings.maxPlayersPerSide;
    const all = new PlayerTracker({ ...this.settings, maxPlayersPerSide: 1000 }).track(input, camera);
    const seen = (t: TrackedPlayer) => TrackedPlayer.observedCount(t);
    const inside = (t: TrackedPlayer) => t.samples.filter((s) => s.measured
      && Math.abs(s.measured.x) <= CourtFrame.halfWidth && Math.abs(s.measured.z) <= 9).length;
    const players = all.filter((t) => inside(t) >= Math.max(this.minOnCourt, 0.1 * seen(t)));
    const firstSeen = (t: TrackedPlayer) => t.samples.find((s) => !s.occluded)?.time ?? Infinity;
    const kept: TrackedPlayer[] = [];
    for (const side of ["home", "opponent"] as const) {
      const mine = players.filter((t) => t.side === side)
        .sort((a, b) => (seen(a) !== seen(b) ? seen(b) - seen(a) : firstSeen(a) - firstSeen(b)));
      kept.push(...mine.slice(0, limit));
    }
    return kept;
  }
}
