/**
 * Measures the two athletes (web/public/athletes/*.glb) for the app's core: their rig as the board's skeleton drives
 * it, and capsules that enclose every vertex of the body (skin, clothes, shoes, hair) in every posture. Writes
 * web/src/core/resources/athletes/{female,male}.json.
 *
 *   cd web && npx vite-node tools/athletes/fit_bodies.ts
 *
 * Run it again whenever make_athlete.py has made new models.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Quat, Rigid, V3 } from "../../src/core/spatial/math3d";
import { BodyMetrics, Joint, SkeletonModel, type Posture } from "../../src/core/spatial/skeleton";
import { PosedPlayer } from "../../src/core/spatial/povAnalysis";
import { PoseParams } from "../../src/core/spatial/postureLibrary";
import { strideParams } from "../../src/core/spatial/gait";
import { Posture as PostureOps } from "../../src/core/spatial/skeleton";
import { SceneToken } from "../../src/core/zones/tacticalScene";
import { parseGlb, type GlbSkinned } from "../../src/core/spatial/glb";
import { poseAthlete, type AthleteBone, type AthleteCapsule, type AthleteRig, type BoneMode, type CapsuleEnd } from "../../src/core/spatial/athleteBody";
import { skinnedPositions } from "../../src/core/spatial/athleteSkin";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");

const jointBones: [number, string][] = [
  [Joint.pelvis, "pelvis"], [Joint.spine, "spine_01"], [Joint.chest, "spine_03"], [Joint.neck, "neck_01"], [Joint.head, "head"],
  [Joint.lShoulder, "upperarm_l"], [Joint.lElbow, "lowerarm_l"], [Joint.lWrist, "hand_l"],
  [Joint.rShoulder, "upperarm_r"], [Joint.rElbow, "lowerarm_r"], [Joint.rWrist, "hand_r"],
  [Joint.lHip, "thigh_l"], [Joint.lKnee, "calf_l"], [Joint.lAnkle, "foot_l"],
  [Joint.rHip, "thigh_r"], [Joint.rKnee, "calf_r"], [Joint.rAnkle, "foot_r"],
];
const directionTo: Record<string, string> = {
  upperarm_l: "lowerarm_l", lowerarm_l: "hand_l", hand_l: "middle_01_l",
  upperarm_r: "lowerarm_r", lowerarm_r: "hand_r", hand_r: "middle_01_r",
  thigh_l: "calf_l", calf_l: "foot_l", foot_l: "ball_l",
  thigh_r: "calf_r", calf_r: "foot_r", foot_r: "ball_r",
};

const reference = new SkeletonModel(new BodyMetrics(1.8));
const rest = reference.restPose;

function restDirection(j: number): V3 | undefined {
  const h = reference.metrics.stature;
  const child: Partial<Record<number, number>> = {
    [Joint.lShoulder]: Joint.lElbow, [Joint.lElbow]: Joint.lWrist, [Joint.rShoulder]: Joint.rElbow, [Joint.rElbow]: Joint.rWrist,
    [Joint.lHip]: Joint.lKnee, [Joint.lKnee]: Joint.lAnkle, [Joint.rHip]: Joint.rKnee, [Joint.rKnee]: Joint.rAnkle,
  };
  const c = child[j];
  if (c !== undefined) return rest[c].translation.sub(rest[j].translation).normalized;
  if (j === Joint.lWrist || j === Joint.rWrist) return rest[j].rotation.rotate(new V3(0, -1, 0)).normalized;
  if (j === Joint.lAnkle || j === Joint.rAnkle) return rest[j].rotation.rotate(new V3(0, -0.006 * h, 0.15 * h)).normalized;
  return undefined;
}

/** The rotation taking unit vector a onto unit vector b by the shortest way. */
function fromUnitVectors(a: V3, b: V3): Quat {
  const r = a.dot(b) + 1;
  if (r < 1e-6) return (Math.abs(a.x) > Math.abs(a.z) ? new Quat(-a.y, a.x, 0, 0) : new Quat(0, -a.z, a.y, 0)).normalized;
  const c = a.cross(b);
  return new Quat(c.x, c.y, c.z, r).normalized;
}

const projectOnPlane = (v: V3, n: V3) => v.sub(n.mul(v.dot(n)));
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const vec = (v: V3): [number, number, number] => [r5(v.x), r5(v.y), r5(v.z)];
const quat = (q: Quat): [number, number, number, number] => [r5(q.x), r5(q.y), r5(q.z), r5(q.w)];

/** The arms' joints: their rest directions are turned outward (left arm toward +X), the upper arm or the forearm's. */
const armJoints = new Map<number, [number, "upper" | "fore"]>([
  [Joint.lShoulder, [1, "upper"]], [Joint.lElbow, [1, "fore"]], [Joint.lWrist, [1, "fore"]],
  [Joint.rShoulder, [-1, "upper"]], [Joint.rElbow, [-1, "fore"]], [Joint.rWrist, [-1, "fore"]],
]);

/** How far out the hanging arms turn in the front plane, radians: the upper arms, and the forearms and hands. */
interface Hang {
  upper: number;
  fore: number;
}

/**
 * The athlete's rig: every bone at rest where the board skeleton's rest pose has it, the arms (straight down on the
 * board) turned out by `hang` in the front plane so they hang beside this body instead of in it.
 * `withCapsules: false` skips the capsule fit (for measuring the hang).
 */
function build(name: string, glb: GlbSkinned, hang: Hang, withCapsules = true): AthleteRig {
  const { nodes } = glb;
  // Bind-pose world transforms (the files carry no scale).
  const worldR: Quat[] = [], worldT: V3[] = [];
  const visitNode = (i: number) => {
    const n = nodes[i];
    if (n.scale.some((s) => Math.abs(s - 1) > 1e-3)) throw new Error(`${n.name} is scaled`);
    const r = new Quat(...n.rotation), t = new V3(...n.translation);
    worldR[i] = n.parent >= 0 ? worldR[n.parent].mul(r).normalized : r;
    worldT[i] = n.parent >= 0 ? worldT[n.parent].add(worldR[n.parent].rotate(t)) : t;
    for (const c of n.children) visitNode(c);
  };
  nodes.forEach((n, i) => { if (n.parent < 0) visitNode(i); });
  // Bones: the skin's joints, parent first.
  const jointNodes = new Set(glb.skinJoints);
  const rootNode = glb.skinJoints.find((j) => !jointNodes.has(nodes[j].parent))!;
  const order: number[] = [];
  const walk = (i: number) => { order.push(i); for (const c of nodes[i].children) if (jointNodes.has(c)) walk(c); };
  walk(rootNode);
  const index = new Map(order.map((node, k) => [nodes[node].name, k]));
  const nodeOf = (bone: string) => order[index.get(bone)!];
  const P = (bone: string) => worldT[nodeOf(bone)];
  const R = (bone: string) => worldR[nodeOf(bone)];
  const jointOf = new Map(jointBones.map(([j, b]) => [b, j]));

  const carry = new Map<string, Quat>();
  const bones: AthleteBone[] = order.map((node) => {
    const n = nodes[node];
    const parentBone = jointNodes.has(n.parent) ? nodes[n.parent].name : undefined;
    const carried = parentBone ? carry.get(parentBone)! : Quat.identity;
    let restWorld = carried.mul(worldR[node]).normalized;
    const joint = jointOf.get(n.name);
    const to = directionTo[n.name];
    if (joint !== undefined && to && index.has(to)) {
      let want = restDirection(joint);
      const arm = armJoints.get(joint);
      if (want && arm) want = Quat.fromAxisAngle(new V3(0, 0, 1), arm[0] * hang[arm[1]]).rotate(want).normalized;
      if (want) restWorld = fromUnitVectors(carried.rotate(P(to).sub(worldT[node])).normalized, want).mul(restWorld).normalized;
    }
    carry.set(n.name, restWorld.mul(worldR[node].conjugate).normalized);
    const mode: BoneMode = !parentBone ? "root" : joint !== undefined ? "joint" : n.name === "spine_02" ? "spine"
      : n.name.startsWith("clavicle_") ? "clavicle" : "bind";
    const bone: AthleteBone = {
      name: n.name, parent: parentBone ? index.get(parentBone)! : -1, mode,
      local: vec(parentBone ? new V3(...n.translation) : worldT[node]), restWorld: quat(restWorld), bindLocal: quat(new Quat(...n.rotation)),
    };
    if (joint !== undefined) bone.joint = joint;
    if (mode === "clavicle") bone.side = n.name.endsWith("_l") ? 1 : -1;
    return bone;
  });

  // Relaxed hands (as the app showed them when they were chosen): fingers curled a little toward the palm, the spread
  // fingers closed halfway toward the middle finger, the thumb barely bent.
  const deg = Math.PI / 180;
  for (const side of ["l", "r"]) {
    const hand = P(`hand_${side}`);
    const along = P(`middle_01_${side}`).sub(hand).normalized;
    const across = P(`index_01_${side}`).sub(P(`pinky_01_${side}`)).normalized;
    let palm = along.cross(across).normalized;
    if (palm.dot(P(`thumb_02_${side}`).sub(hand)) < 0) palm = palm.neg();
    const middle = P(`middle_02_${side}`).sub(P(`middle_01_${side}`)).normalized;
    const fingers: [string, number[]][] = [
      ["index", [6, 16, 12]], ["middle", [8, 18, 12]], ["ring", [10, 20, 14]], ["pinky", [12, 22, 14]], ["thumb", [0, 6, 6]],
    ];
    for (const [finger, angles] of fingers) {
      const names = [1, 2, 3].map((k) => `${finger}_0${k}_${side}`);
      if (!names.every((x) => index.has(x))) continue;
      let dir = P(names[1]).sub(P(names[0])).normalized;
      let spread = Quat.identity;
      if (finger !== "middle" && finger !== "thumb") {
        const a = projectOnPlane(dir, palm).normalized, b = projectOnPlane(middle, palm).normalized;
        spread = Quat.identity.slerp(fromUnitVectors(a, b), 0.5).normalized;
        dir = spread.rotate(dir);
      }
      const axis = dir.cross(palm).normalized;
      let parentWorld = R(`hand_${side}`);
      let total = 0;
      names.forEach((x, k) => {
        total += angles[k] * deg;
        const world = Quat.fromAxisAngle(axis, total).mul(spread).mul(R(x)).normalized;
        bones[index.get(x)!].bindLocal = quat(parentWorld.conjugate.mul(world).normalized);
        parentWorld = world;
      });
    }
  }

  const rig: AthleteRig = {
    name, stature: 0, ankle: (P("foot_l").y + P("foot_r").y) / 2, sole: 0, bones,
    bindPosition: order.map((node) => vec(worldT[node])), bindRotation: order.map((node) => quat(worldR[node])),
    capsules: [], chestBone: index.get("spine_03")!, chestFront: 0, chestBack: 0,
  };
  // The bind pose through the skinning: stature, the shirt at the chest.
  const bindPose = order.map((node) => new Rigid(worldR[node], worldT[node]));
  const meshWorld = meshBindWorld(glb, worldR, worldT);
  let top = -Infinity, low = Infinity, front = -Infinity, back = Infinity;
  const chest = P("spine_03");
  for (const m of glb.meshes) {
    const pts = skinnedPositions(glb, m, order, bindPose, 1, meshWorld);
    for (const p of pts) {
      if (m.material === "Skin") top = Math.max(top, p.y);
      low = Math.min(low, p.y);
      if (m.material === "Shirt" && Math.abs(p.y - chest.y) < 0.05 && Math.abs(p.x - chest.x) < 0.06) {
        front = Math.max(front, p.z);
        back = Math.min(back, p.z);
      }
    }
  }
  if (withCapsules) console.log(`${name}: stature ${top.toFixed(3)} m, lowest point ${low.toFixed(3)} m, pelvis ${P("pelvis").y.toFixed(3)} m`);
  if (Math.abs(low) > 0.02) throw new Error(`${name}: the model does not stand on the floor (lowest ${low})`);
  rig.stature = r5(top);
  rig.sole = 0;
  rig.sole = r5(standingSole(rig, glb, order, meshWorld));
  rig.ankle = r5(rig.ankle);
  rig.chestFront = r5(front);
  rig.chestBack = r5(back);
  if (withCapsules) rig.capsules = fitCapsules(rig, glb, order, meshWorld, P);
  return rig;
}

/**
 * How far the arms of an athlete standing in the rest pose stay clear of the trunk, hips and legs beside them, metres
 * (the least over both arms; negative: in the body): the upper arms below the armpits, and the forearms and hands.
 * Compared at the same height and depth, so a hand in front of a thigh is clear of it.
 */
function armClearance(rig: AthleteRig, glb: GlbSkinned): Record<"upper" | "fore", number> {
  const order = rig.bones.map((b) => glb.nodes.findIndex((n) => n.name === b.name));
  const s = new SkeletonModel(new BodyMetrics(rig.stature));
  const token = SceneToken.create({ side: "home", label: "0", role: "", point: { x: 0, z: 0 } });
  const pose = poseAthlete(rig, new PosedPlayer(token, s, s.restPose));
  const names = glb.skinJoints.map((node) => glb.nodes[node].name);
  const lowerArm = (n: string) => /^(lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(n);
  const upperArm = (n: string) => /^upperarm_/.test(n);
  const anyArm = (n: string) => lowerArm(n) || upperArm(n) || /^clavicle_/.test(n);
  // The armpit: a tenth of the stature under the shoulder joint; above it the upper arm joins the trunk.
  const shoulder = pose.world[rig.bones.findIndex((b) => b.name === "upperarm_l")].translation.y;
  const armpit = shoulder - 0.1 * rig.stature;
  // The body beside the arms (no arm, neck or head), binned by height and depth (1 cm): the farthest out on each side.
  const cell = 0.01;
  const outer = [new Map<string, number>(), new Map<string, number>()];
  const arms: { p: V3; side: number; part: "upper" | "fore" }[] = [];
  for (const m of glb.meshes) {
    if (!["Skin", "Shirt", "Shorts"].includes(m.material)) continue;
    const pts = skinnedPositions(glb, m, order, pose.world, pose.scale, Rigid.identity);
    pts.forEach((p, i) => {
      let best = 0, bone = "";
      for (let k = 0; k < 4; k++) if (m.weights[4 * i + k] > best) { best = m.weights[4 * i + k]; bone = names[m.joints[4 * i + k]]; }
      if (lowerArm(bone)) arms.push({ p, side: bone.endsWith("_l") ? 1 : -1, part: "fore" });
      else if (upperArm(bone) && p.y < armpit) arms.push({ p, side: bone.endsWith("_l") ? 1 : -1, part: "upper" });
      else if (!anyArm(bone) && bone !== "head" && bone !== "neck_01") {
        const side = p.x >= 0 ? 0 : 1, key = `${Math.round(p.y / cell)}|${Math.round(p.z / cell)}`;
        const x = Math.abs(p.x);
        if (x > (outer[side].get(key) ?? -Infinity)) outer[side].set(key, x);
      }
    });
  }
  const least = { upper: Infinity, fore: Infinity };
  for (const { p, side, part } of arms) {
    const bins = outer[side > 0 ? 0 : 1];
    const y0 = Math.round(p.y / cell), z0 = Math.round(p.z / cell);
    let body = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -3; dz <= 3; dz++) body = Math.max(body, bins.get(`${y0 + dy}|${z0 + dz}`) ?? -Infinity);
    if (body > -Infinity) least[part] = Math.min(least[part], side * p.x - body);
  }
  return least;
}

/**
 * The least outward turns of the hanging arms (half-degree steps, at most 20 degrees): the upper arms just beside the
 * trunk (touching it, not in it), then the forearms and hands 1 cm clear of the hips and thighs.
 */
function hangAngle(name: string, glb: GlbSkinned): Hang {
  const deg = Math.PI / 180;
  const search = (clear: (a: number) => boolean) => {
    for (let a = 0; a <= 20 + 1e-9; a += 0.5) if (clear(a * deg)) return a * deg;
    throw new Error(`${name}: the arms do not clear the body`);
  };
  const upper = search((a) => armClearance(build(name, glb, { upper: a, fore: a }, false), glb).upper >= 0);
  const fore = search((a) => armClearance(build(name, glb, { upper, fore: a }, false), glb).fore >= 0.01);
  const clear = armClearance(build(name, glb, { upper, fore }, false), glb);
  console.log(`${name}: upper arms hang ${(upper / deg).toFixed(1)} degrees out (${(clear.upper * 100).toFixed(1)} cm clear), `
    + `forearms ${(fore / deg).toFixed(1)} (${(clear.fore * 100).toFixed(1)} cm)`);
  return { upper, fore };
}

/**
 * Where the meshes are bound: three.js skins a glTF mesh from its vertices as stored (the inverse bind matrices already
 * account for the rig node above it), so the bind transform is the identity. The stature and floor checks in `build`
 * would catch a model exported otherwise.
 */
function meshBindWorld(_glb: GlbSkinned, _worldR: Quat[], _worldT: V3[]): Rigid {
  return Rigid.identity;
}

/** The lowest point of the athlete standing in the skeleton's rest pose with the origin at the floor (scale 1). */
function standingSole(rig: AthleteRig, glb: GlbSkinned, order: number[], meshWorld: Rigid): number {
  const s = new SkeletonModel(new BodyMetrics(rig.stature));
  const token = SceneToken.create({ side: "home", label: "0", role: "", point: { x: 0, z: 0 } });
  const pose = poseAthlete(rig, new PosedPlayer(token, s, s.restPose));
  let low = Infinity;
  for (const m of glb.meshes) for (const v of skinnedPositions(glb, m, order, pose.world, pose.scale, meshWorld)) low = Math.min(low, v.y);
  return low;
}

/** Every posture of the board, in each role's research variant, and halfway between postures that follow each other. */
function fittingPoses(stature: number): PosedPlayer[] {
  const postures: Posture[] = ["standing", "ready", "pass", "set", "attack", "block", "dig", "reach", "readyHigh", "lowDefence",
    "angledPass", "overheadPass", "sprawl", "backSet", "jumpSet", "approach", "armCock", "landing", "quickAttack", "blockReady",
    "blockLanding", "floatServe", "jumpServe", "cover"];
  const roles = ["OH1", "MB1", "S", "L", "OPP"];
  const s = new SkeletonModel(new BodyMetrics(stature));
  const out: PosedPlayer[] = [];
  const add = (what: Posture | PoseParams, role: string) => {
    const token = SceneToken.create({ side: "home", label: "0", role, point: { x: 0, z: 0 } });
    out.push(new PosedPlayer(token, s, s.pose(what, token.point, 0, 0, role)));
  };
  for (const role of roles) {
    for (const p of postures) add(p, role);
    for (let k = 0; k + 1 < postures.length; k++) {
      add(PoseParams.blend(PostureOps.params(postures[k], s, role), PostureOps.params(postures[k + 1], s, role), 0.5), role);
    }
  }
  // Players running between spots take steps (spatial/gait.ts): walking to sprinting, forward, sideways and back.
  for (const base of ["ready", "standing", "cover", "blockReady"] as Posture[]) {
    for (const speed of [1.5, 4, 7]) {
      for (const [forward, left] of [[1, 0], [0, 1], [-0.7, 0.7]]) {
        for (let k = 0; k < 6; k++) {
          const motion = { forward: forward * speed, left: left * speed, phase: (k * Math.PI) / 3 };
          add(strideParams(PostureOps.params(base, s, "OH1"), s, motion), "OH1");
        }
      }
    }
  }
  return out;
}

/** How many capsules each bone's own vertices get (the trunk is wider than deep; shoulders cap the upper arms). */
const clustersPerBone: Record<string, number> = {
  pelvis: 5, spine_01: 3, spine_02: 4, spine_03: 6, neck_01: 2, head: 3,
  clavicle_l: 3, clavicle_r: 3, upperarm_l: 5, upperarm_r: 5, lowerarm_l: 2, lowerarm_r: 2, hand_l: 3, hand_r: 3,
  thigh_l: 5, thigh_r: 5, calf_l: 3, calf_r: 3, foot_l: 2, foot_r: 2, ball_l: 1, ball_r: 1,
};
const coreBones = new Set(["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head"]);

/** The principal axis of a point cloud (power iteration on its covariance). */
function principalAxis(points: readonly V3[]): { mean: V3; axis: V3 } {
  let mean = new V3(0, 0, 0);
  for (const p of points) mean = mean.add(p);
  mean = mean.mul(1 / points.length);
  const c = [0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = p.sub(mean);
    c[0] += d.x * d.x; c[1] += d.x * d.y; c[2] += d.x * d.z; c[3] += d.y * d.y; c[4] += d.y * d.z; c[5] += d.z * d.z;
  }
  let a = new V3(0.3, 1, 0.2).normalized;
  for (let k = 0; k < 50; k++) {
    a = new V3(c[0] * a.x + c[1] * a.y + c[2] * a.z, c[1] * a.x + c[3] * a.y + c[4] * a.z, c[2] * a.x + c[4] * a.y + c[5] * a.z);
    if (a.length < 1e-12) return { mean, axis: new V3(0, 1, 0) };
    a = a.normalized;
  }
  return { mean, axis: a };
}

/** A capsule hugging a point cloud: along its principal axis between the extreme projections, radius to the farthest. */
function hug(points: readonly V3[]): { a: V3; b: V3; r: number } {
  const { mean, axis } = principalAxis(points);
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { const t = p.sub(mean).dot(axis); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  // Shrink the segment until the radius stops paying for it: ends pulled in by the radius they need.
  let a = mean.add(axis.mul(lo)), b = mean.add(axis.mul(hi));
  let r = 0;
  for (let pass = 0; pass < 3; pass++) {
    r = 0;
    for (const p of points) r = Math.max(r, segmentDistance(p, a, b));
    const inset = Math.min(r * 0.8, (hi - lo) / 2);
    a = mean.add(axis.mul(lo + inset));
    b = mean.add(axis.mul(hi - inset));
  }
  r = 0;
  for (const p of points) r = Math.max(r, segmentDistance(p, a, b));
  return { a, b, r };
}

/** k-means on positions, seeded along the principal axis (deterministic). */
function clusters(points: readonly V3[], k: number): V3[][] {
  if (k <= 1 || points.length < 4 * k) return [points.slice()];
  const { mean, axis } = principalAxis(points);
  const sorted = [...points].sort((p, q) => p.sub(mean).dot(axis) - q.sub(mean).dot(axis));
  let centres = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]);
  let groups: V3[][] = [];
  for (let it = 0; it < 25; it++) {
    groups = centres.map(() => []);
    for (const p of points) {
      let best = 0, d = Infinity;
      centres.forEach((c, i) => { const e = p.sub(c).length; if (e < d) { d = e; best = i; } });
      groups[best].push(p);
    }
    centres = groups.map((g, i) => (g.length ? g.reduce((s, p) => s.add(p), new V3(0, 0, 0)).mul(1 / g.length) : centres[i]));
  }
  return groups.filter((g) => g.length >= 3);
}

/**
 * Capsules for the athlete. Every vertex belongs to the bone that moves it most; in every fitting pose it is taken into
 * that bone's own frame, so each bone collects everything it ever carries (skin, clothes, shoes and hair, bent as the
 * joints bend). Each bone's cloud is grouped and hugged by capsules fixed to the bone: enclosed in all fitting poses by
 * construction. A last check over all poses takes in anything the blending moved outside (plus half a centimetre).
 */
function fitCapsules(rig: AthleteRig, glb: GlbSkinned, order: number[], meshWorld: Rigid, _P: (b: string) => V3): AthleteCapsule[] {
  const boneOfNode = new Map(order.map((node, i) => [node, i]));
  const handOf = (i: number) => {
    const m = /^(index|middle|ring|pinky|thumb)_0\d_(l|r)$/.exec(rig.bones[i].name);
    return m ? rig.bones.findIndex((x) => x.name === `hand_${m[2]}`) : i;
  };
  const dominant = glb.meshes.map((m) => {
    const n = m.positions.length / 3;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, w = -1;
      for (let k = 0; k < 4; k++) if (m.weights[4 * i + k] > w) { w = m.weights[4 * i + k]; best = k; }
      out[i] = handOf(boneOfNode.get(glb.skinJoints[m.joints[4 * i + best]])!);
    }
    return out;
  });
  // Clouds in each bone's frame, thinned to one point per 8 mm cell.
  const clouds = rig.bones.map(() => new Map<string, V3>());
  const poses = fittingPoses(rig.stature);
  for (const p of poses) {
    const pose = poseAthlete(rig, p);
    const inv = pose.world.map((w) => w.inverse);
    glb.meshes.forEach((m, mi) => {
      skinnedPositions(glb, m, order, pose.world, pose.scale, meshWorld).forEach((v, i) => {
        const b = dominant[mi][i];
        const local = inv[b].apply(v).mul(1 / pose.scale);
        const key = `${Math.round(local.x / 0.008)},${Math.round(local.y / 0.008)},${Math.round(local.z / 0.008)}`;
        if (!clouds[b].has(key)) clouds[b].set(key, local);
      });
    });
  }
  const caps: AthleteCapsule[] = [];
  rig.bones.forEach((b, i) => {
    const cloud = [...clouds[i].values()];
    if (cloud.length === 0) return;
    const bindRot = new Quat(...rig.bindRotation[i]), bindPos = new V3(...rig.bindPosition[i]);
    const toBind = (local: V3) => vec(bindPos.add(bindRot.rotate(local)));
    for (const g of clusters(cloud, clustersPerBone[b.name] ?? 1)) {
      const c = hug(g);
      caps.push({ a: { bone: i, at: toBind(c.a) }, b: { bone: i, at: toBind(c.b) }, r: c.r, core: coreBones.has(b.name) });
    }
  });
  rig.capsules = caps;
  let grown = 0;
  for (const p of poses) {
    const pose = poseAthlete(rig, p);
    const ends = rig.capsules.map((c) => [carryEnd(rig, pose, c.a), carryEnd(rig, pose, c.b)] as const);
    for (const m of glb.meshes) {
      for (const v of skinnedPositions(glb, m, order, pose.world, pose.scale, meshWorld)) {
        let best = -1, bestD = Infinity;
        ends.forEach(([a, b], k) => {
          const d = segmentDistance(v, a, b) - rig.capsules[k].r * pose.scale;
          if (d < bestD) { bestD = d; best = k; }
        });
        if (bestD > 0) { rig.capsules[best].r += bestD / pose.scale; grown = Math.max(grown, bestD); }
      }
    }
  }
  console.log(`${rig.name}: largest growth in the check ${(grown * 1000).toFixed(1)} mm`);
  return rig.capsules.map((c) => ({ a: c.a, b: c.b, r: r5(c.r + 0.005), core: c.core }));
}

function carryEnd(rig: AthleteRig, pose: ReturnType<typeof poseAthlete>, end: CapsuleEnd): V3 {
  const bone = pose.world[end.bone];
  const offset = new V3(...end.at).sub(new V3(...rig.bindPosition[end.bone]));
  return bone.translation.add(bone.rotation.rotate(new Quat(...rig.bindRotation[end.bone]).conjugate.rotate(offset)).mul(pose.scale));
}

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = b.sub(a), l2 = ab.dot(ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, p.sub(a).dot(ab) / l2)) : 0;
  return p.sub(a.add(ab.mul(t))).length;
}

for (const name of ["female", "male"]) {
  const glb = parseGlb(readFileSync(join(web, "public", "athletes", `${name}.glb`)));
  const rig = build(name, glb, hangAngle(name, glb));
  writeFileSync(join(web, "src", "core", "resources", "athletes", `${name}.json`), JSON.stringify(rig));
  console.log(`${name}: ${rig.bones.length} bones, ${rig.capsules.length} capsules, radii ${rig.capsules.map((c) => `${rig.bones[c.a.bone].name}:${(c.r * 100).toFixed(1)}`).join(" ")} cm`);
}
