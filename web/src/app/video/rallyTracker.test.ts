import { describe, expect, it } from "vitest";
import { V3 } from "../../core/spatial";
import { PersonDetection, PlayerTracker, VideoCamera, type VideoFrameObservation } from "../../core/video";
import { pickBalls } from "./pipeline";
import { RallyTracker } from "./rallyTracker";

/**
 * Six players a side wandering a little (one home player missed in every fifth frame), and a coach standing just
 * behind the home end line all clip long.
 */
function rally(): VideoFrameObservation[] {
  const spots = [[3, 7], [3, 1.5], [0, 2], [-3, 1.5], [-3, 7], [0, 6.5]];
  const frames: VideoFrameObservation[] = [];
  for (let k = 0; k < 40; k++) {
    const t = k / 10;
    const dets = spots.flatMap(([x, z], i) => [
      ...(i === 2 && k % 5 === 0 ? [] : [PersonDetection.create({ x: x + 0.3 * Math.sin(t + i), z: z + 0.2 * Math.cos(t + i) }, { x: 0, y: 0 })]),
      PersonDetection.create({ x: -x + 0.3 * Math.sin(t - i), z: -z - 0.2 * Math.cos(t - i) }, { x: 0, y: 0 }),
    ]);
    dets.push(PersonDetection.create({ x: -4.6, z: 10.2 + 0.05 * Math.sin(3 * t) }, { x: 0, y: 0 }));
    frames.push({ time: t, detections: dets });
  }
  return frames;
}

describe("Video to 3D tracking on real footage", () => {
  it("leaves out a coach who never comes onto the court", () => {
    const frames = rally();
    // The core keeps the coach (within its 2 m court margin, and seen in every frame) and so loses a player.
    const core = new PlayerTracker().track(frames);
    expect(core.some((t) => t.samples.every((s) => s.floor.z > 9.5))).toBe(true);
    const tracks = new RallyTracker().track(frames);
    expect(tracks.filter((t) => t.side === "home").length).toBe(6);
    expect(tracks.filter((t) => t.side === "opponent").length).toBe(6);
    for (const t of tracks) expect(t.samples.every((s) => s.floor.z < 9.5), "no track behind the home end line").toBe(true);
  });

  it("cuts the jump allowance for a far, low camera", () => {
    const broadcast = VideoCamera.lookingAt(new V3(0, 9.4, 38.9), new V3(0, 0, -4.8), 1743, 600, 338);
    const stands = VideoCamera.lookingAt(new V3(1.5, 8, 21), new V3(0, 0, -1), 1500, 1920, 1080);
    const sideline = VideoCamera.lookingAt(new V3(-15, 3, 1), new V3(0, 0.5, 0), 950, 1920, 1080);
    expect(RallyTracker.forCamera(broadcast).settings.maxFootHeight).toBeCloseTo(2 * 9.4 / 38.9, 6);
    expect(RallyTracker.forCamera(stands).settings.maxFootHeight).toBeCloseTo(2 * 8 / 21, 6);
    expect(RallyTracker.forCamera(sideline).settings.maxFootHeight).toBe(1.2);
  });

  it("follows the ball rather than the best-scoring stray candidate", () => {
    const frames = [0, 0.1, 0.2, 0.3].map((t, k) => ({
      time: t,
      balls: [{ x: 900, y: 50, score: 0.6 }, { x: 300 + 40 * k, y: 400 - 30 * k, score: 0.4 }],
    }));
    frames[0].balls.reverse();
    const picked = pickBalls(frames, 1920);
    expect(picked.map((p) => p?.x)).toEqual([300, 340, 380, 420]);
  });
});
