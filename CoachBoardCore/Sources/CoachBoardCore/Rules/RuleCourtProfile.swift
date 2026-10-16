import Foundation

/// A Rule & Court Profile (blueprint Section 2.7, Appendix B5). Profiles are data:
/// federation and youth formats are new JSON files, never new code.
public struct RuleCourtProfile: Codable, Hashable, Sendable {
    public struct Court: Codable, Hashable, Sendable {
        public var length: Double
        public var width: Double
        public var attackLine: Double
        public var lineWidth: Double
        public var freeZoneMin: Double
    }

    public struct Net: Codable, Hashable, Sendable {
        public var heightPresets: [String: Double]
        public var height: Double
        public var antennaAboveTape: Double
        public var tapeWidth: Double
    }

    public struct Rotation: Codable, Hashable, Sendable {
        public var enabled: Bool
    }

    public struct Footprint: Codable, Hashable, Sendable {
        public var footLength: Double
        public var footWidth: Double
        public var stanceWidth: Double
    }

    public struct Overlap: Codable, Hashable, Sendable {
        public var checkServingTeam: Bool
        public var checkReceivingTeam: Bool
        public var requireInsideCourt: Bool
        public var serverExempt: Bool
        public var footprint: Footprint
    }

    public struct Libero: Codable, Hashable, Sendable {
        public var allowed: Bool
        public var maxPerTeam: Int
        public var mayServe: Bool
    }

    public struct Substitutions: Codable, Hashable, Sendable {
        public var maxPerSet: Int
    }

    public struct Scoring: Codable, Hashable, Sendable {
        public var pointsPerSet: Int
        public var decidingSetPoints: Int
        public var winBy: Int
        public var setsToWin: Int

        /// Number of the deciding set, e.g. 5 when three sets win the match.
        public var decidingSetNumber: Int { setsToWin * 2 - 1 }

        public func targetPoints(forSet number: Int) -> Int {
            number == decidingSetNumber ? decidingSetPoints : pointsPerSet
        }
    }

    public struct TimeOuts: Codable, Hashable, Sendable {
        public var perSet: Int
        public var seconds: Int
    }

    public var format: String
    public var name: String
    public var source: String?
    public var court: Court
    public var net: Net
    public var playersPerSide: Int
    public var rotation: Rotation
    public var overlap: Overlap
    public var libero: Libero
    public var substitutions: Substitutions
    public var scoring: Scoring
    public var timeOuts: TimeOuts
}

public enum ProfileError: Error, Equatable {
    case resourceMissing(String)
    case unsupportedFormat(String)
}

extension RuleCourtProfile {
    public static let supportedFormat = "cb.rule-court-profile/1"

    public static func decode(_ data: Data) throws -> RuleCourtProfile {
        let profile = try JSONDecoder().decode(RuleCourtProfile.self, from: data)
        guard profile.format == supportedFormat else { throw ProfileError.unsupportedFormat(profile.format) }
        return profile
    }

    /// The shipped senior indoor profile bundled with the package.
    public static func fivbSenior() throws -> RuleCourtProfile {
        guard let url = Bundle.module.url(forResource: "fivb-senior", withExtension: "json", subdirectory: "Resources/Profiles") else {
            throw ProfileError.resourceMissing("fivb-senior.json")
        }
        return try decode(Data(contentsOf: url))
    }
}
