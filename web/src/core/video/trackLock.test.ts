import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { VideoCamera } from "./courtCalibration";
import { PersonDetection, PlayerTracker, TrackedPlayer, type VideoFrameObservation } from "./playerTracking";

// A camera high behind the home end line that sees the whole court.
const camera = VideoCamera.lookingAt(new V3(0, 6, 16), new V3(0, 0, 0), 1100, 1280, 720);

/** A person standing at (x, z), seen by the camera at their feet. */
const person = (x: number, z: number, appearance?: number[]) =>
  PersonDetection.create({ x, z }, camera.project(V3.fromFloor({ x, z }, 0))!, { appearance });

const foot = (x: number, z: number) => camera.project(V3.fromFloor({ x, z }, 0))!;

describe("following the players the coach tapped", () => {
  it("keeps a tapped player through a gap longer than any automatic track lasts", () => {
    // From (2, 6) to (-2, 3) in 4 s; not detected from 1.0 to 2.6 s. A second player stands still at (-3, 7).
    const path = (t: number) => ({ x: 2 - t, z: 6 - 0.75 * t });
    const frames: VideoFrameObservation[] = Array.from({ length: 41 }, (_, k) => {
      const t = k / 10, p = path(t);
      return { time: t, detections: [...(t > 0.95 && t < 2.65 ? [] : [person(p.x, p.z)]), person(-3, 7)] };
    });
    const { tracks, taken } = new PlayerTracker().follow(frames, [{ time: 0.2, foot: foot(1.8, 5.85) }], camera);
    expect(tracks.length).toBe(1);
    const [t] = tracks;
    expect(t.side).toBe("home");
    expect(t.samples.length).toBe(41);
    expect(TrackedPlayer.observedCount(t)).toBe(41 - 17);
    // Never the player standing still.
    for (const s of t.samples) if (s.measured) expect(Math.hypot(s.measured.x + 3, s.measured.z - 7)).toBeGreaterThan(1);
    // Through the gap on a believable line.
    const mid = t.samples.find((s) => Math.abs(s.time - 1.8) < 0.01)!;
    expect(Math.hypot(mid.floor.x - path(1.8).x, mid.floor.z - path(1.8).z)).toBeLessThan(1.2);
    expect(taken.size).toBe(24);
  });

  it("does not swap two tapped players who cross with their jerseys apart", () => {
    // Two home players crossing at t = 1.5: A from x -2 to 2, B from 2 to -2, both at z 4; one box for both around
    // the crossing.
    const red = [0.8, 0.1, 0.1], white = [0.9, 0.9, 0.9];
    const frames: VideoFrameObservation[] = Array.from({ length: 31 }, (_, k) => {
      const t = k / 10, a = -2 + (4 * t) / 3, b = 2 - (4 * t) / 3;
      const crossing = Math.abs(t - 1.5) < 0.15;
      return { time: t, detections: crossing ? [person(0, 4)] : [person(a, 4, red), person(b, 4.1, white)] };
    });
    const { tracks } = new PlayerTracker().follow(frames, [{ time: 0, foot: foot(-2, 4) }, { time: 0, foot: foot(2, 4.1) }], camera);
    expect(tracks.length).toBe(2);
    const end = (t: TrackedPlayer) => t.samples[t.samples.length - 1].floor.x;
    expect(end(tracks[0])).toBeGreaterThan(1.5);
    expect(end(tracks[1])).toBeLessThan(-1.5);
  });

  it("starts from the tapped spot when the detector missed the player there", () => {
    const frames: VideoFrameObservation[] = Array.from({ length: 11 }, (_, k) => ({
      time: k / 10, detections: k === 2 ? [person(-3, -5)] : [person(-3, -5), person(1, -2)],
    }));
    const { tracks } = new PlayerTracker().follow(frames, [{ time: 0.2, foot: foot(1.1, -2) }], camera);
    expect(tracks.length).toBe(1);
    expect(tracks[0].side).toBe("opponent");
    expect(TrackedPlayer.observedCount(tracks[0])).toBe(11);
    expect(tracks[0].samples.every((s) => Math.hypot(s.floor.x - 1, s.floor.z + 2) < 0.3)).toBe(true);
  });
});
