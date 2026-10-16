// Port of CoachBoardCoreTests/SpatialTests.swift (CameraTests, SkeletonTests, BenchViewTests, PostureLibraryTests,
// UprightCameraTests).
import { describe, expect, it } from "vitest";
import type { FloorPoint } from "../match/court";
import { BoardCamera, criticallyDamped } from "./boardCamera";
import { DualQuat, Quat, Rigid, V3 } from "./math3d";
import { PostureLibrary, PostureSpec } from "./postureLibrary";
import { AvatarMaterial, AvatarMesh, BodyMetrics, Joint, Posture, SkeletonModel } from "./skeleton";
import { expectClose, strideThrough } from "./testSupport";

describe("CameraTests", () => {
  it("top-down matches the two-dimensional layout", () => {
    const cam = BoardCamera.topDown(1.6);
    // Home end line (z = +9) appears on the left, the far sideline (x = -4.5) at the top.
    const home = cam.project(new V3(0, 0, 9), 1.6)!;
    const far = cam.project(new V3(-4.5, 0, 0), 1.6)!;
    expect(home.x).toBeLessThan(-0.5);
    expect(far.y).toBeGreaterThan(0.4);
    // The whole 22.8 m frame fits horizontally.
    const edge = cam.project(new V3(0, 0, 11.4), 1.6)!;
    expectClose(edge.x, -1, 0.01);
    const flipped = BoardCamera.topDown(1.6, { homeOnLeft: false });
    expect(flipped.project(new V3(0, 0, 9), 1.6)!.x).toBeGreaterThan(0.5);
  });

  it("touch ray hits the floor where the point projects", () => {
    for (const cam of [BoardCamera.bench(1.43), BoardCamera.topDown(1.43), BoardCamera.bench(1.43).orbited(0.7, 0.3, 1.4)]) {
      for (const p of [{ x: 2, z: 3 }, { x: -4.5, z: -9 }, { x: 0.3, z: 7.5 }]) {
        const ndc = cam.project(V3.fromFloor(p), 1.43);
        expect(ndc).toBeDefined();
        const back = cam.floorPoint(ndc!.x, ndc!.y, 1.43);
        expect(back).toBeDefined();
        expectClose(back!.x, p.x, 1e-6);
        expectClose(back!.z, p.z, 1e-6);
        expect(ndc!.depth >= 0 && ndc!.depth <= 1).toBe(true);
      }
    }
  });

  it("dolly-zoom keeps the court size and reaches both ends", () => {
    const a = BoardCamera.topDown(1.43), b = BoardCamera.bench(1.43);
    expect(BoardCamera.dollyZoom(a, b, 0)).toEqual(a);
    const end = BoardCamera.dollyZoom(a, b, 1);
    expectClose(end.fovY, b.fovY, 1e-12);
    expectClose(end.distance, b.distance, 1e-9);
    for (const t of strideThrough(0.0, 1.0, 0.1)) {
      const c = BoardCamera.dollyZoom(a, b, t);
      const expected = a.visibleHeight * (1 - t) + b.visibleHeight * t;
      expectClose(c.visibleHeight, expected, 1e-9);
    }
    expectClose(criticallyDamped(0), 0, 1e-12);
    expectClose(criticallyDamped(1), 1, 1e-12);
    expect(criticallyDamped(0.3)).toBeLessThan(criticallyDamped(0.31));
  });

  it("matrix inverse", () => {
    const m = BoardCamera.bench(1.5).viewProjection(1.5);
    const i = m.inverse;
    expect(i).toBeDefined();
    const id = m.mul(i!);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) expectClose(id.get(r, c), r === c ? 1 : 0, 1e-9);
  });
});

describe("SkeletonTests", () => {
  const origin: FloorPoint = { x: 0, z: 0 };

  it("standing dimensions match Appendix B", () => {
    const s = new SkeletonModel(new BodyMetrics(1.9));
    const pose = s.pose("standing", origin, 0);
    expectClose(s.eye(pose).y, 0.936 * 1.9, 0.002);
    expectClose(pose[Joint.lAnkle].translation.y, 0.039 * 1.9, 1e-9);
    expectClose(pose[Joint.lShoulder].translation.y, 0.818 * 1.9, 1e-9);
    expect(pose[Joint.lShoulder].translation.x).toBeGreaterThan(0); // left is +X when facing +Z
  });

  it("reach posture reproduces the measured standing reach", () => {
    for (const [h, reach] of [[1.9, 2.48], [1.75, 2.25], [2.02, 2.7]]) {
      const s = new SkeletonModel(new BodyMetrics(h, reach));
      const pose = s.pose("reach", { x: 1, z: 2 }, 0.4);
      expectClose(s.fingertip(pose, true).y, reach, 0.005, `H ${h}`);
    }
    // Default reach is 1.31 H.
    const d = new SkeletonModel(new BodyMetrics(1.8));
    expectClose(d.fingertip(d.pose("reach", origin, 0), true).y, 1.31 * 1.8, 0.005);
  });

  it("postures keep feet on the floor and jumps lift", () => {
    const s = new SkeletonModel(new BodyMetrics(1.85));
    for (const posture of Posture.allCases) {
      for (const role of [undefined, "S", "OH1", "OPP", "MB1", "L"]) {
        const pose = s.pose(posture, origin, 0, 0, role);
        // The lowest contact (feet or knee pads) touches the floor, or the jump lifts it.
        let clearance = Math.min(pose[Joint.lAnkle].translation.y, pose[Joint.rAnkle].translation.y) - s.ankleHeight;
        for (const k of [Joint.lKnee, Joint.rKnee]) clearance = Math.min(clearance, pose[k].translation.y - 0.04 * 1.85);
        expectClose(clearance, Posture.params(posture, s, role).jump, 1e-9, `${posture} ${role ?? "-"}`);
      }
    }
    const ready = s.pose("ready", origin, 0);
    expect(ready[Joint.pelvis].translation.y).toBeLessThan(0.53 * 1.85 - 0.08); // crouched
    const block = s.pose("block", origin, 0, 0.6);
    expect(s.fingertip(block, true).y).toBeGreaterThan(s.metrics.standingReach + 0.45);
  });

  it("dual quaternion skinning", () => {
    const r = new Rigid(Quat.fromAxisAngle(new V3(0.3, 1, -0.2), 1.1), new V3(0.4, -1.2, 2.5));
    const dq = DualQuat.fromRigid(r);
    const p = new V3(0.7, 1.3, -0.4);
    const a = dq.transform(p), b = r.apply(p);
    expectClose(a.x, b.x, 1e-12);
    expectClose(a.y, b.y, 1e-12);
    expectClose(a.z, b.z, 1e-12);
    // Blending a transform with itself (one copy sign-flipped) gives the same transform.
    const flipped = new DualQuat(dq.real.scale(-1), dq.dual.scale(-1));
    const c = DualQuat.blend([[dq, 0.5], [flipped, 0.5]]).transform(p);
    expectClose(c.x, b.x, 1e-12);
    // Skin of the rest pose is the identity.
    const s = new SkeletonModel(new BodyMetrics(1.9));
    for (const q of s.skin(s.restPose)) {
      const t = q.transform(p);
      expectClose(t.x, p.x, 1e-9);
      expectClose(t.y, p.y, 1e-9);
      expectClose(t.z, p.z, 1e-9);
    }
  });

  it("avatar mesh is well formed", () => {
    const s = new SkeletonModel(new BodyMetrics(1.9));
    const mesh = new AvatarMesh(s);
    expect(mesh.positions.length).toBeGreaterThan(1000);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.weights.length).toBe(mesh.positions.length);
    expect(mesh.indices.every((i) => i < mesh.positions.length)).toBe(true);
    expect(mesh.weights.every((w) => Math.abs(w[0] + w[1] - 1) < 1e-9)).toBe(true);
    const ys = mesh.positions.map((p) => p.y);
    expectClose(Math.max(...ys), 1.9, 0.04); // the head reaches the stature
    expect(mesh.materials.length).toBe(mesh.positions.length);
    // Soles near the floor (the rest pose stands on it), shoulders about 0.26 H wide on each side at most.
    expectClose(Math.min(...ys), 0, 0.03);
    expect(Math.max(...mesh.positions.map((p) => Math.abs(p.x)))).toBeLessThan(0.3 * 1.9);
    for (const m of Object.values(AvatarMaterial)) expect(mesh.materials.includes(m), `${m}`).toBe(true);
    // The jersey covers the chest front at nipple height; the shorts the hips.
    const chestFront = mesh.positions
      .map((p, i) => [p, i] as const)
      .filter(([p]) => Math.abs(p.y - 0.72 * 1.9) < 0.02 && Math.abs(p.x) < 0.05)
      .map(([, i]) => i);
    expect(chestFront.some((i) => mesh.materials[i] === AvatarMaterial.jersey)).toBe(true);
    // Web addition: the typed-array view has the same data.
    const b = mesh.buffers();
    expect(b.positions.length).toBe(mesh.positions.length * 3);
    expect(b.indices.length).toBe(mesh.indices.length);
  });
});

describe("BenchViewTests", () => {
  it("bench view sits beside the home half with home on the chosen side", () => {
    for (const homeOnLeft of [true, false]) {
      const cam = BoardCamera.bench(1.43, { homeOnLeft });
      expect(cam.eye.z, "the bench is beside the home half").toBeGreaterThan(0);
      const home = cam.project(new V3(0, 0, 6), 1.43)!;
      const away = cam.project(new V3(0, 0, -6), 1.43)!;
      expect(home.x < away.x).toBe(homeOnLeft);
      // The net is no longer edge-on: its two antennas project apart horizontally.
      const a = cam.project(new V3(-4.5, 2.43, 0), 1.43)!;
      const b = cam.project(new V3(4.5, 2.43, 0), 1.43)!;
      expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.1);
    }
  });
});

describe("PostureLibraryTests", () => {
  const spec = PostureSpec.create("test_stance", "Wide staggered crouch",
    { lumbar_flex: 25, thoracic_flex: 10, l_hip_flex: 70, r_hip_flex: 70, l_knee_flex: 95, r_knee_flex: 95, l_hip_ext_rot: 15,
      r_hip_ext_rot: 15, l_shoulder_flex: 40, r_shoulder_flex: 40, l_elbow_flex: 30, r_elbow_flex: 30 },
    { jump_m: 0, stance_width_m: 0.7, stagger_m: 0.25, yaw_deg: 20 });

  it("stance IK puts both feet flat at width and stagger", () => {
    const s = new SkeletonModel(new BodyMetrics(1.9));
    const params = PostureSpec.params(spec, s);
    expect(params.airborne).toBe(false);
    const facing = 0.7;
    const pose = s.pose(params, { x: 1, z: 2 }, facing);
    const l = pose[Joint.lAnkle], r = pose[Joint.rAnkle];
    expectClose(l.translation.y, s.ankleHeight, 1e-6);
    expectClose(r.translation.y, s.ankleHeight, 1e-6);
    // In the body frame (facing and the pelvis yaw removed): 0.7 m apart sideways, right foot 0.25 m ahead.
    const body = Quat.fromAxisAngle(V3.up, facing + (20 * Math.PI) / 180).conjugate;
    const d = body.rotate(l.translation.sub(r.translation));
    expectClose(d.x, 0.7, 1e-6);
    expectClose(-d.z, 0.25, 1e-6);
    // Feet are flat: each foot's up axis is world up.
    for (const a of [l, r]) expectClose(a.rotation.rotate(new V3(0, 1, 0)).y, 1, 1e-9);
    // The crouch is real: the pelvis drops well below standing.
    expect(pose[Joint.pelvis].translation.y).toBeLessThan(0.53 * 1.9 - 0.2);
    // Knees bend forward over the feet, not backward.
    const knee = body.rotate(pose[Joint.lKnee].translation.sub(l.translation));
    expect(knee.z).toBeGreaterThan(0);
  });

  it("anatomical angles map to the right directions", () => {
    const s = new SkeletonModel(new BodyMetrics(1.9));
    const hand = (angles: Record<string, number>, left = false): V3 => {
      const p = s.pose(PostureSpec.params(PostureSpec.create("t", "t", angles), s), { x: 0, z: 0 }, 0);
      return s.fingertip(p, left).sub(p[left ? Joint.lShoulder : Joint.rShoulder].translation);
    };
    expect(hand({ r_shoulder_flex: 90 }).z, "flexion points the arm forward").toBeGreaterThan(0.6);
    expect(hand({ r_shoulder_abd: 90 }).x, "right arm abducts to the player's right (-X)").toBeLessThan(-0.6);
    expect(hand({ l_shoulder_abd: 90 }, true).x).toBeGreaterThan(0.6);
    expect(hand({ r_shoulder_flex: 180 }).y, "overhead").toBeGreaterThan(0.6);
    // Arm cock: abducted 90, elbow 90, externally rotated 90 -> forearm points up.
    expect(hand({ r_shoulder_abd: 90, r_elbow_flex: 90, r_shoulder_ext_rot: 90 }).y).toBeGreaterThan(0.2);
    // Trunk twist to the right turns the chest's forward toward -X.
    const p = s.pose(PostureSpec.params(PostureSpec.create("t", "t", { trunk_twist: 40 }), s), { x: 0, z: 0 }, 0);
    expect(p[Joint.chest].rotation.rotate(new V3(0, 0, 1)).x).toBeLessThan(-0.5);
  });

  it("roles map to research positions", () => {
    expect(PostureLibrary.position("S")).toBe("setter");
    expect(PostureLibrary.position("OH2")).toBe("outside_hitter");
    expect(PostureLibrary.position("OPP")).toBe("opposite");
    expect(PostureLibrary.position("MB1")).toBe("middle_blocker");
    expect(PostureLibrary.position("L")).toBe("libero");
    expect(PostureLibrary.position(undefined)).toBeUndefined();
  });

  it("the shipped library loads (web addition)", () => {
    expect(Object.keys(PostureLibrary.shared.positions).sort()).toEqual(
      ["libero", "middle_blocker", "opposite", "outside_hitter", "setter"]);
    expect(PostureLibrary.shared.spec("ready_medium", "L")?.id).toBe("ready_medium");
  });
});

describe("UprightCameraTests", () => {
  /** Portrait boards stand the court upright: home at the bottom, home's right (+X) to the right, in 2D and 3D alike. */
  it("vertical top-down and end view put home at the bottom", () => {
    for (const cam of [BoardCamera.topDown(0.75, { vertical: true }), BoardCamera.bench(0.75, { vertical: true })]) {
      const home = cam.project(new V3(0, 0, 6), 0.75)!;
      const away = cam.project(new V3(0, 0, -6), 0.75)!;
      expect(home.y, "home half lower on the screen").toBeLessThan(away.y);
      const right = cam.project(new V3(4, 0, 0), 0.75)!;
      expect(right.x).toBeGreaterThan(0);
    }
    // The whole court fits the top-down view.
    const cam = BoardCamera.topDown(0.75, { vertical: true });
    for (const p of [new V3(4.5, 0, 9), new V3(-4.5, 0, -9)]) {
      const c = cam.project(p, 0.75)!;
      expect(Math.abs(c.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(c.y)).toBeLessThanOrEqual(1);
    }
    // Switched ends: home on top.
    const flipped = BoardCamera.topDown(0.75, { homeOnLeft: false, vertical: true });
    expect(flipped.project(new V3(0, 0, 6), 0.75)!.y).toBeGreaterThan(0);
  });
});
