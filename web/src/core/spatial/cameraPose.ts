// Port of Spatial/CameraPose.swift. `Quat(basisX:y:z:)` is `Quat.fromBasis` and `Mat4.perspectiveReversedZ` lives
// on Mat4 (math3d.ts); `BoardCamera.pose` is on BoardCamera and `SkeletonModel.povPose` on SkeletonModel.
import type { FloorPoint } from "../match/court";
import { Mat4, Quat, V3 } from "./math3d";

/**
 * Any camera of the board as a pose (Sections 3.2 and 5.1): eye position, orientation and field of view. The orbit
 * camera, the top-down view and a player's POV all reduce to this, so every transition is an interpolation of poses.
 */
export class CameraPose {
  readonly eye: V3;
  /** Camera to world: the camera looks along its -Z, up is +Y, right is +X. */
  readonly rotation: Quat;
  readonly fovY: number;
  /** Near plane of the reversed-Z infinite projection (5.1: 0.04 m in POV). */
  readonly near: number;

  constructor(eye: V3, rotation: Quat, fovY: number, near: number) {
    this.eye = eye;
    this.rotation = rotation.normalized;
    this.fovY = fovY;
    this.near = near;
  }

  /** A pose looking along `forward`, with `up` as the up hint (made perpendicular). */
  static looking(eye: V3, forward: V3, up: V3, fovY: number, near: number): CameraPose {
    const back = forward.neg().normalized;
    let right = up.cross(back).normalized;
    if (right.length < 0.5) right = new V3(1, 0, 0).cross(back).normalized;
    const u = back.cross(right);
    return new CameraPose(eye, Quat.fromBasis(right, u, back), fovY, near);
  }

  get forward(): V3 {
    return this.rotation.rotate(new V3(0, 0, -1));
  }
  get up(): V3 {
    return this.rotation.rotate(new V3(0, 1, 0));
  }
  get right(): V3 {
    return this.rotation.rotate(new V3(1, 0, 0));
  }

  get view(): Mat4 {
    return Mat4.lookAt(this.eye, this.eye.add(this.forward), this.up);
  }

  projection(aspect: number): Mat4 {
    return Mat4.perspectiveReversedZ(this.fovY, aspect, this.near);
  }

  viewProjection(aspect: number): Mat4 {
    return this.projection(aspect).mul(this.view);
  }

  /** The ray through a point in normalized device coordinates (x, y in -1...1, y up). */
  ray(ndcX: number, ndcY: number, aspect: number): { origin: V3; direction: V3 } {
    const h = Math.tan(this.fovY / 2);
    return {
      origin: this.eye,
      direction: this.forward.add(this.right.mul(ndcX * h * aspect)).add(this.up.mul(ndcY * h)).normalized,
    };
  }

  /** The touch ray intersected with the floor (Section 3.5.2), or undefined when it does not point down. */
  floorPoint(ndcX: number, ndcY: number, aspect: number): FloorPoint | undefined {
    const r = this.ray(ndcX, ndcY, aspect);
    if (!(r.direction.y < -1e-9)) return undefined;
    return r.origin.add(r.direction.mul(-r.origin.y / r.direction.y)).floor;
  }

  /** A world point in normalized device coordinates; undefined behind the camera. Depth is reversed (1 at near). */
  project(p: V3, aspect: number): { x: number; y: number; depth: number } | undefined {
    const c = this.viewProjection(aspect).apply(p);
    if (!(c[3] > 1e-9)) return undefined;
    return { x: c[0] / c[3], y: c[1] / c[3], depth: c[2] / c[3] };
  }

  /**
   * The fly-in of Section 5.1: the eye follows a quadratic Bezier whose control point is raised `lift` metres above
   * the midpoint, orientation slerps, the field of view eases. `t` is already eased by the caller.
   */
  static flight(a: CameraPose, b: CameraPose, t0: number, lift = 1.0): CameraPose {
    const t = Math.max(0, Math.min(1, t0));
    if (t === 0) return a;
    if (t === 1) return b;
    const control = a.eye.add(b.eye).mul(0.5).add(new V3(0, lift, 0));
    const s = 1 - t;
    const eye = a.eye.mul(s * s).add(control.mul(2 * s * t)).add(b.eye.mul(t * t));
    return new CameraPose(eye, a.rotation.slerp(b.rotation, t), Math.exp(Math.log(a.fovY) * s + Math.log(b.fovY) * t),
      Math.min(a.near, b.near));
  }

  /** Flight time: at least 0.5 s, longer when the turn would exceed 240 degrees per second. */
  static flightDuration(a: CameraPose, b: CameraPose): number {
    const c = Math.min(1, Math.abs(a.rotation.dot(b.rotation)));
    const angle = 2 * Math.acos(c);
    return Math.max(0.5, angle / ((240 * Math.PI) / 180));
  }
}
