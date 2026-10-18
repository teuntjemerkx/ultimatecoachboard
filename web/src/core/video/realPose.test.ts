import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { PoseParams } from "../spatial/postureLibrary";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "../spatial/skeleton";
import { VideoCamera } from "./courtCalibration";
import { RealPose, type WorldJoint, type WorldPose } from "./realPose";
import { VideoPlayerSample, VideoPlayerTrack, VideoScene } from "./videoScene";

const s = new SkeletonModel(new BodyMetrics(1.8));

/** The body points of a posed skeleton, about the middle of its hips, as the pose model would give them. */
function pointsOf(posture: Posture, facing: number, swap = false): WorldPose {
  const joints = s.pose(posture, { x: 2, z: 5 }, facing).map((r) => r.translation);
  const hips = joints[Joint.lHip].add(joints[Joint.rHip]).mul(0.5);
  const head = joints[Joint.head], chest = joints[Joint.chest];
  const ear = (side: number) => head.add(chest.sub(head).mul(0)).add(new V3(side * 0.08 * Math.cos(facing), 0.1, -side * 0.08 * Math.sin(facing)));
  const at: Partial<Record<WorldJoint, V3>> = {
    leftShoulder: joints[Joint.lShoulder], rightShoulder: joints[Joint.rShoulder], leftElbow: joints[Joint.lElbow], rightElbow: joints[Joint.rElbow],
    leftWrist: joints[Joint.lWrist], rightWrist: joints[Joint.rWrist], leftHip: joints[Joint.lHip], rightHip: joints[Joint.rHip],
    leftKnee: joints[Joint.lKnee], rightKnee: joints[Joint.rKnee], leftAnkle: joints[Joint.lAnkle], rightAnkle: joints[Joint.rAnkle],
    leftEar: ear(1), rightEar: ear(-1),
  };
  const out: WorldPose = {};
  for (const [k, p] of Object.entries(at) as [WorldJoint, V3][]) {
    const name = swap ? ((k.startsWith("left") ? `right${k.slice(4)}` : `left${k.slice(5)}`) as WorldJoint) : k;
    const q = p.sub(hips);
    out[name] = { x: q.x, y: q.y, z: q.z, v: 0.9 };
  }
  return out;
}

/** The farthest any limb joint lands from where the posture put it, posed again from the read rotations. */
function worst(posture: Posture, facing: number, swap = false): number {
  const truth = s.pose(posture, { x: 2, z: 5 }, facing).map((r) => r.translation);
  const read = RealPose.rotations(pointsOf(posture, facing, swap), facing)!;
  const again = s.pose(new PoseParams(read.rotations, Posture.params(posture, s).jump), { x: 2, z: 5 }, facing).map((r) => r.translation);
  // Compare limbs about the pelvis (both stand on the floor; their pelvis heights may differ by the stance).
  const rel = (j: V3[], k: Joint) => j[k].sub(j[Joint.pelvis]);
  const limbs = [Joint.lElbow, Joint.rElbow, Joint.lWrist, Joint.rWrist, Joint.lKnee, Joint.rKnee, Joint.lAnkle, Joint.rAnkle];
  return Math.max(...limbs.map((k) => rel(again, k).sub(rel(truth, k)).length));
}

describe("a player's own joints from the pose model's 3D points", () => {
  it("puts arms and legs where the points say, for very different postures and facings", () => {
    for (const [posture, facing] of [["attack", Math.PI], ["dig", 0.4], ["block", Math.PI], ["jumpServe", -2.5], ["pass", 1.2]] as [Posture, number][]) {
      expect(worst(posture, facing), `${posture}`).toBeLessThan(0.05);
    }
  });

  it("reads a player seen from behind with left and right swapped the right way round", () => {
    expect(worst("attack", Math.PI, true)).toBeLessThan(0.05);
    expect(worst("pass", 0.3, true)).toBeLessThan(0.05);
  });

  it("turns the model's camera axes onto the court", () => {
    const camera = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 0, 0), 1100, 1280, 720);
    // Straight up from the hips, seen in the middle of the picture and at its right edge.
    for (const centre of [{ x: 640, y: 360 }, { x: 1200, y: 400 }]) {
      const f = camera.focalLength;
      const ray = new V3((centre.x - 640) / f, (centre.y - 360) / f, 1).normalized;
      // The model's axes look along the ray: build the same turn by hand and give it the court's up.
      const up = camera.rotation.rotate(V3.up);
      const c = new V3(0, 0, 1).cross(ray), d = new V3(0, 0, 1).dot(ray);
      const back = Math.hypot(c.x, c.y, c.z) < 1e-9 ? up : rotateBack(up, ray);
      const pose = RealPose.fromMediaPipe(Array.from({ length: 33 }, (_, i) => (i === 11 ? { x: back.x, y: back.y, z: back.z } : { x: 0, y: 0, z: 0 })),
        camera, centre);
      expect(pose.leftShoulder!.y).toBeCloseTo(1, 3);
      expect(Math.hypot(pose.leftShoulder!.x, pose.leftShoulder!.z)).toBeLessThan(1e-3);
      void d;
    }
  });
});

describe("the 3D body following the video", () => {
  it("shows the player's own arms where the video read them clearly, the posture where it did not", () => {
    const camera = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 0, 0), 1100, 1280, 720);
    const facing = Math.PI;
    const read = RealPose.rotations(pointsOf("attack", facing), facing)!;
    const sample = (time: number, confidence: number) => {
      const v = VideoPlayerSample.create(time, 2, 5, facing, "ready");
      v.joints = RealPose.pack(read.rotations);
      v.jointsConfidence = confidence;
      return v;
    };
    const wristOf = (confidence: number) => {
      const scene = new VideoScene({ title: "t", duration: 1, camera, players: [VideoPlayerTrack.create({ side: "home", label: "1",
        stature: 1.8, samples: [sample(0, confidence), sample(1, confidence)] })] });
      const p = scene.frame(0.5).posedPlayers()[0];
      return p.joints[Joint.rWrist].translation.sub(p.joints[Joint.pelvis].translation);
    };
    const attack = s.pose("attack", { x: 2, z: 5 }, facing).map((r) => r.translation);
    const ready = s.pose("ready", { x: 2, z: 5 }, facing).map((r) => r.translation);
    const rel = (j: V3[]) => j[Joint.rWrist].sub(j[Joint.pelvis]);
    expect(wristOf(0.9).sub(rel(attack)).length, "read clearly: the attack's arm").toBeLessThan(0.08);
    expect(wristOf(0.2).sub(rel(ready)).length, "barely read: the posture").toBeLessThan(0.08);
  });
});

/** `v` (camera axes) as the model sees it looking along `ray`: turned back by the shortest turn from +z to the ray. */
function rotateBack(v: V3, ray: V3): V3 {
  const a = new V3(0, 0, 1), axis = a.cross(ray).normalized, angle = Math.acos(Math.max(-1, Math.min(1, a.dot(ray))));
  // Rodrigues, by -angle.
  const k = axis, c = Math.cos(-angle), s0 = Math.sin(-angle);
  return v.mul(c).add(k.cross(v).mul(s0)).add(k.mul(k.dot(v) * (1 - c)));
}
