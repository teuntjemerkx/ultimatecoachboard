import Foundation

/// Any camera of the board as a pose (Sections 3.2 and 5.1): eye position, orientation and field of view. The orbit
/// camera, the top-down view and a player's POV all reduce to this, so the renderer has one path and every
/// transition (dolly-zoom, fly-in) is an interpolation between poses.
public struct CameraPose: Hashable, Sendable {
    public var eye: V3
    /// Camera to world: the camera looks along its -Z, up is +Y, right is +X.
    public var rotation: Quat
    public var fovY: Double
    /// Near plane of the reversed-Z infinite projection (5.1: 0.04 m in POV).
    public var near: Double

    public init(eye: V3, rotation: Quat, fovY: Double, near: Double) {
        self.eye = eye
        self.rotation = rotation.normalized
        self.fovY = fovY
        self.near = near
    }

    /// A pose looking along `forward`, with `up` as the up hint (made perpendicular).
    public init(eye: V3, forward: V3, up: V3, fovY: Double, near: Double) {
        let back = (-forward).normalized
        var right = up.cross(back).normalized
        if right.length < 0.5 { right = V3(1, 0, 0).cross(back).normalized }
        let u = back.cross(right)
        self.init(eye: eye, rotation: Quat(basisX: right, y: u, z: back), fovY: fovY, near: near)
    }

    public var forward: V3 { rotation.rotate(V3(0, 0, -1)) }
    public var up: V3 { rotation.rotate(V3(0, 1, 0)) }
    public var right: V3 { rotation.rotate(V3(1, 0, 0)) }

    public var view: Mat4 { Mat4.lookAt(eye: eye, target: eye + forward, up: up) }

    public func projection(aspect: Double) -> Mat4 { Mat4.perspectiveReversedZ(fovY: fovY, aspect: aspect, near: near) }

    public func viewProjection(aspect: Double) -> Mat4 { projection(aspect: aspect) * view }

    /// The ray through a point in normalized device coordinates (x, y in -1...1, y up).
    public func ray(ndcX: Double, ndcY: Double, aspect: Double) -> (origin: V3, direction: V3) {
        let h = tan(fovY / 2)
        return (eye, (forward + right * (ndcX * h * aspect) + up * (ndcY * h)).normalized)
    }

    /// The touch ray intersected with the floor (Section 3.5.2), or nil when it does not point down.
    public func floorPoint(ndcX: Double, ndcY: Double, aspect: Double) -> FloorPoint? {
        let r = ray(ndcX: ndcX, ndcY: ndcY, aspect: aspect)
        guard r.direction.y < -1e-9 else { return nil }
        return (r.origin + r.direction * (-r.origin.y / r.direction.y)).floor
    }

    /// A world point in normalized device coordinates; nil behind the camera. Depth is reversed (1 at the near plane).
    public func project(_ p: V3, aspect: Double) -> (x: Double, y: Double, depth: Double)? {
        let c = viewProjection(aspect: aspect).apply(p)
        guard c.3 > 1e-9 else { return nil }
        return (c.0 / c.3, c.1 / c.3, c.2 / c.3)
    }

    /// The fly-in of Section 5.1: the eye follows a quadratic Bezier whose control point is raised `lift` metres
    /// above the midpoint (so it never passes through bodies or the net), orientation slerps, the field of view
    /// eases. `t` is already eased by the caller.
    public static func flight(from a: CameraPose, to b: CameraPose, t: Double, lift: Double = 1.0) -> CameraPose {
        let t = max(0, min(1, t))
        if t == 0 { return a }
        if t == 1 { return b }
        let control = (a.eye + b.eye) * 0.5 + V3(0, lift, 0)
        let s = 1 - t
        let eye = a.eye * (s * s) + control * (2 * s * t) + b.eye * (t * t)
        return CameraPose(eye: eye, rotation: a.rotation.slerp(to: b.rotation, t),
                          fovY: exp(log(a.fovY) * s + log(b.fovY) * t), near: min(a.near, b.near))
    }

    /// Flight time: at least 0.5 s, longer when the turn would exceed 240 degrees per second.
    public static func flightDuration(from a: CameraPose, to b: CameraPose) -> Double {
        let c = min(1, abs(a.rotation.dot(b.rotation)))
        let angle = 2 * acos(c)
        return max(0.5, angle / (240 * .pi / 180))
    }
}

extension Quat {
    /// The rotation whose columns are the orthonormal basis x, y, z (Shepperd's method).
    public init(basisX x: V3, y: V3, z: V3) {
        let m00 = x.x, m10 = x.y, m20 = x.z
        let m01 = y.x, m11 = y.y, m21 = y.z
        let m02 = z.x, m12 = z.y, m22 = z.z
        let trace = m00 + m11 + m22
        if trace > 0 {
            let s = (trace + 1).squareRoot() * 2
            self.init(x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s, w: 0.25 * s)
        } else if m00 > m11 && m00 > m22 {
            let s = (1 + m00 - m11 - m22).squareRoot() * 2
            self.init(x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s, w: (m21 - m12) / s)
        } else if m11 > m22 {
            let s = (1 + m11 - m00 - m22).squareRoot() * 2
            self.init(x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s, w: (m02 - m20) / s)
        } else {
            let s = (1 + m22 - m00 - m11).squareRoot() * 2
            self.init(x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s, w: (m10 - m01) / s)
        }
    }
}

extension Mat4 {
    /// Reversed-Z perspective with an infinite far plane (Section 5.1): the near plane maps to depth 1 and
    /// infinity to 0, so precision is uniform from a player's own hands to the far end line. Depth test "greater".
    public static func perspectiveReversedZ(fovY: Double, aspect: Double, near: Double) -> Mat4 {
        let ys = 1 / tan(fovY / 2), xs = ys / aspect
        return Mat4([xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, 0, -1, 0, 0, near, 0])
    }
}

extension BoardCamera {
    /// This orbit camera as a pose.
    public var pose: CameraPose {
        CameraPose(eye: eye, forward: (target - eye).normalized, up: upVector, fovY: fovY, near: depthRange.near)
    }
}

extension SkeletonModel {
    /// Head-locked POV (Section 5.1): the eye of the posed skeleton looking along the head's forward direction,
    /// horizon levelled, 90 degrees horizontal field of view at the given aspect. Free-look adds yaw and pitch
    /// relative to the head, limited to the neck's range (yaw +-70, pitch -50...+60 degrees).
    public func povPose(_ posed: [Rigid], aspect: Double, fovX: Double = .pi / 2, yaw: Double = 0, pitch: Double = 0) -> CameraPose {
        let head = posed[Joint.head.rawValue].rotation
        var forward = head.rotate(V3(0, 0, 1))
        let yaw = max(-70, min(70, yaw * 180 / .pi)) * .pi / 180
        let pitch = max(-50, min(60, pitch * 180 / .pi)) * .pi / 180
        forward = Quat(axis: .up, angle: yaw).rotate(forward)
        let side = forward.cross(.up).normalized
        if side.length > 0.5 { forward = Quat(axis: side, angle: pitch).rotate(forward) }
        let fovY = 2 * atan(tan(fovX / 2) / aspect)
        return CameraPose(eye: eye(posed), forward: forward.normalized, up: .up, fovY: fovY, near: 0.04)
    }
}
