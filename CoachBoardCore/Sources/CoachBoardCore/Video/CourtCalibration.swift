import Foundation

/// The phone camera of a rally video (Section 4.1): an ideal pinhole with square pixels, no skew and the principal
/// point at the image centre. Internally the computer-vision convention: camera +Z looks forward, +X is image right,
/// +Y image down. Pixels have their origin at the top-left corner.
///
/// A world point P projects to `u = f x / z + width / 2`, `v = f y / z + height / 2` with `(x, y, z) = R (P - C)`.
public struct VideoCamera: Hashable, Codable, Sendable {
    /// Focal length in pixels.
    public var focalLength: Double
    /// Image size in pixels.
    public var width: Double
    public var height: Double
    /// World to camera rotation R (computer-vision axes: x right, y down, z forward).
    public var rotation: Quat
    /// Camera centre C in world metres.
    public var center: V3

    public init(focalLength: Double, width: Double, height: Double, rotation: Quat, center: V3) {
        self.focalLength = focalLength
        self.width = width
        self.height = height
        self.rotation = rotation.normalized
        self.center = center
    }

    /// A camera at `center` looking at `target` with the image upright (world +Y up), then rolled about its optical
    /// axis by `roll` radians (positive turns the picture counter-clockwise).
    public init(center: V3, lookAt target: V3, focalLength: Double, width: Double, height: Double, roll: Double = 0) {
        let f = (target - center).normalized
        var r = f.cross(.up)
        if r.length < 1e-9 { r = V3(1, 0, 0) }
        r = r.normalized
        var d = f.cross(r)
        if roll != 0 {
            let (c, s) = (cos(roll), sin(roll))
            (r, d) = (r * c + d * s, d * c - r * s)
        }
        self.init(focalLength: focalLength, width: width, height: height,
                  rotation: Matrix3(rows: r, d, f).quat, center: center)
    }

    var matrix: Matrix3 { Matrix3(rotation) }

    /// The principal point (image centre).
    public var principalPoint: ImagePoint { ImagePoint(width / 2, height / 2) }

    /// Vertical and horizontal fields of view in radians.
    public var fovY: Double { 2 * atan(height / (2 * focalLength)) }
    public var fovX: Double { 2 * atan(width / (2 * focalLength)) }

    /// The optical axis in world coordinates.
    public var forward: V3 { rotation.conjugate.rotate(V3(0, 0, 1)) }

    /// Camera coordinates (x right, y down, z forward) of a world point.
    public func cameraCoordinates(_ p: V3) -> V3 { rotation.rotate(p - center) }

    /// The pixel of a world point, or nil when it is behind (or within 1 mm of) the camera. The pixel may lie outside
    /// the image; see `contains(_:)`.
    public func project(_ p: V3) -> ImagePoint? {
        let c = cameraCoordinates(p)
        guard c.z > 1e-3 else { return nil }
        return ImagePoint(focalLength * c.x / c.z + width / 2, focalLength * c.y / c.z + height / 2)
    }

    /// Whether a pixel lies inside the image, shrunk by `margin` pixels on each side.
    public func contains(_ px: ImagePoint, margin: Double = 0) -> Bool {
        px.x >= margin && px.y >= margin && px.x <= width - margin && px.y <= height - margin
    }

    /// The viewing ray through a pixel: from the camera centre, unit direction in world coordinates.
    public func ray(through px: ImagePoint) -> (origin: V3, direction: V3) {
        let d = V3((px.x - width / 2) / focalLength, (px.y - height / 2) / focalLength, 1)
        return (center, rotation.conjugate.rotate(d).normalized)
    }

    /// The floor point seen at a pixel: the viewing ray intersected with the horizontal plane y = `height`
    /// (0 for the floor, about 0.08 for an ankle). Nil when the ray does not reach that plane in front of the camera.
    public func floorPoint(_ px: ImagePoint, height h: Double = 0) -> FloorPoint? {
        let r = ray(through: px)
        guard abs(r.direction.y) > 1e-9 else { return nil }
        let t = (h - r.origin.y) / r.direction.y
        guard t > 1e-6 else { return nil }
        return (r.origin + r.direction * t).floor
    }

    /// The height at which the pixel's viewing ray passes closest to the vertical line through `floor`: how high
    /// above that floor point the pixel's body part is (jump height, stature). Nil for a ray parallel to the line or
    /// meeting it behind the camera.
    public func height(of px: ImagePoint, above floor: FloorPoint) -> Double? {
        let r = ray(through: px)
        let w0 = r.origin - V3(floor, y: 0)
        let b = r.direction.y
        let denom = 1 - b * b
        guard denom > 1e-9 else { return nil }
        let dw = r.direction.dot(w0), ew = w0.y
        let t = (b * ew - dw) / denom
        guard t > 0 else { return nil }
        return (ew - b * dw) / denom
    }

    /// The same camera as a renderer pose (camera to world, looking along -Z with +Y up), vertical field of view
    /// 2 atan(h / 2f), near plane 0.05 m. Rendering with aspect width / height reproduces the video's projection.
    public var cameraPose: CameraPose {
        let inv = rotation.conjugate
        let right = inv.rotate(V3(1, 0, 0)), up = inv.rotate(V3(0, -1, 0)), back = inv.rotate(V3(0, 0, -1))
        return CameraPose(eye: center, rotation: Quat(basisX: right, y: up, z: back), fovY: fovY, near: 0.05)
    }

    /// Root-mean-square reprojection error in pixels; infinity when a point is behind the camera.
    public func reprojectionRMS(_ points: [CalibrationPoint]) -> Double {
        guard !points.isEmpty else { return 0 }
        var sum = 0.0
        for p in points {
            guard let q = project(p.world) else { return .infinity }
            let dx = q.x - p.image.x, dy = q.y - p.image.y
            sum += dx * dx + dy * dy
        }
        return (sum / Double(points.count)).squareRoot()
    }
}

/// Named court marks with known world positions (Section 4.1). Left and right are as seen by the home team facing
/// the net: left is -X, right is +X, on both halves (so `opponentEndLeft` is the far corner on the home team's left).
public enum CourtLandmark: String, CaseIterable, Codable, Sendable {
    case homeEndLeft, homeEndRight, opponentEndLeft, opponentEndRight
    /// Where the centre line meets the sidelines (under the net).
    case centerLineLeft, centerLineRight
    /// Attack-line ends, 3 m from the net.
    case homeAttackLeft, homeAttackRight, opponentAttackLeft, opponentAttackRight
    /// Top of the net tape at the antennas.
    case netTapeLeft, netTapeRight
    /// Antenna tops, 0.8 m above the tape.
    case antennaTopLeft, antennaTopRight

    /// World position in metres for a net height (2.43 men, 2.24 women).
    public func world(netHeight: Double = 2.43) -> V3 {
        let side: Double
        switch self {
        case .homeEndLeft, .opponentEndLeft, .centerLineLeft, .homeAttackLeft, .opponentAttackLeft, .netTapeLeft, .antennaTopLeft:
            side = -CourtFrame.halfWidth
        default:
            side = CourtFrame.halfWidth
        }
        switch self {
        case .homeEndLeft, .homeEndRight: return V3(side, 0, 9)
        case .opponentEndLeft, .opponentEndRight: return V3(side, 0, -9)
        case .centerLineLeft, .centerLineRight: return V3(side, 0, 0)
        case .homeAttackLeft, .homeAttackRight: return V3(side, 0, 3)
        case .opponentAttackLeft, .opponentAttackRight: return V3(side, 0, -3)
        case .netTapeLeft, .netTapeRight: return V3(side, netHeight, 0)
        case .antennaTopLeft, .antennaTopRight: return V3(side, netHeight + 0.8, 0)
        }
    }

    public var isOnFloor: Bool {
        switch self {
        case .netTapeLeft, .netTapeRight, .antennaTopLeft, .antennaTopRight: return false
        default: return true
        }
    }
}

/// A world point and the pixel where it is seen.
public struct CalibrationPoint: Hashable, Codable, Sendable {
    public var world: V3
    public var image: ImagePoint

    public init(world: V3, image: ImagePoint) {
        self.world = world
        self.image = image
    }

    public init(_ landmark: CourtLandmark, image: ImagePoint, netHeight: Double = 2.43) {
        self.init(world: landmark.world(netHeight: netHeight), image: image)
    }
}

/// How far a calibration can be trusted.
public enum CalibrationQuality: String, Codable, Sendable, Hashable {
    /// Below 2 px RMS at 1080p, camera 0.5-25 m above the floor, vertical field of view 15-120 degrees.
    case good
    /// Usable with care: below 6 px RMS at 1080p and a plausible camera.
    case rough
    case failed
}

public struct CalibrationResult: Hashable, Codable, Sendable {
    public var camera: VideoCamera
    /// Reprojection error over the input points, pixels.
    public var rmsError: Double
    public var quality: CalibrationQuality
    /// The landmark assignment used, when a wrapper had to choose between left/right orders.
    public var points: [CalibrationPoint]
    /// Relative disagreement of the two closed-form focal estimates from the homography (nil if one was unusable).
    public var focalDisagreement: Double?
}

/// Camera calibration from court marks (Section 4.1): homography by normalised DLT, focal length and pose from the
/// homography, then Levenberg-Marquardt over (f, rotation, centre) on every point including off-floor marks.
public enum CourtCalibration {
    /// iPhone main camera, 26 mm equivalent: f is about 0.72 of the image's long side.
    public static func defaultFocal(width: Double, height: Double) -> Double { 0.72 * max(width, height) }

    // MARK: Homography

    /// The plane homography H mapping floor coordinates (X, Z, 1) to pixels (u, v, 1), up to scale, by
    /// Hartley-normalised DLT: the eigenvector of the smallest eigenvalue of A^T A. Needs >= 4 points, no three
    /// collinear. Returned row-major (9 values) normalised to unit Frobenius norm.
    public static func homography(floor: [FloorPoint], image: [ImagePoint]) -> [Double]? {
        guard floor.count >= 4, floor.count == image.count else { return nil }
        func normaliser(_ p: [(Double, Double)]) -> Matrix3? {
            let n = Double(p.count)
            let mx = p.reduce(0) { $0 + $1.0 } / n, my = p.reduce(0) { $0 + $1.1 } / n
            let mean = p.reduce(0) { $0 + hypot($1.0 - mx, $1.1 - my) } / n
            guard mean > 1e-12 else { return nil }
            let s = 2.0.squareRoot() / mean
            return Matrix3(rows: V3(s, 0, -s * mx), V3(0, s, -s * my), V3(0, 0, 1))
        }
        guard let ts = normaliser(floor.map { ($0.x, $0.z) }), let td = normaliser(image.map { ($0.x, $0.y) }),
              let tdInv = td.inverse else { return nil }
        var ata = [Double](repeating: 0, count: 81)
        for (w, px) in zip(floor, image) {
            let s = ts * V3(w.x, w.z, 1), d = td * V3(px.x, px.y, 1)
            let (x, y, u, v) = (s.x, s.y, d.x, d.y)
            let rows: [[Double]] = [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]]
            for row in rows {
                for i in 0..<9 where row[i] != 0 { for j in 0..<9 { ata[i * 9 + j] += row[i] * row[j] } }
            }
        }
        let (values, vectors) = LinearAlgebra.symmetricEigen(ata, n: 9)
        // Degenerate (three collinear points or duplicates): a second near-null direction.
        guard values.count == 9, values[1] > 1e-9 * max(values[8], 1e-300) else { return nil }
        let hn = Matrix3(vectors[0])
        let h = tdInv * hn * ts
        let norm = h.values.reduce(0) { $0 + $1 * $1 }.squareRoot()
        guard norm > 0, norm.isFinite else { return nil }
        return (h * (1 / norm)).values
    }

    /// The two closed-form focal estimates of a homography in centred pixel coordinates (K = diag(f, f, 1)):
    /// r_X perpendicular to r_Z, and |r_X| = |r_Z|. Each comes with a weight (its conditioning, 0 when unusable).
    static func focalEstimates(_ hc: Matrix3, prior: Double) -> [(f: Double, weight: Double)] {
        let h1 = hc.c0, h2 = hc.c1
        // Conditioning from the directions with the prior focal: a_z, b_z are the optical-axis components of the
        // court axes; both near zero means the floor is seen face-on and f is not observable from it.
        let a = V3(h1.x / prior, h1.y / prior, h1.z).normalized, b = V3(h2.x / prior, h2.y / prior, h2.z).normalized
        var out: [(Double, Double)] = []
        let den1 = h1.z * h2.z
        let w1 = (a.z * b.z) * (a.z * b.z)
        if abs(den1) > 1e-300, w1 > 1e-4 {
            let f2 = -(h1.x * h2.x + h1.y * h2.y) / den1
            if f2 > 0 { out.append((f2.squareRoot(), w1)) }
        }
        let den2 = h2.z * h2.z - h1.z * h1.z
        let w2 = (b.z * b.z - a.z * a.z) * (b.z * b.z - a.z * a.z)
        if abs(den2) > 1e-300, w2 > 1e-4 {
            let f2 = (h1.x * h1.x + h1.y * h1.y - h2.x * h2.x - h2.y * h2.y) / den2
            if f2 > 0 { out.append((f2.squareRoot(), w2)) }
        }
        return out
    }

    /// Rotation and centre from a centred homography and a focal length: lambda = 2 / (|K^-1 h1| + |K^-1 h2|),
    /// r_X = lambda K^-1 h1, r_Z = lambda K^-1 h2, r_Y = r_Z x r_X, t = lambda K^-1 h3, R projected onto the nearest
    /// rotation, C = -R^T t. The sign of lambda puts the floor points in front of the camera; nil when they straddle
    /// it or the camera ends up below the floor.
    static func pose(_ hc: Matrix3, focal f: Double, floor: [FloorPoint]) -> (r: Matrix3, c: V3)? {
        let a = V3(hc.c0.x / f, hc.c0.y / f, hc.c0.z), b = V3(hc.c1.x / f, hc.c1.y / f, hc.c1.z)
        let c = V3(hc.c2.x / f, hc.c2.y / f, hc.c2.z)
        let na = a.length, nb = b.length
        guard na > 1e-300, nb > 1e-300 else { return nil }
        var lambda = 2 / (na + nb)
        let depths = floor.map { (a * $0.x + b * $0.z + c).z * lambda }
        let positive = depths.filter { $0 > 0 }.count
        if positive == 0 { lambda = -lambda } else if positive != depths.count { return nil }
        let rX = a * lambda, rZ = b * lambda, t = c * lambda
        let rY = rZ.cross(rX)
        let r = LinearAlgebra.nearestRotation(Matrix3(columns: rX, rY, rZ))
        let center = -(r.transpose * t)
        guard center.y > 0 else { return nil }
        return (r, center)
    }

    // MARK: Refinement

    /// Levenberg-Marquardt over (f, three small-angle rotation parameters applied in the camera frame, C) on the
    /// reprojection error of every point, with a weak log-focal prior that only matters when f is unobservable.
    static func refine(_ camera: VideoCamera, points: [CalibrationPoint], focalPrior: Double, priorWeight: Double) -> VideoCamera? {
        let r0 = camera.matrix
        let scale = max(1, camera.center.length)
        func make(_ x: [Double]) -> VideoCamera {
            let r = Matrix3.rotation(V3(x[1], x[2], x[3])) * r0
            return VideoCamera(focalLength: x[0], width: camera.width, height: camera.height, rotation: r.quat,
                               center: V3(x[4], x[5], x[6]))
        }
        let x0 = [camera.focalLength, 0, 0, 0, camera.center.x, camera.center.y, camera.center.z]
        let steps = [camera.focalLength * 1e-6, 1e-7, 1e-7, 1e-7, 1e-6 * scale, 1e-6 * scale, 1e-6 * scale]
        let minF = 0.05 * max(camera.width, camera.height)
        let result = LevenbergMarquardt.minimize(x0, steps: steps, maxIterations: 100, tolerance: 1e-14,
                                                 clamp: { x in var x = x; x[0] = max(minF, x[0]); return x }) { x in
            let cam = make(x)
            var r: [Double] = []
            r.reserveCapacity(points.count * 2 + 1)
            for p in points {
                let c = cam.cameraCoordinates(p.world)
                guard c.z > 1e-3 else { return nil }
                r.append(cam.focalLength * c.x / c.z + cam.width / 2 - p.image.x)
                r.append(cam.focalLength * c.y / c.z + cam.height / 2 - p.image.y)
            }
            r.append(priorWeight * log(cam.focalLength / focalPrior))
            return r
        }
        return result.map { make($0.x) }
    }

    // MARK: Solving

    /// A camera from labelled points: at least four on the floor (y = 0, no three collinear); off-floor points such as
    /// the net tape ends join the refinement and break the remaining ambiguity. Nil when no camera explains the
    /// floor points (they straddle the camera, or it would sit below the floor).
    public static func solve(points: [CalibrationPoint], imageWidth: Double, imageHeight: Double,
                             focalPrior: Double? = nil) -> CalibrationResult? {
        let floor = points.filter { abs($0.world.y) < 1e-6 }
        guard floor.count >= 4, imageWidth > 0, imageHeight > 0 else { return nil }
        guard let hv = homography(floor: floor.map(\.world.floor), image: floor.map(\.image)) else { return nil }
        let center = Matrix3(rows: V3(1, 0, -imageWidth / 2), V3(0, 1, -imageHeight / 2), V3(0, 0, 1))
        let hc = center * Matrix3(hv)
        let prior = focalPrior ?? defaultFocal(width: imageWidth, height: imageHeight)
        let estimates = focalEstimates(hc, prior: prior)
        var disagreement: Double?
        if estimates.count == 2 {
            disagreement = abs(estimates[0].f - estimates[1].f) / ((estimates[0].f + estimates[1].f) / 2)
        }
        // Inverse-variance combination of f^2; the prior when neither estimate is usable.
        var starts: [Double] = []
        if !estimates.isEmpty {
            let wsum = estimates.reduce(0) { $0 + $1.weight }
            starts.append((estimates.reduce(0) { $0 + $1.weight * $1.f * $1.f } / wsum).squareRoot())
            if estimates.count == 2 { starts += estimates.map(\.f) }
        }
        starts.append(prior)
        let longSide = max(imageWidth, imageHeight)
        var best: CalibrationResult?
        for f0 in starts where f0 > 0.05 * longSide && f0 < 50 * longSide {
            guard let (r, c) = pose(hc, focal: f0, floor: floor.map(\.world.floor)) else { continue }
            let initial = VideoCamera(focalLength: f0, width: imageWidth, height: imageHeight, rotation: r.quat, center: c)
            guard let cam = refine(initial, points: points, focalPrior: prior, priorWeight: focalPrior == nil ? 0.3 : 3) else { continue }
            let rms = cam.reprojectionRMS(points)
            guard rms.isFinite, cam.center.y > 0 else { continue }
            if best == nil || rms < best!.rmsError - 1e-9 {
                best = CalibrationResult(camera: cam, rmsError: rms, quality: quality(cam, rms: rms), points: points,
                                         focalDisagreement: disagreement)
            }
        }
        return best
    }

    /// Quality thresholds scaled to 1080p by the image's short side.
    public static func quality(_ cam: VideoCamera, rms: Double) -> CalibrationQuality {
        let scale = min(cam.width, cam.height) / 1080
        let fov = cam.fovY * 180 / .pi, h = cam.center.y
        if rms < 2 * scale && (0.5...25).contains(h) && (15...120).contains(fov) { return .good }
        if rms < 6 * scale && (0.2...40).contains(h) && (8...150).contains(fov) { return .rough }
        return .failed
    }

    /// The coach's four dots: the two corners of our (home) end line and the two of their (opponent) end line, each pair
    /// in either left/right order. All four assignments are tried; the one with a camera above the floor in front of
    /// all points, consistent focal estimates, a plausible field of view and the lowest error wins. `extra` points
    /// (e.g. net tape ends) join every candidate.
    public static func solveCorners(ourEnd: [ImagePoint], theirEnd: [ImagePoint], imageWidth: Double, imageHeight: Double,
                                    focalPrior: Double? = nil, netHeight: Double = 2.43,
                                    extra: [CalibrationPoint] = []) -> CalibrationResult? {
        solvePairs(ourEnd, (.homeEndLeft, .homeEndRight), theirEnd, (.opponentEndLeft, .opponentEndRight),
                   imageWidth: imageWidth, imageHeight: imageHeight, focalPrior: focalPrior, netHeight: netHeight, extra: extra)
    }

    /// One half only: its two end-line corners and the two points where the net meets the sidelines on the floor (the
    /// centre-line ends), each pair in either left/right order.
    public static func solveNearHalf(endLine: [ImagePoint], netLine: [ImagePoint], half: Side, imageWidth: Double,
                                     imageHeight: Double, focalPrior: Double? = nil, netHeight: Double = 2.43,
                                     extra: [CalibrationPoint] = []) -> CalibrationResult? {
        let end: (CourtLandmark, CourtLandmark) = half == .home ? (.homeEndLeft, .homeEndRight) : (.opponentEndLeft, .opponentEndRight)
        return solvePairs(endLine, end, netLine, (.centerLineLeft, .centerLineRight), imageWidth: imageWidth,
                          imageHeight: imageHeight, focalPrior: focalPrior, netHeight: netHeight, extra: extra)
    }

    static func solvePairs(_ a: [ImagePoint], _ la: (CourtLandmark, CourtLandmark), _ b: [ImagePoint],
                           _ lb: (CourtLandmark, CourtLandmark), imageWidth: Double, imageHeight: Double,
                           focalPrior: Double?, netHeight: Double, extra: [CalibrationPoint]) -> CalibrationResult? {
        guard a.count == 2, b.count == 2 else { return nil }
        var best: (score: Double, result: CalibrationResult)?
        for swapA in [false, true] {
            for swapB in [false, true] {
                let pa = swapA ? [a[1], a[0]] : a, pb = swapB ? [b[1], b[0]] : b
                let points = [CalibrationPoint(la.0, image: pa[0], netHeight: netHeight),
                              CalibrationPoint(la.1, image: pa[1], netHeight: netHeight),
                              CalibrationPoint(lb.0, image: pb[0], netHeight: netHeight),
                              CalibrationPoint(lb.1, image: pb[1], netHeight: netHeight)] + extra
                guard let r = solve(points: points, imageWidth: imageWidth, imageHeight: imageHeight, focalPrior: focalPrior) else { continue }
                let scale = min(imageWidth, imageHeight) / 1080
                var score = r.rmsError / scale
                if let d = r.focalDisagreement, d > 0.25 { score += 20 * (d - 0.25) }
                let fov = r.camera.fovY * 180 / .pi
                if !(15...120).contains(fov) { score += 10 }
                if r.quality == .failed { score += 100 }
                if best == nil || score < best!.score { best = (score, r) }
            }
        }
        return best?.result
    }
}
