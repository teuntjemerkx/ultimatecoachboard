import XCTest
@testable import CoachBoardCore

final class POVTests: XCTestCase {
    func testCameraPoseMatchesTheOrbitCameraAndUsesReversedDepth() throws {
        let cam = BoardCamera.bench(aspect: 1.43)
        let pose = cam.pose
        for p in [V3(0, 0, 0), V3(4.5, 0, 9), V3(-3, 2.43, -6)] {
            let a = try XCTUnwrap(cam.project(p, aspect: 1.43)), b = try XCTUnwrap(pose.project(p, aspect: 1.43))
            XCTAssertEqual(a.x, b.x, accuracy: 1e-9)
            XCTAssertEqual(a.y, b.y, accuracy: 1e-9)
        }
        // Reversed-Z, infinite far: the near plane maps to 1, far points approach 0, nearer is greater.
        let near = try XCTUnwrap(pose.project(pose.eye + pose.forward * pose.near, aspect: 1.43))
        XCTAssertEqual(near.depth, 1, accuracy: 1e-9)
        let mid = try XCTUnwrap(pose.project(pose.eye + pose.forward * 10, aspect: 1.43))
        let far = try XCTUnwrap(pose.project(pose.eye + pose.forward * 1000, aspect: 1.43))
        XCTAssertGreaterThan(mid.depth, far.depth)
        XCTAssertGreaterThan(far.depth, 0)
        // Floor picking agrees with the orbit camera.
        let f1 = try XCTUnwrap(cam.floorPoint(ndcX: 0.3, ndcY: -0.2, aspect: 1.43))
        let f2 = try XCTUnwrap(pose.floorPoint(ndcX: 0.3, ndcY: -0.2, aspect: 1.43))
        XCTAssertEqual(f1.x, f2.x, accuracy: 1e-9)
        XCTAssertEqual(f1.z, f2.z, accuracy: 1e-9)
    }

    func testFlightEndsExactlyAndArcsOverTheMidpoint() {
        let a = BoardCamera.bench(aspect: 1.43).pose
        let b = CameraPose(eye: V3(1, 1.8, 5), forward: V3(0, 0, -1), up: .up, fovY: 1.2, near: 0.04)
        XCTAssertEqual(CameraPose.flight(from: a, to: b, t: 0), a)
        XCTAssertEqual(CameraPose.flight(from: a, to: b, t: 1), b)
        let mid = CameraPose.flight(from: a, to: b, t: 0.5)
        // Quadratic Bezier at t = 0.5: a quarter of each end plus half the raised control point.
        XCTAssertEqual(mid.eye.y, (a.eye.y + b.eye.y) / 2 + 0.5, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(CameraPose.flightDuration(from: a, to: b), 0.5)
    }

    func testHeadLockedPOVSitsAtTheEyeAndLooksAtTheNet() {
        let s = SkeletonModel(BodyMetrics(stature: 1.98))
        let posed = s.pose(.standing, position: FloorPoint(x: 1, z: 3), facing: .pi)
        let pov = s.povPose(posed, aspect: 4.0 / 3)
        XCTAssertEqual(pov.eye.y, s.eye(posed).y, accuracy: 1e-12)
        XCTAssertEqual(pov.eye.y, 0.936 * 1.98, accuracy: 0.02, "standing eye height (Appendix B2)")
        XCTAssertLessThan(pov.forward.z, -0.99, "a home player faces the net")
        // 90 degrees horizontal on 4:3 is about 74 degrees vertical (Section 5.1).
        XCTAssertEqual(pov.fovY * 180 / .pi, 73.74, accuracy: 0.05)
        XCTAssertEqual(pov.near, 0.04)
        // Free-look is limited to the neck's range.
        let look = s.povPose(posed, aspect: 4.0 / 3, yaw: 2.0, pitch: 0)
        XCTAssertEqual(acos(look.forward.dot(pov.forward)) * 180 / .pi, 70, accuracy: 1e-6)
    }

    func testRayCapsuleAgainstSampling() {
        let c = Capsule(a: V3(0, 1, 0), b: V3(0, 2, 0.5), radius: 0.2, part: .torso)
        var rng = SplitMix64(seed: 5)
        func r() -> Double { Double(rng.next() % 10_000) / 10_000 * 2 - 1 }
        for _ in 0..<300 {
            let o = V3(3 * r(), 1.5 + r(), 3 + r())
            let d = (V3(0.3 * r(), 1.5 + r(), 0.25 + 0.3 * r()) - o).normalized
            // March along the ray and find the first point inside the capsule.
            var marched: Double?
            var t = 0.0
            while t < 8 {
                if LineOfSight.segmentDistance(o + d * t, c.a, c.b) <= c.radius { marched = t; break }
                t += 0.0005
            }
            let exact = c.intersect(origin: o, direction: d)
            XCTAssertEqual(exact == nil, marched == nil, "hit/miss must agree")
            if let e = exact, let m = marched { XCTAssertEqual(e, m, accuracy: 0.002) }
        }
    }

    func testVisibilityAndReadouts() {
        let eye = V3(0, 1.8, 6)
        let target = V3(0, 1.8, -3)
        XCTAssertEqual(LineOfSight.visibility(eye: eye, target: target, radius: 0.1, occluders: []).fraction, 1)
        // A fat capsule across the line hides it completely, and is named.
        let wall = Capsule(a: V3(-2, 1.8, 2), b: V3(2, 1.8, 2), radius: 0.3, owner: UUID(), ownerLabel: "#14", part: .leftForearm)
        let blocked = LineOfSight.visibility(eye: eye, target: target, radius: 0.1, occluders: [wall])
        XCTAssertEqual(blocked.fraction, 0)
        XCTAssertEqual(blocked.readout, "0% visible \u{2014} blocked by #14 left forearm")
        XCTAssertEqual(blocked.occlusionPoint!.z, 2.3, accuracy: 0.05)
        // A thin bar across the centre hides only part of the target.
        let bar = Capsule(a: V3(-2, 1.8, 2), b: V3(2, 1.8, 2), radius: 0.01, part: .antenna)
        let partial = LineOfSight.visibility(eye: eye, target: target, radius: 0.1, occluders: [bar])
        XCTAssertGreaterThan(partial.fraction, 0)
        XCTAssertLessThan(partial.fraction, 1)
        // Through the mesh at standing height: not occluded, labelled.
        let net = LineOfSight.visibility(eye: V3(0, 1.8, 6), target: V3(0, 1.7, -6), radius: 0.1, occluders: OccluderModel.net(height: 2.43))
        XCTAssertEqual(net.fraction, 1)
        XCTAssertTrue(net.throughNet)
        XCTAssertEqual(net.readout, "100% visible through net")
    }

    func testVisualFieldBands() {
        let f = VisualField()
        let fw = V3(0, 0, -1)
        func dir(h: Double, v: Double) -> V3 {
            let hr = h * .pi / 180, vr = v * .pi / 180
            return V3(sin(hr) * cos(vr), sin(vr), -cos(hr) * cos(vr))
        }
        XCTAssertEqual(f.classify(dir(h: 2, v: 0), forward: fw, up: .up).band, .foveal)
        XCTAssertEqual(f.classify(dir(h: 20, v: 10), forward: fw, up: .up).band, .central)
        XCTAssertEqual(f.classify(dir(h: 80, v: 0), forward: fw, up: .up).band, .peripheral)
        XCTAssertEqual(f.classify(dir(h: 0, v: 45), forward: fw, up: .up).band, .peripheral)
        XCTAssertEqual(f.classify(dir(h: 0, v: 55), forward: fw, up: .up).band, .outside, "upper limit 50")
        XCTAssertEqual(f.classify(dir(h: 0, v: -65), forward: fw, up: .up).band, .peripheral, "lower limit 70")
        XCTAssertEqual(f.classify(dir(h: 120, v: 0), forward: fw, up: .up).band, .outside)
        XCTAssertEqual(f.classify(dir(h: -60, v: 30), forward: fw, up: .up).band, .peripheral)
        XCTAssertEqual(f.classify(dir(h: -80, v: 30), forward: fw, up: .up).band, .outside, "ellipse, not a box")
    }

    func testDefenderBehindTheirOwnBlockSeesTheHitterThroughGaps() throws {
        // Home blocker at the net with arms up, a home defender right behind, an opponent hitter across the net.
        let blocker = SceneToken(side: .home, label: "4", role: "MB1", point: FloorPoint(x: 0, z: 0.6), posture: .block)
        let defender = SceneToken(side: .home, label: "2", role: "L", point: FloorPoint(x: 0, z: 5), posture: .dig)
        let hitter = SceneToken(side: .opponent, label: "OH1", role: "OH1", point: FloorPoint(x: 0.2, z: -1.5), posture: .attack)
        var scene = TacticalScene(title: "Shadow", tokens: [blocker, defender, hitter])
        scene.phases = nil
        let players = scene.frame(at: 0).posedPlayers()
        let viewer = try XCTUnwrap(players.first { $0.id == defender.id })
        let pov = viewer.skeleton.povPose(viewer.joints, aspect: 4.0 / 3)
        let targets = Gaze.defaultTargets(for: viewer, among: players)
        XCTAssertEqual(targets.map(\.0), [hitter.id], "front-row hitter, no setter in this scene")
        let r = try XCTUnwrap(Gaze.readouts(viewer: viewer, pov: pov, targets: targets, players: players, netHeight: 2.43).first)
        XCTAssertLessThan(r.visibility.fraction, 1, "the own blocker hides part of the hitting shoulder")
        XCTAssertEqual(r.visibility.blocker?.owner, blocker.id)
        XCTAssertTrue(r.text.hasPrefix("OH1 hitting shoulder \u{00B7} "))
    }
}
