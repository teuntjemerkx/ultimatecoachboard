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
  /** Web addition: the ball's apparent diameter in pixels (the detector's box), when the box was whole. */
  ballSize?: number;
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

/** A player the coach tapped on one frame of the clip (web addition), to be followed through the whole clip. */
export interface TrackLock {
  /** Seconds from the start of the clip of the frame tapped. */
  time: number;
  /** The player's feet in that frame, pixels. */
  foot: ImagePoint;
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
  /**
   * Web addition: two tracks whose detections stay closer than this most of the time they are both seen follow one
   * person (two people cannot stand that close), metres.
   */
  sameBodyDistance: number;
}

export const defaultTrackerSettings: Readonly<PlayerTrackerSettings> = {
  courtMargin: 2, netTolerance: 0.5, maxFootHeight: 1.2, maxSpeed: 8, gateSlack: 0.6, maxPlayersPerSide: 6, maxCoast: 1.0,
  mergeGap: 2.5, minDetections: 4, minConfidence: 0.1, measurementNoise: 0.1, accelerationNoise: 8, duplicateRadius: 0.4,
  tentativePenalty: 3, missGate: 64, keypointWeight: 30, appearanceWeight: 40, appearanceMergeLimit: 0.03,
  sameBodyDistance: 0.45,
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
    tracks = this.joinDuplicates(tracks);
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
   * Web addition: follows the players the coach tapped (`locks`) through the whole clip, forward and backward from the
   * frame each was tapped on. A lock starts from the detection whose feet are nearest the tap (within 3% of the frame
   * width), else from the tapped point itself. It never ends: while its player is not detected it coasts (the velocity
   * carries it for half a second, then it waits where it was), and it takes them back when they are, within the
   * physical gate of the time unseen. Everyone else gets a passing track of their own, as in `track`, that competes
   * for the detections: a lock waiting for its player does not take a person standing nearby, who is already someone
   * else's. Each detection counts with the camera's own uncertainty at that spot (`floorNoise`), not a fixed 10 cm:
   * from a low camera a far player's floor point wanders metres along the view, and such a player would otherwise be
   * lost every few frames. A person the frame cuts is now and then found twice, whole and as a piece at the edge
   * (`onePerson`): the piece next to a lock's detection starts no passing track. Frames a lock's player spends in the
   * air go back to the lock after each pass, and so do the frames from his landing on when the lock followed him up
   * (`rejoinJumps`). Returns the locks' tracks (spanning the clip, unseen frames occluded) and the detections they
   * took.
   */
  follow(input: readonly VideoFrameObservation[], locks: readonly TrackLock[], camera: VideoCamera):
    { tracks: TrackedPlayer[]; taken: Set<PersonDetection> } {
    const settings = this.settings;
    const taken = new Set<PersonDetection>();
    const frames = input.filter((f) => f.detections.length > 0).sort((a, b) => a.time - b.time);
    if (frames.length === 0 || locks.length === 0) return { tracks: [], taken };
    const times = frames.map((f) => f.time);
    const r = settings.measurementNoise * settings.measurementNoise, q = settings.accelerationNoise;
    const radius = Math.max(12, 0.03 * camera.width);
    const seeds: { frame: number; det: PersonDetection }[] = [];
    for (const lock of locks) {
      let frame = 0;
      times.forEach((t, k) => { if (Math.abs(t - lock.time) < Math.abs(times[frame] - lock.time)) frame = k; });
      const near = frames[frame].detections.map((d) => ({ d, gap: ImagePoint.distance(d.footImage, lock.foot) }))
        .filter((c) => c.gap <= radius).sort((a, b) => a.gap - b.gap)[0];
      if (near) {
        // A second tap on the same person is the same player.
        if (taken.has(near.d)) continue;
        taken.add(near.d);
        seeds.push({ frame, det: near.d });
        continue;
      }
      if (seeds.some((s) => s.frame === frame && ImagePoint.distance(s.det.footImage, lock.foot) < radius / 2)) continue;
      const floor = camera.floorPoint(lock.foot);
      if (floor) seeds.push({ frame, det: PersonDetection.create(floor, lock.foot, { confidence: 0.3 }) });
    }
    const locked = seeds.map((s) => new Work(CourtFrame.side(s.det.floor), s.det, s.frame, times[s.frame], r));
    const found = seeds.map(() => [] as { frame: number; det: PersonDetection }[]);
    const forbidden = 1e9;
    const miss = settings.missGate + 2 * Math.log(0.15 * 0.15);
    for (const forward of [true, false]) {
      // Each pass starts from the seeds, with no one else yet.
      locked.forEach((w, i) => {
        const s = seeds[i];
        w.detections = [{ frame: s.frame, det: s.det }];
        w.appearance = s.det.appearance;
        w.x = new Axis(s.det.floor.x, 0, r, 0, 9);
        w.z = new Axis(s.det.floor.z, 0, r, 0, 9);
        w.lastTime = times[s.frame];
      });
      const others: Work[] = [];
      const ahead = (k: number, frame: number) => (forward ? k > frame : k < frame);
      for (let n = 0; n < frames.length; n++) {
        const k = forward ? n : frames.length - 1 - n;
        const t = times[k];
        // From the first seed on (the seed's own frame already has its detection).
        if (!seeds.some((s) => s.frame === k || ahead(k, s.frame))) continue;
        const locks = locked.filter((_, i) => ahead(k, seeds[i].frame));
        const active = [...locks, ...others.filter((w) => Math.abs(t - w.lastTime) <= settings.maxCoast)];
        const dets = frames[k].detections.filter((d) => !taken.has(d) && d.confidence >= settings.minConfidence && this.onCourt(d.floor));
        if (dets.length === 0) continue;
        const nt = active.length, nd = dets.length;
        const cost = Array.from({ length: nt + nd }, () => new Array<number>(nd + nt).fill(forbidden));
        for (let j = 0; j < nd; j++) cost[nt + j][j] = 0;
        for (let i = nt; i < nt + nd; i++) for (let j = nd; j < nd + nt; j++) cost[i][j] = 0;
        const noise = dets.map((d) => PlayerTracker.floorNoise(d.floor, camera, r));
        const predicted = active.map((w) => {
          const dt = Math.abs(t - w.lastTime);
          const px = w.x.predicted(dt, q), pz = w.z.predicted(dt, q);
          // A player unseen for a while has most likely stopped: the velocity carries them half a second at most.
          const lead = Math.min(dt, 0.5);
          px.p = w.x.p + w.x.v * lead;
          pz.p = w.z.p + w.z.v * lead;
          return { dt, px, pz };
        });
        active.forEach((w, i) => {
          const { dt, px, pz } = predicted[i];
          const tentative = i >= locks.length && w.detections.length < 3 ? settings.tentativePenalty : 0;
          cost[i][nd + i] = miss + tentative;
          dets.forEach((d, j) => {
            if (!this.allowed(w.side, d, camera)) return;
            const [rx, rz] = noise[j];
            // The physical gate, widened by twice the reading's own uncertainty.
            const gate = settings.maxSpeed * dt + settings.gateSlack + 2 * Math.sqrt(Math.max(rx, rz));
            if (!(Math.hypot(d.floor.x - w.x.p, d.floor.z - w.z.p) <= gate)) return;
            const sx = px.ppp + rx, sz = pz.ppp + rz;
            const ex = d.floor.x - px.p, ez = d.floor.z - pz.p;
            cost[i][j] = (ex * ex) / sx + (ez * ez) / sz + Math.log(sx * sz) + tentative
              + this.appearanceCost(w.appearance, d.appearance) + this.keypointCost(w, d, dt);
          });
        });
        const assigned = new Array<boolean>(nd).fill(false), locksTook = new Array<boolean>(nd).fill(false);
        Hungarian.solve(cost).forEach((j, i) => {
          if (i >= nt || j === undefined || j >= nd || !(cost[i][j] < forbidden)) return;
          const w = active[i], { px, pz } = predicted[i];
          w.x = px;
          w.z = pz;
          w.x.update(dets[j].floor.x, noise[j][0]);
          w.z.update(dets[j].floor.z, noise[j][1]);
          w.lastTime = t;
          w.detections.push({ frame: k, det: dets[j] });
          w.blendAppearance(dets[j].appearance);
          assigned[j] = true;
          if (i < locks.length) {
            taken.add(dets[j]);
            locksTook[j] = true;
          }
        });
        const matched = dets.filter((_, j) => assigned[j]).map((d) => d.floor);
        dets.forEach((d, j) => {
          if (assigned[j] || matched.some((m) => Math.hypot(m.x - d.floor.x, m.z - d.floor.z) < settings.duplicateRadius)) return;
          if (dets.some((m, i) => locksTook[i] && PlayerTracker.onePerson(m, d, camera))) return;
          others.push(new Work(CourtFrame.side(d.floor), d, k, t, r));
        });
      }
      PlayerTracker.rejoinJumps(locked, others, times, camera, taken, forward);
      locked.forEach((w, i) => found[i].push(...w.detections.slice(1)));
    }
    const tracks = locked.map((w, i) => {
      w.detections = [{ frame: seeds[i].frame, det: seeds[i].det }, ...found[i]].sort((a, b) => a.frame - b.frame);
      return this.smooth(w, times, Infinity);
    });
    return { tracks, taken };
  }

  /**
   * Web addition: whether two detections of one frame are one person the frame cuts, found twice: the shorter box,
   * under half the taller one's height, reaches the edge of the picture (within 2% of its height), its feet lie under
   * the taller one's body (within 0.3 of its height across) and no higher than its feet, and its top below the taller
   * one's. Another person standing farther away would stand higher in the picture, and one nearer would look taller.
   */
  static onePerson(a: PersonDetection, b: PersonDetection, camera: VideoCamera): boolean {
    if (a.boxHeight === undefined || b.boxHeight === undefined) return false;
    const [tall, short] = a.boxHeight >= b.boxHeight ? [a, b] : [b, a];
    const h = tall.boxHeight!, s = short.boxHeight!, f = short.footImage, edge = 0.02 * camera.height;
    const cut = f.y >= camera.height - edge || f.x <= edge || f.x >= camera.width - edge;
    return cut && s < 0.5 * h && Math.abs(f.x - tall.footImage.x) <= 0.3 * h && f.y >= tall.footImage.y - 0.1 * h
      && f.y - s >= tall.footImage.y - h;
  }

  /**
   * Web addition: whether detection `b`, `dt` seconds after `a`, continues it in the picture: their keypoints at most
   * 0.3 of the body's height apart per 1/15 s (`keypointDistance`; a random walk, so growing with the square root of
   * the time between them).
   */
  static continues(a: PersonDetection, b: PersonDetection, dt: number): boolean {
    const m = PlayerTracker.keypointDistance(a.keypoints, b.keypoints);
    return m !== undefined && m <= 0.3 * Math.sqrt(Math.max(1, Math.abs(dt) * 15));
  }

  /**
   * Web addition: gives the locks back what passing tracks took of their players around a jump. Feet off the floor
   * read farther along the camera's ray (see `maxFootHeight`), from a low camera metres farther. When the first frame
   * in the air already reads beyond the physical gate, a passing track takes the jumper's frames until he lands. A
   * passing track that holds at least two frames inside a gap of a lock (a jump lasts 0.3 s or more), each farther along
   * the ray than the lock's path across the gap (from its detection before the gap to the one after) by more than three
   * times the reading's own uncertainty (as in `floorNoise`), whose first and last of them continue the lock's
   * detections on either side in the picture (`continues`), and the farthest of which shows him lifted off the floor
   * (`lifted`: legs misread move the feet alone) against him on the floor next to the gap (the lock's detection before
   * or after it, whichever reads nearer; where the lock followed him part of the way up or down, the one it saw him
   * take off or land in: away from the gap while each reads that much nearer and shows him lifted in the one closer to
   * it), was the lock's player in the air: the lock takes those frames. When the lock follows its player up instead
   * (his first frame in the air, often only 0.1 to 0.3 m up, reads inside its gate), the frame he comes down in (the
   * landing, or the take-off on the pass back in time) reads beyond it and a passing track takes him from there. At
   * least two of the lock's detections that each read that much farther than an earlier one of his (`a`, the latest
   * that does), with him lifted off the floor (`lifted`, from `a` to the farthest of them: a misread foot moves alone),
   * were a jump. He comes down within a second of the first of them, over a frame or a few after the last the lock saw
   * him in: each a passing track's detection that continues the one before in the picture, reads that much nearer,
   * shows the one before as him lifted, and whose track held no one else's frames since the jump began (of several, the
   * one nearest in the picture). The lock takes each, and from the last, his landing, that track's frames up to its own
   * next detection. A passing track goes to one lock at most.
   */
  private static rejoinJumps(locked: readonly Work[], others: readonly Work[], times: readonly number[],
    camera: VideoCamera, taken: Set<PersonDetection>, forward: boolean): void {
    type Taken = { frame: number; det: PersonDetection };
    const c = camera.center, claimed = new Map<Work, Work>();
    const byFrame = (x: Taken, y: Taken) => x.frame - y.frame;
    const give = (w: Work, o: Work, dets: readonly Taken[]) => {
      claimed.set(o, w);
      for (const e of dets) taken.add(e.det);
      w.detections.push(...dets);
    };
    // How far a detection reads beyond a floor point along the camera's ray, in standard deviations of a reading there.
    const beyond = (e: Taken, p: FloorPoint): number => {
      const d = Math.max(2, Math.hypot(p.x - c.x, p.z - c.z));
      const along = ((e.det.floor.x - p.x) * (p.x - c.x) + (e.det.floor.z - p.z) * (p.z - c.z)) / d;
      return along / ((5 * d * d) / (camera.focalLength * Math.max(1, c.y)));
    };
    const distance = (d: PersonDetection) => Math.hypot(d.floor.x - c.x, d.floor.z - c.z);
    for (const w of locked) {
      const mine = [...w.detections].sort(byFrame);
      // The lock's detection of its player on the floor, from its `k`th on away from a gap (`step` -1 or 1): while the
      // next one reads that much nearer and shows him lifted in this one, he was in the air in this one.
      const floor = (k: number, step: number): Taken => {
        while (mine[k + step] && beyond(mine[k], mine[k + step].det.floor) > 3
          && PlayerTracker.lifted(mine[k + step].det, mine[k].det, camera)) k += step;
        return mine[k];
      };
      for (let g = 0; g + 1 < mine.length; g++) {
        const a = mine[g], b = mine[g + 1];
        if (b.frame - a.frame < 3) continue;
        const path = (e: Taken): FloorPoint => {
          const u = (times[e.frame] - times[a.frame]) / (times[b.frame] - times[a.frame]);
          return { x: a.det.floor.x + u * (b.det.floor.x - a.det.floor.x), z: a.det.floor.z + u * (b.det.floor.z - a.det.floor.z) };
        };
        const between = (o: Work) => o.detections.filter((e) => e.frame > a.frame && e.frame < b.frame).sort(byFrame);
        const o = others.find((o) => {
          const inside = between(o);
          if (claimed.has(o) || inside.length < 2 || !inside.every((e) => beyond(e, path(e)) > 3)) return false;
          const first = inside[0], last = inside[inside.length - 1];
          if (!(PlayerTracker.continues(a.det, first.det, times[first.frame] - times[a.frame])
            && PlayerTracker.continues(last.det, b.det, times[b.frame] - times[last.frame]))) return false;
          const sides = [floor(g, -1).det, floor(g + 1, 1).det];
          const ground = sides[distance(sides[0]) <= distance(sides[1]) ? 0 : 1];
          const top = inside.reduce((m, e) => (beyond(e, ground.floor) > beyond(m, ground.floor) ? e : m));
          return PlayerTracker.lifted(ground, top.det, camera);
        });
        if (o) give(w, o, between(o));
      }
    }
    // In the pass's order of time: the lock followed its player up from one of his detections (`a`) and lost him where
    // he came down. Of the runs ending at the same detection the latest `a` that passes wins: the shortest, the jump.
    const order = (x: Taken, y: Taken) => (forward ? x.frame - y.frame : y.frame - x.frame);
    const before = (x: Taken, y: Taken) => order(x, y) < 0;
    for (const w of locked) {
      const mine = [...w.detections].sort(order), held = new Set(mine.map((e) => e.det)), landed = new Set<number>();
      for (let g = mine.length - 3; g >= 0; g--) {
        const a = mine[g];
        let n = g + 1;
        while (n < mine.length && beyond(mine[n], a.det.floor) > 3) n++;
        if (n - g - 1 < 2 || landed.has(n)) continue;
        const up = mine.slice(g + 1, n);
        const top = up.reduce((m, e) => (beyond(e, a.det.floor) > beyond(m, a.det.floor) ? e : m));
        if (!PlayerTracker.lifted(a.det, top.det, camera)) continue;
        // He comes down within a second, over a frame or a few: from the last the lock saw him in (it may follow him
        // part of the way), each a passing track's detection that reads nearer, with him lifted in the one before. The
        // lock takes each, and from the last, on the floor, its track's frames up to the lock's own next detection.
        let from = up[up.length - 1], step: { o: Work; landing: Taken; gap: number } | undefined;
        for (;;) {
          const next = mine.find((e) => before(from, e));
          let best: typeof step;
          for (const o of others) {
            const landing = o.detections.filter((e) => before(from, e) && (!next || before(e, next))).sort(order)[0];
            if (!landing || (claimed.has(o) && claimed.get(o) !== w)) continue;
            // No one else's frames while the lock's player was in the air.
            if (o.detections.some((e) => !before(e, up[0]) && !before(from, e) && !held.has(e.det))) continue;
            if (!(Math.abs(times[landing.frame] - times[up[0].frame]) <= 1 && beyond(landing, from.det.floor) < -3
              && PlayerTracker.continues(from.det, landing.det, times[landing.frame] - times[from.frame])
              && PlayerTracker.lifted(landing.det, from.det, camera))) continue;
            const gap = PlayerTracker.keypointDistance(from.det.keypoints, landing.det.keypoints)!;
            if (!best || gap < best.gap) best = { o, landing, gap };
          }
          if (best) {
            if (step) give(w, step.o, [step.landing]);
            held.add(best.landing.det);
            step = best;
            from = best.landing;
          } else if (!step && next && Math.abs(times[next.frame] - times[up[0].frame]) <= 1) {
            from = next;
          } else {
            break;
          }
        }
        if (!step) continue;
        const { o, landing } = step, next = mine.find((e) => before(landing, e));
        landed.add(n);
        give(w, o, o.detections.filter((e) => !before(e, landing) && (!next || before(e, next))));
      }
    }
  }

  /**
   * Web addition: whether detection `air`, read farther along the camera's ray than `ground`, is the same body lifted
   * off the floor rather than its feet misread (or the body standing farther away): its upper body (neck, shoulders,
   * hips) stands taller above its floor reading (`heightAbove`, per keypoint both show, median). A body raised with its
   * feet stands as much taller as the reading is farther (the same rays, met farther away), one standing there as tall,
   * and one whose feet alone read farther shorter. On a log scale at least a quarter of what the reading's distance
   * gives (1 for a body raised with its feet, 0 standing): the OK Hoče jump server, his feet tucked up, 0.6 to 1.2;
   * feet misread there -1.2 to -1.8.
   */
  static lifted(ground: PersonDetection, air: PersonDetection, camera: VideoCamera): boolean {
    const c = camera.center;
    const taller: number[] = [];
    for (const k of ["neck", "leftShoulder", "rightShoulder", "root", "leftHip", "rightHip"] as const) {
      const p = ground.keypoints[k], q = air.keypoints[k];
      if (!p || !q || !(p.confidence >= 0.2) || !(q.confidence >= 0.2)) continue;
      const h0 = camera.heightAbove(p.point, ground.floor), h1 = camera.heightAbove(q.point, air.floor);
      if (h0 !== undefined && h1 !== undefined && h0 > 0 && h1 > 0) taller.push(Math.log(h1 / h0));
    }
    const farther = Math.log(Math.hypot(air.floor.x - c.x, air.floor.z - c.z) / Math.hypot(ground.floor.x - c.x, ground.floor.z - c.z));
    if (taller.length < 2 || !(farther > 0)) return false;
    taller.sort((x, y) => x - y);
    return taller[Math.floor(taller.length / 2)] >= 0.25 * farther;
  }

  /**
   * Web addition: the variance (x, z) of a floor point read from a person's feet in the picture, for a few pixels of
   * error at the feet: d/f metres per pixel across the view and d²/(f h) along it (a camera h up, d away over the
   * floor), split onto the court's axes by the direction of the view; never below `least`.
   */
  static floorNoise(p: FloorPoint, camera: VideoCamera, least: number, pixels = 5): [number, number] {
    const c = camera.center, f = camera.focalLength;
    const d = Math.max(2, Math.hypot(p.x - c.x, p.z - c.z)), h = Math.max(1, c.y);
    const across = (pixels * d) / f, along = (pixels * d * d) / (f * h);
    const ux = (p.x - c.x) / d, uz = (p.z - c.z) / d;
    const x = across * uz, xa = along * ux, z = across * ux, za = along * uz;
    return [Math.max(least, x * x + xa * xa), Math.max(least, z * z + za * za)];
  }

  /**
   * Web addition: joins tracks that follow one person at the same time (a person detected twice, or two tracks taking
   * turns on one player), which would show as two bodies inside each other: same side, at least three frames in which
   * both were detected, and in at least 70% of them their detections closer than `sameBodyDistance`. The track with
   * more detections keeps its own and takes the other's in the frames it missed. Closest pairs first.
   */
  private joinDuplicates(input: Work[]): Work[] {
    const limit = this.settings.sameBodyDistance;
    const tracks = [...input];
    for (;;) {
      let best: [number, number, number] | undefined;
      tracks.forEach((a, i) => {
        tracks.forEach((b, j) => {
          if (j <= i || a.side !== b.side || a.lastFrame < b.firstFrame || b.lastFrame < a.firstFrame) return;
          const theirs = new Map(b.detections.map((d) => [d.frame, d.det.floor]));
          let both = 0, close = 0, sum = 0;
          for (const d of a.detections) {
            const q = theirs.get(d.frame);
            if (!q) continue;
            const gap = Math.hypot(d.det.floor.x - q.x, d.det.floor.z - q.z);
            both++;
            sum += gap;
            if (gap < limit) close++;
          }
          if (both < 3 || close < 0.7 * both) return;
          const mean = sum / both;
          if (!best || mean < best[0]) best = [mean, i, j];
        });
      });
      if (!best) return tracks;
      const [, i, j] = best;
      const [keep, drop] = tracks[i].detections.length >= tracks[j].detections.length ? [tracks[i], tracks[j]] : [tracks[j], tracks[i]];
      const mine = new Set(keep.detections.map((d) => d.frame));
      keep.detections.push(...drop.detections.filter((d) => !mine.has(d.frame)));
      keep.detections.sort((x, y) => x.frame - y.frame);
      keep.lastTime = Math.max(keep.lastTime, drop.lastTime);
      tracks.splice(tracks.indexOf(drop), 1);
    }
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

  /**
   * Kalman filter over every frame of the track's span (missing frames only predict), then the RTS smoother. Frames
   * before and after the span, up to `hold` seconds, keep the nearest position.
   */
  private smooth(track: Work, times: readonly number[], hold = this.settings.maxCoast): TrackedPlayer {
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
      for (let k = first - 1; k >= 0 && head.time - times[k] <= hold; k--) {
        samples.unshift({ time: times[k], floor: head.floor, occluded: true });
      }
    }
    const tail = samples[samples.length - 1];
    if (tail) {
      for (let k = last + 1; k < times.length && times[k] - tail.time <= hold; k++) {
        samples.push({ time: times[k], floor: tail.floor, occluded: true });
      }
    }
    return { id: newUUID(), side: track.side, samples };
  }
}
