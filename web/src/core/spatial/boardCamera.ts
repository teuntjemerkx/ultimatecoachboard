// Port of Spatial/BoardCamera.swift (with `BoardCamera.pose` of CameraPose.swift).
import type { FloorPoint } from "../match/court";
import { CameraPose } from "./cameraPose";
import { Mat4, V3 } from "./math3d";

/**
 * The board camera (Sections 3.1 and 3.2): an orbit around a target on the floor. The 2D blueprint view is the same
 * camera looking straight down with a very narrow field of view, so 2D and 3D share one renderer and the transition
 * between them is a dolly-zoom.
 */
export class BoardCamera {
  /** Point on the floor the camera looks at. */
  readonly target: V3;
  /** Horizontal direction from the target toward the eye, radians from world +X toward +Z (0 = home bench view). */
  readonly heading: number;
  /** Elevation of the eye above the floor plane, radians (pi/2 = straight down). */
  readonly pitch: number;
  readonly distance: number;
  readonly fovY: number;

  constructor(init: { target?: V3; heading?: number; pitch?: number; distance: number; fovY: number }) {
    this.target = init.target ?? V3.zero;
    this.heading = init.heading ?? 0;
    this.pitch = init.pitch ?? Math.PI / 2;
    this.distance = init.distance;
    this.fovY = init.fovY;
  }

  /** A copy with some fields changed (Swift `var c = self; c.x = ...`). */
  with(changes: Partial<{ target: V3; heading: number; pitch: number; distance: number; fovY: number }>): BoardCamera {
    return new BoardCamera({
      target: changes.target ?? this.target,
      heading: changes.heading ?? this.heading,
      pitch: changes.pitch ?? this.pitch,
      distance: changes.distance ?? this.distance,
      fovY: changes.fovY ?? this.fovY,
    });
  }

  get horizontal(): V3 {
    return new V3(Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  get eye(): V3 {
    return this.target.add(this.horizontal.mul(Math.cos(this.pitch)).add(V3.up.mul(Math.sin(this.pitch))).mul(this.distance));
  }

  /** The camera's up vector, perpendicular to the view direction; straight down it points away from the viewer. */
  get upVector(): V3 {
    return this.horizontal.mul(-Math.sin(this.pitch)).add(V3.up.mul(Math.cos(this.pitch))).normalized;
  }

  get view(): Mat4 {
    return Mat4.lookAt(this.eye, this.target, this.upVector);
  }

  /** Near and far planes bracketing the court and its surroundings at this distance. */
  get depthRange(): { near: number; far: number } {
    return { near: Math.max(0.25, this.distance - 40), far: this.distance + 40 };
  }

  projection(aspect: number): Mat4 {
    const r = this.depthRange;
    return Mat4.perspective(this.fovY, aspect, r.near, r.far);
  }

  viewProjection(aspect: number): Mat4 {
    return this.projection(aspect).mul(this.view);
  }

  /** Height of the visible region in the plane through the target, perpendicular to the view direction. */
  get visibleHeight(): number {
    return 2 * this.distance * Math.tan(this.fovY / 2);
  }

  /** The ray through a point in normalized device coordinates (x, y in -1...1, y up). */
  ray(ndcX: number, ndcY: number, aspect: number): { origin: V3; direction: V3 } {
    const eye = this.eye;
    const forward = this.target.sub(eye).normalized;
    const up = this.upVector;
    const right = forward.cross(up).normalized;
    const h = Math.tan(this.fovY / 2);
    const dir = forward.add(right.mul(ndcX * h * aspect)).add(up.mul(ndcY * h)).normalized;
    return { origin: eye, direction: dir };
  }

  /** Section 3.5.2: the touch ray intersected with the floor, t* = -o_y / u_y (only when the ray points down). */
  floorPoint(ndcX: number, ndcY: number, aspect: number): FloorPoint | undefined {
    const r = this.ray(ndcX, ndcY, aspect);
    if (!(r.direction.y < -1e-9)) return undefined;
    const t = -r.origin.y / r.direction.y;
    return r.origin.add(r.direction.mul(t)).floor;
  }

  /** Projects a world point to normalized device coordinates (x, y in -1...1, y up); undefined behind the camera. */
  project(p: V3, aspect: number): { x: number; y: number; depth: number } | undefined {
    const c = this.viewProjection(aspect).apply(p);
    if (!(c[3] > 1e-9)) return undefined;
    return { x: c[0] / c[3], y: c[1] / c[3], depth: c[2] / c[3] };
  }

  /** This orbit camera as a pose. */
  get pose(): CameraPose {
    const eye = this.eye;
    return CameraPose.looking(eye, this.target.sub(eye).normalized, this.upVector, this.fovY, this.depthRange.near);
  }

  // Presets

  /**
   * The 2D view as a camera: straight down, a 1 degree field of view (practically orthographic), framing
   * `frameWidth` x `frameLength` metres. `vertical` stands the court upright (home at the bottom unless switched).
   */
  static topDown(aspect: number, options: { homeOnLeft?: boolean; vertical?: boolean; frameLength?: number; frameWidth?: number } = {}): BoardCamera {
    const homeOnLeft = options.homeOnLeft ?? true, vertical = options.vertical ?? false;
    const frameLength = options.frameLength ?? 22.8, frameWidth = options.frameWidth ?? 13.8;
    const fov = (1.0 * Math.PI) / 180;
    if (vertical) {
      const neededHeight = Math.max(frameLength, frameWidth / aspect);
      return new BoardCamera({ heading: homeOnLeft ? Math.PI / 2 : -Math.PI / 2, pitch: Math.PI / 2,
        distance: neededHeight / (2 * Math.tan(fov / 2)), fovY: fov });
    }
    // Screen width shows the court length (Z); screen height the width (X).
    const neededHeight = Math.max(frameWidth, frameLength / aspect);
    return new BoardCamera({ heading: homeOnLeft ? 0 : Math.PI, pitch: Math.PI / 2,
      distance: neededHeight / (2 * Math.tan(fov / 2)), fovY: fov });
  }

  /** Heading offset of the bench view toward the home half (from level with the centre line the net is edge-on). */
  static readonly benchOffset = 0.2;

  /** The default 3D view from the home bench: 32 degrees up, 45 degree field of view, turned toward the home half. */
  static bench(aspect: number, options: { homeOnLeft?: boolean; vertical?: boolean } = {}): BoardCamera {
    const homeOnLeft = options.homeOnLeft ?? true, vertical = options.vertical ?? false;
    const fov = (45.0 * Math.PI) / 180;
    if (vertical) {
      // Upright screens: from behind the home end line, 38 degrees up, the court's width across the screen.
      const pitch = (38.0 * Math.PI) / 180;
      const width = 12.5;
      const distance = (width / (2 * Math.tan(fov / 2) * aspect)) * 1.15;
      return new BoardCamera({ target: new V3(0, 0, homeOnLeft ? 1.5 : -1.5), heading: homeOnLeft ? Math.PI / 2 : -Math.PI / 2,
        pitch, distance, fovY: fov });
    }
    const pitch = (32.0 * Math.PI) / 180;
    // Frame the court length across the screen width.
    const width = 20.0, height = width / aspect;
    const distance = (Math.max(height, 9 / 0.9) / (2 * Math.tan(fov / 2))) * 1.05;
    return new BoardCamera({ heading: homeOnLeft ? BoardCamera.benchOffset : Math.PI - BoardCamera.benchOffset, pitch,
      distance, fovY: fov });
  }

  /**
   * The 2D <-> 3D dolly-zoom (Section 3.2): field of view and pose interpolate while the distance keeps the visible
   * height through the target constant. `t` is already eased (critically damped) by the caller.
   */
  static dollyZoom(a: BoardCamera, b: BoardCamera, t0: number): BoardCamera {
    const t = Math.max(0, Math.min(1, t0));
    if (t === 0) return a;
    if (t === 1) return b;
    const fov = Math.exp(Math.log(a.fovY) * (1 - t) + Math.log(b.fovY) * t);
    const visible = a.visibleHeight * (1 - t) + b.visibleHeight * t;
    let dh = b.heading - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    return new BoardCamera({
      target: a.target.add(b.target.sub(a.target).mul(t)),
      heading: a.heading + dh * t,
      pitch: a.pitch + (b.pitch - a.pitch) * t,
      distance: visible / (2 * Math.tan(fov / 2)),
      fovY: fov,
    });
  }

  /** Orbit and dolly from touch gestures; pitch stays between 8 degrees and straight down. */
  orbited(dHeading: number, dPitch: number, zoom: number): BoardCamera {
    return this.with({
      heading: this.heading + dHeading,
      pitch: Math.max((8 * Math.PI) / 180, Math.min(Math.PI / 2, this.pitch + dPitch)),
      distance: Math.max(4, Math.min(80, this.distance / Math.max(zoom, 0.05))),
    });
  }
}

/** Critically damped easing for camera moves (Section 1.6): x(t) = 1 - (1 + w t) e^(-w t), normalized to reach 1. */
export function criticallyDamped(t0: number, omega = 9): number {
  const t = Math.max(0, Math.min(1, t0));
  const raw = 1 - (1 + omega * t) * Math.exp(-omega * t);
  const end = 1 - (1 + omega) * Math.exp(-omega);
  return raw / end;
}
