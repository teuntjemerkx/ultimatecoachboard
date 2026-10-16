import Foundation

/// The playing systems Match Setup offers (Appendix C2, Screen 2), each backed by a verified template.
public enum TeamSystem: String, Codable, CaseIterable, Sendable, Hashable {
    case fiveOneOutside = "5-1-outside-follows-setter"
    case fiveOneMiddle = "5-1-middle-follows-setter"
    case sixTwo = "6-2"
    case fourTwo = "4-2"
    case youthW = "youth-w"

    public var templateID: String { rawValue }

    public var displayName: String {
        switch self {
        case .fiveOneOutside: return "5-1 · outside follows setter"
        case .fiveOneMiddle: return "5-1 · middle follows setter"
        case .sixTwo: return "6-2"
        case .fourTwo: return "4-2"
        case .youthW: return "Youth W"
        }
    }

    /// Display names of the roles in rotational order (index 0 names the rotation).
    public var roleNames: [String] {
        switch self {
        case .fiveOneOutside: return ["Setter", "Outside 1", "Middle 1", "Opposite", "Outside 2", "Middle 2"]
        case .fiveOneMiddle: return ["Setter", "Middle 1", "Outside 1", "Opposite", "Middle 2", "Outside 2"]
        case .sixTwo, .fourTwo: return ["Setter 1", "Outside 1", "Middle 1", "Setter 2", "Outside 2", "Middle 2"]
        case .youthW: return ["Player A", "Player B", "Player C", "Player D", "Player E", "Player F"]
        }
    }

    /// True when the first role is a setter, so the coach marks who sets.
    public var hasSetter: Bool { self != .youthW }
}

/// Builds team sheets from players placed on court positions (Match Setup's position slots).
public enum LineupBuilder {
    /// Roles by court position when the template's first role stands in `anchor`:
    /// P_i holds order[(i - anchor) mod 6], the convention of Appendix A.
    public static func roles(order: [String], anchor: CourtPosition) -> [CourtPosition: String] {
        precondition(order.count == 6, "a lineup order has six roles")
        var out: [CourtPosition: String] = [:]
        for pos in CourtPosition.allCases {
            out[pos] = order[((pos.rawValue - anchor.rawValue) % 6 + 6) % 6]
        }
        return out
    }

    /// A team sheet from players by position, with roles derived from the lineup order and the libero
    /// partners taken from the template's libero rule.
    public static func sheet(players: [CourtPosition: PlayerID], order: [String], anchor: CourtPosition,
                             libero: PlayerID?, liberoReplaces: [String]) -> TeamSheet {
        let roleByPosition = roles(order: order, anchor: anchor)
        let lineup = (1...6).map { players[CourtPosition(rawValue: $0)!]! }
        var roles: [PlayerID: String] = [:]
        var partners: Set<PlayerID> = []
        for (pos, id) in players {
            let role = roleByPosition[pos]!
            roles[id] = role
            if liberoReplaces.contains(role) { partners.insert(id) }
        }
        var liberos: [PlayerID] = []
        if let libero {
            liberos = [libero]
            roles[libero] = "L"
        }
        return TeamSheet(startingLineup: lineup, roles: roles, liberos: liberos,
                         liberoPartners: liberos.isEmpty ? [] : partners)
    }
}

extension TemplateLibrary {
    /// A template by id, including the 6-2, which is derived from the verified 5-1 (Appendix A4).
    public static func template(id: String) throws -> RotationTemplate {
        if id == TeamSystem.sixTwo.rawValue { return sixTwo(from: try shipped(TeamSystem.fiveOneOutside.rawValue)) }
        return try shipped(id)
    }

    /// The 6-2: indexed by the back-row setter's position (1, 6 or 5), each formation is the 5-1 formation
    /// of that rotation with the back-row setter as S1 and the front-row setter in the opposite's place.
    public static func sixTwo(from fiveOne: RotationTemplate) -> RotationTemplate {
        var t = fiveOne
        t.id = TeamSystem.sixTwo.rawValue
        t.system = "6-2"
        t.lineupOrder = ["S1", "OH1", "MB1", "S2", "OH2", "MB2"]
        t.formations = fiveOne.formations.filter { [1, 6, 5].contains($0.rotation) }.map { f in
            var f = f
            for i in f.players.indices {
                switch f.players[i].role {
                case "S": f.players[i].role = "S1"
                case "OPP": f.players[i].role = "S2"
                default: break
                }
            }
            f.note = "6-2 formation derived from 5-1 R\(f.rotation)"
            return f
        }
        t.note = "Indexed by the back-row setter's position; S1 is whichever setter is in the back row."
        return t
    }
}

extension RotationTemplate {
    /// The formation a team stands in for this template's system (blueprint Section 2.6, Appendix A),
    /// or nil when the system defines none for that phase (the board then uses generic anchors).
    public func formation(for match: MatchState, side: Side, phase: String) -> Formation? {
        switch system {
        case "6-2":
            guard let back = match.positions(ofRoles: ["S1", "S2"], side: side).first(where: { !$0.isFrontRow }) else { return nil }
            return formation(rotation: back.rawValue, phase: phase)
        case "4-2":
            guard phase == "receive",
                  let front = match.positions(ofRoles: ["S1", "S2"], side: side).first(where: \.isFrontRow) else { return nil }
            return formation(rotation: front.rawValue, phase: "receive")
        case "youth-W":
            return phase == "receive" ? formation(rotation: 0, phase: "receive") : nil
        default:
            return formation(rotation: match.rotationNumber(side), phase: phase)
        }
    }
}
