import XCTest
@testable import CoachBoardCore

/// Deterministic strokes identical to the Python reference (verify/swift_test_strokes.py),
/// whose recognizer classifies every one of them correctly.
enum TestStrokes {
    static let n = 180

    static func linspace(_ a: Double, _ b: Double, _ n: Int) -> [Double] {
        (0..<n).map { a + (b - a) * Double($0) / Double(n - 1) }
    }

    static func rotate(_ p: [P2], _ th: Double) -> [P2] {
        p.map { P2(cos(th) * $0.x - sin(th) * $0.y, sin(th) * $0.x + cos(th) * $0.y) }
    }

    static func wobble(_ p: [P2], _ amp: Double) -> [P2] {
        let t = linspace(0, 1, p.count)
        return zip(p, t).map { q, s -> P2 in
            let dx: Double = sin(6 * Double.pi * s + 0.5)
            let dy: Double = cos(4 * Double.pi * s + 1.1)
            return q + amp * P2(dx, dy)
        }
    }

    static func polygonPath(_ corners: [P2], over: Double) -> [P2] {
        let c = corners + [corners[0]]
        var s: [Double] = [0]
        for i in 1..<c.count { s.append(s[i - 1] + ((c[i] - c[i - 1]).x * (c[i] - c[i - 1]).x + (c[i] - c[i - 1]).y * (c[i] - c[i - 1]).y).squareRoot()) }
        let total = s[s.count - 1]
        return linspace(0, 1 + over, n).map { u -> P2 in
            let t = u.truncatingRemainder(dividingBy: 1.0) * total
            var j = 0
            while j < s.count - 2 && s[j + 1] < t { j += 1 }
            let f = (t - s[j]) / (s[j + 1] - s[j])
            return c[j] + (c[j + 1] - c[j]) * f
        }
    }

    static var all: [(expected: ShapeKind, points: [P2])] {
        let t = linspace(0, 2 * .pi * 1.05, n).map { $0 + 0.3 }
        let circle = wobble(t.map { P2(2 * cos($0), 2 * sin($0)) }, 0.03)
        let ellipse = wobble(rotate(t.map { P2(3 * cos($0), 1.4 * sin($0)) }, 0.4), 0.03)
        let rect = wobble(rotate(polygonPath([P2(-2, -1.25), P2(2, -1.25), P2(2, 1.25), P2(-2, 1.25)], over: 0.06), 0.2), 0.02)
        let triangle = wobble(polygonPath([P2(-2.0, -1.5), P2(2.5, -1.0), P2(-0.3, 2.2)], over: 0.06), 0.02)
        let trapezoid = wobble(polygonPath([P2(-2.0, -1.2), P2(2.0, -1.2), P2(1.0, 1.2), P2(-1.2, 1.2)], over: 0.06), 0.02)
        let tb = linspace(0, 2 * .pi * 1.04, n)
        let bean = tb.map { a -> P2 in
            let r = 2 + 0.5 * cos(2 * a) + 0.4 * cos(3 * a + 1)
            return P2(r * cos(a), r * sin(a))
        }
        let line = wobble(linspace(0, 1, n).map { P2(5 * $0, 0.4 * $0) }, 0.01)
        let arc = linspace(0, .pi, n).map { P2(2 * cos($0), 2 * sin($0)) }
        return [(.circle, circle), (.ellipse, ellipse), (.rect, rect), (.polygon, triangle), (.polygon, trapezoid),
                (.freeform, bean), (.line, line), (.openPath, arc)]
    }
}

final class SmartGeometryTests: XCTestCase {
    func testRecognizesTheReferenceStrokes() {
        for (expected, points) in TestStrokes.all {
            let shape = SmartGeometry.recognize(points)
            XCTAssertEqual(shape.kind, expected, "expected \(expected), got \(shape.kind) (alternative \(String(describing: shape.alternative)))")
        }
    }

    func testCircleParameters() {
        let t = TestStrokes.linspace(0, 2 * .pi, 100)
        let fit = SmartGeometry.fitCircle(t.map { P2(1 + 2 * cos($0), -3 + 2 * sin($0)) })
        XCTAssertEqual(fit.center.x, 1, accuracy: 1e-6)
        XCTAssertEqual(fit.center.y, -3, accuracy: 1e-6)
        XCTAssertEqual(fit.radius, 2, accuracy: 1e-6)
    }

    func testEllipseParameters() throws {
        let t = TestStrokes.linspace(0, 2 * .pi, 200)
        let pts = TestStrokes.rotate(t.map { P2(3 * cos($0), 1.5 * sin($0)) }, 0.5).map { $0 + P2(2, 1) }
        let fit = try XCTUnwrap(SmartGeometry.fitEllipse(pts))
        XCTAssertEqual(fit.center.x, 2, accuracy: 1e-3)
        XCTAssertEqual(fit.center.y, 1, accuracy: 1e-3)
        XCTAssertEqual(fit.semiAxes.x, 3, accuracy: 1e-3)
        XCTAssertEqual(fit.semiAxes.y, 1.5, accuracy: 1e-3)
        XCTAssertLessThan(fit.rms, 1e-3)
        // Major-axis direction is 0.5 rad, modulo pi.
        let delta = (fit.angle - 0.5).truncatingRemainder(dividingBy: .pi)
        XCTAssertLessThan(min(abs(delta), .pi - abs(delta)), 1e-3)
    }

    func testMinimumAreaRectangle() {
        let corners = TestStrokes.rotate([P2(-2, -1), P2(2, -1), P2(2, 1), P2(-2, 1)], 0.3)
        let rect = SmartGeometry.minAreaRect(TestStrokes.polygonPath(corners, over: 0))
        let area = abs(SmartGeometry.cross(rect[1] - rect[0], rect[3] - rect[0]))
        XCTAssertEqual(area, 8, accuracy: 1e-6)
    }
}

final class JournalTests: XCTestCase {
    func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("journal-\(UUID().uuidString).cbj")
    }

    func testCRC32CKnownAnswer() {
        // RFC 3720 check value for the ASCII digits 1...9.
        XCTAssertEqual(CRC32C.checksum(Array("123456789".utf8)), 0xE306_9283)
    }

    func testRoundTripAndTornTailRecovery() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let header = JournalHeader(matchID: UUID(), createdAtNanoseconds: 1_700_000_000_000_000_000,
                                   profileHash: [UInt8](repeating: 7, count: 32))
        let writer = try JournalWriter(url: url, header: header)
        for i in 0..<5 {
            writer.append(type: .rallyWon, payload: try JournalPayload.encode(RallyWonPayload(winner: i % 2 == 0 ? .home : .opponent)),
                          wallClock: Int64(i))
        }
        try writer.commit()

        var data = try Data(contentsOf: url)
        let ok = try JournalCodec.read(data)
        XCTAssertEqual(ok.records.count, 5)
        XCTAssertFalse(ok.hadTornTail)
        XCTAssertEqual(ok.header.matchID, header.matchID)
        XCTAssertEqual(ok.records.map(\.seq), [1, 2, 3, 4, 5])
        XCTAssertEqual(try JournalPayload.decode(RallyWonPayload.self, from: ok.records[1].payload).winner, .opponent)

        // Simulate power loss in the middle of the last record.
        data.removeLast(7)
        try data.write(to: url)
        let torn = try JournalCodec.read(data)
        XCTAssertEqual(torn.records.count, 4)
        XCTAssertTrue(torn.hadTornTail)

        // Reopening truncates the torn tail and continues the sequence.
        let reopened = try JournalWriter(url: url, header: header)
        XCTAssertEqual(reopened.nextSeq, 5)
        reopened.append(type: .note, payload: Data(), wallClock: 9)
        try reopened.commit()
        let after = try JournalCodec.read(try Data(contentsOf: url))
        XCTAssertEqual(after.records.count, 5)
        XCTAssertFalse(after.hadTornTail)
    }

    func testCorruptedRecordStopsTheRead() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try JournalWriter(url: url, header: JournalHeader(matchID: UUID(), createdAtNanoseconds: 0,
                                                                      profileHash: [UInt8](repeating: 0, count: 32)))
        writer.append(type: .note, payload: Data([1, 2, 3]), wallClock: 0)
        writer.append(type: .note, payload: Data([4, 5, 6]), wallClock: 0)
        try writer.commit()
        var data = try Data(contentsOf: url)
        data[data.count - 6] ^= 0xFF      // flip a payload byte of the second record
        let result = try JournalCodec.read(data)
        XCTAssertEqual(result.records.count, 1)
        XCTAssertTrue(result.hadTornTail)
    }
}

final class LiveStateTests: XCTestCase {
    func makeState() throws -> (LiveState, TestTeam) {
        let home = TestTeam(), away = TestTeam()
        let setup = MatchStartedPayload(profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet,
                                        firstServer: .opponent, mode: .solo, templateID: "5-1-outside-follows-setter")
        let state = LiveState(setup: setup, profile: try RuleCourtProfile.fivbSenior(),
                              template: try TemplateLibrary.shipped("5-1-outside-follows-setter"))
        return (state, home)
    }

    func testSwipeUndoRedoIsExact() throws {
        var s = try makeState().0
        _ = s.reduce(.pointSwipe(winner: .home))
        _ = s.reduce(.pointSwipe(winner: .home))
        XCTAssertEqual(s.match.current.score, Score(home: 2, opponent: 0))
        XCTAssertEqual(s.match.rotationNumber(.home), 6)
        _ = s.reduce(.undo)
        _ = s.reduce(.undo)
        XCTAssertEqual(s.match.current.score, Score())
        XCTAssertEqual(s.match.rotationNumber(.home), 1)
        _ = s.reduce(.redo)
        XCTAssertEqual(s.match.current.score, Score(home: 1, opponent: 0))
        XCTAssertEqual(s.match.rotationNumber(.home), 6)
    }

    func testReceivingTokensComeFromTheVerifiedTemplate() throws {
        let (s, _) = try makeState()
        let tokens = s.tokens().filter { $0.side == .home }
        XCTAssertEqual(tokens.count, 6)
        // Home receives in R1: OH1 passes in the left lane at (2.2, 5.0) (Appendix A2).
        let p2 = try XCTUnwrap(tokens.first { $0.position == .p2 })
        XCTAssertEqual(p2.point, LocalPoint(l: 2.2, d: 5.0))
        XCTAssertTrue(s.currentConstraints(.home).allSatisfy(\.isLegal))
    }

    func testDraggingIntoAnOverlapReportsAFault() throws {
        var s = try makeState().0
        // Move P5 (OH2 at d 5.4) in front of P4 (OPP at d 0.6).
        let effects = s.reduce(.moveToken(side: .home, position: .p5, to: LocalPoint(l: 4.5, d: 0.3)))
        XCTAssertTrue(effects.contains(.haptic(.overlapFault)))
        XCTAssertTrue(s.currentConstraints(.home).contains { !$0.isLegal && $0.a == .p4 && $0.b == .p5 })
    }

    func testJournalReplayReproducesTheState() throws {
        let made = try makeState()
        var s = made.0
        let home = made.1
        var records: [JournalRecord] = [
            JournalRecord(type: JournalRecordType.matchStarted.rawValue, seq: 1, lamport: 1, wallClock: 0,
                          payload: try JournalPayload.encode(s.setup)),
        ]
        func run(_ e: LiveEvent) {
            var seq = s.nextSeq
            for effect in s.reduce(e) {
                if case let .journal(type, payload) = effect {
                    records.append(JournalRecord(type: type.rawValue, seq: seq, lamport: seq, wallClock: 0, payload: payload))
                    seq += 1
                }
            }
        }
        run(.pointSwipe(winner: .home))
        run(.scoutTap(side: .opponent, point: LocalPoint(l: 1, d: 1), time: 1))
        run(.scoutTap(side: .home, point: LocalPoint(l: 2, d: 7), time: 2))
        run(.pointSwipe(winner: .opponent))
        run(.substitution(side: .home, outgoing: home.oh2, incoming: home.bench))
        run(.undo)
        run(.pointSwipe(winner: .opponent))
        let replayed = try XCTUnwrap(LiveState.replay(records: records, profile: s.profile, template: s.template))
        XCTAssertEqual(replayed.match, s.match)
        XCTAssertEqual(replayed.scoutLines, s.scoutLines)
        XCTAssertEqual(replayed.nextSeq, s.nextSeq)
    }

    func testPanicFreezesScoutingAndReturnsToLive() throws {
        var s = try makeState().0
        _ = s.reduce(.scoutTap(side: .opponent, point: LocalPoint(l: 1, d: 1), time: 0))
        let effects = s.reduce(.panicPressed(time: 1))
        XCTAssertTrue(effects.contains(.haptic(.panic)))
        XCTAssertEqual(s.scout.state, .idle)
        let rejected = s.reduce(.pointSwipe(winner: .home))
        XCTAssertEqual(rejected, [.haptic(.rejected)])
        _ = s.reduce(.ink(InkStroke(points: [FloorPoint(x: 0, z: 1), FloorPoint(x: 1, z: 2)])))
        _ = s.reduce(.panicDone)
        XCTAssertEqual(s.context, .live)
        XCTAssertEqual(s.ink.count, 1)
    }
}

final class SignedDistanceTests: XCTestCase {
    func testExactAgainstBruteForce() {
        var rng = SplitMix64(seed: 7)
        let w = 23, h = 17
        let mask = (0..<(w * h)).map { _ in Double(rng.next() % 1000) / 1000 < 0.08 }
        let fast = SignedDistance.squaredDistance(feature: mask, width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                var best = Float.infinity
                for yy in 0..<h { for xx in 0..<w where mask[yy * w + xx] {
                    best = min(best, Float((x - xx) * (x - xx) + (y - yy) * (y - yy)))
                } }
                XCTAssertEqual(fast[y * w + x], best, "(\(x), \(y))")
            }
        }
    }

    func testFieldOfADisc() {
        let w = 64, h = 64
        let coverage: [UInt8] = (0..<(w * h)).map { i in
            let x = Double(i % w) - 31.5, y = Double(i / w) - 31.5
            return (x * x + y * y).squareRoot() < 16 ? 255 : 0
        }
        let sdf = SignedDistance.field(coverage: coverage, width: w, height: h, spread: 8)
        XCTAssertEqual(sdf[32 * w + 32], 255)                 // deep inside saturates
        XCTAssertEqual(sdf[0], 0)                             // far outside saturates
        let edge = Int(sdf[32 * w + 32 + 16])                 // just outside the rim
        XCTAssertTrue((100...135).contains(edge), "edge value \(edge)")
    }
}
