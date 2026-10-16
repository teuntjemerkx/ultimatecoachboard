import XCTest
@testable import CoachBoardCore

final class CameraTests: XCTestCase {
    func testTopDownMatchesTheTwoDimensionalLayout() throws {
        let cam = BoardCamera.topDown(aspect: 1.6)
        // Home end line (z = +9) appears on the left, the far sideline (x = -4.5) at the top.
        let home = try XCTUnwrap(cam.project(V3(0, 0, 9), aspect: 1.6))
        let far = try XCTUnwrap(cam.project(V3(-4.5, 0, 0), aspect: 1.6))
        XCTAssertLessThan(home.x, -0.5)
        XCTAssertGreaterThan(far.y, 0.4)
        // The whole 22.8 m frame fits horizontally.
        let edge = try XCTUnwrap(cam.project(V3(0, 0, 11.4), aspect: 1.6))
        XCTAssertEqual(edge.x, -1, accuracy: 0.01)
        let flipped = BoardCamera.topDown(aspect: 1.6, homeOnLeft: false)
        XCTAssertGreaterThan(try XCTUnwrap(flipped.project(V3(0, 0, 9), aspect: 1.6)).x, 0.5)
    }

    func testTouchRayHitsTheFloorWhereThePointProjects() throws {
        for cam in [BoardCamera.bench(aspect: 1.43), BoardCamera.topDown(aspect: 1.43),
                    BoardCamera.bench(aspect: 1.43).orbited(dHeading: 0.7, dPitch: 0.3, zoom: 1.4)] {
            for p in [FloorPoint(x: 2, z: 3), FloorPoint(x: -4.5, z: -9), FloorPoint(x: 0.3, z: 7.5)] {
                let ndc = try XCTUnwrap(cam.project(V3(p), aspect: 1.43))
                let back = try XCTUnwrap(cam.floorPoint(ndcX: ndc.x, ndcY: ndc.y, aspect: 1.43))
                XCTAssertEqual(back.x, p.x, accuracy: 1e-6)
                XCTAssertEqual(back.z, p.z, accuracy: 1e-6)
                XCTAssertTrue((0...1).contains(ndc.depth))
            }
        }
    }

    func testDollyZoomKeepsTheCourtSizeAndReachesBothEnds() {
        let a = BoardCamera.topDown(aspect: 1.43), b = BoardCamera.bench(aspect: 1.43)
        XCTAssertEqual(BoardCamera.dollyZoom(from: a, to: b, t: 0), a)
        let end = BoardCamera.dollyZoom(from: a, to: b, t: 1)
        XCTAssertEqual(end.fovY, b.fovY, accuracy: 1e-12)
        XCTAssertEqual(end.distance, b.distance, accuracy: 1e-9)
        for t in stride(from: 0.0, through: 1.0, by: 0.1) {
            let c = BoardCamera.dollyZoom(from: a, to: b, t: t)
            let expected = a.visibleHeight * (1 - t) + b.visibleHeight * t
            XCTAssertEqual(c.visibleHeight, expected, accuracy: 1e-9)
        }
        XCTAssertEqual(criticallyDamped(0), 0, accuracy: 1e-12)
        XCTAssertEqual(criticallyDamped(1), 1, accuracy: 1e-12)
        XCTAssertLessThan(criticallyDamped(0.3), criticallyDamped(0.31))
    }

    func testMatrixInverse() throws {
        let m = BoardCamera.bench(aspect: 1.5).viewProjection(aspect: 1.5)
        let i = try XCTUnwrap(m.inverse)
        let id = m * i
        for r in 0..<4 { for c in 0..<4 { XCTAssertEqual(id[r, c], r == c ? 1 : 0, accuracy: 1e-9) } }
    }
}

final class SkeletonTests: XCTestCase {
    func testStandingDimensionsMatchAppendixB() {
        let s = SkeletonModel(BodyMetrics(stature: 1.90))
        let pose = s.pose(.standing, position: FloorPoint(x: 0, z: 0), facing: 0)
        XCTAssertEqual(s.eye(pose).y, 0.936 * 1.90, accuracy: 0.002)
        XCTAssertEqual(pose[Joint.lAnkle.rawValue].translation.y, 0.039 * 1.90, accuracy: 1e-9)
        XCTAssertEqual(pose[Joint.lShoulder.rawValue].translation.y, 0.818 * 1.90, accuracy: 1e-9)
        XCTAssertGreaterThan(pose[Joint.lShoulder.rawValue].translation.x, 0)       // left is +X when facing +Z
    }

    func testReachPostureReproducesTheMeasuredStandingReach() {
        for (h, reach) in [(1.90, 2.48), (1.75, 2.25), (2.02, 2.70)] {
            let s = SkeletonModel(BodyMetrics(stature: h, standingReach: reach))
            let pose = s.pose(.reach, position: FloorPoint(x: 1, z: 2), facing: 0.4)
            XCTAssertEqual(s.fingertip(pose, left: true).y, reach, accuracy: 0.005, "H \(h)")
        }
        // Default reach is 1.31 H.
        let d = SkeletonModel(BodyMetrics(stature: 1.80))
        XCTAssertEqual(d.fingertip(d.pose(.reach, position: FloorPoint(x: 0, z: 0), facing: 0), left: true).y,
                       1.31 * 1.80, accuracy: 0.005)
    }

    func testPosturesKeepFeetOnTheFloorAndJumpsLift() {
        let s = SkeletonModel(BodyMetrics(stature: 1.85))
        for posture in Posture.allCases {
            for role in [nil, "S", "OH1", "OPP", "MB1", "L"] as [String?] {
                let pose = s.pose(posture, position: FloorPoint(x: 0, z: 0), facing: 0, role: role)
                // The lowest contact (feet or knee pads) touches the floor, or the jump lifts it.
                var clearance = min(pose[Joint.lAnkle.rawValue].translation.y, pose[Joint.rAnkle.rawValue].translation.y) - s.ankleHeight
                for k in [Joint.lKnee, .rKnee] { clearance = min(clearance, pose[k.rawValue].translation.y - 0.04 * 1.85) }
                XCTAssertEqual(clearance, posture.params(for: s, role: role).jump, accuracy: 1e-9, "\(posture) \(role ?? "-")")
            }
        }
        let ready = s.pose(.ready, position: FloorPoint(x: 0, z: 0), facing: 0)
        XCTAssertLessThan(ready[Joint.pelvis.rawValue].translation.y, 0.53 * 1.85 - 0.08)  // crouched
        let block = s.pose(.block, position: FloorPoint(x: 0, z: 0), facing: 0, jump: 0.6)
        XCTAssertGreaterThan(s.fingertip(block, left: true).y, s.metrics.standingReach + 0.45)
    }

    func testDualQuaternionSkinning() {
        let r = Rigid(rotation: Quat(axis: V3(0.3, 1, -0.2), angle: 1.1), translation: V3(0.4, -1.2, 2.5))
        let dq = DualQuat(r)
        let p = V3(0.7, 1.3, -0.4)
        let a = dq.transform(p), b = r.apply(p)
        XCTAssertEqual(a.x, b.x, accuracy: 1e-12); XCTAssertEqual(a.y, b.y, accuracy: 1e-12); XCTAssertEqual(a.z, b.z, accuracy: 1e-12)
        // Blending a transform with itself (one copy sign-flipped) gives the same transform.
        let flipped = DualQuat(real: dq.real * -1, dual: dq.dual * -1)
        let c = DualQuat.blend([(dq, 0.5), (flipped, 0.5)]).transform(p)
        XCTAssertEqual(c.x, b.x, accuracy: 1e-12)
        // Skin of the rest pose is the identity.
        let s = SkeletonModel(BodyMetrics(stature: 1.9))
        for q in s.skin(s.restPose) {
            let t = q.transform(p)
            XCTAssertEqual(t.x, p.x, accuracy: 1e-9); XCTAssertEqual(t.y, p.y, accuracy: 1e-9); XCTAssertEqual(t.z, p.z, accuracy: 1e-9)
        }
    }

    func testAvatarMeshIsWellFormed() {
        let s = SkeletonModel(BodyMetrics(stature: 1.9))
        let mesh = AvatarMesh(skeleton: s)
        XCTAssertGreaterThan(mesh.positions.count, 1000)
        XCTAssertEqual(mesh.positions.count, mesh.normals.count)
        XCTAssertEqual(mesh.positions.count, mesh.weights.count)
        XCTAssertTrue(mesh.indices.allSatisfy { Int($0) < mesh.positions.count })
        XCTAssertTrue(mesh.weights.allSatisfy { abs($0.0 + $0.1 - 1) < 1e-9 })
        let top = mesh.positions.map(\.y).max() ?? 0
        XCTAssertEqual(top, 1.9, accuracy: 0.04)                                     // the head reaches the stature
        XCTAssertEqual(mesh.materials.count, mesh.positions.count)
        // Soles near the floor (the rest pose stands on it), shoulders about 0.26 H wide on each side at most.
        XCTAssertEqual(mesh.positions.map(\.y).min() ?? 1, 0, accuracy: 0.03)
        XCTAssertLessThan(mesh.positions.map { abs($0.x) }.max() ?? 0, 0.3 * 1.9)
        for m in [AvatarMaterial.skin, .jersey, .shorts, .pads, .shoes, .hair, .socks] {
            XCTAssertTrue(mesh.materials.contains(m), "\(m)")
        }
        // The jersey covers the chest front at nipple height; the shorts the hips.
        let chestFront = mesh.positions.indices.filter { abs(mesh.positions[$0].y - 0.72 * 1.9) < 0.02 && abs(mesh.positions[$0].x) < 0.05 }
        XCTAssertTrue(chestFront.contains { mesh.materials[$0] == .jersey })
    }
}

final class BenchViewTests: XCTestCase {
    func testBenchViewSitsBesideTheHomeHalfWithHomeOnTheChosenSide() throws {
        for homeOnLeft in [true, false] {
            let cam = BoardCamera.bench(aspect: 1.43, homeOnLeft: homeOnLeft)
            XCTAssertGreaterThan(cam.eye.z, 0, "the bench is beside the home half")
            let home = try XCTUnwrap(cam.project(V3(0, 0, 6), aspect: 1.43))
            let away = try XCTUnwrap(cam.project(V3(0, 0, -6), aspect: 1.43))
            XCTAssertEqual(home.x < away.x, homeOnLeft)
            // The net is no longer edge-on: its two antennas project apart horizontally.
            let a = try XCTUnwrap(cam.project(V3(-4.5, 2.43, 0), aspect: 1.43))
            let b = try XCTUnwrap(cam.project(V3(4.5, 2.43, 0), aspect: 1.43))
            XCTAssertGreaterThan(abs(a.x - b.x), 0.1)
        }
    }
}

final class PostureLibraryTests: XCTestCase {
    let spec = PostureSpec(id: "test_stance", name: "Wide staggered crouch",
                           root: .init(jump_m: 0, stance_width_m: 0.7, stagger_m: 0.25, yaw_deg: 20),
                           angles: ["lumbar_flex": 25, "thoracic_flex": 10, "l_hip_flex": 70, "r_hip_flex": 70,
                                    "l_knee_flex": 95, "r_knee_flex": 95, "l_hip_ext_rot": 15, "r_hip_ext_rot": 15,
                                    "l_shoulder_flex": 40, "r_shoulder_flex": 40, "l_elbow_flex": 30, "r_elbow_flex": 30])

    func testStanceIKPutsBothFeetFlatAtWidthAndStagger() {
        let s = SkeletonModel(BodyMetrics(stature: 1.9))
        let params = spec.params(for: s)
        XCTAssertFalse(params.airborne)
        let facing = 0.7
        let pose = s.pose(params, position: FloorPoint(x: 1, z: 2), facing: facing)
        let l = pose[Joint.lAnkle.rawValue], r = pose[Joint.rAnkle.rawValue]
        XCTAssertEqual(l.translation.y, s.ankleHeight, accuracy: 1e-6)
        XCTAssertEqual(r.translation.y, s.ankleHeight, accuracy: 1e-6)
        // In the body frame (facing and the pelvis yaw removed): 0.7 m apart sideways, right foot 0.25 m ahead.
        let body = Quat(axis: .up, angle: facing + 20 * .pi / 180).conjugate
        let d = body.rotate(l.translation - r.translation)
        XCTAssertEqual(d.x, 0.7, accuracy: 1e-6)
        XCTAssertEqual(-d.z, 0.25, accuracy: 1e-6)
        // Feet are flat: each foot's up axis is world up.
        for a in [l, r] { XCTAssertEqual(a.rotation.rotate(V3(0, 1, 0)).y, 1, accuracy: 1e-9) }
        // The crouch is real: the pelvis drops well below standing.
        XCTAssertLessThan(pose[Joint.pelvis.rawValue].translation.y, 0.53 * 1.9 - 0.2)
        // Knees bend forward over the feet, not backward.
        let knee = body.rotate(pose[Joint.lKnee.rawValue].translation - l.translation)
        XCTAssertGreaterThan(knee.z, 0)
    }

    func testAnatomicalAnglesMapToTheRightDirections() {
        let s = SkeletonModel(BodyMetrics(stature: 1.9))
        func hand(_ angles: [String: Double], left: Bool = false) -> V3 {
            let p = s.pose(PostureSpec(id: "t", name: "t", angles: angles).params(for: s), position: FloorPoint(x: 0, z: 0), facing: 0)
            return s.fingertip(p, left: left) - p[(left ? Joint.lShoulder : Joint.rShoulder).rawValue].translation
        }
        XCTAssertGreaterThan(hand(["r_shoulder_flex": 90]).z, 0.6, "flexion points the arm forward")
        XCTAssertLessThan(hand(["r_shoulder_abd": 90]).x, -0.6, "right arm abducts to the player's right (-X)")
        XCTAssertGreaterThan(hand(["l_shoulder_abd": 90], left: true).x, 0.6)
        XCTAssertGreaterThan(hand(["r_shoulder_flex": 180]).y, 0.6, "overhead")
        // Arm cock: abducted 90, elbow 90, externally rotated 90 -> forearm points up.
        XCTAssertGreaterThan(hand(["r_shoulder_abd": 90, "r_elbow_flex": 90, "r_shoulder_ext_rot": 90]).y, 0.2)
        // Trunk twist to the right turns the chest's forward toward -X.
        let p = s.pose(PostureSpec(id: "t", name: "t", angles: ["trunk_twist": 40]).params(for: s), position: FloorPoint(x: 0, z: 0), facing: 0)
        XCTAssertLessThan(p[Joint.chest.rawValue].rotation.rotate(V3(0, 0, 1)).x, -0.5)
    }

    func testRolesMapToResearchPositions() {
        XCTAssertEqual(PostureLibrary.position(forRole: "S"), "setter")
        XCTAssertEqual(PostureLibrary.position(forRole: "OH2"), "outside_hitter")
        XCTAssertEqual(PostureLibrary.position(forRole: "OPP"), "opposite")
        XCTAssertEqual(PostureLibrary.position(forRole: "MB1"), "middle_blocker")
        XCTAssertEqual(PostureLibrary.position(forRole: "L"), "libero")
        XCTAssertNil(PostureLibrary.position(forRole: nil))
    }
}
