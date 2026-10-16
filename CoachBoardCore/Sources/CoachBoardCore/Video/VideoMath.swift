import Foundation

// Small dense numerics for the video reconstruction (Section 4): 3 x 3 matrices, a symmetric eigen solver, a linear
// solver, Levenberg-Marquardt and the Hungarian assignment. Foundation only, so the core builds on Linux.

/// A pixel position in a video frame: origin at the top-left corner, x to the right, y down (Vision's normalised
/// coordinates must be converted by the app: x * width, (1 - y) * height).
public struct ImagePoint: Hashable, Codable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public init(_ x: Double, _ y: Double) { self.init(x: x, y: y) }

    public static func + (a: ImagePoint, b: ImagePoint) -> ImagePoint { ImagePoint(a.x + b.x, a.y + b.y) }
    public static func - (a: ImagePoint, b: ImagePoint) -> ImagePoint { ImagePoint(a.x - b.x, a.y - b.y) }
    public static func * (a: ImagePoint, s: Double) -> ImagePoint { ImagePoint(a.x * s, a.y * s) }

    public func distance(to b: ImagePoint) -> Double { hypot(b.x - x, b.y - y) }
}

/// A 3 x 3 matrix stored by rows.
struct Matrix3: Hashable, Sendable {
    var r0: V3, r1: V3, r2: V3

    init(rows r0: V3, _ r1: V3, _ r2: V3) {
        self.r0 = r0; self.r1 = r1; self.r2 = r2
    }

    init(columns c0: V3, _ c1: V3, _ c2: V3) {
        self.init(rows: V3(c0.x, c1.x, c2.x), V3(c0.y, c1.y, c2.y), V3(c0.z, c1.z, c2.z))
    }

    /// The rotation matrix of a unit quaternion.
    init(_ q: Quat) {
        self.init(columns: q.rotate(V3(1, 0, 0)), q.rotate(V3(0, 1, 0)), q.rotate(V3(0, 0, 1)))
    }

    /// Row-major values.
    init(_ m: [Double]) {
        self.init(rows: V3(m[0], m[1], m[2]), V3(m[3], m[4], m[5]), V3(m[6], m[7], m[8]))
    }

    static let identity = Matrix3(rows: V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1))

    /// Rotation about the world vertical by `yaw` (from +Z toward +X), as SkeletonModel's facing.
    static func yaw(_ a: Double) -> Matrix3 {
        let c = cos(a), s = sin(a)
        return Matrix3(rows: V3(c, 0, s), V3(0, 1, 0), V3(-s, 0, c))
    }

    /// Rodrigues: the rotation by |w| radians about w.
    static func rotation(_ w: V3) -> Matrix3 {
        let theta = w.length
        guard theta > 1e-12 else {
            return Matrix3(rows: V3(1, -w.z, w.y), V3(w.z, 1, -w.x), V3(-w.y, w.x, 1))
        }
        let k = w * (1 / theta), c = cos(theta), s = sin(theta), v = 1 - c
        return Matrix3(rows: V3(c + k.x * k.x * v, k.x * k.y * v - k.z * s, k.x * k.z * v + k.y * s),
                       V3(k.y * k.x * v + k.z * s, c + k.y * k.y * v, k.y * k.z * v - k.x * s),
                       V3(k.z * k.x * v - k.y * s, k.z * k.y * v + k.x * s, c + k.z * k.z * v))
    }

    var values: [Double] { [r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z] }
    var c0: V3 { V3(r0.x, r1.x, r2.x) }
    var c1: V3 { V3(r0.y, r1.y, r2.y) }
    var c2: V3 { V3(r0.z, r1.z, r2.z) }
    var transpose: Matrix3 { Matrix3(rows: c0, c1, c2) }
    var determinant: Double { r0.dot(r1.cross(r2)) }
    /// The quaternion of a rotation matrix.
    var quat: Quat { Quat(basisX: c0, y: c1, z: c2).normalized }

    static func * (m: Matrix3, v: V3) -> V3 { V3(m.r0.dot(v), m.r1.dot(v), m.r2.dot(v)) }

    static func * (a: Matrix3, b: Matrix3) -> Matrix3 {
        let bc0 = b.c0, bc1 = b.c1, bc2 = b.c2
        return Matrix3(rows: V3(a.r0.dot(bc0), a.r0.dot(bc1), a.r0.dot(bc2)),
                       V3(a.r1.dot(bc0), a.r1.dot(bc1), a.r1.dot(bc2)),
                       V3(a.r2.dot(bc0), a.r2.dot(bc1), a.r2.dot(bc2)))
    }

    static func * (m: Matrix3, s: Double) -> Matrix3 { Matrix3(rows: m.r0 * s, m.r1 * s, m.r2 * s) }

    var inverse: Matrix3? {
        let det = determinant
        guard abs(det) > 1e-300 else { return nil }
        // Rows of the inverse are the cross products of the columns, divided by the determinant.
        let a = c0, b = c1, c = c2
        return Matrix3(rows: b.cross(c) * (1 / det), c.cross(a) * (1 / det), a.cross(b) * (1 / det))
    }
}

enum LinearAlgebra {
    /// Eigen-decomposition of a symmetric n x n matrix (row-major) by cyclic Jacobi rotations. Eigenvalues ascend;
    /// `vectors[i]` is the unit eigenvector of `values[i]`.
    static func symmetricEigen(_ matrix: [Double], n: Int, maxSweeps: Int = 80) -> (values: [Double], vectors: [[Double]]) {
        var a = matrix
        var v = [Double](repeating: 0, count: n * n)
        for i in 0..<n { v[i * n + i] = 1 }
        var scale = 0.0
        for x in a { scale += x * x }
        let tolerance = max(scale, 1e-300) * 1e-30
        for _ in 0..<maxSweeps {
            var off = 0.0
            for p in 0..<n { for q in 0..<n where q != p { off += a[p * n + q] * a[p * n + q] } }
            if off <= tolerance { break }
            for p in 0..<(n - 1) {
                for q in (p + 1)..<n {
                    let apq = a[p * n + q]
                    if abs(apq) < 1e-300 { continue }
                    let theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
                    let t = (theta >= 0 ? 1.0 : -1.0) / (abs(theta) + (theta * theta + 1).squareRoot())
                    let c = 1 / (t * t + 1).squareRoot(), s = t * c
                    for k in 0..<n {
                        let akp = a[k * n + p], akq = a[k * n + q]
                        a[k * n + p] = c * akp - s * akq
                        a[k * n + q] = s * akp + c * akq
                    }
                    for k in 0..<n {
                        let apk = a[p * n + k], aqk = a[q * n + k]
                        a[p * n + k] = c * apk - s * aqk
                        a[q * n + k] = s * apk + c * aqk
                    }
                    for k in 0..<n {
                        let vkp = v[k * n + p], vkq = v[k * n + q]
                        v[k * n + p] = c * vkp - s * vkq
                        v[k * n + q] = s * vkp + c * vkq
                    }
                }
            }
        }
        let order = (0..<n).sorted { a[$0 * n + $0] < a[$1 * n + $1] }
        return (order.map { a[$0 * n + $0] }, order.map { j in (0..<n).map { v[$0 * n + j] } })
    }

    /// The rotation nearest to m in the Frobenius norm (polar decomposition through the eigenvectors of m^T m).
    static func nearestRotation(_ m: Matrix3) -> Matrix3 {
        let mtm = m.transpose * m
        let (_, vectors) = symmetricEigen(mtm.values, n: 3)
        // Descending singular values: v1 is the last eigenvector.
        let v1 = V3(vectors[2][0], vectors[2][1], vectors[2][2])
        let v2 = V3(vectors[1][0], vectors[1][1], vectors[1][2])
        let v3 = V3(vectors[0][0], vectors[0][1], vectors[0][2])
        var u1 = m * v1
        if u1.length < 1e-15 { return .identity }
        u1 = u1.normalized
        var u2 = m * v2
        u2 = u2 - u1 * u1.dot(u2)
        if u2.length < 1e-12 {
            // Rank one: any unit vector perpendicular to u1.
            u2 = abs(u1.x) < 0.9 ? V3(1, 0, 0).cross(u1) : V3(0, 1, 0).cross(u1)
        }
        u2 = u2.normalized
        let detV = v1.dot(v2.cross(v3))
        let u3 = u1.cross(u2) * (detV >= 0 ? 1 : -1)
        // R = sum u_i v_i^T.
        func outer(_ a: V3, _ b: V3) -> Matrix3 { Matrix3(rows: b * a.x, b * a.y, b * a.z) }
        let r = [outer(u1, v1), outer(u2, v2), outer(u3, v3)]
        return Matrix3(rows: r[0].r0 + r[1].r0 + r[2].r0, r[0].r1 + r[1].r1 + r[2].r1, r[0].r2 + r[1].r2 + r[2].r2)
    }

    /// Solves A x = b for a square n x n system (row-major) by Gaussian elimination with partial pivoting.
    static func solve(_ matrix: [Double], _ rhs: [Double], n: Int) -> [Double]? {
        var a = matrix, b = rhs
        var scale = 0.0
        for x in a { scale = max(scale, abs(x)) }
        guard scale > 0 else { return nil }
        for col in 0..<n {
            var pivot = col
            for r in (col + 1)..<max(n, col + 1) where abs(a[r * n + col]) > abs(a[pivot * n + col]) { pivot = r }
            guard abs(a[pivot * n + col]) > scale * 1e-15 else { return nil }
            if pivot != col {
                for k in 0..<n { a.swapAt(col * n + k, pivot * n + k) }
                b.swapAt(col, pivot)
            }
            let d = a[col * n + col]
            for r in (col + 1)..<max(n, col + 1) {
                let f = a[r * n + col] / d
                if f == 0 { continue }
                for k in col..<n { a[r * n + k] -= f * a[col * n + k] }
                b[r] -= f * b[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = b[r]
            for k in (r + 1)..<max(n, r + 1) { s -= a[r * n + k] * x[k] }
            x[r] = s / a[r * n + r]
        }
        return x.allSatisfy(\.isFinite) ? x : nil
    }

    /// Least squares for an over-determined system given as rows (normal equations, n unknowns).
    static func leastSquares(rows: [[Double]], rhs: [Double], n: Int) -> [Double]? {
        var ata = [Double](repeating: 0, count: n * n), atb = [Double](repeating: 0, count: n)
        for (row, y) in zip(rows, rhs) {
            for i in 0..<n {
                atb[i] += row[i] * y
                for j in 0..<n { ata[i * n + j] += row[i] * row[j] }
            }
        }
        return solve(ata, atb, n: n)
    }
}

/// Levenberg-Marquardt least squares with a central-difference Jacobian and Marquardt's diagonal scaling.
enum LevenbergMarquardt {
    struct Result {
        var x: [Double]
        /// Sum of squared residuals at x.
        var cost: Double
        var iterations: Int
    }

    /// Minimises |r(x)|^2. `residuals` returns nil for an invalid x (treated as infinitely bad); `steps` are the
    /// finite-difference steps per parameter; `clamp` keeps parameters in their valid range after each step.
    static func minimize(_ x0: [Double], steps: [Double], maxIterations: Int = 60, tolerance: Double = 1e-12,
                         clamp: (([Double]) -> [Double])? = nil, residuals: ([Double]) -> [Double]?) -> Result? {
        let n = x0.count
        var x = clamp?(x0) ?? x0
        guard var r = residuals(x) else { return nil }
        var cost = r.reduce(0) { $0 + $1 * $1 }
        var mu = 1e-3
        var iterations = 0
        for _ in 0..<maxIterations {
            iterations += 1
            let m = r.count
            // Jacobian, column by column.
            var jac = [Double](repeating: 0, count: m * n)
            for j in 0..<n {
                var xp = x, xm = x
                xp[j] += steps[j]
                xm[j] -= steps[j]
                if let rp = residuals(xp), let rm = residuals(xm), rp.count == m, rm.count == m {
                    for i in 0..<m { jac[i * n + j] = (rp[i] - rm[i]) / (2 * steps[j]) }
                } else if let rp = residuals(xp), rp.count == m {
                    for i in 0..<m { jac[i * n + j] = (rp[i] - r[i]) / steps[j] }
                } else if let rm = residuals(xm), rm.count == m {
                    for i in 0..<m { jac[i * n + j] = (r[i] - rm[i]) / steps[j] }
                }
            }
            var jtj = [Double](repeating: 0, count: n * n), jtr = [Double](repeating: 0, count: n)
            for i in 0..<m {
                let base = i * n
                for a in 0..<n {
                    let ja = jac[base + a]
                    if ja == 0 { continue }
                    jtr[a] += ja * r[i]
                    for b in a..<n { jtj[a * n + b] += ja * jac[base + b] }
                }
            }
            for a in 0..<n { for b in 0..<a { jtj[a * n + b] = jtj[b * n + a] } }
            var improved = false
            for _ in 0..<12 {
                var damped = jtj
                for a in 0..<n { damped[a * n + a] += mu * max(jtj[a * n + a], 1e-12) }
                guard let delta = LinearAlgebra.solve(damped, jtr.map { -$0 }, n: n) else { mu *= 10; continue }
                var xn = zip(x, delta).map { $0 + $1 }
                if let clamp { xn = clamp(xn) }
                if let rn = residuals(xn) {
                    let cn = rn.reduce(0) { $0 + $1 * $1 }
                    if cn < cost {
                        let gain = cost - cn
                        x = xn
                        r = rn
                        cost = cn
                        mu = max(mu / 3, 1e-12)
                        improved = true
                        if gain <= tolerance * max(cost, 1e-300) { return Result(x: x, cost: cost, iterations: iterations) }
                        break
                    }
                }
                mu *= 4
            }
            if !improved { break }
        }
        return Result(x: x, cost: cost, iterations: iterations)
    }
}

/// Optimal assignment (Kuhn-Munkres with potentials, O(n^2 m)).
enum Hungarian {
    /// The column assigned to each row minimising the total cost, nil for rows left over when there are more rows than
    /// columns. Costs must be finite; use a large value for forbidden pairs and filter them afterwards.
    static func solve(_ cost: [[Double]]) -> [Int?] {
        let rows = cost.count
        guard rows > 0, let cols = cost.first?.count, cols > 0 else { return [Int?](repeating: nil, count: rows) }
        if rows > cols {
            // Transpose so that rows <= columns.
            let t = (0..<cols).map { c in (0..<rows).map { cost[$0][c] } }
            let colToRow = solve(t)
            var out = [Int?](repeating: nil, count: rows)
            for (c, r) in colToRow.enumerated() { if let r { out[r] = c } }
            return out
        }
        let n = rows, m = cols
        var u = [Double](repeating: 0, count: n + 1), v = [Double](repeating: 0, count: m + 1)
        var p = [Int](repeating: 0, count: m + 1), way = [Int](repeating: 0, count: m + 1)
        for i in 1...n {
            p[0] = i
            var j0 = 0
            var minv = [Double](repeating: .infinity, count: m + 1)
            var used = [Bool](repeating: false, count: m + 1)
            repeat {
                used[j0] = true
                let i0 = p[j0]
                var delta = Double.infinity, j1 = 0
                for j in 1...m where !used[j] {
                    let cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j] { minv[j] = cur; way[j] = j0 }
                    if minv[j] < delta { delta = minv[j]; j1 = j }
                }
                for j in 0...m {
                    if used[j] { u[p[j]] += delta; v[j] -= delta } else { minv[j] -= delta }
                }
                j0 = j1
            } while p[j0] != 0
            repeat {
                let j1 = way[j0]
                p[j0] = p[j1]
                j0 = j1
            } while j0 != 0
        }
        var out = [Int?](repeating: nil, count: n)
        for j in 1...m where p[j] != 0 { out[p[j] - 1] = j - 1 }
        return out
    }
}

extension Double {
    /// The angle wrapped into (-pi, pi].
    var wrappedAngle: Double {
        var a = truncatingRemainder(dividingBy: 2 * .pi)
        if a <= -.pi { a += 2 * .pi }
        if a > .pi { a -= 2 * .pi }
        return a
    }
}
