import Foundation

/// The board camera (Sections 3.1 and 3.2): an orbit around a target on the floor. The 2D blueprint view is the
/// same camera looking straight down with a very narrow field of view, so 2D and 3D share one renderer and the
/// transition between them is a dolly-zoom.
public struct BoardCamera: Hashable, Sendable {
    /// Point on the floor the camera looks at.
    public var target: V3
    /// Horizontal direction from the target toward the eye, radians from world +X toward +Z.
    /// 0 = the home bench view (eye at +X, home half on the left of the screen).
    public var heading: Double
    /// Elevation of the eye above the floor plane, radians (pi/2 = straight down).
    public var pitch: Double
    public var distance: Double
    public var fovY: Double

    public init(target: V3 = .zero, heading: Double = 0, pitch: Double = .pi / 2, distance: Double, fovY: Double) {
        self.target = target
        self.heading = heading
        self.pitch = pitch
        self.distance = distance
        self.fovY = fovY
    }

    var horizontal: V3 { V3(cos(heading), 0, sin(heading)) }

    public var eye: V3 { target + (horizontal * cos(pitch) + V3.up * sin(pitch)) * distance }

    /// The camera's up vector, perpendicular to the view direction; straight down it points away from the viewer's side.
    public var upVector: V3 { (horizontal * -sin(pitch) + V3.up * cos(pitch)).normalized }

    public var view: Mat4 { Mat4.lookAt(eye: eye, target: target, up: upVector) }

    /// Near and far planes bracketing the court and its surroundings at this distance.
    public var depthRange: (near: Double, far: Double) { (max(0.05, distance - 40), distance + 40) }

    public func projection(aspect: Double) -> Mat4 {
        Mat4.perspective(fovY: fovY, aspect: aspect, near: depthRange.near, far: depthRange.far)
    }

    public func viewProjection(aspect: Double) -> Mat4 { projection(aspect: aspect) * view }

    /// Height of the visible region in the plane through the target, perpendicular to the view direction.
    public var visibleHeight: Double { 2 * distance * tan(fovY / 2) }

    /// The ray through a point in normalized device coordinates (x, y in -1...1, y up).
    public func ray(ndcX: Double, ndcY: Double, aspect: Double) -> (origin: V3, direction: V3) {
        let forward = (target - eye).normalized
        let up = upVector
        let right = forward.cross(up).normalized
        let h = tan(fovY / 2)
        let dir = (forward + right * (ndcX * h * aspect) + up * (ndcY * h)).normalized
        return (eye, dir)
    }

    /// Section 3.5.2: the touch ray intersected with the floor, t* = -o_y / u_y (only when the ray points down).
    public func floorPoint(ndcX: Double, ndcY: Double, aspect: Double) -> FloorPoint? {
        let r = ray(ndcX: ndcX, ndcY: ndcY, aspect: aspect)
        guard r.direction.y < -1e-9 else { return nil }
        let t = -r.origin.y / r.direction.y
        return (r.origin + r.direction * t).floor
    }

    /// Projects a world point to normalized device coordinates (x, y in -1...1, y up); nil behind the camera.
    public func project(_ p: V3, aspect: Double) -> (x: Double, y: Double, depth: Double)? {
        let c = viewProjection(aspect: aspect).apply(p)
        guard c.3 > 1e-9 else { return nil }
        return (c.0 / c.3, c.1 / c.3, c.2 / c.3)
    }

    // MARK: - Presets

    /// The 2D view as a camera: straight down, a 1 degree field of view (practically orthographic), framing
    /// `courtWidth` x `courtHeight` metres. `homeOnLeft` matches the 2D sideline-true orientation.
    public static func topDown(aspect: Double, homeOnLeft: Bool = true, frameLength: Double = 22.8, frameWidth: Double = 13.8) -> BoardCamera {
        let fov = 1.0 * Double.pi / 180
        // Screen width shows the court length (Z); screen height the width (X).
        let neededHeight = max(frameWidth, frameLength / aspect)
        return BoardCamera(heading: homeOnLeft ? 0 : .pi, pitch: .pi / 2, distance: neededHeight / (2 * tan(fov / 2)), fovY: fov)
    }

    /// The default 3D view from the home bench: 32 degrees above the floor, 45 degree field of view.
    public static func bench(aspect: Double, homeOnLeft: Bool = true) -> BoardCamera {
        let fov = 45.0 * Double.pi / 180
        let pitch = 32.0 * Double.pi / 180
        // Frame the court length across the screen width.
        let width = 21.0, height = width / aspect
        let distance = max(height, 9 / 0.9) / (2 * tan(fov / 2)) * 1.05
        return BoardCamera(heading: homeOnLeft ? 0 : .pi, pitch: pitch, distance: distance, fovY: fov)
    }

    /// The 2D <-> 3D dolly-zoom (Section 3.2): the field of view and the pose interpolate while the distance
    /// keeps the visible height through the target constant, so the court does not jump in size.
    /// `t` is already eased (critically damped) by the caller.
    public static func dollyZoom(from a: BoardCamera, to b: BoardCamera, t: Double) -> BoardCamera {
        let t = max(0, min(1, t))
        if t == 0 { return a }
        if t == 1 { return b }
        let fov = exp(log(a.fovY) * (1 - t) + log(b.fovY) * t)
        let visible = a.visibleHeight * (1 - t) + b.visibleHeight * t
        var dh = b.heading - a.heading
        dh = atan2(sin(dh), cos(dh))
        return BoardCamera(target: a.target + (b.target - a.target) * t,
                           heading: a.heading + dh * t,
                           pitch: a.pitch + (b.pitch - a.pitch) * t,
                           distance: visible / (2 * tan(fov / 2)),
                           fovY: fov)
    }

    /// Orbit and dolly from touch gestures: heading and pitch in radians, distance scaled; pitch stays between
    /// 8 degrees and straight down.
    public func orbited(dHeading: Double, dPitch: Double, zoom: Double) -> BoardCamera {
        var c = self
        c.heading += dHeading
        c.pitch = max(8 * .pi / 180, min(.pi / 2, pitch + dPitch))
        c.distance = max(4, min(80, distance / max(zoom, 0.05)))
        return c
    }
}

/// Critically damped easing for camera moves (Section 1.6): x(t) = 1 - (1 + w t) e^(-w t), normalized to reach 1.
public func criticallyDamped(_ t: Double, omega: Double = 9) -> Double {
    let t = max(0, min(1, t))
    let raw = 1 - (1 + omega * t) * exp(-omega * t)
    let end = 1 - (1 + omega) * exp(-omega)
    return raw / end
}
