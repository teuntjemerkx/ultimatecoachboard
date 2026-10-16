// Port of Spatial/PostureLibrary.swift (`SkeletonModel.solveStance` is a method of SkeletonModel in skeleton.ts).
import libraryFile from "../resources/postures/library.json";
import { Quat, V3 } from "./math3d";
import { allJoints, Joint, type SkeletonModel } from "./skeleton";

/** Root motion of a research posture (JSON keys as in the library). */
export interface PostureSpecRoot {
  jump_m?: number;
  stance_width_m?: number;
  stagger_m?: number;
  yaw_deg?: number;
}

/**
 * One posture of the research library (resources/postures/library.json, built by Verification/build_postures.py).
 * Angles are anatomical degrees relative to the standing anatomical position (Verification/postures/SCHEMA.md).
 */
export interface PostureSpec {
  id: string;
  name: string;
  phase?: string;
  description?: string;
  root?: PostureSpecRoot;
  angles: Record<string, number>;
  confidence?: string;
  evidence?: string[];
}

const rx = (a: number): Quat => Quat.fromAxisAngle(new V3(1, 0, 0), a);
const ry = (a: number): Quat => Quat.fromAxisAngle(new V3(0, 1, 0), a);
const rz = (a: number): Quat => Quat.fromAxisAngle(new V3(0, 0, 1), a);

export const PostureSpec = {
  create(id: string, name: string, angles: Record<string, number>, root?: PostureSpecRoot): PostureSpec {
    return root === undefined ? { id, name, angles } : { id, name, root, angles };
  },

  jump(spec: PostureSpec): number {
    return Math.max(0, spec.root?.jump_m ?? 0);
  },

  /**
   * Anatomical angles to local joint rotations of the 17-joint skeleton (body frame: facing +Z, left +X, up +Y; limbs
   * hang along -Y at rest). Grounded postures are finished by two-bone leg IK that puts both feet at the stance width
   * and stagger, flat on the floor.
   */
  params(spec: PostureSpec, s: SkeletonModel): PoseParams {
    const deg = (key: string): number => ((spec.angles[key] ?? 0) * Math.PI) / 180;
    const r = new Map<Joint, Quat>();
    const lateral = deg("trunk_lateral") / 2, twist = deg("trunk_twist") / 2;
    // Trunk lean: the lower trunk tilts by lumbar_flex from the hips, the upper trunk adds thoracic_flex at the lumbar
    // joint, so the thorax leans lumbar + thoracic from vertical. Hip angles are measured from vertical, so they are
    // compensated for the tilt.
    const lumbar = deg("lumbar_flex");
    const yawAngle = ((spec.root?.yaw_deg ?? 0) * Math.PI) / 180;
    r.set(Joint.pelvis, ry(yawAngle).mul(rx(lumbar)));
    r.set(Joint.spine, rx(deg("thoracic_flex")).mul(rz(lateral)).mul(ry(-twist)));
    r.set(Joint.chest, rz(lateral).mul(ry(-twist)));
    r.set(Joint.neck, rx(deg("neck_flex") / 2));
    r.set(Joint.head, rx(deg("neck_flex") / 2));
    for (const left of [true, false]) {
      const p = left ? "l_" : "r_", side = left ? 1.0 : -1.0;
      r.set(left ? Joint.lShoulder : Joint.rShoulder,
        rx(-deg(p + "shoulder_flex")).mul(rz(side * deg(p + "shoulder_abd"))).mul(ry(side * deg(p + "shoulder_ext_rot"))));
      r.set(left ? Joint.lElbow : Joint.rElbow, rx(-deg(p + "elbow_flex")));
      r.set(left ? Joint.lWrist : Joint.rWrist, rx(deg(p + "wrist_ext")));
      r.set(left ? Joint.lHip : Joint.rHip,
        rx(-lumbar).mul(rx(-deg(p + "hip_flex"))).mul(rz(side * deg(p + "hip_abd"))).mul(ry(side * deg(p + "hip_ext_rot"))));
      r.set(left ? Joint.lKnee : Joint.rKnee, rx(deg(p + "knee_flex")));
      r.set(left ? Joint.lAnkle : Joint.rAnkle, rx(-deg(p + "ankle_dorsi")));
    }
    const params = new PoseParams(r, PostureSpec.jump(spec));
    if (!params.airborne) {
      s.solveStance(params, spec.root?.stance_width_m, spec.root?.stagger_m, ry(yawAngle));
    }
    return params;
  },
};

/** Anthropometrics of a position from the research (metres, keyed by group such as "elite_men"). */
export interface PositionTraits {
  stature_m?: Record<string, number>;
  standing_reach_m?: Record<string, number>;
  spike_reach_m?: Record<string, number>;
  block_reach_m?: Record<string, number>;
  build_notes?: string;
}

/** Swift `PostureLibrary.Position`. */
export interface PostureLibraryPosition {
  traits?: PositionTraits;
  techniques: PostureSpec[];
}

/** The library file (Swift `PostureLibrary.File`). */
export interface PostureLibraryFile {
  version: number;
  positions: Record<string, PostureLibraryPosition>;
}

function decodeLibrary(value: unknown): Record<string, PostureLibraryPosition> {
  const file = value as Partial<PostureLibraryFile> | null;
  if (!file || typeof file.version !== "number" || typeof file.positions !== "object" || file.positions === null) return {};
  for (const position of Object.values(file.positions)) {
    if (!Array.isArray(position.techniques)) return {};
    for (const t of position.techniques) {
      if (typeof t.id !== "string" || typeof t.name !== "string" || typeof t.angles !== "object") return {};
    }
  }
  return file.positions;
}

/** The research-based posture library: technique id -> position -> posture. */
export class PostureLibrary {
  positions: Record<string, PostureLibraryPosition>;

  constructor(positions: Record<string, PostureLibraryPosition>) {
    this.positions = positions;
  }

  private static sharedInstance: PostureLibrary | undefined;

  /** The library shipped in resources/postures/library.json (empty when it cannot be read). */
  static get shared(): PostureLibrary {
    if (!PostureLibrary.sharedInstance) PostureLibrary.sharedInstance = new PostureLibrary(decodeLibrary(libraryFile));
    return PostureLibrary.sharedInstance;
  }

  /** Positions in the order they are preferred when the player's own position has no variant of a technique. */
  static readonly fallbackOrder = ["outside_hitter", "opposite", "middle_blocker", "setter", "libero"];

  /** Role code (template roles such as "S", "OH1", "MB2", "OPP", "L") to research position. */
  static position(role: string | undefined): string | undefined {
    if (role === undefined) return undefined;
    if (role.startsWith("OH")) return "outside_hitter";
    if (role.startsWith("MB") || (role.startsWith("M") && [...role].length <= 2)) return "middle_blocker";
    if (role.startsWith("OPP") || role === "O") return "opposite";
    if (role.startsWith("S")) return "setter";
    if (role === "L" || role === "DS") return "libero";
    return undefined;
  }

  /** The variant of a technique for a role's position, else the first measured variant, else any variant. */
  spec(technique: string, role: string | undefined): PostureSpec | undefined {
    const p = PostureLibrary.position(role);
    if (p !== undefined) {
      const s = this.positions[p]?.techniques.find((t) => t.id === technique);
      if (s) return s;
    }
    const all = PostureLibrary.fallbackOrder
      .map((pos) => this.positions[pos]?.techniques.find((t) => t.id === technique))
      .filter((t): t is PostureSpec => t !== undefined);
    return all.find((t) => t.confidence?.startsWith("measured") === true) ?? all[0];
  }
}

/** Joint rotations plus root motion for one instant: what `SkeletonModel.pose` consumes. */
export class PoseParams {
  rotations: Map<Joint, Quat>;
  /** Feet above the floor (metres). */
  jump: number;

  constructor(rotations: Map<Joint, Quat>, jump = 0) {
    this.rotations = rotations;
    this.jump = jump;
  }

  /** Grounded postures get flat feet; airborne ones keep their ankle angles (pointed toes). */
  get airborne(): boolean {
    return this.jump > 0.02;
  }

  /** Joint-wise slerp and a linear jump (Section 3.3: postures blend by quaternion slerp per joint). */
  static blend(a: PoseParams, b: PoseParams, t0: number): PoseParams {
    const t = Math.max(0, Math.min(1, t0));
    if (t === 0) return a;
    if (t === 1) return b;
    const r = new Map<Joint, Quat>();
    for (const j of allJoints) {
      const qa = a.rotations.get(j) ?? Quat.identity, qb = b.rotations.get(j) ?? Quat.identity;
      r.set(j, qa.slerp(qb, t));
    }
    return new PoseParams(r, a.jump + (b.jump - a.jump) * t);
  }
}
