import XCTest
@testable import CoachBoardCore

/// Deterministic random numbers for property tests (SplitMix64).
struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

final class OverlapEngineTests: XCTestCase {
    /// The worked example of blueprint Section 2.6 / Appendix A2 (5-1, R4 receive).
    let r4: [CourtPosition: LocalPoint] = [
        .p4: LocalPoint(l: 0.9, d: 0.5), .p3: LocalPoint(l: 1.7, d: 0.9), .p2: LocalPoint(l: 2.4, d: 4.6),
        .p5: LocalPoint(l: 4.6, d: 5.1), .p6: LocalPoint(l: 6.9, d: 5.0), .p1: LocalPoint(l: 8.3, d: 7.6),
    ]

    func testWorkedExampleMarginsMatchReference() {
        let results = OverlapEngine.evaluate(r4, serving: false)
        let expected: [(CourtPosition, CourtPosition, Double)] = [
            (.p4, .p5, 4.6), (.p3, .p6, 4.1), (.p2, .p1, 3.0), (.p4, .p3, 0.8),
            (.p5, .p6, 2.3), (.p2, .p3, 0.7), (.p1, .p6, 1.4),
        ]
        XCTAssertEqual(results.count, 7)
        for (a, b, m) in expected {
            let r = results.first { $0.a == a && $0.b == b }
            XCTAssertNotNil(r)
            XCTAssertEqual(r!.margin, m, accuracy: 1e-9, "\(a.label)/\(b.label)")
        }
        XCTAssertTrue(results.allSatisfy(\.isLegal))
    }

    func testServerExemptionDropsPairsWithP1() {
        let results = OverlapEngine.evaluate(r4, serving: true)
        XCTAssertEqual(results.count, 5)
        XCTAssertFalse(results.contains { $0.a == .p1 || $0.b == .p1 })
    }

    func testLevelFeetAreAFault() {
        var f = r4
        f[.p5] = LocalPoint(l: 4.6, d: 0.5)   // exactly level with P4
        let r = OverlapEngine.evaluate(f, serving: false).first { $0.a == .p4 && $0.b == .p5 }!
        XCTAssertEqual(r.margin, 0, accuracy: 1e-12)
        XCTAssertFalse(r.isLegal, "level is not closer")
    }

    /// Property test against a literal reading of the rule on a fixed 2 mm raster (Appendix D2 uses 1 mm).
    func testAgreesWithRasterReference() {
        var rng = SplitMix64(seed: 11)
        let grid = 0.002
        func raster(_ verts: [LocalPoint]) -> [LocalPoint] {
            var out: [LocalPoint] = []
            for foot in [Array(verts[0..<4]), Array(verts[4..<8])] {
                let loop = [foot[0], foot[1], foot[3], foot[2]]
                let lo = (l: loop.map(\.l).min()!, d: loop.map(\.d).min()!)
                let hi = (l: loop.map(\.l).max()!, d: loop.map(\.d).max()!)
                var x = (lo.l / grid).rounded(.down) * grid + grid / 2
                while x <= hi.l {
                    var y = (lo.d / grid).rounded(.down) * grid + grid / 2
                    while y <= hi.d {
                        var pos = 0, neg = 0
                        for i in 0..<4 {
                            let a = loop[i], b = loop[(i + 1) % 4]
                            let c = (b.l - a.l) * (y - a.d) - (b.d - a.d) * (x - a.l)
                            if c >= 0 { pos += 1 }
                            if c <= 0 { neg += 1 }
                        }
                        if pos == 4 || neg == 4 { out.append(LocalPoint(l: x, d: y)) }
                        y += grid
                    }
                    x += grid
                }
            }
            return out
        }
        var decided = 0
        for _ in 0..<120 {
            let cl = Double.random(in: 1.5...7.5, using: &rng), cd = Double.random(in: 1.0...7.5, using: &rng)
            var positions: [CourtPosition: LocalPoint] = [:]
            var stances: [CourtPosition: Stance] = [:]
            for p in CourtPosition.allCases {
                positions[p] = LocalPoint(l: cl + Double.random(in: -0.6...0.6, using: &rng),
                                          d: cd + Double.random(in: -0.6...0.6, using: &rng))
                stances[p] = Stance(yaw: Double.random(in: -1.0...1.0, using: &rng),
                                    width: Double.random(in: 0.2...0.45, using: &rng),
                                    stagger: Double.random(in: -0.25...0.25, using: &rng))
            }
            let serving = Bool.random(using: &rng)
            var cells: [CourtPosition: [LocalPoint]] = [:]
            for p in CourtPosition.allCases {
                cells[p] = raster(Footprint.vertices(center: positions[p]!, stance: stances[p]!))
            }
            for r in OverlapEngine.evaluate(positions, stances: stances, serving: serving) {
                guard abs(r.margin) > 0.004 else { continue }   // undecidable at this raster
                let a = cells[r.a]!, b = cells[r.b]!
                let reference: Double
                switch r.kind {
                case .frontBack: reference = b.map(\.d).min()! - a.map(\.d).min()!
                case .leftCentre: reference = b.map(\.l).min()! - a.map(\.l).min()!
                case .rightCentre: reference = b.map { 9 - $0.l }.min()! - a.map { 9 - $0.l }.min()!
                }
                XCTAssertEqual(r.margin > 0, reference > 0)
                XCTAssertEqual(r.margin, reference, accuracy: 0.004)
                decided += 1
            }
        }
        XCTAssertGreaterThan(decided, 500)
    }
}

final class LegalEnvelopeTests: XCTestCase {
    func testPointsInsideTheEnvelopeAreLegalAndOutsideAreNot() throws {
        let profile = try RuleCourtProfile.fivbSenior()
        let template = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        var rng = SplitMix64(seed: 5)
        for f in template.formations where f.phase == "receive" {
            for player in CourtPosition.allCases {
                let env = LegalEnvelope.compute(for: player, positions: f.positions, serving: false, profile: profile)
                XCTAssertFalse(env.isEmpty, "R\(f.rotation) \(player.label)")
                for _ in 0..<40 {
                    let probe = LocalPoint(l: Double.random(in: -0.5...9.5, using: &rng), d: Double.random(in: -0.5...9.5, using: &rng))
                    var moved = f.positions
                    moved[player] = probe
                    let legal = OverlapEngine.isLegal(moved, serving: false, profile: profile)
                    let inside = env.contains(probe)
                    // Points well inside or well outside must agree; points on the boundary are skipped.
                    let nearEdge = min(abs(probe.l - env.lMin), abs(probe.l - env.lMax), abs(probe.d - env.dMin), abs(probe.d - env.dMax)) < 1e-6
                    if !nearEdge { XCTAssertEqual(inside, legal, "R\(f.rotation) \(player.label) at \(probe)") }
                }
            }
        }
    }
}

final class AtlasTests: XCTestCase {
    func testEveryShippedFormationIsLegalAndMatchesTheAtlas() throws {
        let profile = try RuleCourtProfile.fivbSenior()
        for template in try TemplateLibrary.allShipped() {
            for v in TemplateLibrary.validate(template, profile: profile) {
                XCTAssertTrue(v.isLegal, "\(template.id) R\(v.rotation) \(v.phase): \(v.failing)")
                XCTAssertTrue(v.matchesExpectation, "\(template.id) R\(v.rotation) \(v.phase) min margin \(v.minMargin)")
            }
        }
    }

    func testSmallestMarginsFromAppendixA() throws {
        let t = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        let expected: [Int: Double] = [1: 0.70, 6: 0.70, 5: 0.40, 4: 0.70, 3: 0.60, 2: 0.60]
        for (rotation, margin) in expected {
            let f = try XCTUnwrap(t.formation(rotation: rotation, phase: "receive"))
            XCTAssertEqual(OverlapEngine.minimumMargin(f.positions, serving: false), margin, accuracy: 0.005)
        }
    }

    func testRouteTimingMatchesAppendixA() throws {
        let t = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        let r1 = try XCTUnwrap(t.formation(rotation: 1, phase: "receive"))
        let checks = RouteTiming.check(r1, targets: t.routeTargets)
        let opp = try XCTUnwrap(checks.first { $0.role == "OPP" })
        XCTAssertEqual(opp.length, 9.18, accuracy: 0.005)
        XCTAssertEqual(opp.slack, 0.26, accuracy: 0.006)
        XCTAssertFalse(checks.contains { $0.isLate })

        // The rejected variant: OH1 passing in the right lane is 0.53 s late.
        var bad = r1
        for i in bad.players.indices {
            switch bad.players[i].role {
            case "OH1": bad.players[i].anchor = [7.0, 5.0]
            case "OH2": bad.players[i].anchor = [2.0, 5.0]
            case "L": bad.players[i].anchor = [4.5, 5.4]
            default: break
            }
        }
        let oh1 = try XCTUnwrap(RouteTiming.check(bad, targets: t.routeTargets).first { $0.role == "OH1" })
        XCTAssertTrue(oh1.isLate)
        XCTAssertEqual(oh1.slack, -0.53, accuracy: 0.006)
    }

    func testSixTwoReusesFiveOneFormations() throws {
        let t = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        let f = try XCTUnwrap(TemplateLibrary.sixTwoFormation(backRowSetterAt: .p6, from: t))
        XCTAssertTrue(f.players.contains { $0.role == "S2" && $0.position == 3 })
        XCTAssertNil(TemplateLibrary.sixTwoFormation(backRowSetterAt: .p3, from: t))
    }
}
