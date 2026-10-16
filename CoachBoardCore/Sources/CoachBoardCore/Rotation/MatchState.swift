import Foundation

public typealias PlayerID = UUID

public struct Score: Codable, Hashable, Sendable {
    public var home: Int
    public var opponent: Int

    public init(home: Int = 0, opponent: Int = 0) {
        self.home = home
        self.opponent = opponent
    }

    public subscript(side: Side) -> Int {
        get { side == .home ? home : opponent }
        set { if side == .home { home = newValue } else { opponent = newValue } }
    }
}

/// One team's roster facts that the rotation engine needs.
public struct TeamSheet: Codable, Hashable, Sendable {
    /// Players at P1...P6 at the start of the set (index 0 = P1).
    public var startingLineup: [PlayerID]
    /// Role names as used in templates ("S", "OH1", "MB1", "OPP", ...).
    public var roles: [PlayerID: String]
    public var liberos: [PlayerID]
    /// Players the libero automatically replaces in the back row (normally the two middles).
    public var liberoPartners: Set<PlayerID>

    public init(startingLineup: [PlayerID], roles: [PlayerID: String] = [:],
                liberos: [PlayerID] = [], liberoPartners: Set<PlayerID> = []) {
        precondition(startingLineup.count == 6, "a lineup has six players")
        self.startingLineup = startingLineup
        self.roles = roles
        self.liberos = liberos
        self.liberoPartners = liberoPartners
    }

    public func role(of id: PlayerID) -> String? { roles[id] }
}

/// A team's rotational state inside one set.
public struct TeamInSet: Codable, Hashable, Sendable {
    /// Rotational order as at the start of the set; substitutions replace a slot in place.
    public var lineup: [PlayerID]
    /// Side-out rotations performed in this set.
    public var rotations: Int
    public var substitutionsUsed: Int

    public init(lineup: [PlayerID]) {
        self.lineup = lineup
        self.rotations = 0
        self.substitutionsUsed = 0
    }

    /// Lineup mapping of blueprint Section 2.5: player(i, n) = L[(i - 1 + n) mod 6].
    public func player(at pos: CourtPosition) -> PlayerID {
        lineup[(pos.rawValue - 1 + rotations) % 6]
    }

    public func position(of id: PlayerID) -> CourtPosition? {
        CourtPosition.allCases.first { player(at: $0) == id }
    }
}

public struct SetState: Codable, Hashable, Sendable {
    public var number: Int
    public var score: Score
    public var serving: Side
    public var firstServer: Side
    public var home: TeamInSet
    public var opponent: TeamInSet
    public var winner: Side?

    public subscript(side: Side) -> TeamInSet {
        get { side == .home ? home : opponent }
        set { if side == .home { home = newValue } else { opponent = newValue } }
    }
}

public struct RallyOutcome: Hashable, Sendable {
    public var winner: Side
    public var sideOut: Bool
    public var setEnded: Bool
    public var matchEnded: Bool
}

public enum MatchError: Error, Equatable {
    case matchOver
    case setOver
    case setNotOver
    case playerNotOnCourt
    case substitutionLimitReached
    case notALiberoChange
}

/// The rally-by-rally state machine behind the Point Swipe Wheel (blueprint Section 2.5).
public struct MatchState: Codable, Hashable, Sendable {
    public var scoring: RuleCourtProfile.Scoring
    public var maxSubstitutionsPerSet: Int
    public var liberoMayServe: Bool
    public var sheets: [Side: TeamSheet]
    public var sets: [SetState]
    public var setsWonHome: Int
    public var setsWonOpponent: Int

    public init(profile: RuleCourtProfile, home: TeamSheet, opponent: TeamSheet, firstServer: Side) {
        self.scoring = profile.scoring
        self.maxSubstitutionsPerSet = profile.substitutions.maxPerSet
        self.liberoMayServe = profile.libero.mayServe
        self.sheets = [.home: home, .opponent: opponent]
        self.sets = [SetState(number: 1, score: Score(), serving: firstServer, firstServer: firstServer,
                              home: TeamInSet(lineup: home.startingLineup),
                              opponent: TeamInSet(lineup: opponent.startingLineup), winner: nil)]
        self.setsWonHome = 0
        self.setsWonOpponent = 0
    }

    public var current: SetState {
        get { sets[sets.count - 1] }
        set { sets[sets.count - 1] = newValue }
    }

    public func setsWon(_ side: Side) -> Int { side == .home ? setsWonHome : setsWonOpponent }

    public var isOver: Bool { setsWonHome == scoring.setsToWin || setsWonOpponent == scoring.setsToWin }

    /// Applies one rally outcome: score, side-out rotation, serve, set and match end.
    @discardableResult
    public mutating func applyRally(winner: Side) throws -> RallyOutcome {
        guard !isOver else { throw MatchError.matchOver }
        guard current.winner == nil else { throw MatchError.setOver }
        var set = current
        set.score[winner] += 1
        let sideOut = winner != set.serving
        if sideOut {
            set[winner].rotations += 1
            set.serving = winner
        }
        let target = scoring.targetPoints(forSet: set.number)
        let mine = set.score[winner]
        let theirs = set.score[winner.other]
        var setEnded = false
        if mine >= target && mine - theirs >= scoring.winBy {
            set.winner = winner
            setEnded = true
            if winner == .home { setsWonHome += 1 } else { setsWonOpponent += 1 }
        }
        current = set
        return RallyOutcome(winner: winner, sideOut: sideOut, setEnded: setEnded, matchEnded: isOver)
    }

    /// Starts the next set. Without explicit lineups the starting lineups of the previous set are reused;
    /// without an explicit first server the team that did not serve first in the previous set serves first.
    public mutating func startNextSet(homeLineup: [PlayerID]? = nil, opponentLineup: [PlayerID]? = nil,
                                      firstServer: Side? = nil) throws {
        guard current.winner != nil else { throw MatchError.setNotOver }
        guard !isOver else { throw MatchError.matchOver }
        let previous = current
        let server = firstServer ?? previous.firstServer.other
        let home = homeLineup ?? sheets[.home]?.startingLineup ?? previous.home.lineup
        let opponent = opponentLineup ?? sheets[.opponent]?.startingLineup ?? previous.opponent.lineup
        sets.append(SetState(number: previous.number + 1, score: Score(), serving: server, firstServer: server,
                             home: TeamInSet(lineup: home), opponent: TeamInSet(lineup: opponent), winner: nil))
    }

    /// A regular substitution: `incoming` takes `outgoing`'s rotational slot.
    public mutating func substitute(side: Side, outgoing: PlayerID, incoming: PlayerID) throws {
        var set = current
        guard set[side].substitutionsUsed < maxSubstitutionsPerSet else { throw MatchError.substitutionLimitReached }
        guard let slot = set[side].lineup.firstIndex(of: outgoing) else { throw MatchError.playerNotOnCourt }
        set[side].lineup[slot] = incoming
        set[side].substitutionsUsed += 1
        current = set
    }

    /// Manual correction of a rotation or serving side (journal type 0x0012, Appendix C6).
    public mutating func correctRotation(side: Side, setterPosition: CourtPosition?, rotations: Int?, serving: Side?) {
        var set = current
        if let rotations { set[side].rotations = ((rotations % 6) + 6) % 6 }
        if let setterPosition, let slot = setterSlot(side) {
            // Find n such that (setterPosition - 1 + n) mod 6 == slot.
            set[side].rotations = ((slot - (setterPosition.rawValue - 1)) % 6 + 6) % 6
        }
        if let serving { set.serving = serving }
        current = set
    }

    // MARK: - Derived views

    /// Players on court by position, with the libero applied automatically: the libero replaces a
    /// partner (normally a middle) in the back row, except when that partner is serving and liberos may not serve.
    public func onCourt(_ side: Side) -> [CourtPosition: PlayerID] {
        let team = current[side]
        var out: [CourtPosition: PlayerID] = [:]
        let sheet = sheets[side]
        for pos in CourtPosition.allCases {
            let id = team.player(at: pos)
            out[pos] = id
            guard let sheet, let libero = sheet.liberos.first, pos.isBackRow, sheet.liberoPartners.contains(id) else { continue }
            let partnerServes = pos == .p1 && current.serving == side
            if partnerServes && !liberoMayServe { continue }
            out[pos] = libero
        }
        return out
    }

    /// Rotation number named by the setter's position (R1 = setter in P1), or by sequence when no setter is known.
    public func rotationNumber(_ side: Side) -> Int {
        let team = current[side]
        if let slot = setterSlot(side) {
            // player(at: pos) = lineup[(pos - 1 + n) mod 6], so the setter's slot s sits at pos = ((s - n) mod 6) + 1.
            // Using the slot keeps the numbering right after the setter has been substituted out.
            return ((slot - team.rotations) % 6 + 6) % 6 + 1
        }
        // No setter known: count side-outs in the R1, R6, R5, ... direction.
        return (6 - team.rotations % 6) % 6 + 1
    }

    /// The rotational slot of the team's setter in this set's lineup order ("S" in a 5-1, "S1" in a 4-2 or 6-2).
    func setterSlot(_ side: Side) -> Int? {
        slot(ofRole: "S", side: side) ?? slot(ofRole: "S1", side: side)
    }

    /// The rotational slot of the player who started the set with `role`; substitutes keep the slot.
    public func slot(ofRole role: String, side: Side) -> Int? {
        guard let sheet = sheets[side], let id = sheet.roles.first(where: { $0.value == role })?.key else { return nil }
        return current[side].lineup.firstIndex(of: id) ?? sheet.startingLineup.firstIndex(of: id)
    }

    /// Court positions currently held by the rotational slots of the given roles.
    public func positions(ofRoles roles: [String], side: Side) -> [CourtPosition] {
        let n = current[side].rotations
        return roles.compactMap { slot(ofRole: $0, side: side) }
            .compactMap { CourtPosition(rawValue: (($0 - n) % 6 + 6) % 6 + 1) }
    }

    /// The team's starting lineup rotated so that the next set starts in `rotation`
    /// (named by the setter's position; by side-out sequence when no setter is known).
    public func lineup(_ side: Side, startingIn rotation: Int) -> [PlayerID]? {
        guard let base = sheets[side]?.startingLineup, (1...6).contains(rotation) else { return nil }
        let setter = sheets[side].flatMap { s in s.roles.first { $0.value == "S" }?.key ?? s.roles.first { $0.value == "S1" }?.key }
        let k: Int
        if let setter, let s = base.firstIndex(of: setter) {
            k = ((s - (rotation - 1)) % 6 + 6) % 6        // player(at: P_rotation) is then the setter
        } else {
            k = (7 - rotation) % 6                          // inverse of the sequence numbering above
        }
        return (0..<6).map { base[($0 + k) % 6] }
    }

    /// The server and the next servers of a team, in order.
    public func servingOrder(_ side: Side, count: Int = 3) -> [PlayerID] {
        var team = current[side]
        var out: [PlayerID] = []
        if current.serving != side { team.rotations += 1 }   // the team must win a side-out first
        for _ in 0..<count {
            out.append(team.player(at: .p1))
            team.rotations += 1
        }
        return out
    }
}
