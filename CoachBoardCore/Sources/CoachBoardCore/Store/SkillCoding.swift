import Foundation

/// Skills of the Advanced Mode coding pad (Appendix C2, Screen 4), in the usual scouting letters.
public enum Skill: String, Codable, CaseIterable, Sendable, Hashable {
    case serve = "S", reception = "R", set = "E", attack = "A", block = "B", dig = "D", freeball = "F"

    public var name: String {
        switch self {
        case .serve: return "Serve"
        case .reception: return "Reception"
        case .set: return "Set"
        case .attack: return "Attack"
        case .block: return "Block"
        case .dig: return "Dig"
        case .freeball: return "Free ball"
        }
    }
}

/// Grades from best to worst: # perfect (ace, kill, perfect pass), + positive, ! fair, − negative,
/// / poor (overpass, blocked), = error.
public enum SkillGrade: String, Codable, CaseIterable, Sendable, Hashable {
    case perfect = "#", positive = "+", fair = "!", negative = "-", poor = "/", error = "="

    /// The character shown on chips (a true minus sign for the negative grade).
    public var symbol: String { self == .negative ? "\u{2212}" : rawValue }
}

/// One coded touch (journal type 0x000D), with the rally context it was coded in.
public struct SkillCode: Codable, Hashable, Sendable {
    public var side: Side
    public var player: PlayerID
    public var skill: Skill
    public var grade: SkillGrade
    public var setNumber: Int
    /// Score when the touch was coded, which is the score before the rally it belongs to.
    public var score: Score
    public var homeRotation: Int
    public var opponentRotation: Int

    public var code: String { skill.rawValue + grade.rawValue }
}

/// One player's line in a skill table.
public struct SkillLine: Hashable, Sendable {
    public var counts: [SkillGrade: Int] = [:]

    public var total: Int { counts.values.reduce(0, +) }
    public func count(_ g: SkillGrade) -> Int { counts[g] ?? 0 }
    /// Share of # and + touches.
    public var positiveRate: Double? { total == 0 ? nil : Double(count(.perfect) + count(.positive)) / Double(total) }
    /// (# − / − =) / total: kills minus blocked and errors for attacks, aces minus errors for serves.
    public var efficiency: Double? {
        total == 0 ? nil : Double(count(.perfect) - count(.poor) - count(.error)) / Double(total)
    }
}

public enum SkillStats {
    /// Per player and skill, over one set or the whole match.
    public static func table(_ codes: [SkillCode], side: Side, setNumber: Int? = nil) -> [PlayerID: [Skill: SkillLine]] {
        var out: [PlayerID: [Skill: SkillLine]] = [:]
        for c in codes where c.side == side && (setNumber == nil || c.setNumber == setNumber) {
            out[c.player, default: [:]][c.skill, default: SkillLine()].counts[c.grade, default: 0] += 1
        }
        return out
    }

    /// Team totals per skill.
    public static func team(_ codes: [SkillCode], side: Side, setNumber: Int? = nil) -> [Skill: SkillLine] {
        var out: [Skill: SkillLine] = [:]
        for c in codes where c.side == side && (setNumber == nil || c.setNumber == setNumber) {
            out[c.skill, default: SkillLine()].counts[c.grade, default: 0] += 1
        }
        return out
    }
}

public enum SkillPredictor {
    /// The skill a coach most likely codes next for this player, so the common case is a single tap on a grade:
    /// the server serves; the receiving team's first touch is a reception; after a reception or dig the setter
    /// sets and everyone else attacks; after the other side attacks, front-row players block and others dig.
    public static func next(side: Side, isServer: Bool, isFrontRow: Bool, role: String?,
                            serving: Side, codesThisRally: [SkillCode]) -> Skill {
        if isServer && codesThisRally.isEmpty { return .serve }
        guard let last = codesThisRally.last else { return side == serving ? .serve : .reception }
        let isSetter = role?.hasPrefix("S") ?? false
        if last.side == side {
            switch last.skill {
            case .reception, .dig, .freeball: return isSetter ? .set : .attack
            case .set: return .attack
            case .serve, .attack, .block: return .dig
            }
        }
        switch last.skill {
        case .serve: return .reception
        case .attack, .set: return isFrontRow ? .block : .dig
        case .freeball: return .freeball
        default: return .dig
        }
    }
}
