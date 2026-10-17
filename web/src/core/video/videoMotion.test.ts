import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "../spatial/skeleton";
import { Stride, strideParams } from "../spatial/gait";
import { VideoCamera } from "./courtCalibration";
import { VideoPlayerSample, VideoPlayerTrack, VideoScene } from "./videoScene";

const skeleton = new SkeletonModel(new BodyMetrics(1.9));
const pose = (posture: Posture, forward: number, left: number, phase: number) =>
  skeleton.pose(strideParams(Posture.params(posture, skeleton), skeleton, { forward, left, phase }), { x: 0, z: 0 }, 0);

/** A player running from z = 8 toward the net at `speed` m/s, facing it, with the given posture and confidence. */
function runner(speed: number, posture: Posture, confidence: number): VideoScene {
  const samples = Array.from({ length: 31 }, (_, k) => VideoPlayerSample.create(k / 10, 0, 8 - (speed * k) / 10, Math.PI, posture, { confidence }));
  const camera = VideoCamera.lookingAt(new V3(0, 9.4, 38.9), new V3(0, 0, -4.8), 1743, 600, 338);
  return new VideoScene({ title: "run", duration: 3, camera, players: [VideoPlayerTrack.create({ side: "home", label: "1", samples })] });
}

describe("Video to 3D: players step instead of sliding", () => {
  it("alternates the feet along the run, lifts the swinging one and swings the arms against the legs", () => {
    const quarter = pose("ready", 3, 0, Math.PI / 2), start = pose("ready", 3, 0, 0);
    const z = (p: typeof quarter, j: Joint) => p[j].translation.z;
    // A quarter cycle in: the left foot is ahead by about two half steps, the left arm behind.
    expect(z(quarter, Joint.lAnkle) - z(quarter, Joint.rAnkle)).toBeGreaterThan(1.5 * Stride.halfStep(3));
    expect(z(quarter, Joint.lWrist)).toBeLessThan(z(quarter, Joint.rWrist));
    // At the start of the cycle the left foot swings, off the floor; the right one carries the body.
    expect(start[Joint.lAnkle].translation.y - start[Joint.rAnkle].translation.y).toBeGreaterThan(0.08);
    // Standing still nothing changes.
    const still = skeleton.pose(Posture.params("ready", skeleton), { x: 0, z: 0 }, 0);
    expect(pose("ready", 0, 0, 1)[Joint.lAnkle].translation.sub(still[Joint.lAnkle].translation).length).toBeLessThan(1e-9);
  });

  it("keeps the planted foot nearly still while the body runs past it", () => {
    const scene = runner(3, "ready", 1);
    // The right foot carries the body while the left swings: from the right foot furthest ahead (sin = -1) half a
    // cycle on to the right foot furthest behind.
    const at = (t: number) => scene.frame(t).posedPlayers()[0];
    const phaseAt = (t: number) => scene.frame(t).motion.get(scene.players[0].id)!.phase;
    const from = Math.ceil((phaseAt(1) - 1.5 * Math.PI) / (2 * Math.PI)) * 2 * Math.PI + 1.5 * Math.PI;
    let t0 = 1;
    while (phaseAt(t0) < from) t0 += 0.001;
    let t1 = t0;
    while (phaseAt(t1) < from + Math.PI) t1 += 0.001;
    const foot = (t: number) => at(t).joints[Joint.rAnkle].translation;
    const body = Math.abs(at(t1).joints[Joint.pelvis].translation.z - at(t0).joints[Joint.pelvis].translation.z);
    expect(body).toBeGreaterThan(0.5);
    expect(Math.abs(foot(t1).z - foot(t0).z)).toBeLessThan(0.25 * body);
  });

  it("shows a running player the video barely saw in a run, not in a held set", () => {
    const head = (scene: VideoScene) => {
      const p = scene.frame(1.5).posedPlayers()[0];
      return { wristOverHead: Math.max(p.joints[Joint.lWrist].translation.y, p.joints[Joint.rWrist].translation.y) - p.joints[Joint.head].translation.y };
    };
    // A set the keypoints barely support (confidence 0.05) becomes a run with the arms low...
    expect(head(runner(3, "set", 0.05)).wristOverHead).toBeLessThan(-0.3);
    // ...a well-seen one keeps its hands up.
    expect(head(runner(0, "set", 0.9)).wristOverHead).toBeGreaterThan(0);
  });
});
