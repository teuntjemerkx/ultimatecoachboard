// Web addition (no Swift counterpart): the 3D players' real bodies. The app draws MakeHuman athletes (a woman and a man,
// web/public/athletes) driven by the board's 17-joint skeleton; this is where every bone of an athlete stands for a
// posed player, and the capsules that enclose its body (skin, clothes, shoes, hair) there. The rigs and capsules are
// measured from the models by web/tools/athletes/fit_bodies.ts (resources/athletes/*.json, loaded by athleteRigs.ts). The renderer and the body
// separation both use these numbers, so what the separation keeps apart is exactly what is drawn.
import type { BodyCapsule } from "./bodySeparation";
import { Quat, Rigid, V3 } from "./math3d";
import type { PosedPlayer } from "./povAnalysis";
import { BodyMetrics, Joint, SkeletonModel } from "./skeleton";

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

/** How a bone of the athlete's rig follows the board's skeleton. */
export type BoneMode =
  /** Turns as its board joint has turned since the rest pose. */
  | "joint"
  /** Halfway between the board's spine and chest (spine_02). */
  | "spine"
  /** With the chest, lifted as the arm rises (clavicles). */
  | "clavicle"
  /** Keeps its bind-pose turn relative to its parent (fingers, toes). */
  | "bind"
  /** The rig's root: keeps its bind-pose world rotation. */
  | "root";

export interface AthleteBone {
  name: string;
  /** Index of the parent bone, -1 for the root. */
  parent: number;
  mode: BoneMode;
  /** The board joint driving it ("joint" mode). */
  joint?: number;
  /** Clavicles: +1 left (outer end at +X), -1 right. */
  side?: number;
  /** Translation from the parent bone (or, for the root, from the model's origin) in the parent's frame, metres. */
  local: Vec3;
  /** World rotation with the model standing in the board skeleton's rest pose (arms down, facing +Z). */
  restWorld: Vec4;
  /** Rotation relative to the parent in the bind pose (fingers relaxed). */
  bindLocal: Vec4;
}

/** A capsule end: a point fixed to a bone, given where it is in the bind pose (model at the origin, unscaled). */
export interface CapsuleEnd {
  bone: number;
  at: Vec3;
}

export interface AthleteCapsule {
  a: CapsuleEnd;
  b: CapsuleEnd;
  /** Radius at the model's own size, metres (scaled with the player). */
  r: number;
  /** Trunk, neck or head: may never reach through the net. */
  core: boolean;
}

export interface AthleteRig {
  name: string;
  /** Height of the body (skin, no hair) in the bind pose. */
  stature: number;
  /** Mean height of the two foot bones' heads in the bind pose. */
  ankle: number;
  /** Height of the lowest point of the model (the shoe soles) in the bind pose. */
  sole: number;
  bones: AthleteBone[];
  /** Bind-pose world position and rotation of every bone (model at the origin, unscaled). */
  bindPosition: Vec3[];
  bindRotation: Vec4[];
  capsules: AthleteCapsule[];
  /** Shirt numbers: the chest bone, and the shirt's front and back z at its height in the bind pose. */
  chestBone: number;
  chestFront: number;
  chestBack: number;
}

const q4 = (v: Vec4) => new Quat(v[0], v[1], v[2], v[3]);
const v3 = (v: Vec3) => new V3(v[0], v[1], v[2]);

/** A rig's numbers as the posing needs them, built once per rig (posing runs for every player many times a second). */
interface RigParts {
  restWorld: Quat[];
  bindLocal: Quat[];
  local: V3[];
  pelvisBone: number;
  /** Each capsule end in its bone's bind frame. */
  ends: { a: V3; b: V3 }[];
}

const rigParts = new WeakMap<AthleteRig, RigParts>();

function partsOf(rig: AthleteRig): RigParts {
  let parts = rigParts.get(rig);
  if (!parts) {
    const inBone = (end: CapsuleEnd) => q4(rig.bindRotation[end.bone]).conjugate.rotate(v3(end.at).sub(v3(rig.bindPosition[end.bone])));
    parts = {
      restWorld: rig.bones.map((b) => q4(b.restWorld)), bindLocal: rig.bones.map((b) => q4(b.bindLocal)),
      local: rig.bones.map((b) => v3(b.local)), pelvisBone: rig.bones.findIndex((b) => b.name === "pelvis"),
      ends: rig.capsules.map((c) => ({ a: inBone(c.a), b: inBone(c.b) })),
    };
    rigParts.set(rig, parts);
  }
  return parts;
}

/** The board skeleton's rest pose (standing, arms down, facing +Z); its rotations do not depend on stature. */
const reference = new SkeletonModel(new BodyMetrics(1.8));
const referenceRest = reference.restPose;

/** An athlete posed for a board player. */
export interface AthletePose {
  /** Uniform scale of the model (the player's stature over the model's). */
  scale: number;
  /** Where the model's origin goes (it is scaled about it, not turned). */
  origin: V3;
  /** Every bone's rotation relative to its parent, for the renderer. */
  local: Quat[];
  /** Every bone's world rotation and world position. */
  world: Rigid[];
}

/**
 * Every bone of the athlete for a posed board player: scaled to the player's stature; each joint-driven bone turned as
 * its joint has turned since the rest pose; spine_02 halfway between spine and chest; the collarbones with the chest,
 * rising with the arm (above 30 degrees of arm elevation, a third of the rest); fingers and toes as in the bind pose.
 * The pelvis stands over the skeleton's and rises and falls with it; standing, the shoe soles are on the floor.
 */
export function poseAthlete(rig: AthleteRig, p: PosedPlayer): AthletePose {
  const J = p.joints;
  const h = p.skeleton.metrics.stature;
  const scale = h / rig.stature;
  const turns = new Map<number, Quat>();
  const turn = (j: number): Quat => {
    let r = turns.get(j);
    if (!r) {
      r = J[j].rotation.mul(referenceRest[j].rotation.conjugate).normalized;
      turns.set(j, r);
    }
    return r;
  };
  // The origin: the pelvis bone head over the skeleton's pelvis; vertically as high as the skeleton's pelvis is above
  // its standing height, so a standing athlete's soles touch the floor and a jump lifts it as much.
  const parts = partsOf(rig);
  const pelvisBind = v3(rig.bindPosition[parts.pelvisBone]);
  const pelvis = J[Joint.pelvis].translation;
  const restPelvis = p.skeleton.restPose[Joint.pelvis].translation.y;
  const origin = new V3(pelvis.x - pelvisBind.x * scale, pelvis.y - restPelvis - rig.sole * scale, pelvis.z - pelvisBind.z * scale);

  const world: Rigid[] = [];
  rig.bones.forEach((b, i) => {
    const parent = b.parent >= 0 ? world[b.parent] : undefined;
    let w: Quat;
    switch (b.mode) {
      case "joint": w = turn(b.joint!).mul(parts.restWorld[i]); break;
      case "spine": w = turn(Joint.spine).slerp(turn(Joint.chest), 0.5).mul(parts.restWorld[i]); break;
      case "clavicle": {
        const left = (b.side ?? 1) > 0;
        const chest = turn(Joint.chest);
        const arm = J[left ? Joint.lElbow : Joint.rElbow].translation.sub(J[left ? Joint.lShoulder : Joint.rShoulder].translation).normalized;
        const down = chest.rotate(new V3(0, -1, 0));
        const elevation = Math.acos(Math.max(-1, Math.min(1, arm.dot(down))));
        const lift = Math.max(0, elevation - Math.PI / 6) / 3;
        w = Quat.fromAxisAngle(chest.rotate(new V3(0, 0, 1)), left ? lift : -lift).mul(chest).mul(parts.restWorld[i]);
        break;
      }
      case "root": w = parts.restWorld[i]; break;
      default: w = (parent ? parent.rotation : Quat.identity).mul(parts.bindLocal[i]);
    }
    w = w.normalized;
    const position = parent
      ? parent.translation.add(parent.rotation.rotate(parts.local[i].mul(scale)))
      : origin.add(parts.local[i].mul(scale));
    world.push(new Rigid(w, position));
  });
  // The renderer's rotations relative to the parents, worked out only when asked for (the body separation never is).
  let local: Quat[] | undefined;
  return {
    scale, origin, world,
    get local() {
      local ??= rig.bones.map((b, i) => (b.parent >= 0 ? world[b.parent].rotation.conjugate.mul(world[i].rotation).normalized : world[i].rotation));
      return local;
    },
  };
}

/** A bind-pose point (given in its bone's bind frame, see RigParts) carried by its bone into a posed athlete. */
function carry(pose: AthletePose, bone: number, inBone: V3): V3 {
  const b = pose.world[bone];
  // Out through the bone's posed frame, scaled like the model.
  return b.translation.add(b.rotation.rotate(inBone).mul(pose.scale));
}

/** The capsules enclosing a posed athlete's body (skin, clothes, shoes and hair), in world metres. */
export function athleteCapsules(rig: AthleteRig, p: PosedPlayer, pose: AthletePose = poseAthlete(rig, p)): BodyCapsule[] {
  const ends = partsOf(rig).ends;
  return rig.capsules.map((c, i) => ({
    a: carry(pose, c.a.bone, ends[i].a), b: carry(pose, c.b.bone, ends[i].b), r: c.r * pose.scale, core: c.core,
  }));
}
