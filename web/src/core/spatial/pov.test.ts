// Port of CoachBoardCoreTests/POVTests.swift.
import { describe, expect, it } from "vitest";
import { sceneFrame } from "../zones/sceneTimeline";
import { SceneToken, TacticalScene } from "../zones/tacticalScene";
import { BoardCamera } from "./boardCamera";
import { CameraPose } from "./cameraPose";
import { Capsule, LineOfSight, OccluderModel, VisualField } from "./lineOfSight";
import { V3 } from "./math3d";
import { Gaze, posedPlayers } from "./povAnalysis";
import { BodyMetrics, SkeletonModel } from "./skeleton";
import { newUUID } from "./swiftCompat";
import { expectClose, SplitMix64 } from "./testSupport";

describe("POVTests", () => {
  it("camera pose matches the orbit camera and uses reversed depth", () => {
    const cam = BoardCamera.bench(1.43);
    const pose = cam.pose;
    for (const p of [new V3(0, 0, 0), new V3(4.5, 0, 9), new V3(-3, 2.43, -6)]) {
      const a = cam.project(p, 1.43)!, b = pose.project(p, 1.43)!;
      expectClose(a.x, b.x, 1e-9);
      expectClose(a.y, b.y, 1e-9);
    }
    // Reversed-Z, infinite far: the near plane maps to 1, far points approach 0, nearer is greater.
    const near = pose.project(pose.eye.add(pose.forward.mul(pose.near)), 1.43)!;
    expectClose(near.depth, 1, 1e-9);
    const mid = pose.project(pose.eye.add(pose.forward.mul(10)), 1.43)!;
    const far = pose.project(pose.eye.add(pose.forward.mul(1000)), 1.43)!;
    expect(mid.depth).toBeGreaterThan(far.depth);
    expect(far.depth).toBeGreaterThan(0);
    // Floor picking agrees with the orbit camera.
    const f1 = cam.floorPoint(0.3, -0.2, 1.43)!;
    const f2 = pose.floorPoint(0.3, -0.2, 1.43)!;
    expectClose(f1.x, f2.x, 1e-9);
    expectClose(f1.z, f2.z, 1e-9);
  });

  it("flight ends exactly and arcs over the midpoint", () => {
    const a = BoardCamera.bench(1.43).pose;
    const b = CameraPose.looking(new V3(1, 1.8, 5), new V3(0, 0, -1), V3.up, 1.2, 0.04);
    expect(CameraPose.flight(a, b, 0)).toEqual(a);
    expect(CameraPose.flight(a, b, 1)).toEqual(b);
    const mid = CameraPose.flight(a, b, 0.5);
    // Quadratic Bezier at t = 0.5: a quarter of each end plus half the raised control point.
    expectClose(mid.eye.y, (a.eye.y + b.eye.y) / 2 + 0.5, 1e-9);
    expect(CameraPose.flightDuration(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it("head-locked POV sits at the eye and looks at the net", () => {
    const s = new SkeletonModel(new BodyMetrics(1.98));
    const posed = s.pose("standing", { x: 1, z: 3 }, Math.PI);
    const pov = s.povPose(posed, 4.0 / 3);
    expectClose(pov.eye.y, s.eye(posed).y, 1e-12);
    expectClose(pov.eye.y, 0.936 * 1.98, 0.02, "standing eye height (Appendix B2)");
    expect(pov.forward.z, "a home player faces the net").toBeLessThan(-0.99);
    // 90 degrees horizontal on 4:3 is about 74 degrees vertical (Section 5.1).
    expectClose((pov.fovY * 180) / Math.PI, 73.74, 0.05);
    expect(pov.near).toBe(0.04);
    // Free-look is limited to the neck's range.
    const look = s.povPose(posed, 4.0 / 3, { yaw: 2.0, pitch: 0 });
    expectClose((Math.acos(look.forward.dot(pov.forward)) * 180) / Math.PI, 70, 1e-6);
  });

  it("ray capsule against sampling", () => {
    const c = new Capsule({ a: new V3(0, 1, 0), b: new V3(0, 2, 0.5), radius: 0.2, part: "torso" });
    const rng = new SplitMix64(5);
    const r = (): number => (rng.nextMod(10_000) / 10_000) * 2 - 1;
    for (let n = 0; n < 300; n++) {
      const o = new V3(3 * r(), 1.5 + r(), 3 + r());
      const d = new V3(0.3 * r(), 1.5 + r(), 0.25 + 0.3 * r()).sub(o).normalized;
      // March along the ray and find the first point inside the capsule.
      let marched: number | undefined;
      let t = 0.0;
      while (t < 8) {
        if (LineOfSight.segmentDistance(o.add(d.mul(t)), c.a, c.b) <= c.radius) {
          marched = t;
          break;
        }
        t += 0.0005;
      }
      const exact = c.intersect(o, d);
      expect(exact === undefined, "hit/miss must agree").toBe(marched === undefined);
      if (exact !== undefined && marched !== undefined) expectClose(exact, marched, 0.002);
    }
  });

  it("visibility and readouts", () => {
    const eye = new V3(0, 1.8, 6);
    const target = new V3(0, 1.8, -3);
    expect(LineOfSight.visibility(eye, target, 0.1, []).fraction).toBe(1);
    // A fat capsule across the line hides it completely, and is named.
    const wall = new Capsule({ a: new V3(-2, 1.8, 2), b: new V3(2, 1.8, 2), radius: 0.3, owner: newUUID(), ownerLabel: "#14", part: "leftForearm" });
    const blocked = LineOfSight.visibility(eye, target, 0.1, [wall]);
    expect(blocked.fraction).toBe(0);
    expect(blocked.readout).toBe("0% visible — blocked by #14 left forearm");
    expectClose(blocked.occlusionPoint!.z, 2.3, 0.05);
    // A thin bar across the centre hides only part of the target.
    const bar = new Capsule({ a: new V3(-2, 1.8, 2), b: new V3(2, 1.8, 2), radius: 0.01, part: "antenna" });
    const partial = LineOfSight.visibility(eye, target, 0.1, [bar]);
    expect(partial.fraction).toBeGreaterThan(0);
    expect(partial.fraction).toBeLessThan(1);
    // Through the mesh at standing height: not occluded, labelled.
    const net = LineOfSight.visibility(new V3(0, 1.8, 6), new V3(0, 1.7, -6), 0.1, OccluderModel.net(2.43));
    expect(net.fraction).toBe(1);
    expect(net.throughNet).toBe(true);
    expect(net.readout).toBe("100% visible through net");
  });

  it("visual field bands", () => {
    const f = new VisualField();
    const fw = new V3(0, 0, -1);
    const dir = (h: number, v: number): V3 => {
      const hr = (h * Math.PI) / 180, vr = (v * Math.PI) / 180;
      return new V3(Math.sin(hr) * Math.cos(vr), Math.sin(vr), -Math.cos(hr) * Math.cos(vr));
    };
    expect(f.classify(dir(2, 0), fw, V3.up).band).toBe("foveal");
    expect(f.classify(dir(20, 10), fw, V3.up).band).toBe("central");
    expect(f.classify(dir(80, 0), fw, V3.up).band).toBe("peripheral");
    expect(f.classify(dir(0, 45), fw, V3.up).band).toBe("peripheral");
    expect(f.classify(dir(0, 55), fw, V3.up).band, "upper limit 50").toBe("outside");
    expect(f.classify(dir(0, -65), fw, V3.up).band, "lower limit 70").toBe("peripheral");
    expect(f.classify(dir(120, 0), fw, V3.up).band).toBe("outside");
    expect(f.classify(dir(-60, 30), fw, V3.up).band).toBe("peripheral");
    expect(f.classify(dir(-80, 30), fw, V3.up).band, "ellipse, not a box").toBe("outside");
  });

  it("defender behind their own block sees the hitter through gaps", () => {
    // Home blocker at the net with arms up, a home defender right behind, an opponent hitter across the net.
    const blocker = SceneToken.create({ side: "home", label: "4", role: "MB1", point: { x: 0, z: 0.6 }, posture: "block" });
    const defender = SceneToken.create({ side: "home", label: "2", role: "L", point: { x: 0, z: 5 }, posture: "dig" });
    const hitter = SceneToken.create({ side: "opponent", label: "OH1", role: "OH1", point: { x: 0.2, z: -1.5 }, posture: "attack" });
    const scene = TacticalScene.create({ title: "Shadow", tokens: [blocker, defender, hitter] });
    delete scene.phases;
    const players = posedPlayers(sceneFrame(scene, 0));
    const viewer = players.find((p) => p.id === defender.id)!;
    const pov = viewer.skeleton.povPose(viewer.joints, 4.0 / 3);
    const targets = Gaze.defaultTargets(viewer, players);
    expect(targets.map((t) => t[0]), "front-row hitter, no setter in this scene").toEqual([hitter.id]);
    const r = Gaze.readouts(viewer, pov, targets, players, 2.43)[0];
    expect(r).toBeDefined();
    expect(r.visibility.fraction, "the own blocker hides part of the hitting shoulder").toBeLessThan(1);
    expect(r.visibility.blocker?.owner).toBe(blocker.id);
    expect(r.text.startsWith("OH1 hitting shoulder · ")).toBe(true);
  });
});
