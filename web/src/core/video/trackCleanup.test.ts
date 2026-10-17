import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { VideoCamera } from "./courtCalibration";
import { TrackCleanup, defaultTrackCleanup } from "./trackCleanup";
import { VideoPlayerSample } from "./videoScene";

// A club camera: 2.2 m up, 14 m behind the net, behind our end line (as on the Orion clip).
const camera = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 0, 0), 1100, 1280, 720);

/** A deterministic wobble in [-1, 1]. */
const wobble = (k: number) => Math.sin(k * 12.9898) * 0.5 + Math.sin(k * 78.233) * 0.5;

describe("making a rebuilt player believable", () => {
  it("smooths a wobbling, half-unseen run into a path a body can run", () => {
    // Truth: from (-3, 6) to (2, 4) in 4 s at an even 1.35 m/s. Seen 4 frames in 10, each off by up to 15 cm
    // sideways and 40 cm in depth; the unseen ones as the tracker fills them: along a straight line with a kink.
    const truth = (t: number) => ({ x: -3 + 1.25 * t, z: 6 - 0.5 * t });
    const samples = Array.from({ length: 41 }, (_, k) => {
      const t = k / 10, p = truth(t), seen = k % 10 < 4;
      return VideoPlayerSample.create(t, p.x + (seen ? 0.15 * wobble(k) : 0.6), p.z + (seen ? 0.4 * wobble(k + 50) : -0.5), Math.PI,
        "ready", { occluded: !seen, confidence: 0.7 });
    });
    const out = TrackCleanup.clean(samples, defaultTrackCleanup, camera);
    let worst = 0, fastest = 0;
    out.forEach((s, k) => {
      const p = truth(s.time);
      worst = Math.max(worst, Math.hypot(s.x - p.x, s.z - p.z));
      if (k > 0) fastest = Math.max(fastest, Math.hypot(s.x - out[k - 1].x, s.z - out[k - 1].z) / 0.1);
    });
    expect(worst).toBeLessThan(0.45);
    expect(fastest).toBeLessThan(3);
  });

  it("lets a player lost before the end of the clip come to a stop, not run on", () => {
    // Seen running at 4 m/s along x until 1.5 s, then not again until the clip ends at 4 s (and not before 0.5 s).
    const samples = Array.from({ length: 41 }, (_, k) => {
      const t = k / 10, seen = t >= 0.5 && t <= 1.5;
      return VideoPlayerSample.create(t, seen ? -2 + 4 * (t - 0.5) : 0, -6, 0, "ready", { occluded: !seen, confidence: 0.8 });
    });
    const out = TrackCleanup.clean(samples, defaultTrackCleanup, camera);
    const end = out[out.length - 1], atLast = out[15], atFirst = out[5];
    expect(Math.abs(end.x - atLast.x)).toBeLessThan(1.5);
    expect(Math.abs(out[0].x - atFirst.x)).toBeLessThan(1.5);
    expect(Math.abs(end.x)).toBeLessThan(4);
  });

  it("never lets a player go faster than a sprint", () => {
    const samples = Array.from({ length: 11 }, (_, k) => VideoPlayerSample.create(k / 10, k === 5 ? 4 : 0, 5, Math.PI, "ready", { confidence: 1 }));
    const out = TrackCleanup.clean(samples, { ...defaultTrackCleanup, acceleration: 200 }, camera);
    for (let k = 1; k < out.length; k++) {
      expect(Math.hypot(out[k].x - out[k - 1].x, out[k].z - out[k - 1].z) / 0.1).toBeLessThanOrEqual(defaultTrackCleanup.maxSpeed + 1e-6);
    }
  });

  it("keeps a block at the net as a real jump, with a missed frame in the air", () => {
    // Up 0.7 m in a 0.76 s flight around t 1.1; the reading at 1.1 dropped out.
    const flight = (t: number) => Math.max(0, 0.7 * (1 - ((2 * (t - 1.1)) / 0.755) ** 2));
    const samples = Array.from({ length: 23 }, (_, k) => {
      const t = k / 10;
      return VideoPlayerSample.create(t, 0.5, 0.8, Math.PI, "block", { jump: Math.abs(t - 1.1) < 0.01 ? 0 : flight(t), confidence: 0.8 });
    });
    const out = TrackCleanup.clean(samples, defaultTrackCleanup, camera);
    const top = out.find((s) => Math.abs(s.time - 1.1) < 0.01)!;
    expect(top.jump).toBeGreaterThan(0.6);
    expect(top.jump).toBeLessThanOrEqual(defaultTrackCleanup.maxJump);
    for (const s of out) if (Math.abs(s.time - 1.1) > 0.5) expect(s.jump).toBe(0);
  });

  it("puts a player who seems to fly in the back court back on the floor", () => {
    // The feet read 1.8 m up for 3 s in the middle of their court: a misreading, not a jump.
    const samples = Array.from({ length: 41 }, (_, k) =>
      VideoPlayerSample.create(k / 10, -1, -6, 0, "ready", { jump: k > 5 && k < 36 ? 1.8 : 0, confidence: 0.5 }));
    const out = TrackCleanup.clean(samples, defaultTrackCleanup, camera);
    expect(Math.max(...out.map((s) => s.jump))).toBe(0);
    // And a 2.7 m reading at the net becomes at most a real jump.
    const net = Array.from({ length: 21 }, (_, k) =>
      VideoPlayerSample.create(k / 10, 0, 0.7, Math.PI, "block", { jump: k >= 9 && k <= 12 ? 2.7 : 0, confidence: 0.6 }));
    expect(Math.max(...TrackCleanup.clean(net, defaultTrackCleanup, camera).map((s) => s.jump))).toBeLessThanOrEqual(defaultTrackCleanup.maxJump);
  });
});
