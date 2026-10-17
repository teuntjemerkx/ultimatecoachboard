// Port of Video/PoseFitting.swift: analysis-by-synthesis posture fitting (Section 4.3). Swift's
// `SkeletonModel.keypoints(_:)` extension is `skeletonKeypoints(skeleton, posed)`.
import type { FloorPoint } from "../match/court";
import { V3, type Rigid } from "../spatial/math3d";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "../spatial/skeleton";
import type { VideoCamera } from "./courtCalibration";
import { BodyKeypoint, PlayerTracker, type Keypoints } from "./playerTracking";
import { Matrix3, wrappedAngle } from "./videoMath";

/**
 * Where the body keypoints sit on a posed skeleton: the 17 joints map directly (the detector's root is our pelvis,
 * its neck our neck joint between the shoulders); nose, eyes and ears are points on the head in front of and beside
 * the head joint.
 */
export function skeletonKeypoints(s: SkeletonModel, posed: readonly Rigid[]): Record<BodyKeypoint, V3> {
  const h = s.metrics.stature;
  const head = posed[Joint.head];
  const j = (joint: Joint) => posed[joint].translation;
  return {
    nose: head.apply(new V3(0, 0.045 * h, 0.07 * h)),
    leftEye: head.apply(new V3(0.017 * h, 0.066 * h, 0.056 * h)),
    rightEye: head.apply(new V3(-0.017 * h, 0.066 * h, 0.056 * h)),
    leftEar: head.apply(new V3(0.05 * h, 0.056 * h, 0.005 * h)),
    rightEar: head.apply(new V3(-0.05 * h, 0.056 * h, 0.005 * h)),
    neck: j(Joint.neck), root: j(Joint.pelvis),
    leftShoulder: j(Joint.lShoulder), rightShoulder: j(Joint.rShoulder),
    leftElbow: j(Joint.lElbow), rightElbow: j(Joint.rElbow),
    leftWrist: j(Joint.lWrist), rightWrist: j(Joint.rWrist),
    leftHip: j(Joint.lHip), rightHip: j(Joint.rHip),
    leftKnee: j(Joint.lKnee), rightKnee: j(Joint.rKnee),
    leftAnkle: j(Joint.lAnkle), rightAnkle: j(Joint.rAnkle),
  };
}

/** A player's fitted body at one frame. */
export interface PoseEstimate {
  posture: Posture;
  /** Facing in radians from +Z toward +X (SkeletonModel's `facing`), in (-pi, pi]. */
  yaw: number;
  /**
   * Feet above their standing contact (metres); 0 when grounded. For an airborne posture this replaces the library's
   * own jump (see `VideoFrame.posedPlayers`).
   */
  jump: number;
  /** 0...1: how much the keypoints support the fit. */
  confidence: number;
}

/** One frame of a track for the pose fitter. */
export interface PoseTrackFrame {
  time: number;
  /** The (smoothed) floor position. */
  floor: FloorPoint;
  /**
   * The detection's own floor point, when the player was seen (`TrackSample.measured`). With these the jump
   * correction re-smooths the path without the airborne frames instead of interpolating the smoothed one.
   */
  measured?: FloorPoint;
  keypoints?: Keypoints;
  /**
   * Web addition: the floor points are where the body's size puts a jumper (`PoseFitter.placeJumpers`), not where the
   * feet do, so they hold in the air too: no take-off-to-landing line replaces them.
   */
  placed?: boolean;
}

/** The fit of a whole track. */
export interface PoseTrackResult {
  estimates: PoseEstimate[];
  /**
   * Where the player stands for `SkeletonModel.pose` (the pelvis over the floor): the feet-based floor points less
   * each posture's foot offset, airborne runs bridged from take-off to landing.
   */
  floor: FloorPoint[];
}

/** Settings of the pose fitter (Swift `PoseFitter.Settings`). */
export interface PoseFitterSettings {
  /** Cost per radian of turning between frames, and the hard limit on turning speed. */
  turnPenalty: number;
  maxTurnRate: number;
  /** Cost of changing posture between frames. */
  switchPenalty: number;
  /** Weak pull toward facing the net, per frame (at 180 degrees off). */
  facingPriorWeight: number;
  /** Keypoints below this confidence are ignored. */
  minConfidence: number;
  /** Cauchy scale of the normalised keypoint error (a fraction of the body height). */
  robustScale: number;
  /** Airborne runs longer than this are not jumps (misclassified) and keep their floor points. */
  maxAirTime: number;
  /**
   * Web addition, placing a body by its size in the picture (`placeBySize`): the keypoints it reads (confidence), how
   * much a body's size at a given distance varies (a fraction: players' statures, and postures the library holds only
   * roughly), how many standard deviations above the floor its feet must be before the size, not the feet, places a
   * jumper (`placeJumper`), and how many for the frames of the same jump, within `jumpSpan` seconds of such a frame
   * (`placeJumpers`).
   */
  sizeConfidence: number;
  sizeSpread: number;
  sizeSigmas: number;
  sizeSigmasInJump: number;
  jumpSpan: number;
}

export const defaultPoseFitterSettings: Readonly<PoseFitterSettings> = {
  turnPenalty: 0.005, maxTurnRate: 4 * Math.PI, switchPenalty: 0.006, facingPriorWeight: 0.0003, minConfidence: 0.05,
  robustScale: 0.1, maxAirTime: 1.5, sizeConfidence: 0.5, sizeSpread: 0.07, sizeSigmas: 2.5, sizeSigmasInJump: 1, jumpSpan: 0.5,
};

/** Where a body's size in the picture puts it (`PoseFitter.placeBySize`). */
export interface SizePlacement {
  /** The pelvis over the floor, as `SkeletonModel.pose` stands a body. */
  floor: FloorPoint;
  /** The floor under the ankles, as a detection's floor point (`PersonDetection.floor`). */
  feet: FloorPoint;
  /** Feet above their standing contact (metres), as `PoseEstimate.jump`; negative when the size puts them below it. */
  jump: number;
  /** One standard deviation of `jump` from how uncertain the size is. */
  sigma: number;
  /** The body's size in the picture over that of the posed model at the floor point it was placed from. */
  scale: number;
}

/** The highest the feet of a jump get (metres); a size that puts them higher is a misreading. */
const highestFeet = 1.2;

/** Costs of every (posture, yaw bin) for one frame, and the weight (0...1) of the frame's evidence. */
class Costs {
  constructor(
    readonly values: Float64Array,
    readonly weight: number,
  ) {}

  /** Bins wrap around. */
  at(p: number, b: number): number {
    const n = PoseFitter.yawBins;
    return this.values[p * n + (((b % n) + n) % n)];
  }
}

/** Inclusive frame index ranges (Swift `ClosedRange<Int>`). */
export type FrameRun = [number, number];

/**
 * Analysis-by-synthesis posture fitting (Section 4.3): every posture of the library at every 15-degree facing is
 * posed, projected through the camera at the player's floor point and compared to the detector's 2D keypoints. The
 * comparison is confidence-weighted, translation-free (centroids aligned, so floor-point error and the jump do not
 * dominate), normalised by the person's pixel height and robust (Cauchy loss) to a wrong keypoint.
 */
export class PoseFitter {
  static readonly yawBins = 24;
  static readonly yawStep = (2 * Math.PI) / PoseFitter.yawBins;
  static readonly postures = Posture.allCases;
  static readonly keypointList = BodyKeypoint.allCases;

  readonly settings: PoseFitterSettings;
  /**
   * Keypoint positions per posture (index in Posture.allCases) and keypoint (index in BodyKeypoint.allCases),
   * standing at the origin facing +Z, airborne postures lifted by their library jump.
   */
  private readonly model: V3[][];
  private readonly libraryJumps: number[];
  /** Midpoint of the ankles relative to the pelvis on the floor, per posture (facing +Z). */
  private readonly footOffset: V3[];

  constructor(readonly stature: number, readonly role = "", settings: Partial<PoseFitterSettings> = {}) {
    this.settings = { ...defaultPoseFitterSettings, ...settings };
    const s = new SkeletonModel(new BodyMetrics(stature));
    const model: V3[][] = [], jumps: number[] = [];
    for (const p of PoseFitter.postures) {
      const params = Posture.params(p, s, role);
      const kp = skeletonKeypoints(s, s.pose(params, { x: 0, z: 0 }, 0));
      model.push(PoseFitter.keypointList.map((k) => kp[k]));
      jumps.push(params.jump);
    }
    this.model = model;
    this.libraryJumps = jumps;
    const la = PoseFitter.keypointList.indexOf("leftAnkle"), ra = PoseFitter.keypointList.indexOf("rightAnkle");
    this.footOffset = model.map((m) => new V3((m[la].x + m[ra].x) / 2, 0, (m[la].z + m[ra].z) / 2));
  }

  /** The posture's own jump in the library (metres). */
  libraryJump(p: Posture): number {
    return this.libraryJumps[PoseFitter.index(p)];
  }

  /** Whether the library poses this posture in the air (attack, block, jump set, jump serve, quick attack ...). */
  isAirborne(p: Posture): boolean {
    return this.libraryJump(p) > 0.02;
  }

  static index(p: Posture): number {
    return PoseFitter.postures.indexOf(p);
  }

  /** The cost table of one frame; undefined with fewer than four usable keypoints or the player behind the camera. */
  private costs(keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera): Costs | undefined {
    const ks: number[] = [], ox: number[] = [], oy: number[] = [], ws: number[] = [];
    PoseFitter.keypointList.forEach((k, i) => {
      const o = keypoints[k];
      if (!o || !(o.confidence >= this.settings.minConfidence)) return;
      ks.push(i);
      ox.push(o.point.x - camera.width / 2);
      oy.push(o.point.y - camera.height / 2);
      ws.push(o.confidence);
    });
    if (ks.length < 4) return undefined;
    let wsum = 0;
    for (const w of ws) wsum += w;
    let mx = 0, my = 0;
    for (let i = 0; i < ks.length; i++) { mx += ws[i] * ox[i]; my += ws[i] * oy[i]; }
    mx /= wsum;
    my /= wsum;
    for (let i = 0; i < ks.length; i++) { ox[i] -= mx; oy[i] -= my; }
    const r = camera.matrix;
    const base = r.apply(V3.fromFloor(floor, 0).sub(camera.center));
    const middle = base.add(r.apply(new V3(0, 0.55 * this.stature, 0))).z;
    if (!(middle > 0.3)) return undefined;
    const f = camera.focalLength;
    const pixelHeight = (f * this.stature) / middle;
    const invS2 = 1 / (pixelHeight * pixelHeight);
    const c2 = this.settings.robustScale * this.settings.robustScale;
    const nk = ks.length, np = PoseFitter.postures.length, nb = PoseFitter.yawBins;
    const values = new Float64Array(np * nb);
    const qx = new Float64Array(nk), qy = new Float64Array(nk);
    const bx = base.x, by = base.y, bz = base.z;
    for (let b = 0; b < nb; b++) {
      const m = r.mul(Matrix3.yaw(b * PoseFitter.yawStep));
      const m0 = m.r0, m1 = m.r1, m2 = m.r2;
      for (let p = 0; p < np; p++) {
        const pts = this.model[p];
        let sx = 0, sy = 0;
        let valid = true;
        for (let i = 0; i < nk; i++) {
          const v = pts[ks[i]];
          const cz = bz + m2.x * v.x + m2.y * v.y + m2.z * v.z;
          if (cz < 0.05) { valid = false; break; }
          const cx = bx + m0.x * v.x + m0.y * v.y + m0.z * v.z;
          const cy = by + m1.x * v.x + m1.y * v.y + m1.z * v.z;
          qx[i] = (f * cx) / cz;
          qy[i] = (f * cy) / cz;
          sx += ws[i] * qx[i];
          sy += ws[i] * qy[i];
        }
        if (!valid) { values[p * nb + b] = 1; continue; }
        sx /= wsum;
        sy /= wsum;
        let cost = 0;
        for (let i = 0; i < nk; i++) {
          const ex = qx[i] - sx - ox[i], ey = qy[i] - sy - oy[i];
          const e = (ex * ex + ey * ey) * invS2;
          cost += ws[i] * c2 * Math.log(1 + e / c2);
        }
        values[p * nb + b] = cost / wsum;
      }
    }
    return new Costs(values, Math.min(1, wsum / 8));
  }

  /** The facing of bin b refined by a parabola through the costs of its neighbours. */
  private refinedYaw(c: Costs, p: number, b: number): number {
    const cm = c.at(p, b - 1), c0 = c.at(p, b), cp = c.at(p, b + 1);
    const den = cm - 2 * c0 + cp;
    let delta = den > 1e-15 ? (0.5 * (cm - cp)) / den : 0;
    delta = Math.max(-0.5, Math.min(0.5, delta));
    return wrappedAngle((b + delta) * PoseFitter.yawStep);
  }

  private confidence(c: Costs, best: number): number {
    return c.weight / (1 + best / 0.004);
  }

  /** The best posture and facing for one frame, with a jump estimate for airborne postures. Undefined without at least four keypoints. */
  fit(keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera): PoseEstimate | undefined {
    const c = this.costs(keypoints, floor, camera);
    if (!c) return undefined;
    let best = { cost: Infinity, p: 0, b: 0 };
    for (let p = 0; p < PoseFitter.postures.length; p++) {
      for (let b = 0; b < PoseFitter.yawBins; b++) if (c.at(p, b) < best.cost) best = { cost: c.at(p, b), p, b };
    }
    const posture = PoseFitter.postures[best.p];
    const yaw = this.refinedYaw(c, best.p, best.b);
    const jump = this.isAirborne(posture)
      ? (this.estimateJump(posture, yaw, keypoints, floor, camera) ?? this.libraryJump(posture))
      : 0;
    return { posture, yaw, jump, confidence: this.confidence(c, best.cost) };
  }

  /**
   * The jump of an airborne posture: for the ankles (else knees, else hips), the height of their pixel above the floor
   * point where the posed body puts them (`VideoCamera.heightAbove`), minus their height in the posture standing on the
   * floor. Undefined without any leg keypoint.
   */
  estimateJump(posture: Posture, yaw: number, keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera): number | undefined {
    const p = PoseFitter.index(posture);
    const rot = Matrix3.yaw(yaw);
    const groups: BodyKeypoint[][] = [["leftAnkle", "rightAnkle"], ["leftKnee", "rightKnee"], ["leftHip", "rightHip", "root"]];
    for (const group of groups) {
      let sum = 0, wsum = 0;
      for (const k of group) {
        const o = keypoints[k];
        if (!o || !(o.confidence >= this.settings.minConfidence)) continue;
        const v = this.model[p][PoseFitter.keypointList.indexOf(k)];
        const offset = rot.apply(new V3(v.x, 0, v.z));
        const h = camera.heightAbove(o.point, { x: floor.x + offset.x, z: floor.z + offset.z });
        if (h === undefined) continue;
        sum += o.confidence * (h - (v.y - this.libraryJumps[p]));
        wsum += o.confidence;
      }
      if (wsum > 0) return Math.max(0, sum / wsum);
    }
    return undefined;
  }

  /**
   * Web addition: where the body's size in the picture puts the player along the viewing ray of the legs. The posture
   * at that facing, posed at `floor`, is projected and scaled onto the confident keypoints (`sizeConfidence`, at least
   * six, head and legs among them); a body s times the model's size stands at 1/s of its depth (`expected` is the size a
   * body shows where its feet are, e.g. a clip's own, see `sizeBaseline`). The ankles (else knees) are then on their
   * ray at that depth: their height less the posture's standing height is the jump, the floor under them the place.
   * The jump's sigma is the size's (`sizeSpread`, and two pixels of keypoint noise over the body's height) times the
   * camera's height above the legs: along a ray a fraction e nearer, a point is e of that higher. Undefined without the
   * keypoints for it.
   */
  placeBySize(posture: Posture, yaw: number, keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera, expected = 1):
    SizePlacement | undefined {
    const p = PoseFitter.index(posture);
    const r = camera.matrix, m = r.mul(Matrix3.yaw(yaw));
    const base = r.apply(V3.fromFloor(floor, 0).sub(camera.center));
    const f = camera.focalLength, least = this.settings.sizeConfidence;
    const ox: number[] = [], oy: number[] = [], qx: number[] = [], qy: number[] = [], qz: number[] = [], ws: number[] = [];
    let head = false, legs = false;
    PoseFitter.keypointList.forEach((k, i) => {
      const o = keypoints[k];
      if (!o || !(o.confidence >= least)) return;
      const c = base.add(m.apply(this.model[p][i]));
      if (!(c.z > 0.3)) return;
      ox.push(o.point.x);
      oy.push(o.point.y);
      qx.push((f * c.x) / c.z);
      qy.push((f * c.y) / c.z);
      qz.push(c.z);
      ws.push(o.confidence);
      if (PoseFitter.headKeypoints.has(k)) head = true;
      if (PoseFitter.legKeypoints.has(k)) legs = true;
    });
    if (ws.length < 6 || !head || !legs) return undefined;
    let w = 0, mox = 0, moy = 0, mqx = 0, mqy = 0, mz = 0;
    for (let i = 0; i < ws.length; i++) {
      w += ws[i];
      mox += ws[i] * ox[i];
      moy += ws[i] * oy[i];
      mqx += ws[i] * qx[i];
      mqy += ws[i] * qy[i];
      mz += ws[i] * qz[i];
    }
    mox /= w;
    moy /= w;
    mqx /= w;
    mqy /= w;
    mz /= w;
    // Least-squares scale of the model's layout onto the keypoints', both about their centroids.
    let num = 0, den = 0, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < ws.length; i++) {
      const ax = qx[i] - mqx, ay = qy[i] - mqy;
      num += ws[i] * (ax * (ox[i] - mox) + ay * (oy[i] - moy));
      den += ws[i] * (ax * ax + ay * ay);
      top = Math.min(top, oy[i]);
      bottom = Math.max(bottom, oy[i]);
    }
    if (!(den > 0) || !(num > 0)) return undefined;
    const scale = num / den;
    const depth = (mz * expected) / scale;
    const spread = Math.hypot(this.settings.sizeSpread, 2 / Math.max(bottom - top, 1));
    const rot = Matrix3.yaw(yaw);
    for (const group of PoseFitter.legGroups) {
      let sx = 0, sy = 0, gw = 0;
      let v = new V3(0, 0, 0);
      for (const k of group) {
        const o = keypoints[k];
        if (!o || !(o.confidence >= least)) continue;
        sx += o.confidence * o.point.x;
        sy += o.confidence * o.point.y;
        gw += o.confidence;
        v = v.add(this.model[p][PoseFitter.keypointList.indexOf(k)].mul(o.confidence));
      }
      if (!(gw > 0)) continue;
      v = v.mul(1 / gw);
      // The legs' depth: the body's, plus how far the posture holds them in front of or behind its middle.
      const legDepth = depth + base.add(m.apply(v)).z - mz;
      const ray = camera.ray({ x: sx / gw, y: sy / gw });
      const along = ray.direction.dot(camera.forward);
      if (!(legDepth > 0.3) || !(along > 1e-6)) return undefined;
      const point = ray.origin.add(ray.direction.mul(legDepth / along));
      const offset = rot.apply(new V3(v.x, 0, v.z)), feet = rot.apply(this.footOffset[p]);
      const pelvis = { x: point.x - offset.x, z: point.z - offset.z };
      return { floor: pelvis, feet: { x: pelvis.x + feet.x, z: pelvis.z + feet.z }, jump: point.y - (v.y - this.libraryJumps[p]),
        sigma: spread * Math.max(0, camera.center.y - point.y), scale };
    }
    return undefined;
  }

  /**
   * Web addition: a jumper the feet misplace. Seen from a low camera, feet in the air read as a floor point farther
   * along their ray: 0.5 m up, from 2.6 m up, puts a jump server on the OK Hoče clip 3.3 m into the court. The body's
   * size does not move with the feet. So a frame the track's fit holds airborne (`posture`, `yaw`) is placed by its
   * size (`placeBySize`), its posture fitted again there (it was chosen at the feet's floor point, for a body of the
   * wrong size), and placed again: when the feet are then at least `sigmas` of the size's standard deviations above the
   * floor (so the size places the body better than the feet, by as much) and no higher than a jump gets, that
   * placement. `expected` is the size a body shows where its feet are (`standingSize`, `sizeBaseline`).
   */
  placeJumper(posture: Posture, yaw: number, keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera, expected = 1,
    sigmas = this.settings.sizeSigmas): SizePlacement | undefined {
    if (!this.isAirborne(posture) || !this.sizable(keypoints)) return undefined;
    const rough = this.placeBySize(posture, yaw, keypoints, floor, camera, expected);
    if (!rough || !(rough.jump > 0)) return undefined;
    const there = this.fit(keypoints, rough.floor, camera);
    const placed = there && this.placeBySize(there.posture, there.yaw, keypoints, rough.floor, camera, expected);
    if (!placed || !(placed.jump > sigmas * placed.sigma) || !(placed.jump <= highestFeet)) return undefined;
    return placed;
  }

  /**
   * Web addition: a track's frames with each jumper its feet misplace (`placeJumper`, airborne in `estimates`, the
   * track's fit) where the body's size puts it, the detection's floor point and the track's: fitted again, the posture
   * is read there and the jump measured above the floor where the player is (the tracker ran on the feet's floor
   * points, and their leap along the view is how it took them). The size a body shows where its feet are is the
   * player's own when the track stands on the floor in sight often enough (`standingSize`), else `expected`. A frame
   * the size puts `sizeSigmas` up starts a jump; the airborne frames within `jumpSpan` seconds of it need only
   * `sizeSigmasInJump` (the take-off and the landing are lower). Undefined when there is none.
   */
  placeJumpers(frames: readonly PoseTrackFrame[], estimates: readonly PoseEstimate[], camera: VideoCamera, expected = 1):
    PoseTrackFrame[] | undefined {
    const settings = this.settings;
    const size = this.standingSize(frames, estimates, camera) ?? expected;
    const found = frames.map((f, k) => {
      const e = estimates[k];
      return e && f.keypoints && f.measured
        ? this.placeJumper(e.posture, e.yaw, f.keypoints, f.measured, camera, size, settings.sizeSigmasInJump) : undefined;
    });
    const jumps = found.flatMap((p, k) => (p && p.jump > settings.sizeSigmas * p.sigma ? [frames[k].time] : []));
    if (jumps.length === 0) return undefined;
    return frames.map((f, k) => {
      const p = found[k];
      if (!p || !jumps.some((t) => Math.abs(t - f.time) <= settings.jumpSpan)) return f;
      return { ...f, floor: p.feet, measured: p.feet, placed: true };
    });
  }

  /**
   * Web addition: the size a track's body shows where its feet are, for `placeBySize`: the median scale over its frames
   * standing in sight (grounded posture in `estimates`, ankles seen) when there are at least three; else undefined.
   */
  standingSize(frames: readonly PoseTrackFrame[], estimates: readonly PoseEstimate[], camera: VideoCamera): number | undefined {
    const scales = frames.flatMap((f, k) => {
      const e = estimates[k];
      const scale = e && f.keypoints && f.measured ? this.standingScale(f.keypoints, f.measured, camera, e) : undefined;
      return scale === undefined ? [] : [scale];
    });
    return scales.length >= 3 ? PoseFitter.median(scales) : undefined;
  }

  /**
   * Web addition: the size bodies show where their feet are, for `placeBySize`: the median scale of the detections
   * standing on the floor (grounded posture, ankles seen) that the size can place, when there are at least
   * `minCount`; else 1. It takes out what all of a clip's bodies share: a focal length a little off, players shorter or
   * taller than the model.
   */
  sizeBaseline(detections: readonly { floor: FloorPoint; keypoints: Keypoints }[], camera: VideoCamera, minCount = 20): number {
    const scales = detections.flatMap((d) => {
      const scale = this.standingScale(d.keypoints, d.floor, camera);
      return scale === undefined ? [] : [scale];
    });
    return scales.length >= minCount ? PoseFitter.median(scales) : 1;
  }

  /**
   * The scale (`placeBySize`) of a body standing at `floor` with its ankles seen, in its posture (`estimate`, else the
   * single frame's fit); undefined when that posture is airborne or the keypoints do not do.
   */
  private standingScale(keypoints: Keypoints, floor: FloorPoint, camera: VideoCamera, estimate?: PoseEstimate): number | undefined {
    const least = this.settings.sizeConfidence;
    if (!this.sizable(keypoints) || !PoseFitter.legGroups[0].some((k) => (keypoints[k]?.confidence ?? 0) >= least)) return undefined;
    const e = estimate ?? this.fit(keypoints, floor, camera);
    if (!e || this.isAirborne(e.posture)) return undefined;
    return this.placeBySize(e.posture, e.yaw, keypoints, floor, camera)?.scale;
  }

  private static median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** Whether the keypoints are enough for `placeBySize`: six confident ones, head and legs among them. */
  private sizable(keypoints: Keypoints): boolean {
    let n = 0, head = false, legs = false;
    for (const k of PoseFitter.keypointList) {
      if (!((keypoints[k]?.confidence ?? 0) >= this.settings.sizeConfidence)) continue;
      n += 1;
      if (PoseFitter.headKeypoints.has(k)) head = true;
      if (PoseFitter.legKeypoints.has(k)) legs = true;
    }
    return n >= 6 && head && legs;
  }

  private static readonly headKeypoints: ReadonlySet<BodyKeypoint> = new Set(["nose", "leftEye", "rightEye", "leftEar", "rightEar"]);
  private static readonly legGroups: readonly (readonly BodyKeypoint[])[] = [["leftAnkle", "rightAnkle"], ["leftKnee", "rightKnee"]];
  private static readonly legKeypoints: ReadonlySet<BodyKeypoint> = new Set(PoseFitter.legGroups.flat());

  /**
   * Fits a whole track with temporal smoothing: a Viterbi pass over facing bins (each bin scored by its best posture,
   * turning costs `turnPenalty` per radian and is limited to `maxTurnRate`), then a Viterbi pass over postures at the
   * chosen facings (`switchPenalty` per change); the facing is refined by a parabola around the chosen bin. Floor
   * points lose the posture's foot offset (they come from the feet; poses stand on the pelvis); airborne runs get the
   * take-off-to-landing line and their jump measured there. `facingPrior` (radians, e.g. toward the net) gently
   * resolves frames without evidence.
   */
  fitTrack(frames: readonly PoseTrackFrame[], camera: VideoCamera, facingPrior?: number): PoseTrackResult {
    const n = frames.length;
    if (n === 0) return { estimates: [], floor: [] };
    const nb = PoseFitter.yawBins, np = PoseFitter.postures.length, step = PoseFitter.yawStep;
    const settings = this.settings;
    const tables = frames.map((f) => (f.keypoints ? this.costs(f.keypoints, f.floor, camera) : undefined));
    // Facing: unary = the frame's best posture at that bin.
    const unary: number[][] = [];
    for (let t = 0; t < n; t++) {
      const row: number[] = [];
      const c = tables[t];
      for (let b = 0; b < nb; b++) {
        let u = 0;
        if (c) {
          let m = Infinity;
          for (let p = 0; p < np; p++) m = Math.min(m, c.at(p, b));
          u = c.weight * m;
        }
        if (facingPrior !== undefined) u += (settings.facingPriorWeight * (1 - Math.cos(b * step - facingPrior))) / 2;
        row.push(u);
      }
      unary.push(row);
    }
    const binDistance = (a: number, b: number) => {
      const d = Math.abs(a - b) % nb;
      return Math.min(d, nb - d);
    };
    const argmin = (xs: readonly number[]) => {
      let k = 0;
      for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i;
      return k;
    };
    const bins = new Array<number>(n).fill(0);
    {
      let score = unary[0];
      const back = Array.from({ length: n }, () => new Array<number>(nb).fill(0));
      for (let t = 1; t < n; t++) {
        const dt = Math.max(frames[t].time - frames[t - 1].time, 1e-3);
        const limit = settings.maxTurnRate * dt + step;
        const next = new Array<number>(nb).fill(0);
        for (let b = 0; b < nb; b++) {
          let best = Infinity, from = 0;
          for (let a = 0; a < nb; a++) {
            const angle = binDistance(a, b) * step;
            let c = score[a] + settings.turnPenalty * angle;
            if (angle > limit) c += 1 + (angle - limit);
            if (c < best) { best = c; from = a; }
          }
          next[b] = best + unary[t][b];
          back[t][b] = from;
        }
        score = next;
      }
      let b = argmin(score);
      for (let t = n - 1; t >= 0; t--) {
        bins[t] = b;
        if (t > 0) b = back[t][b];
      }
    }
    // Postures at the chosen facings.
    const postureIndex = new Array<number>(n).fill(0);
    {
      // Without evidence a frame prefers the ready posture slightly, so an unseen track is not arbitrary.
      const ready = PoseFitter.index("ready");
      const unaryP = (t: number, p: number) => {
        const c = tables[t];
        return (c ? c.weight * c.at(p, bins[t]) : 0) + (!c && p !== ready ? 1e-6 : 0);
      };
      let score = Array.from({ length: np }, (_, p) => unaryP(0, p));
      const back = Array.from({ length: n }, () => new Array<number>(np).fill(0));
      for (let t = 1; t < n; t++) {
        const next = new Array<number>(np).fill(0);
        let bestPrev = Infinity, bestFrom = 0;
        for (let a = 0; a < np; a++) if (score[a] < bestPrev) { bestPrev = score[a]; bestFrom = a; }
        for (let p = 0; p < np; p++) {
          const stay = score[p], move = bestPrev + settings.switchPenalty;
          if (stay <= move) { next[p] = stay; back[t][p] = p; } else { next[p] = move; back[t][p] = bestFrom; }
          next[p] += unaryP(t, p);
        }
        score = next;
      }
      let p = argmin(score);
      for (let t = n - 1; t >= 0; t--) {
        postureIndex[t] = p;
        if (t > 0) p = back[t][p];
      }
    }
    const estimates: PoseEstimate[] = [];
    for (let t = 0; t < n; t++) {
      const p = postureIndex[t];
      const c = tables[t];
      let yaw: number, conf = 0;
      if (c) {
        yaw = this.refinedYaw(c, p, bins[t]);
        conf = this.confidence(c, c.at(p, bins[t]));
      } else {
        yaw = wrappedAngle(bins[t] * step);
      }
      estimates.push({ posture: PoseFitter.postures[p], yaw, jump: 0, confidence: conf });
    }
    // Floor points come from the feet; SkeletonModel stands the pelvis on its position, so each grounded frame loses
    // its posture's foot offset (up to 0.3 m in a lunge). Jumps: a straight floor path through the air, then the
    // measured height. With raw measurements the path is re-smoothed from the corrected ones without the airborne
    // frames (the tracker's smoothed path has their bias smeared into take-off and landing).
    const airborne = estimates.map((e) => this.isAirborne(e.posture));
    const times = frames.map((f) => f.time);
    // Web addition: a jumper placed by its size stands where it is in the air too (`PoseTrackFrame.placed`).
    const offFloor = airborne.map((a, t) => a && frames[t].placed !== true);
    const root = (feet: FloorPoint, t: number): FloorPoint => {
      if (offFloor[t]) return feet;
      const o = Matrix3.yaw(estimates[t].yaw).apply(this.footOffset[postureIndex[t]]);
      return { x: feet.x - o.x, z: feet.z - o.z };
    };
    const floor = PoseFitter.correctAirborneFloor(frames.map((f, k) => root(f.floor, k)), times, offFloor, settings.maxAirTime);
    const runs = PoseFitter.airborneRuns(times, offFloor, settings.maxAirTime);
    let first = -1, last = -1;
    frames.forEach((f, k) => { if (f.measured) { if (first < 0) first = k; last = k; } });
    if (first >= 0 && first < last) {
      const kept = frames.map((f, k) => (f.measured ? root(f.measured, k) : undefined));
      for (const [lo, hi] of runs) for (let k = lo; k <= hi; k++) kept[k] = undefined;
      const path = PlayerTracker.smoothedPath(times.slice(first, last + 1), kept.slice(first, last + 1));
      if (path.length === last - first + 1) {
        // Inside the observed span the re-smoothed path; outside it the ends hold.
        for (let k = 0; k < n; k++) floor[k] = path[Math.min(Math.max(k, first), last) - first];
      }
    }
    // Jump heights where the keypoints show them; frames of a jump without keypoints interpolate their neighbours in
    // the same run, a run without any falls back to the library's jump.
    const measuredJump: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined);
    for (let t = 0; t < n; t++) {
      if (!airborne[t]) continue;
      const e = estimates[t], kp = frames[t].keypoints;
      measuredJump[t] = kp ? this.estimateJump(e.posture, e.yaw, kp, floor[t], camera) : undefined;
    }
    let i = 0;
    while (i < n) {
      if (!airborne[i]) { i += 1; continue; }
      let j = i;
      while (j + 1 < n && airborne[j + 1]) j += 1;
      const known: number[] = [];
      for (let k = i; k <= j; k++) if (measuredJump[k] !== undefined) known.push(k);
      for (let t = i; t <= j; t++) {
        const m = measuredJump[t];
        if (m !== undefined) { estimates[t].jump = m; continue; }
        let before: number | undefined, after: number | undefined;
        for (const k of known) { if (k < t) before = k; }
        for (const k of known) { if (k > t) { after = k; break; } }
        if (before !== undefined && after !== undefined) {
          const u = (times[t] - times[before]) / Math.max(times[after] - times[before], 1e-9);
          estimates[t].jump = measuredJump[before]! + (measuredJump[after]! - measuredJump[before]!) * u;
        } else if (before !== undefined) estimates[t].jump = measuredJump[before]!;
        else if (after !== undefined) estimates[t].jump = measuredJump[after]!;
        else estimates[t].jump = this.libraryJump(estimates[t].posture);
      }
      i = j + 1;
    }
    return { estimates, floor };
  }

  /**
   * During a jump the feet are in the air, so a floor point taken from them is wrong (it slides away from the camera).
   * Every airborne run is replaced by linear interpolation in time between the last grounded point before it
   * (take-off) and the first after it (landing): constant horizontal velocity in flight. A run at the start or end of
   * the track holds its one grounded neighbour; runs longer than `maxAirTime` are left alone.
   */
  static correctAirborneFloor(floor: readonly FloorPoint[], times: readonly number[], airborne: readonly boolean[],
    maxAirTime = 1.5): FloorPoint[] {
    const out = [...floor];
    const n = Math.min(floor.length, times.length, airborne.length);
    for (const [lo, hi] of PoseFitter.airborneRuns(times, airborne, maxAirTime)) {
      const before = lo > 0 ? lo - 1 : undefined, after = hi + 1 < n ? hi + 1 : undefined;
      for (let k = lo; k <= hi; k++) {
        if (before !== undefined && after !== undefined) {
          const u = (times[k] - times[before]) / Math.max(times[after] - times[before], 1e-9);
          out[k] = { x: floor[before].x + (floor[after].x - floor[before].x) * u, z: floor[before].z + (floor[after].z - floor[before].z) * u };
        } else if (before !== undefined) out[k] = floor[before];
        else if (after !== undefined) out[k] = floor[after];
      }
    }
    return out;
  }

  /** Maximal runs of airborne frames whose span from take-off to landing is at most `maxAirTime` (longer runs are a misreading, not a jump). */
  static airborneRuns(times: readonly number[], airborne: readonly boolean[], maxAirTime: number): FrameRun[] {
    const n = Math.min(times.length, airborne.length);
    const runs: FrameRun[] = [];
    let i = 0;
    while (i < n) {
      if (!airborne[i]) { i += 1; continue; }
      let j = i;
      while (j + 1 < n && airborne[j + 1]) j += 1;
      const start = i > 0 ? times[i - 1] : times[i], end = j + 1 < n ? times[j + 1] : times[j];
      if (end - start <= maxAirTime) runs.push([i, j]);
      i = j + 1;
    }
    return runs;
  }

  /**
   * Postures that 2D keypoints cannot tell apart reliably, for evaluating fits: their keypoint layouts differ by under
   * about 4% of the body height at the best facing (measured on the library), which is what 3 px of noise on a 150 px
   * player amounts to. Not transitive across groups; each posture is equivalent to itself.
   */
  static equivalent(a: Posture, b: Posture): boolean {
    return a === b || PoseFitter.equivalenceGroups.some((g) => g.has(a) && g.has(b));
  }

  static readonly equivalenceGroups: readonly ReadonlySet<Posture>[] = [
    new Set<Posture>(["ready", "readyHigh", "lowDefence"]),
    new Set<Posture>(["lowDefence", "cover"]),
    new Set<Posture>(["blockReady", "blockLanding"]),
    new Set<Posture>(["set", "overheadPass", "backSet", "jumpSet"]),
    new Set<Posture>(["attack", "jumpServe", "quickAttack", "floatServe"]),
  ];
}
