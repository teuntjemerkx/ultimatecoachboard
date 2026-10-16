import Foundation

/// How a player stands, in the team-local frame. Yaw 0 means facing the net (forward = -d).
public struct Stance: Codable, Hashable, Sendable {
    public var yaw: Double
    public var width: Double
    public var stagger: Double

    public init(yaw: Double = 0, width: Double = 0.30, stagger: Double = 0) {
        self.yaw = yaw
        self.width = width
        self.stagger = stagger
    }

    public static let ready = Stance()
}

/// The extreme points of a player's two feet (blueprint Section 3.4.1).
public struct FootExtremes: Hashable, Sendable {
    /// Distance of the foremost part of any foot to the centre line.
    public var d: Double
    /// Distance of the outermost part of any foot to the team's left sideline.
    public var left: Double
    /// Distance of the outermost part of any foot to the team's right sideline.
    public var right: Double
    /// Deepest part of any foot (used for the inside-court and envelope checks).
    public var maxD: Double
    public var witnessD: LocalPoint
    public var witnessLeft: LocalPoint
    public var witnessRight: LocalPoint
}

public enum Footprint {
    /// The eight vertices of the two feet, each a `footLength` x `footWidth` rectangle.
    /// Mirrors the executable reference used to verify the engine (Appendix D2).
    public static func vertices(center c: LocalPoint, stance s: Stance,
                                footLength: Double = 0.28, footWidth: Double = 0.10) -> [LocalPoint] {
        let fwd = (l: sin(s.yaw), d: -cos(s.yaw))
        let rgt = (l: cos(s.yaw), d: sin(s.yaw))
        var out: [LocalPoint] = []
        out.reserveCapacity(8)
        for (side, stag) in [(-1.0, s.stagger / 2), (1.0, -s.stagger / 2)] {
            let fl = c.l + rgt.l * side * s.width / 2 + fwd.l * stag
            let fd = c.d + rgt.d * side * s.width / 2 + fwd.d * stag
            for a in [-1.0, 1.0] {
                for b in [-1.0, 1.0] {
                    out.append(LocalPoint(l: fl + fwd.l * a * footLength / 2 + rgt.l * b * footWidth / 2,
                                          d: fd + fwd.d * a * footLength / 2 + rgt.d * b * footWidth / 2))
                }
            }
        }
        return out
    }

    public static func extremes(center: LocalPoint, stance: Stance,
                                footLength: Double = 0.28, footWidth: Double = 0.10,
                                courtWidth: Double = 9.0) -> FootExtremes {
        let v = vertices(center: center, stance: stance, footLength: footLength, footWidth: footWidth)
        var e = FootExtremes(d: .infinity, left: .infinity, right: .infinity, maxD: -.infinity,
                             witnessD: center, witnessLeft: center, witnessRight: center)
        for p in v {
            if p.d < e.d { e.d = p.d; e.witnessD = p }
            if p.l < e.left { e.left = p.l; e.witnessLeft = p }
            let r = courtWidth - p.l
            if r < e.right { e.right = r; e.witnessRight = p }
            e.maxD = max(e.maxD, p.d)
        }
        return e
    }
}

public enum ConstraintKind: String, Codable, Sendable, Hashable {
    /// The front-row player must be nearer the centre line than the back-row player behind.
    case frontBack
    /// The left player must be nearer the left sideline than the centre player of the row.
    case leftCentre
    /// The right player must be nearer the right sideline than the centre player of the row.
    case rightCentre
}

public struct ConstraintResult: Hashable, Sendable {
    public var a: CourtPosition
    public var b: CourtPosition
    public var kind: ConstraintKind
    /// Positive margin = legal, in metres (blueprint Section 3.4.2).
    public var margin: Double
    public var witnessA: LocalPoint
    public var witnessB: LocalPoint

    public var isLegal: Bool { margin > 0 }
}

public enum OverlapEngine {
    /// The seven constraint pairs; `a` is the player who must be nearer the reference line.
    public static let pairs: [(CourtPosition, CourtPosition, ConstraintKind)] = [
        (.p4, .p5, .frontBack), (.p3, .p6, .frontBack), (.p2, .p1, .frontBack),
        (.p4, .p3, .leftCentre), (.p5, .p6, .leftCentre),
        (.p2, .p3, .rightCentre), (.p1, .p6, .rightCentre),
    ]

    public struct Options: Hashable, Sendable {
        public var footLength: Double
        public var footWidth: Double
        public var courtWidth: Double

        public init(footLength: Double = 0.28, footWidth: Double = 0.10, courtWidth: Double = 9.0) {
            self.footLength = footLength
            self.footWidth = footWidth
            self.courtWidth = courtWidth
        }

        public init(profile: RuleCourtProfile) {
            self.init(footLength: profile.overlap.footprint.footLength,
                      footWidth: profile.overlap.footprint.footWidth,
                      courtWidth: profile.court.width)
        }
    }

    public static func extremes(_ positions: [CourtPosition: LocalPoint],
                                stances: [CourtPosition: Stance],
                                options: Options) -> [CourtPosition: FootExtremes] {
        var out: [CourtPosition: FootExtremes] = [:]
        for (p, c) in positions {
            out[p] = Footprint.extremes(center: c, stance: stances[p] ?? .ready,
                                        footLength: options.footLength, footWidth: options.footWidth,
                                        courtWidth: options.courtWidth)
        }
        return out
    }

    /// Evaluates every applicable constraint. When `serving` is true and the server is exempt,
    /// every pair containing P1 is dropped (blueprint Section 3.4.3).
    public static func evaluate(_ positions: [CourtPosition: LocalPoint],
                                stances: [CourtPosition: Stance] = [:],
                                serving: Bool,
                                serverExempt: Bool = true,
                                options: Options = Options()) -> [ConstraintResult] {
        let ex = extremes(positions, stances: stances, options: options)
        var results: [ConstraintResult] = []
        for (a, b, kind) in pairs {
            if serving && serverExempt && (a == .p1 || b == .p1) { continue }
            guard let ea = ex[a], let eb = ex[b] else { continue }
            switch kind {
            case .frontBack:
                results.append(ConstraintResult(a: a, b: b, kind: kind, margin: eb.d - ea.d,
                                                witnessA: ea.witnessD, witnessB: eb.witnessD))
            case .leftCentre:
                results.append(ConstraintResult(a: a, b: b, kind: kind, margin: eb.left - ea.left,
                                                witnessA: ea.witnessLeft, witnessB: eb.witnessLeft))
            case .rightCentre:
                results.append(ConstraintResult(a: a, b: b, kind: kind, margin: eb.right - ea.right,
                                                witnessA: ea.witnessRight, witnessB: eb.witnessRight))
            }
        }
        return results
    }

    /// Whether a whole formation is legal under a profile, including the inside-court rule.
    public static func isLegal(_ positions: [CourtPosition: LocalPoint],
                               stances: [CourtPosition: Stance] = [:],
                               serving: Bool,
                               profile: RuleCourtProfile) -> Bool {
        let checked = serving ? profile.overlap.checkServingTeam : profile.overlap.checkReceivingTeam
        guard checked else { return true }
        let options = Options(profile: profile)
        if !evaluate(positions, stances: stances, serving: serving,
                     serverExempt: profile.overlap.serverExempt, options: options).allSatisfy(\.isLegal) {
            return false
        }
        if profile.overlap.requireInsideCourt {
            for (p, c) in positions {
                if serving && profile.overlap.serverExempt && p == .p1 { continue }
                let verts = Footprint.vertices(center: c, stance: stances[p] ?? .ready,
                                               footLength: options.footLength, footWidth: options.footWidth)
                if verts.contains(where: { $0.l < 0 || $0.l > profile.court.width || $0.d < 0 || $0.d > profile.court.length / 2 }) {
                    return false
                }
            }
        }
        return true
    }

    /// Server position at contact (or take-off): behind the end line, between the sideline extensions.
    public static func serverPositionIsLegal(center: LocalPoint, stance: Stance = .ready,
                                             profile: RuleCourtProfile) -> Bool {
        let half = profile.court.length / 2
        let verts = Footprint.vertices(center: center, stance: stance,
                                       footLength: profile.overlap.footprint.footLength,
                                       footWidth: profile.overlap.footprint.footWidth)
        return verts.allSatisfy { $0.d > half && $0.l >= 0 && $0.l <= profile.court.width }
    }

    /// The smallest margin of a formation (positive = legal with that much to spare).
    public static func minimumMargin(_ positions: [CourtPosition: LocalPoint],
                                     stances: [CourtPosition: Stance] = [:],
                                     serving: Bool,
                                     options: Options = Options()) -> Double {
        evaluate(positions, stances: stances, serving: serving, options: options).map(\.margin).min() ?? .infinity
    }
}
