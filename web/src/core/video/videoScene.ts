// Port of Video/VideoScene.swift: a scene reconstructed from a rally video and the video-to-3D pipeline
// (Section 4.6). Swift's `VideoScene` is a class here; `encode`/`decode` give its Codable JSON shape.
import { TrackCleanup, defaultTrackCleanup } from "./trackCleanup";
import { CourtFrame, CourtPosition, Side, type FloorPoint, type LocalPoint } from "../match/court";
import { Stride, strideEnvelope, strideParams } from "../spatial/gait";
import { V3 } from "../spatial/math3d";
import { PoseParams } from "../spatial/postureLibrary";
import { PosedPlayer } from "../spatial/povAnalysis";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "../spatial/skeleton";
import { newUUID, referenceDateNow, swiftRound } from "../spatial/swiftCompat";
import { automaticPosture, SceneFrame, type PostureBlend } from "../zones/sceneTimeline";
import { SceneToken } from "../zones/tacticalScene";
import { BallAnchor, BallReconstruction, BallSegment, defaultBallSettings, type BallObservation, type BallSegmentJSON } from "./ballReconstruction";
import { VideoCamera, type VideoCameraJSON } from "./courtCalibration";
import { HallEnvironment, type HallEnvironmentJSON } from "./environment";
import { PlayerTracker, type VideoFrameObservation } from "./playerTracking";
import { PoseFitter } from "./poseFitting";
import { Hungarian, ImagePoint, wrappedAngle } from "./videoMath";
import { motionAt, type PlayerMotion } from "./videoMotion";

/** One reconstructed instant of a player. */
export interface VideoPlayerSample {
  time: number;
  x: number;
  z: number;
  /** Facing, radians from +Z toward +X. */
  yaw: number;
  posture: Posture;
  /** Feet above their standing contact, metres (replaces the posture's library jump). */
  jump: number;
  confidence: number;
  /** Not seen in this frame (position interpolated). */
  occluded: boolean;
}

export const VideoPlayerSample = {
  create(time: number, x: number, z: number, yaw: number, posture: Posture, options: { jump?: number; confidence?: number;
    occluded?: boolean } = {}): VideoPlayerSample {
    return { time, x, z, yaw, posture, jump: options.jump ?? 0, confidence: options.confidence ?? 1, occluded: options.occluded ?? false };
  },
  point(s: VideoPlayerSample): FloorPoint {
    return { x: s.x, z: s.z };
  },
};

/** A player of a video scene through time. */
export interface VideoPlayerTrack {
  id: string;
  side: Side;
  label: string;
  /** Role code ("S", "OH1", "MB2", "OPP", "L" ...); "" when unknown. */
  role: string;
  /** Stature in metres; undefined uses the role's default. */
  stature?: number;
  /** Samples in time order. */
  samples: VideoPlayerSample[];
}

export const VideoPlayerTrack = {
  create(init: { id?: string; side: Side; label: string; role?: string; stature?: number; samples: VideoPlayerSample[] }): VideoPlayerTrack {
    const t: VideoPlayerTrack = { id: init.id ?? newUUID(), side: init.side, label: init.label, role: init.role ?? "", samples: init.samples };
    if (init.stature !== undefined) t.stature = init.stature;
    return t;
  },
  effectiveStature(t: VideoPlayerTrack): number {
    return t.stature ?? SceneToken.defaultStature(t.role);
  },
};

/** A player as a tap target on the video frame. */
export interface VideoMarker {
  id: string;
  label: string;
  side: Side;
  /** Normalised frame coordinates (0...1, v down) of the feet and the top of the head. */
  foot: ImagePoint;
  head: ImagePoint;
}

/** The Swift Codable shape of a video scene. */
export interface VideoSceneJSON {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  camera: VideoCameraJSON;
  environment: HallEnvironmentJSON;
  videoFile?: string;
  plateFile?: string;
  clipStart?: number;
  players: VideoPlayerTrack[];
  ball: BallSegmentJSON[];
  netHeight: number;
}

/** A video scene at one moment. Tokens carry the position and posture; facing, jump and blends are by token id. */
export class VideoFrame {
  tokens: SceneToken[] = [];
  /** Facing per token, radians from +Z toward +X. */
  yaw = new Map<string, number>();
  /** Feet above the floor per token, metres; replaces the posture's library jump. */
  jump = new Map<string, number>();
  /** Postures changing between two samples (the token's posture is the blend's start). */
  postureBlends = new Map<string, PostureBlend>();
  confidence = new Map<string, number>();
  /** Velocity on the floor and step phase per token (web addition, see videoMotion.ts). */
  motion = new Map<string, PlayerMotion>();
  ball?: V3;

  /**
   * Every player posed with the reconstructed facing and jump (for the 3D view and POV analysis). Web additions: a
   * grounded posture the keypoints barely support (confidence under 0.4, a far, small or hidden player) fades to the
   * ready stance, since a held set or dive the video does not show is the likelier error; and a player moving over
   * the floor takes steps (spatial/gait.ts) instead of sliding in one stance; `stride: false` leaves the steps out
   * (the bodies as they stand, e.g. for keeping players apart without the swinging legs).
   */
  posedPlayers(options: { stride?: boolean } = {}): PosedPlayer[] {
    return this.tokens.map((t) => {
      const s = new SkeletonModel(new BodyMetrics(SceneToken.effectiveStature(t)));
      const posture = t.posture ?? automaticPosture(t.point);
      const blend = this.postureBlends.get(t.id);
      let params = blend
        ? PoseParams.blend(Posture.params(blend.from, s, t.role), Posture.params(blend.to, s, t.role), blend.t)
        : Posture.params(posture, s, t.role);
      const j = this.jump.get(t.id);
      const inAir = params.airborne || (j !== undefined && j > 0.02);
      const doubt = Math.max(0, Math.min(1, (0.4 - (this.confidence.get(t.id) ?? 1)) / 0.2));
      if (doubt > 0 && !inAir) params = PoseParams.blend(params, Posture.params("ready", s, t.role), doubt);
      if (j !== undefined && (params.airborne || j > 0.02)) params.jump = Math.max(0, j);
      const yaw = this.yaw.get(t.id) ?? SceneToken.facing(t);
      const motion = this.motion.get(t.id);
      const stride = motion && !inAir && options.stride !== false ? Stride.motion(motion.velocity, yaw, motion.phase) : undefined;
      const envelope = stride ? strideEnvelope(params, s, stride).map((e) => s.pose(e, t.point, yaw, 0)) : [];
      if (stride) params = strideParams(params, s, stride);
      const joints = s.pose(params, t.point, yaw, 0);
      return new PosedPlayer(t, s, joints, envelope);
    });
  }
}

/**
 * A scene reconstructed from a rally video (Section 4.6): the calibrated camera, the hall, every player's path,
 * facing, posture and jump, and the ball's flights. Stored next to the video and its clean plate.
 */
export class VideoScene {
  id: string;
  title: string;
  /** Seconds since 2001-01-01 UTC (Foundation's reference date, as Swift encodes `Date`). */
  createdAt: number;
  /** Seconds; sample and flight times are seconds from the start of the video. */
  duration: number;
  camera: VideoCamera;
  environment: HallEnvironment;
  /** File names the app stores next to the scene (the video, the clean plate image). */
  videoFile?: string;
  plateFile?: string;
  /** Where time 0 of the scene sits in the video file, seconds (undefined: at its start). */
  clipStart?: number;
  players: VideoPlayerTrack[];
  ball: BallSegment[];
  netHeight: number;

  constructor(init: { id?: string; title: string; createdAt?: number; duration: number; camera: VideoCamera; environment?: HallEnvironment;
    videoFile?: string; plateFile?: string; clipStart?: number; players?: VideoPlayerTrack[]; ball?: BallSegment[]; netHeight?: number }) {
    this.id = init.id ?? newUUID();
    this.title = init.title;
    this.createdAt = init.createdAt ?? referenceDateNow();
    this.duration = init.duration;
    this.camera = init.camera;
    this.environment = init.environment ?? new HallEnvironment();
    if (init.videoFile !== undefined) this.videoFile = init.videoFile;
    if (init.plateFile !== undefined) this.plateFile = init.plateFile;
    if (init.clipStart !== undefined) this.clipStart = init.clipStart;
    this.players = init.players ?? [];
    this.ball = init.ball ?? [];
    this.netHeight = init.netHeight ?? 2.43;
  }

  /**
   * The scene at time t: players between their samples (positions, jump and confidence linearly, facing along the
   * shortest arc, a posture blend while the posture changes) and the ball on its flight. A player is present from its
   * first to its last sample. Between two flights less than 0.25 s apart the ball moves in a straight line.
   */
  frame(t: number): VideoFrame {
    const frame = new VideoFrame();
    for (const track of this.players) {
      const s = track.samples;
      if (s.length === 0) continue;
      const first = s[0], last = s[s.length - 1];
      if (!(t >= first.time - 1e-9 && t <= last.time + 1e-9)) continue;
      let i = 0, j = s.length - 1;
      while (j - i > 1) {
        const m = (i + j) >> 1;
        if (s[m].time <= t) i = m;
        else j = m;
      }
      const a = s[i], b = s[j];
      const u = b.time > a.time ? Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time))) : 0;
      const point = { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
      const posture = u >= 1 ? b.posture : a.posture;
      frame.tokens.push(SceneToken.create({ id: track.id, side: track.side, label: track.label, role: track.role, point, posture,
        stature: track.stature }));
      frame.yaw.set(track.id, wrappedAngle(a.yaw + wrappedAngle(b.yaw - a.yaw) * u));
      frame.jump.set(track.id, a.jump + (b.jump - a.jump) * u);
      frame.confidence.set(track.id, a.confidence + (b.confidence - a.confidence) * u);
      if (a.posture !== b.posture && u > 0 && u < 1) frame.postureBlends.set(track.id, { from: a.posture, to: b.posture, t: u });
      const motion = motionAt(track, t);
      if (motion) frame.motion.set(track.id, motion);
    }
    frame.ball = this.ballPosition(t);
    return frame;
  }

  /** The ball at time t, undefined outside every flight. */
  ballPosition(t: number): V3 | undefined {
    const flights = [...this.ball].sort((a, b) => a.t0 - b.t0);
    const f = flights.find((s) => t >= s.t0 - 1e-9 && t <= s.t1 + 1e-9);
    if (f) return f.position(t);
    for (let k = 0; k + 1 < flights.length; k++) {
      const a = flights[k], b = flights[k + 1];
      if (t > a.t1 && t < b.t0 && b.t0 - a.t1 < 0.25) {
        const u = (t - a.t1) / (b.t0 - a.t1);
        const p = a.position(a.t1), q = b.position(b.t0);
        return p.add(q.sub(p).mul(u));
      }
    }
    return undefined;
  }

  /**
   * Every player in view at time t as tap targets on the video: feet and top of the head in normalised frame
   * coordinates (0...1, v down), nearest the camera first.
   */
  markers(t: number): VideoMarker[] {
    const f = this.frame(t);
    const cam = this.camera;
    const out: [VideoMarker, number][] = [];
    for (const token of f.tokens) {
      const lift = f.jump.get(token.id) ?? 0;
      const feet = V3.fromFloor(token.point, lift), top = V3.fromFloor(token.point, lift + SceneToken.effectiveStature(token));
      const a = cam.project(feet), b = cam.project(top);
      if (!a || !b || !(cam.contains(a, -40) || cam.contains(b))) continue;
      out.push([{ id: token.id, label: token.label, side: token.side, foot: { x: a.x / cam.width, y: a.y / cam.height },
        head: { x: b.x / cam.width, y: b.y / cam.height } }, feet.sub(cam.center).length]);
    }
    return out.sort((x, y) => x[1] - y[1]).map((m) => m[0]);
  }

  /**
   * The same moment for code that consumes SceneFrame (tokens and posture blends; no zones), each token facing the
   * reconstructed way.
   */
  sceneFrame(t: number): SceneFrame {
    const f = this.frame(t);
    const out = new SceneFrame();
    out.tokens = f.tokens.map((token) => {
      const yaw = f.yaw.get(token.id);
      return yaw === undefined ? token : { ...token, yaw };
    });
    out.postureBlends = f.postureBlends;
    return out;
  }

  encode(): VideoSceneJSON {
    const j: VideoSceneJSON = {
      id: this.id, title: this.title, createdAt: this.createdAt, duration: this.duration, camera: this.camera.encode(),
      environment: this.environment.encode(), players: this.players.map((p) => ({ ...p, samples: p.samples.map((s) => ({ ...s })) })),
      ball: this.ball.map((b) => b.encode()), netHeight: this.netHeight,
    };
    if (this.videoFile !== undefined) j.videoFile = this.videoFile;
    if (this.plateFile !== undefined) j.plateFile = this.plateFile;
    if (this.clipStart !== undefined) j.clipStart = this.clipStart;
    return j;
  }

  static decode(j: VideoSceneJSON): VideoScene {
    return new VideoScene({
      id: j.id, title: j.title, createdAt: j.createdAt, duration: j.duration, camera: VideoCamera.decode(j.camera),
      environment: HallEnvironment.decode(j.environment), videoFile: j.videoFile ?? undefined, plateFile: j.plateFile ?? undefined,
      clipStart: j.clipStart ?? undefined,
      players: j.players.map((p) => VideoPlayerTrack.create({ id: p.id, side: p.side, label: p.label, role: p.role,
        stature: p.stature ?? undefined, samples: p.samples.map((s) => ({ ...s })) })),
      ball: j.ball.map((b) => BallSegment.decode(b)), netHeight: j.netHeight,
    });
  }
}

/** The stages `VideoReconstructor.reconstruct` reports. */
export type ReconstructionStage = "Tracking players" | "Reading body positions" | "Tracking the ball" | "Done";

/** Web addition: a player's hand nearest the ball's viewing ray near a flight's start or end (`contactAnchor`). */
interface HandOnRay {
  /** Distance of the hand from the ray, metres. */
  d: number;
  /** When (seconds). */
  t: number;
  /** The point of the ray nearest the hand, and how far along the ray it is (metres from the camera). */
  point: V3;
  depth: number;
  posture?: Posture;
}

/**
 * Web addition: a hand this close to the ball's ray could have played it (a fitted pose puts a hand to about half a
 * metre, more when the posture is read wrong), and players whose hands are that close and further apart than
 * `depthSpread` along the ray make the contact ambiguous (metres).
 */
const rivalDistance = 1.0;
const depthSpread = 1.0;

/**
 * The video-to-3D pipeline the app calls after running the detector on sampled frames (Section 4): player tracking,
 * pose fitting with temporal smoothing, jump correction, ball segmentation and reconstruction, then labels and roles.
 */
export const VideoReconstructor = {
  /**
   * Builds the scene. Home players are labelled by their rotational position at their first frame (P1 right back,
   * P2 right front, P3 middle front, P4 left front, P5 left back, P6 middle back, from the team's own view facing the
   * net): `homeLabels[position]` or "1"..."6"; opponents "A"..."F" in the same order. `homeRoles` sets roles by
   * position ("" = unknown, which also picks the default stature). `progress` reports a fraction and a short stage
   * name ("Tracking players", "Reading body positions", "Tracking the ball", then "Done" at 1).
   */
  reconstruct(input: readonly VideoFrameObservation[], camera: VideoCamera, options: {
    homeLabels?: Partial<Record<CourtPosition, string>>; homeRoles?: Partial<Record<CourtPosition, string>>; netHeight?: number;
    title?: string; environment?: HallEnvironment; tracker?: PlayerTracker; progress?: (fraction: number, stage: ReconstructionStage) => void;
  } = {}): VideoScene {
    const homeLabels = options.homeLabels ?? {}, homeRoles = options.homeRoles ?? {};
    const progress = options.progress;
    const frames = [...input].sort((a, b) => a.time - b.time);
    progress?.(0, "Tracking players");
    const tracked = (options.tracker ?? new PlayerTracker()).track(frames, camera);
    progress?.(0.15, "Tracking players");

    // Labels and roles by rotational position at the first sample.
    const labels = new Map<string, [string, string]>();
    for (const side of Side.allCases) {
      const mine = tracked.filter((t) => t.side === side);
      const spots = CourtPosition.allCases;
      const cost = mine.map((tr) => {
        const p = CourtFrame.local(tr.samples[0].floor, side);
        return spots.map((s) => {
          const c = VideoReconstructor.canonical(s);
          return (p.l - c.l) * (p.l - c.l) + (p.d - c.d) * (p.d - c.d);
        });
      });
      const assignment = Hungarian.solve(cost);
      mine.forEach((tr, i) => {
        const k = assignment[i];
        if (k === undefined) return;
        const pos = spots[k];
        if (side === "home") labels.set(tr.id, [homeLabels[pos] ?? `${pos}`, homeRoles[pos] ?? ""]);
        else labels.set(tr.id, [String.fromCharCode(64 + pos), ""]);
      });
    }

    progress?.(0.2, "Reading body positions");
    const fitters = new Map<string, PoseFitter>();
    const players: VideoPlayerTrack[] = [];
    tracked.forEach((tr, n) => {
      const [label, role] = labels.get(tr.id) ?? ["?", ""];
      const stature = SceneToken.defaultStature(role);
      const key = `${role}|${swiftRound(stature * 100)}`;
      let fitter = fitters.get(key);
      if (!fitter) {
        fitter = new PoseFitter(stature, role);
        fitters.set(key, fitter);
      }
      const poseFrames = tr.samples.map((s) => ({ time: s.time, floor: s.floor, measured: s.measured, keypoints: s.keypoints }));
      const fit = fitter.fitTrack(poseFrames, camera, tr.side === "home" ? Math.PI : 0);
      // Web addition: positions smoothed through the gaps with the camera's own uncertainty, jumps only where and as
      // long as volleyball jumps happen (TrackCleanup): no gliding, wobbling or flying players.
      const samples = TrackCleanup.clean(tr.samples.map((s, k) => {
        const e = fit.estimates[k];
        return VideoPlayerSample.create(s.time, fit.floor[k].x, fit.floor[k].z, e.yaw, e.posture,
          { jump: e.jump, confidence: e.confidence, occluded: s.occluded });
      }), defaultTrackCleanup, camera);
      players.push(VideoPlayerTrack.create({ id: tr.id, side: tr.side, label, role, samples }));
      progress?.(0.2 + (0.6 * (n + 1)) / Math.max(tracked.length, 1), "Reading body positions");
    });
    players.sort((a, b) => {
      const sa = a.side === "home" ? 0 : 1, sb = b.side === "home" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });

    progress?.(0.8, "Tracking the ball");
    const scene = new VideoScene({ title: options.title ?? "Video rally", duration: frames[frames.length - 1]?.time ?? 0, camera,
      environment: options.environment ?? new HallEnvironment(), players, netHeight: options.netHeight ?? 2.43 });
    const ballObs: BallObservation[] = [];
    for (const f of frames) if (f.ball) ballObs.push(f.ballSize !== undefined ? { time: f.time, image: f.ball, size: f.ballSize } : { time: f.time, image: f.ball });
    const flights = BallReconstruction.split(ballObs, camera);
    const anchors: BallAnchor[] = [];
    for (const flight of flights) {
      const start = VideoReconstructor.contactAnchor(flight, scene, true, undefined, ballObs);
      if (start) anchors.push(start);
      const end = VideoReconstructor.contactAnchor(flight, scene, false, undefined, ballObs);
      if (end) {
        anchors.push(end);
      } else {
        const last = flight[flight.length - 1];
        // Web addition: with drag, as `split` grew the flight; drag-free a long serve ends metres further and lower.
        const free = last ? BallReconstruction.fit(flight, camera) : undefined;
        if (last && free && free.position(last.time).y < 0.4) anchors.push(BallAnchor.floor(last.time));
      }
    }
    scene.ball = BallReconstruction.reconstruct(flights, camera, anchors);
    progress?.(1, "Done");
    return scene;
  },

  /**
   * A contact at a flight's start (or end): the ball's image track, extrapolated by up to 1.5 frames (the contact
   * happens between frames), passes within `maxDistance` of a hand or forearm of a posed player. The anchor is the
   * point of the ball's viewing ray nearest that hand, at that moment, with the spin the player's posture gives.
   *
   * Web additions, for a far camera whose viewing ray crosses half the court at hand height (a broadcast telephoto
   * behind an end line): the image does not tell how far along the ray the ball is, so a hand near the ray is often
   * that of a player metres in front of or behind the ball. So there is no contact where one believable flight also
   * runs through the ball points just past the edge (`track`, the whole ball track; a contact changes the velocity),
   * nor where no believable flight through that hand (bounded as in `BallReconstruction.reconstruct`) reprojects
   * within `rmsThreshold`. And when another player's hand comes within `rivalDistance` of the ray more than
   * `depthSpread` nearer or farther along it, the image must fit the flight through the nearest hand clearly better
   * than through theirs: by nine times the per-coordinate pixel variance of that fit (three standard deviations).
   */
  contactAnchor(flight: readonly BallObservation[], scene: VideoScene, atStart: boolean, maxDistance = 0.6,
    track: readonly BallObservation[] = []): BallAnchor | undefined {
    if (flight.length < 4) return undefined;
    const first = flight[0], last = flight[flight.length - 1];
    const free = BallReconstruction.fit(flight, scene.camera, [], false);
    if (!free) return undefined;
    if (VideoReconstructor.fliesOn(flight, track, scene.camera, atStart)) return undefined;
    const frameTime = (last.time - first.time) / (flight.length - 1);
    const edge = atStart ? first.time : last.time;
    // Each player's hand nearest the ray, with its depth along the ray (metres from the camera).
    const nearest = new Map<string, HandOnRay>();
    for (let k = 0; k <= 6; k++) {
      const t = edge + (atStart ? -1 : 1) * 1.5 * frameTime * (k / 6);
      const px = scene.camera.project(free.unclamped(t));
      if (!px) continue;
      const ray = scene.camera.ray(px);
      for (const player of scene.frame(t).posedPlayers()) {
        const j = player.joints, s = player.skeleton;
        const elbows = [j[Joint.lElbow].translation, j[Joint.rElbow].translation];
        const wrists = [j[Joint.lWrist].translation, j[Joint.rWrist].translation];
        const hands = [s.fingertip(j, true), s.fingertip(j, false), ...wrists, ...elbows.map((e, i) => e.add(wrists[i]).mul(0.5))];
        for (const q of hands) {
          const w = q.sub(ray.origin);
          const along = w.dot(ray.direction);
          if (!(along > 0)) continue;
          const onRay = ray.origin.add(ray.direction.mul(along));
          const d = q.sub(onRay).length;
          const mine = nearest.get(player.token.id);
          if (!mine || d < mine.d) nearest.set(player.token.id, { d, t, point: onRay, depth: along, posture: player.token.posture });
        }
      }
    }
    let best: HandOnRay | undefined;
    for (const c of nearest.values()) if (!best || c.d < best.d) best = c;
    if (!best || !(best.d <= maxDistance)) return undefined;
    const settings = defaultBallSettings;
    const anchorAt = (c: HandOnRay) =>
      BallAnchor.hand(c.t, c.point, 0.3, atStart && c.posture ? BallReconstruction.expectedAero(c.posture) : undefined);
    const fitThrough = (c: HandOnRay) => BallReconstruction.bestFit(flight, scene.camera, [anchorAt(c)], settings.drag, settings);
    const chosen = best, through = fitThrough(best);
    if (!through || !(Math.sqrt(through.pixelCost / through.count) <= settings.rmsThreshold)
      || !(Math.sqrt(through.sizeCost / Math.max(through.sizeCount, 1)) <= settings.sizeThreshold)) return undefined;
    const variance = Math.max(1, through.pixelCost / (2 * through.count));
    for (const c of nearest.values()) {
      if (c === chosen || !(c.d <= rivalDistance) || !(Math.abs(c.depth - chosen.depth) > depthSpread)) continue;
      const theirs = fitThrough(c);
      if (theirs && theirs.cost - through.cost < 9 * variance) return undefined;
    }
    return anchorAt(chosen);
  },

  /**
   * Web addition: whether one believable flight (`BallReconstruction.plausible`, within `rmsThreshold` and each new
   * point within `pointThreshold`, as `split` grows a flight, with drag) runs through the flight and the two or three
   * ball points of `track` nearest past its start (or end), within half a second: then the ball flew on there, and an
   * outlier or a gap in the track split the flight, not a contact.
   */
  fliesOn(flight: readonly BallObservation[], track: readonly BallObservation[], camera: VideoCamera, atStart: boolean): boolean {
    const s = defaultBallSettings;
    const edge = atStart ? flight[0].time : flight[flight.length - 1].time;
    const past = track.filter((o) => (atStart ? o.time < edge - 1e-6 && o.time >= edge - 0.5 : o.time > edge + 1e-6 && o.time <= edge + 0.5))
      .sort((a, b) => Math.abs(a.time - edge) - Math.abs(b.time - edge)).slice(0, 3);
    if (past.length < 2) return false;
    const all = [...flight, ...past].sort((a, b) => a.time - b.time);
    const fit = BallReconstruction.bestFit(all, camera, [], s.drag, s);
    if (!fit || !(Math.sqrt(fit.pixelCost / fit.count) <= s.rmsThreshold)
      || !(Math.sqrt(fit.sizeCost / Math.max(fit.sizeCount, 1)) <= s.sizeThreshold)) return false;
    const seg = new BallSegment(all[0].time, all[all.length - 1].time, fit.p0, fit.v0, fit.aero);
    if (!BallReconstruction.plausible(seg, s)) return false;
    return past.every((o) => {
      const q = camera.project(seg.unclamped(o.time));
      return q !== undefined && ImagePoint.distance(q, o.image) <= s.pointThreshold;
    });
  },

  /** Nominal spot of each rotational position in the team's own frame (l from its left sideline, d from the net). */
  canonical(p: CourtPosition): LocalPoint {
    switch (p) {
      case 1: return { l: 7.5, d: 7 };
      case 2: return { l: 7.5, d: 1.5 };
      case 3: return { l: 4.5, d: 1.5 };
      case 4: return { l: 1.5, d: 1.5 };
      case 5: return { l: 1.5, d: 7 };
      case 6: return { l: 4.5, d: 7 };
    }
  },
};
