import Foundation

/// Where an opponent attack started (blueprint Section 2.9).
public enum AttackLane: String, Codable, Sendable, CaseIterable {
    case front4, front3, front2          // front row, by lateral thirds of the opponent's frame
    case backLeft, pipe, backRight       // behind the 3.5 m depth: back-row attacks (pipe, D)

    public static func classify(_ origin: LocalPoint) -> AttackLane {
        let third = origin.l < 3 ? 0 : (origin.l < 6 ? 1 : 2)
        if origin.d <= 3.5 {
            return [AttackLane.front4, .front3, .front2][third]
        }
        return [AttackLane.backLeft, .pipe, .backRight][third]
    }
}

/// A landing cell: one of nine 3 x 3 m zones split into four 1.5 m sub-cells.
/// Zone numbers: 4, 3, 2 near the net (left to right), 7, 8, 9 in the middle, 5, 6, 1 at the back.
/// Sub-cells are the app's own convention: a = net-left, b = net-right, c = back-right, d = back-left.
public struct GridCell: Codable, Hashable, Sendable {
    public var zone: Int
    public var sub: String

    public static func locate(_ p: LocalPoint) -> GridCell? {
        guard p.l >= 0, p.l <= 9, p.d >= 0, p.d <= 9 else { return nil }
        let col = min(Int(p.l / 3), 2)
        let row = min(Int(p.d / 3), 2)
        let zones = [[4, 3, 2], [7, 8, 9], [5, 6, 1]]
        let inL = p.l - Double(col) * 3
        let inD = p.d - Double(row) * 3
        let netSide = inD < 1.5
        let leftSide = inL < 1.5
        let sub: String
        switch (netSide, leftSide) {
        case (true, true): sub = "a"
        case (true, false): sub = "b"
        case (false, false): sub = "c"
        case (false, true): sub = "d"
        }
        return GridCell(zone: zones[row][col], sub: sub)
    }
}

public enum LandingOutcome: String, Codable, Sendable {
    case inCourt, out, short
}

public enum AttackDirection: String, Codable, Sendable {
    case line, cross, cut
}

public enum AttackDepth: String, Codable, Sendable {
    case short, mid, deep
}

public struct AttributedAttacker: Codable, Hashable, Sendable {
    public var role: String
    public var probability: Double
}

/// One logged attack line (blueprint Section 2.9, journal type 0x000A).
public struct ScoutLine: Codable, Hashable, Sendable {
    public var time: Double
    public var setNumber: Int
    public var score: Score
    public var homeRotation: Int
    public var opponentRotation: Int
    /// In the opponent's frame.
    public var originRaw: LocalPoint
    /// In the home frame.
    public var landingRaw: LocalPoint
    public var originLane: AttackLane
    public var landingCell: GridCell?
    public var outcome: LandingOutcome
    public var direction: AttackDirection
    public var depth: AttackDepth
    public var attacker: AttributedAttacker?
}

public enum ScoutTapResult: Equatable, Sendable {
    case originAccepted(LocalPoint)
    case originReplaced(LocalPoint)
    case committed(ScoutLine)
    case rejected
    case expired
}

/// The two-tap state machine. Taps arrive already converted to the team-local frame of the half that was hit.
public struct MicroScout: Codable, Hashable, Sendable {
    public enum State: Codable, Hashable, Sendable {
        case idle
        case originSet(LocalPoint, Double)
    }

    public var timeout: Double = 4.0
    public var shortZoneDepth: Double = 1.0
    public private(set) var state: State = .idle

    public init() {}

    /// Context needed to stamp and attribute a committed line.
    public struct Context: Hashable, Sendable {
        public var setNumber: Int
        public var score: Score
        public var homeRotation: Int
        public var opponentRotation: Int
        public var opponentFrontRowRoles: [CourtPosition: String]
        public var opponentBackRowRoles: [CourtPosition: String]

        public init(setNumber: Int, score: Score, homeRotation: Int, opponentRotation: Int,
                    opponentFrontRowRoles: [CourtPosition: String] = [:],
                    opponentBackRowRoles: [CourtPosition: String] = [:]) {
            self.setNumber = setNumber
            self.score = score
            self.homeRotation = homeRotation
            self.opponentRotation = opponentRotation
            self.opponentFrontRowRoles = opponentFrontRowRoles
            self.opponentBackRowRoles = opponentBackRowRoles
        }
    }

    /// Expires a pending origin; returns true when an origin was dropped.
    public mutating func tick(now: Double) -> Bool {
        if case let .originSet(_, t0) = state, now - t0 > timeout {
            state = .idle
            return true
        }
        return false
    }

    public mutating func tap(on side: Side, at local: LocalPoint, time now: Double, context: Context) -> ScoutTapResult {
        let expired = tick(now: now)
        switch (state, side) {
        case (.idle, .opponent):
            state = .originSet(local, now)
            return .originAccepted(local)
        case (.originSet, .opponent):
            state = .originSet(local, now)
            return .originReplaced(local)
        case (.originSet(let origin, _), .home):
            state = .idle
            return .committed(Self.makeLine(origin: origin, landing: local, time: now, context: context,
                                            shortZoneDepth: shortZoneDepth))
        case (.idle, .home):
            return expired ? .expired : .rejected
        }
    }

    public mutating func cancel() { state = .idle }

    static func makeLine(origin: LocalPoint, landing: LocalPoint, time: Double, context: Context,
                         shortZoneDepth: Double) -> ScoutLine {
        let lane = AttackLane.classify(origin)
        let inside = landing.l >= 0 && landing.l <= 9 && landing.d >= 0 && landing.d <= 9
        let outcome: LandingOutcome = !inside ? .out : (landing.d <= shortZoneDepth ? .short : .inCourt)
        // Direction in the world frame: the attack vector from origin to landing.
        let o = CourtFrame.world(origin, of: .opponent)
        let t = CourtFrame.world(landing, of: .home)
        let dx = abs(t.x - o.x)
        let dz = abs(t.z - o.z)
        let angle = atan2(dx, max(dz, 1e-9)) * 180 / .pi
        let direction: AttackDirection
        if landing.d < 4.5 && dx >= 4.0 {
            direction = .cut
        } else if angle < 15 {
            direction = .line
        } else {
            direction = .cross
        }
        let depth: AttackDepth = landing.d < 3 ? .short : (landing.d > 6 ? .deep : .mid)
        return ScoutLine(time: time, setNumber: context.setNumber, score: context.score,
                         homeRotation: context.homeRotation, opponentRotation: context.opponentRotation,
                         originRaw: origin, landingRaw: landing, originLane: lane,
                         landingCell: GridCell.locate(landing), outcome: outcome,
                         direction: direction, depth: depth,
                         attacker: attribute(lane: lane, context: context))
    }

    /// Lane-to-role prior: front lanes map to the front-row player at the matching position after
    /// switching (OH left, MB middle, OPP or front setter right); back lanes to back-row attackers.
    static func attribute(lane: AttackLane, context: Context) -> AttributedAttacker? {
        func role(in roles: [CourtPosition: String], matching: (String) -> Bool) -> String? {
            roles.values.first(where: matching)
        }
        let front = context.opponentFrontRowRoles
        let back = context.opponentBackRowRoles
        switch lane {
        case .front4:
            if let r = role(in: front, matching: { $0.hasPrefix("OH") }) { return AttributedAttacker(role: r, probability: 0.8) }
        case .front3:
            if let r = role(in: front, matching: { $0.hasPrefix("MB") }) { return AttributedAttacker(role: r, probability: 0.8) }
        case .front2:
            if let r = role(in: front, matching: { $0 == "OPP" || $0.hasPrefix("S") }) { return AttributedAttacker(role: r, probability: 0.8) }
        case .pipe:
            if let r = role(in: back, matching: { $0.hasPrefix("OH") }) { return AttributedAttacker(role: r, probability: 0.7) }
        case .backRight:
            if let r = role(in: back, matching: { $0 == "OPP" }) { return AttributedAttacker(role: r, probability: 0.7) }
        case .backLeft:
            if let r = role(in: back, matching: { $0.hasPrefix("OH") }) { return AttributedAttacker(role: r, probability: 0.5) }
        }
        return nil
    }
}

/// Aggregation for Panic and Set Break: counts per opponent rotation and lane.
public struct ScoutSummary: Hashable, Sendable {
    public struct Key: Hashable, Sendable {
        public var opponentRotation: Int
        public var lane: AttackLane
    }

    public var counts: [Key: [AttackDirection: Int]] = [:]
    public var deep: [Key: Int] = [:]
    public var total: [Key: Int] = [:]

    public init(lines: [ScoutLine]) {
        for line in lines {
            let key = Key(opponentRotation: line.opponentRotation, lane: line.originLane)
            counts[key, default: [:]][line.direction, default: 0] += 1
            total[key, default: 0] += 1
            if line.depth == .deep { deep[key, default: 0] += 1 }
        }
    }
}
