import XCTest
@testable import CoachBoardCore

final class TimelineTests: XCTestCase {
    let allPhases = RallyPhase.allCases

    func scene() -> (TacticalScene, UUID, UUID) {
        let token = SceneToken(side: .home, label: "9", role: "OH1", point: FloorPoint(x: 3, z: 5))
        let zone = Zone(geometry: .circle(center: FloorPoint(x: 0, z: -4), radius: 1))
        var s = TacticalScene(title: "T", tokens: [token], zones: [zone])
        s.phases = allPhases
        return (s, token.id, zone.id)
    }

    func testKeyframesAreHitExactlyAtTheirMarkers() {
        var (s, tid, zid) = scene()
        s.tokens[0].keys = [TokenKey(phase: .set, point: FloorPoint(x: 1, z: 2), posture: .attack)]
        s.zones[0].keys = [ZoneKey(phase: .attack, geometry: .circle(center: FloorPoint(x: 2, z: -5), radius: 2), intensity: 0.5)]
        let atSet = s.frame(at: 2)
        XCTAssertEqual(atSet.tokens[0].point, FloorPoint(x: 1, z: 2))
        XCTAssertEqual(atSet.tokens[0].posture, .attack)
        XCTAssertNil(atSet.postureBlends[tid])
        let atAttack = s.frame(at: 3)
        XCTAssertEqual(atAttack.zones[0].geometry, .circle(center: FloorPoint(x: 2, z: -5), radius: 2))
        XCTAssertEqual(atAttack.intensities[zid]!, 0.5, accuracy: 1e-12)
        XCTAssertEqual(atAttack.zones[0].style.opacity, s.zones[0].style.opacity * 0.5, accuracy: 1e-12)
        // Before the first key the base holds; after the last key the last key holds.
        XCTAssertEqual(s.frame(at: 0).tokens[0].point, FloorPoint(x: 3, z: 5))
        XCTAssertEqual(s.frame(at: 5).tokens[0].point, FloorPoint(x: 1, z: 2))
        // Between markers the posture blends and the token is on its way.
        let mid = s.frame(at: 1)
        XCTAssertEqual(mid.postureBlends[tid]?.to, .attack)
        XCTAssertGreaterThan(mid.tokens[0].point.x, 1)
        XCTAssertLessThan(mid.tokens[0].point.x, 3)
    }

    func testEasingIsCriticallyDampedAndPathFollowsArcLength() {
        var (s, _, _) = scene()
        s.tokens[0].keys = [TokenKey(phase: .receive, point: FloorPoint(x: 3, z: 1))]
        // A straight move: the point stays on the segment and its progress equals the eased fraction.
        for f in stride(from: 0.1, through: 0.9, by: 0.2) {
            let p = s.frame(at: f).tokens[0].point
            XCTAssertEqual(p.x, 3, accuracy: 1e-9)
            XCTAssertEqual((5 - p.z) / 4, criticallyDamped(f), accuracy: 2e-3)
        }
        // Through three keys the path is a smooth centripetal Catmull-Rom: no overshoot beyond the hull here.
        s.tokens[0].keys = [TokenKey(phase: .receive, point: FloorPoint(x: 1, z: 3)), TokenKey(phase: .set, point: FloorPoint(x: 3, z: 1))]
        for f in stride(from: 0.0, through: 2.0, by: 0.05) {
            let p = s.frame(at: f).tokens[0].point
            XCTAssertGreaterThanOrEqual(p.x, 0.8)
            XCTAssertLessThanOrEqual(p.z, 5.0 + 1e-9)
        }
    }

    func testSameTypeZonesInterpolateParametersAndAnglesTakeTheShortArc() {
        let a = ZoneGeometry.rect(center: FloorPoint(x: 0, z: 0), halfWidth: 1, halfDepth: 2, angle: 0.1)
        let b = ZoneGeometry.rect(center: FloorPoint(x: 2, z: 4), halfWidth: 3, halfDepth: 2, angle: .pi - 0.1)
        let (g, morph) = ZoneInterpolation.interpolate(a, b, 0.5)
        XCTAssertNil(morph)
        guard case let .rect(c, hw, hd, angle) = g else { return XCTFail("\(g)") }
        XCTAssertEqual(c, FloorPoint(x: 1, z: 2))
        XCTAssertEqual(hw, 2, accuracy: 1e-12)
        XCTAssertEqual(hd, 2, accuracy: 1e-12)
        // pi - 0.1 is the same rectangle as -0.1, so the short way passes through 0.
        XCTAssertEqual(angle, 0, accuracy: 1e-9)
        // Circles and ellipses are one family.
        let (e, m2) = ZoneInterpolation.interpolate(.circle(center: FloorPoint(x: 0, z: 0), radius: 1),
                                                    .ellipse(center: FloorPoint(x: 0, z: 0), a: 3, b: 1, angle: 0.4), 0.5)
        XCTAssertNil(m2)
        XCTAssertEqual(e, .ellipse(center: FloorPoint(x: 0, z: 0), a: 2, b: 1, angle: 0.4))
    }

    func testPolygonsResampleAndAlignWithoutSwirling() {
        let square = [FloorPoint(x: -1, z: -1), FloorPoint(x: 1, z: -1), FloorPoint(x: 1, z: 1), FloorPoint(x: -1, z: 1)]
        // The same square listed from another vertex and clockwise: alignment must make the morph a no-op.
        let shifted = Array(square[2...] + square[..<2]).reversed().map { $0 }
        let (g, _) = ZoneInterpolation.interpolate(.polygon(square), .polygon(shifted), 0.5)
        guard case let .polygon(mid) = g else { return XCTFail("\(g)") }
        XCTAssertEqual(Set(mid.map { "\($0.x),\($0.z)" }), Set(square.map { "\($0.x),\($0.z)" }))
        // Different vertex counts: 64 points by arc length, evenly spaced on the perimeter.
        let triangle = [FloorPoint(x: 0, z: -1), FloorPoint(x: 1, z: 1), FloorPoint(x: -1, z: 1)]
        let (h, morph) = ZoneInterpolation.interpolate(.polygon(square), .polygon(triangle), 0.5)
        XCTAssertNil(morph)
        guard case let .polygon(blend) = h else { return XCTFail("\(h)") }
        XCTAssertEqual(blend.count, ZoneInterpolation.resampleCount)
        let ring = ZoneInterpolation.resample(square, count: 64)
        for i in 0..<64 {
            let a = ring[i], b = ring[(i + 1) % 64]
            XCTAssertEqual(hypot(b.x - a.x, b.z - a.z), 8.0 / 64, accuracy: 1e-9)
        }
        // The halfway shape lies between the two: inside the square, containing the triangle's centre.
        XCTAssertLessThan(ZoneSDF.distance(.polygon(blend), FloorPoint(x: 0, z: 0.3)), 0)
        XCTAssertGreaterThan(ZoneSDF.distance(.polygon(blend), FloorPoint(x: 1.2, z: 0)), 0)
    }

    func testTypeChangesBlendSignedDistances() {
        let circle = ZoneGeometry.circle(center: FloorPoint(x: 0, z: 0), radius: 1)
        let rect = ZoneGeometry.rect(center: FloorPoint(x: 0, z: 0), halfWidth: 2, halfDepth: 0.5, angle: 0)
        let (g, morph) = ZoneInterpolation.interpolate(circle, rect, 0.25)
        XCTAssertEqual(g, circle)
        XCTAssertEqual(morph, ZoneMorph(to: rect, t: 0.25))
        var (s, _, _) = scene()
        s.zones[0] = Zone(id: s.zones[0].id, geometry: circle, keys: [ZoneKey(phase: .receive, geometry: rect)])
        let frame = s.frame(at: 0.5)
        let m = frame.morphs[s.zones[0].id]!
        XCTAssertEqual(m.t, criticallyDamped(0.5), accuracy: 1e-12)
        let p = FloorPoint(x: 1.5, z: 0)
        XCTAssertEqual(frame.distance(to: frame.zones[0], p),
                       (1 - m.t) * ZoneSDF.distance(circle, p) + m.t * ZoneSDF.distance(rect, p), accuracy: 1e-12)
        // At the markers there is no morph.
        XCTAssertTrue(s.frame(at: 1).morphs.isEmpty)
        XCTAssertEqual(s.frame(at: 1).zones[0].geometry, rect)
    }

    func testEditorWritesKeyframesAtLaterMarkersAndUndoes() {
        let (s, tid, zid) = scene()
        var e = SceneEditor(scene: s)
        e.move(token: tid, to: FloorPoint(x: 2, z: 2), phase: .attack)
        XCTAssertEqual(e.scene.tokens[0].point, FloorPoint(x: 3, z: 5), "base untouched")
        XCTAssertEqual(e.scene.tokens[0].keys, [TokenKey(phase: .attack, point: FloorPoint(x: 2, z: 2))])
        e.move(token: tid, to: FloorPoint(x: 4, z: 4), phase: .serve)
        XCTAssertEqual(e.scene.tokens[0].point, FloorPoint(x: 4, z: 4), "first marker edits the base")
        e.setPosture(.block, token: tid, phase: .set)
        let atSet = e.scene.frame(at: 2).tokens[0]
        XCTAssertEqual(atSet.posture, .block)
        XCTAssertEqual(e.scene.tokens[0].keys?.count, 2)
        // Zones: moving at a later marker keys the translated shape that marker shows.
        e.move(zone: zid, by: 1, 0, phase: .cover)
        XCTAssertEqual(e.scene.frame(at: 4).zones[0].geometry, .circle(center: FloorPoint(x: 1, z: -4), radius: 1))
        XCTAssertEqual(e.scene.zones[0].geometry, .circle(center: FloorPoint(x: 0, z: -4), radius: 1))
        e.setIntensity(0, zone: zid, phase: .defence)
        XCTAssertEqual(e.scene.frame(at: 5).intensities[zid], 0)
        XCTAssertNil(e.scene.frame(at: 5).zone(at: FloorPoint(x: 1, z: -4)), "hidden zones are not hit")
        e.clearKey(zid, phase: .defence)
        XCTAssertEqual(e.scene.zones[0].keys?.count, 1)
        for _ in 0..<6 { e.undo() }
        XCTAssertEqual(e.scene, s)
    }

    func testOldScenesDecodeWithoutTimelineFields() throws {
        let token = SceneToken(side: .home, label: "9", role: "OH1", point: FloorPoint(x: 3, z: 5))
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TacticalScene(title: "Old", tokens: [token],
            zones: [Zone(geometry: .circle(center: FloorPoint(x: 0, z: 0), radius: 1))]))) as! [String: Any]
        json.removeValue(forKey: "phases")
        let decoded = try JSONDecoder().decode(TacticalScene.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.phases)
        XCTAssertTrue(decoded.timeline.isEmpty)
        XCTAssertEqual(decoded.frame(at: 3).tokens[0].point, FloorPoint(x: 3, z: 5))
    }

    func testPostureBlendEndpointsAndMidpoint() {
        let s = SkeletonModel(BodyMetrics(stature: 1.9))
        let at = FloorPoint(x: 1, z: 2)
        let a = s.pose(.ready, position: at, facing: .pi)
        let b = s.pose(.block, position: at, facing: .pi)
        let start = s.pose(PostureBlend(from: .ready, to: .block, t: 0), position: at, facing: .pi)
        let end = s.pose(PostureBlend(from: .ready, to: .block, t: 1), position: at, facing: .pi)
        for j in Joint.allCases {
            XCTAssertLessThan((start[j.rawValue].translation - a[j.rawValue].translation).length, 1e-9)
            XCTAssertLessThan((end[j.rawValue].translation - b[j.rawValue].translation).length, 1e-9)
        }
        // Halfway the hands are between a ready guard and a block, and the feet stay on the floor.
        let mid = s.pose(PostureBlend(from: .ready, to: .block, t: 0.5), position: at, facing: .pi)
        let hand = s.fingertip(mid, left: true).y
        XCTAssertGreaterThan(hand, s.fingertip(a, left: true).y)
        XCTAssertLessThan(hand, s.fingertip(b, left: true).y)
        // The feet rise with the blended jump (the block posture is the block jump at its peak).
        let jump = (Posture.ready.params(for: s).jump + Posture.block.params(for: s).jump) / 2
        XCTAssertEqual(min(mid[Joint.lAnkle.rawValue].translation.y, mid[Joint.rAnkle.rawValue].translation.y), s.ankleHeight + jump, accuracy: 1e-9)
    }
}
