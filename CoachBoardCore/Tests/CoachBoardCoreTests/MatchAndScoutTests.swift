import XCTest
@testable import CoachBoardCore

/// A 5-1 team in lineup order S, OH1, MB1, OPP, OH2, MB2 starting in R1 (setter in P1), with a libero.
struct TestTeam {
    let s = UUID(), oh1 = UUID(), mb1 = UUID(), opp = UUID(), oh2 = UUID(), mb2 = UUID(), libero = UUID(), bench = UUID()

    var sheet: TeamSheet {
        TeamSheet(startingLineup: [s, oh1, mb1, opp, oh2, mb2],
                  roles: [s: "S", oh1: "OH1", mb1: "MB1", opp: "OPP", oh2: "OH2", mb2: "MB2", libero: "L", bench: "OH"],
                  liberos: [libero], liberoPartners: [mb1, mb2])
    }
}

final class MatchStateTests: XCTestCase {
    func makeMatch(firstServer: Side = .home) throws -> (MatchState, TestTeam, TestTeam) {
        let home = TestTeam(), away = TestTeam()
        let m = MatchState(profile: try RuleCourtProfile.fivbSenior(), home: home.sheet, opponent: away.sheet, firstServer: firstServer)
        return (m, home, away)
    }

    func testSideOutRotatesOnlyTheTeamThatWinsServe() throws {
        let made = try makeMatch(firstServer: .home)
        var m = made.0
        let home = made.1
        XCTAssertEqual(m.rotationNumber(.home), 1)
        let first = try m.applyRally(winner: .home)            // server wins: no rotation
        XCTAssertFalse(first.sideOut)
        XCTAssertEqual(m.current[.home].rotations, 0)
        let second = try m.applyRally(winner: .opponent)       // side-out for the opponent
        XCTAssertTrue(second.sideOut)
        XCTAssertEqual(m.current.serving, .opponent)
        XCTAssertEqual(m.current[.opponent].rotations, 1)
        XCTAssertEqual(m.current[.home].rotations, 0)
        _ = try m.applyRally(winner: .home)                    // side-out back: home rotates, setter P1 -> P6
        XCTAssertEqual(m.rotationNumber(.home), 6)
        XCTAssertEqual(m.current.home.player(at: .p1), home.oh1, "the player from P2 now serves")
        XCTAssertEqual(m.current.score, Score(home: 2, opponent: 1))
    }

    func testRotationSequenceFollowsSideOutOrder() throws {
        var m = try makeMatch(firstServer: .opponent).0
        var seen: [Int] = [m.rotationNumber(.home)]
        for _ in 0..<6 {
            _ = try m.applyRally(winner: .home)      // side-out for home
            seen.append(m.rotationNumber(.home))
            _ = try m.applyRally(winner: .opponent)  // side-out for opponent
        }
        XCTAssertEqual(seen, [1, 6, 5, 4, 3, 2, 1])
    }

    func testSetEndsAt25WithTwoPointLeadAndDecidingSetAt15() throws {
        var m = try makeMatch().0
        for _ in 0..<24 { _ = try m.applyRally(winner: .home) }
        for _ in 0..<24 { _ = try m.applyRally(winner: .opponent) }
        XCTAssertNil(m.current.winner, "24:24 is not over")
        _ = try m.applyRally(winner: .home)
        XCTAssertNil(m.current.winner, "25:24 is not over")
        let out = try m.applyRally(winner: .home)
        XCTAssertTrue(out.setEnded)
        XCTAssertEqual(m.current.winner, .home)
        XCTAssertThrowsError(try m.applyRally(winner: .home))
        // Play to a deciding fifth set.
        for set in 2...4 {
            try m.startNextSet()
            XCTAssertEqual(m.current.number, set)
            let winner: Side = set % 2 == 0 ? .opponent : (set == 3 ? .home : .opponent)
            while m.current.winner == nil { _ = try m.applyRally(winner: winner) }
        }
        XCTAssertEqual(m.setsWonHome, 2)
        XCTAssertEqual(m.setsWonOpponent, 2)
        try m.startNextSet(firstServer: .home)
        XCTAssertEqual(m.scoring.targetPoints(forSet: m.current.number), 15)
        while m.current.winner == nil { _ = try m.applyRally(winner: .home) }
        XCTAssertEqual(m.current.score.home, 15)
        XCTAssertTrue(m.isOver)
    }

    func testFirstServerAlternatesBetweenSets() throws {
        var m = try makeMatch(firstServer: .home).0
        while m.current.winner == nil { _ = try m.applyRally(winner: .home) }
        try m.startNextSet()
        XCTAssertEqual(m.current.serving, .opponent)
    }

    func testLiberoReplacesBackRowMiddleExceptWhenTheMiddleServes() throws {
        let made = try makeMatch(firstServer: .opponent)
        var m = made.0
        let home = made.1
        // R1 receiving: MB2 is at P6 (back row) -> libero in.
        XCTAssertEqual(m.onCourt(.home)[.p6], home.libero)
        // Move home to R5: MB1 reaches P1. While home serves, MB1 must serve (liberos may not serve).
        _ = try m.applyRally(winner: .home)        // R6, home serves; MB2 now P5 -> still libero
        XCTAssertEqual(m.onCourt(.home)[.p5], home.libero)
        _ = try m.applyRally(winner: .opponent)
        _ = try m.applyRally(winner: .home)        // R5, home serves, MB1 at P1
        XCTAssertEqual(m.rotationNumber(.home), 5)
        XCTAssertEqual(m.onCourt(.home)[.p1], home.mb1, "the middle serves")
        _ = try m.applyRally(winner: .opponent)    // home loses serve: libero takes P1 for defence
        XCTAssertEqual(m.onCourt(.home)[.p1], home.libero)
    }

    func testSubstitutionPairingAndLimit() throws {
        let made = try makeMatch()
        var m = made.0
        let home = made.1
        let b1 = UUID(), b2 = UUID(), b3 = UUID()
        try m.substitute(side: .home, outgoing: home.oh2, incoming: b1)
        // A substitute may only leave for the starter it replaced.
        XCTAssertThrowsError(try m.substitute(side: .home, outgoing: b1, incoming: b2)) { error in
            XCTAssertEqual(error as? MatchError, .illegalSubstitution)
        }
        try m.substitute(side: .home, outgoing: b1, incoming: home.oh2)
        // The pair is complete: the starter cannot leave again in this set.
        XCTAssertThrowsError(try m.substitute(side: .home, outgoing: home.oh2, incoming: b2)) { error in
            XCTAssertEqual(error as? MatchError, .illegalSubstitution)
        }
        try m.substitute(side: .home, outgoing: home.oh1, incoming: b2)
        try m.substitute(side: .home, outgoing: b2, incoming: home.oh1)
        try m.substitute(side: .home, outgoing: home.opp, incoming: b3)
        try m.substitute(side: .home, outgoing: b3, incoming: home.opp)
        XCTAssertThrowsError(try m.substitute(side: .home, outgoing: home.s, incoming: UUID())) { error in
            XCTAssertEqual(error as? MatchError, .substitutionLimitReached)
        }
    }

    func testLiberoAndRoleFollowTheSlotAfterASubstitution() throws {
        let made = try makeMatch(firstServer: .opponent)
        var m = made.0
        let home = made.1
        let sub = UUID()
        // MB2 starts in P6 (back row): the libero is in for MB2.
        XCTAssertEqual(m.onCourt(.home)[.p6], home.libero)
        try m.substitute(side: .home, outgoing: home.mb2, incoming: sub)
        XCTAssertEqual(m.onCourt(.home)[.p6], home.libero)     // the libero now replaces the substitute
        XCTAssertEqual(m.displayRole(of: sub, side: .home), "MB2")
        XCTAssertTrue(m.bench(.home, listed: [sub]).contains(home.mb2))
        XCTAssertFalse(m.bench(.home, listed: [sub]).contains(sub))
    }

    func testSetPointAndMatchPoint() throws {
        var m = try makeMatch(firstServer: .home).0
        for _ in 0..<24 { try m.applyRally(winner: .home) }
        XCTAssertEqual(m.pointStatus(.home), .setPoint)
        XCTAssertNil(m.pointStatus(.opponent))
        try m.applyRally(winner: .home)
        try m.startNextSet()
        for _ in 0..<25 { try m.applyRally(winner: .home) }
        try m.startNextSet()
        for _ in 0..<24 { try m.applyRally(winner: .home) }
        XCTAssertEqual(m.pointStatus(.home), .matchPoint)
    }

    func testRotationCorrectionBySetterPosition() throws {
        var m = try makeMatch().0
        m.correctRotation(side: .home, setterPosition: .p4, rotations: nil, serving: .opponent)
        XCTAssertEqual(m.rotationNumber(.home), 4)
        XCTAssertEqual(m.current.serving, .opponent)
    }
}

final class MicroScoutTests: XCTestCase {
    let ctx = MicroScout.Context(setNumber: 1, score: Score(), homeRotation: 1, opponentRotation: 2,
                                 opponentFrontRowRoles: [.p4: "OH2", .p3: "MB2", .p2: "S"],
                                 opponentBackRowRoles: [.p5: "OH1", .p6: "OPP", .p1: "L"])

    func testTwoTapsCommitALine() {
        var s = MicroScout()
        XCTAssertEqual(s.tap(on: .opponent, at: LocalPoint(l: 1.0, d: 1.0), time: 10, context: ctx),
                       .originAccepted(LocalPoint(l: 1.0, d: 1.0)))
        guard case let .committed(line) = s.tap(on: .home, at: LocalPoint(l: 1.5, d: 7.5), time: 11.5, context: ctx) else {
            return XCTFail("expected a committed line")
        }
        XCTAssertEqual(line.originLane, .front4)
        XCTAssertEqual(line.landingCell, GridCell(zone: 5, sub: "c"))
        XCTAssertEqual(line.outcome, .inCourt)
        XCTAssertEqual(line.depth, .deep)
        XCTAssertEqual(line.attacker?.role, "OH2")
        XCTAssertEqual(s.state, .idle)
    }

    func testOriginExpiresAfterFourSeconds() {
        var s = MicroScout()
        _ = s.tap(on: .opponent, at: LocalPoint(l: 4.5, d: 1.0), time: 0, context: ctx)
        XCTAssertEqual(s.tap(on: .home, at: LocalPoint(l: 4.5, d: 5.0), time: 4.5, context: ctx), .expired)
        XCTAssertEqual(s.tap(on: .home, at: LocalPoint(l: 4.5, d: 5.0), time: 5.0, context: ctx), .rejected)
    }

    func testDirectionClassification() {
        // Opponent left-front (their l = 1) attacks straight down their left sideline:
        // in the world frame that is X = +3.5, landing on home's right side (home l = 8).
        let line = MicroScout.makeLine(origin: LocalPoint(l: 1.0, d: 0.8), landing: LocalPoint(l: 8.0, d: 7.5),
                                       time: 0, context: ctx, shortZoneDepth: 1.0)
        XCTAssertEqual(line.direction, .line)
        let cross = MicroScout.makeLine(origin: LocalPoint(l: 1.0, d: 0.8), landing: LocalPoint(l: 1.5, d: 7.5),
                                        time: 0, context: ctx, shortZoneDepth: 1.0)
        XCTAssertEqual(cross.direction, .cross)
        let cut = MicroScout.makeLine(origin: LocalPoint(l: 1.0, d: 0.8), landing: LocalPoint(l: 1.0, d: 3.0),
                                      time: 0, context: ctx, shortZoneDepth: 1.0)
        XCTAssertEqual(cut.direction, .cut)
        let out = MicroScout.makeLine(origin: LocalPoint(l: 1.0, d: 0.8), landing: LocalPoint(l: 9.6, d: 5.0),
                                      time: 0, context: ctx, shortZoneDepth: 1.0)
        XCTAssertEqual(out.outcome, .out)
    }
}
