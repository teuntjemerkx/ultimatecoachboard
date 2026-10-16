import Foundation

/// Ball flight (Sections 4.7 and 5.4): gravity, quadratic drag and Magnus lift, integrated with RK4 at 1 ms.
/// Constants as in Appendix D: radius 0.105 m, mass 0.27 kg, air 1.2 kg/m^3, C_D 0.25, topspin C_L 0.15.
public enum BallFlight {
    public static let radius = 0.105
    public static let mass = 0.27
    public static let airDensity = 1.2
    public static let gravity = 9.81
    /// rho A / 2m, about 0.077 per metre.
    public static var k: Double { airDensity * .pi * radius * radius / (2 * mass) }

    public struct Aero: Hashable, Codable, Sendable {
        public var drag: Double
        /// Signed lift coefficient: positive topspin (pushes down), negative backspin, 0 float.
        public var lift: Double

        public init(drag: Double = 0.25, lift: Double = 0) {
            self.drag = drag
            self.lift = lift
        }

        public static let float = Aero(drag: 0.25, lift: 0)
        public static let topspin = Aero(drag: 0.25, lift: 0.15)
        /// A set or pass carries a little backspin; a small lift keeps the model honest without a spin measurement.
        public static let soft = Aero(drag: 0.25, lift: -0.03)
    }

    /// Acceleration at velocity v. The spin axis lies horizontal and perpendicular to the flight plane, so
    /// topspin lift points down for a forward-moving ball and the flight stays in its vertical plane.
    public static func acceleration(_ v: V3, aero: Aero, axis: V3) -> V3 {
        let speed = v.length
        let drag = v * (-k * aero.drag * speed)
        let magnus = axis.cross(v) * (k * aero.lift * speed)
        return V3(0, -gravity, 0) + drag + magnus
    }

    /// The topspin axis for a horizontal heading: up x heading, so axis x v points down.
    public static func spinAxis(heading h: V3) -> V3 {
        let flat = V3(h.x, 0, h.z).normalized
        return flat.length > 0.5 ? V3.up.cross(flat) : V3(1, 0, 0)
    }

    public struct Sample: Hashable, Sendable {
        public var t: Double
        public var p: V3
        public var v: V3
    }

    /// Integrates from p0 with v0 until `stop` says so or `maxTime` passes; keeps every `keepEvery`-th step.
    public static func simulate(from p0: V3, velocity v0: V3, aero: Aero, dt: Double = 0.001, maxTime: Double = 6,
                                keepEvery: Int = 10, stop: (Sample) -> Bool) -> [Sample] {
        let axis = spinAxis(heading: v0)
        var s = Sample(t: 0, p: p0, v: v0)
        var out = [s]
        var step = 0
        while s.t < maxTime {
            let (p, v) = (s.p, s.v)
            let a1 = acceleration(v, aero: aero, axis: axis)
            let v2 = v + a1 * (dt / 2), a2 = acceleration(v2, aero: aero, axis: axis)
            let v3 = v + a2 * (dt / 2), a3 = acceleration(v3, aero: aero, axis: axis)
            let v4 = v + a3 * dt, a4 = acceleration(v4, aero: aero, axis: axis)
            let nextP = p + (v + v2 * 2 + v3 * 2 + v4) * (dt / 6)
            let nextV = v + (a1 + a2 * 2 + a3 * 2 + a4) * (dt / 6)
            s = Sample(t: s.t + dt, p: nextP, v: nextV)
            step += 1
            if stop(s) { out.append(s); break }
            if step % keepEvery == 0 { out.append(s) }
        }
        return out
    }
}

/// A solved flight between two points.
public struct Trajectory: Hashable, Sendable {
    public var samples: [BallFlight.Sample]
    public var aero: BallFlight.Aero

    public var start: V3 { samples.first!.p }
    public var end: V3 { samples.last!.p }
    public var duration: Double { samples.last!.t }
    public var launchSpeed: Double { samples.first!.v.length }
    public var apex: Double { samples.map(\.p.y).max() ?? 0 }

    /// Position at flight time t (linear between kept samples, which are 10 ms apart).
    public func position(at t: Double) -> V3 {
        guard t > 0 else { return start }
        guard t < duration else { return end }
        var i = 1
        while i < samples.count - 1 && samples[i].t < t { i += 1 }
        let a = samples[i - 1], b = samples[i]
        let f = (t - a.t) / max(b.t - a.t, 1e-9)
        return a.p + (b.p - a.p) * f
    }

    /// Where and how high the ball crosses the net plane (Z = 0), if it does.
    public func netCrossing(netHeight: Double) -> NetCrossing? {
        for i in 1..<samples.count {
            let a = samples[i - 1].p, b = samples[i].p
            guard (a.z < 0) != (b.z < 0) else { continue }
            let f = a.z / (a.z - b.z)
            let p = a + (b - a) * f
            return NetCrossing(x: p.x, height: p.y, netHeight: netHeight)
        }
        return nil
    }
}

/// Net check of Section 5.5: the ball centre must pass above the tape by its radius and between the antennas.
public struct NetCrossing: Hashable, Sendable {
    public var x: Double
    public var height: Double
    public var netHeight: Double

    public var clearance: Double { height - netHeight - BallFlight.radius }
    public var insideAntennas: Bool { abs(x) <= 4.5 - BallFlight.radius }
    public var clears: Bool { clearance > 0 && insideAntennas }
}

/// Two-point boundary value problems by shooting (Section 5.4).
public enum FlightSolver {
    /// The low, driven trajectory from `from` to `to` at launch speed `speed` (serves, attacks), or nil when the
    /// target is out of reach at that speed. The ball's centre ends at `to`.
    public static func aim(from: V3, to: V3, speed: Double, aero: BallFlight.Aero) -> Trajectory? {
        let flat = V3(to.x - from.x, 0, to.z - from.z)
        let distance = flat.length
        guard distance > 0.05 else { return nil }
        let heading = flat * (1 / distance)
        func along(_ p: V3) -> Double { V3(p.x - from.x, 0, p.z - from.z).dot(heading) }
        /// Height above the target when the flight has covered the horizontal distance (exactly, by interpolating
        /// the last step); nil when the ball comes down first.
        func shoot(_ theta: Double, dt: Double) -> (Double, [BallFlight.Sample])? {
            let v0 = (heading * cos(theta) + V3.up * sin(theta)) * speed
            let samples = BallFlight.simulate(from: from, velocity: v0, aero: aero, dt: dt, keepEvery: 1) { s in
                along(s.p) >= distance || s.p.y < to.y - 3
            }
            guard samples.count >= 2 else { return nil }
            let b = samples[samples.count - 1], a = samples[samples.count - 2]
            guard along(b.p) >= distance else { return nil }
            let f = (distance - along(a.p)) / max(along(b.p) - along(a.p), 1e-12)
            let end = BallFlight.Sample(t: a.t + (b.t - a.t) * f, p: a.p + (b.p - a.p) * f, v: a.v + (b.v - a.v) * f)
            return (end.p.y - to.y, Array(samples.dropLast()) + [end])
        }
        func height(_ theta: Double, dt: Double = 0.004) -> Double { shoot(theta, dt: dt)?.0 ?? -1e3 }
        // Scan upward from a steep downward angle for the first rise through the target (the low solution).
        var a = -1.2, fa = height(a)
        var bracket: (Double, Double)?
        var theta = a
        while theta < 1.3 {
            theta += 0.04
            let f = height(theta)
            if fa < 0 && f >= 0 { bracket = (a, theta); break }
            a = theta
            fa = f
        }
        guard var (lo, hi) = bracket else { return nil }
        for _ in 0..<36 {
            let m = (lo + hi) / 2
            if height(m, dt: 0.001) < 0 { lo = m } else { hi = m }
        }
        guard let (_, samples) = shoot((lo + hi) / 2, dt: 0.001) else { return nil }
        return Trajectory(samples: thin(samples, to: to), aero: aero)
    }

    /// The trajectory from `from` to `to` whose highest point is at height `apex` (passes, sets, free balls),
    /// solved by Newton's method on the launch velocity starting from the drag-free answer.
    public static func lob(from: V3, to: V3, apex: Double, aero: BallFlight.Aero) -> Trajectory? {
        let flat = V3(to.x - from.x, 0, to.z - from.z)
        let distance = flat.length
        let heading = distance > 1e-6 ? flat * (1 / distance) : V3(0, 0, 1)
        let apex = max(apex, max(from.y, to.y) + 0.05)
        let g = BallFlight.gravity
        // Drag-free start: rise to the apex, fall to the target height.
        let vy0 = (2 * g * (apex - from.y)).squareRoot()
        let tFlight = vy0 / g + (2 * (apex - to.y) / g).squareRoot()
        var x = (distance / tFlight, vy0)
        func run(_ vh: Double, _ vy: Double) -> (residual: (Double, Double), samples: [BallFlight.Sample])? {
            let v0 = heading * vh + V3.up * vy
            let samples = BallFlight.simulate(from: from, velocity: v0, aero: aero, keepEvery: 1) { s in
                s.v.y < 0 && s.p.y <= to.y
            }
            guard samples.count >= 2, let b = samples.last, b.v.y < 0, b.p.y <= to.y else { return nil }
            let a = samples[samples.count - 2]
            let f = (a.p.y - to.y) / max(a.p.y - b.p.y, 1e-12)
            let end = BallFlight.Sample(t: a.t + (b.t - a.t) * f, p: a.p + (b.p - a.p) * f, v: a.v + (b.v - a.v) * f)
            // At 1 ms steps the highest sample is within micrometres of the true apex (the vertical speed is ~0 there).
            let top = samples.map(\.p.y).max() ?? from.y
            let covered = V3(end.p.x - from.x, 0, end.p.z - from.z).dot(heading)
            return ((covered - distance, top - apex), Array(samples.dropLast()) + [end])
        }
        for _ in 0..<30 {
            guard let r = run(x.0, x.1) else { return nil }
            if abs(r.residual.0) < 0.01 && abs(r.residual.1) < 0.01 { return Trajectory(samples: thin(r.samples, to: to), aero: aero) }
            let h = 1e-3
            guard let rx = run(x.0 + h, x.1), let ry = run(x.0, x.1 + h) else { return nil }
            let j00 = (rx.residual.0 - r.residual.0) / h, j01 = (ry.residual.0 - r.residual.0) / h
            let j10 = (rx.residual.1 - r.residual.1) / h, j11 = (ry.residual.1 - r.residual.1) / h
            let det = j00 * j11 - j01 * j10
            guard abs(det) > 1e-12 else { return nil }
            let dx = (j11 * r.residual.0 - j01 * r.residual.1) / det
            let dy = (-j10 * r.residual.0 + j00 * r.residual.1) / det
            x = (max(0, x.0 - dx), x.1 - dy)
        }
        return nil
    }

    /// Keeps every 10th step (10 ms) plus the exact end, placed on the target so chained flights connect.
    private static func thin(_ samples: [BallFlight.Sample], to target: V3) -> [BallFlight.Sample] {
        var out = samples.enumerated().filter { $0.offset % 10 == 0 }.map(\.element)
        var last = samples[samples.count - 1]
        last.p = target
        if out.last?.t == last.t { out.removeLast() }
        out.append(last)
        return out
    }
}
