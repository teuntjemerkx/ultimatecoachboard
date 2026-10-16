import Foundation

/// The ball's pixel in one frame.
public struct BallObservation: Hashable, Codable, Sendable {
    public var time: Double
    public var image: ImagePoint

    public init(time: Double, image: ImagePoint) {
        self.time = time
        self.image = image
    }
}

/// One free flight of the ball between contacts, reconstructed in 3D.
public struct BallSegment: Hashable, Codable, Sendable {
    /// Start and end of the flight (contact times, or the first and last observation), seconds.
    public var t0: Double
    public var t1: Double
    /// Position and velocity at t0.
    public var p0: V3
    public var v0: V3
    /// Drag and lift; `BallSegment.vacuum` (both 0) is the drag-free parabola.
    public var aero: BallFlight.Aero
    /// Reprojection error of the fit, pixels RMS.
    public var rmsError: Double

    public static let vacuum = BallFlight.Aero(drag: 0, lift: 0)

    public init(t0: Double, t1: Double, p0: V3, v0: V3, aero: BallFlight.Aero = BallSegment.vacuum, rmsError: Double = 0) {
        self.t0 = t0
        self.t1 = t1
        self.p0 = p0
        self.v0 = v0
        self.aero = aero
        self.rmsError = rmsError
    }

    public var isBallistic: Bool { aero.drag == 0 && aero.lift == 0 }

    /// Ball centre at time t (extrapolated outside t0...t1), never below the floor.
    public func position(at t: Double) -> V3 {
        var p = Self.positions(p0: p0, v0: v0, aero: aero, times: [t - t0])[0]
        p.y = max(p.y, BallFlight.radius)
        return p
    }

    /// Positions at flight times (relative to the start, in any order and sign) by the closed form when drag-free,
    /// else RK4 on the core's BallFlight model with steps of at most `dt`, ending exactly on every time.
    static func positions(p0: V3, v0: V3, aero: BallFlight.Aero, times: [Double], dt: Double = 0.004) -> [V3] {
        if aero.drag == 0 && aero.lift == 0 {
            return times.map { p0 + v0 * $0 + V3(0, -0.5 * BallFlight.gravity * $0 * $0, 0) }
        }
        let axis = BallFlight.spinAxis(heading: v0)
        func step(_ p: V3, _ v: V3, _ h: Double) -> (V3, V3) {
            let a1 = BallFlight.acceleration(v, aero: aero, axis: axis)
            let v2 = v + a1 * (h / 2), a2 = BallFlight.acceleration(v2, aero: aero, axis: axis)
            let v3 = v + a2 * (h / 2), a3 = BallFlight.acceleration(v3, aero: aero, axis: axis)
            let v4 = v + a3 * h, a4 = BallFlight.acceleration(v4, aero: aero, axis: axis)
            return (p + (v + v2 * 2 + v3 * 2 + v4) * (h / 6), v + (a1 + a2 * 2 + a3 * 2 + a4) * (h / 6))
        }
        var out = [V3](repeating: p0, count: times.count)
        for direction in [1.0, -1.0] {
            let order = times.indices.filter { times[$0] * direction > 0 }.sorted { abs(times[$0]) < abs(times[$1]) }
            var p = p0, v = v0, tau = 0.0
            for i in order {
                let target = abs(times[i])
                while tau + dt <= target { (p, v) = step(p, v, dt * direction); tau += dt }
                let h = target - tau
                out[i] = h > 1e-12 ? step(p, v, h * direction).0 : p
            }
        }
        return out
    }
}


/// What else is known about the ball at a moment: a contact by a player (where they stand, roughly how high) or a
/// bounce on the floor (only its height). Monocular depth is only as good as the assumed spin (Magnus lift changes
/// the apparent gravity that fixes the scale), so anchors are what make short or spinning flights metric.
public struct BallAnchor: Hashable, Codable, Sendable {
    public var time: Double
    public var position: V3
    /// Standard deviations in metres of the horizontal (x and z) and vertical position; nil leaves that part free.
    public var horizontalSigma: Double?
    public var verticalSigma: Double?
    /// The spin expected of the flight this contact starts (`BallReconstruction.expectedAero(after:)`), used as the
    /// prior of the fitted lift coefficient.
    public var aero: BallFlight.Aero?

    public init(time: Double, position: V3, horizontalSigma: Double?, verticalSigma: Double?, aero: BallFlight.Aero? = nil) {
        self.time = time
        self.position = position
        self.horizontalSigma = horizontalSigma
        self.verticalSigma = verticalSigma
        self.aero = aero
    }

    /// The ball on the floor (landing or bounce): its centre one radius up, anywhere.
    public static func floor(at time: Double) -> BallAnchor {
        BallAnchor(time: time, position: V3(0, BallFlight.radius, 0), horizontalSigma: nil, verticalSigma: 0.03)
    }

    /// A contact at a hand of a fitted pose (`SkeletonModel.fingertip` of the posed player): the pose library places a
    /// hand to about 0.2 m.
    public static func hand(at time: Double, position: V3, sigma: Double = 0.3, aero: BallFlight.Aero? = nil) -> BallAnchor {
        BallAnchor(time: time, position: position, horizontalSigma: sigma, verticalSigma: sigma, aero: aero)
    }

    /// A contact by a player standing at `player`: the ball within about `horizontalSigma` of them (hands reach about
    /// half a metre from the body), at `height` when known.
    public static func contact(at time: Double, player: FloorPoint, height: Double? = nil, horizontalSigma: Double = 0.45,
                               verticalSigma: Double = 0.5, aero: BallFlight.Aero? = nil) -> BallAnchor {
        BallAnchor(time: time, position: V3(player, y: height ?? 0), horizontalSigma: horizontalSigma,
                   verticalSigma: height == nil ? nil : verticalSigma, aero: aero)
    }
}

/// Monocular ball reconstruction (Section 4.4). Gravity is known, so with the frame timing it fixes the metric scale:
/// the fit solves the launch position and velocity by Levenberg-Marquardt on the reprojection error, from a linear
/// (DLT-like) start and several depths along the first ray, drag-free first, then with the BallFlight drag model.
/// The scale is only as good as the assumed spin, so the fit also uses `BallAnchor`s (contacts, bounces), keeps the
/// ball above the floor, frees the lift coefficient when anchors pin the scale, and chains consecutive flights
/// through their shared contact point.
public enum BallReconstruction {
    public struct Settings: Hashable, Sendable {
        /// A flight's RMS reprojection error must stay below this (pixels at the video's resolution).
        public var rmsThreshold: Double = 3
        /// A new point joins the flight only when its own error is below this.
        public var pointThreshold: Double = 7
        /// Points per flight at least.
        public var minPoints: Int = 5
        /// Longer gaps without the ball always end a flight (seconds).
        public var maxGap: Double = 0.35
        /// Refine with drag and lift.
        public var drag: Bool = true
        /// Join consecutive flights at their contact (each pulls the other by its own uncertainty).
        public var chain: Bool = true

        public init() {}
    }

    /// The flight model's free parameters: launch position and velocity, and the lift coefficient when it is free.
    struct Fit {
        var p0: V3, v0: V3
        var aero: BallFlight.Aero
        var fitsLift: Bool
        /// Total cost (pixels squared plus priors) and the pixel part.
        var cost: Double
        var pixelCost: Double
        var count: Int
        var rms: Double { (pixelCost / Double(max(count, 1))).squareRoot() }
        var params: [Double] { [p0.x, p0.y, p0.z, v0.x, v0.y, v0.z] + (fitsLift ? [aero.lift] : []) }
    }

    /// Residual weights: pixels per metre below the floor; the lift prior without and with a contact hint.
    static let floorWeight = 50.0
    static let liftRange = -0.1...0.35
    static let liftScale = 0.2
    static let hintedLiftScale = 0.04

    /// The spin a contact gives the ball, as the core's ball plan models it: attacks and jump serves topspin, float
    /// serves none, passes, digs and sets a little backspin. Nil for a block (a deflection) or no contact.
    public static func expectedAero(after posture: Posture) -> BallFlight.Aero? {
        switch posture {
        case .attack, .quickAttack, .armCock, .jumpServe: return .topspin
        case .floatServe: return .float
        case .pass, .angledPass, .set, .backSet, .jumpSet, .overheadPass, .dig, .sprawl, .lowDefence, .cover: return .soft
        default: return nil
        }
    }

    /// The lift prior (centre, scale) of a flight: the spin hint of a contact at its start, else no spin, loosely.
    static func liftPrior(_ anchors: [BallAnchor], start: Double) -> (Double, Double) {
        if let a = anchors.filter({ $0.aero != nil && abs($0.time - start) <= 0.15 }).min(by: { abs($0.time - start) < abs($1.time - start) }) {
            return (a.aero!.lift, hintedLiftScale)
        }
        return (0, liftScale)
    }

    struct Problem {
        let obs: ArraySlice<BallObservation>
        let t0: Double
        let camera: VideoCamera
        let anchors: [BallAnchor]
        let aero: BallFlight.Aero
        let fitsLift: Bool
        var liftPrior: (centre: Double, scale: Double) = (0, liftScale)

        func aero(_ x: [Double]) -> BallFlight.Aero {
            fitsLift ? BallFlight.Aero(drag: aero.drag, lift: min(liftRange.upperBound, max(liftRange.lowerBound, x[6]))) : aero
        }

        func positions(_ x: [Double], times: [Double]) -> [V3] {
            BallSegment.positions(p0: V3(x[0], x[1], x[2]), v0: V3(x[3], x[4], x[5]), aero: aero(x), times: times.map { $0 - t0 })
        }

        /// Pixel residuals, floor penalties, anchor residuals (in sigmas) and the lift prior; nil when the ball would be
        /// behind the camera.
        func residuals(_ x: [Double]) -> (all: [Double], pixelCost: Double)? {
            let ps = positions(x, times: obs.map(\.time) + anchors.map(\.time))
            var r: [Double] = []
            r.reserveCapacity(obs.count * 3 + anchors.count * 3 + 1)
            var pixelCost = 0.0
            for (o, p) in zip(obs, ps) {
                guard let q = camera.project(p) else { return nil }
                let dx = q.x - o.image.x, dy = q.y - o.image.y
                r.append(dx)
                r.append(dy)
                pixelCost += dx * dx + dy * dy
                r.append(max(0, BallFlight.radius - p.y) * floorWeight)
            }
            for (a, p) in zip(anchors, ps.dropFirst(obs.count)) {
                if let h = a.horizontalSigma { r.append((p.x - a.position.x) / h); r.append((p.z - a.position.z) / h) }
                if let v = a.verticalSigma { r.append((p.y - a.position.y) / v) }
            }
            if fitsLift { r.append((x[6] - liftPrior.centre) / liftPrior.scale) }
            return (r, pixelCost)
        }

        func refine(_ x0: [Double], maxIterations: Int = 60) -> Fit? {
            let steps = [Double](repeating: 1e-5, count: x0.count)
            let clamp: ([Double]) -> [Double] = { x in
                guard fitsLift else { return x }
                var x = x
                x[6] = min(liftRange.upperBound, max(liftRange.lowerBound, x[6]))
                return x
            }
            guard let r = LevenbergMarquardt.minimize(x0, steps: steps, maxIterations: maxIterations, tolerance: 1e-10,
                                                      clamp: clamp, residuals: { residuals($0)?.all }),
                  let e = residuals(r.x) else { return nil }
            return Fit(p0: V3(r.x[0], r.x[1], r.x[2]), v0: V3(r.x[3], r.x[4], r.x[5]), aero: aero(r.x), fitsLift: fitsLift,
                       cost: r.cost, pixelCost: e.pixelCost, count: obs.count)
        }

        /// Standard deviation (metres, all axes together) of the fitted position at time t, from the Gauss-Newton
        /// covariance of the parameters with one-pixel measurement noise.
        func positionSigma(_ fit: Fit, at t: Double) -> Double {
            let x = fit.params, n = x.count
            guard let r0 = residuals(x)?.all else { return .infinity }
            let m = r0.count
            var jac = [Double](repeating: 0, count: m * n)
            var jp = [[Double]](repeating: [Double](repeating: 0, count: n), count: 3)
            for j in 0..<n {
                let h = 1e-5
                var xp = x, xm = x
                xp[j] += h
                xm[j] -= h
                guard let rp = residuals(xp)?.all, let rm = residuals(xm)?.all else { return .infinity }
                for i in 0..<m { jac[i * n + j] = (rp[i] - rm[i]) / (2 * h) }
                let pp = positions(xp, times: [t])[0], pm = positions(xm, times: [t])[0]
                jp[0][j] = (pp.x - pm.x) / (2 * h)
                jp[1][j] = (pp.y - pm.y) / (2 * h)
                jp[2][j] = (pp.z - pm.z) / (2 * h)
            }
            var jtj = [Double](repeating: 0, count: n * n)
            for i in 0..<m { for a in 0..<n { for b in 0..<n { jtj[a * n + b] += jac[i * n + a] * jac[i * n + b] } } }
            var variance = 0.0
            for k in 0..<3 {
                guard let y = LinearAlgebra.solve(jtj, jp[k], n: n) else { return .infinity }
                variance += zip(jp[k], y).reduce(0) { $0 + $1.0 * $1.1 }
            }
            return variance > 0 ? variance.squareRoot() : .infinity
        }
    }

    /// Drag-free start by linear least squares: each pixel gives two equations linear in (p0, v0) once the
    /// projection is cross-multiplied, (u' r3 - f r1) . (p0 + tau v0 + g tau^2 / 2 - C) = 0, likewise for v'.
    /// With `p0` given only v0 is solved.
    static func linearStart(_ obs: ArraySlice<BallObservation>, t0: Double, camera: VideoCamera, p0: V3? = nil) -> (V3, V3)? {
        let r = camera.matrix, f = camera.focalLength, c = camera.center
        let g = V3(0, -BallFlight.gravity, 0)
        var rows: [[Double]] = [], rhs: [Double] = []
        for o in obs {
            let tau = o.time - t0
            let u = o.image.x - camera.width / 2, v = o.image.y - camera.height / 2
            for a in [r.r2 * u - r.r0 * f, r.r2 * v - r.r1 * f] {
                let n = a.length
                guard n > 0 else { continue }
                let a = a * (1 / n)
                var y = a.dot(c) - 0.5 * tau * tau * a.dot(g)
                if let p0 {
                    y -= a.dot(p0)
                    rows.append([tau * a.x, tau * a.y, tau * a.z])
                } else {
                    rows.append([a.x, a.y, a.z, tau * a.x, tau * a.y, tau * a.z])
                }
                rhs.append(y)
            }
        }
        if let p0 {
            guard let x = LinearAlgebra.leastSquares(rows: rows, rhs: rhs, n: 3) else { return nil }
            return (p0, V3(x[0], x[1], x[2]))
        }
        guard let x = LinearAlgebra.leastSquares(rows: rows, rhs: rhs, n: 6) else { return nil }
        return (V3(x[0], x[1], x[2]), V3(x[3], x[4], x[5]))
    }

    /// The best drag-free flight (t0 = the first observation): LM from the linear start and from depths of 3 to 40 m
    /// along the first ray, or from `warm`.
    static func ballistic(_ obs: ArraySlice<BallObservation>, camera: VideoCamera, anchors: [BallAnchor] = [], warm: Fit? = nil) -> Fit? {
        guard obs.count >= 3, let t0 = obs.first?.time else { return nil }
        let problem = Problem(obs: obs, t0: t0, camera: camera, anchors: anchors, aero: BallSegment.vacuum, fitsLift: false)
        if let warm, let f = problem.refine(Array(warm.params.prefix(6)), maxIterations: 20) { return f }
        var starts: [(V3, V3)] = []
        if let s = linearStart(obs, t0: t0, camera: camera) { starts.append(s) }
        let ray = camera.ray(through: obs.first!.image)
        for depth in [3.0, 5, 8, 12, 18, 26, 40] {
            if let s = linearStart(obs, t0: t0, camera: camera, p0: ray.origin + ray.direction * depth) { starts.append(s) }
        }
        var best: Fit?
        for s in starts {
            guard let f = problem.refine([s.0.x, s.0.y, s.0.z, s.1.x, s.1.y, s.1.z]) else { continue }
            if best == nil || f.cost < best!.cost { best = f }
        }
        return best
    }

    /// Drag-free first, then the BallFlight model with drag: without anchors as a float (no spin, which the image
    /// cannot measure), kept if it fits at least as well; with anchors the lift coefficient is fitted too.
    static func bestFit(_ obs: ArraySlice<BallObservation>, camera: VideoCamera, anchors: [BallAnchor], drag: Bool) -> Fit? {
        guard let t0 = obs.first?.time, let free = ballistic(obs, camera: camera, anchors: anchors) else { return nil }
        guard drag else { return free }
        let base = free.params.prefix(6)
        if anchors.isEmpty {
            let problem = Problem(obs: obs, t0: t0, camera: camera, anchors: [], aero: .float, fitsLift: false)
            guard let f = problem.refine(Array(base), maxIterations: 40) else { return free }
            return f.cost <= free.cost ? f : free
        }
        var problem = Problem(obs: obs, t0: t0, camera: camera, anchors: anchors, aero: .float, fitsLift: true)
        problem.liftPrior = liftPrior(anchors, start: t0)
        var best = free
        for lift in Set([problem.liftPrior.centre, 0, 0.15]).sorted() {
            guard let f = problem.refine(Array(base) + [lift], maxIterations: 40) else { continue }
            if f.cost < best.cost { best = f }
        }
        return best
    }

    static func problem(for fit: Fit, _ obs: ArraySlice<BallObservation>, camera: VideoCamera, anchors: [BallAnchor]) -> Problem {
        var p = Problem(obs: obs, t0: obs.first!.time, camera: camera, anchors: anchors, aero: fit.aero, fitsLift: fit.fitsLift)
        p.liftPrior = liftPrior(anchors, start: obs.first!.time)
        return p
    }

    /// One flight through all the observations (with optional anchors). Nil with fewer than four observations or no
    /// flight in front of the camera.
    public static func fit(_ observations: [BallObservation], camera: VideoCamera, anchors: [BallAnchor] = [],
                           drag: Bool = true) -> BallSegment? {
        let obs = observations.sorted { $0.time < $1.time }
        guard obs.count >= 4, let first = obs.first, let last = obs.last,
              let best = bestFit(obs[...], camera: camera, anchors: anchors, drag: drag) else { return nil }
        return BallSegment(t0: first.time, t1: last.time, p0: best.p0, v0: best.v0, aero: best.aero, rmsError: best.rms)
    }

    /// Splits a ball track into flights at contacts: a flight grows point by point while its drag-free fit stays below
    /// `rmsThreshold` and the new point below `pointThreshold`; then each boundary moves by up to three points to the
    /// split with the lowest total error. Groups shorter than `minPoints` are dropped (a held ball, noise).
    public static func split(_ observations: [BallObservation], camera: VideoCamera, settings: Settings = Settings()) -> [[BallObservation]] {
        let obs = observations.sorted { $0.time < $1.time }
        let n = obs.count
        let minPoints = max(4, settings.minPoints)
        func pointError(_ f: Fit, _ o: BallObservation, t0: Double) -> Double {
            let p = BallSegment.positions(p0: f.p0, v0: f.v0, aero: f.aero, times: [o.time - t0])[0]
            return camera.project(p).map { $0.distance(to: o.image) } ?? .infinity
        }
        var ranges: [Range<Int>] = []
        var start = 0
        while start + minPoints <= n {
            var end = start + minPoints
            if let gap = (start + 1..<end).first(where: { obs[$0].time - obs[$0 - 1].time > settings.maxGap }) {
                start = gap
                continue
            }
            guard var fit = ballistic(obs[start..<end], camera: camera), fit.rms <= settings.rmsThreshold else {
                start += 1
                continue
            }
            while end < n && obs[end].time - obs[end - 1].time <= settings.maxGap {
                guard let candidate = ballistic(obs[start...end], camera: camera, warm: fit),
                      candidate.rms <= settings.rmsThreshold,
                      pointError(candidate, obs[end], t0: obs[start].time) <= settings.pointThreshold else { break }
                fit = candidate
                end += 1
            }
            ranges.append(start..<end)
            start = end
        }
        func cost(_ r: Range<Int>) -> Double { ballistic(obs[r], camera: camera).map(\.pixelCost) ?? .infinity }
        if ranges.count > 1 {
            for i in 0..<(ranges.count - 1) {
                let a = ranges[i], b = ranges[i + 1]
                guard b.lowerBound == a.upperBound else { continue }
                var best = (cost: cost(a) + cost(b), split: a.upperBound)
                for s in (a.upperBound - 3)...(a.upperBound + 3) where s != a.upperBound {
                    guard s - a.lowerBound >= minPoints, b.upperBound - s >= minPoints else { continue }
                    let c = cost(a.lowerBound..<s) + cost(s..<b.upperBound)
                    if c < best.cost { best = (c, s) }
                }
                ranges[i] = a.lowerBound..<best.split
                ranges[i + 1] = best.split..<b.upperBound
            }
        }
        return ranges.map { Array(obs[$0]) }
    }

    /// Reconstructs flights (observation groups from `split`) with the anchors falling in or next to each, places
    /// the contact between consecutive flights where they pass closest, and chains them there: both flights are
    /// refitted with the contact point fused from the two by their uncertainties.
    public static func reconstruct(flights: [[BallObservation]], camera: VideoCamera, anchors: [BallAnchor] = [],
                                   settings: Settings = Settings()) -> [BallSegment] {
        let groups = flights.map { $0.sorted { $0.time < $1.time } }.filter { $0.count >= 4 }
        func own(_ g: [BallObservation]) -> [BallAnchor] {
            anchors.filter { $0.time >= g.first!.time - 0.15 && $0.time <= g.last!.time + 0.15 }
        }
        var extra = [[BallAnchor]](repeating: [], count: groups.count)
        var fits = groups.map { bestFit($0[...], camera: camera, anchors: own($0), drag: settings.drag) }
        // Contact times where consecutive flights pass closest.
        var contacts = [Double?](repeating: nil, count: groups.count)
        func segment(_ i: Int) -> BallSegment? {
            fits[i].map { BallSegment(t0: groups[i].first!.time, t1: groups[i].last!.time, p0: $0.p0, v0: $0.v0, aero: $0.aero, rmsError: $0.rms) }
        }
        for i in 0..<max(0, groups.count - 1) {
            guard let a = segment(i), let b = segment(i + 1), b.t0 - a.t1 <= settings.maxGap + 1e-9 else { continue }
            var best = (d: Double.infinity, t: (a.t1 + b.t0) / 2)
            for k in 0...24 {
                let t = a.t1 + (b.t0 - a.t1) * Double(k) / 24
                let d = (a.unclamped(at: t) - b.unclamped(at: t)).length
                if d < best.d { best = (d, t) }
            }
            contacts[i] = best.t
        }
        if settings.chain {
            for i in 0..<max(0, groups.count - 1) {
                guard let tc = contacts[i], let fa = fits[i], let fb = fits[i + 1] else { continue }
                let pa = problem(for: fa, groups[i][...], camera: camera, anchors: own(groups[i]))
                let pb = problem(for: fb, groups[i + 1][...], camera: camera, anchors: own(groups[i + 1]))
                let sa = pa.positionSigma(fa, at: tc), sb = pb.positionSigma(fb, at: tc)
                guard sa.isFinite || sb.isFinite else { continue }
                let xa = pa.positions(fa.params, times: [tc])[0], xb = pb.positions(fb.params, times: [tc])[0]
                let wa = sa.isFinite ? 1 / (sa * sa) : 0, wb = sb.isFinite ? 1 / (sb * sb) : 0
                let fused = (xa * wa + xb * wb) * (1 / (wa + wb))
                let sigma = (1 / (wa + wb)).squareRoot() + 0.05
                let anchor = BallAnchor(time: tc, position: fused, horizontalSigma: sigma, verticalSigma: sigma)
                extra[i].append(anchor)
                extra[i + 1].append(anchor)
            }
            for i in groups.indices where !extra[i].isEmpty {
                guard let f = fits[i] else { continue }
                var p = Problem(obs: groups[i][...], t0: groups[i].first!.time, camera: camera, anchors: own(groups[i]) + extra[i],
                                aero: f.aero, fitsLift: settings.drag)
                p.liftPrior = liftPrior(own(groups[i]), start: groups[i].first!.time)
                let x0 = Array(f.params.prefix(6)) + (settings.drag ? [f.fitsLift ? f.aero.lift : 0] : [])
                if let g = p.refine(x0, maxIterations: 40) { fits[i] = g }
            }
        }
        var segments: [BallSegment] = []
        for i in groups.indices {
            guard var s = segment(i) else { continue }
            if i > 0, let tc = contacts[i - 1] {
                let p = s.unclamped(at: tc), v = s.velocity(at: tc)
                s = BallSegment(t0: tc, t1: s.t1, p0: p, v0: v, aero: s.aero, rmsError: s.rmsError)
            }
            if let tc = contacts[i] { s.t1 = tc }
            segments.append(s)
        }
        return segments
    }

    /// `split` then `reconstruct`.
    public static func segment(_ observations: [BallObservation], camera: VideoCamera, anchors: [BallAnchor] = [],
                               settings: Settings = Settings()) -> [BallSegment] {
        reconstruct(flights: split(observations, camera: camera, settings: settings), camera: camera, anchors: anchors, settings: settings)
    }
}

extension BallSegment {
    func unclamped(at t: Double) -> V3 { Self.positions(p0: p0, v0: v0, aero: aero, times: [t - t0])[0] }

    /// Velocity at time t (central difference of the trajectory).
    public func velocity(at t: Double) -> V3 {
        let h = 1e-4
        let p = Self.positions(p0: p0, v0: v0, aero: aero, times: [t - t0 - h, t - t0 + h])
        return (p[1] - p[0]) * (1 / (2 * h))
    }
}
