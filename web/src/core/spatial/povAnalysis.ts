// Port of Spatial/POVAnalysis.swift: posed players of a scene frame, the women/men body defaults, and gaze readouts
// (Sections 5.3, 5.6 and 5.7). `SceneFrame.posedPlayers()` is `posedPlayers(frame)`; `SceneToken.defaultStature` and
// `effectiveStature` are also on the SceneToken object of zones/tacticalScene.ts.
import type { SceneFrame } from "../zones/sceneTimeline";
import { automaticPosture } from "../zones/sceneTimeline";
import type { SceneToken } from "../zones/tacticalScene";
import { BallFlight } from "./ballFlight";
import type { CameraPose } from "./cameraPose";
import { LineOfSight, OccluderModel, VisualField, type Visibility, type VisualBand } from "./lineOfSight";
import { V3, type Rigid } from "./math3d";
import { Stride, strideEnvelope, strideParams } from "./gait";
import { PoseParams, PostureLibrary } from "./postureLibrary";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "./skeleton";
import { swiftRound } from "./swiftCompat";

/**
 * Whose bodies the defaults describe: women or men (the research library's "elite_women" and "elite_men" figures, and
 * the net height that goes with them). The app sets it once from its settings.
 */
export const PlayerBodies = {
  women: false,
  /**
   * Web: the 3D players are drawn as the MakeHuman athletes (athleteBody.ts), so bodies are kept apart by their
   * capsules; false while the app can only draw the mannequin (AvatarMesh).
   */
  athletes: true,

  get group(): string {
    return PlayerBodies.women ? "elite_women" : "elite_men";
  },

  /** The net: 2.24 m women, 2.43 m men. */
  get netHeight(): number {
    return PlayerBodies.women ? 2.24 : 2.43;
  },
};

/**
 * Default stature by role when none is set (metres): the research library's elite figure for the position (women or
 * men, see `PlayerBodies`) when it has one, else liberos shortest and middles tallest. Swift `SceneToken.defaultStature`.
 */
export function defaultStature(role: string): number {
  const position = PostureLibrary.position(role);
  if (position !== undefined) {
    const h = PostureLibrary.shared.positions[position]?.traits?.stature_m?.[PlayerBodies.group];
    if (h !== undefined && h >= 1.5 && h <= 2.3) return h;
  }
  const shift = PlayerBodies.women ? -0.13 : 0;
  switch (role) {
    case "L":
      return 1.8 + shift;
    case "S": case "S1": case "S2":
      return 1.9 + shift;
    case "MB": case "MB1": case "MB2": case "M": case "M1": case "M2":
      return 2.02 + shift;
    default:
      return 1.95 + shift;
  }
}

/** Swift `SceneToken.effectiveStature`. */
export function effectiveStature(t: SceneToken): number {
  return t.stature ?? defaultStature(t.role);
}

/** A player of a scene frame with its fitted skeleton and posed joints. */
export class PosedPlayer {
  constructor(
    readonly token: SceneToken,
    readonly skeleton: SkeletonModel,
    readonly joints: Rigid[],
    /**
     * Web addition: for a player taking steps, the joints at the step cycle's turning points (gait.ts,
     * `strideEnvelope`); the body separation keeps all of them apart, and the pose of the moment as well.
     */
    readonly strideEnvelope: readonly Rigid[][] = [],
  ) {}

  get id(): string {
    return this.token.id;
  }

  get label(): string {
    return this.token.side === "home" ? `#${this.token.label}` : this.token.label;
  }

  get headCentre(): V3 {
    const h = this.skeleton.metrics.stature;
    return this.joints[Joint.head].apply(new V3(0, 0.06 * h, 0.01 * h));
  }

  /** Right-handed by default: the right shoulder. */
  get hittingShoulder(): V3 {
    return this.joints[Joint.rShoulder].translation;
  }
}

/**
 * Every player of a frame posed (posture blends applied). Swift `SceneFrame.posedPlayers()`. Web addition: a player
 * the frame has moving (`frame.motion`) takes steps (spatial/gait.ts) instead of sliding in one stance; `stride: false`
 * leaves the steps out (the bodies as they stand, e.g. for keeping players apart without the swinging arms and legs).
 */
export function posedPlayers(frame: SceneFrame, options: { stride?: boolean } = {}): PosedPlayer[] {
  return frame.tokens.map((t) => {
    const s = new SkeletonModel(new BodyMetrics(effectiveStature(t)));
    const posture = t.posture ?? automaticPosture(t.point);
    const facing = t.yaw ?? (t.side === "home" ? Math.PI : 0);
    const blend = frame.postureBlends.get(t.id);
    const motion = options.stride === false ? undefined : frame.motion.get(t.id);
    if (!motion) return new PosedPlayer(t, s, s.pose(blend ?? posture, t.point, facing, 0, t.role));
    const params = blend
      ? PoseParams.blend(Posture.params(blend.from, s, t.role), Posture.params(blend.to, s, t.role), blend.t)
      : Posture.params(posture, s, t.role);
    const m = Stride.motion(motion.velocity, facing, motion.phase);
    const joints = s.pose(strideParams(params, s, m), t.point, facing, 0);
    return new PosedPlayer(t, s, joints, strideEnvelope(params, s, m).map((e) => s.pose(e, t.point, facing, 0)));
  });
}

/** What a gaze ray aims at (Swift `GazeReadout.Aim`). */
export type GazeAim = "head" | "hittingShoulder" | "ball";

/** One gaze ray of a POV player (Section 5.6) with its visual-field band (5.7). */
export class GazeReadout {
  constructor(
    readonly targetID: string,
    readonly targetLabel: string,
    readonly aim: GazeAim,
    readonly point: V3,
    readonly visibility: Visibility,
    readonly band: VisualBand,
    readonly angle: number,
  ) {}

  /** "MB1 hitting shoulder · central 12° · 100% visible" */
  get text(): string {
    let what: string;
    switch (this.aim) {
      case "head": what = `${this.targetLabel} head`; break;
      case "hittingShoulder": what = `${this.targetLabel} hitting shoulder`; break;
      case "ball": what = "Ball"; break;
    }
    return `${what} · ${this.band} ${swiftRound(this.angle)}° · ${this.visibility.readout}`;
  }
}

const setterRoles = ["S", "S1", "S2"];

export const Gaze = {
  /**
   * Default targets for a POV player in a manual scene: the opposing setter's head and the opposing front row's hitting
   * shoulders (the read cues of Section 5.3).
   */
  defaultTargets(viewer: PosedPlayer, players: readonly PosedPlayer[]): [string, GazeAim][] {
    const opponents = players.filter((p) => p.token.side !== viewer.token.side);
    const out: [string, GazeAim][] = [];
    const setter = opponents.find((p) => setterRoles.includes(p.token.role));
    if (setter) out.push([setter.id, "head"]);
    for (const p of opponents) {
      if (Math.abs(p.token.point.z) < 4.5 && !setterRoles.includes(p.token.role)) out.push([p.id, "hittingShoulder"]);
    }
    return out;
  },

  /** The ball's identity as a gaze target. */
  ballID: "BA11BA11-0000-4000-8000-000000000000",

  /**
   * Visibility and band of each target from the viewer's eye; the occluders are every body and the net. With a ball
   * position, the ball (radius 0.105 m) is the first target.
   */
  readouts(viewer: PosedPlayer, pov: CameraPose, targets: readonly (readonly [string, GazeAim])[], players: readonly PosedPlayer[],
    netHeight: number, ball?: V3, field: VisualField = new VisualField()): GazeReadout[] {
    const occluders = [
      ...players.flatMap((p) => OccluderModel.body(p.skeleton, p.joints, p.id, p.label)),
      ...OccluderModel.net(netHeight),
    ];
    const out: GazeReadout[] = [];
    if (ball) {
      const vis = LineOfSight.visibility(pov.eye, ball, BallFlight.radius, occluders, { netHeight, viewer: viewer.id });
      const { band, angle } = field.classify(ball.sub(pov.eye), pov.forward, V3.up);
      out.push(new GazeReadout(Gaze.ballID, "Ball", "ball", ball, vis, band, angle));
    }
    for (const [id, aim] of targets) {
      const t = players.find((p) => p.id === id);
      if (!t || id === viewer.id) continue;
      const k = t.skeleton.metrics.stature / 1.9;
      const point = aim === "head" ? t.headCentre : t.hittingShoulder;
      const radius = (aim === "head" ? 0.1 : 0.08) * k;
      if (aim === "ball") continue;
      const vis = LineOfSight.visibility(pov.eye, point, radius, occluders, { netHeight, viewer: viewer.id, targetOwner: id });
      const { band, angle } = field.classify(point.sub(pov.eye), pov.forward, V3.up);
      out.push(new GazeReadout(id, t.label, aim, point, vis, band, angle));
    }
    return out;
  },
};
