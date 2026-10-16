import Foundation

/// The two teams on the court.
public enum Side: String, Codable, Sendable, CaseIterable, Hashable {
    case home
    case opponent

    public var other: Side { self == .home ? .opponent : .home }
}

/// A point in a team's own frame (blueprint Section 0.4):
/// `l` is measured from that team's left sideline while facing the net,
/// `d` from the centre line, both in metres.
public struct LocalPoint: Codable, Hashable, Sendable {
    public var l: Double
    public var d: Double

    public init(l: Double, d: Double) {
        self.l = l
        self.d = d
    }

    public init(_ pair: [Double]) {
        precondition(pair.count == 2, "a LocalPoint needs exactly two coordinates")
        self.l = pair[0]
        self.d = pair[1]
    }

    public static func + (a: LocalPoint, b: LocalPoint) -> LocalPoint { LocalPoint(l: a.l + b.l, d: a.d + b.d) }
    public static func - (a: LocalPoint, b: LocalPoint) -> LocalPoint { LocalPoint(l: a.l - b.l, d: a.d - b.d) }

    public func distance(to other: LocalPoint) -> Double {
        let dl = other.l - l
        let dd = other.d - d
        return (dl * dl + dd * dd).squareRoot()
    }
}

/// A point on the floor in the world frame (blueprint Section 0.3):
/// X along the net (+X is the home team's right), Z perpendicular to the net
/// (home half Z > 0, opponent half Z < 0), metres.
public struct FloorPoint: Codable, Hashable, Sendable {
    public var x: Double
    public var z: Double

    public init(x: Double, z: Double) {
        self.x = x
        self.z = z
    }
}

/// Conversions between the world frame and the team-local frames.
public enum CourtFrame {
    public static let halfWidth = 4.5

    public static func local(_ p: FloorPoint, for side: Side) -> LocalPoint {
        switch side {
        case .home: return LocalPoint(l: p.x + halfWidth, d: p.z)
        case .opponent: return LocalPoint(l: halfWidth - p.x, d: -p.z)
        }
    }

    public static func world(_ p: LocalPoint, of side: Side) -> FloorPoint {
        switch side {
        case .home: return FloorPoint(x: p.l - halfWidth, z: p.d)
        case .opponent: return FloorPoint(x: halfWidth - p.l, z: -p.d)
        }
    }

    /// Which half of the court a world point lies on (the net plane belongs to neither; it is reported as home).
    public static func side(of p: FloorPoint) -> Side { p.z >= 0 ? .home : .opponent }
}

/// Rotational positions, numbered as in the rules: P1 right back (server) ... P6 middle back.
public enum CourtPosition: Int, Codable, Sendable, CaseIterable, Hashable, Comparable {
    case p1 = 1, p2, p3, p4, p5, p6

    public var isFrontRow: Bool { self == .p2 || self == .p3 || self == .p4 }
    public var isBackRow: Bool { !isFrontRow }

    public var label: String { "P\(rawValue)" }

    public static func < (a: CourtPosition, b: CourtPosition) -> Bool { a.rawValue < b.rawValue }

    /// Clockwise rotation on a side-out: P2 -> P1, P1 -> P6, P6 -> P5, P5 -> P4, P4 -> P3, P3 -> P2.
    public var afterRotation: CourtPosition {
        switch self {
        case .p1: return .p6
        case .p2: return .p1
        case .p3: return .p2
        case .p4: return .p3
        case .p5: return .p4
        case .p6: return .p5
        }
    }
}
