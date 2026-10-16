import Foundation

/// Small, dependency-free 3D math in Double so the domain core builds and is tested on Linux as well.
/// World frame (blueprint Section 0): metres, Y up, the floor at y = 0; court X across, Z along (home Z > 0).
public struct V3: Hashable, Codable, Sendable {
    public var x: Double, y: Double, z: Double

    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x; self.y = y; self.z = z
    }

    public static let zero = V3(0, 0, 0)
    public static let up = V3(0, 1, 0)

    public static func + (a: V3, b: V3) -> V3 { V3(a.x + b.x, a.y + b.y, a.z + b.z) }
    public static func - (a: V3, b: V3) -> V3 { V3(a.x - b.x, a.y - b.y, a.z - b.z) }
    public static func * (a: V3, s: Double) -> V3 { V3(a.x * s, a.y * s, a.z * s) }
    public static func * (s: Double, a: V3) -> V3 { a * s }
    public static prefix func - (a: V3) -> V3 { V3(-a.x, -a.y, -a.z) }

    public func dot(_ b: V3) -> Double { x * b.x + y * b.y + z * b.z }
    public func cross(_ b: V3) -> V3 { V3(y * b.z - z * b.y, z * b.x - x * b.z, x * b.y - y * b.x) }
    public var length: Double { dot(self).squareRoot() }
    public var normalized: V3 { let l = length; return l > 0 ? self * (1 / l) : self }

    public init(_ p: FloorPoint, y: Double = 0) { self.init(p.x, y, p.z) }
    public var floor: FloorPoint { FloorPoint(x: x, z: z) }
}

/// Unit quaternion for rotations (x, y, z vector part, w scalar).
public struct Quat: Hashable, Codable, Sendable {
    public var x: Double, y: Double, z: Double, w: Double

    public init(x: Double, y: Double, z: Double, w: Double) {
        self.x = x; self.y = y; self.z = z; self.w = w
    }

    public static let identity = Quat(x: 0, y: 0, z: 0, w: 1)

    public init(axis: V3, angle: Double) {
        let a = axis.normalized, s = sin(angle / 2)
        self.init(x: a.x * s, y: a.y * s, z: a.z * s, w: cos(angle / 2))
    }

    public static func * (a: Quat, b: Quat) -> Quat {
        Quat(x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
             y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
             z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
             w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z)
    }

    public static func * (q: Quat, s: Double) -> Quat { Quat(x: q.x * s, y: q.y * s, z: q.z * s, w: q.w * s) }
    public static func + (a: Quat, b: Quat) -> Quat { Quat(x: a.x + b.x, y: a.y + b.y, z: a.z + b.z, w: a.w + b.w) }

    public var conjugate: Quat { Quat(x: -x, y: -y, z: -z, w: w) }
    public func dot(_ b: Quat) -> Double { x * b.x + y * b.y + z * b.z + w * b.w }
    public var norm: Double { dot(self).squareRoot() }
    public var normalized: Quat { let n = norm; return n > 0 ? self * (1 / n) : .identity }

    public func rotate(_ v: V3) -> V3 {
        let u = V3(x, y, z)
        let t = 2 * u.cross(v)
        return v + w * t + u.cross(t)
    }

    /// Spherical interpolation along the shortest arc.
    public func slerp(to b: Quat, _ t: Double) -> Quat {
        var b = b
        var c = dot(b)
        if c < 0 { b = b * -1; c = -c }
        if c > 0.9995 { return (self * (1 - t) + b * t).normalized }
        let theta = acos(min(1, c))
        let s = sin(theta)
        return (self * (sin((1 - t) * theta) / s) + b * (sin(t * theta) / s)).normalized
    }
}

/// A rotation followed by a translation.
public struct Rigid: Hashable, Sendable {
    public var rotation: Quat
    public var translation: V3

    public init(rotation: Quat = .identity, translation: V3 = .zero) {
        self.rotation = rotation
        self.translation = translation
    }

    public static let identity = Rigid()

    public func apply(_ p: V3) -> V3 { rotation.rotate(p) + translation }

    /// self ∘ other: apply `other` first.
    public static func * (a: Rigid, b: Rigid) -> Rigid {
        Rigid(rotation: (a.rotation * b.rotation).normalized, translation: a.apply(b.translation))
    }

    public var inverse: Rigid {
        let r = rotation.conjugate
        return Rigid(rotation: r, translation: -(r.rotate(translation)))
    }
}

/// Unit dual quaternion for skinning (Kavan et al.): blending rotations and translations without the
/// candy-wrapper collapse of linear blend skinning.
public struct DualQuat: Hashable, Sendable {
    public var real: Quat
    public var dual: Quat

    public init(real: Quat, dual: Quat) {
        self.real = real
        self.dual = dual
    }

    public init(_ r: Rigid) {
        real = r.rotation.normalized
        let t = Quat(x: r.translation.x, y: r.translation.y, z: r.translation.z, w: 0)
        dual = (t * real) * 0.5
    }

    public var rigid: Rigid {
        let n = real.norm
        let r = real * (1 / n), d = dual * (1 / n)
        let t = (d * 2) * r.conjugate
        return Rigid(rotation: r, translation: V3(t.x, t.y, t.z))
    }

    public func transform(_ p: V3) -> V3 { rigid.apply(p) }

    /// Weighted blend with antipodality correction, then normalization (DLB).
    public static func blend(_ items: [(DualQuat, Double)]) -> DualQuat {
        guard let pivot = items.first?.0.real else { return DualQuat(Rigid.identity) }
        var r = Quat(x: 0, y: 0, z: 0, w: 0), d = Quat(x: 0, y: 0, z: 0, w: 0)
        for (q, w) in items {
            let s = pivot.dot(q.real) < 0 ? -w : w
            r = r + q.real * s
            d = d + q.dual * s
        }
        let n = r.norm
        return DualQuat(real: r * (1 / n), dual: d * (1 / n))
    }
}

/// Column-major 4 x 4 matrix (Metal's convention), clip-space depth in 0...1.
public struct Mat4: Hashable, Sendable {
    public var m: [Double]      // 16 values, column-major

    public init(_ m: [Double]) {
        precondition(m.count == 16)
        self.m = m
    }

    public static let identity = Mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

    public subscript(row: Int, col: Int) -> Double {
        get { m[col * 4 + row] }
        set { m[col * 4 + row] = newValue }
    }

    public static func * (a: Mat4, b: Mat4) -> Mat4 {
        var out = [Double](repeating: 0, count: 16)
        for c in 0..<4 {
            for r in 0..<4 {
                var s = 0.0
                for k in 0..<4 { s += a.m[k * 4 + r] * b.m[c * 4 + k] }
                out[c * 4 + r] = s
            }
        }
        return Mat4(out)
    }

    /// Transforms a point and returns (x, y, z, w) before the perspective divide.
    public func apply(_ p: V3, w: Double = 1) -> (Double, Double, Double, Double) {
        let v = [p.x, p.y, p.z, w]
        var o = [0.0, 0, 0, 0]
        for r in 0..<4 { for k in 0..<4 { o[r] += m[k * 4 + r] * v[k] } }
        return (o[0], o[1], o[2], o[3])
    }

    /// Perspective for Metal: right-handed view space looking down -Z, depth 0 at near and 1 at far.
    public static func perspective(fovY: Double, aspect: Double, near: Double, far: Double) -> Mat4 {
        let ys = 1 / tan(fovY / 2), xs = ys / aspect, zs = far / (near - far)
        return Mat4([xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, zs, -1, 0, 0, zs * near, 0])
    }

    public static func lookAt(eye: V3, target: V3, up: V3) -> Mat4 {
        let z = (eye - target).normalized
        let x = up.cross(z).normalized
        let y = z.cross(x)
        return Mat4([x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0,
                     -x.dot(eye), -y.dot(eye), -z.dot(eye), 1])
    }

    /// General inverse (cofactor expansion).
    public var inverse: Mat4? {
        let a = m
        var inv = [Double](repeating: 0, count: 16)
        inv[0] = a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10]
        inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10]
        inv[8] = a[4]*a[9]*a[15] - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9]
        inv[12] = -a[4]*a[9]*a[14] + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9]
        inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10]
        inv[5] = a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10]
        inv[9] = -a[0]*a[9]*a[15] + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9]
        inv[13] = a[0]*a[9]*a[14] - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9]
        inv[2] = a[1]*a[6]*a[15] - a[1]*a[7]*a[14] - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7] - a[13]*a[3]*a[6]
        inv[6] = -a[0]*a[6]*a[15] + a[0]*a[7]*a[14] + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7] + a[12]*a[3]*a[6]
        inv[10] = a[0]*a[5]*a[15] - a[0]*a[7]*a[13] - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7] - a[12]*a[3]*a[5]
        inv[14] = -a[0]*a[5]*a[14] + a[0]*a[6]*a[13] + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6] + a[12]*a[2]*a[5]
        inv[3] = -a[1]*a[6]*a[11] + a[1]*a[7]*a[10] + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7] + a[9]*a[3]*a[6]
        inv[7] = a[0]*a[6]*a[11] - a[0]*a[7]*a[10] - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7] - a[8]*a[3]*a[6]
        inv[11] = -a[0]*a[5]*a[11] + a[0]*a[7]*a[9] + a[4]*a[1]*a[11] - a[4]*a[3]*a[9] - a[8]*a[1]*a[7] + a[8]*a[3]*a[5]
        inv[15] = a[0]*a[5]*a[10] - a[0]*a[6]*a[9] - a[4]*a[1]*a[10] + a[4]*a[2]*a[9] + a[8]*a[1]*a[6] - a[8]*a[2]*a[5]
        let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12]
        guard abs(det) > 1e-18 else { return nil }
        return Mat4(inv.map { $0 / det })
    }
}
