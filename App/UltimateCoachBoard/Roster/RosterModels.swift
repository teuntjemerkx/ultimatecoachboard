import Foundation
import SwiftData

/// The Phase 1 subset of the SwiftData schema of Appendix B2: teams and their players.
@Model
final class Team {
    @Attribute(.unique) var id: UUID
    var name: String
    var isOwnTeam: Bool
    @Relationship(deleteRule: .cascade, inverse: \Player.team) var players: [Player] = []
    var createdAt: Date
    var modifiedAt: Date

    init(name: String, isOwnTeam: Bool) {
        self.id = UUID()
        self.name = name
        self.isOwnTeam = isOwnTeam
        self.createdAt = .now
        self.modifiedAt = .now
    }

    var sortedPlayers: [Player] { players.sorted { $0.jersey < $1.jersey } }
}

enum PlayerRole: String, CaseIterable, Identifiable {
    case unknown, setter, outside, middle, opposite, libero, defensive

    var id: String { rawValue }

    var label: String {
        switch self {
        case .unknown: return "No role"
        case .setter: return "Setter"
        case .outside: return "Outside"
        case .middle: return "Middle"
        case .opposite: return "Opposite"
        case .libero: return "Libero"
        case .defensive: return "Defensive specialist"
        }
    }

    var short: String {
        switch self {
        case .unknown: return ""
        case .setter: return "S"
        case .outside: return "OH"
        case .middle: return "MB"
        case .opposite: return "OPP"
        case .libero: return "L"
        case .defensive: return "DS"
        }
    }

    /// Whether a template role ("OH1", "MB2", "S1", ...) fits this roster role.
    func fits(templateRole role: String) -> Bool {
        switch self {
        case .unknown, .defensive: return true
        case .setter: return role.hasPrefix("S")
        case .outside: return role.hasPrefix("OH")
        case .middle: return role.hasPrefix("MB")
        case .opposite: return role == "OPP"
        case .libero: return role == "L"
        }
    }
}

enum Handedness: String, CaseIterable, Identifiable {
    case unknown, right, left
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

@Model
final class Player {
    @Attribute(.unique) var id: UUID
    /// 0...99; the only required field (jersey-only quick add, Screen 18).
    var jersey: Int
    var displayName: String?
    var roleRaw: String
    var handednessRaw: String
    /// Biometrics in metres; nil means "use the estimate" (Appendix B2 defaults).
    var stature: Double?
    var standingReach: Double?
    var spikeReach: Double?
    var blockReach: Double?
    var team: Team?
    var modifiedAt: Date

    /// Insert the player into a context before setting `team`, so the relationship is made inside one context.
    init(jersey: Int) {
        self.id = UUID()
        self.jersey = jersey
        self.roleRaw = PlayerRole.unknown.rawValue
        self.handednessRaw = Handedness.unknown.rawValue
        self.modifiedAt = .now
    }

    var role: PlayerRole {
        get { PlayerRole(rawValue: roleRaw) ?? .unknown }
        set { roleRaw = newValue.rawValue; modifiedAt = .now }
    }

    var handedness: Handedness {
        get { Handedness(rawValue: handednessRaw) ?? .unknown }
        set { handednessRaw = newValue.rawValue; modifiedAt = .now }
    }

    /// Standing reach, estimated as 1.31 × stature when not measured (Appendix B2).
    var standingReachOrEstimate: Double? { standingReach ?? stature.map { $0 * 1.31 } }
}

/// Plausible ranges for Player Detail (Screen 19); values outside are refused inline with the reason.
enum Biometrics {
    static let stature = 1.20...2.25

    static func problem(stature: Double?, standing: Double?, spike: Double?, block: Double?) -> String? {
        if let stature, !Self.stature.contains(stature) { return "Stature runs from 1.20 to 2.25 m." }
        if let stature, let standing, standing < stature { return "Standing reach cannot be below stature." }
        if let standing, let spike, spike < standing { return "Spike reach cannot be below standing reach." }
        if let standing, let block, block < standing { return "Block reach cannot be below standing reach." }
        if let spike, spike > 4.0 { return "Spike reach above 4.00 m is not plausible." }
        if let block, block > 4.0 { return "Block reach above 4.00 m is not plausible." }
        return nil
    }
}
