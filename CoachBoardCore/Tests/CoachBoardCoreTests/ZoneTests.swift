import XCTest
@testable import CoachBoardCore

final class ZoneSDFTests: XCTestCase {
    /// Brute force: distance to a densely sampled boundary, signed by containment.
    func bruteForce(_ zone: Zone, _ p: FloorPoint, inside: Bool) -> Double {
        let ring = ZoneSDF.outline(zone.geometry, samples: 4000)
        var best = Double.infinity
        for i in 0..<ring.count {
            let a = ring[i], b = ring[(i + 1) % ring.count]
            let ex = b.x - a.x, ez = b.z - a.z
            let t = max(0, min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / max(ex * ex + ez * ez, 1e-12)))
            best = min(best, hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t)))
        }
        return inside ? -best : best
    }

    func testExactDistancesAgainstSampledBoundaries() {
        var rng = SplitMix64(seed: 11)
        func r(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * Double(rng.next() % 100_000) / 100_000 }
        let zones = [
            Zone(geometry: .ellipse(center: FloorPoint(x: 0.5, z: 4), a: 2.2, b: 1.1, angle: 0.6)),
            Zone(geometry: .ellipse(center: FloorPoint(x: -1, z: -3), a: 0.8, b: 1.9, angle: -1.1)),
            Zone(geometry: .rect(center: FloorPoint(x: 1, z: 2), halfWidth: 1.5, halfDepth: 0.75, angle: 0.3)),
            Zone(geometry: .circle(center: FloorPoint(x: 0, z: 0), radius: 1.25)),
            Zone(geometry: .polygon([FloorPoint(x: -2, z: 1), FloorPoint(x: 2, z: 1.5), FloorPoint(x: 0.5, z: 4), FloorPoint(x: -1.5, z: 3)])),
        ]
        for zone in zones {
            for _ in 0..<200 {
                let p = FloorPoint(x: zone.centroid.x + r(-3, 3), z: zone.centroid.z + r(-3, 3))
                let d = zone.distance(to: p)
                let expected = bruteForce(zone, p, inside: d < 0)
                XCTAssertEqual(d, expected, accuracy: 0.004, "\(zone.geometry) at \(p)")
            }
        }
    }

    func testFreeformIsClosedAndContainsItsCentre() {
        let ring = (0..<10).map { i -> FloorPoint in
            let a = Double(i) / 10 * 2 * .pi
            return FloorPoint(x: 2 + 1.5 * cos(a) + 0.2 * cos(3 * a), z: 5 + 1.0 * sin(a))
        }
        let zone = Zone(geometry: .freeform(ring))
        XCTAssertTrue(zone.contains(FloorPoint(x: 2, z: 5)))
        XCTAssertFalse(zone.contains(FloorPoint(x: 4.2, z: 5)))
    }

    func testTagDefaults() {
        XCTAssertEqual(ZoneTag.noFly.defaultStyle.pattern, .crossHatch)
        XCTAssertEqual(ZoneTag.noFly.defaultStyle.extrusion, .wall(height: 0.5))
        XCTAssertEqual(ZoneTag.serveTarget.defaultStyle.extrusion, .cylinder(height: 1.5))
        XCTAssertEqual(ZoneTag.tipAlert.defaultStyle.edge, .dashed)
    }
}

final class ZoneSnappingTests: XCTestCase {
    func loop(center c: FloorPoint, radius r: Double, wobble: Double, phase: Double = 0.4) -> [FloorPoint] {
        (0..<120).map { i -> FloorPoint in
            let a = Double(i) / 119 * 2 * .pi * 1.04 + phase
            let rr = r * (1 + wobble * sin(3 * a + 1))
            return FloorPoint(x: c.x + rr * cos(a), z: c.z + rr * sin(a))
        }
    }

    func testSeamExampleFromTheBlueprint() throws {
        // A wobbly loop over the opponent's P4/P5 seam: (l 1.5, d 4.5) in the opponent frame (Section 3.5.3).
        let seam = CourtFrame.world(LocalPoint(l: 1.5, d: 4.5), of: .opponent)
        let stroke = loop(center: FloorPoint(x: seam.x + 0.12, z: seam.z - 0.1), radius: 1.2, wobble: 0.015)
        let result = try XCTUnwrap(ZoneBuilder.build(stroke: stroke, tag: .tipAlert))
        XCTAssertEqual(result.kind, .circle)
        guard case let .circle(center, radius) = result.zone.geometry else { return XCTFail("not a circle") }
        XCTAssertEqual(center.x, seam.x, accuracy: 1e-9)
        XCTAssertEqual(center.z, seam.z, accuracy: 1e-9)
        XCTAssertEqual(radius, 1.25, accuracy: 1e-9)
        XCTAssertEqual(result.zone.style.edge, .dashed)                       // Tip/Dump Alert default style
        XCTAssertEqual(result.zone.side, .opponent)
    }

    func testNearCellRectangleBecomesTheCell() throws {
        // Home zone 1 is x 1.5...4.5, z 6...9 (world). Draw it 4 degrees off with edges up to 0.2 m out.
        let c = FloorPoint(x: 3.05, z: 7.4)
        let zone = Zone(geometry: .rect(center: c, halfWidth: 1.6, halfDepth: 1.45, angle: 4 * .pi / 180))
        let (snapped, hits) = ZoneSnapping.snap(zone)
        XCTAssertEqual(snapped.geometry, .rect(center: FloorPoint(x: 3, z: 7.5), halfWidth: 1.5, halfDepth: 1.5, angle: 0))
        XCTAssertTrue(hits.contains(.cell(min: FloorPoint(x: 1.5, z: 6), max: FloorPoint(x: 4.5, z: 9))))
    }

    func testEdgesSnapToCourtLinesAndRotatedRectanglesStay() {
        let zone = Zone(geometry: .rect(center: FloorPoint(x: 0.4, z: 1.45), halfWidth: 2.5, halfDepth: 1.6, angle: 0))
        let (snapped, _) = ZoneSnapping.snap(zone)
        guard case let .rect(c, _, hd, _) = snapped.geometry else { return XCTFail() }
        XCTAssertEqual(c.z - hd, 0, accuracy: 1e-9)                          // centre line
        XCTAssertEqual(c.z + hd, 3, accuracy: 1e-9)                          // attack line
        let tilted = Zone(geometry: .rect(center: FloorPoint(x: 0, z: 4), halfWidth: 1, halfDepth: 0.5, angle: 0.5))
        XCTAssertEqual(ZoneSnapping.snap(tilted).0.geometry, tilted.geometry)
    }

    func testCentreSnapsToANearbyToken() throws {
        let token = FloorPoint(x: -2.2, z: 5.3)
        let stroke = loop(center: FloorPoint(x: -2.0, z: 5.4), radius: 0.9, wobble: 0.01)
        let result = try XCTUnwrap(ZoneBuilder.build(stroke: stroke, tag: .responsibility, tokens: [token]))
        guard case let .circle(center, radius) = result.zone.geometry else { return XCTFail("not a circle") }
        XCTAssertEqual(center, token)
        XCTAssertEqual(radius, 1.0, accuracy: 1e-9)
    }

    func testForcedShapeAndNoSnapping() throws {
        let stroke = loop(center: FloorPoint(x: 1, z: 4.4), radius: 1.0, wobble: 0.01)
        let rect = try XCTUnwrap(ZoneBuilder.build(stroke: stroke, forced: .rect, snapping: false))
        guard case .rect = rect.zone.geometry else { return XCTFail("not a rect") }
        let free = try XCTUnwrap(ZoneBuilder.build(stroke: stroke, forced: .freeform, snapping: false))
        guard case let .freeform(points) = free.zone.geometry else { return XCTFail("not freeform") }
        XCTAssertEqual(points.count, 16)
        let exact = try XCTUnwrap(ZoneBuilder.build(stroke: stroke, snapping: false))
        guard case let .circle(_, r) = exact.zone.geometry else { return XCTFail("not a circle") }
        XCTAssertNotEqual(r, 1.0)                                             // no quantization without snapping
    }
}

final class SceneEditorTests: XCTestCase {
    func makeScene() throws -> TacticalScene {
        let t = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        return TacticalScene.fromFormations(title: "R1", home: t, homeRotation: 1, homePhase: "receive",
                                            opponent: t, opponentRotation: 1)
    }

    func testFormationSceneHasBothTeams() throws {
        let s = try makeScene()
        XCTAssertEqual(s.tokens.filter { $0.side == .home }.count, 6)
        XCTAssertEqual(s.tokens.filter { $0.side == .opponent }.count, 6)
        // Home OH1 receives in P2 at (2.2, 5.0), opponent server stands 1 m behind its end line.
        let oh1 = try XCTUnwrap(s.tokens.first { $0.side == .home && $0.role == "OH1" })
        XCTAssertEqual(oh1.point, CourtFrame.world(LocalPoint(l: 2.2, d: 5.0), of: .home))
        XCTAssertTrue(s.tokens.contains { $0.side == .opponent && abs($0.point.z) == 10 })
    }

    func testEditsUndoAndRedoExactly() throws {
        var e = SceneEditor(scene: try makeScene())
        let original = e.scene
        let zone = Zone(geometry: .circle(center: FloorPoint(x: 1, z: -4.5), radius: 1.25), semantic: ZoneSemantic(tag: .tipAlert))
        e.addZone(zone)
        e.move(zone: zone.id, by: 0.5, -1)
        e.setTag(.noFly, zone: zone.id)
        XCTAssertEqual(e.scene.zones.first?.style.pattern, .crossHatch)
        XCTAssertEqual(e.zone(at: FloorPoint(x: 1.5, z: -5.5))?.id, zone.id)
        let token = try XCTUnwrap(e.scene.tokens.first)
        e.move(token: token.id, to: FloorPoint(x: 0, z: 2))
        e.undo(); e.undo(); e.undo(); e.undo()
        XCTAssertEqual(e.scene.zones, original.zones)
        XCTAssertEqual(e.scene.tokens, original.tokens)
        XCTAssertFalse(e.canUndo)
        e.redo(); e.redo()
        guard case let .circle(c, _) = e.scene.zones.first?.geometry else { return XCTFail() }
        XCTAssertEqual(c, FloorPoint(x: 1.5, z: -5.5))
        e.deleteZone(zone.id)
        XCTAssertFalse(e.canRedo)                    // a new edit clears the redo stack
        XCTAssertTrue(e.scene.zones.isEmpty)
    }

    func testScenesRoundTripAsJSON() throws {
        var e = SceneEditor(scene: try makeScene())
        e.addZone(Zone(geometry: .polygon([FloorPoint(x: -4.5, z: 3), FloorPoint(x: 0, z: 3), FloorPoint(x: -2, z: 6)])))
        e.addZone(Zone(geometry: .ellipse(center: FloorPoint(x: 0, z: 7), a: 2, b: 1, angle: 0.3), semantic: ZoneSemantic(tag: .serveTarget)))
        e.addInk(InkStroke(points: [FloorPoint(x: 0, z: 1), FloorPoint(x: 1, z: 2)]))
        let data = try JSONEncoder().encode(e.scene)
        XCTAssertEqual(try JSONDecoder().decode(TacticalScene.self, from: data), e.scene)
    }
}
