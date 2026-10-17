import { V3 } from "../spatial/math3d";
import type { VideoScene } from "./videoScene";

/** A team's side: home plays at +Z, the opponent at -Z (the board's world). */
type Side = "home" | "opponent";

/** How far back the ball's last place, or ahead its next one, still says where the eyes go (s). */
const ballMemory = 1.0;
/** The head turns after the eyes: the direction is averaged over this time constant (s)... */
const headLag = 0.06;
/** ...sampled this often over this long (s). */
const sampleStep = 0.03, sampleSpan = 0.18;
/** No looking straight down at the feet or up at the roof (radians). */
const minElevation = (-40 * Math.PI) / 180, maxElevation = (55 * Math.PI) / 180;

/**
 * Where a player of a rebuilt rally looks, for the eye view (Section 5.1). A player follows the ball, so the eyes go to
 * the ball while the video has it; between two flights (a contact the video missed) to where it was and where it will
 * be, in time; with no ball near in time, to the play across the net: the attackers' zone for a player at the net,
 * the middle of the other court for the others; a ball that comes within a second draws the eyes ahead of it. The
 * fitted head is not used: on real footage the posture is mostly a guess (a blocker's head tipped back points the
 * view at the roof). The direction follows like a head turning (some 60 ms behind) and keeps the horizon level.
 */
export const VideoGaze = {
  /** The ball at time t, or where it was and will be within a second (by time); undefined without a ball near. */
  ballAt(scene: VideoScene, t: number): V3 | undefined {
    let before: { t: number; p: V3 } | undefined, after: { t: number; p: V3 } | undefined;
    for (const seg of scene.ball) {
      if (t >= seg.t0 && t <= seg.t1) return seg.position(t);
      if (seg.t1 < t && t - seg.t1 <= ballMemory && (!before || seg.t1 > before.t)) before = { t: seg.t1, p: seg.position(seg.t1) };
      if (seg.t0 > t && seg.t0 - t <= ballMemory && (!after || seg.t0 < after.t)) after = { t: seg.t0, p: seg.position(seg.t0) };
    }
    if (before && after) {
      const u = (t - before.t) / Math.max(1e-6, after.t - before.t);
      return before.p.add(after.p.sub(before.p).mul(u));
    }
    return before?.p ?? after?.p;
  },

  /** What the eyes are on at time t, for a player of `side` whose eyes are at `eye`. */
  target(scene: VideoScene, side: Side, eye: V3, t: number): V3 {
    const ball = VideoGaze.ballAt(scene, t);
    if (ball) return ball;
    const across = side === "home" ? -1 : 1;
    // At the net: their attackers, a little above the tape; elsewhere: the middle of their court at shoulder height.
    const atNet = Math.abs(eye.z) < 2;
    return atNet ? new V3(eye.x * 0.5, scene.netHeight + 0.4, across * 3) : new V3(eye.x * 0.3, 1.6, across * 4.5);
  },

  /** The unit direction the eye view looks along at time t: smoothed toward the target, pitch kept sensible. */
  direction(scene: VideoScene, side: Side, eye: V3, t: number): V3 {
    let sum = new V3(0, 0, 0);
    for (let k = 0; k * sampleStep <= sampleSpan; k++) {
      const at = Math.max(0, t - k * sampleStep);
      const d = VideoGaze.target(scene, side, eye, at).sub(eye);
      if (d.length < 1e-6) continue;
      sum = sum.add(d.normalized.mul(Math.exp(-(k * sampleStep) / headLag)));
    }
    if (sum.length < 1e-6) sum = new V3(0, 0, side === "home" ? -1 : 1);
    const dir = sum.normalized;
    const flat = Math.hypot(dir.x, dir.z);
    const elevation = Math.max(minElevation, Math.min(maxElevation, Math.atan2(dir.y, flat)));
    const heading = flat > 1e-6 ? new V3(dir.x / flat, 0, dir.z / flat) : new V3(0, 0, side === "home" ? -1 : 1);
    return new V3(heading.x * Math.cos(elevation), Math.sin(elevation), heading.z * Math.cos(elevation));
  },
};
