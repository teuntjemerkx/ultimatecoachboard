import Foundation

/// How a contact sends the ball on, with the defaults of Section 5.4.
public enum ContactKind: String, Codable, CaseIterable, Sendable, Hashable {
    case floatServe, jumpServe, pass, quickSet, secondTempoSet, highSet, attack, freeball, dig

    public var title: String {
        switch self {
        case .floatServe: return "FLOAT"
        case .jumpServe: return "JUMP SERVE"
        case .pass: return "PASS"
        case .quickSet: return "QUICK"
        case .secondTempoSet: return "2ND TEMPO"
        case .highSet: return "HIGH SET"
        case .attack: return "ATTACK"
        case .freeball: return "FREE BALL"
        case .dig: return "DIG"
        }
    }

    /// Driven contacts have a launch speed; lobbed ones an apex above the tape.
    public enum Launch: Hashable, Sendable {
        case speed(Double, BallFlight.Aero)
        case apexAboveTape(Double, BallFlight.Aero)
    }

    /// Float serve 14 to 18 m/s, jump serve 18 to 28, pass apex 1.5 to 3 m over the tape, sets by tempo,
    /// attacks at 25 m/s with topspin (a men's hitter profile), free balls and digs as soft lobs.
    public var launch: Launch {
        switch self {
        case .floatServe: return .speed(16, .float)
        case .jumpServe: return .speed(22, .topspin)
        case .pass: return .apexAboveTape(2.0, .soft)
        case .quickSet: return .apexAboveTape(0.5, .soft)
        case .secondTempoSet: return .apexAboveTape(1.5, .soft)
        case .highSet: return .apexAboveTape(3.5, .soft)
        case .attack: return .speed(25, .topspin)
        case .freeball: return .apexAboveTape(1.5, .soft)
        case .dig: return .apexAboveTape(1.2, .soft)
        }
    }

    /// The kinds that make sense at a marker, the first being the default.
    public static func choices(at phase: RallyPhase) -> [ContactKind] {
        switch phase {
        case .serve: return [.floatServe, .jumpServe]
        case .receive: return [.pass, .dig]
        case .set: return [.highSet, .secondTempoSet, .quickSet]
        case .attack: return [.attack, .freeball]
        case .cover, .defence: return [.dig, .freeball, .attack]
        }
    }

    /// Where the ball is met relative to the player standing at `p` facing `facing`.
    public func contactPoint(at p: FloorPoint, facing: Double, metrics: BodyMetrics) -> V3 {
        let fwd = V3(sin(facing), 0, cos(facing))
        let base = V3(p)
        switch self {
        case .floatServe: return base + fwd * 0.3 + V3(0, metrics.standingReach, 0)
        case .jumpServe: return base + fwd * 0.5 + V3(0, metrics.standingReach + 0.5, 0)
        case .attack: return base + fwd * 0.3 + V3(0, metrics.standingReach + 0.6, 0)
        case .quickSet, .secondTempoSet, .highSet: return base + fwd * 0.15 + V3(0, metrics.stature + 0.15, 0)
        case .pass: return base + fwd * 0.45 + V3(0, 0.75, 0)
        case .dig: return base + fwd * 0.45 + V3(0, 0.45, 0)
        case .freeball: return base + fwd * 0.4 + V3(0, 1.0, 0)
        }
    }
}

/// A ball contact placed by the coach (Section 3.3): who plays the ball, at which marker, and how.
public struct BallContact: Codable, Hashable, Sendable {
    public var phase: RallyPhase
    public var player: UUID
    public var kind: ContactKind

    public init(phase: RallyPhase, player: UUID, kind: ContactKind) {
        self.phase = phase
        self.player = player
        self.kind = kind
    }
}

/// The ball through a scene's timeline: one solved flight between consecutive contacts.
public struct BallPlan: Sendable {
    public struct Segment: Sendable {
        public var contact: BallContact
        public var playerLabel: String
        /// Timeline span (phase-index units) the flight occupies.
        public var startTime: Double
        public var endTime: Double
        public var from: V3
        public var to: V3
        public var trajectory: Trajectory?

        /// "HIGH SET · apex 5.9 m · 1.48 s" or "ATTACK 25 m/s · 0.31 m over the tape · 1.02 s".
        public func summary(netHeight: Double) -> String {
            guard let t = trajectory else { return "\(contact.kind.title) \u{00B7} out of reach" }
            var parts = ["\(playerLabel) \(contact.kind.title)"]
            if case .speed(let v, _) = contact.kind.launch { parts.append("\(Int(v.rounded())) m/s") }
            if let n = t.netCrossing(netHeight: netHeight) {
                if !n.insideAntennas { parts.append("outside the antenna") } else {
                    parts.append(n.clearance >= 0 ? String(format: "%.2f m over the tape", n.clearance) : "into the net")
                }
            } else {
                parts.append(String(format: "apex %.1f m", t.apex))
            }
            parts.append(String(format: "%.2f s", t.duration))
            return parts.joined(separator: " \u{00B7} ")
        }
    }

    public var segments: [Segment]

    /// The ball at a timeline position: in the hands at a contact, in flight between contacts. The flight runs at
    /// physical pace across its timeline span. Nil without contacts or before the first contact's marker.
    public func position(at time: Double) -> V3? {
        guard let first = segments.first, time >= first.startTime - 1e-9 else { return nil }
        for s in segments where time <= s.endTime + 1e-9 {
            guard let t = s.trajectory, s.endTime > s.startTime else { return s.from }
            let u = max(0, min(1, (time - s.startTime) / (s.endTime - s.startTime)))
            return t.position(at: u * t.duration)
        }
        return segments.last.map { $0.trajectory?.end ?? $0.to }
    }

    /// The segment in flight (or about to start) at a timeline position.
    public func segment(at time: Double) -> Segment? {
        segments.first { time >= $0.startTime - 1e-9 && time < $0.endTime } ?? segments.last { time >= $0.startTime - 1e-9 }
    }
}

extension TacticalScene {
    /// The default landing for the last flight: deep in the middle of the half across the net from the hitter.
    public func defaultLanding(for side: Side) -> FloorPoint { FloorPoint(x: 0, z: side == .home ? -6 : 6) }

    /// Solves the flights between the contacts in timeline order (Section 5.4). Expensive (RK4 shooting), so
    /// callers cache it per scene value.
    public func ballPlan(netHeight: Double = 2.43) -> BallPlan {
        let line = timeline
        let contacts = (contacts ?? []).compactMap { c in line.firstIndex(of: c.phase).map { (c, $0) } }.sorted { $0.1 < $1.1 }
        guard !contacts.isEmpty else { return BallPlan(segments: []) }
        var points: [V3] = []
        var labels: [String] = []
        var sides: [Side] = []
        for (c, i) in contacts {
            let f = frame(at: Double(i))
            guard let t = f.tokens.first(where: { $0.id == c.player }) else { return BallPlan(segments: []) }
            points.append(c.kind.contactPoint(at: t.point, facing: t.facing, metrics: BodyMetrics(stature: t.effectiveStature)))
            labels.append(t.side == .home ? "#\(t.label)" : t.label)
            sides.append(t.side)
        }
        var segments: [BallPlan.Segment] = []
        for (k, (c, i)) in contacts.enumerated() {
            let last = k == contacts.count - 1
            let to: V3
            let endTime: Double
            if last {
                let landing = ballLanding ?? defaultLanding(for: sides[k])
                to = V3(landing, y: ballLanding == nil ? BallFlight.radius : max(BallFlight.radius, ballLandingHeight ?? 0))
                endTime = min(Double(i + 1), Double(max(line.count - 1, i)))
            } else {
                to = points[k + 1]
                endTime = Double(contacts[k + 1].1)
            }
            let from = points[k]
            let trajectory: Trajectory?
            switch c.kind.launch {
            case let .speed(v, aero):
                trajectory = FlightSolver.aim(from: from, to: to, speed: v, aero: aero)
                    ?? FlightSolver.lob(from: from, to: to, apex: max(from.y, netHeight + 1) + 0.5, aero: aero)
            case let .apexAboveTape(h, aero):
                trajectory = FlightSolver.lob(from: from, to: to, apex: netHeight + h, aero: aero)
            }
            segments.append(BallPlan.Segment(contact: c, playerLabel: labels[k], startTime: Double(i), endTime: endTime,
                                              from: from, to: to, trajectory: trajectory))
        }
        return BallPlan(segments: segments)
    }
}
