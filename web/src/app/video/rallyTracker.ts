import { CourtFrame } from "../../core/match/court";
import {
  PlayerTracker, TrackedPlayer, type PlayerTrackerSettings, type TrackLock, type VideoCamera, type VideoFrameObservation,
} from "../../core/video";

/**
 * The core's tracker with what real footage needs. When the coach tapped players (`locks`), exactly those are followed,
 * through the whole clip (`PlayerTracker.follow`), and no one else: whoever was not tapped (the coach by the sideline,
 * a line judge) is not in the rally. Without taps the players are found automatically: a person who is seldom on the
 * court during the clip (a coach walking the sideline, an official by the post) is not one of the twelve, even when
 * they stand within the tracker's court margin. Tracks are made without the six-per-side limit; a track seen inside
 * the lines in fewer than `minOnCourt` frames, or in under `onCourtShare` of the frames it was seen in, is dropped
 * (a player is inside nearly all the time, a server behind the end line only for a few seconds); then the six most
 * persistent per side are kept, as the core does.
 */
export class RallyTracker extends PlayerTracker {
  constructor(settings: Partial<PlayerTrackerSettings> = {}, readonly minOnCourt = 3, readonly locks: readonly TrackLock[] = [],
    readonly onCourtShare = 0.3) {
    super(settings);
  }

  /**
   * The tracker for a camera. A jumping player's feet put their floor point farther along the camera's ray; the core
   * lets a track take such points up to a foot height of 1.2 m. From far behind an end line and not very high (a
   * broadcast camera, a phone in the stands) that height moves the point metres along the court, and tracks start to
   * take players across the net; there the allowance is cut to about 2 m along the court (at least 0.4 m of height).
   */
  static forCamera(camera: VideoCamera, locks: readonly TrackLock[] = []): RallyTracker {
    const alongPerMetre = Math.abs(camera.center.z) / Math.max(camera.center.y, 0.1);
    return new RallyTracker({ maxFootHeight: Math.min(1.2, Math.max(0.4, 2 / Math.max(alongPerMetre, 1e-3))) }, 3, locks);
  }

  override track(input: readonly VideoFrameObservation[], camera?: VideoCamera): TrackedPlayer[] {
    if (camera && this.locks.length > 0) return this.follow(input, this.locks, camera).tracks;
    const limit = this.settings.maxPlayersPerSide;
    const all = new PlayerTracker({ ...this.settings, maxPlayersPerSide: 1000 }).track(input, camera);
    const seen = (t: TrackedPlayer) => TrackedPlayer.observedCount(t);
    const inside = (t: TrackedPlayer) => t.samples.filter((s) => s.measured
      && Math.abs(s.measured.x) <= CourtFrame.halfWidth && Math.abs(s.measured.z) <= 9).length;
    const players = all.filter((t) => inside(t) >= Math.max(this.minOnCourt, this.onCourtShare * seen(t)));
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
