// Port of Video/CourtCalibration.swift: the phone camera of a rally video and its calibration from court marks
// (Section 4.1). `VideoCamera.normalizedProjection` (Environment.swift) is a getter of the class here.
import { CourtFrame, type FloorPoint, type Side } from "../match/court";
import { CameraPose } from "../spatial/cameraPose";
import { Quat, V3 } from "../spatial/math3d";
import { ImagePoint, LevenbergMarquardt, LinearAlgebra, Matrix3 } from "./videoMath";

/** The Swift Codable shape of a camera. */
export interface VideoCameraJSON {
  focalLength: number;
  width: number;
  height: number;
  rotation: { x: number; y: number; z: number; w: number };
  center: { x: number; y: number; z: number };
}

/**
 * The phone camera of a rally video (Section 4.1): an ideal pinhole with square pixels, no skew and the principal
 * point at the image centre. Internally the computer-vision convention: camera +Z looks forward, +X is image right,
 * +Y image down. Pixels have their origin at the top-left corner.
 *
 * A world point P projects to `u = f x / z + width / 2`, `v = f y / z + height / 2` with `(x, y, z) = R (P - C)`.
 */
export class VideoCamera {
  /** Focal length in pixels. */
  readonly focalLength: number;
  /** Image size in pixels. */
  readonly width: number;
  readonly height: number;
  /** World to camera rotation R (computer-vision axes: x right, y down, z forward). */
  readonly rotation: Quat;
  /** Camera centre C in world metres. */
  readonly center: V3;

  /** `normalize` false keeps the rotation as given (decoding, like Swift's synthesized Decodable). */
  constructor(focalLength: number, width: number, height: number, rotation: Quat, center: V3, normalize = true) {
    this.focalLength = focalLength;
    this.width = width;
    this.height = height;
    this.rotation = normalize ? rotation.normalized : rotation;
    this.center = center;
  }

  /**
   * A camera at `center` looking at `target` with the image upright (world +Y up), then rolled about its optical axis
   * by `roll` radians (positive turns the picture counter-clockwise).
   */
  static lookingAt(center: V3, target: V3, focalLength: number, width: number, height: number, roll = 0): VideoCamera {
    const f = target.sub(center).normalized;
    let r = f.cross(V3.up);
    if (r.length < 1e-9) r = new V3(1, 0, 0);
    r = r.normalized;
    let d = f.cross(r);
    if (roll !== 0) {
      const c = Math.cos(roll), s = Math.sin(roll);
      [r, d] = [r.mul(c).add(d.mul(s)), d.mul(c).sub(r.mul(s))];
    }
    return new VideoCamera(focalLength, width, height, Matrix3.rows(r, d, f).quat, center);
  }

  get matrix(): Matrix3 {
    return Matrix3.fromQuat(this.rotation);
  }

  /** The principal point (image centre). */
  get principalPoint(): ImagePoint {
    return { x: this.width / 2, y: this.height / 2 };
  }

  /** Vertical and horizontal fields of view in radians. */
  get fovY(): number {
    return 2 * Math.atan(this.height / (2 * this.focalLength));
  }
  get fovX(): number {
    return 2 * Math.atan(this.width / (2 * this.focalLength));
  }

  /** The optical axis in world coordinates. */
  get forward(): V3 {
    return this.rotation.conjugate.rotate(new V3(0, 0, 1));
  }

  /** Camera coordinates (x right, y down, z forward) of a world point. */
  cameraCoordinates(p: V3): V3 {
    return this.rotation.rotate(p.sub(this.center));
  }

  /**
   * The pixel of a world point, or undefined when it is behind (or within 1 mm of) the camera. The pixel may lie
   * outside the image; see `contains`.
   */
  project(p: V3): ImagePoint | undefined {
    const c = this.cameraCoordinates(p);
    if (!(c.z > 1e-3)) return undefined;
    return { x: (this.focalLength * c.x) / c.z + this.width / 2, y: (this.focalLength * c.y) / c.z + this.height / 2 };
  }

  /** Whether a pixel lies inside the image, shrunk by `margin` pixels on each side. */
  contains(px: ImagePoint, margin = 0): boolean {
    return px.x >= margin && px.y >= margin && px.x <= this.width - margin && px.y <= this.height - margin;
  }

  /** The viewing ray through a pixel: from the camera centre, unit direction in world coordinates. */
  ray(px: ImagePoint): { origin: V3; direction: V3 } {
    const d = new V3((px.x - this.width / 2) / this.focalLength, (px.y - this.height / 2) / this.focalLength, 1);
    return { origin: this.center, direction: this.rotation.conjugate.rotate(d).normalized };
  }

  /**
   * The floor point seen at a pixel: the viewing ray intersected with the horizontal plane y = `height` (0 for the
   * floor, about 0.08 for an ankle). Undefined when the ray does not reach that plane in front of the camera.
   */
  floorPoint(px: ImagePoint, height = 0): FloorPoint | undefined {
    const r = this.ray(px);
    if (!(Math.abs(r.direction.y) > 1e-9)) return undefined;
    const t = (height - r.origin.y) / r.direction.y;
    if (!(t > 1e-6)) return undefined;
    return r.origin.add(r.direction.mul(t)).floor;
  }

  /**
   * The height at which the pixel's viewing ray passes closest to the vertical line through `floor`: how high above
   * that floor point the pixel's body part is (jump height, stature). Undefined for a ray parallel to the line or
   * meeting it behind the camera. Swift `height(of:above:)`.
   */
  heightAbove(px: ImagePoint, floor: FloorPoint): number | undefined {
    const r = this.ray(px);
    const w0 = r.origin.sub(V3.fromFloor(floor, 0));
    const b = r.direction.y;
    const denom = 1 - b * b;
    if (!(denom > 1e-9)) return undefined;
    const dw = r.direction.dot(w0), ew = w0.y;
    const t = (b * ew - dw) / denom;
    if (!(t > 0)) return undefined;
    return (ew - b * dw) / denom;
  }

  /**
   * The same camera as a renderer pose (camera to world, looking along -Z with +Y up), vertical field of view
   * 2 atan(h / 2f), near plane 0.05 m. Rendering with aspect width / height reproduces the video's projection.
   */
  get cameraPose(): CameraPose {
    const inv = this.rotation.conjugate;
    const right = inv.rotate(new V3(1, 0, 0)), up = inv.rotate(new V3(0, -1, 0)), back = inv.rotate(new V3(0, 0, -1));
    return new CameraPose(this.center, Quat.fromBasis(right, up, back), this.fovY, 0.05);
  }

  /** Root-mean-square reprojection error in pixels; infinity when a point is behind the camera. */
  reprojectionRMS(points: readonly CalibrationPoint[]): number {
    if (points.length === 0) return 0;
    let sum = 0;
    for (const p of points) {
      const q = this.project(p.world);
      if (!q) return Infinity;
      const dx = q.x - p.image.x, dy = q.y - p.image.y;
      sum += dx * dx + dy * dy;
    }
    return Math.sqrt(sum / points.length);
  }

  /**
   * The 3 x 4 matrix taking homogeneous world points to normalised frame coordinates (u, v in 0...1, v down) before
   * the perspective divide, row-major: diag(f / w, f / h, 1) with the principal point at 0.5, times [R | -R C]. This
   * is what a shader needs to texture world geometry from the video or the clean plate (Environment.swift).
   */
  get normalizedProjection(): number[] {
    const r = this.matrix;
    const t = r.apply(this.center).neg();
    const k0 = new V3(this.focalLength / this.width, 0, 0.5), k1 = new V3(0, this.focalLength / this.height, 0.5), k2 = new V3(0, 0, 1);
    const out: number[] = [];
    for (const k of [k0, k1, k2]) {
      const row = r.transpose.apply(k); // k^T R as a column
      out.push(row.x, row.y, row.z, k.dot(t));
    }
    return out;
  }

  /** The same camera for a frame of another size (same aspect): the focal length scales with the width. */
  scaled(width: number, height: number): VideoCamera {
    const s = width / Math.max(this.width, 1);
    return new VideoCamera(this.focalLength * s, width, height, this.rotation, this.center);
  }

  encode(): VideoCameraJSON {
    const q = this.rotation, c = this.center;
    return { focalLength: this.focalLength, width: this.width, height: this.height,
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, center: { x: c.x, y: c.y, z: c.z } };
  }

  static decode(j: VideoCameraJSON): VideoCamera {
    return new VideoCamera(j.focalLength, j.width, j.height, new Quat(j.rotation.x, j.rotation.y, j.rotation.z, j.rotation.w),
      new V3(j.center.x, j.center.y, j.center.z), false);
  }
}

/**
 * Named court marks with known world positions (Section 4.1). Left and right are as seen by the home team facing the
 * net: left is -X, right is +X, on both halves (so `opponentEndLeft` is the far corner on the home team's left).
 */
export type CourtLandmark =
  | "homeEndLeft" | "homeEndRight" | "opponentEndLeft" | "opponentEndRight"
  /** Where the centre line meets the sidelines (under the net). */
  | "centerLineLeft" | "centerLineRight"
  /** Attack-line ends, 3 m from the net. */
  | "homeAttackLeft" | "homeAttackRight" | "opponentAttackLeft" | "opponentAttackRight"
  /** Top of the net tape at the antennas. */
  | "netTapeLeft" | "netTapeRight"
  /** Antenna tops, 0.8 m above the tape. */
  | "antennaTopLeft" | "antennaTopRight";

export const CourtLandmark = {
  allCases: [
    "homeEndLeft", "homeEndRight", "opponentEndLeft", "opponentEndRight", "centerLineLeft", "centerLineRight",
    "homeAttackLeft", "homeAttackRight", "opponentAttackLeft", "opponentAttackRight", "netTapeLeft", "netTapeRight",
    "antennaTopLeft", "antennaTopRight",
  ] as readonly CourtLandmark[],

  /** World position in metres for a net height (2.43 men, 2.24 women). */
  world(l: CourtLandmark, netHeight = 2.43): V3 {
    const side = l.endsWith("Left") ? -CourtFrame.halfWidth : CourtFrame.halfWidth;
    switch (l) {
      case "homeEndLeft": case "homeEndRight": return new V3(side, 0, 9);
      case "opponentEndLeft": case "opponentEndRight": return new V3(side, 0, -9);
      case "centerLineLeft": case "centerLineRight": return new V3(side, 0, 0);
      case "homeAttackLeft": case "homeAttackRight": return new V3(side, 0, 3);
      case "opponentAttackLeft": case "opponentAttackRight": return new V3(side, 0, -3);
      case "netTapeLeft": case "netTapeRight": return new V3(side, netHeight, 0);
      case "antennaTopLeft": case "antennaTopRight": return new V3(side, netHeight + 0.8, 0);
    }
  },

  isOnFloor(l: CourtLandmark): boolean {
    return !(l.startsWith("netTape") || l.startsWith("antennaTop"));
  },
};

/** A world point and the pixel where it is seen. */
export interface CalibrationPoint {
  world: V3;
  image: ImagePoint;
}

export const CalibrationPoint = {
  make(world: V3, image: ImagePoint): CalibrationPoint {
    return { world, image };
  },
  landmark(l: CourtLandmark, image: ImagePoint, netHeight = 2.43): CalibrationPoint {
    return { world: CourtLandmark.world(l, netHeight), image };
  },
};

/**
 * How far a calibration can be trusted. good: below 2 px RMS at 1080p, camera 0.5-25 m above the floor, vertical
 * field of view 4-120 degrees (from a broadcast telephoto in the stands to a wide phone lens). rough: usable with
 * care, below 6 px RMS at 1080p and a plausible camera.
 */
export type CalibrationQuality = "good" | "rough" | "failed";

export interface CalibrationResult {
  camera: VideoCamera;
  /** Reprojection error over the input points, pixels. */
  rmsError: number;
  quality: CalibrationQuality;
  /** The landmark assignment used, when a wrapper had to choose between left/right orders. */
  points: CalibrationPoint[];
  /** Relative disagreement of the two closed-form focal estimates from the homography (undefined if one was unusable). */
  focalDisagreement?: number;
}

/**
 * Camera calibration from court marks (Section 4.1): homography by normalised DLT, focal length and pose from the
 * homography, then Levenberg-Marquardt over (f, rotation, centre) on every point including off-floor marks.
 */
export const CourtCalibration = {
  /** iPhone main camera, 26 mm equivalent: f is about 0.72 of the image's long side. */
  defaultFocal(width: number, height: number): number {
    return 0.72 * Math.max(width, height);
  },

  /**
   * The plane homography H mapping floor coordinates (X, Z, 1) to pixels (u, v, 1), up to scale, by Hartley-normalised
   * DLT: the eigenvector of the smallest eigenvalue of A^T A. Needs >= 4 points, no three collinear. Returned
   * row-major (9 values) normalised to unit Frobenius norm.
   */
  homography(floor: readonly FloorPoint[], image: readonly ImagePoint[]): number[] | undefined {
    if (floor.length < 4 || floor.length !== image.length) return undefined;
    const normaliser = (p: readonly [number, number][]): Matrix3 | undefined => {
      const n = p.length;
      let mx = 0, my = 0;
      for (const q of p) { mx += q[0]; my += q[1]; }
      mx /= n;
      my /= n;
      let mean = 0;
      for (const q of p) mean += Math.hypot(q[0] - mx, q[1] - my);
      mean /= n;
      if (!(mean > 1e-12)) return undefined;
      const s = Math.SQRT2 / mean;
      return Matrix3.rows(new V3(s, 0, -s * mx), new V3(0, s, -s * my), new V3(0, 0, 1));
    };
    const ts = normaliser(floor.map((p) => [p.x, p.z]));
    const td = normaliser(image.map((p) => [p.x, p.y]));
    const tdInv = td?.inverse;
    if (!ts || !td || !tdInv) return undefined;
    const ata = new Array<number>(81).fill(0);
    for (let k = 0; k < floor.length; k++) {
      const w = floor[k], px = image[k];
      const s = ts.apply(new V3(w.x, w.z, 1)), d = td.apply(new V3(px.x, px.y, 1));
      const x = s.x, y = s.y, u = d.x, v = d.y;
      const rows = [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]];
      for (const row of rows) {
        for (let i = 0; i < 9; i++) {
          if (row[i] === 0) continue;
          for (let j = 0; j < 9; j++) ata[i * 9 + j] += row[i] * row[j];
        }
      }
    }
    const { values, vectors } = LinearAlgebra.symmetricEigen(ata, 9);
    // Degenerate (three collinear points or duplicates): a second near-null direction.
    if (!(values.length === 9 && values[1] > 1e-9 * Math.max(values[8], 1e-300))) return undefined;
    const hn = Matrix3.fromValues(vectors[0]);
    const h = tdInv.mul(hn).mul(ts);
    let norm = 0;
    for (const v of h.values) norm += v * v;
    norm = Math.sqrt(norm);
    if (!(norm > 0) || !Number.isFinite(norm)) return undefined;
    return h.scale(1 / norm).values;
  },

  /**
   * The two closed-form focal estimates of a homography in centred pixel coordinates (K = diag(f, f, 1)): r_X
   * perpendicular to r_Z, and |r_X| = |r_Z|. Each comes with a weight (its conditioning, 0 when unusable).
   */
  focalEstimates(hc: Matrix3, prior: number): { f: number; weight: number }[] {
    const h1 = hc.c0, h2 = hc.c1;
    // Conditioning from the directions with the prior focal: a_z, b_z are the optical-axis components of the court
    // axes; both near zero means the floor is seen face-on and f is not observable from it.
    const a = new V3(h1.x / prior, h1.y / prior, h1.z).normalized, b = new V3(h2.x / prior, h2.y / prior, h2.z).normalized;
    const out: { f: number; weight: number }[] = [];
    const den1 = h1.z * h2.z;
    const w1 = a.z * b.z * (a.z * b.z);
    if (Math.abs(den1) > 1e-300 && w1 > 1e-4) {
      const f2 = -(h1.x * h2.x + h1.y * h2.y) / den1;
      if (f2 > 0) out.push({ f: Math.sqrt(f2), weight: w1 });
    }
    const den2 = h2.z * h2.z - h1.z * h1.z;
    const w2 = (b.z * b.z - a.z * a.z) * (b.z * b.z - a.z * a.z);
    if (Math.abs(den2) > 1e-300 && w2 > 1e-4) {
      const f2 = (h1.x * h1.x + h1.y * h1.y - h2.x * h2.x - h2.y * h2.y) / den2;
      if (f2 > 0) out.push({ f: Math.sqrt(f2), weight: w2 });
    }
    return out;
  },

  /**
   * Rotation and centre from a centred homography and a focal length: lambda = 2 / (|K^-1 h1| + |K^-1 h2|),
   * r_X = lambda K^-1 h1, r_Z = lambda K^-1 h2, r_Y = r_Z x r_X, t = lambda K^-1 h3, R projected onto the nearest
   * rotation, C = -R^T t. The sign of lambda puts the floor points in front of the camera; undefined when they
   * straddle it or the camera ends up below the floor.
   */
  pose(hc: Matrix3, f: number, floor: readonly FloorPoint[]): { r: Matrix3; c: V3 } | undefined {
    const a = new V3(hc.c0.x / f, hc.c0.y / f, hc.c0.z), b = new V3(hc.c1.x / f, hc.c1.y / f, hc.c1.z);
    const c = new V3(hc.c2.x / f, hc.c2.y / f, hc.c2.z);
    const na = a.length, nb = b.length;
    if (!(na > 1e-300 && nb > 1e-300)) return undefined;
    let lambda = 2 / (na + nb);
    const depths = floor.map((p) => a.mul(p.x).add(b.mul(p.z)).add(c).z * lambda);
    const positive = depths.filter((d) => d > 0).length;
    if (positive === 0) lambda = -lambda;
    else if (positive !== depths.length) return undefined;
    const rX = a.mul(lambda), rZ = b.mul(lambda), t = c.mul(lambda);
    const rY = rZ.cross(rX);
    const r = LinearAlgebra.nearestRotation(Matrix3.columns(rX, rY, rZ));
    const center = r.transpose.apply(t).neg();
    if (!(center.y > 0)) return undefined;
    return { r, c: center };
  },

  /**
   * Levenberg-Marquardt over (f, three small-angle rotation parameters applied in the camera frame, C) on the
   * reprojection error of every point, with a weak log-focal prior that only matters when f is unobservable.
   */
  refine(camera: VideoCamera, points: readonly CalibrationPoint[], focalPrior: number, priorWeight: number): VideoCamera | undefined {
    const r0 = camera.matrix;
    const scale = Math.max(1, camera.center.length);
    const make = (x: readonly number[]) => {
      const r = Matrix3.rotation(new V3(x[1], x[2], x[3])).mul(r0);
      return new VideoCamera(x[0], camera.width, camera.height, r.quat, new V3(x[4], x[5], x[6]));
    };
    const x0 = [camera.focalLength, 0, 0, 0, camera.center.x, camera.center.y, camera.center.z];
    const steps = [camera.focalLength * 1e-6, 1e-7, 1e-7, 1e-7, 1e-6 * scale, 1e-6 * scale, 1e-6 * scale];
    const minF = 0.05 * Math.max(camera.width, camera.height);
    const result = LevenbergMarquardt.minimize(x0, steps, (x) => {
      const cam = make(x);
      const r: number[] = [];
      for (const p of points) {
        const c = cam.cameraCoordinates(p.world);
        if (!(c.z > 1e-3)) return undefined;
        r.push((cam.focalLength * c.x) / c.z + cam.width / 2 - p.image.x);
        r.push((cam.focalLength * c.y) / c.z + cam.height / 2 - p.image.y);
      }
      r.push(priorWeight * Math.log(cam.focalLength / focalPrior));
      return r;
    }, { maxIterations: 100, tolerance: 1e-14, clamp: (x) => { const y = [...x]; y[0] = Math.max(minF, y[0]); return y; } });
    return result ? make(result.x) : undefined;
  },

  /**
   * A camera from labelled points: at least four on the floor (y = 0, no three collinear); off-floor points such as
   * the net tape ends join the refinement and break the remaining ambiguity. Undefined when no camera explains the
   * floor points (they straddle the camera, or it would sit below the floor).
   */
  solve(points: readonly CalibrationPoint[], imageWidth: number, imageHeight: number, focalPrior?: number): CalibrationResult | undefined {
    const floor = points.filter((p) => Math.abs(p.world.y) < 1e-6);
    if (floor.length < 4 || !(imageWidth > 0) || !(imageHeight > 0)) return undefined;
    const hv = CourtCalibration.homography(floor.map((p) => p.world.floor), floor.map((p) => p.image));
    if (!hv) return undefined;
    const center = Matrix3.rows(new V3(1, 0, -imageWidth / 2), new V3(0, 1, -imageHeight / 2), new V3(0, 0, 1));
    const hc = center.mul(Matrix3.fromValues(hv));
    const prior = focalPrior ?? CourtCalibration.defaultFocal(imageWidth, imageHeight);
    const estimates = CourtCalibration.focalEstimates(hc, prior);
    let disagreement: number | undefined;
    if (estimates.length === 2) {
      disagreement = Math.abs(estimates[0].f - estimates[1].f) / ((estimates[0].f + estimates[1].f) / 2);
    }
    // Inverse-variance combination of f^2; the prior when neither estimate is usable.
    const starts: number[] = [];
    if (estimates.length > 0) {
      let wsum = 0, f2 = 0;
      for (const e of estimates) { wsum += e.weight; f2 += e.weight * e.f * e.f; }
      starts.push(Math.sqrt(f2 / wsum));
      if (estimates.length === 2) starts.push(...estimates.map((e) => e.f));
    }
    starts.push(prior);
    const longSide = Math.max(imageWidth, imageHeight);
    let best: CalibrationResult | undefined;
    const floorPoints = floor.map((p) => p.world.floor);
    for (const f0 of starts) {
      if (!(f0 > 0.05 * longSide && f0 < 50 * longSide)) continue;
      const pose = CourtCalibration.pose(hc, f0, floorPoints);
      if (!pose) continue;
      const initial = new VideoCamera(f0, imageWidth, imageHeight, pose.r.quat, pose.c);
      const cam = CourtCalibration.refine(initial, points, prior, focalPrior === undefined ? 0.3 : 3);
      if (!cam) continue;
      const rms = cam.reprojectionRMS(points);
      if (!Number.isFinite(rms) || !(cam.center.y > 0)) continue;
      if (!best || rms < best.rmsError - 1e-9) {
        best = { camera: cam, rmsError: rms, quality: CourtCalibration.quality(cam, rms), points: [...points] };
        if (disagreement !== undefined) best.focalDisagreement = disagreement;
      }
    }
    return best;
  },

  /** Quality thresholds scaled to 1080p by the image's short side. */
  quality(cam: VideoCamera, rms: number): CalibrationQuality {
    const scale = Math.min(cam.width, cam.height) / 1080;
    const fov = (cam.fovY * 180) / Math.PI, h = cam.center.y;
    if (rms < 2 * scale && h >= 0.5 && h <= 25 && fov >= 4 && fov <= 120) return "good";
    if (rms < 6 * scale && h >= 0.2 && h <= 40 && fov >= 3 && fov <= 150) return "rough";
    return "failed";
  },

  /**
   * The coach's four dots: the two corners of our (home) end line and the two of their (opponent) end line, each pair
   * in either left/right order. All four assignments are tried; the one with a camera above the floor in front of all
   * points, consistent focal estimates, a plausible field of view and the lowest error wins. `extra` points (e.g. net
   * tape ends) join every candidate.
   */
  solveCorners(ourEnd: readonly ImagePoint[], theirEnd: readonly ImagePoint[], imageWidth: number, imageHeight: number,
    options: { focalPrior?: number; netHeight?: number; extra?: CalibrationPoint[] } = {}): CalibrationResult | undefined {
    return CourtCalibration.solvePairs(ourEnd, ["homeEndLeft", "homeEndRight"], theirEnd, ["opponentEndLeft", "opponentEndRight"],
      imageWidth, imageHeight, options.focalPrior, options.netHeight ?? 2.43, options.extra ?? []);
  },

  /**
   * One half only: its two end-line corners and the two points where the net meets the sidelines on the floor (the
   * centre-line ends), each pair in either left/right order.
   */
  solveNearHalf(endLine: readonly ImagePoint[], netLine: readonly ImagePoint[], half: Side, imageWidth: number, imageHeight: number,
    options: { focalPrior?: number; netHeight?: number; extra?: CalibrationPoint[] } = {}): CalibrationResult | undefined {
    const end: [CourtLandmark, CourtLandmark] = half === "home" ? ["homeEndLeft", "homeEndRight"] : ["opponentEndLeft", "opponentEndRight"];
    return CourtCalibration.solvePairs(endLine, end, netLine, ["centerLineLeft", "centerLineRight"], imageWidth, imageHeight,
      options.focalPrior, options.netHeight ?? 2.43, options.extra ?? []);
  },

  solvePairs(a: readonly ImagePoint[], la: [CourtLandmark, CourtLandmark], b: readonly ImagePoint[], lb: [CourtLandmark, CourtLandmark],
    imageWidth: number, imageHeight: number, focalPrior: number | undefined, netHeight: number,
    extra: readonly CalibrationPoint[]): CalibrationResult | undefined {
    if (a.length !== 2 || b.length !== 2) return undefined;
    let best: { score: number; result: CalibrationResult } | undefined;
    for (const swapA of [false, true]) {
      for (const swapB of [false, true]) {
        const pa = swapA ? [a[1], a[0]] : a, pb = swapB ? [b[1], b[0]] : b;
        const points = [
          CalibrationPoint.landmark(la[0], pa[0], netHeight), CalibrationPoint.landmark(la[1], pa[1], netHeight),
          CalibrationPoint.landmark(lb[0], pb[0], netHeight), CalibrationPoint.landmark(lb[1], pb[1], netHeight), ...extra,
        ];
        const r = CourtCalibration.solve(points, imageWidth, imageHeight, focalPrior);
        if (!r) continue;
        const scale = Math.min(imageWidth, imageHeight) / 1080;
        let score = r.rmsError / scale;
        if (r.focalDisagreement !== undefined && r.focalDisagreement > 0.25) score += 20 * (r.focalDisagreement - 0.25);
        const fov = (r.camera.fovY * 180) / Math.PI;
        if (!(fov >= 4 && fov <= 120)) score += 10;
        if (r.quality === "failed") score += 100;
        if (!best || score < best.score) best = { score, result: r };
      }
    }
    return best?.result;
  },
};
