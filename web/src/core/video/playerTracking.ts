// Port of Video/PlayerTracking.swift: body keypoints, person detections and multi-player tracking on the floor
// (Section 4.2).
import { CourtFrame, Side, type FloorPoint } from "../match/court";
import { newUUID } from "../spatial/swiftCompat";
import type { VideoCamera } from "./courtCalibration";
import { Hungarian, ImagePoint } from "./videoMath";

/**
 * The body keypoints the reconstruction reads (Apple Vision's joint names; the web app maps MediaPipe's landmarks to
 * them). Left and right are the subject's own.
 */
export type BodyKeypoint =
  | "nose" | "leftEye" | "rightEye" | "leftEar" | "rightEar" | "neck"
  | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftWrist" | "rightWrist"
  | "root" | "leftHip" | "rightHip" | "leftKnee" | "rightKnee" | "leftAnkle" | "rightAnkle";

export const BodyKeypoint = {
  allCases: [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar", "neck",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
    "root", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
  ] as readonly BodyKeypoint[],
};

/** One detected keypoint: its pixel and the detector's confidence (0...1). */
export interface Keypoint2D {
  point: ImagePoint;
  confidence: number;
}

/** Keypoints by name (Swift `[BodyKeypoint: Keypoint2D]`). */
export type Keypoints = Partial<Record<BodyKeypoint, Keypoint2D>>;

/** A person found in one sampled video frame. */
export interface PersonDetection {
  /** Where the person stands, from the feet (see `PersonDetection.fromKeypoints`). */
  floor: FloorPoint;
  /** The foot pixel the floor point came from. */
  footImage: ImagePoint;
  keypoints: Keypoints;
  confidence: number;
  /** Height of the person's bounding box in pixels, when known. */
  boxHeight?: number;
  /**
   * An optional appearance descriptor the app may compute, e.g. the mean jersey colour (r, g, b in 0...1) of the
   * torso. When present the tracker uses it to keep identities apart where players nearly collide.
   */
  appearance?: number[];
}

export const PersonDetection = {
  create(floor: FloorPoint, footImage: ImagePoint, options: { keypoints?: Keypoints; confidence?: number; boxHeight?: number;
    appearance?: number[] } = {}): PersonDetection {
    const d: PersonDetection = { floor, footImage, keypoints: options.keypoints ?? {}, confidence: options.confidence ?? 1 };
    if (options.boxHeight !== undefined) d.boxHeight = options.boxHeight;
    if (options.appearance !== undefined) d.appearance = options.appearance;
    return d;
  },

  /**
   * A detection from body keypoints: the foot pixel is the confidence-weighted midpoint of the ankles, back-projected
   * to ankle height (8 cm); without ankles the shanks are extrapolated from hips and knees; without legs the bottom of
   * the bounding box is used. Undefined when there is nothing to stand on.
   */
  fromKeypoints(keypoints: Keypoints, confidence: number, camera: VideoCamera, options: { boxHeight?: number;
    boxBottom?: ImagePoint; appearance?: number[]; minConfidence?: number } = {}): PersonDetection | undefined {
    const minConfidence = options.minConfidence ?? 0.1;
    const kp = (k: BodyKeypoint): Keypoint2D | undefined => {
      const p = keypoints[k];
      return p && p.confidence >= minConfidence ? p : undefined;
    };
    const mid = (a: Keypoint2D | undefined, b: Keypoint2D | undefined): ImagePoint | undefined => {
      if (a && b) {
        const w = a.confidence + b.confidence;
        return ImagePoint.mul(ImagePoint.add(ImagePoint.mul(a.point, a.confidence), ImagePoint.mul(b.point, b.confidence)), 1 / w);
      }
      if (a) return a.point;
      if (b) return b.point;
      return undefined;
    };
    let foot: ImagePoint | undefined;
    let footHeight = 0.08;
    const ankles = mid(kp("leftAnkle"), kp("rightAnkle"));
    if (ankles) {
      foot = ankles;
    } else {
      const knees = mid(kp("leftKnee"), kp("rightKnee"));
      const hips = knees ? mid(kp("leftHip"), kp("rightHip")) ?? kp("root")?.point : undefined;
      if (knees && hips) {
        foot = ImagePoint.add(knees, ImagePoint.sub(knees, hips));
      } else if (options.boxBottom) {
        foot = options.boxBottom;
        footHeight = 0;
      }
    }
    if (!foot) return undefined;
    const floor = camera.floorPoint(foot, footHeight);
    if (!floor) return undefined;
    return PersonDetection.create(floor, foot, { keypoints, confidence, boxHeight: options.boxHeight, appearance: options.appearance });
  },
};

/**
 * What the app hands over per sampled frame after running the detector: the frame time, the people and the ball
 * pixel. Frames without any person detection (e.g. extra ball-only frames between the pose frames) are not used for
 * player tracking.
 */
export interface VideoFrameObservation {
  /** Seconds from the start of the clip; frames may be spaced unevenly. */
  time: number;
  detections: PersonDetection[];
  ball?: ImagePoint;
}

/** One frame of a tracked player. */
export interface TrackSample {
  time: number;
  /** Smoothed floor position. */
  floor: FloorPoint;
  /** The detection's own floor point when the player was seen in this frame. */
  measured?: FloorPoint;
  footImage?: ImagePoint;
  keypoints?: Keypoints;
  boxHeight?: number;
  /** Not detected in this frame: the position is interpolated. */
  occluded: boolean;
}

/** A player followed through the clip. */
export interface TrackedPlayer {
  id: string;
  side: Side;
  samples: TrackSample[];
}

export const TrackedPlayer = {
  /** Frames in which the player was actually detected. */
  observedCount(p: TrackedPlayer): number {
    return p.samples.filter((s) => !s.occluded).length;
  },
};

/** Settings of the player tracker (Swift `PlayerTracker.Settings`). */
export interface PlayerTrackerSettings {
  /** Detections farther than this beyond the court lines are ignored (coaches, bench, spectators). */
  courtMargin: number;
  /** How far a track may reach under the net into the other half. */
  netTolerance: number;
  /**
   * Highest foot (ankle) height of a jump. A floor point taken from airborne feet lies farther along the camera ray
   * than the player (a blocker's lands behind the net), so with the camera known the side test accepts a detection
   * whose foot ray passes over the track's half anywhere below this height. The pose fitter later replaces airborne
   * floor points (`PoseFitter.fitTrack`).
   */
  maxFootHeight: number;
  /** Physical gate: a player moves at most maxSpeed * dt + gateSlack between detections. */
  maxSpeed: number;
  gateSlack: number;
  maxPlayersPerSide: number;
  /** A track not seen for longer than this stops taking detections (it may still be merged). */
  maxCoast: number;
  /** Fragments are merged across gaps up to this long when their ends are physically consistent. */
  mergeGap: number;
  /** Tracks with fewer detections are dropped as false positives. */
  minDetections: number;
  minConfidence: number;
  /** Detection noise (metres, one sigma) and acceleration noise (m^2/s^3) of the constant-velocity model. */
  measurementNoise: number;
  accelerationNoise: number;
  /** Unmatched detections this close to a matched one are duplicates, not new players. */
  duplicateRadius: number;
  /** Extra assignment cost for a track with fewer than three detections (established tracks win ties). */
  tentativePenalty: number;
  /**
   * Cost of a track missing a frame, against which each pairing's negative log-likelihood is weighed: a well-tracked
   * player (predicted sigma about 0.15 m) rather misses a frame than takes a detection beyond 8 sigma (the apparent
   * motion of a jump is fast). It is the same for every track, so a vague track does not win just because it is vague.
   */
  missGate: number;
  /**
   * Image continuity: cost per squared median keypoint displacement (as a fraction of the person's pixel height)
   * between a track's last detection and a new one, per frame interval of 1/15 s. Tells apart people who are close on
   * the floor but not in the picture (a jumping blocker and the player across the net).
   */
  keypointWeight: number;
  /**
   * Assignment cost per unit of squared appearance distance, and the largest squared distance at which two fragments
   * may still be the same player.
   */
  appearanceWeight: number;
  appearanceMergeLimit: number;
}

export const defaultTrackerSettings: Readonly<PlayerTrackerSettings> = {
  courtMargin: 2, netTolerance: 0.5, maxFootHeight: 1.2, maxSpeed: 8, gateSlack: 0.6, maxPlayersPerSide: 6, maxCoast: 1.0,
  mergeGap: 2.5, minDetections: 4, minConfidence: 0.1, measurementNoise: 0.1, accelerationNoise: 8, duplicateRadius: 0.4,
  tentativePenalty: 3, missGate: 64, keypointWeight: 30, appearanceWeight: 40, appearanceMergeLimit: 0.03,
};

/** A one-axis constant-velocity Kalman state. */
class Axis {
  constructor(
    public p: number,
    public v: number,
    public ppp: number,
    public ppv: number,
    public pvv: number,
  ) {}

  copy(): Axis {
    return new Axis(this.p, this.v, this.ppp, this.ppv, this.pvv);
  }

  predicted(dt: number, q: number): Axis {
    return new Axis(this.p + this.v * dt, this.v,
      this.ppp + 2 * dt * this.ppv + dt * dt * this.pvv + (q * dt * dt * dt) / 3,
      this.ppv + dt * this.pvv + (q * dt * dt) / 2,
      this.pvv + q * dt);
  }

  update(z: number, r: number): void {
    const s = this.ppp + r;
    const kp = this.ppp / s, kv = this.ppv / s;
    const y = z - this.p;
    this.p += kp * y;
    this.v += kv * y;
    const opp = this.ppp, opv = this.ppv, ovv = this.pvv;
    this.ppp = (1 - kp) * opp;
    this.ppv = (1 - kp) * opv;
    this.pvv = ovv - kv * opv;
  }
}

class Work {
  detections: { frame: number; det: PersonDetection }[];
  x: Axis;
  z: Axis;
  lastTime: number;
  /** Running mean of the detections' appearance. */
  appearance?: number[];

  constructor(readonly side: Side, det: PersonDetection, frame: number, time: number, r: number) {
    this.detections = [{ frame, det }];
    this.appearance = det.appearance;
    this.x = new Axis(det.floor.x, 0, r, 0, 9);
    this.z = new Axis(det.floor.z, 0, r, 0, 9);
    this.lastTime = time;
  }

  blendAppearance(a: number[] | undefined): void {
    if (!a) return;
    const m = this.appearance;
    if (!m || m.length !== a.length) {
      this.appearance = a;
      return;
    }
    this.appearance = m.map((v, i) => v + 0.2 * (a[i] - v));
  }

  get position(): FloorPoint {
    return { x: this.x.p, z: this.z.p };
  }
  get firstFrame(): number {
    return this.detections[0].frame;
  }
  get lastFrame(): number {
    return this.detections[this.detections.length - 1].frame;
  }
}

/**
 * Multi-player tracking on the floor (Section 4.2): court gating, sides fixed per track, constant-velocity Kalman
 * prediction, Hungarian assignment (with miss and new-player options) on the detection's likelihood with a physical
 * gate, plus keypoint continuity in the picture and an optional appearance cue; at most six tracks per side
 * (fragments of one player merged, the most persistent kept), gap interpolation and Rauch-Tung-Striebel smoothing.
 */
export class PlayerTracker {
  readonly settings: PlayerTrackerSettings;

  constructor(settings: Partial<PlayerTrackerSettings> = {}) {
    this.settings = { ...defaultTrackerSettings, ...settings };
  }

  /**
   * Median distance between the keypoints two detections share (at least four, confidence 0.2 and up), as a fraction
   * of the first one's height in the picture; undefined when they share too few.
   */
  static keypointDistance(a: Keypoints, b: Keypoints): number | undefined {
    const d: number[] = [];
    let top = Infinity, bottom = -Infinity;
    for (const k of BodyKeypoint.allCases) {
      const p = a[k];
      if (!p || !(p.confidence >= 0.2)) continue;
      top = Math.min(top, p.point.y);
      bottom = Math.max(bottom, p.point.y);
      const q = b[k];
      if (q && q.confidence >= 0.2) d.push(ImagePoint.distance(p.point, q.point));
    }
    if (d.length < 4) return undefined;
    d.sort((x, y) => x - y);
    return d[Math.floor(d.length / 2)] / Math.max(bottom - top, 10);
  }

  private keypointCost(track: Work, d: PersonDetection, dt: number): number {
    if (!(this.settings.keypointWeight > 0)) return 0;
    const last = track.detections[track.detections.length - 1]?.det.keypoints;
    if (!last) return 0;
    const m = PlayerTracker.keypointDistance(last, d.keypoints);
    if (m === undefined) return 0;
    return (this.settings.keypointWeight * m * m) / Math.max(1, dt * 15);
  }

  /** Squared distance between two appearance descriptors (0 when either is missing). */
  static appearanceDistance(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
    if (!a || !b || a.length !== b.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return s;
  }

  private appearanceCost(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
    return this.settings.appearanceWeight * PlayerTracker.appearanceDistance(a, b);
  }

  private onCourt(p: FloorPoint): boolean {
    return Math.abs(p.x) <= CourtFrame.halfWidth + this.settings.courtMargin && Math.abs(p.z) <= 9 + this.settings.courtMargin;
  }

  private allowed(side: Side, d: PersonDetection, camera: VideoCamera | undefined): boolean {
    const zs = [d.floor.z];
    const high = camera?.floorPoint(d.footImage, this.settings.maxFootHeight);
    if (high) zs.push(high.z);
    return side === "home" ? Math.max(...zs) > -this.settings.netTolerance : Math.min(...zs) < this.settings.netTolerance;
  }

  /**
   * Tracks the players through the frames (sorted by time internally; frames without person detections skipped).
   * With the camera, jumping players near the net keep their track (see `maxFootHeight`).
   */
  track(input: readonly VideoFrameObservation[], camera?: VideoCamera): TrackedPlayer[] {
    const settings = this.settings;
    const frames = input.filter((f) => f.detections.length > 0).sort((a, b) => a.time - b.time);
    if (frames.length === 0) return [];
    const times = frames.map((f) => f.time);
    const r = settings.measurementNoise * settings.measurementNoise, q = settings.accelerationNoise;
    const all: Work[] = [];
    frames.forEach((frame, k) => {
      const t = frame.time;
      const dets = frame.detections.filter((d) => d.confidence >= settings.minConfidence && this.onCourt(d.floor));
      const active = all.filter((w) => t - w.lastTime <= settings.maxCoast && w.lastFrame < k);
      const assigned = new Array<boolean>(dets.length).fill(false);
      if (active.length > 0 && dets.length > 0) {
        const forbidden = 1e9;
        // Tracks x detections, augmented so that a track may miss the frame (the miss cost) and a detection may stay
        // unassigned (a new player or clutter, cost 0): a pair wins only when it beats both.
        const nt = active.length, nd = dets.length;
        const cost = Array.from({ length: nt + nd }, () => new Array<number>(nd + nt).fill(forbidden));
        for (let j = 0; j < nd; j++) for (let i = nt; i < nt + nd; i++) cost[i][j] = i - nt === j ? 0 : forbidden;
        for (let i = nt; i < nt + nd; i++) for (let j = nd; j < nd + nt; j++) cost[i][j] = 0;
        active.forEach((tr, i) => {
          const dt = t - tr.lastTime;
          const px = tr.x.predicted(dt, q), pz = tr.z.predicted(dt, q);
          const gate = settings.maxSpeed * dt + settings.gateSlack;
          const sx = px.ppp + r, sz = pz.ppp + r;
          const tentative = tr.detections.length < 3 ? settings.tentativePenalty : 0;
          cost[i][nd + i] = settings.missGate + 2 * Math.log(0.15 * 0.15) + tentative;
          dets.forEach((d, j) => {
            if (!this.allowed(tr.side, d, camera)) return;
            if (!(Math.hypot(d.floor.x - tr.x.p, d.floor.z - tr.z.p) <= gate)) return;
            const ex = d.floor.x - px.p, ez = d.floor.z - pz.p;
            // Negative log-likelihood of the detection under the prediction: the log-determinant keeps a vague
            // (long-coasting or brand-new) track from winning just because it is vague.
            cost[i][j] = (ex * ex) / sx + (ez * ez) / sz + Math.log(sx * sz) + tentative
              + this.appearanceCost(tr.appearance, d.appearance) + this.keypointCost(tr, d, dt);
          });
        });
        const match = Hungarian.solve(cost);
        match.forEach((j, i) => {
          if (i >= nt || j === undefined || j >= nd || !(cost[i][j] < forbidden)) return;
          const tr = active[i];
          const dt = t - tr.lastTime;
          tr.x = tr.x.predicted(dt, q);
          tr.z = tr.z.predicted(dt, q);
          tr.x.update(dets[j].floor.x, r);
          tr.z.update(dets[j].floor.z, r);
          tr.lastTime = t;
          tr.detections.push({ frame: k, det: dets[j] });
          tr.blendAppearance(dets[j].appearance);
          assigned[j] = true;
        });
      }
      const matched = dets.filter((_, j) => assigned[j]).map((d) => d.floor);
      dets.forEach((d, j) => {
        if (assigned[j]) return;
        if (matched.some((m) => Math.hypot(m.x - d.floor.x, m.z - d.floor.z) < settings.duplicateRadius)) return;
        all.push(new Work(CourtFrame.side(d.floor), d, k, t, r));
      });
    });
    let tracks = all.filter((w) => w.detections.length >= settings.minDetections);
    tracks = this.merge(tracks, times);
    // At most six per side: the most persistent.
    const kept: Work[] = [];
    for (const side of Side.allCases) {
      const mine = tracks.filter((w) => w.side === side).sort((a, b) =>
        a.detections.length !== b.detections.length ? b.detections.length - a.detections.length : a.firstFrame - b.firstFrame);
      kept.push(...mine.slice(0, settings.maxPlayersPerSide));
    }
    return kept.map((w) => this.smooth(w, times));
  }

  /**
   * Joins fragments of one player: a track ending before another of the same side starts, with the gap short and the
   * jump between their ends physically possible. Cheapest joins first.
   */
  private merge(input: Work[], times: readonly number[]): Work[] {
    const s = this.settings;
    const tracks = [...input];
    for (;;) {
      let best: [number, number, number] | undefined;
      tracks.forEach((a, i) => {
        tracks.forEach((b, j) => {
          if (i === j || a.side !== b.side || !(a.lastFrame < b.firstFrame)) return;
          const gap = times[b.firstFrame] - times[a.lastFrame];
          if (!(gap <= s.mergeGap)) return;
          const end = a.detections[a.detections.length - 1].det.floor, start = b.detections[0].det.floor;
          const d = Math.hypot(start.x - end.x, start.z - end.z);
          if (!(d <= s.maxSpeed * gap + s.gateSlack)) return;
          if (!(PlayerTracker.appearanceDistance(a.appearance, b.appearance) <= s.appearanceMergeLimit)) return;
          const c = d / (s.maxSpeed * gap + s.gateSlack) + gap / s.mergeGap;
          if (!best || c < best[0]) best = [c, i, j];
        });
      });
      if (!best) return tracks;
      const [, i, j] = best;
      const a = tracks[i], b = tracks[j];
      a.detections.push(...b.detections);
      a.lastTime = b.lastTime;
      for (const d of b.detections) a.blendAppearance(d.det.appearance);
      tracks.splice(j, 1);
    }
  }

  /**
   * A floor path smoothed by a constant-velocity Kalman filter and the Rauch-Tung-Striebel smoother: frames without a
   * measurement (undefined) are bridged at constant velocity. Uses the settings' measurement and acceleration noise.
   * Empty when there is no measurement at all.
   */
  static smoothedPath(times: readonly number[], measurements: readonly (FloorPoint | undefined)[],
    settings: PlayerTrackerSettings = defaultTrackerSettings): FloorPoint[] {
    const n = Math.min(times.length, measurements.length);
    let firstSeen = -1;
    for (let i = 0; i < n; i++) if (measurements[i]) { firstSeen = i; break; }
    if (firstSeen < 0) return [];
    const r = settings.measurementNoise * settings.measurementNoise, q = settings.accelerationNoise;
    const run = (value: (p: FloorPoint) => number): number[] => {
      const filtered: Axis[] = [], predicted: Axis[] = [];
      let s = new Axis(value(measurements[firstSeen]!), 0, firstSeen === 0 ? r : 100, 0, 9);
      for (let i = 0; i < n; i++) {
        const p = i === 0 ? s.copy() : s.predicted(Math.max(times[i] - times[i - 1], 0), q);
        predicted.push(p);
        s = p.copy();
        const m = measurements[i];
        if (m && !(i === 0 && firstSeen === 0)) s.update(value(m), r);
        filtered.push(s);
      }
      // Rauch-Tung-Striebel: x_s(k) = x_f(k) + G (x_s(k+1) - x_p(k+1)), G = P_f(k) F^T P_p(k+1)^-1.
      const out = filtered.map((a) => a.p);
      let next = filtered[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        const f = filtered[i], p = predicted[i + 1];
        const dt = times[i + 1] - times[i];
        // P_f F^T with F = [[1, dt], [0, 1]].
        const a00 = f.ppp + dt * f.ppv, a01 = f.ppv;
        const a10 = f.ppv + dt * f.pvv, a11 = f.pvv;
        const det = p.ppp * p.pvv - p.ppv * p.ppv;
        if (!(Math.abs(det) > 1e-300)) {
          next = f;
          out[i] = f.p;
          continue;
        }
        const i00 = p.pvv / det, i01 = -p.ppv / det, i11 = p.ppp / det;
        const g00 = a00 * i00 + a01 * i01, g01 = a00 * i01 + a01 * i11;
        const g10 = a10 * i00 + a11 * i01, g11 = a10 * i01 + a11 * i11;
        const dp = next.p - p.p, dv = next.v - p.v;
        const sm = f.copy();
        sm.p = f.p + g00 * dp + g01 * dv;
        sm.v = f.v + g10 * dp + g11 * dv;
        out[i] = sm.p;
        next = sm;
      }
      return out;
    };
    const xs = run((p) => p.x), zs = run((p) => p.z);
    return Array.from({ length: n }, (_, i) => ({ x: xs[i], z: zs[i] }));
  }

  /** Kalman filter over every frame of the track's span (missing frames only predict), then the RTS smoother. */
  private smooth(track: Work, times: readonly number[]): TrackedPlayer {
    const s = this.settings;
    const first = track.firstFrame, last = track.lastFrame;
    const byFrame = new Map<number, PersonDetection>();
    for (const d of track.detections) byFrame.set(d.frame, d.det);
    const n = last - first + 1;
    const frames = Array.from({ length: n }, (_, i) => first + i);
    const path = PlayerTracker.smoothedPath(times.slice(first, last + 1), frames.map((k) => byFrame.get(k)?.floor), s);
    const samples: TrackSample[] = [];
    for (let i = 0; i < n; i++) {
      const k = first + i;
      const d = byFrame.get(k);
      const p = { ...path[i] };
      // Never across the net beyond the tolerance.
      if (track.side === "home") p.z = Math.max(p.z, -s.netTolerance);
      else p.z = Math.min(p.z, s.netTolerance);
      const sample: TrackSample = { time: times[k], floor: p, occluded: d === undefined };
      if (d) {
        sample.measured = d.floor;
        sample.footImage = d.footImage;
        sample.keypoints = d.keypoints;
        if (d.boxHeight !== undefined) sample.boxHeight = d.boxHeight;
      }
      samples.push(sample);
    }
    // Short gaps at the clip's ends hold the nearest position, so players do not pop in and out.
    const head = samples[0];
    if (head) {
      for (let k = first - 1; k >= 0 && head.time - times[k] <= s.maxCoast; k--) {
        samples.unshift({ time: times[k], floor: head.floor, occluded: true });
      }
    }
    const tail = samples[samples.length - 1];
    if (tail) {
      for (let k = last + 1; k < times.length && times[k] - tail.time <= s.maxCoast; k++) {
        samples.push({ time: times[k], floor: tail.floor, occluded: true });
      }
    }
    return { id: newUUID(), side: track.side, samples };
  }
}
