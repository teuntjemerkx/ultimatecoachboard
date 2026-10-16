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
            let pose = s.pose(posture, position: FloorPoint(x: 0, z: 0), facing: 0)
            let lowest = min(pose[Joint.lAnkle.rawValue].translation.y, pose[Joint.rAnkle.rawValue].translation.y)
            XCTAssertEqual(lowest, s.ankleHeight, accuracy: 1e-9, "\(posture)")
        }
        let ready = s.pose(.ready, position: FloorPoint(x: 0, z: 0), facing: 0)
        XCTAssertLessThan(ready[Joint.pelvis.rawValue].translation.y, 0.53 * 1.85 - 0.08)  // crouched
        let block = s.pose(.block, position: FloorPoint(x: 0, z: 0), facing: 0, jump: 0.6)
        XCTAssertGreaterThan(s.fingertip(block, left: true).y, s.metrics.standingReach + 0.5)
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
    }
}
