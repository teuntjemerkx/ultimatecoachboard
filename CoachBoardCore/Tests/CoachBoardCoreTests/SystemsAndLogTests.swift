import XCTest
@testable import CoachBoardCore

/// Six players placed on P1...P6 plus a libero, as Match Setup builds them.
struct PlacedTeam {
    let ids: [CourtPosition: PlayerID] = Dictionary(uniqueKeysWithValues: CourtPosition.allCases.map { ($0, UUID()) })
    let libero = UUID()

    func sheet(_ system: TeamSystem, anchor: CourtPosition = .p1, withLibero: Bool = true) throws -> TeamSheet {
        let t = try TemplateLibrary.template(id: system.templateID)
        return LineupBuilder.sheet(players: ids, order: t.lineupOrder, anchor: anchor,
                                   libero: withLibero ? libero : nil, liberoReplaces: t.libero?.replaces ?? [])
    }
}

final class MiddleFollowsSetterTemplateTests: XCTestCase {
    func testSmallestMarginsAndNoLateRoutes() throws {
        let t = try TemplateLibrary.shipped("5-1-middle-follows-setter")
        XCTAssertEqual(t.lineupOrder, ["S", "MB1", "OH1", "OPP", "MB2", "OH2"])
        let expected: [Int: Double] = [1: 0.70, 6: 0.60, 5: 0.80, 4: 0.80, 3: 0.60, 2: 2.40]
        for (rotation, margin) in expected {
            let f = try XCTUnwrap(t.formation(rotation: rotation, phase: "receive"))
            XCTAssertEqual(OverlapEngine.minimumMargin(f.positions, serving: false), margin, accuracy: 0.005, "R\(rotation)")
            let checks = RouteTiming.check(f, targets: t.routeTargets)
            XCTAssertFalse(checks.contains { $0.isLate }, "R\(rotation)")
            XCTAssertGreaterThanOrEqual(checks.map(\.slack).min() ?? 0, 0.25, "R\(rotation)")
            XCTAssertNotNil(t.formation(rotation: rotation, phase: "serve"))
        }
    }
}

final class TeamSystemTests: XCTestCase {
    func testRolesFollowTheLineupOrderFromTheSetter() {
        let order = ["S", "MB1", "OH1", "OPP", "MB2", "OH2"]
        let r1 = LineupBuilder.roles(order: order, anchor: .p1)
        XCTAssertEqual([r1[.p1], r1[.p2], r1[.p3], r1[.p4], r1[.p5], r1[.p6]], ["S", "MB1", "OH1", "OPP", "MB2", "OH2"])
        let r4 = LineupBuilder.roles(order: order, anchor: .p4)
        XCTAssertEqual(r4[.p4], "S")
        XCTAssertEqual(r4[.p5], "MB1")
        XCTAssertEqual(r4[.p1], "OPP")
    }

    func testSheetTakesLiberoPartnersFromTheTemplate() throws {
        let team = PlacedTeam()
        let sheet = try team.sheet(.fiveOneMiddle)
        XCTAssertEqual(sheet.liberoPartners, [team.ids[.p2]!, team.ids[.p5]!])     // MB1 and MB2
        XCTAssertEqual(sheet.roles[team.libero], "L")
        XCTAssertEqual(try team.sheet(.fourTwo).liberoPartners, [])                // the 4-2 template has no libero rule
    }

    func testMiddleFollowsSetterTokensComeFromItsTemplate() throws {
        let home = PlacedTeam(), away = PlacedTeam()
        let setup = MatchStartedPayload(profileName: "FIVB senior indoor", home: try home.sheet(.fiveOneMiddle),
                                        opponent: try away.sheet(.fiveOneOutside), firstServer: .opponent, mode: .solo,
                                        templateID: TeamSystem.fiveOneMiddle.rawValue)
        let s = LiveState(setup: setup, profile: try RuleCourtProfile.fivbSenior(),
                          template: try TemplateLibrary.template(id: setup.templateID),
                          opponentTemplate: try TemplateLibrary.template(id: TeamSystem.fiveOneOutside.rawValue))
        let tokens = s.tokens().filter { $0.side == .home }
        // R1 receive (Appendix A, middle follows setter): OH1 passes from P3 at (2.0, 4.8); the libero is in P5.
        XCTAssertEqual(tokens.first { $0.position == .p3 }?.point, LocalPoint(l: 2.0, d: 4.8))
        let p5 = try XCTUnwrap(tokens.first { $0.position == .p5 })
        XCTAssertTrue(p5.isLibero)
        XCTAssertEqual(p5.point, LocalPoint(l: 4.5, d: 5.4))
        XCTAssertTrue(s.currentConstraints(.home).allSatisfy(\.isLegal))
        // The opponent serves in its own 5-1 serve formation.
        XCTAssertEqual(s.tokens().first { $0.side == .opponent && $0.position == .p1 }?.point.d, 10.0)
    }

    func testSixTwoUsesTheBackRowSetter() throws {
        let six = try TemplateLibrary.template(id: "6-2")
        let five = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        let home = PlacedTeam(), away = PlacedTeam()
        // S1 starts in P4, so S2 is in P1: the back-row setter is in P1 and the 5-1 R1 formation applies.
        var m = MatchState(profile: try RuleCourtProfile.fivbSenior(), home: try home.sheet(.sixTwo, anchor: .p4),
                           opponent: try away.sheet(.fiveOneOutside), firstServer: .opponent)
        XCTAssertEqual(six.formation(for: m, side: .home, phase: "receive")?.positions,
                       five.formation(rotation: 1, phase: "receive")?.positions)
        try m.applyRally(winner: .home)                       // side-out: S2 moves to P6
        XCTAssertEqual(six.formation(for: m, side: .home, phase: "serve")?.positions,
                       five.formation(rotation: 6, phase: "serve")?.positions)
        for v in TemplateLibrary.validate(six, profile: try RuleCourtProfile.fivbSenior()) {
            XCTAssertTrue(v.isLegal && v.matchesExpectation)
        }
    }

    func testFourTwoUsesTheFrontRowSetterAndYouthWIsPositional() throws {
        let fourTwo = try TemplateLibrary.template(id: "4-2")
        let youth = try TemplateLibrary.template(id: "youth-w")
        let home = PlacedTeam(), away = PlacedTeam()
        let m = MatchState(profile: try RuleCourtProfile.fivbSenior(), home: try home.sheet(.fourTwo, anchor: .p1),
                           opponent: try away.sheet(.youthW), firstServer: .opponent)
        // S1 in P1, so S2 is the front-row setter in P4: pattern A.
        XCTAssertEqual(fourTwo.formation(for: m, side: .home, phase: "receive")?.rotation, 4)
        XCTAssertNil(fourTwo.formation(for: m, side: .home, phase: "serve"))
        XCTAssertEqual(youth.formation(for: m, side: .opponent, phase: "receive")?.rotation, 0)
        XCTAssertNil(youth.formation(for: m, side: .opponent, phase: "serve"))
        XCTAssertEqual(m.rotationNumber(.home), 1)            // named by S1
    }
}

final class NextSetAndStatsTests: XCTestCase {
    func makeState(firstServer: Side = .opponent) throws -> (LiveState, TestTeam) {
        let home = TestTeam(), away = TestTeam()
        let setup = MatchStartedPayload(profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet,
                                        firstServer: firstServer, mode: .solo, templateID: "5-1-outside-follows-setter")
        let state = LiveState(setup: setup, profile: try RuleCourtProfile.fivbSenior(),
                              template: try TemplateLibrary.shipped("5-1-outside-follows-setter"))
        return (state, home)
    }

    func testLineupForEveryStartingRotation() throws {
        let home = TestTeam(), away = TestTeam()
        let m = MatchState(profile: try RuleCourtProfile.fivbSenior(), home: home.sheet, opponent: away.sheet, firstServer: .home)
        for r in 1...6 {
            let lineup = try XCTUnwrap(m.lineup(.home, startingIn: r))
            XCTAssertEqual(lineup[r - 1], home.s, "setter starts in P\(r)")
            // Rotational order is kept: the player after the setter is still OH1.
            XCTAssertEqual(lineup[r % 6], home.oh1)
        }
    }

    func testRallyHistoryAndSideOutRecords() throws {
        var s = try makeState(firstServer: .opponent).0
        for w: Side in [.home, .home, .opponent, .opponent, .home] { _ = s.reduce(.pointSwipe(winner: w)) }
        XCTAssertEqual(s.rallies.count, 5)
        XCTAssertTrue(s.rallies[0].sideOut)
        XCTAssertFalse(s.rallies[1].sideOut)
        XCTAssertEqual(s.rallies[2].scoreBefore, Score(home: 2, opponent: 0))
        XCTAssertEqual(s.rallies[0].homeRotation, 1)
        XCTAssertEqual(s.rallies[1].homeRotation, 6)
        let records = RotationStats.records(s.rallies, side: .home, setNumber: 1)
        XCTAssertEqual(records[0].receiveWon, 1)                      // R1
        XCTAssertEqual(records[5].receiveWon, 1)                      // R6
        XCTAssertEqual(records[5].receiveLost, 1)
        XCTAssertEqual(records[5].serveWon, 1)
        XCTAssertEqual(records[5].serveLost, 1)
        XCTAssertEqual(RotationStats.suggestedStart(records)?.rotation, 1)
        _ = s.reduce(.undo)
        XCTAssertEqual(s.rallies.count, 4)
    }

    func testNextSetStartsInTheChosenRotationAndReplays() throws {
        let made = try makeState(firstServer: .home)
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
        for _ in 0..<25 { run(.pointSwipe(winner: .home)) }
        XCTAssertEqual(s.context, .setBreak)
        run(.startNextSet(firstServer: .opponent, homeStartRotation: 4))
        XCTAssertEqual(s.match.current.number, 2)
        XCTAssertEqual(s.match.rotationNumber(.home), 4)
        XCTAssertEqual(s.match.current.home.player(at: .p4), home.s)
        let replayed = try XCTUnwrap(LiveState.replay(records: records, profile: s.profile))
        XCTAssertEqual(replayed.match, s.match)
        XCTAssertEqual(replayed.rallies, s.rallies)
    }

    func testRewoundShowsTheStateBeforeARally() throws {
        var s = try makeState().0
        for w: Side in [.home, .opponent, .opponent] { _ = s.reduce(.pointSwipe(winner: w)) }
        let third = s.rallies[2]
        let before = s.rewound(before: third.seq)
        XCTAssertEqual(before.match.current.score, third.scoreBefore)
        XCTAssertEqual(before.match.current.serving, third.serving)
        XCTAssertEqual(before.rallies.count, 2)
        XCTAssertEqual(s.match.current.score, Score(home: 1, opponent: 2))     // the original is untouched
    }

    func testMatchLogAttachesEventsToTheirRally() throws {
        var s = try makeState().0
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
        run(.panicPressed(time: 3))
        run(.ink(InkStroke(points: [FloorPoint(x: 0, z: 1), FloorPoint(x: 1, z: 2)])))
        run(.panicDone)
        run(.pointSwipe(winner: .opponent))
        let second = s.rallies[1]
        records.append(JournalRecord(type: JournalRecordType.note.rawValue, seq: s.nextSeq, lamport: s.nextSeq, wallClock: 0,
                                     payload: try JournalPayload.encode(NotePayload(afterSeq: second.seq, text: "late block"))))
        let rows = MatchLog.rows(state: s, records: records)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].scoutLines, 0)
        XCTAssertEqual(rows[1].scoutLines, 1)
        XCTAssertEqual(rows[1].sketchStrokes, 1)
        XCTAssertEqual(rows[1].timeOuts, 1)
        XCTAssertEqual(rows[1].notes, ["late block"])
        XCTAssertEqual(rows[1].rally.scoreAfter, Score(home: 1, opponent: 1))
    }
}

final class SkillCodingTests: XCTestCase {
    func makeState() throws -> (LiveState, TestTeam, TestTeam) {
        let home = TestTeam(), away = TestTeam()
        let setup = MatchStartedPayload(profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet,
                                        firstServer: .opponent, mode: .advanced, templateID: "5-1-outside-follows-setter")
        let state = LiveState(setup: setup, profile: try RuleCourtProfile.fivbSenior(),
                              template: try TemplateLibrary.shipped("5-1-outside-follows-setter"))
        return (state, home, away)
    }

    func testCodesAreJournalledUndoneAndReplayed() throws {
        let made = try makeState()
        var s = made.0
        let home = made.1, away = made.2
        var records: [JournalRecord] = [
            JournalRecord(type: JournalRecordType.matchStarted.rawValue, seq: 1, lamport: 1, wallClock: 0,
                          payload: try JournalPayload.encode(s.setup)),
        ]
        func run(_ e: LiveEvent) -> [LiveEffect] {
            var seq = s.nextSeq
            let effects = s.reduce(e)
            for effect in effects {
                if case let .journal(type, payload) = effect {
                    records.append(JournalRecord(type: type.rawValue, seq: seq, lamport: seq, wallClock: 0, payload: payload))
                    seq += 1
                }
            }
            return effects
        }
        _ = run(.skill(side: .opponent, player: away.s, skill: .serve, grade: .fair))
        let effects = run(.skill(side: .home, player: home.oh1, skill: .reception, grade: .positive))
        XCTAssertTrue(effects.contains { if case .journal(.skillCode, _) = $0 { return true } else { return false } })
        XCTAssertEqual(s.codesThisRally.map(\.code), ["S!", "R+"])
        _ = run(.skill(side: .home, player: home.oh2, skill: .attack, grade: .error))
        _ = run(.undo)
        XCTAssertEqual(s.skillCodes.count, 2)
        _ = run(.skill(side: .home, player: home.oh2, skill: .attack, grade: .perfect))
        _ = run(.pointSwipe(winner: .home))
        XCTAssertTrue(s.codesThisRally.isEmpty)
        XCTAssertEqual(s.skillCodes.last?.score, Score())                     // coded before the rally ended
        let replayed = try XCTUnwrap(LiveState.replay(records: records, profile: s.profile))
        XCTAssertEqual(replayed.skillCodes, s.skillCodes)
        let rows = MatchLog.rows(state: replayed, records: records)
        XCTAssertEqual(rows.first?.skills.map(\.code), ["S!", "R+", "A#"])
    }

    func testPredictorAndStats() {
        let p = UUID()
        func code(_ side: Side, _ skill: Skill) -> SkillCode {
            SkillCode(side: side, player: p, skill: skill, grade: .positive, setNumber: 1, score: Score(),
                      homeRotation: 1, opponentRotation: 1)
        }
        XCTAssertEqual(SkillPredictor.next(side: .home, isServer: true, isFrontRow: false, role: "OH1",
                                           serving: .home, codesThisRally: []), .serve)
        XCTAssertEqual(SkillPredictor.next(side: .home, isServer: false, isFrontRow: false, role: "OH1",
                                           serving: .opponent, codesThisRally: []), .reception)
        XCTAssertEqual(SkillPredictor.next(side: .home, isServer: false, isFrontRow: true, role: "MB2",
                                           serving: .home, codesThisRally: []), .block)
        let received = [code(.opponent, .serve), code(.home, .reception)]
        XCTAssertEqual(SkillPredictor.next(side: .home, isServer: false, isFrontRow: true, role: "S",
                                           serving: .opponent, codesThisRally: received), .set)
        XCTAssertEqual(SkillPredictor.next(side: .home, isServer: false, isFrontRow: true, role: "OH2",
                                           serving: .opponent, codesThisRally: received), .attack)
        XCTAssertEqual(SkillPredictor.next(side: .opponent, isServer: false, isFrontRow: true, role: "MB1",
                                           serving: .opponent, codesThisRally: received + [code(.home, .attack)]), .block)

        var line = SkillLine()
        line.counts = [.perfect: 5, .positive: 2, .fair: 1, .poor: 1, .error: 1]
        XCTAssertEqual(line.total, 10)
        XCTAssertEqual(line.positiveRate ?? 0, 0.7, accuracy: 1e-9)
        XCTAssertEqual(line.efficiency ?? 0, 0.3, accuracy: 1e-9)
    }

    func testRingPreviewLoadsAnyRotationAndPhase() throws {
        let made = try makeState()
        let s = made.0
        let home = made.1
        let preview = s.previewing(homeRotation: 4, phase: "receive")
        XCTAssertEqual(preview.match.rotationNumber(.home), 4)
        XCTAssertEqual(preview.match.current.home.player(at: .p4), home.s)
        let p4 = try XCTUnwrap(preview.tokens().first { $0.side == .home && $0.position == .p4 })
        XCTAssertEqual(p4.point, LocalPoint(l: 0.9, d: 0.5))                  // Appendix A2, R4 receive
        XCTAssertEqual(s.match.rotationNumber(.home), 1)                       // the live state is untouched
        let serve = s.previewing(homeRotation: 2, phase: "serve")
        XCTAssertEqual(serve.match.current.serving, .home)
        XCTAssertEqual(serve.tokens().first { $0.side == .home && $0.position == .p1 }?.point.d, 10.0)
    }
}
