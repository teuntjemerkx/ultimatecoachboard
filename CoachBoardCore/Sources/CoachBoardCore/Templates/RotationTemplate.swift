import Foundation

/// A rotation template file (Appendix B5, format "cb.rotation-template/1").
public struct RotationTemplate: Codable, Hashable, Sendable, Identifiable {
    public struct Libero: Codable, Hashable, Sendable {
        public var replaces: [String]
        public var whenServing: Bool
    }

    public struct Player: Codable, Hashable, Sendable {
        public var role: String
        public var position: Int
        public var anchor: [Double]
        public var passes: Bool
        public var route: String?
        public var switchTo: [Double]?

        public var courtPosition: CourtPosition? { CourtPosition(rawValue: position) }
        public var point: LocalPoint { LocalPoint(anchor) }
    }

    public struct Formation: Codable, Hashable, Sendable {
        public var rotation: Int
        public var phase: String
        public var players: [Player]
        public var expectedMinMargin: Double?
        public var frontSetterPosition: Int?
        public var note: String?

        public var isServing: Bool { phase == "serve" }

        public var positions: [CourtPosition: LocalPoint] {
            var out: [CourtPosition: LocalPoint] = [:]
            for p in players { if let cp = p.courtPosition { out[cp] = p.point } }
            return out
        }
    }

    public var format: String
    public var id: String
    public var system: String
    public var lineupOrder: [String]
    public var libero: Libero?
    public var setterTarget: [Double]
    public var routeTargets: [String: [Double]]
    public var baseSlots: [String: [Double]]?
    public var formations: [Formation]
    public var note: String?

    public static let supportedFormat = "cb.rotation-template/1"

    public func formation(rotation: Int, phase: String) -> Formation? {
        formations.first { $0.rotation == rotation && $0.phase == phase }
    }
}

public enum TemplateError: Error, Equatable {
    case resourceMissing(String)
    case unsupportedFormat(String)
    case invalid(String)
}

public struct FormationValidation: Hashable, Sendable {
    public var rotation: Int
    public var phase: String
    public var minMargin: Double
    public var isLegal: Bool
    /// True when the file's `expectedMinMargin` matches the engine to the centimetre (or none is given).
    public var matchesExpectation: Bool
    public var failing: [ConstraintResult]
}

public enum TemplateLibrary {
    public static let shippedIDs = ["5-1-outside-follows-setter", "4-2", "youth-w"]

    public static func decode(_ data: Data) throws -> RotationTemplate {
        let t = try JSONDecoder().decode(RotationTemplate.self, from: data)
        guard t.format == RotationTemplate.supportedFormat else { throw TemplateError.unsupportedFormat(t.format) }
        for f in t.formations {
            let positions = Set(f.players.compactMap(\.courtPosition))
            guard positions.count == f.players.count else {
                throw TemplateError.invalid("formation R\(f.rotation) \(f.phase): duplicate or invalid positions")
            }
            guard f.players.allSatisfy({ $0.anchor.count == 2 }) else {
                throw TemplateError.invalid("formation R\(f.rotation) \(f.phase): anchors need two coordinates")
            }
        }
        return t
    }

    public static func shipped(_ id: String) throws -> RotationTemplate {
        guard let url = Bundle.module.url(forResource: id, withExtension: "json", subdirectory: "Resources/Templates") else {
            throw TemplateError.resourceMissing("\(id).json")
        }
        return try decode(Data(contentsOf: url))
    }

    public static func allShipped() throws -> [RotationTemplate] {
        try shippedIDs.map(shipped)
    }

    /// Validates every formation of a template against a profile (blueprint Section 2.6: load-time validation).
    public static func validate(_ template: RotationTemplate, profile: RuleCourtProfile) -> [FormationValidation] {
        let options = OverlapEngine.Options(profile: profile)
        return template.formations.map { f in
            let results = OverlapEngine.evaluate(f.positions, serving: f.isServing,
                                                 serverExempt: profile.overlap.serverExempt, options: options)
            let minMargin = results.map(\.margin).min() ?? .infinity
            let matches: Bool
            if let expected = f.expectedMinMargin {
                matches = abs(expected - minMargin) < 0.005
            } else {
                matches = true
            }
            return FormationValidation(rotation: f.rotation, phase: f.phase, minMargin: minMargin,
                                       isLegal: results.allSatisfy(\.isLegal), matchesExpectation: matches,
                                       failing: results.filter { !$0.isLegal })
        }
    }

    /// 6-2: the three rotations with a back-row setter reuse the verified 5-1 formations R1, R6 and R5
    /// with the off-setter in the opposite's place (Appendix A4).
    public static func sixTwoFormation(backRowSetterAt position: CourtPosition,
                                       from fiveOne: RotationTemplate) -> RotationTemplate.Formation? {
        let rotation: Int
        switch position {
        case .p1: rotation = 1
        case .p6: rotation = 6
        case .p5: rotation = 5
        default: return nil
        }
        guard var f = fiveOne.formation(rotation: rotation, phase: "receive") else { return nil }
        for i in f.players.indices where f.players[i].role == "OPP" { f.players[i].role = "S2" }
        for i in f.players.indices where f.players[i].role == "S" { f.players[i].role = "S1" }
        f.note = "6-2 formation derived from 5-1 R\(rotation)"
        return f
    }
}
