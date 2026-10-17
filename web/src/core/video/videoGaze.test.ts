import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { BallSegment } from "./ballReconstruction";
import { VideoCamera } from "./courtCalibration";
import { VideoGaze } from "./videoGaze";
import { VideoScene } from "./videoScene";

const camera = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 0, 0), 1200, 1280, 720);
const sceneWith = (ball: BallSegment[]) => new VideoScene({ title: "gaze", duration: 10, camera, ball, netHeight: 2.24 });
const elevation = (d: V3) => (Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI;
const angle = (a: V3, b: V3) => (Math.acos(Math.max(-1, Math.min(1, a.normalized.dot(b.normalized)))) * 180) / Math.PI;

describe("where a player looks in the eye view", () => {
  // A serve from their end line over the net to our court: from t 2 to 3.
  const serve = new BallSegment(2, 3, new V3(0, 2.8, -9), new V3(0, 3, 15));

  it("follows the ball while the video has it", () => {
    const scene = sceneWith([serve]);
    // The receiver deep in our court; the ball comes at her from 15 m (the last tenths, close by, swing too fast to
    // follow exactly, as for a real head).
    const eye = new V3(1, 1.65, 8);
    for (const t of [2.3, 2.5, 2.7]) {
      const d = VideoGaze.direction(scene, "home", eye, t);
      expect(angle(d, serve.position(t).sub(eye))).toBeLessThan(12);
    }
  });

  it("bridges a contact the video missed, in time", () => {
    const a = new BallSegment(1, 2, new V3(0, 2, -6), new V3(0, 2, 6));
    const b = new BallSegment(2.6, 3.4, new V3(2, 3, 4), new V3(-1, 2, -6));
    const mid = VideoGaze.ballAt(sceneWith([a, b]), 2.3)!;
    const from = a.position(2), to = b.position(2.6);
    expect(mid.sub(from.add(to.sub(from).mul(0.5))).length).toBeLessThan(1e-6);
  });

  it("without a ball, looks across the net at the play, never at the roof", () => {
    const scene = sceneWith([]);
    // A blocker in the air: her head would point up; the eyes go to their attackers.
    const blocker = new V3(0, 2.6, 0.6);
    const d = VideoGaze.direction(scene, "home", blocker, 5);
    expect(d.z).toBeLessThan(0);
    expect(elevation(d)).toBeLessThan(25);
    // A back-row player looks at the middle of their court.
    const back = VideoGaze.direction(scene, "home", new V3(-2, 1.6, 7), 5);
    expect(back.z).toBeLessThan(-0.9);
    // Their players look our way.
    expect(VideoGaze.direction(scene, "opponent", new V3(0, 1.6, -6), 5).z).toBeGreaterThan(0.9);
  });

  it("keeps the pitch sensible for a ball right overhead or at the feet", () => {
    const up = sceneWith([new BallSegment(0, 2, new V3(0, 8, 6.01), new V3(0, 0, 0))]);
    expect(elevation(VideoGaze.direction(up, "home", new V3(0, 1.6, 6), 1))).toBeLessThanOrEqual(55.01);
    const down = sceneWith([new BallSegment(0, 2, new V3(0.01, 0.12, 6), new V3(0, 0, 0))]);
    expect(elevation(VideoGaze.direction(down, "home", new V3(0, 1.6, 6), 1))).toBeGreaterThanOrEqual(-40.01);
  });

  it("turns like a head, a moment behind, toward a ball that is about to come", () => {
    // A ball that will be on the left from t 4 (held still by an upward push against gravity for the test's span);
    // a second ahead the eyes start to go there, gradually.
    const ball = new BallSegment(4, 6, new V3(-6, 2, 0), new V3(0, 0, 0));
    const scene = sceneWith([ball]);
    const eye = new V3(0, 1.6, 5);
    const at = (t: number) => angle(VideoGaze.direction(scene, "home", eye, t), ball.position(4).sub(eye));
    expect(at(2.5)).toBeGreaterThan(30);
    expect(at(3.02)).toBeLessThan(at(2.5));
    expect(at(3.02)).toBeGreaterThan(at(3.5));
    expect(at(3.5)).toBeLessThan(3);
  });
});
