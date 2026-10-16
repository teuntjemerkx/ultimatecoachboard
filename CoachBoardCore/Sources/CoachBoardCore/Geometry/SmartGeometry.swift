import Foundation

public typealias P2 = SIMD2<Double>

/// Result kinds of the Smart Geometry recognizer (blueprint Section 3.5.3, Appendix D5).
public enum ShapeKind: String, Codable, Sendable, CaseIterable {
    case line, openPath, circle, ellipse, rect, polygon, freeform
}

public struct RecognizedShape: Hashable, Sendable {
    public var kind: ShapeKind
    /// Offered on the one-tap alternative chip when the runner-up is close.
    public var alternative: ShapeKind?
    public var center: P2 = .zero
    public var radius: Double = 0
    public var semiAxes: P2 = .zero
    public var angle: Double = 0
    /// Rectangle corners or polygon vertices, in stroke coordinates.
    public var vertices: [P2] = []
    /// The resampled stroke, kept for freeform and open paths.
    public var resampled: [P2] = []
}

public struct RecognizerParameters: Hashable, Sendable {
    public var tau: Double
    public var closeGap: Double
    public var circleRatio: Double
    public var prior: Double
    public var complexity: Double
    public var ambiguity: Double

    /// Tuned on synthetic strokes, "normal hand" (Appendix D5): 94.7% on the test set.
    public static let normalHand = RecognizerParameters(tau: 0.035, closeGap: 0.15, circleRatio: 1.25,
                                                        prior: 0.008, complexity: 0.002, ambiguity: 0.15)
    /// Tuned for a shaky hand: 89.1% on the test set.
    public static let shakyHand = RecognizerParameters(tau: 0.045, closeGap: 0.15, circleRatio: 1.4,
                                                       prior: 0.008, complexity: 0.002, ambiguity: 0.15)
}

public enum SmartGeometry {
    public static let sampleCount = 64

    // MARK: - Recognizer

    public static func recognize(_ stroke: [P2], parameters prm: RecognizerParameters = .normalHand) -> RecognizedShape {
        guard stroke.count >= 3 else { return RecognizedShape(kind: .openPath, resampled: stroke) }
        let (p, length) = resample(stroke, n: sampleCount)
        let diag = boundingDiagonal(p)
        guard length > 0, diag > 0 else { return RecognizedShape(kind: .openPath, resampled: p) }

        if simd_length_double(p[p.count - 1] - p[0]) / length >= prm.closeGap {
            let line = fitLine(p)
            if line.rms / diag < 0.03 {
                return RecognizedShape(kind: .line, center: line.center, angle: atan2(line.direction.y, line.direction.x),
                                       vertices: [p[0], p[p.count - 1]], resampled: p)
            }
            return RecognizedShape(kind: .openPath, resampled: p)
        }

        let cornerPoints = corners(p)
        let cornered = cornerPoints.count >= 3
        let circle = fitCircle(p)
        let ellipse = fitEllipse(p)
        let rect = minAreaRect(p)
        let rectRMS = rms(distanceToPolyline(p, rect, closed: true))
        let poly = polygonVertices(p, diagonal: diag, corners: cornerPoints)
        let polyRMS = poly.map { rms(distanceToPolyline(p, $0, closed: true)) } ?? .infinity
        let ratio = ellipse.map { $0.semiAxes.x / max($0.semiAxes.y, 1e-9) } ?? 1

        var candidates: [(ShapeKind, Double)] = []
        if ratio < prm.circleRatio {
            candidates.append((.circle, circle.rms / diag + 3 * prm.complexity + (cornered ? prm.prior : 0)))
        } else if let e = ellipse {
            candidates.append((.ellipse, e.rms / diag + 5 * prm.complexity + (cornered ? prm.prior : 0)))
        }
        let polyIsRect = poly.map { quadIsRect($0) } ?? false
        let rectOK = polyIsRect || (poly != nil && poly!.count == 4 && rectRMS <= 1.6 * polyRMS)
        if rectOK || poly == nil {
            candidates.append((.rect, rectRMS / diag + 5 * prm.complexity + (cornered ? 0 : prm.prior)))
        }
        if let poly, !(poly.count == 4 && polyIsRect) {
            candidates.append((.polygon, polyRMS / diag + 2 * Double(poly.count) * prm.complexity + (cornered ? 0 : prm.prior)))
        }
        candidates = candidates.filter { $0.1.isFinite }.sorted { $0.1 < $1.1 }

        guard let best = candidates.first, best.1 <= prm.tau else {
            let alt = candidates.first.flatMap { $0.1 < 1.4 * prm.tau ? $0.0 : nil }
            return RecognizedShape(kind: .freeform, alternative: alt, resampled: p)
        }
        var alternative: ShapeKind?
        if candidates.count > 1, candidates[1].1 - best.1 < prm.ambiguity * best.1 {
            alternative = candidates[1].0
        } else if best.1 > 0.85 * prm.tau {
            alternative = .freeform
        }

        var shape = RecognizedShape(kind: best.0, alternative: alternative, resampled: p)
        switch best.0 {
        case .circle:
            shape.center = circle.center
            shape.radius = circle.radius
        case .ellipse:
            if let e = ellipse {
                shape.center = e.center
                shape.semiAxes = e.semiAxes
                shape.angle = e.angle
            }
        case .rect:
            shape.vertices = rect
            shape.center = rect.reduce(P2.zero, +) / 4
            let edge = rect[1] - rect[0]
            shape.angle = atan2(edge.y, edge.x)
        case .polygon:
            shape.vertices = poly ?? []
            shape.center = shape.vertices.reduce(P2.zero, +) / Double(max(shape.vertices.count, 1))
        default:
            break
        }
        return shape
    }

    // MARK: - Preprocessing

    public static func resample(_ pts: [P2], n: Int) -> ([P2], Double) {
        guard pts.count >= 2, n >= 2 else { return (pts, 0) }
        var cumulative: [Double] = [0]
        cumulative.reserveCapacity(pts.count)
        for i in 1..<pts.count { cumulative.append(cumulative[i - 1] + simd_length_double(pts[i] - pts[i - 1])) }
        let total = cumulative[cumulative.count - 1]
        guard total > 0 else { return (Array(repeating: pts[0], count: n), 0) }
        var out: [P2] = []
        out.reserveCapacity(n)
        var j = 0
        for k in 0..<n {
            let t = total * Double(k) / Double(n - 1)
            while j < pts.count - 2 && cumulative[j + 1] < t { j += 1 }
            let segment = cumulative[j + 1] - cumulative[j]
            let u = segment > 0 ? (t - cumulative[j]) / segment : 0
            out.append(pts[j] + (pts[j + 1] - pts[j]) * min(max(u, 0), 1))
        }
        return (out, total)
    }

    static func boundingDiagonal(_ p: [P2]) -> Double {
        var lo = p[0], hi = p[0]
        for q in p {
            lo = P2(min(lo.x, q.x), min(lo.y, q.y))
            hi = P2(max(hi.x, q.x), max(hi.y, q.y))
        }
        return simd_length_double(hi - lo)
    }

    static func rms(_ d: [Double]) -> Double {
        guard !d.isEmpty else { return .infinity }
        return (d.reduce(0) { $0 + $1 * $1 } / Double(d.count)).squareRoot()
    }

    static func cross(_ a: P2, _ b: P2) -> Double { a.x * b.y - a.y * b.x }

    public static func distanceToPolyline(_ p: [P2], _ poly: [P2], closed: Bool) -> [Double] {
        guard poly.count >= 2 else { return p.map { _ in .infinity } }
        let path = closed ? poly + [poly[0]] : poly
        return p.map { q in
            var best = Double.infinity
            for i in 0..<(path.count - 1) {
                let a = path[i], b = path[i + 1]
                let ab = b - a
                let l2 = simd_dot_double(ab, ab)
                let t = l2 > 0 ? min(max(simd_dot_double(q - a, ab) / l2, 0), 1) : 0
                best = min(best, simd_length_double(q - (a + ab * t)))
            }
            return best
        }
    }

    // MARK: - Corners (ring-contrast test)

    public static func corners(_ p: [P2], window w: Int = 3, minAngle: Double = 45, contrast: Double = 2.0) -> [P2] {
        var q = p
        if q.count > 1 && simd_length_double(q[0] - q[q.count - 1]) < 1e-12 { q.removeLast() }
        let n = q.count
        guard n > 2 * (w + 8) else { return [] }
        func at(_ i: Int) -> P2 { q[((i % n) + n) % n] }
        var angle = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let a = q[i] - at(i - w)
            let b = at(i + w) - q[i]
            angle[i] = abs(atan2(cross(a, b), simd_dot_double(a, b))) * 180 / .pi
        }
        func ang(_ i: Int) -> Double { angle[((i % n) + n) % n] }
        var found: [Int] = []
        for i in 0..<n {
            if angle[i] < minAngle || angle[i] < ang(i - 1) || angle[i] < ang(i + 1) { continue }
            var ring: [Double] = []
            for s in (w + 2)...(w + 7) { ring.append(ang(i + s)) }
            for s in (-w - 7)...(-w - 2) { ring.append(ang(i + s)) }
            let mean = ring.reduce(0, +) / Double(ring.count)
            if angle[i] >= contrast * (mean + 1e-6) { found.append(i) }
        }
        var merged: [Int] = []
        for i in found {
            if let last = merged.last, i - last <= w {
                if angle[i] > angle[last] { merged[merged.count - 1] = i }
            } else {
                merged.append(i)
            }
        }
        if merged.count > 1, merged[0] + n - merged[merged.count - 1] <= w { merged.removeFirst() }
        return merged.map { q[$0] }
    }

    // MARK: - Fits

    public struct LineFit: Hashable, Sendable { public var center: P2; public var direction: P2; public var rms: Double }

    public static func fitLine(_ p: [P2]) -> LineFit {
        let c = p.reduce(P2.zero, +) / Double(p.count)
        var sxx = 0.0, sxy = 0.0, syy = 0.0
        for q in p {
            let d = q - c
            sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y
        }
        // Principal direction of the 2 x 2 scatter matrix.
        let theta = 0.5 * atan2(2 * sxy, sxx - syy)
        let u = P2(cos(theta), sin(theta))
        let normal = P2(-u.y, u.x)
        let r = rms(p.map { abs(simd_dot_double($0 - c, normal)) })
        return LineFit(center: c, direction: u, rms: r)
    }

    public struct CircleFit: Hashable, Sendable { public var center: P2; public var radius: Double; public var rms: Double }

    /// Kasa algebraic fit refined by Gauss-Newton on the geometric error.
    public static func fitCircle(_ p: [P2]) -> CircleFit {
        // Normal equations for [2x 2y 1] * [cx cy k] = x^2 + y^2.
        var ata = [[Double]](repeating: [0, 0, 0], count: 3)
        var atb = [Double](repeating: 0, count: 3)
        for q in p {
            let row = [2 * q.x, 2 * q.y, 1.0]
            let rhs = q.x * q.x + q.y * q.y
            for i in 0..<3 {
                atb[i] += row[i] * rhs
                for j in 0..<3 { ata[i][j] += row[i] * row[j] }
            }
        }
        var center = P2.zero
        var radius = 0.0
        if let x = solve3(ata, atb) {
            center = P2(x[0], x[1])
            radius = max(x[2] + simd_dot_double(center, center), 0).squareRoot()
        } else {
            center = p.reduce(P2.zero, +) / Double(p.count)
            radius = p.map { simd_length_double($0 - center) }.reduce(0, +) / Double(p.count)
        }
        // Gauss-Newton refinement: residual r_i = |p_i - c| - R.
        for _ in 0..<10 {
            var jtj = [[Double]](repeating: [0, 0, 0], count: 3)
            var jtr = [Double](repeating: 0, count: 3)
            for q in p {
                let d = q - center
                let len = max(simd_length_double(d), 1e-12)
                let r = len - radius
                let jrow = [-d.x / len, -d.y / len, -1.0]
                for i in 0..<3 {
                    jtr[i] += jrow[i] * r
                    for j in 0..<3 { jtj[i][j] += jrow[i] * jrow[j] }
                }
            }
            for i in 0..<3 { jtj[i][i] *= 1.0 + 1e-6 }
            guard let step = solve3(jtj, jtr.map { -$0 }) else { break }
            center += P2(step[0], step[1])
            radius += step[2]
            if abs(step[0]) + abs(step[1]) + abs(step[2]) < 1e-10 { break }
        }
        radius = abs(radius)
        let residuals = p.map { abs(simd_length_double($0 - center) - radius) }
        return CircleFit(center: center, radius: radius, rms: rms(residuals))
    }

    public struct EllipseFit: Hashable, Sendable {
        public var center: P2
        /// (major, minor) semi-axes.
        public var semiAxes: P2
        public var angle: Double
        public var rms: Double
    }

    /// Direct least-squares ellipse fit (Fitzgibbon; numerically stable form of Halir and Flusser).
    public static func fitEllipse(_ p: [P2]) -> EllipseFit? {
        let m = p.reduce(P2.zero, +) / Double(p.count)
        var s = 0.0
        for q in p { s = max(s, abs(q.x - m.x), abs(q.y - m.y)) }
        guard s > 0 else { return nil }
        var s1 = [[Double]](repeating: [0, 0, 0], count: 3)
        var s2 = [[Double]](repeating: [0, 0, 0], count: 3)
        var s3 = [[Double]](repeating: [0, 0, 0], count: 3)
        for q0 in p {
            let q = (q0 - m) / s
            let d1 = [q.x * q.x, q.x * q.y, q.y * q.y]
            let d2 = [q.x, q.y, 1.0]
            for i in 0..<3 {
                for j in 0..<3 {
                    s1[i][j] += d1[i] * d1[j]
                    s2[i][j] += d1[i] * d2[j]
                    s3[i][j] += d2[i] * d2[j]
                }
            }
        }
        guard let s3inv = invert3(s3) else { return nil }
        // T = -S3^-1 * S2^T
        var t = [[Double]](repeating: [0, 0, 0], count: 3)
        for i in 0..<3 {
            for j in 0..<3 {
                var acc = 0.0
                for k in 0..<3 { acc += s3inv[i][k] * s2[j][k] }
                t[i][j] = -acc
            }
        }
        // M = S1 + S2 * T, then premultiply by C1^-1.
        var mm = s1
        for i in 0..<3 {
            for j in 0..<3 {
                var acc = 0.0
                for k in 0..<3 { acc += s2[i][k] * t[k][j] }
                mm[i][j] += acc
            }
        }
        let mc: [[Double]] = [mm[2].map { $0 / 2 }, mm[1].map { -$0 }, mm[0].map { $0 / 2 }]
        var chosen: [Double]?
        var bestCond = 0.0
        for v in realEigenvectors3(mc) {
            let cond = 4 * v[0] * v[2] - v[1] * v[1]
            if cond > bestCond { bestCond = cond; chosen = v }
        }
        guard let a1 = chosen else { return nil }
        let a = a1[0], b = a1[1], c = a1[2]
        let d = t[0][0] * a + t[0][1] * b + t[0][2] * c
        let e = t[1][0] * a + t[1][1] * b + t[1][2] * c
        let f = t[2][0] * a + t[2][1] * b + t[2][2] * c
        let den = b * b - 4 * a * c
        guard abs(den) > 1e-15 else { return nil }
        let x0 = (2 * c * d - b * e) / den
        let y0 = (2 * a * e - b * d) / den
        let num = 2 * (a * e * e + c * d * d - b * d * e + den * f)
        let root = ((a - c) * (a - c) + b * b).squareRoot()
        let ax1 = max(num * (a + c + root), 0).squareRoot() / abs(den)
        let ax2 = max(num * (a + c - root), 0).squareRoot() / abs(den)
        let angle = 0.5 * atan2(-b, c - a)
        let center = P2(x0, y0) * s + m
        let big = ax1 * s, small = ax2 * s
        guard big.isFinite, small.isFinite, big > 0, small > 0 else { return nil }
        // Residual against a dense polyline of the fitted ellipse.
        var outline: [P2] = []
        outline.reserveCapacity(256)
        for k in 0..<256 {
            let tt = 2 * Double.pi * Double(k) / 256
            let local = P2(big * cos(tt), small * sin(tt))
            outline.append(P2(cos(angle) * local.x - sin(angle) * local.y,
                              sin(angle) * local.x + cos(angle) * local.y) + center)
        }
        let r = rms(distanceToPolyline(p, outline, closed: true))
        // `angle` is the direction of the first computed axis; report the major axis direction.
        let majorAngle = big >= small ? angle : angle + .pi / 2
        return EllipseFit(center: center, semiAxes: P2(max(big, small), min(big, small)), angle: majorAngle, rms: r)
    }

    /// Minimum-area enclosing rectangle via the convex hull and rotating edges.
    public static func minAreaRect(_ p: [P2]) -> [P2] {
        let hull = convexHull(p)
        guard hull.count >= 3 else {
            let c = p.reduce(P2.zero, +) / Double(max(p.count, 1))
            return [c, c, c, c]
        }
        var best: (area: Double, theta: Double, lo: P2, hi: P2)?
        for i in 0..<hull.count {
            let e = hull[(i + 1) % hull.count] - hull[i]
            let th = atan2(e.y, e.x)
            let cs = cos(th), sn = sin(th)
            var lo = P2(Double.infinity, Double.infinity)
            var hi = P2(-Double.infinity, -Double.infinity)
            for h in hull {
                let q = P2(cs * h.x + sn * h.y, -sn * h.x + cs * h.y)
                lo = P2(min(lo.x, q.x), min(lo.y, q.y))
                hi = P2(max(hi.x, q.x), max(hi.y, q.y))
            }
            let area = (hi.x - lo.x) * (hi.y - lo.y)
            if best == nil || area < best!.area { best = (area, th, lo, hi) }
        }
        let b = best!
        let cs = cos(b.theta), sn = sin(b.theta)
        let local = [P2(b.lo.x, b.lo.y), P2(b.hi.x, b.lo.y), P2(b.hi.x, b.hi.y), P2(b.lo.x, b.hi.y)]
        return local.map { P2(cs * $0.x - sn * $0.y, sn * $0.x + cs * $0.y) }
    }

    /// Andrew's monotone chain; counter-clockwise, no repeated end point.
    public static func convexHull(_ points: [P2]) -> [P2] {
        let pts = points.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard pts.count > 2 else { return pts }
        var lower: [P2] = []
        for q in pts {
            while lower.count >= 2 && cross(lower[lower.count - 1] - lower[lower.count - 2], q - lower[lower.count - 2]) <= 0 {
                lower.removeLast()
            }
            lower.append(q)
        }
        var upper: [P2] = []
        for q in pts.reversed() {
            while upper.count >= 2 && cross(upper[upper.count - 1] - upper[upper.count - 2], q - upper[upper.count - 2]) <= 0 {
                upper.removeLast()
            }
            upper.append(q)
        }
        lower.removeLast()
        upper.removeLast()
        return lower + upper
    }

    /// Ramer-Douglas-Peucker simplification of an open polyline.
    public static func rdp(_ p: [P2], epsilon: Double) -> [P2] {
        guard p.count >= 3 else { return p }
        let a = p[0], b = p[p.count - 1]
        let ab = b - a
        let len = simd_length_double(ab)
        var maxD = -1.0
        var index = 0
        for i in 1..<(p.count - 1) {
            let d = len > 0 ? abs(cross(ab, p[i] - a)) / len : simd_length_double(p[i] - a)
            if d > maxD { maxD = d; index = i }
        }
        if maxD > epsilon {
            let left = rdp(Array(p[0...index]), epsilon: epsilon)
            let right = rdp(Array(p[index...]), epsilon: epsilon)
            return Array(left.dropLast()) + right
        }
        return [a, b]
    }

    /// Union of detected corners and RDP vertices, ordered around the centroid, merged and pruned.
    public static func polygonVertices(_ p: [P2], diagonal diag: Double, corners cs: [P2],
                                       epsilon: Double = 0.04, merge: Double = 0.08, maxCount: Int = 6) -> [P2]? {
        let simplified = rdp(p + [p[0]], epsilon: epsilon * diag).dropLast()
        let centroid = p.reduce(P2.zero, +) / Double(p.count)
        let candidates = (cs + Array(simplified)).sorted {
            atan2($0.y - centroid.y, $0.x - centroid.x) < atan2($1.y - centroid.y, $1.x - centroid.x)
        }
        var out: [P2] = []
        for v in candidates where out.last.map({ simd_length_double(v - $0) > merge * diag }) ?? true {
            out.append(v)
        }
        if out.count > 2, simd_length_double(out[0] - out[out.count - 1]) < merge * diag { out.removeLast() }
        var changed = true
        while changed && out.count > 3 {
            changed = false
            for i in 0..<out.count {
                let a = out[(i - 1 + out.count) % out.count], b = out[i], c = out[(i + 1) % out.count]
                let u = b - a, v = c - b
                let turn = abs(atan2(cross(u, v), simd_dot_double(u, v))) * 180 / .pi
                if turn < 15 {
                    out.remove(at: i)
                    changed = true
                    break
                }
            }
        }
        return (3...maxCount).contains(out.count) ? out : nil
    }

    public static func quadIsRect(_ poly: [P2], tolerance: Double = 15) -> Bool {
        guard poly.count == 4 else { return false }
        for i in 0..<4 {
            let u = poly[(i + 3) % 4] - poly[i]
            let v = poly[(i + 1) % 4] - poly[i]
            let denom = simd_length_double(u) * simd_length_double(v)
            guard denom > 0 else { return false }
            let deg = acos(min(max(simd_dot_double(u, v) / denom, -1), 1)) * 180 / .pi
            if abs(deg - 90) > tolerance { return false }
        }
        return true
    }

    // MARK: - Small linear algebra

    static func det3(_ m: [[Double]]) -> Double {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    }

    static func invert3(_ m: [[Double]]) -> [[Double]]? {
        let d = det3(m)
        guard abs(d) > 1e-18 else { return nil }
        var inv = [[Double]](repeating: [0, 0, 0], count: 3)
        inv[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d
        inv[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d
        inv[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d
        inv[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d
        inv[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d
        inv[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d
        inv[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d
        inv[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d
        inv[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d
        return inv
    }

    static func solve3(_ a: [[Double]], _ b: [Double]) -> [Double]? {
        guard let inv = invert3(a) else { return nil }
        return (0..<3).map { i in inv[i][0] * b[0] + inv[i][1] * b[1] + inv[i][2] * b[2] }
    }

    /// Real eigenvectors of a general 3 x 3 matrix: real roots of the characteristic cubic,
    /// each eigenvector taken as the largest cross product of two rows of (M - lambda I).
    static func realEigenvectors3(_ m: [[Double]]) -> [[Double]] {
        let tr = m[0][0] + m[1][1] + m[2][2]
        let minors = (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            + (m[0][0] * m[2][2] - m[0][2] * m[2][0])
            + (m[0][0] * m[1][1] - m[0][1] * m[1][0])
        let det = det3(m)
        // lambda^3 - tr lambda^2 + minors lambda - det = 0
        var vectors: [[Double]] = []
        for lambda in realCubicRoots(a: -tr, b: minors, c: -det) {
            let r = (0..<3).map { i in (0..<3).map { j in m[i][j] - (i == j ? lambda : 0) } }
            func crossRows(_ x: [Double], _ y: [Double]) -> [Double] {
                [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
            }
            let options = [crossRows(r[0], r[1]), crossRows(r[0], r[2]), crossRows(r[1], r[2])]
            guard let best = options.max(by: { norm3($0) < norm3($1) }), norm3(best) > 1e-30 else { continue }
            let n = norm3(best)
            vectors.append(best.map { $0 / n })
        }
        return vectors
    }

    static func norm3(_ v: [Double]) -> Double { (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).squareRoot() }

    /// Real roots of x^3 + a x^2 + b x + c = 0.
    static func realCubicRoots(a: Double, b: Double, c: Double) -> [Double] {
        let q = (a * a - 3 * b) / 9
        let r = (2 * a * a * a - 9 * a * b + 27 * c) / 54
        let q3 = q * q * q
        if r * r < q3 {
            let theta = acos(min(max(r / q3.squareRoot(), -1), 1))
            let sq = -2 * q.squareRoot()
            return [sq * cos(theta / 3) - a / 3,
                    sq * cos((theta + 2 * .pi) / 3) - a / 3,
                    sq * cos((theta - 2 * .pi) / 3) - a / 3]
        }
        let aa = -copysign(pow(abs(r) + (r * r - q3).squareRoot(), 1.0 / 3.0), r)
        let bb = aa != 0 ? q / aa : 0
        return [(aa + bb) - a / 3]
    }
}

// Scalar helpers that work on every platform (simd_* double functions are not available on Linux).
@inline(__always) func simd_length_double(_ v: P2) -> Double { (v.x * v.x + v.y * v.y).squareRoot() }
@inline(__always) func simd_dot_double(_ a: P2, _ b: P2) -> Double { a.x * b.x + a.y * b.y }
