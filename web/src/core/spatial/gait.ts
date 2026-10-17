// Web addition (no Swift counterpart): a step cycle laid over a pose for a player moving over the floor. The posture
// library has no running or walking, so a player rebuilt from a video otherwise slides across the court in one
// stance. The feet alternate along the direction of travel with step lengths of a walk or a run for the speed, the
// swinging foot lifts, the arms swing against the legs and the trunk leans into a forward run. The cycle advances
// with the distance covered (`Stride.phasePerMetre`), so a planted foot stays where it is while the body passes it.
import { Quat, V3 } from "./math3d";
import { PoseParams } from "./postureLibrary";
import { Joint, SkeletonModel } from "./skeleton";

/** A player's motion for the step cycle: velocity in the body frame (m/s) and the cycle's phase (radians). */
export interface StrideMotion {
  /** Along the facing (backwards negative). */
  forward: number;
  /** To the player's own left (right negative). */
  left: number;
  /** 0 with the feet together and the left foot about to swing forward; the cycle repeats every 2 pi. */
  phase: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const Stride = {
  /** Speeds above this read as noise in the track (metres per second). */
  maxSpeed: 7,

  /** Half a step along the direction of travel (metres): short steps walking, long ones running. */
  halfStep(speed: number): number {
    return Math.min(0.55, 0.12 + 0.12 * Math.max(0, speed));
  },

  /** Radians of the cycle per metre travelled: one cycle is two steps, each two half steps long. */
  phasePerMetre(speed: number): number {
    return (2 * Math.PI) / (4 * Stride.halfStep(speed));
  },

  /** How much of the cycle shows: none standing (or shifting weight), all from a brisk walk on. */
  weight(speed: number): number {
    return smoothstep(0.4, 1.2, speed);
  },

  /** Body-frame motion from a velocity on the floor (world x, z) for a facing (radians from +Z toward +X). */
  motion(velocity: { x: number; z: number }, facing: number, phase: number): StrideMotion {
    const s = Math.sin(facing), c = Math.cos(facing);
    return { forward: velocity.x * s + velocity.z * c, left: velocity.x * c - velocity.z * s, phase };
  },
};

/**
 * `base` with the step cycle for `motion`, faded in by speed (and by `weight`). Airborne poses are left alone. The
 * legs reach their targets by two-bone IK, so the stance and knee direction of the base posture carry through.
 */
export function strideParams(base: PoseParams, skeleton: SkeletonModel, motion: StrideMotion, weight = 1): PoseParams {
  const speed = Math.min(Stride.maxSpeed, Math.hypot(motion.forward, motion.left));
  const w = Math.max(0, Math.min(1, weight)) * Stride.weight(speed);
  if (base.airborne || w < 0.01) return base;
  const h = skeleton.metrics.stature;
  const params = new PoseParams(new Map(base.rotations), base.jump);
  // Travel direction in the body frame (x left, z forward).
  const ux = motion.left / Math.max(speed, 1e-6), uz = motion.forward / Math.max(speed, 1e-6);
  const a = Stride.halfStep(speed), lift = Math.min(0.22, 0.05 + 0.04 * speed) * (h / 1.9);
  const sin = Math.sin(motion.phase), cos = Math.cos(motion.phase);
  // The left foot leads half a cycle when sin > 0; a foot swings (and lifts) while it moves along the travel.
  const l = skeleton.legChain(params, true).ankle, r = skeleton.legChain(params, false).ankle;
  let la = new V3(l.x + ux * a * sin, l.y + lift * Math.max(0, cos), l.z + uz * a * sin);
  let ra = new V3(r.x - ux * a * sin, r.y + lift * Math.max(0, -cos), r.z - uz * a * sin);
  // Running sideways the feet would cross through each other: keep them a little apart.
  const minWidth = 0.1 * h;
  if (la.x - ra.x < minWidth) {
    const push = (minWidth - (la.x - ra.x)) / 2;
    la = la.with({ x: la.x + push });
    ra = ra.with({ x: ra.x - push });
  }
  skeleton.reachFeet(params, la, ra);
  // Arms against the legs (the left arm forward with the right foot), more the faster; the trunk leans into a run.
  const swing = 0.55 * Math.min(1, speed / 4) * Math.abs(uz);
  const turn = (j: Joint, angle: number) => params.rotations.set(j, Quat.fromAxisAngle(new V3(1, 0, 0), angle).mul(params.rotations.get(j) ?? Quat.identity));
  turn(Joint.lShoulder, swing * sin);
  turn(Joint.rShoulder, -swing * sin);
  turn(Joint.spine, Math.max(-0.08, Math.min(0.22, 0.05 * motion.forward)));
  return w >= 0.999 ? params : PoseParams.blend(base, params, w);
}

/**
 * Web addition: the step cycle's turning points for `motion` (each foot forward and back, each foot lifted, the arms at
 * both ends of their swing), as `strideParams` poses them; empty when no steps show. Every pose of the cycle lies
 * within these, so the body separation keeps them apart instead of the pose of the moment: the arms and legs then
 * never swing into anyone, and nobody is pushed about at every step.
 */
export function strideEnvelope(base: PoseParams, skeleton: SkeletonModel, motion: StrideMotion, weight = 1): PoseParams[] {
  const speed = Math.min(Stride.maxSpeed, Math.hypot(motion.forward, motion.left));
  if (base.airborne || Math.max(0, Math.min(1, weight)) * Stride.weight(speed) < 0.01) return [];
  return [0, 1, 2, 3].map((k) => strideParams(base, skeleton, { ...motion, phase: (k * Math.PI) / 2 }, weight));
}
