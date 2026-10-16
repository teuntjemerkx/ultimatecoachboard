import Foundation

/// Phase markers of a rally on a scene's timeline (Sections 3.3 and 3.5.7).
public enum RallyPhase: String, Codable, CaseIterable, Sendable, Hashable {
    case serve, receive, set, attack, cover, defence

    public var title: String { rawValue.uppercased() }
}

/// A player's keyframe at a phase marker: where they stand and, optionally, their posture.
public struct TokenKey: Codable, Hashable, Sendable {
    public var phase: RallyPhase
    public var point: FloorPoint
    public var posture: Posture?

    public init(phase: RallyPhase, point: FloorPoint, posture: Posture? = nil) {
        self.phase = phase
        self.point = point
        self.posture = posture
    }
}

/// A zone's keyframe at a phase marker: its geometry and style intensity (0 hides it, 1 is the full style).
public struct ZoneKey: Codable, Hashable, Sendable {
    public var phase: RallyPhase
    public var geometry: ZoneGeometry
    public var intensity: Double

    public init(phase: RallyPhase, geometry: ZoneGeometry, intensity: Double = 1) {
        self.phase = phase
        self.geometry = geometry
        self.intensity = intensity
    }
}

/// A zone changing type between two keyframes (a circle becoming a rectangle): the floor shader blends the two
/// signed distances, d(t) = (1 - t) d0 + t d1. Not an exact distance field, but its zero contour morphs smoothly.
public struct ZoneMorph: Hashable, Sendable {
    public var to: ZoneGeometry
    public var t: Double

    public init(to: ZoneGeometry, t: Double) {
        self.to = to
        self.t = t
    }
}

/// A posture changing between two keyframes; joints blend by quaternion slerp.
public struct PostureBlend: Hashable, Sendable {
    public var from: Posture
    public var to: Posture
    public var t: Double

    public init(from: Posture, to: Posture, t: Double) {
        self.from = from
        self.to = to
        self.t = t
    }
}

/// The scene at one moment of its timeline: tokens where they stand, zones in their shape and intensity.
public struct SceneFrame: Sendable {
    /// Tokens with `point` and `posture` evaluated (posture is the blend's start while a blend runs).
    public var tokens: [SceneToken]
    public var postureBlends: [UUID: PostureBlend]
    /// Zones with `geometry` evaluated and the style opacity scaled by the intensity.
    public var zones: [Zone]
    public var intensities: [UUID: Double]
    public var morphs: [UUID: ZoneMorph]

    /// Signed distance to a zone as drawn in this frame (morphs blend the two shapes).
    public func distance(to zone: Zone, _ p: FloorPoint) -> Double {
        let d = zone.distance(to: p)
        guard let m = morphs[zone.id] else { return d }
        return (1 - m.t) * d + m.t * ZoneSDF.distance(m.to, p)
    }

    /// The topmost visible zone under a point.
    public func zone(at p: FloorPoint, tolerance: Double = 0.15) -> Zone? {
        zones.last { (intensities[$0.id] ?? 1) > 0.05 && distance(to: $0, p) <= tolerance }
    }
}

extension TacticalScene {
    /// The phase markers in use, in order; empty for a static scene.
    public var timeline: [RallyPhase] { phases ?? [] }

    /// Timeline position of a phase marker (phase-index units), or nil when the scene does not use it.
    public func time(of phase: RallyPhase) -> Double? { timeline.firstIndex(of: phase).map(Double.init) }

    /// The scene at a timeline position in phase-index units (0 = the first marker). The base values of tokens
    /// and zones are the first marker's; keyframes at later markers move them. Each interval eases critically damped.
    public func frame(at time: Double) -> SceneFrame {
        let line = timeline
        func index(_ p: RallyPhase) -> Int? { line.firstIndex(of: p).flatMap { $0 > 0 ? $0 : nil } }
        var frame = SceneFrame(tokens: [], postureBlends: [:], zones: [], intensities: [:], morphs: [:])
        for token in tokens {
            var keys: [(Int, FloorPoint, Posture)] = [(0, token.point, token.effectivePosture)]
            for k in (token.keys ?? []).compactMap({ k in index(k.phase).map { (k, $0) } }).sorted(by: { $0.1 < $1.1 }) {
                if keys.last?.0 == k.1 { keys.removeLast() }
                // A key without a posture keeps the previous one, unless the player is fully automatic.
                let posture = k.0.posture ?? (token.posture == nil ? SceneToken.automaticPosture(at: k.0.point) : keys.last!.2)
                keys.append((k.1, k.0.point, posture))
            }
            var t = token
            let (i, u) = Timeline.locate(time, keys.map(\.0))
            if u == 0 || i + 1 >= keys.count {
                t.point = keys[i].1
                t.posture = keys[i].2
            } else {
                t.point = Timeline.path(keys.map(\.1), segment: i, u: u)
                t.posture = keys[i].2
                if keys[i].2 != keys[i + 1].2 {
                    frame.postureBlends[token.id] = PostureBlend(from: keys[i].2, to: keys[i + 1].2, t: u)
                }
            }
            frame.tokens.append(t)
        }
        for zone in zones {
            var keys: [(Int, ZoneGeometry, Double)] = [(0, zone.geometry, 1)]
            for k in (zone.keys ?? []).compactMap({ k in index(k.phase).map { (k, $0) } }).sorted(by: { $0.1 < $1.1 }) {
                if keys.last?.0 == k.1 { keys.removeLast() }
                keys.append((k.1, k.0.geometry, k.0.intensity))
            }
            var z = zone
            let (i, u) = Timeline.locate(time, keys.map(\.0))
            let intensity: Double
            if u == 0 || i + 1 >= keys.count {
                z.geometry = keys[i].1
                intensity = keys[i].2
            } else {
                let (g, morph) = ZoneInterpolation.interpolate(keys[i].1, keys[i + 1].1, u)
                z.geometry = g
                if let morph { frame.morphs[zone.id] = morph }
                intensity = keys[i].2 + (keys[i + 1].2 - keys[i].2) * u
            }
            z.style.opacity *= intensity
            frame.intensities[zone.id] = intensity
            frame.zones.append(z)
        }
        return frame
    }
}

extension SceneToken {
    /// Ready on court, standing behind the end line (the server).
    public static func automaticPosture(at p: FloorPoint) -> Posture { abs(p.z) > 9 ? .standing : .ready }
}

/// Timeline helpers: interval lookup with critically damped easing and paths through keyframes.
public enum Timeline {
    /// The interval of `time` among increasing key times: (index of the interval's first key, eased fraction).
    /// Before the first key or after the last, the fraction is 0 at the nearest key.
    public static func locate(_ time: Double, _ keyTimes: [Int]) -> (Int, Double) {
        guard let first = keyTimes.first, let last = keyTimes.last, keyTimes.count > 1 else { return (0, 0) }
        if time <= Double(first) { return (0, 0) }
        if time >= Double(last) { return (keyTimes.count - 1, 0) }
        var i = 0
        while i + 1 < keyTimes.count && Double(keyTimes[i + 1]) <= time { i += 1 }
        let a = Double(keyTimes[i]), b = Double(keyTimes[i + 1])
        return (i, criticallyDamped((time - a) / (b - a)))
    }

    /// A point on the open centripetal Catmull-Rom path through `points`, on the span from `points[segment]` to
    /// `points[segment + 1]`, at arc-length fraction `u` (Section 3.3: paths reparametrized by arc length).
    public static func path(_ points: [FloorPoint], segment k: Int, u: Double) -> FloorPoint {
        let p1 = points[k], p2 = points[k + 1]
        if hypot(p2.x - p1.x, p2.z - p1.z) < 1e-9 { return p1 }
        // End spans mirror the neighbour so the curve starts and ends straight.
        let p0 = k > 0 ? points[k - 1] : FloorPoint(x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z)
        let p3 = k + 2 < points.count ? points[k + 2] : FloorPoint(x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z)
        let samples = 24
        var pts = [p1]
        var lengths = [0.0]
        for s in 1...samples {
            let q = catmullRom(p0, p1, p2, p3, Double(s) / Double(samples))
            lengths.append(lengths[s - 1] + hypot(q.x - pts[s - 1].x, q.z - pts[s - 1].z))
            pts.append(q)
        }
        let target = max(0, min(1, u)) * lengths[samples]
        var s = 1
        while s < samples && lengths[s] < target { s += 1 }
        let span = lengths[s] - lengths[s - 1]
        let f = span > 0 ? (target - lengths[s - 1]) / span : 0
        return FloorPoint(x: pts[s - 1].x + (pts[s].x - pts[s - 1].x) * f, z: pts[s - 1].z + (pts[s].z - pts[s - 1].z) * f)
    }

    /// Centripetal (alpha = 0.5) Catmull-Rom between p1 and p2 at parameter fraction f.
    static func catmullRom(_ p0: FloorPoint, _ p1: FloorPoint, _ p2: FloorPoint, _ p3: FloorPoint, _ f: Double) -> FloorPoint {
        func knot(_ a: FloorPoint, _ b: FloorPoint) -> Double { max(pow((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z), 0.25), 1e-6) }
        let t0 = 0.0, t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3)
        let t = t1 + (t2 - t1) * f
        func mix(_ a: FloorPoint, _ b: FloorPoint, _ ta: Double, _ tb: Double) -> FloorPoint {
            let w = (t - ta) / (tb - ta)
            return FloorPoint(x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w)
        }
        let a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3)
        let b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3)
        return mix(b1, b2, t1, t2)
    }
}

/// Zone keyframe interpolation (Section 3.5.7).
public enum ZoneInterpolation {
    /// Points per outline when polygons of different vertex counts morph.
    public static let resampleCount = 64

    /// The geometry between two keyframes at eased fraction `t`, or the start geometry plus a signed-distance morph
    /// when the type changes. Same type: centre and size interpolate linearly, the angle along the shortest arc;
    /// circles and ellipses are one family. Polygons and freeforms: equal vertex counts interpolate directly after
    /// aligning the start vertex; otherwise both outlines are resampled to 64 points by arc length first.
    public static func interpolate(_ a: ZoneGeometry, _ b: ZoneGeometry, _ t: Double) -> (ZoneGeometry, ZoneMorph?) {
        if t <= 0 { return (a, nil) }
        if t >= 1 { return (b, nil) }
        func lerp(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
        func lerp(_ p: FloorPoint, _ q: FloorPoint) -> FloorPoint { FloorPoint(x: lerp(p.x, q.x), z: lerp(p.z, q.z)) }
        // Rectangles and ellipses look the same turned by pi, so their shortest arc is taken modulo pi.
        func angle(_ x: Double, _ y: Double) -> Double {
            var d = (y - x).truncatingRemainder(dividingBy: .pi)
            if d > .pi / 2 { d -= .pi }
            if d < -.pi / 2 { d += .pi }
            return x + d * t
        }
        switch (a, b) {
        case let (.rect(c0, w0, d0, a0), .rect(c1, w1, d1, a1)):
            return (.rect(center: lerp(c0, c1), halfWidth: lerp(w0, w1), halfDepth: lerp(d0, d1), angle: angle(a0, a1)), nil)
        case let (.circle(c0, r0), .circle(c1, r1)):
            return (.circle(center: lerp(c0, c1), radius: lerp(r0, r1)), nil)
        case let (.circle(c0, r0), .ellipse(c1, a1, b1, an1)):
            return (.ellipse(center: lerp(c0, c1), a: lerp(r0, a1), b: lerp(r0, b1), angle: an1), nil)
        case let (.ellipse(c0, a0, b0, an0), .circle(c1, r1)):
            return (.ellipse(center: lerp(c0, c1), a: lerp(a0, r1), b: lerp(b0, r1), angle: an0), nil)
        case let (.ellipse(c0, a0, b0, an0), .ellipse(c1, a1, b1, an1)):
            return (.ellipse(center: lerp(c0, c1), a: lerp(a0, a1), b: lerp(b0, b1), angle: angle(an0, an1)), nil)
        case let (.freeform(p), .freeform(q)) where p.count == q.count:
            let start = oriented(p)
            return (.freeform(blend(start, align(oriented(q), to: start), t)), nil)
        case let (.polygon(p), .polygon(q)) where p.count == q.count:
            let start = oriented(p)
            return (.polygon(blend(start, align(oriented(q), to: start), t)), nil)
        case (.polygon, .polygon), (.polygon, .freeform), (.freeform, .polygon), (.freeform, .freeform):
            let p = resample(oriented(ZoneSDF.outline(a)), count: resampleCount)
            let q = resample(oriented(ZoneSDF.outline(b)), count: resampleCount)
            return (.polygon(blend(p, align(q, to: p), t)), nil)
        default:
            return (a, ZoneMorph(to: b, t: t))
        }
    }

    private static func blend(_ p: [FloorPoint], _ q: [FloorPoint], _ t: Double) -> [FloorPoint] {
        zip(p, q).map { FloorPoint(x: $0.x + ($1.x - $0.x) * t, z: $0.z + ($1.z - $0.z) * t) }
    }

    /// Signed area in the X-Z plane (positive counter-clockwise when looking down with X right and Z up).
    public static func signedArea(_ p: [FloorPoint]) -> Double {
        guard p.count >= 3 else { return 0 }
        var s = 0.0
        for i in 0..<p.count {
            let a = p[i], b = p[(i + 1) % p.count]
            s += a.x * b.z - b.x * a.z
        }
        return s / 2
    }

    /// The same outline with counter-clockwise winding, so two outlines run the same way round before morphing.
    public static func oriented(_ p: [FloorPoint]) -> [FloorPoint] { signedArea(p) < 0 ? p.reversed() : p }

    /// `count` points spaced evenly by arc length around a closed outline, starting at its first vertex.
    public static func resample(_ p: [FloorPoint], count: Int) -> [FloorPoint] {
        guard p.count >= 2 else { return Array(repeating: p.first ?? FloorPoint(x: 0, z: 0), count: count) }
        var cumulative = [0.0]
        for i in 0..<p.count {
            let a = p[i], b = p[(i + 1) % p.count]
            cumulative.append(cumulative[i] + hypot(b.x - a.x, b.z - a.z))
        }
        let total = cumulative[p.count]
        guard total > 0 else { return Array(repeating: p[0], count: count) }
        var out: [FloorPoint] = []
        var seg = 0
        for k in 0..<count {
            let s = total * Double(k) / Double(count)
            while seg < p.count - 1 && cumulative[seg + 1] < s { seg += 1 }
            let a = p[seg], b = p[(seg + 1) % p.count]
            let len = cumulative[seg + 1] - cumulative[seg]
            let f = len > 0 ? (s - cumulative[seg]) / len : 0
            out.append(FloorPoint(x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f))
        }
        return out
    }

    /// `q` cyclically shifted so its start lines up with `p`: the shift minimizing the sum of squared distances.
    public static func align(_ q: [FloorPoint], to p: [FloorPoint]) -> [FloorPoint] {
        let n = q.count
        guard n == p.count, n > 1 else { return q }
        var best = (shift: 0, cost: Double.infinity)
        for s in 0..<n {
            var cost = 0.0
            for i in 0..<n {
                let a = p[i], b = q[(i + s) % n]
                cost += (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)
                if cost >= best.cost { break }
            }
            if cost < best.cost { best = (s, cost) }
        }
        return (0..<n).map { q[($0 + best.shift) % n] }
    }
}
