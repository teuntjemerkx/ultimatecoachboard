import XCTest
@testable import CoachBoardCore

// Synthetic data for the video-to-3D tests: cameras, noise, players, keypoints, ball flights.

fileprivate extension SplitMix64 {
    /// Uniform in [0, 1).
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func uniform(_ a: Double, _ b: Double) -> Double { a + (b - a) * unit() }
    /// Standard normal (Box-Muller).
    mutating func gaussian() -> Double {
        let u = max(unit(), 1e-12), v = unit()
        return (-2 * log(u)).squareRoot() * cos(2 * .pi * v)
    }
    mutating func chance(_ p: Double) -> Bool { unit() < p }
}

fileprivate enum Synth {
    /// High in the stands behind the home end line.
    static let stands = VideoCamera(center: V3(1.5, 8, 21), lookAt: V3(0, 0, -1), focalLength: 1500, width: 1920, height: 1080)
    /// On the left sideline (home view), 3 m up.
    static let sideline = VideoCamera(center: V3(-15, 3, 1), lookAt: V3(0, 0.5, 0), focalLength: 950, width: 1920, height: 1080)
    /// A low tripod behind the home end line.
    static let tripod = VideoCamera(center: V3(0.8, 1.5, 15), lookAt: V3(0, 0.8, 0), focalLength: 1000, width: 1920, height: 1080)

    static func noisy(_ p: ImagePoint, _ rng: inout SplitMix64, _ amplitude: Double) -> ImagePoint {
        ImagePoint(p.x + rng.uniform(-amplitude, amplitude), p.y + rng.uniform(-amplitude, amplitude))
    }

    static func landmarks(_ cam: VideoCamera, _ rng: inout SplitMix64, noise: Double, _ list: [CourtLandmark] = CourtLandmark.allCases) -> [CalibrationPoint] {
        list.map { l in CalibrationPoint(l, image: noisy(cam.project(l.world())!, &rng, noise)) }
    }

    /// The Vision keypoints of a posed player seen by a camera, with pixel noise, dropped joints and confidences.
    /// `jump` lifts the body on top of the posture's own jump; `totalJump` replaces it.
    static func keypoints(_ s: SkeletonModel, _ posture: Posture, at p: FloorPoint, yaw: Double, jump: Double = 0,
                          totalJump: Double? = nil, camera: VideoCamera, _ rng: inout SplitMix64, noise: Double = 3,
                          drop: Double = 0.1, role: String = "") -> [BodyKeypoint: Keypoint2D] {
        var params = posture.params(for: s, role: role)
        if let totalJump { params.jump = totalJump }
        let posed = s.pose(params, position: p, facing: yaw, jump: jump)
        let points = s.keypoints(posed)
        var out: [BodyKeypoint: Keypoint2D] = [:]
        // In a fixed order: dictionary order changes from run to run and would reshuffle the noise.
        for k in BodyKeypoint.allCases where !rng.chance(drop) {
            guard let px = camera.project(points[k]!) else { continue }
            out[k] = Keypoint2D(point: ImagePoint(px.x + noise * rng.gaussian(), px.y + noise * rng.gaussian()),
                                confidence: rng.uniform(0.4, 1))
        }
        return out
    }
}

final class MathVideoTests: XCTestCase {
    func testJacobiEigenAndNearestRotation() {
        var rng = SplitMix64(seed: 1)
        // A random symmetric 9 x 9 matrix: A v = lambda v for every pair, values ascending.
        var a = [Double](repeating: 0, count: 81)
        for i in 0..<9 { for j in i..<9 { let x = rng.uniform(-1, 1); a[i * 9 + j] = x; a[j * 9 + i] = x } }
        let (values, vectors) = LinearAlgebra.symmetricEigen(a, n: 9)
        XCTAssertEqual(values, values.sorted())
        for (lambda, v) in zip(values, vectors) {
            for i in 0..<9 {
                let av = (0..<9).reduce(0) { $0 + a[i * 9 + $1] * v[$1] }
                XCTAssertEqual(av, lambda * v[i], accuracy: 1e-9)
            }
        }
        // A rotation perturbed by noise projects back onto a nearby proper rotation; a reflection is fixed too.
        let r = Matrix3.rotation(V3(0.3, -1.1, 0.7))
        let noisy = Matrix3(rows: r.r0 + V3(0.01, -0.02, 0), r.r1 + V3(0, 0.015, 0.01), r.r2 * 1.05)
        let p = LinearAlgebra.nearestRotation(noisy)
        XCTAssertEqual(p.determinant, 1, accuracy: 1e-9)
        XCTAssertEqual((p.transpose * p).r0.x, 1, accuracy: 1e-9)
        XCTAssertLessThan((p.r0 - r.r0).length + (p.r1 - r.r1).length + (p.r2 - r.r2).length, 0.05)
        let flipped = LinearAlgebra.nearestRotation(Matrix3(rows: r.r0, r.r1, -r.r2))
        XCTAssertEqual(flipped.determinant, 1, accuracy: 1e-9)
    }

    func testHungarianMatchesBruteForce() {
        var rng = SplitMix64(seed: 2)
        func permutations(_ n: Int) -> [[Int]] {
            if n == 1 { return [[0]] }
            return permutations(n - 1).flatMap { p in (0...p.count).map { i in var q = p; q.insert(n - 1, at: i); return q } }
        }
        for trial in 0..<40 {
            let rows = 2 + trial % 4, cols = 2 + (trial / 4) % 4
            let cost = (0..<rows).map { _ in (0..<cols).map { _ in rng.uniform(0, 10) } }
            let a = Hungarian.solve(cost)
            var total = 0.0
            for (r, c) in a.enumerated() { if let c { total += cost[r][c] } }
            XCTAssertEqual(a.compactMap { $0 }.count, min(rows, cols))
            XCTAssertEqual(Set(a.compactMap { $0 }).count, min(rows, cols), "a column is used once")
            // Brute force over assignments of the smaller side.
            let n = max(rows, cols)
            var best = Double.infinity
            for p in permutations(n) {
                var s = 0.0
                for r in 0..<rows where p[r] < cols { s += cost[r][p[r]] }
                best = min(best, s)
            }
            XCTAssertEqual(total, best, accuracy: 1e-9)
        }
    }

    func testLevenbergMarquardtFitsRosenbrock() {
        let r = LevenbergMarquardt.minimize([-1.2, 1], steps: [1e-7, 1e-7], maxIterations: 200) { x in
            [10 * (x[1] - x[0] * x[0]), 1 - x[0]]
        }
        XCTAssertEqual(r!.x[0], 1, accuracy: 1e-6)
        XCTAssertEqual(r!.x[1], 1, accuracy: 1e-6)
    }
}

final class CalibrationVideoTests: XCTestCase {
    func testCameraProjectionRaysAndRendererPose() throws {
        let cam = Synth.stands
        let p = V3(2, 1.3, 4)
        let px = try XCTUnwrap(cam.project(p))
        // The ray through the pixel passes through the point; the floor point under a floor point is itself.
        let ray = cam.ray(through: px)
        let t = (p - ray.origin).dot(ray.direction)
        XCTAssertLessThan((ray.origin + ray.direction * t - p).length, 1e-9)
        let fp = try XCTUnwrap(cam.floorPoint(cam.project(V3(-3, 0, 6))!))
        XCTAssertEqual(fp.x, -3, accuracy: 1e-9)
        XCTAssertEqual(fp.z, 6, accuracy: 1e-9)
        let ankle = try XCTUnwrap(cam.floorPoint(cam.project(V3(1, 0.08, 2))!, height: 0.08))
        XCTAssertEqual(ankle.x, 1, accuracy: 1e-9)
        // Height above a floor point: a head at 1.85 m above (2, 4) reads 1.85.
        XCTAssertEqual(try XCTUnwrap(cam.height(of: cam.project(V3(2, 1.85, 4))!, above: FloorPoint(x: 2, z: 4))), 1.85, accuracy: 1e-9)
        XCTAssertNil(cam.project(V3(0, 8, 30)), "behind the camera")
        // The renderer pose reproduces the projection (NDC y up, aspect = width / height).
        let pose = cam.cameraPose
        let ndc = try XCTUnwrap(pose.project(p, aspect: cam.width / cam.height))
        XCTAssertEqual(ndc.x, (px.x - cam.width / 2) / (cam.width / 2), accuracy: 1e-9)
        XCTAssertEqual(ndc.y, -(px.y - cam.height / 2) / (cam.height / 2), accuracy: 1e-9)
        XCTAssertEqual(pose.fovY, 2 * atan(1080 / 3000.0), accuracy: 1e-12)
        XCTAssertEqual(pose.near, 0.05)
        XCTAssertGreaterThan(pose.up.y, 0.8)
        // Every landmark of the synthetic cameras is in frame.
        for c in [Synth.stands, Synth.sideline, Synth.tripod] {
            for l in CourtLandmark.allCases { XCTAssertTrue(c.contains(try XCTUnwrap(c.project(l.world())), margin: 10), "\(l)") }
        }
    }

    func testHomographyMapsTheFloor() throws {
        let cam = Synth.sideline
        let floor = CourtLandmark.allCases.filter(\.isOnFloor).map { $0.world() }
        let h = try XCTUnwrap(CourtCalibration.homography(floor: floor.map(\.floor), image: floor.map { cam.project($0)! }))
        let m = Matrix3(h)
        for p in [V3(1, 0, 2), V3(-4, 0, -7), V3(3.3, 0, 8)] {
            let q = m * V3(p.x, p.z, 1), px = cam.project(p)!
            XCTAssertEqual(q.x / q.z, px.x, accuracy: 1e-6)
            XCTAssertEqual(q.y / q.z, px.y, accuracy: 1e-6)
        }
        // Three collinear points and a duplicate cannot define it.
        let line = [FloorPoint(x: 0, z: 0), FloorPoint(x: 1, z: 0), FloorPoint(x: 2, z: 0), FloorPoint(x: 2, z: 0)]
        XCTAssertNil(CourtCalibration.homography(floor: line, image: line.map { cam.project(V3($0))! }))
    }

    /// Mark positions with +-1 px noise recover the camera of three typical set-ups.
    func testRecoversSyntheticCameras() throws {
        var rng = SplitMix64(seed: 3)
        let setups: [(String, VideoCamera, (FloorPoint) -> Bool)] = [
            ("stands", Synth.stands, { $0.z >= 0 }),
            ("sideline", Synth.sideline, { $0.x <= 0 }),
            ("tripod", Synth.tripod, { $0.z >= 0 }),
        ]
        for (name, truth, near) in setups {
            for trial in 0..<5 {
                let points = Synth.landmarks(truth, &rng, noise: 1)
                let r = try XCTUnwrap(CourtCalibration.solve(points: points, imageWidth: 1920, imageHeight: 1080), name)
                XCTAssertEqual(r.quality, .good, "\(name) \(trial)")
                XCTAssertLessThan(r.rmsError, 1.2, name)
                XCTAssertEqual(r.camera.focalLength / truth.focalLength, 1, accuracy: 0.03, "\(name) focal")
                XCTAssertLessThan((r.camera.center - truth.center).length, 0.3, "\(name) centre")
                // Floor back-projection in the near half.
                var worst = 0.0, sum = 0.0, count = 0.0
                for x in stride(from: -4.5, through: 4.5, by: 1.5) {
                    for z in stride(from: -9.0, through: 9, by: 1.5) where near(FloorPoint(x: x, z: z)) {
                        let px = truth.project(V3(x, 0, z))!
                        let fp = try XCTUnwrap(r.camera.floorPoint(px))
                        let e = hypot(fp.x - x, fp.z - z)
                        worst = max(worst, e)
                        sum += e * e
                        count += 1
                    }
                }
                XCTAssertLessThan((sum / count).squareRoot(), 0.05, "\(name) near floor error")
                XCTAssertLessThan(worst, 0.08, "\(name) worst near floor error")
            }
        }
    }

    /// The coach's four dots, pairs in any left/right order.
    func testFourCornersInAnyOrder() throws {
        var rng = SplitMix64(seed: 4)
        for truth in [Synth.stands, Synth.sideline, Synth.tripod] {
            func px(_ l: CourtLandmark) -> ImagePoint { Synth.noisy(truth.project(l.world())!, &rng, 1) }
            let ours = [px(.homeEndLeft), px(.homeEndRight)], theirs = [px(.opponentEndLeft), px(.opponentEndRight)]
            for (a, b) in [(ours, theirs), (ours.reversed(), theirs), (ours, theirs.reversed()), (ours.reversed(), theirs.reversed())] {
                let r = try XCTUnwrap(CourtCalibration.solveCorners(ourEnd: Array(a), theirEnd: Array(b), imageWidth: 1920, imageHeight: 1080))
                XCTAssertNotEqual(r.quality, .failed)
                XCTAssertEqual(r.camera.focalLength / truth.focalLength, 1, accuracy: 0.06)
                XCTAssertLessThan((r.camera.center - truth.center).length, 0.6)
                // The chosen assignment puts the home-left corner where the true one is.
                XCTAssertLessThan(r.points[0].image.distance(to: truth.project(CourtLandmark.homeEndLeft.world())!), 2)
            }
            // Near half only: end-line corners and the centre-line ends.
            let end = [px(.homeEndRight), px(.homeEndLeft)], net = [px(.centerLineLeft), px(.centerLineRight)]
            let r = try XCTUnwrap(CourtCalibration.solveNearHalf(endLine: end, netLine: net, half: .home, imageWidth: 1920, imageHeight: 1080))
            XCTAssertNotEqual(r.quality, .failed)
            XCTAssertLessThan((r.camera.center - truth.center).length, 1.0)
        }
    }

    func testNonsenseInputFails() {
        // One dot inside the triangle of the other three: no camera sees a rectangle like that.
        let r1 = CourtCalibration.solveCorners(ourEnd: [ImagePoint(200, 900), ImagePoint(1700, 900)],
                                               theirEnd: [ImagePoint(950, 200), ImagePoint(950, 700)], imageWidth: 1920, imageHeight: 1080)
        XCTAssertTrue(r1 == nil || r1!.quality == .failed)
        // All on one line.
        XCTAssertNil(CourtCalibration.solveCorners(ourEnd: [ImagePoint(100, 500), ImagePoint(500, 500)],
                                                   theirEnd: [ImagePoint(900, 500), ImagePoint(1300, 500)], imageWidth: 1920, imageHeight: 1080))
        XCTAssertNil(CourtCalibration.solve(points: [], imageWidth: 1920, imageHeight: 1080))
    }
}

/// Twelve synthetic players moving smoothly on their halves (up to 5 m/s), two home players crossing paths.
fileprivate struct SyntheticRally {
    struct Player {
        var side: Side
        var base: FloorPoint
        var waves: [(ax: Double, az: Double, w: Double, phase: Double)]
        var line: (from: FloorPoint, to: FloorPoint)?

        func position(_ t: Double, duration: Double) -> FloorPoint {
            if let line {
                let u = t / duration
                return FloorPoint(x: line.from.x + (line.to.x - line.from.x) * u, z: line.from.z + (line.to.z - line.from.z) * u)
            }
            var p = base
            for w in waves {
                p.x += w.ax * sin(w.w * t + w.phase)
                p.z += w.az * sin(w.w * t + w.phase * 1.7)
            }
            return p
        }

        func speed(_ t: Double, duration: Double) -> Double {
            let a = position(t - 0.001, duration: duration), b = position(t + 0.001, duration: duration)
            return hypot(b.x - a.x, b.z - a.z) / 0.002
        }
    }

    var players: [Player] = []
    let duration: Double

    init(duration: Double, seed: UInt64) {
        self.duration = duration
        var rng = SplitMix64(seed: seed)
        let home = [FloorPoint(x: 3, z: 7), FloorPoint(x: 3, z: 1.5), FloorPoint(x: 0, z: 2), FloorPoint(x: -3, z: 1.5),
                    FloorPoint(x: -3, z: 7), FloorPoint(x: 0, z: 6.5)]
        for side in Side.allCases {
            // The crossing pair first, so the wanderers keep clear of them too.
            for i in [0, 4, 1, 2, 3, 5] {
                let b = home[i]
                let base = side == .home ? b : FloorPoint(x: -b.x, z: -b.z)
                var p = Player(side: side, base: base, waves: [])
                if side == .home && (i == 0 || i == 4) {
                    // P1 and P5 run straight across each other's path.
                    let z = 5.0
                    p.line = i == 0 ? (FloorPoint(x: 3.2, z: z - 0.3), FloorPoint(x: -3.2, z: z + 0.3))
                                    : (FloorPoint(x: -3.2, z: z), FloorPoint(x: 3.2, z: z))
                } else {
                    // Smooth wandering that peaks at 2.5 to 5 m/s, stays on the player's half and keeps 0.6 m from the
                    // others (bodies do not overlap).
                    repeat {
                        p.waves = (0..<2).map { _ in (rng.uniform(-1.2, 1.2), rng.uniform(-1.0, 1.0), rng.uniform(0.8, 2.2), rng.uniform(0, 6.28)) }
                        let top = stride(from: 0.0, through: duration, by: 0.02).map { p.speed($0, duration: duration) }.max()!
                        let k = rng.uniform(2.5, 5) / top
                        p.waves = p.waves.map { ($0.ax * k, $0.az * k, $0.w, $0.phase) }
                    } while stride(from: 0.0, through: duration, by: 0.02).contains { t in
                        let q = p.position(t, duration: duration)
                        let d = side == .home ? q.z : -q.z
                        let crowded = players.contains { o in
                            let r = o.position(t, duration: duration)
                            return o.side == side && hypot(r.x - q.x, r.z - q.z) < 0.6
                        }
                        return abs(q.x) > 4.3 || d < 0.6 || d > 8.8 || crowded
                    }
                }
                players.append(p)
            }
        }
    }

    /// Frame times at about `fps` with up to 15% jitter.
    static func times(duration: Double, fps: Double, _ rng: inout SplitMix64) -> [Double] {
        var t = 0.0, out: [Double] = []
        while t <= duration + 1e-9 {
            out.append(t)
            t += (1 / fps) * rng.uniform(0.85, 1.15)
        }
        return out
    }
}

final class TrackingVideoTests: XCTestCase {
    func testTracksTwelvePlayersWithoutIdentitySwitches() throws {
        for seed in [22, 23, 24, 25] as [UInt64] { try trackRally(seed: seed) }
    }

    func trackRally(seed: UInt64) throws {
        var rng = SplitMix64(seed: seed * 7)
        let rally = SyntheticRally(duration: 4, seed: seed)
        let times = SyntheticRally.times(duration: rally.duration, fps: 15, &rng)
        var frames: [VideoFrameObservation] = []
        for t in times {
            var dets: [PersonDetection] = []
            for p in rally.players where !rng.chance(0.1) {
                let q = p.position(t, duration: rally.duration)
                let m = FloorPoint(x: q.x + rng.uniform(-0.1, 0.1), z: q.z + rng.uniform(-0.1, 0.1))
                dets.append(PersonDetection(floor: m, footImage: ImagePoint(0, 0), confidence: rng.uniform(0.5, 1)))
            }
            // Off court: the bench, a line judge, spectators; now and then a one-frame ghost on court.
            for _ in 0..<2 {
                let x = rng.chance(0.5) ? rng.uniform(7, 10) : rng.uniform(-10, -7)
                dets.append(PersonDetection(floor: FloorPoint(x: x, z: rng.uniform(-12, 12)), footImage: ImagePoint(0, 0)))
            }
            dets.append(PersonDetection(floor: FloorPoint(x: rng.uniform(-3, 3), z: rng.chance(0.5) ? 12.5 : -12.5), footImage: ImagePoint(0, 0)))
            if rng.chance(0.05) {
                dets.append(PersonDetection(floor: FloorPoint(x: rng.uniform(-4, 4), z: rng.uniform(-8, 8)), footImage: ImagePoint(0, 0)))
            }
            frames.append(VideoFrameObservation(time: t, detections: dets.shuffled(using: &rng)))
        }
        let tracks = PlayerTracker().track(frames)
        XCTAssertEqual(tracks.filter { $0.side == .home }.count, 6, "seed \(seed)")
        XCTAssertEqual(tracks.filter { $0.side == .opponent }.count, 6, "seed \(seed)")
        var owner: [Int] = []
        var errors: [Double] = []
        for tr in tracks {
            // The true player this track follows (nearest on average), and its error against that player throughout.
            func meanError(_ i: Int) -> Double {
                tr.samples.reduce(0.0) { s, x in
                    let q = rally.players[i].position(x.time, duration: rally.duration)
                    return s + hypot(q.x - x.floor.x, q.z - x.floor.z)
                }
            }
            let best = rally.players.indices.min { meanError($0) < meanError($1) }!
            owner.append(best)
            XCTAssertEqual(rally.players[best].side, tr.side)
            var worst = 0.0
            for s in tr.samples {
                let q = rally.players[best].position(s.time, duration: rally.duration)
                let e = hypot(q.x - s.floor.x, q.z - s.floor.z)
                worst = max(worst, e)
                errors.append(e)
            }
            XCTAssertLessThan(worst, 0.5, "seed \(seed): track of player \(best) jumps to someone else")
            XCTAssertEqual(tr.samples.count, times.count, "a track covers the whole clip")
            XCTAssertTrue(tr.samples.contains { $0.occluded }, "missed detections are interpolated and flagged")
        }
        XCTAssertEqual(Set(owner).count, 12, "seed \(seed): every player has exactly one track")
        errors.sort()
        XCTAssertLessThan(errors[errors.count / 2], 0.1, "seed \(seed): median position error")
    }

    /// Two players meet head-on (0.1 m apart) and both turn back: positions alone cannot say who is who at the
    /// bounce; their jersey shades keep them apart.
    func testAppearanceKeepsIdentitiesThroughANearCollision() {
        var rng = SplitMix64(seed: 26)
        func path(_ i: Int, _ t: Double) -> FloorPoint {
            // Toward each other at 3 m/s until t = 1, then back the way they came.
            let x = 3 * (1 - abs(t - 1)) - 0.05
            return i == 0 ? FloorPoint(x: -3 + x, z: 4) : FloorPoint(x: 3 - x, z: 4)
        }
        func frames(withAppearance: Bool) -> [VideoFrameObservation] {
            stride(from: 0.0, through: 2.0, by: 1.0 / 15).map { t in
                VideoFrameObservation(time: t, detections: (0..<2).map { i in
                    let p = path(i, t)
                    let shade = withAppearance ? [i == 0 ? 0.8 : 0.3, 0.2, 0.2].map { $0 + rng.uniform(-0.05, 0.05) } : nil
                    return PersonDetection(floor: FloorPoint(x: p.x + rng.uniform(-0.05, 0.05), z: p.z + rng.uniform(-0.05, 0.05)),
                                           footImage: ImagePoint(0, 0), appearance: shade)
                })
            }
        }
        func followsItsPlayer(_ tracks: [TrackedPlayer]) -> Bool {
            tracks.allSatisfy { tr in
                let start = tr.samples.first!.floor.x < 0 ? 0 : 1
                return tr.samples.allSatisfy { abs($0.floor.x - path(start, $0.time).x) < 0.4 }
            }
        }
        let tracks = PlayerTracker().track(frames(withAppearance: true))
        XCTAssertEqual(tracks.count, 2)
        XCTAssertTrue(followsItsPlayer(tracks))
    }

    func testSidesAreKeptAndPerSideCapHolds() {
        // Seven people on the home half (an extra one now and then), and a home blocker reaching under the net.
        var frames: [VideoFrameObservation] = []
        for k in 0..<30 {
            let t = Double(k) / 15
            var dets = (0..<6).map { i in
                PersonDetection(floor: FloorPoint(x: -4 + Double(i) * 1.6, z: 3 + 0.2 * sin(t + Double(i))), footImage: ImagePoint(0, 0))
            }
            if k % 3 == 0 { dets.append(PersonDetection(floor: FloorPoint(x: 0, z: 8), footImage: ImagePoint(0, 0))) }
            dets.append(PersonDetection(floor: FloorPoint(x: 1, z: 0.35 - 0.65 * sin(Double(k) / 29 * .pi)), footImage: ImagePoint(0, 0)))
            frames.append(VideoFrameObservation(time: t, detections: dets))
        }
        let tracks = PlayerTracker().track(frames)
        XCTAssertLessThanOrEqual(tracks.filter { $0.side == .home }.count, 6)
        XCTAssertTrue(tracks.filter { $0.side == .opponent }.isEmpty, "reaching under the net does not change sides")
    }
}

final class PoseVideoTests: XCTestCase {
    func testSingleFrameFitRecoversPostureAndFacing() throws {
        var rng = SplitMix64(seed: 31)
        let fitter = PoseFitter(stature: 1.95)
        let s = SkeletonModel(BodyMetrics(stature: 1.95))
        var yawOK = 0, postureOK = 0, n = 0
        var misses: [String] = []
        for i in 0..<192 {
            let cam = i % 2 == 0 ? Synth.stands : Synth.sideline
            let posture = Posture.allCases[i % Posture.allCases.count]
            let yaw = rng.uniform(-.pi, .pi)
            let pos = FloorPoint(x: rng.uniform(-4, 4), z: rng.uniform(-8.5, 8.5))
            let kp = Synth.keypoints(s, posture, at: pos, yaw: yaw, camera: cam, &rng, noise: 3, drop: 0.1)
            let e = try XCTUnwrap(fitter.fit(keypoints: kp, floor: pos, camera: cam))
            n += 1
            if abs((e.yaw - yaw).wrappedAngle) < 20 * .pi / 180 { yawOK += 1 }
            if PoseFitter.equivalent(e.posture, posture) { postureOK += 1 } else { misses.append("\(posture)->\(e.posture)") }
        }
        XCTAssertGreaterThanOrEqual(Double(yawOK) / Double(n), 0.9, "facing within 20 degrees")
        XCTAssertGreaterThanOrEqual(Double(postureOK) / Double(n), 0.8, "posture or an equivalent: \(misses)")
    }

    func testJumpHeightOfABlock() throws {
        var rng = SplitMix64(seed: 32)
        let fitter = PoseFitter(stature: 1.95)
        let s = SkeletonModel(BodyMetrics(stature: 1.95))
        XCTAssertTrue(fitter.isAirborne(.block))
        XCTAssertFalse(fitter.isAirborne(.ready))
        for (cam, extra) in [(Synth.stands, 0.2), (Synth.sideline, 0.0), (Synth.tripod, 0.35)] {
            let pos = FloorPoint(x: 1, z: 0.6)
            let kp = Synth.keypoints(s, .block, at: pos, yaw: .pi, jump: extra, camera: cam, &rng, noise: 2, drop: 0)
            let j = try XCTUnwrap(fitter.estimateJump(posture: .block, yaw: .pi, keypoints: kp, floor: pos, camera: cam))
            XCTAssertEqual(j, fitter.libraryJump(.block) + extra, accuracy: 0.08)
        }
    }

    func testTrackSmoothingRemovesSingleFrameFlips() throws {
        var rng = SplitMix64(seed: 33)
        let fitter = PoseFitter(stature: 1.95)
        let s = SkeletonModel(BodyMetrics(stature: 1.95))
        let cam = Synth.stands
        var frames: [PoseTrackFrame] = []
        var truth: [(Posture, Double)] = []
        for k in 0..<30 {
            let t = Double(k) / 15
            let pos = FloorPoint(x: -1 + 0.05 * Double(k), z: 4)
            // Ready facing the net, then a sustained turn to the right and a pass from frame 18.
            var posture: Posture = k < 18 ? .ready : .pass
            var yaw = k < 18 ? Double.pi : Double.pi - 1.2
            truth.append((posture, yaw))
            // Single-frame glitches: the body read back to front, a stray posture.
            if k == 7 { yaw += .pi }
            if k == 11 { posture = .standing }
            frames.append(PoseTrackFrame(time: t, floor: pos,
                                         keypoints: k == 14 ? nil : Synth.keypoints(s, posture, at: pos, yaw: yaw, camera: cam, &rng, noise: 3, drop: 0.1)))
        }
        // Single frames alone do follow the glitches.
        let single = try XCTUnwrap(fitter.fit(keypoints: frames[7].keypoints!, floor: frames[7].floor, camera: cam))
        XCTAssertGreaterThan(abs((single.yaw - truth[7].1).wrappedAngle), 2.5)
        let result = fitter.fitTrack(frames, camera: cam, facingPrior: .pi)
        for (k, e) in result.estimates.enumerated() {
            XCTAssertLessThan(abs((e.yaw - truth[k].1).wrappedAngle), 20 * .pi / 180, "frame \(k) facing")
            if k != 18 { XCTAssertTrue(PoseFitter.equivalent(e.posture, truth[k].0), "frame \(k): \(e.posture)") }
            XCTAssertEqual(e.jump, 0)
        }
        XCTAssertEqual(result.estimates[14].confidence, 0, "no keypoints, no confidence")
        XCTAssertGreaterThan(result.estimates[3].confidence, 0.3)
    }

    func testAirborneFloorPointsFollowTheTakeOffToLandingLine() {
        let times = (0..<10).map { Double($0) / 10 }
        // Feet in the air push the floor point away from the camera during frames 3...6.
        let floor = (0..<10).map { k in FloorPoint(x: 0.2 * Double(k), z: (3...6).contains(k) ? 5 + Double(k) : 2) }
        let airborne = (0..<10).map { (3...6).contains($0) }
        let fixed = PoseFitter.correctAirborneFloor(floor, times: times, airborne: airborne)
        for k in 0..<10 {
            XCTAssertEqual(fixed[k].x, 0.2 * Double(k), accuracy: 1e-9)
            XCTAssertEqual(fixed[k].z, 2, accuracy: 1e-9)
        }
        // A run at the end holds the take-off point; an overlong run is left alone.
        let end = PoseFitter.correctAirborneFloor(floor, times: times, airborne: (0..<10).map { $0 >= 8 })
        XCTAssertEqual(end[9], floor[7])
        let long = PoseFitter.correctAirborneFloor(floor, times: times.map { $0 * 5 }, airborne: airborne)
        XCTAssertEqual(long, floor)
    }

    func testDetectionFromKeypointsStandsOnTheFeet() throws {
        var rng = SplitMix64(seed: 34)
        let s = SkeletonModel(BodyMetrics(stature: 1.95))
        let pos = FloorPoint(x: 2, z: 5)
        let kp = Synth.keypoints(s, .ready, at: pos, yaw: .pi, camera: Synth.stands, &rng, noise: 0, drop: 0)
        let d = try XCTUnwrap(PersonDetection(keypoints: kp, confidence: 0.9, camera: Synth.stands))
        XCTAssertLessThan(hypot(d.floor.x - pos.x, d.floor.z - pos.z), 0.25)
    }
}

/// A simulated ball flight (the core's RK4 model at 1 ms), interpolated.
fileprivate struct SyntheticFlight {
    let samples: [BallFlight.Sample]

    /// Flies for `duration` seconds or until the ball lands.
    init(from p0: V3, velocity v0: V3, aero: BallFlight.Aero, duration: Double) {
        samples = BallFlight.simulate(from: p0, velocity: v0, aero: aero, dt: 0.001, maxTime: duration, keepEvery: 1) {
            $0.p.y <= BallFlight.radius
        }
    }

    var duration: Double { samples.last!.t }

    func position(_ t: Double) -> V3 {
        let i = max(0, min(samples.count - 2, Int(t / 0.001)))
        let a = samples[i], b = samples[i + 1]
        return a.p + (b.p - a.p) * ((t - a.t) / (b.t - a.t))
    }

    /// Velocity aimed from p0 toward a target at `speed`, raised by `elevation` radians.
    static func aim(_ p0: V3, _ target: V3, speed: Double, elevation: Double) -> V3 {
        let d = (target - p0).normalized
        let flat = V3(d.x, 0, d.z).normalized
        let pitch = asin(max(-1, min(1, d.y))) + elevation
        return (flat * cos(pitch) + V3.up * sin(pitch)) * speed
    }
}

final class BallVideoTests: XCTestCase {
    func observe(_ position: (Double) -> V3, from t0: Double, to t1: Double, fps: Double, phase: Double,
                 camera: VideoCamera, _ rng: inout SplitMix64) -> [BallObservation] {
        var out: [BallObservation] = []
        var t = t0 + phase / fps
        while t <= t1 {
            if let px = camera.project(position(t)), camera.contains(px) {
                out.append(BallObservation(time: t, image: Synth.noisy(px, &rng, 1.5)))
            }
            t += 1 / fps
        }
        return out
    }

    /// Serve, set and attack, each anchored as the pipeline does: the contact at the hand of the fitted pose of the
    /// player who played it (to +-0.2 m) and the landing on the floor or at the next player.
    func testReconstructsServeSetAndAttack() throws {
        for seed in [41, 141, 241, 341] as [UInt64] { try serveSetAttack(seed: seed) }
    }

    func serveSetAttack(seed: UInt64) throws {
        var rng = SplitMix64(seed: seed)
        let cam = Synth.stands
        let serveFrom = V3(1, 2.7, 10.5), setFrom = V3(-0.5, 2.5, 0.8), attackFrom = V3(3.4, 3.2, -0.5)
        let flights: [(String, SyntheticFlight, endsOnFloor: Bool, contact: Posture)] = [
            ("float serve", SyntheticFlight(from: serveFrom, velocity: SyntheticFlight.aim(serveFrom, V3(-1, 2.6, -2), speed: 16, elevation: 0.12),
                                            aero: .float, duration: 2), true, .floatServe),
            ("high set", SyntheticFlight(from: setFrom, velocity: V3(-2.1, 7.2, -0.25), aero: .soft, duration: 1.45), false, .set),
            ("attack", SyntheticFlight(from: attackFrom, velocity: SyntheticFlight.aim(attackFrom, V3(0.5, 0.1, 6.5), speed: 25, elevation: 0),
                                       aero: .topspin, duration: 1), true, .attack),
        ]
        for (name, flight, endsOnFloor, posture) in flights {
            func contact(at t: Double) -> BallAnchor {
                let p = flight.position(t)
                return .hand(at: t, position: V3(p.x + rng.uniform(-0.2, 0.2), p.y + rng.uniform(-0.2, 0.2), p.z + rng.uniform(-0.2, 0.2)),
                             aero: t == 0 ? BallReconstruction.expectedAero(after: posture) : nil)
            }
            let anchors = [contact(at: 0), endsOnFloor ? BallAnchor.floor(at: flight.duration) : contact(at: flight.duration)]
            for fps in [30.0, 60] {
                let obs = observe(flight.position, from: 0, to: flight.duration, fps: fps, phase: rng.unit(), camera: cam, &rng)
                let fit = try XCTUnwrap(BallReconstruction.fit(obs, camera: cam, anchors: anchors), name)
                XCTAssertLessThan(fit.rmsError, 2.0, "\(name) at \(fps) fps reprojects")
                var worst = 0.0, near = 0
                for o in obs where flight.position(o.time).z > 0 {
                    worst = max(worst, (fit.position(at: o.time) - flight.position(o.time)).length)
                    near += 1
                }
                XCTAssertGreaterThan(near, 3, name)
                XCTAssertLessThan(worst, 0.25, "\(name) at \(fps) fps: 3D error in the near half")
            }
        }
    }

    /// Without anchors a long float flight is still metric (drag fixes the scale), but spin is not observable: the
    /// same serve read as topspin would be metres off, which is why the pipeline anchors flights at contacts.
    func testUnanchoredFloatFlight() throws {
        var rng = SplitMix64(seed: 43)
        let cam = Synth.stands
        let from = V3(1, 2.7, 10.5)
        let serve = SyntheticFlight(from: from, velocity: SyntheticFlight.aim(from, V3(-1, 2.6, -2), speed: 16, elevation: 0.12), aero: .float, duration: 2)
        let obs = observe(serve.position, from: 0, to: serve.duration, fps: 30, phase: 0.3, camera: cam, &rng)
        let fit = try XCTUnwrap(BallReconstruction.fit(obs, camera: cam))
        XCTAssertEqual(fit.aero, .float)
        for o in obs where serve.position(o.time).z > 0 {
            XCTAssertLessThan((fit.position(at: o.time) - serve.position(o.time)).length, 0.25)
        }
    }

    func testSplitsASetAndAnAttackAtTheContact() throws {
        var rng = SplitMix64(seed: 42)
        let cam = Synth.stands
        let contact = 1.1
        let set = SyntheticFlight(from: V3(0.5, 2.6, 1.0), velocity: V3(-3.4, 6.2, -0.15), aero: .soft, duration: contact)
        let hit = set.position(contact)
        let attack = SyntheticFlight(from: hit, velocity: SyntheticFlight.aim(hit, V3(-0.5, 0.1, -6.5), speed: 24, elevation: 0),
                                     aero: .topspin, duration: 0.45)
        for fps in [30.0, 60] {
            let obs = observe({ $0 < contact ? set.position($0) : attack.position($0 - contact) }, from: 0, to: contact + attack.duration,
                              fps: fps, phase: 0.4, camera: cam, &rng)
            let segments = BallReconstruction.segment(obs, camera: cam)
            XCTAssertEqual(segments.count, 2, "\(fps) fps")
            guard segments.count == 2 else { continue }
            XCTAssertEqual(segments[0].t1, contact, accuracy: 1 / fps, "contact within one frame at \(fps) fps")
            XCTAssertEqual(segments[1].t0, segments[0].t1)
            // Both flights are reconstructed; the ball is continuous at the contact.
            XCTAssertLessThan((segments[0].position(at: segments[0].t1) - segments[1].position(at: segments[1].t0)).length, 0.3)
            XCTAssertLessThan((segments[0].position(at: 0.5) - set.position(0.5)).length, 0.25)
        }
    }

    func testFlightNeverGoesBelowTheFloor() {
        let s = BallSegment(t0: 0, t1: 2, p0: V3(0, 1, 0), v0: V3(0, 0, 5))
        XCTAssertEqual(s.position(at: 2).y, BallFlight.radius)
        XCTAssertEqual(s.position(at: 0.2).y, 1 - 0.5 * BallFlight.gravity * 0.04, accuracy: 1e-12)
        let drag = BallSegment(t0: 1, t1: 2, p0: V3(0, 3, 0), v0: V3(0, 2, 10), aero: .topspin)
        let sim = BallFlight.simulate(from: drag.p0, velocity: drag.v0, aero: .topspin, dt: 0.001, maxTime: 0.5, keepEvery: 1) { _ in false }
        XCTAssertLessThan((drag.position(at: 1.5) - sim.last!.p).length, 1e-3, "matches the core's ball model")
    }
}

final class EnvironmentVideoTests: XCTestCase {
    /// A gradient hall, a person walking across it, and a corner that is never seen without someone in front of it.
    func testCleanPlateRemovesMoversAndFillsTheUnseen() {
        var rng = SplitMix64(seed: 51)
        let w = 40, h = 30, n = 11
        func background(_ x: Int, _ y: Int) -> [UInt8] { [UInt8(x * 6), UInt8(y * 8), UInt8((x + y) * 3), 255] }
        var frames: [[UInt8]] = [], masks: [[UInt8]] = []
        for k in 0..<n {
            var img = [UInt8](repeating: 0, count: w * h * 4), mask = [UInt8](repeating: 0, count: w * h)
            for y in 0..<h { for x in 0..<w { img.replaceSubrange((y * w + x) * 4..<(y * w + x) * 4 + 4, with: background(x, y)) } }
            // The walker: a 5 x 10 block of random colour; masked in most frames, missed by the mask in a few.
            let x0 = 2 + 3 * k, y0 = 10
            for y in y0..<(y0 + 10) {
                for x in x0..<(x0 + 5) {
                    let i = y * w + x
                    for c in 0..<3 { img[i * 4 + c] = UInt8(rng.next() % 256) }
                    if k % 4 != 0 { mask[i] = 1 }
                }
            }
            // A bench always occupied: rows 0-3, columns 30-35, always masked.
            for y in 0..<4 { for x in 30..<36 { mask[y * w + x] = 1; img[(y * w + x) * 4] = 0 } }
            frames.append(img)
            masks.append(mask)
        }
        let plate = CleanPlate.median(frames: frames, masks: masks, width: w, height: h)
        XCTAssertEqual(plate.count, w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let got = Array(plate[i..<i + 4])
                if y < 4 && (30..<36).contains(x) {
                    // Filled from the nearest seen pixel in the row (left, right) or column (below); ties go to the row.
                    let nearest = [(29, y, x - 29), (36, y, 36 - x), (x, 4, 4 - y)].min { $0.2 < $1.2 }!
                    XCTAssertEqual(got, background(nearest.0, nearest.1), "filled (\(x), \(y))")
                } else {
                    XCTAssertEqual(got, background(x, y), "(\(x), \(y))")
                }
            }
        }
        // Without masks the median alone still removes a mover that covers each pixel in a minority of frames.
        let plain = CleanPlate.median(frames: frames, width: w, height: h)
        XCTAssertEqual(Array(plain[((15 * w) + 20) * 4..<((15 * w) + 20) * 4 + 4]), background(20, 15))
    }

    func testCleanPlateIsFastEnough() {
        let w = 960, h = 540, n = 30
        var rng = SplitMix64(seed: 52)
        let base = (0..<(w * h)).flatMap { _ in withUnsafeBytes(of: rng.next()) { Array($0.prefix(4)) } }
        let frames = (0..<n).map { k in Array(base[(k * 4099)...] + base[..<(k * 4099)]) }
        let start = Date()
        let plate = CleanPlate.median(frames: frames, width: w, height: h)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(plate.count, w * h * 4)
        // Generous for an unoptimised debug build; release builds are an order of magnitude faster.
        XCTAssertLessThan(elapsed, 20, "30 frames of 960 x 540")
    }

    func testHallLookupAndMirroring() throws {
        let cam = Synth.stands
        let hall = HallEnvironment()
        XCTAssertEqual(hall.halfWidth, 11.5)
        XCTAssertEqual(hall.halfLength, 17)
        // The far wall is in the video: its uv is the pixel over the image size, and the 3 x 4 matrix agrees.
        let wall = V3(-2, 2, -17)
        let px = try XCTUnwrap(cam.project(wall))
        let uv = try XCTUnwrap(hall.uv(for: wall, camera: cam))
        XCTAssertFalse(uv.mirrored)
        XCTAssertEqual(uv.u, px.x / cam.width, accuracy: 1e-12)
        XCTAssertEqual(uv.v, px.y / cam.height, accuracy: 1e-12)
        let m = cam.normalizedProjection
        let hx = m[0] * wall.x + m[1] * wall.y + m[2] * wall.z + m[3]
        let hy = m[4] * wall.x + m[5] * wall.y + m[6] * wall.z + m[7]
        let hz = m[8] * wall.x + m[9] * wall.y + m[10] * wall.z + m[11]
        XCTAssertEqual(hx / hz, uv.u, accuracy: 1e-9)
        XCTAssertEqual(hy / hz, uv.v, accuracy: 1e-9)
        // The wall behind the home end line is not in this video: it borrows the far wall, mirrored across Z = 0.
        let behind = V3(2, 3, 17)
        XCTAssertFalse(cam.project(behind).map { cam.contains($0) } ?? false)
        let borrowed = try XCTUnwrap(hall.uv(for: behind, camera: cam))
        XCTAssertTrue(borrowed.mirrored)
        let far = cam.project(V3(2, 3, -17))!
        XCTAssertEqual(borrowed.u, far.x / cam.width, accuracy: 1e-12)
        // High above the camera nothing (nor any mirror image) is in the frame.
        XCTAssertNil(hall.uv(for: V3(0, 10, 17), camera: cam))
        // A POV ray from mid-court toward the side wall leaves the hall there.
        let exit = try XCTUnwrap(hall.exitPoint(from: V3(1, 1.8, 3), direction: V3(1, 0, 0)))
        XCTAssertEqual(exit.x, 11.5, accuracy: 1e-12)
        XCTAssertNil(hall.exitPoint(from: V3(0, 1, 30), direction: V3(0, 0, -1)), "origin outside the hall")
    }
}

final class SceneVideoTests: XCTestCase {
    func testFrameInterpolatesFacingPostureAndBall() throws {
        let id = UUID()
        let track = VideoPlayerTrack(id: id, side: .home, label: "4", role: "OH1", samples: [
            VideoPlayerSample(time: 0, x: 0, z: 3, yaw: 3.0, posture: .ready),
            VideoPlayerSample(time: 1, x: 2, z: 3, yaw: -3.0, posture: .attack, jump: 0.8, confidence: 0.5),
        ])
        let serve = BallSegment(t0: 0.2, t1: 0.6, p0: V3(0, 3, -9), v0: V3(0, 2, 15))
        let next = BallSegment(t0: 0.7, t1: 1.2, p0: V3(0, 2, 2), v0: V3(1, 3, -5))
        var scene = VideoScene(title: "Test", duration: 1.2, camera: Synth.stands, players: [track], ball: [serve, next])
        let f = scene.frame(at: 0.5)
        XCTAssertEqual(f.tokens.count, 1)
        XCTAssertEqual(f.tokens[0].point.x, 1, accuracy: 1e-12)
        XCTAssertEqual(f.tokens[0].label, "4")
        XCTAssertEqual(f.tokens[0].posture, .ready)
        // 3.0 to -3.0 radians goes the short way, through pi.
        XCTAssertEqual(abs(try XCTUnwrap(f.yaw[id])), .pi, accuracy: 1e-9)
        XCTAssertEqual(f.jump[id]!, 0.4, accuracy: 1e-12)
        XCTAssertEqual(f.postureBlends[id], PostureBlend(from: .ready, to: .attack, t: 0.5))
        XCTAssertEqual(f.confidence[id]!, 0.75, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(f.ball).z, serve.position(at: 0.5).z, accuracy: 1e-12)
        // Between two close flights the ball moves straight from one to the other; outside them there is none.
        let gap = try XCTUnwrap(scene.frame(at: 0.65).ball)
        XCTAssertEqual(gap.y, (serve.position(at: 0.6).y + next.position(at: 0.7).y) / 2, accuracy: 1e-9)
        XCTAssertNil(scene.frame(at: 0.1).ball)
        // Outside its samples a player is absent; the SceneFrame view has the same tokens and no zones.
        scene.players[0].samples.removeFirst()
        XCTAssertTrue(scene.frame(at: 0.5).tokens.isEmpty)
        let sf = VideoScene(title: "T", duration: 1, camera: Synth.stands, players: [track]).sceneFrame(at: 0.5)
        XCTAssertEqual(sf.tokens.count, 1)
        XCTAssertTrue(sf.zones.isEmpty)
        XCTAssertEqual(try XCTUnwrap(sf.tokens[0].yaw),
                       try XCTUnwrap(VideoScene(title: "T", duration: 1, camera: Synth.stands, players: [track]).frame(at: 0.5).yaw[sf.tokens[0].id]),
                       accuracy: 1e-12)
        // Posed with the reconstructed facing and jump.
        let posed = VideoScene(title: "T", duration: 1, camera: Synth.stands, players: [track]).frame(at: 1).posedPlayers()[0]
        let s = SkeletonModel(BodyMetrics(stature: track.effectiveStature))
        let ankle = min(posed.joints[Joint.lAnkle.rawValue].translation.y, posed.joints[Joint.rAnkle.rawValue].translation.y)
        XCTAssertGreaterThan(ankle, 0.8 + s.ankleHeight - 0.15, "feet 0.8 m up")
        XCTAssertLessThan(posed.joints[Joint.head.rawValue].rotation.rotate(V3(0, 0, 1)).z, -0.5, "facing -Z (yaw -3)")
    }

    func testSceneRoundTripsThroughJSON() throws {
        let scene = VideoScene(title: "Rally 12", createdAt: Date(timeIntervalSince1970: 1_700_000_000), duration: 2,
                               camera: Synth.sideline, videoFile: "rally12.mov", plateFile: "rally12-plate.png",
                               players: [VideoPlayerTrack(side: .opponent, label: "A", samples: [VideoPlayerSample(time: 0, x: 1, z: -3, yaw: 0.2, posture: .block, jump: 0.5)])],
                               ball: [BallSegment(t0: 0, t1: 1, p0: V3(0, 3, -9), v0: V3(0, 2, 15), aero: .topspin, rmsError: 1.2)])
        let data = try JSONEncoder().encode(scene)
        XCTAssertEqual(try JSONDecoder().decode(VideoScene.self, from: data), scene)
        let detection = PersonDetection(floor: FloorPoint(x: 1, z: 2), footImage: ImagePoint(3, 4),
                                        keypoints: [.leftWrist: Keypoint2D(point: ImagePoint(5, 6), confidence: 0.7)], boxHeight: 140)
        let frame = VideoFrameObservation(time: 0.5, detections: [detection], ball: ImagePoint(7, 8))
        let json = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
        XCTAssertTrue(json.contains("\"leftWrist\""), "keypoints encode as a dictionary keyed by joint name")
        XCTAssertEqual(try JSONDecoder().decode(VideoFrameObservation.self, from: Data(json.utf8)), frame)
    }

    /// Two seconds of a rally: twelve players moving, an opponent float serve received by a home passer, a home
    /// middle blocker jumping at the net. Vision is simulated by posing every player and projecting the keypoints with
    /// noise (pose at 15 fps, ball at 30 fps); floor points come from the ankles, so they are wrong in the air.
    func testReconstructsASyntheticRallyEndToEnd() throws {
        for seed in [61, 62, 63, 64, 65, 66] as [UInt64] { try syntheticRally(seed: seed) }
    }

    func syntheticRally(seed: UInt64) throws {
        var rng = SplitMix64(seed: seed)
        let cam = Synth.stands
        let stature = SceneToken.defaultStature(role: "")
        let skeleton = SkeletonModel(BodyMetrics(stature: stature))
        struct Truth {
            var side: Side
            var base: FloorPoint
            var amplitude: (Double, Double)
            var phase: Double
            var posture: (Double) -> Posture
            var jump: (Double) -> Double = { _ in 0 }
            func position(_ t: Double) -> FloorPoint {
                FloorPoint(x: base.x + amplitude.0 * sin(1.7 * t + phase), z: base.z + amplitude.1 * sin(1.3 * t + phase * 2))
            }
            func yaw(_ t: Double) -> Double { (side == .home ? Double.pi : 0) + 0.35 * sin(1.1 * t + phase) }
        }
        let serveTime = 0.3, receiveTime = 1.5
        // Home in rotational order P1...P6 (P1 right back, x > 0): P6 receives standing still.
        let homeSpots = [FloorPoint(x: 3, z: 7), FloorPoint(x: 3, z: 1.5), FloorPoint(x: 0, z: 2), FloorPoint(x: -3, z: 1.5),
                         FloorPoint(x: -3, z: 7), FloorPoint(x: 0.5, z: 6.5)]
        var truths: [Truth] = []
        for (i, b) in homeSpots.enumerated() {
            let receiver = i == 5
            truths.append(Truth(side: .home, base: b, amplitude: receiver ? (0, 0) : (0.6, 0.5), phase: Double(i),
                                posture: { t in receiver && t > receiveTime - 0.4 ? .pass : .ready }))
        }
        // P3 blocks: in the air from 0.8 to 1.45 s, feet 0.7 m up at the top.
        truths[2] = Truth(side: .home, base: FloorPoint(x: 0.3, z: 0.9), amplitude: (0, 0), phase: 2,
                          posture: { t in t < 0.8 ? .blockReady : t < 1.45 ? .block : t < 1.65 ? .blockLanding : .blockReady },
                          jump: { t in t >= 0.8 && t < 1.45 ? 0.7 * sin(.pi * (t - 0.8) / 0.65) : 0 })
        // Opponents mirror the formation; their P1 (right back is -X for them) serves from behind the end line.
        for (i, b) in homeSpots.enumerated() {
            let server = i == 0
            truths.append(Truth(side: .opponent, base: server ? FloorPoint(x: -2.5, z: -10.2) : FloorPoint(x: -b.x, z: -b.z),
                                amplitude: server ? (0, 0) : (0.6, 0.5), phase: Double(i) + 0.5,
                                posture: { t in server ? (t < serveTime - 0.15 ? .standing : t < serveTime + 0.15 ? .floatServe : .standing) : .ready }))
        }
        // The serve: from the server's hand at contact to the receiver's forearms.
        let serverPose = skeleton.pose(.floatServe, position: truths[6].position(serveTime), facing: truths[6].yaw(serveTime))
        let receiverPose = skeleton.pose(.pass, position: truths[5].position(receiveTime), facing: truths[5].yaw(receiveTime))
        let start = [skeleton.fingertip(serverPose, left: false), skeleton.fingertip(serverPose, left: true)].max { $0.y < $1.y }!
        let forearms = (receiverPose[Joint.lWrist.rawValue].translation + receiverPose[Joint.rWrist.rawValue].translation
                        + receiverPose[Joint.lElbow.rawValue].translation + receiverPose[Joint.rElbow.rawValue].translation) * 0.25
        let serve = try XCTUnwrap(FlightSolver.aim(from: start, to: forearms, speed: 16, aero: .float))
        func ball(_ t: Double) -> V3? { t >= serveTime && t <= serveTime + serve.duration ? serve.position(at: t - serveTime) : nil }

        var frames: [VideoFrameObservation] = []
        for k in 0...60 {
            let t = Double(k) / 30
            var detections: [PersonDetection] = []
            if k % 2 == 0 {
                for truth in truths where !rng.chance(0.1) {
                    let kp = Synth.keypoints(skeleton, truth.posture(t), at: truth.position(t), yaw: truth.yaw(t),
                                             totalJump: truth.posture(t) == .block ? truth.jump(t) : nil, camera: cam, &rng, noise: 3, drop: 0.1)
                    if let d = PersonDetection(keypoints: kp, confidence: rng.uniform(0.6, 1), camera: cam) { detections.append(d) }
                }
            }
            let px = ball(t).flatMap { cam.project($0) }.flatMap { cam.contains($0) ? Synth.noisy($0, &rng, 1.5) : nil }
            frames.append(VideoFrameObservation(time: t, detections: detections, ball: px))
        }
        var stages: [String] = []
        var fractions: [Double] = []
        let scene = VideoReconstructor.reconstruct(frames: frames, camera: cam, homeLabels: [.p6: "L"], homeRoles: [.p6: "L"]) { f, stage in
            fractions.append(f)
            if stages.last != stage { stages.append(stage) }
        }
        XCTAssertEqual(stages, ["Tracking players", "Reading body positions", "Tracking the ball", "Done"])
        XCTAssertEqual(fractions, fractions.sorted())
        XCTAssertEqual(fractions.last, 1)
        XCTAssertEqual(scene.duration, 2, accuracy: 1e-9)

        // Players: six a side, labelled by rotational position, where they are, facing the right way.
        XCTAssertEqual(scene.players.filter { $0.side == .home }.count, 6)
        XCTAssertEqual(scene.players.filter { $0.side == .opponent }.count, 6)
        XCTAssertEqual(Set(scene.players.filter { $0.side == .home }.map(\.label)), ["1", "2", "3", "4", "5", "L"])
        XCTAssertEqual(Set(scene.players.filter { $0.side == .opponent }.map(\.label)), ["A", "B", "C", "D", "E", "F"])
        var positionErrors: [Double] = [], yawErrors: [Double] = []
        for track in scene.players {
            let first = track.samples[0]
            let truthIndex = truths.indices.min { a, b in
                let pa = truths[a].position(first.time), pb = truths[b].position(first.time)
                return hypot(pa.x - first.x, pa.z - first.z) < hypot(pb.x - first.x, pb.z - first.z)
            }!
            let truth = truths[truthIndex]
            if truthIndex == 5 { XCTAssertEqual(track.label, "L"); XCTAssertEqual(track.role, "L") }
            if truthIndex == 0 { XCTAssertEqual(track.label, "1") }
            if truthIndex == 6 { XCTAssertEqual(track.label, "A", "the opponent server is their P1") }
            for s in track.samples where !s.occluded {
                let p = truth.position(s.time)
                positionErrors.append(hypot(p.x - s.x, p.z - s.z))
                yawErrors.append(abs((s.yaw - truth.yaw(s.time)).wrappedAngle))
            }
            if truthIndex == 5, let late = track.samples.last {
                XCTAssertTrue(PoseFitter.equivalent(late.posture, .pass), "the receiver passes: \(late.posture)")
            }
            if truthIndex == 2 {
                // The blocker: in the air at the top of the jump, standing where they took off, at the right height.
                let top = try XCTUnwrap(track.samples.min { abs($0.time - 1.13) < abs($1.time - 1.13) })
                XCTAssertEqual(top.posture, .block)
                XCTAssertEqual(top.jump, truth.jump(top.time), accuracy: 0.15, "jump height")
                XCTAssertLessThan(hypot(top.x - 0.3, top.z - 0.9), 0.35, "floor point under the jump (1.75 m off uncorrected)")
                for s in track.samples where s.time < 0.7 || s.time > 1.75 { XCTAssertEqual(s.jump, 0) }
            }
        }
        positionErrors.sort()
        yawErrors.sort()
        XCTAssertLessThan(positionErrors[positionErrors.count / 2], 0.15, "median position error")
        XCTAssertLessThan(yawErrors[yawErrors.count / 2], 20 * .pi / 180, "median facing error")
        XCTAssertLessThan(yawErrors[yawErrors.count * 9 / 10], 35 * .pi / 180, "90th percentile facing error")

        // The serve, in 3D, from the server to the receiver.
        XCTAssertFalse(scene.ball.isEmpty)
        var worst = 0.0
        for f in frames where f.ball != nil {
            guard let truth = ball(f.time), truth.z > 0 else { continue }
            let got = try XCTUnwrap(scene.frame(at: f.time).ball, "ball at \(f.time)")
            worst = max(worst, (got - truth).length)
        }
        XCTAssertLessThan(worst, 0.3, "ball error in the near half")
        let mid = scene.frame(at: 1.0)
        XCTAssertEqual(mid.tokens.count, 12)
        XCTAssertNotNil(mid.ball)
        XCTAssertEqual(scene.sceneFrame(at: 1.0).tokens.count, 12)
    }
}
