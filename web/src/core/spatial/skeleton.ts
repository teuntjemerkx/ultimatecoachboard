// Port of Spatial/Skeleton.swift, with `SkeletonModel.solveStance` (PostureLibrary.swift) and `SkeletonModel.povPose`
// (CameraPose.swift) as methods of the class.
import type { FloorPoint } from "../match/court";
import type { PostureBlend } from "../zones/sceneTimeline";
import { CameraPose } from "./cameraPose";
import { DualQuat, Quat, Rigid, V3 } from "./math3d";
import { PoseParams, PostureLibrary, PostureSpec } from "./postureLibrary";

/**
 * The 17-joint avatar skeleton of the 3D board (Section 5.2 uses 24 joints for reconstruction; the manual-scene
 * avatars need these 17). Values are the Swift raw values; order is parent-before-child.
 */
export const Joint = {
  pelvis: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  head: 4,
  lShoulder: 5,
  lElbow: 6,
  lWrist: 7,
  rShoulder: 8,
  rElbow: 9,
  rWrist: 10,
  lHip: 11,
  lKnee: 12,
  lAnkle: 13,
  rHip: 14,
  rKnee: 15,
  rAnkle: 16,
} as const;
export type Joint = (typeof Joint)[keyof typeof Joint];

const jointParents: readonly (Joint | undefined)[] = [
  undefined, // pelvis
  Joint.pelvis, // spine
  Joint.spine, // chest
  Joint.chest, // neck
  Joint.neck, // head
  Joint.chest, // lShoulder
  Joint.lShoulder, // lElbow
  Joint.lElbow, // lWrist
  Joint.chest, // rShoulder
  Joint.rShoulder, // rElbow
  Joint.rElbow, // rWrist
  Joint.pelvis, // lHip
  Joint.lHip, // lKnee
  Joint.lKnee, // lAnkle
  Joint.pelvis, // rHip
  Joint.rHip, // rKnee
  Joint.rKnee, // rAnkle
];

/** Every joint in order (Swift `Joint.allCases`). */
export const allJoints: readonly Joint[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** The joint's parent (Swift `Joint.parent`); undefined for the pelvis. */
export function jointParent(j: Joint): Joint | undefined {
  return jointParents[j];
}

/** The Swift case name of a joint (for readouts and debugging). */
export function jointName(j: Joint): keyof typeof Joint {
  return (Object.keys(Joint) as (keyof typeof Joint)[])[j];
}

/** Body dimensions (Appendix B2 `Biometrics`), in metres. */
export class BodyMetrics {
  readonly stature: number;
  /** Standing reach, one hand, flat-footed; defaults to 1.31 x stature. */
  readonly standingReach: number;

  constructor(stature: number, standingReach?: number) {
    this.stature = stature;
    this.standingReach = standingReach ?? 1.31 * stature;
  }

  /** Eye height standing, 0.936 x stature (Appendix B2). */
  get eyeHeight(): number {
    return 0.936 * this.stature;
  }

  toJSON(): { stature: number; standingReach: number } {
    return { stature: this.stature, standingReach: this.standingReach };
  }
}

/**
 * Segment lengths from stature (Drillis and Contini proportions as tabulated by Winter), with the arm scaled so that
 * the reach posture reproduces the measured standing reach.
 */
export class SkeletonModel {
  readonly metrics: BodyMetrics;
  /** Joint offsets from the parent in the rest pose (standing, arms down, facing +Z in the body frame). */
  readonly restOffsets: readonly V3[];
  readonly ankleHeight: number;
  readonly armScale: number;
  private restCache: Rigid[] | undefined;

  /** Shoulder elevation when the arm is raised overhead (clavicle), as a fraction of stature. */
  static readonly shoulderElevation = 0.045;

  constructor(metrics: BodyMetrics) {
    this.metrics = metrics;
    const h = metrics.stature;
    // Reach = shoulder height + elevation + arm length (upper arm + forearm + hand = 0.440 H nominal).
    const nominalArm = 0.186 + 0.146 + 0.108;
    const scale = (metrics.standingReach - (0.818 + SkeletonModel.shoulderElevation) * h) / (nominalArm * h);
    this.armScale = Math.max(0.8, Math.min(1.25, scale));
    this.ankleHeight = 0.039 * h;
    const a = this.armScale;
    const o: V3[] = new Array<V3>(allJoints.length).fill(V3.zero);
    o[Joint.pelvis] = new V3(0, 0.53 * h, 0);
    o[Joint.spine] = new V3(0, 0.13 * h, 0);
    o[Joint.chest] = new V3(0, 0.106 * h, 0);
    o[Joint.neck] = new V3(0, 0.052 * h, 0); // shoulder line at 0.818 H, chin at 0.870 H
    o[Joint.head] = new V3(0, 0.052 * h, 0);
    o[Joint.lShoulder] = new V3(0.129 * h, 0.052 * h, 0);
    o[Joint.rShoulder] = new V3(-0.129 * h, 0.052 * h, 0);
    o[Joint.lElbow] = new V3(0, -0.186 * h * a, 0);
    o[Joint.rElbow] = new V3(0, -0.186 * h * a, 0);
    o[Joint.lWrist] = new V3(0, -0.146 * h * a, 0);
    o[Joint.rWrist] = new V3(0, -0.146 * h * a, 0);
    o[Joint.lHip] = new V3(0.095 * h, 0, 0);
    o[Joint.rHip] = new V3(-0.095 * h, 0, 0);
    o[Joint.lKnee] = new V3(0, -0.245 * h, 0);
    o[Joint.rKnee] = new V3(0, -0.245 * h, 0);
    o[Joint.lAnkle] = new V3(0, -0.246 * h, 0);
    o[Joint.rAnkle] = new V3(0, -0.246 * h, 0);
    this.restOffsets = o;
  }

  get handLength(): number {
    return 0.108 * this.metrics.stature * this.armScale;
  }

  /**
   * World transforms of every joint, standing at `position` facing `facing` (radians from world +Z toward +X), lifted
   * by `jump` metres on top of the posture's own jump. The pose is a posture (its research variant for `role`), a
   * blend between two postures (Section 3.3), or explicit pose parameters.
   */
  pose(what: Posture | PostureBlend | PoseParams, position: FloorPoint, facing: number, jump = 0, role?: string): Rigid[] {
    if (what instanceof PoseParams) return this.poseParams(what, position, facing, jump);
    if (typeof what === "string") return this.poseParams(Posture.params(what, this, role), position, facing, jump);
    const a = Posture.params(what.from, this, role), b = Posture.params(what.to, this, role);
    return this.poseParams(PoseParams.blend(a, b, what.t), position, facing, jump);
  }

  /** How far a shoulder is elevated (0...1) for its arm's angle: arms overhead lift the clavicle fully. */
  static shoulderLift(shoulder: Quat): number {
    const arm = shoulder.rotate(new V3(0, -1, 0));
    const elevation = (Math.acos(Math.max(-1, Math.min(1, -arm.y))) * 180) / Math.PI;
    return Math.max(0, Math.min(1, (elevation - 100) / 70));
  }

  private poseParams(params: PoseParams, position: FloorPoint, facing: number, jump: number): Rigid[] {
    const world: Rigid[] = new Array<Rigid>(allJoints.length).fill(Rigid.identity);
    for (const j of allJoints) {
      let offset = this.restOffsets[j];
      let rotation = params.rotations.get(j) ?? Quat.identity;
      // Raising an arm overhead lifts the shoulder (clavicle elevation), which the reach measurement includes.
      if (j === Joint.lShoulder || j === Joint.rShoulder) {
        offset = offset.with({ y: offset.y + SkeletonModel.shoulderElevation * this.metrics.stature * SkeletonModel.shoulderLift(rotation) });
      }
      const p = jointParent(j);
      if (p !== undefined) {
        // Grounded feet stay flat, pointing where the shank points.
        if ((j === Joint.lAnkle || j === Joint.rAnkle) && !params.airborne) {
          const parent = world[p].rotation;
          const fwd = parent.rotate(new V3(0, 0, 1));
          const heading = Math.hypot(fwd.x, fwd.z) > 1e-6 ? Math.atan2(fwd.x, fwd.z) : facing;
          rotation = parent.conjugate.mul(Quat.fromAxisAngle(V3.up, heading));
        }
        world[j] = world[p].mul(new Rigid(rotation, offset));
      } else {
        world[j] = new Rigid(Quat.fromAxisAngle(V3.up, facing), V3.zero).mul(new Rigid(rotation, offset));
      }
    }
    // Ground contact: whatever is lowest rests on the floor (the feet, or the knee pads in a collapse dig). Hands
    // are not supports. A jump lifts the body from there.
    const h = this.metrics.stature;
    let clearance = Math.min(world[Joint.lAnkle].translation.y, world[Joint.rAnkle].translation.y) - this.ankleHeight;
    for (const knee of [Joint.lKnee, Joint.rKnee]) clearance = Math.min(clearance, world[knee].translation.y - 0.04 * h);
    const lift = -clearance + params.jump + Math.max(jump, 0);
    const shift = new V3(position.x, lift, position.z);
    return world.map((r) => new Rigid(r.rotation, r.translation.add(shift)));
  }

  /** The rest pose at the origin (the bind pose for skinning). */
  get restPose(): Rigid[] {
    if (!this.restCache) this.restCache = this.pose("standing", { x: 0, z: 0 }, 0);
    return [...this.restCache];
  }

  /** Skin transforms (posed * inverse(rest)) as dual quaternions, one per joint. */
  skin(posed: readonly Rigid[]): DualQuat[] {
    const rest = this.restPose;
    const n = Math.min(posed.length, rest.length);
    const out: DualQuat[] = [];
    for (let i = 0; i < n; i++) out.push(DualQuat.fromRigid(posed[i].mul(rest[i].inverse)));
    return out;
  }

  /** Fingertip of a hand in a pose (the wrist plus the hand along the forearm direction). */
  fingertip(posed: readonly Rigid[], left: boolean): V3 {
    const w = posed[left ? Joint.lWrist : Joint.rWrist];
    return w.apply(new V3(0, -this.handLength, 0));
  }

  /** Eye position: in front of the head joint by 0.066 H up and 0.04 H forward. */
  eye(posed: readonly Rigid[]): V3 {
    const h = this.metrics.stature;
    return posed[Joint.head].apply(new V3(0, 0.066 * h, 0.04 * h));
  }

  /**
   * Two-bone IK for both legs in the body frame (PostureLibrary.swift): the ankles move to the stance width (lateral)
   * and stagger (right foot ahead positive) at the mean height the angles produce, and each knee keeps pointing where
   * the angles put it. Hip and knee rotations of `params` are replaced in place; the rest is untouched.
   */
  solveStance(params: PoseParams, width: number | undefined, stagger: number | undefined, yaw: Quat = Quat.identity): void {
    const pelvisRot = params.rotations.get(Joint.pelvis) ?? Quat.identity;
    const thigh = this.restOffsets[Joint.lKnee].length, shank = this.restOffsets[Joint.lAnkle].length;
    const fk = (left: boolean): { hip: V3; knee: V3; ankle: V3 } => {
      const hipJ = left ? Joint.lHip : Joint.rHip, kneeJ = left ? Joint.lKnee : Joint.rKnee;
      const hip = pelvisRot.rotate(this.restOffsets[hipJ]);
      const tw = pelvisRot.mul(params.rotations.get(hipJ) ?? Quat.identity);
      const knee = hip.add(tw.rotate(new V3(0, -thigh, 0)));
      const sw = tw.mul(params.rotations.get(kneeJ) ?? Quat.identity);
      return { hip, knee, ankle: knee.add(sw.rotate(new V3(0, -shank, 0))) };
    };
    const l = fk(true), rgt = fk(false);
    // Targets in the body's yaw frame (the stance is measured on the floor, not in the tilted pelvis), then back.
    const inv = yaw.conjugate;
    let la = inv.rotate(l.ankle), ra = inv.rotate(rgt.ankle);
    const y = (la.y + ra.y) / 2;
    la = la.with({ y });
    ra = ra.with({ y });
    if (width !== undefined && width > 0) {
      const cx = (la.x + ra.x) / 2;
      la = la.with({ x: cx + width / 2 });
      ra = ra.with({ x: cx - width / 2 });
    }
    if (stagger !== undefined) {
      const cz = (la.z + ra.z) / 2;
      ra = ra.with({ z: cz + stagger / 2 });
      la = la.with({ z: cz - stagger / 2 });
    }
    const legs: [boolean, { hip: V3; knee: V3; ankle: V3 }, V3][] = [
      [true, l, yaw.rotate(la)],
      [false, rgt, yaw.rotate(ra)],
    ];
    for (const [left, leg, target] of legs) {
      const v = target.sub(leg.hip);
      const dist = Math.max(Math.abs(thigh - shank) + 1e-4, Math.min(thigh + shank - 1e-4, v.length));
      const dir = v.normalized;
      const cosA = Math.max(-1, Math.min(1, (thigh * thigh + dist * dist - shank * shank) / (2 * thigh * dist)));
      const sinA = Math.sqrt(1 - cosA * cosA);
      // The knee keeps the side the angles gave it (forward and as far out as the hip rotation turns it).
      const kh = leg.knee.sub(leg.hip);
      let pole = kh.sub(dir.mul(kh.dot(dir)));
      if (pole.length < 1e-6) {
        const fwd = yaw.rotate(new V3(0, 0, 1));
        pole = fwd.sub(dir.mul(fwd.dot(dir)));
      }
      pole = pole.normalized;
      const knee = leg.hip.add(dir.mul(thigh * cosA)).add(pole.mul(thigh * sinA));
      const ankle = leg.hip.add(dir.mul(dist));
      const thighDir = knee.sub(leg.hip).normalized, shankDir = ankle.sub(knee).normalized;
      const yAxis = thighDir.neg();
      let zAxis = shankDir.sub(thighDir.mul(shankDir.dot(thighDir))).neg();
      if (zAxis.length < 1e-6) zAxis = pole;
      zAxis = zAxis.sub(yAxis.mul(zAxis.dot(yAxis))).normalized;
      const xAxis = yAxis.cross(zAxis);
      const thighWorld = Quat.fromBasis(xAxis, yAxis, zAxis);
      const kneeFlex = Math.acos(Math.max(-1, Math.min(1, thighDir.dot(shankDir))));
      params.rotations.set(left ? Joint.lHip : Joint.rHip, pelvisRot.conjugate.mul(thighWorld));
      params.rotations.set(left ? Joint.lKnee : Joint.rKnee, Quat.fromAxisAngle(new V3(1, 0, 0), kneeFlex));
    }
  }

  /**
   * Head-locked POV (Section 5.1, CameraPose.swift): the eye of the posed skeleton looking along the head's forward
   * direction, horizon levelled, 90 degrees horizontal field of view at the given aspect. Free-look adds yaw and pitch
   * relative to the head, limited to the neck's range (yaw +-70, pitch -50...+60 degrees).
   */
  povPose(posed: readonly Rigid[], aspect: number, options: { fovX?: number; yaw?: number; pitch?: number } = {}): CameraPose {
    const fovX = options.fovX ?? Math.PI / 2;
    const head = posed[Joint.head].rotation;
    let forward = head.rotate(new V3(0, 0, 1));
    const yaw = (Math.max(-70, Math.min(70, ((options.yaw ?? 0) * 180) / Math.PI)) * Math.PI) / 180;
    const pitch = (Math.max(-50, Math.min(60, ((options.pitch ?? 0) * 180) / Math.PI)) * Math.PI) / 180;
    forward = Quat.fromAxisAngle(V3.up, yaw).rotate(forward);
    const side = forward.cross(V3.up).normalized;
    if (side.length > 0.5) forward = Quat.fromAxisAngle(side, pitch).rotate(forward);
    const fovY = 2 * Math.atan(Math.tan(fovX / 2) / aspect);
    return CameraPose.looking(this.eye(posed), forward.normalized, V3.up, fovY, 0.04);
  }
}

/**
 * The posture library (Sections 3.2 and 5.2). Each posture names a technique of the research library
 * (resources/postures, per position); `rotations` is the hand-made fallback when the library has no variant.
 * Angles are anatomical: flexion bends a limb forward (+Z in the body frame), abduction lifts it sideways.
 */
export type Posture =
  | "standing" | "ready" | "pass" | "set" | "attack" | "block" | "dig" | "reach"
  | "readyHigh" | "lowDefence" | "angledPass" | "overheadPass" | "sprawl" | "backSet" | "jumpSet" | "approach"
  | "armCock" | "landing" | "quickAttack" | "blockReady" | "blockLanding" | "floatServe" | "jumpServe" | "cover";

const flex = (deg: number): Quat => Quat.fromAxisAngle(new V3(1, 0, 0), (-deg * Math.PI) / 180); // limbs pointing down swing forward
const bend = (deg: number): Quat => Quat.fromAxisAngle(new V3(1, 0, 0), (deg * Math.PI) / 180); // knee: shank backward
const lean = (deg: number): Quat => Quat.fromAxisAngle(new V3(1, 0, 0), (deg * Math.PI) / 180); // trunk forward
const abduct = (deg: number, left: boolean): Quat => Quat.fromAxisAngle(new V3(0, 0, 1), ((left ? 1 : -1) * deg * Math.PI) / 180);

function table(entries: [Joint, Quat][]): Map<Joint, Quat> {
  return new Map(entries);
}

const techniqueIDs: Record<Posture, string | undefined> = {
  standing: undefined,
  reach: undefined,
  ready: "ready_medium",
  readyHigh: "ready_high",
  lowDefence: "ready_low",
  pass: "pass_platform",
  angledPass: "pass_platform_angled",
  overheadPass: "overhead_pass",
  dig: "dig_low",
  sprawl: "dig_sprawl",
  set: "set_front_contact",
  backSet: "set_back_contact",
  jumpSet: "set_jump_contact",
  approach: "approach_takeoff",
  armCock: "attack_arm_cock",
  attack: "attack_contact",
  landing: "attack_landing",
  quickAttack: "quick_attack_contact",
  blockReady: "block_ready",
  block: "block_jump_peak",
  blockLanding: "block_landing",
  floatServe: "serve_float_contact",
  jumpServe: "serve_jump_contact",
  cover: "cover",
};

const postureTitles: Partial<Record<Posture, string>> = {
  readyHigh: "HIGH READY",
  lowDefence: "LOW DEFENCE",
  angledPass: "ANGLED PASS",
  overheadPass: "OVERHEAD PASS",
  backSet: "BACK SET",
  jumpSet: "JUMP SET",
  armCock: "ARM COCK",
  quickAttack: "QUICK",
  blockReady: "BLOCK READY",
  blockLanding: "BLOCK LANDING",
  floatServe: "FLOAT SERVE",
  jumpServe: "JUMP SERVE",
};

export const Posture = {
  allCases: [
    "standing", "ready", "pass", "set", "attack", "block", "dig", "reach",
    "readyHigh", "lowDefence", "angledPass", "overheadPass", "sprawl", "backSet", "jumpSet", "approach",
    "armCock", "landing", "quickAttack", "blockReady", "blockLanding", "floatServe", "jumpServe", "cover",
  ] as readonly Posture[],

  /** The technique id in the research library. */
  techniqueID(p: Posture): string | undefined {
    return techniqueIDs[p];
  },

  title(p: Posture): string {
    return postureTitles[p] ?? p.toUpperCase();
  },

  /** Joint rotations and jump for a skeleton: the research variant for the role's position when there is one. */
  params(p: Posture, skeleton: SkeletonModel, role?: string): PoseParams {
    const id = techniqueIDs[p];
    if (id !== undefined) {
      const spec = PostureLibrary.shared.spec(id, role);
      if (spec) return PostureSpec.params(spec, skeleton);
    }
    return new PoseParams(Posture.rotations(p), Posture.fallbackJump(p));
  },

  fallbackJump(p: Posture): number {
    switch (p) {
      case "jumpSet": return 0.35;
      case "attack": case "jumpServe": return 0.6;
      case "quickAttack": return 0.55;
      case "armCock": return 0.5;
      default: return 0;
    }
  },

  flex, bend, lean, abduct,

  /** The hand-made fallback rotations. */
  rotations(p: Posture): Map<Joint, Quat> {
    switch (p) {
      case "standing":
        return new Map();
      case "reach":
        return table([[Joint.lShoulder, flex(180)]]);
      case "ready":
        return table([[Joint.spine, lean(20)], [Joint.chest, lean(5)],
          [Joint.lHip, flex(55)], [Joint.rHip, flex(55)], [Joint.lKnee, bend(85)], [Joint.rKnee, bend(85)],
          [Joint.lShoulder, flex(35).mul(abduct(10, true))], [Joint.rShoulder, flex(35).mul(abduct(10, false))],
          [Joint.lElbow, flex(35)], [Joint.rElbow, flex(35)]]);
      case "pass":
        return table([[Joint.spine, lean(25)], [Joint.chest, lean(5)],
          [Joint.lHip, flex(60)], [Joint.rHip, flex(60)], [Joint.lKnee, bend(90)], [Joint.rKnee, bend(90)],
          [Joint.lShoulder, flex(55).mul(abduct(-8, true))], [Joint.rShoulder, flex(55).mul(abduct(-8, false))]]);
      case "set":
        return table([[Joint.lHip, flex(20)], [Joint.rHip, flex(20)], [Joint.lKnee, bend(30)], [Joint.rKnee, bend(30)],
          [Joint.lShoulder, flex(160).mul(abduct(15, true))], [Joint.rShoulder, flex(160).mul(abduct(15, false))],
          [Joint.lElbow, flex(75)], [Joint.rElbow, flex(75)]]);
      case "attack":
        return table([[Joint.spine, lean(-10)],
          [Joint.lHip, flex(25)], [Joint.rHip, flex(15)], [Joint.lKnee, bend(40)], [Joint.rKnee, bend(25)],
          [Joint.rShoulder, flex(170)], [Joint.rElbow, flex(10)],
          [Joint.lShoulder, flex(70)], [Joint.lElbow, flex(40)]]);
      case "block":
        return table([[Joint.lHip, flex(10)], [Joint.rHip, flex(10)], [Joint.lKnee, bend(15)], [Joint.rKnee, bend(15)],
          [Joint.lShoulder, flex(170).mul(abduct(5, true))], [Joint.rShoulder, flex(170).mul(abduct(5, false))],
          [Joint.chest, lean(8)]]);
      case "dig": case "lowDefence": case "sprawl": case "cover":
        return table([[Joint.spine, lean(35)], [Joint.chest, lean(10)],
          [Joint.lHip, flex(75).mul(abduct(15, true))], [Joint.rHip, flex(75).mul(abduct(15, false))],
          [Joint.lKnee, bend(110)], [Joint.rKnee, bend(110)],
          [Joint.lShoulder, flex(50)], [Joint.rShoulder, flex(50)]]);
      case "readyHigh": case "landing": case "blockLanding":
        return table([[Joint.spine, lean(10)], [Joint.lHip, flex(30)], [Joint.rHip, flex(30)], [Joint.lKnee, bend(45)],
          [Joint.rKnee, bend(45)], [Joint.lShoulder, flex(30)], [Joint.rShoulder, flex(30)], [Joint.lElbow, flex(60)],
          [Joint.rElbow, flex(60)]]);
      case "angledPass":
        return Posture.rotations("pass");
      case "overheadPass": case "backSet": case "jumpSet":
        return Posture.rotations("set");
      case "approach":
        return table([[Joint.spine, lean(35)], [Joint.lHip, flex(70)], [Joint.rHip, flex(70)], [Joint.lKnee, bend(100)],
          [Joint.rKnee, bend(100)], [Joint.lShoulder, flex(-60)], [Joint.rShoulder, flex(-60)]]);
      case "armCock": case "quickAttack": case "floatServe": case "jumpServe":
        return Posture.rotations("attack");
      case "blockReady":
        return table([[Joint.lHip, flex(20)], [Joint.rHip, flex(20)], [Joint.lKnee, bend(30)], [Joint.rKnee, bend(30)],
          [Joint.lShoulder, flex(60).mul(abduct(20, true))], [Joint.rShoulder, flex(60).mul(abduct(20, false))],
          [Joint.lElbow, flex(100)], [Joint.rElbow, flex(100)]]);
    }
  },
};

/** Surface materials of the avatar mesh (the renderer colours them; the jersey takes the team colour). */
export const AvatarMaterial = {
  skin: 0,
  jersey: 1,
  shorts: 2,
  pads: 3,
  shoes: 4,
  hair: 5,
  socks: 6,
} as const;
export type AvatarMaterial = (typeof AvatarMaterial)[keyof typeof AvatarMaterial];

type Radii = readonly [number, number];

/**
 * A procedural, anatomically shaped, skinned avatar mesh: tapered limbs with oval cross-sections and muscle bulges,
 * an oval trunk, deltoids, hands, shoes, knee pads and a head with hair, each vertex bound to up to two joints so
 * elbows and knees bend smoothly under dual-quaternion skinning. Built in the rest pose (standing, facing +Z).
 */
export class AvatarMesh {
  positions: V3[] = [];
  normals: V3[] = [];
  joints: [number, number][] = [];
  weights: [number, number][] = [];
  materials: AvatarMaterial[] = [];
  indices: number[] = [];

  constructor(s: SkeletonModel, segments = 16) {
    const rest = s.restPose;
    const h = s.metrics.stature;
    const pos = (j: Joint): V3 => rest[j].translation;
    const x = new V3(1, 0, 0), up = V3.up;
    const M = AvatarMaterial;
    const sleeve = (t: number): AvatarMaterial => (t < 0.3 ? M.jersey : M.skin);
    // Trunk: shorts over the pelvis, jersey from the waist to the shoulders.
    this.tube(pos(Joint.pelvis).sub(up.mul(0.06 * h)), pos(Joint.pelvis).add(up.mul(0.045 * h)), {
      side: x, r0: [0.104 * h, 0.07 * h], r1: [0.094 * h, 0.062 * h], capLength: 0.02 * h,
      driver: Joint.pelvis, blend: Joint.spine, blendFrom: 0.5, material: () => M.shorts, segments });
    // The jersey hangs over the waistband: it starts below the shorts' top and is a little wider there.
    this.tube(pos(Joint.pelvis).add(up.mul(0.03 * h)), pos(Joint.chest), {
      side: x, r0: [0.099 * h, 0.067 * h], r1: [0.104 * h, 0.068 * h],
      capLength: 0.01 * h, driver: Joint.spine, blend: Joint.chest, material: () => M.jersey, segments });
    // Chest: broadest at the shoulders, sloping to the neck (trapezius) through a long top cap.
    this.tube(pos(Joint.chest).sub(up.mul(0.02 * h)), pos(Joint.neck).sub(up.mul(0.035 * h)), {
      side: x, r0: [0.106 * h, 0.07 * h], r1: [0.116 * h, 0.064 * h],
      capLength: 0.055 * h, driver: Joint.chest, blend: undefined, material: () => M.jersey, segments });
    // Neck and head (hair over the top and back).
    this.tube(pos(Joint.neck), pos(Joint.head).add(up.mul(0.025 * h)), {
      side: x, r0: [0.03 * h, 0.031 * h], r1: [0.028 * h, 0.03 * h],
      driver: Joint.neck, blend: Joint.head, material: () => M.skin, segments });
    const headCentre = pos(Joint.head).add(new V3(0, 0.06 * h, 0.01 * h));
    this.ellipsoid(headCentre, new V3(0.05 * h, 0.066 * h, 0.058 * h), Joint.head, segments, (p) =>
      (p.y > headCentre.y + 0.012 * h && p.z < headCentre.z + 0.03 * h) || p.z < headCentre.z - 0.03 * h ? M.hair : M.skin);
    for (const left of [true, false]) {
      const shoulder = left ? Joint.lShoulder : Joint.rShoulder, elbow = left ? Joint.lElbow : Joint.rElbow;
      const wrist = left ? Joint.lWrist : Joint.rWrist;
      const hip = left ? Joint.lHip : Joint.rHip, knee = left ? Joint.lKnee : Joint.rKnee, ankle = left ? Joint.lAnkle : Joint.rAnkle;
      // Deltoid under the sleeve, upper arm, forearm, flat hand (palm toward the thigh at rest).
      this.tube(pos(shoulder).sub(up.mul(0.008 * h)), pos(shoulder).sub(up.mul(0.06 * h)), {
        side: x, r0: [0.034 * h, 0.033 * h], r1: [0.031 * h, 0.031 * h], capLength: 0.022 * h,
        driver: shoulder, blend: undefined, material: () => M.jersey, segments });
      this.tube(pos(shoulder), pos(elbow), {
        side: x, r0: [0.031 * h, 0.032 * h], r1: [0.022 * h, 0.023 * h], bulge: 0.14, bulgeAt: 0.42,
        driver: shoulder, blend: elbow, material: sleeve, segments });
      this.tube(pos(elbow), pos(wrist), {
        side: x, r0: [0.022 * h, 0.023 * h], r1: [0.015 * h, 0.017 * h], bulge: 0.16, bulgeAt: 0.25,
        driver: elbow, blend: wrist, material: () => M.skin, segments });
      this.tube(pos(wrist), pos(wrist).sub(up.mul(s.handLength)), {
        side: x, r0: [0.011 * h, 0.026 * h], r1: [0.008 * h, 0.021 * h],
        driver: wrist, blend: undefined, material: () => M.skin, segments });
      // Thigh (shorts over the top), knee pad, shank with the calf, sock, shoe.
      this.tube(pos(hip), pos(knee), {
        side: x, r0: [0.056 * h, 0.06 * h], r1: [0.034 * h, 0.036 * h], bulge: 0.08, bulgeAt: 0.3,
        driver: hip, blend: knee, material: (t) => (t < 0.32 ? M.shorts : M.skin), segments });
      this.tube(pos(knee).add(up.mul(0.032 * h)).add(new V3(0, 0, 0.004 * h)), pos(knee).sub(up.mul(0.03 * h)).add(new V3(0, 0, 0.004 * h)), {
        side: x, r0: [0.038 * h, 0.04 * h], r1: [0.037 * h, 0.039 * h], capLength: 0.012 * h,
        driver: hip, blend: knee, blendFrom: 0, material: () => M.pads, segments });
      this.tube(pos(knee), pos(ankle), {
        side: x, r0: [0.033 * h, 0.036 * h], r1: [0.02 * h, 0.022 * h], bulge: 0.22, bulgeAt: 0.28,
        driver: knee, blend: ankle, material: (t) => (t > 0.78 ? M.socks : M.skin), segments });
      this.tube(pos(ankle).add(new V3(0, -0.024 * h, -0.032 * h)), pos(ankle).add(new V3(0, -0.03 * h, 0.118 * h)), {
        side: x, r0: [0.025 * h, 0.024 * h], r1: [0.027 * h, 0.016 * h], capLength: 0.02 * h,
        driver: ankle, blend: undefined, material: () => M.shoes, segments });
    }
  }

  /**
   * A tapered tube from a to b with an elliptical cross-section (half-width along `side`, half-depth across), a
   * muscle bulge, and ellipsoidal end caps. Vertices near b blend into `blend` so joints bend smoothly.
   */
  private tube(a: V3, b: V3, o: {
    side: V3; r0: Radii; r1: Radii; bulge?: number; bulgeAt?: number; capLength?: number;
    driver: Joint; blend: Joint | undefined; blendFrom?: number; material: (t: number) => AvatarMaterial; rings?: number; segments: number;
  }): void {
    const { side, r0, r1, driver, blend, material, segments } = o;
    const bulge = o.bulge ?? 0, bulgeAt = o.bulgeAt ?? 0.5, blendFrom = o.blendFrom ?? 0.7, rings = o.rings ?? 10;
    const axis = b.sub(a);
    const len = axis.length;
    if (!(len > 1e-6)) return;
    const dir = axis.mul(1 / len);
    let u = side.sub(dir.mul(side.dot(dir)));
    if (u.length < 1e-6) u = new V3(0, 0, 1).sub(dir.mul(dir.z));
    u = u.normalized;
    const v = dir.cross(u);
    const radii = (t0: number): [number, number] => {
      const t = Math.max(0, Math.min(1, t0));
      const k = 1 + bulge * Math.exp(-((t - bulgeAt) / 0.28) * ((t - bulgeAt) / 0.28));
      return [(r0[0] + (r1[0] - r0[0]) * t) * k, (r0[1] + (r1[1] - r0[1]) * t) * k];
    };
    const slope = ((r1[0] + r1[1]) - (r0[0] + r0[1])) / 2 / len;
    // Rows: start cap (pole to equator), tube, end cap (equator to pole).
    const capRings = 4;
    const rows: { t: number; centre: V3; w: number; d: number; theta: number; capLen: number }[] = [];
    const c0 = o.capLength ?? Math.min(r0[0], r0[1]) * 0.9, c1 = o.capLength ?? Math.min(r1[0], r1[1]) * 0.9;
    for (let i = 0; i < capRings; i++) {
      const theta = ((-Math.PI / 2) * (1 - i / capRings)) * 0.98;
      const [w, d] = radii(0);
      rows.push({ t: (Math.sin(theta) * c0) / len, centre: a.add(dir.mul(Math.sin(theta) * c0)), w: w * Math.cos(theta),
        d: d * Math.cos(theta), theta, capLen: c0 });
    }
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const [w, d] = radii(t);
      rows.push({ t, centre: a.add(dir.mul(len * t)), w, d, theta: 0, capLen: 0 });
    }
    for (let i = 1; i <= capRings; i++) {
      const theta = (((Math.PI / 2) * i) / capRings) * 0.98;
      const [w, d] = radii(1);
      rows.push({ t: 1 + (Math.sin(theta) * c1) / len, centre: b.add(dir.mul(Math.sin(theta) * c1)), w: w * Math.cos(theta),
        d: d * Math.cos(theta), theta, capLen: c1 });
    }
    const base = this.positions.length;
    for (const row of rows) {
      const [wFull, dFull] = radii(row.t);
      for (let k = 0; k < segments; k++) {
        const phi = (2 * Math.PI * k) / segments;
        const p = row.centre.add(u.mul(row.w * Math.cos(phi))).add(v.mul(row.d * Math.sin(phi)));
        let n = u.mul(Math.cos(phi) / Math.max(wFull, 1e-6)).add(v.mul(Math.sin(phi) / Math.max(dFull, 1e-6)));
        if (row.theta !== 0) {
          n = n.mul(Math.cos(row.theta)).add(dir.mul(Math.sin(row.theta) / Math.max(row.capLen, 1e-6)));
        } else {
          n = n.normalized.sub(dir.mul(slope));
        }
        this.positions.push(p);
        this.normals.push(n.normalized);
        const w = blend === undefined ? 0 : Math.max(0, Math.min(0.5, (row.t - blendFrom) / (2 * Math.max(1 - blendFrom, 1e-6))));
        this.joints.push([driver, blend ?? driver]);
        this.weights.push([1 - w, w]);
        this.materials.push(material(Math.max(0, Math.min(1, row.t))));
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let k = 0; k < segments; k++) {
        const a0 = base + i * segments + k, a1 = base + i * segments + ((k + 1) % segments);
        const b0 = a0 + segments, b1 = a1 + segments;
        this.indices.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }

  private ellipsoid(c: V3, r: V3, driver: Joint, segments: number, material: (p: V3) => AvatarMaterial): void {
    const rings = segments;
    const base = this.positions.length;
    for (let i = 0; i <= rings; i++) {
      const theta = -Math.PI / 2 + (Math.PI * i) / rings;
      for (let k = 0; k < segments; k++) {
        const phi = (2 * Math.PI * k) / segments;
        const unit = new V3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
        const p = c.add(new V3(unit.x * r.x, unit.y * r.y, unit.z * r.z));
        this.positions.push(p);
        this.normals.push(new V3(unit.x / r.x, unit.y / r.y, unit.z / r.z).normalized);
        this.joints.push([driver, driver]);
        this.weights.push([1, 0]);
        this.materials.push(material(p));
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let k = 0; k < segments; k++) {
        const a0 = base + i * segments + k, a1 = base + i * segments + ((k + 1) % segments);
        const b0 = a0 + segments, b1 = a1 + segments;
        this.indices.push(a0, a1, b0, a1, b1, b0);
      }
    }
  }

  /**
   * Flat typed arrays for a GPU mesh (Three.js BufferGeometry): xyz positions and normals, two joint indices and two
   * weights per vertex, a material per vertex, and triangle indices. Web addition; the data is the mesh above.
   */
  buffers(): {
    positions: Float32Array; normals: Float32Array; joints: Uint16Array; weights: Float32Array;
    materials: Uint8Array; indices: Uint32Array;
  } {
    const n = this.positions.length;
    const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
    const joints = new Uint16Array(n * 2), weights = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = this.positions[i], q = this.normals[i];
      positions.set([p.x, p.y, p.z], i * 3);
      normals.set([q.x, q.y, q.z], i * 3);
      joints.set(this.joints[i], i * 2);
      weights.set(this.weights[i], i * 2);
    }
    return { positions, normals, joints, weights, materials: Uint8Array.from(this.materials), indices: Uint32Array.from(this.indices) };
  }
}
