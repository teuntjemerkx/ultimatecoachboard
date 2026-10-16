import Foundation

/// The route timing model of Appendix A1. All values are per-team settings.
public struct TimingModel: Codable, Hashable, Sendable {
    public var serveToPass: Double = 1.2
    public var passToSet: Double = 1.1
    public var nonPasserStart: Double = 0.25
    public var passerRecovery: Double = 0.2
    public var setterSpeed: Double = 4.5
    public var hitterSpeed: Double = 5.0
    public var setterArriveBeforeSet: Double = 0.3
    public var pinSetFlight: Double = 0.8
    public var backRowSetFlight: Double = 0.7
    public var approachDuration: Double = 0.75
    public var quickLead: Double = 0.45

    public init() {}

    public var setTime: Double { serveToPass + passToSet }

    public func deadline(for route: String) -> Double? {
        switch route {
        case "target": return setTime - setterArriveBeforeSet
        case "left", "right": return setTime + pinSetFlight - approachDuration
        case "quick": return setTime - quickLead
        case "pipe", "dball": return setTime + backRowSetFlight - approachDuration
        default: return nil
        }
    }
}

public struct RouteCheck: Hashable, Sendable {
    public var role: String
    public var position: Int
    public var route: String
    public var length: Double
    public var arrival: Double
    public var deadline: Double

    /// Deadline minus arrival; negative means the app shows a LATE chip.
    public var slack: Double { deadline - arrival }
    public var isLate: Bool { slack < 0 }
}

public enum RouteTiming {
    public static func check(_ formation: RotationTemplate.Formation,
                             targets: [String: [Double]],
                             model: TimingModel = TimingModel()) -> [RouteCheck] {
        formation.players.compactMap { p in
            guard let route = p.route, let dest = targets[route], dest.count == 2,
                  let deadline = model.deadline(for: route) else { return nil }
            let length = p.point.distance(to: LocalPoint(dest))
            let speed = route == "target" ? model.setterSpeed : model.hitterSpeed
            let start = p.passes ? model.serveToPass + model.passerRecovery : model.nonPasserStart
            return RouteCheck(role: p.role, position: p.position, route: route, length: length,
                              arrival: start + length / speed, deadline: deadline)
        }
    }
}
