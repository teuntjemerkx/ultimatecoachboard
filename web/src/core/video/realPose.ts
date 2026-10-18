// Web addition: a player's own joint angles from the pose model's 3D points (see RealPose).
import { Quat, V3 } from "../spatial/math3d";
import { allJoints, Joint, jointParent } from "../spatial/skeleton";
import type { VideoCamera } from "./courtCalibration";
import type { ImagePoint } from "./videoMath";

/** The body points the joints are read from (MediaPipe's landmarks; left and right are the player's own). */
export type WorldJoint =
  | "nose" | "leftEar" | "rightEar" | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftWrist" | "rightWrist"
  | "leftHip" | "rightHip" | "leftKnee" | "rightKnee" | "leftAnkle" | "rightAnkle" | "leftHeel" | "rightHeel" | "leftToe" | "rightToe";

/** A body point in metres about the middle of the hips, on the court's axes (y up), and how visible it was (0...1). */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
  v: number;
}

export type WorldPose = Partial<Record<WorldJoint, WorldPoint>>;

/** MediaPipe's landmark numbers. */
const LANDMARKS: readonly [WorldJoint, number][] = [
  ["nose", 0], ["leftEar", 7], ["rightEar", 8], ["leftShoulder", 11], ["rightShoulder", 12], ["leftElbow", 13], ["rightElbow", 14],
  ["leftWrist", 15], ["rightWrist", 16], ["leftHip", 23], ["rightHip", 24], ["leftKnee", 25], ["rightKnee", 26],
  ["leftAnkle", 27], ["rightAnkle", 28], ["leftHeel", 29], ["rightHeel", 30], ["leftToe", 31], ["rightToe", 32],
];

const mirror = (j: WorldJoint): WorldJoint =>
  (j.startsWith("left") ? `right${j.slice(4)}` : j.startsWith("right") ? `left${j.slice(5)}` : j) as WorldJoint;

/** The shortest rotation taking unit vector a to unit vector b. */
function between(a: V3, b: V3): Quat {
  const d = a.dot(b);
  if (d > 1 - 1e-9) return Quat.identity;
  if (d < -1 + 1e-9) {
    const axis = Math.abs(a.x) < 0.9 ? a.cross(new V3(1, 0, 0)) : a.cross(new V3(0, 1, 0));
    return Quat.fromAxisAngle(axis, Math.PI);
  }
  const c = a.cross(b);
  return new Quat(c.x, c.y, c.z, 1 + d).normalized;
}

/** A body frame: x along `across` (to the body's left), y up along `up` made square to it, z forward. */
function frame(across: V3, up: V3): Quat | undefined {
  if (across.length < 1e-4) return undefined;
  const x = across.normalized;
  const y0 = up.sub(x.mul(up.dot(x)));
  if (y0.length < 1e-4) return undefined;
  const y = y0.normalized;
  return Quat.fromBasis(x, y, x.cross(y));
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** How sure the points are that the limbs come from: the mean visibility of shoulders to ankles. */
const limbPoints: readonly WorldJoint[] = [
  "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
  "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
];

/**
 * A player's own joint angles from the pose model's 3D points ("world landmarks"), instead of the nearest posture
 * from the library: the 3D board's skeleton then moves as the player in the video moves.
 */
export const RealPose = {
  /**
   * The pose model's world landmarks of one person (metres about the hips, on the camera's axes: x right, y down, z
   * away) on the court's axes. The model reads a crop around the person as if they stood straight ahead, so its axes
   * are turned onto the camera's ray through the crop's centre first, then by the camera's rotation onto the court.
   */
  fromMediaPipe(world: readonly { x: number; y: number; z: number; visibility?: number }[], camera: VideoCamera,
    cropCentre: ImagePoint): WorldPose {
    const f = camera.focalLength;
    const ray = new V3((cropCentre.x - camera.width / 2) / f, (cropCentre.y - camera.height / 2) / f, 1).normalized;
    const toCourt = camera.rotation.conjugate.mul(between(new V3(0, 0, 1), ray));
    const out: WorldPose = {};
    for (const [name, i] of LANDMARKS) {
      const p = world[i];
      if (!p) continue;
      const w = toCourt.rotate(new V3(p.x, p.y, p.z));
      out[name] = { x: round(w.x), y: round(w.y), z: round(w.z), v: round(p.visibility ?? 0.5) };
    }
    return out;
  },

  /**
   * Local joint rotations of the 17-joint skeleton (as `PoseParams.rotations`; the pelvis's relative to `facing`) and
   * how sure they are (0...1), or undefined without both hips and both shoulders. From behind the model often swaps
   * left and right: the points are mirrored when the hips and shoulders point the body's left the wrong way for the
   * facing the track has. Pelvis and chest are frames across the hips and the shoulders with the trunk as up (the
   * spine halfway); each limb segment is turned from its parent onto the measured direction (the shortest turn, so no
   * twist is made up); a point seen with visibility under 0.3 leaves its segment hanging from the parent.
   */
  rotations(pose: WorldPose, facing: number): { rotations: Map<Joint, Quat>; confidence: number } | undefined {
    const left = new V3(Math.cos(facing), 0, -Math.sin(facing));
    const raw = (j: WorldJoint) => { const p = pose[j]; return p ? new V3(p.x, p.y, p.z) : undefined; };
    const hipL0 = raw("leftHip"), hipR0 = raw("rightHip"), shL0 = raw("leftShoulder"), shR0 = raw("rightShoulder");
    if (!hipL0 || !hipR0 || !shL0 || !shR0) return undefined;
    const swap = hipL0.sub(hipR0).add(shL0.sub(shR0)).dot(left) < 0;
    const at = (j: WorldJoint, least = 0.3) => {
      const p = pose[swap ? mirror(j) : j];
      return p && p.v >= least ? new V3(p.x, p.y, p.z) : undefined;
    };
    const hipL = at("leftHip", 0)!, hipR = at("rightHip", 0)!, shL = at("leftShoulder", 0)!, shR = at("rightShoulder", 0)!;
    const midHip = hipL.add(hipR).mul(0.5), midSh = shL.add(shR).mul(0.5);
    const up = midSh.sub(midHip);
    if (up.y <= 0) return undefined;
    const pelvis = frame(hipL.sub(hipR), up), chest = frame(shL.sub(shR), up);
    if (!pelvis || !chest) return undefined;
    /** The parent's frame turned so that its rest bone direction (`rest`) points from `from` to `to`. */
    const aim = (parent: Quat, from: V3 | undefined, to: V3 | undefined, rest = new V3(0, -1, 0)) => {
      if (!from || !to) return parent;
      const d = to.sub(from);
      if (d.length < 1e-4) return parent;
      return between(parent.rotate(rest).normalized, d.normalized).mul(parent);
    };
    const world = new Map<Joint, Quat>();
    world.set(Joint.pelvis, pelvis);
    world.set(Joint.spine, pelvis.slerp(chest, 0.5));
    world.set(Joint.chest, chest);
    world.set(Joint.neck, chest);
    const earL = at("leftEar"), earR = at("rightEar");
    const ears = earL && earR ? earL.add(earR).mul(0.5) : earL ?? earR;
    world.set(Joint.head, aim(chest, midSh, ears, new V3(0, 1, 0)));
    for (const side of ["left", "right"] as const) {
      const l = side === "left";
      const sh = aim(chest, at(`${side}Shoulder`), at(`${side}Elbow`));
      const el = aim(sh, at(`${side}Elbow`), at(`${side}Wrist`));
      const hip = aim(pelvis, at(`${side}Hip`), at(`${side}Knee`));
      const knee = aim(hip, at(`${side}Knee`), at(`${side}Ankle`));
      const ankle = aim(knee, at(`${side}Heel`), at(`${side}Toe`), new V3(0, 0, 1));
      world.set(l ? Joint.lShoulder : Joint.rShoulder, sh);
      world.set(l ? Joint.lElbow : Joint.rElbow, el);
      world.set(l ? Joint.lWrist : Joint.rWrist, el);
      world.set(l ? Joint.lHip : Joint.rHip, hip);
      world.set(l ? Joint.lKnee : Joint.rKnee, knee);
      world.set(l ? Joint.lAnkle : Joint.rAnkle, ankle);
    }
    const yaw = Quat.fromAxisAngle(V3.up, facing);
    const rotations = new Map<Joint, Quat>();
    for (const j of allJoints) {
      const parent = jointParent(j);
      const w = world.get(j)!;
      rotations.set(j, (parent === undefined ? yaw : world.get(parent)!).conjugate.mul(w).normalized);
    }
    const seen = limbPoints.map((j) => pose[j]?.v ?? 0);
    return { rotations, confidence: seen.reduce((a, b) => a + b, 0) / seen.length };
  },

  /** Rotations as 68 numbers (17 quaternions x, y, z, w, four decimals), for keeping with a sample. */
  pack(rotations: Map<Joint, Quat>): number[] {
    return allJoints.flatMap((j) => {
      const q = rotations.get(j) ?? Quat.identity;
      return [round(q.x), round(q.y), round(q.z), round(q.w)];
    });
  },

  unpack(packed: readonly number[]): Map<Joint, Quat> {
    const out = new Map<Joint, Quat>();
    allJoints.forEach((j, i) => out.set(j, new Quat(packed[4 * i], packed[4 * i + 1], packed[4 * i + 2], packed[4 * i + 3]).normalized));
    return out;
  },

  /**
   * Joint rotations smoothed over time: per joint the weighted mean of the neighbours within `reach` samples (weights
   * falling off linearly, times each sample's confidence), quaternions turned onto one hemisphere first. Samples
   * without rotations stay without.
   */
  smooth(series: readonly ({ rotations: Map<Joint, Quat>; confidence: number } | undefined)[], reach = 2):
    ({ rotations: Map<Joint, Quat>; confidence: number } | undefined)[] {
    return series.map((s, i) => {
      if (!s) return undefined;
      const rotations = new Map<Joint, Quat>();
      for (const j of allJoints) {
        const own = s.rotations.get(j) ?? Quat.identity;
        let sum = new Quat(0, 0, 0, 0), total = 0;
        for (let k = -reach; k <= reach; k++) {
          const o = series[i + k];
          if (!o) continue;
          let q = o.rotations.get(j) ?? Quat.identity;
          if (q.dot(own) < 0) q = q.scale(-1);
          const w = (reach + 1 - Math.abs(k)) * Math.max(0.05, o.confidence);
          sum = sum.add(q.scale(w));
          total += w;
        }
        rotations.set(j, total > 0 ? sum.normalized : own);
      }
      return { rotations, confidence: s.confidence };
    });
  },
};
