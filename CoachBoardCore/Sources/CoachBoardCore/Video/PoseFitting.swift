import Foundation

extension SkeletonModel {
    /// Where Vision's body keypoints sit on a posed skeleton: the 17 joints map directly (Vision's root is our pelvis,
    /// its neck our neck joint between the shoulders); nose, eyes and ears are points on the head in front of and
    /// beside the head joint.
    public func keypoints(_ posed: [Rigid]) -> [BodyKeypoint: V3] {
        let h = metrics.stature
        let head = posed[Joint.head.rawValue]
        func j(_ joint: Joint) -> V3 { posed[joint.rawValue].translation }
        return [
            .nose: head.apply(V3(0, 0.045 * h, 0.07 * h)),
            .leftEye: head.apply(V3(0.017 * h, 0.066 * h, 0.056 * h)),
            .rightEye: head.apply(V3(-0.017 * h, 0.066 * h, 0.056 * h)),
            .leftEar: head.apply(V3(0.05 * h, 0.056 * h, 0.005 * h)),
            .rightEar: head.apply(V3(-0.05 * h, 0.056 * h, 0.005 * h)),
            .neck: j(.neck), .root: j(.pelvis),
            .leftShoulder: j(.lShoulder), .rightShoulder: j(.rShoulder),
            .leftElbow: j(.lElbow), .rightElbow: j(.rElbow),
            .leftWrist: j(.lWrist), .rightWrist: j(.rWrist),
            .leftHip: j(.lHip), .rightHip: j(.rHip),
            .leftKnee: j(.lKnee), .rightKnee: j(.rKnee),
            .leftAnkle: j(.lAnkle), .rightAnkle: j(.rAnkle),
        ]
    }
}

/// A player's fitted body at one frame.
public struct PoseEstimate: Hashable, Codable, Sendable {
    public var posture: Posture
    /// Facing in radians from +Z toward +X (SkeletonModel's `facing`), in (-pi, pi].
    public var yaw: Double
    /// Feet above their standing contact (metres); 0 when grounded. For an airborne posture this replaces the
    /// library's own jump (see `VideoFrame.posedPlayers`).
    public var jump: Double
    /// 0...1: how much the keypoints support the fit.
    public var confidence: Double

    public init(posture: Posture, yaw: Double, jump: Double, confidence: Double) {
        self.posture = posture
        self.yaw = yaw
        self.jump = jump
        self.confidence = confidence
    }
}

/// One frame of a track for the pose fitter.
public struct PoseTrackFrame: Hashable, Sendable {
    public var time: Double
    /// The (smoothed) floor position.
    public var floor: FloorPoint
    /// The detection's own floor point, when the player was seen (`TrackSample.measured`). With these the jump
    /// correction re-smooths the path without the airborne frames instead of interpolating the smoothed one.
    public var measured: FloorPoint?
    public var keypoints: [BodyKeypoint: Keypoint2D]?

    public init(time: Double, floor: FloorPoint, measured: FloorPoint? = nil, keypoints: [BodyKeypoint: Keypoint2D]?) {
        self.time = time
        self.floor = floor
        self.measured = measured
        self.keypoints = keypoints
    }
}

/// The fit of a whole track.
public struct PoseTrackResult: Hashable, Sendable {
    public var estimates: [PoseEstimate]
    /// Where the player stands for `SkeletonModel.pose` (the pelvis over the floor): the feet-based floor points
    /// less each posture's foot offset, airborne runs bridged from take-off to landing.
    public var floor: [FloorPoint]
}

/// Analysis-by-synthesis posture fitting (Section 4.3): every posture of the library at every 15-degree facing is
/// posed, projected through the camera at the player's floor point and compared to Vision's 2D keypoints.
/// The comparison is confidence-weighted, translation-free (centroids aligned, so floor-point error and the jump
/// do not dominate), normalised by the person's pixel height and robust (Cauchy loss) to a wrong keypoint.
public struct PoseFitter: Sendable {
    public struct Settings: Hashable, Sendable {
        /// Cost per radian of turning between frames, and the hard limit on turning speed.
        public var turnPenalty: Double = 0.005
        public var maxTurnRate: Double = 4 * .pi
        /// Cost of changing posture between frames.
        public var switchPenalty: Double = 0.006
        /// Weak pull toward facing the net, per frame (at 180 degrees off).
        public var facingPriorWeight: Double = 0.0003
        /// Keypoints below this confidence are ignored.
        public var minConfidence: Double = 0.05
        /// Cauchy scale of the normalised keypoint error (a fraction of the body height).
        public var robustScale: Double = 0.1
        /// Airborne runs longer than this are not jumps (misclassified) and keep their floor points.
        public var maxAirTime: Double = 1.5

        public init() {}
    }

    public static let yawBins = 24
    public static let yawStep = 2 * Double.pi / Double(yawBins)

    public let stature: Double
    public let role: String
    public var settings: Settings
    /// Keypoint positions per posture (index in Posture.allCases) and keypoint (index in BodyKeypoint.allCases),
    /// standing at the origin facing +Z, airborne postures lifted by their library jump.
    let model: [[V3]]
    let libraryJump: [Double]
    /// Midpoint of the ankles relative to the pelvis on the floor, per posture (facing +Z).
    let footOffset: [V3]

    static let postures = Posture.allCases
    static let keypointList = BodyKeypoint.allCases

    public init(stature: Double, role: String = "", settings: Settings = Settings()) {
        self.stature = stature
        self.role = role
        self.settings = settings
        let s = SkeletonModel(BodyMetrics(stature: stature))
        var model: [[V3]] = [], jumps: [Double] = []
        for p in Self.postures {
            let params = p.params(for: s, role: role)
            let kp = s.keypoints(s.pose(params, position: FloorPoint(x: 0, z: 0), facing: 0))
            model.append(Self.keypointList.map { kp[$0]! })
            jumps.append(params.jump)
        }
        self.model = model
        libraryJump = jumps
        let la = Self.keypointList.firstIndex(of: .leftAnkle)!, ra = Self.keypointList.firstIndex(of: .rightAnkle)!
        footOffset = model.map { V3(($0[la].x + $0[ra].x) / 2, 0, ($0[la].z + $0[ra].z) / 2) }
    }

    /// The posture's own jump in the library (metres).
    public func libraryJump(_ p: Posture) -> Double { libraryJump[Self.index(p)] }

    /// Whether the library poses this posture in the air (attack, block, jump set, jump serve, quick attack ...).
    public func isAirborne(_ p: Posture) -> Bool { libraryJump(p) > 0.02 }

    static func index(_ p: Posture) -> Int { postures.firstIndex(of: p)! }

    /// Costs of every (posture, yaw bin) for one frame, and the weight (0...1) of the frame's evidence.
    struct Costs {
        var values: [Double]
        var weight: Double
        /// Bins wrap around.
        subscript(_ p: Int, _ b: Int) -> Double {
            let n = PoseFitter.yawBins
            return values[p * n + ((b % n) + n) % n]
        }
    }

    /// The cost table of one frame; nil with fewer than four usable keypoints or the player behind the camera.
    func costs(keypoints: [BodyKeypoint: Keypoint2D], floor: FloorPoint, camera: VideoCamera) -> Costs? {
        var ks: [Int] = [], ox: [Double] = [], oy: [Double] = [], ws: [Double] = []
        for (i, k) in Self.keypointList.enumerated() {
            guard let o = keypoints[k], o.confidence >= settings.minConfidence else { continue }
            ks.append(i); ox.append(o.point.x - camera.width / 2); oy.append(o.point.y - camera.height / 2); ws.append(o.confidence)
        }
        guard ks.count >= 4 else { return nil }
        let wsum = ws.reduce(0, +)
        var mx = 0.0, my = 0.0
        for i in ks.indices { mx += ws[i] * ox[i]; my += ws[i] * oy[i] }
        mx /= wsum
        my /= wsum
        for i in ks.indices { ox[i] -= mx; oy[i] -= my }
        let r = camera.matrix
        let base = r * (V3(floor, y: 0) - camera.center)
        let middle = (base + r * V3(0, 0.55 * stature, 0)).z
        guard middle > 0.3 else { return nil }
        let f = camera.focalLength
        let pixelHeight = f * stature / middle
        let invS2 = 1 / (pixelHeight * pixelHeight)
        let c2 = settings.robustScale * settings.robustScale
        let nk = ks.count, np = Self.postures.count
        var values = [Double](repeating: 0, count: np * Self.yawBins)
        var qx = [Double](repeating: 0, count: nk), qy = [Double](repeating: 0, count: nk)
        for b in 0..<Self.yawBins {
            let m = r * Matrix3.yaw(Double(b) * Self.yawStep)
            let (m0, m1, m2) = (m.r0, m.r1, m.r2)
            for p in 0..<np {
                let pts = model[p]
                var sx = 0.0, sy = 0.0
                var valid = true
                for i in 0..<nk {
                    let v = pts[ks[i]]
                    let cz = base.z + m2.x * v.x + m2.y * v.y + m2.z * v.z
                    if cz < 0.05 { valid = false; break }
                    let cx = base.x + m0.x * v.x + m0.y * v.y + m0.z * v.z
                    let cy = base.y + m1.x * v.x + m1.y * v.y + m1.z * v.z
                    qx[i] = f * cx / cz
                    qy[i] = f * cy / cz
                    sx += ws[i] * qx[i]
                    sy += ws[i] * qy[i]
                }
                guard valid else { values[p * Self.yawBins + b] = 1; continue }
                sx /= wsum
                sy /= wsum
                var cost = 0.0
                for i in 0..<nk {
                    let ex = qx[i] - sx - ox[i], ey = qy[i] - sy - oy[i]
                    let e = (ex * ex + ey * ey) * invS2
                    cost += ws[i] * c2 * log(1 + e / c2)
                }
                values[p * Self.yawBins + b] = cost / wsum
            }
        }
        return Costs(values: values, weight: min(1, wsum / 8))
    }

    /// The facing of bin b refined by a parabola through the costs of its neighbours.
    func refinedYaw(_ c: Costs, posture p: Int, bin b: Int) -> Double {
        let cm = c[p, b - 1], c0 = c[p, b], cp = c[p, b + 1]
        let den = cm - 2 * c0 + cp
        var delta = den > 1e-15 ? 0.5 * (cm - cp) / den : 0
        delta = max(-0.5, min(0.5, delta))
        return ((Double(b) + delta) * Self.yawStep).wrappedAngle
    }

    func confidence(_ c: Costs, best: Double) -> Double { c.weight / (1 + best / 0.004) }

    /// The best posture and facing for one frame, with a jump estimate for airborne postures. Nil without at least
    /// four keypoints.
    public func fit(keypoints: [BodyKeypoint: Keypoint2D], floor: FloorPoint, camera: VideoCamera) -> PoseEstimate? {
        guard let c = costs(keypoints: keypoints, floor: floor, camera: camera) else { return nil }
        var best = (cost: Double.infinity, p: 0, b: 0)
        for p in 0..<Self.postures.count {
            for b in 0..<Self.yawBins where c[p, b] < best.cost { best = (c[p, b], p, b) }
        }
        let posture = Self.postures[best.p]
        let yaw = refinedYaw(c, posture: best.p, bin: best.b)
        let jump = isAirborne(posture)
            ? (estimateJump(posture: posture, yaw: yaw, keypoints: keypoints, floor: floor, camera: camera) ?? libraryJump(posture))
            : 0
        return PoseEstimate(posture: posture, yaw: yaw, jump: jump, confidence: confidence(c, best: best.cost))
    }

    /// The jump of an airborne posture: for the ankles (else knees, else hips), the height of their pixel above the
    /// floor point where the posed body puts them (`VideoCamera.height(of:above:)`), minus their height in the
    /// posture standing on the floor. Nil without any leg keypoint.
    public func estimateJump(posture: Posture, yaw: Double, keypoints: [BodyKeypoint: Keypoint2D], floor: FloorPoint,
                             camera: VideoCamera) -> Double? {
        let p = Self.index(posture)
        let rot = Matrix3.yaw(yaw)
        let groups: [[BodyKeypoint]] = [[.leftAnkle, .rightAnkle], [.leftKnee, .rightKnee], [.leftHip, .rightHip, .root]]
        for group in groups {
            var sum = 0.0, wsum = 0.0
            for k in group {
                guard let o = keypoints[k], o.confidence >= settings.minConfidence else { continue }
                let v = model[p][Self.keypointList.firstIndex(of: k)!]
                let offset = rot * V3(v.x, 0, v.z)
                guard let h = camera.height(of: o.point, above: FloorPoint(x: floor.x + offset.x, z: floor.z + offset.z)) else { continue }
                sum += o.confidence * (h - (v.y - libraryJump[p]))
                wsum += o.confidence
            }
            if wsum > 0 { return max(0, sum / wsum) }
        }
        return nil
    }

    /// Fits a whole track with temporal smoothing: a Viterbi pass over facing bins (each bin scored by its best
    /// posture, turning costs `turnPenalty` per radian and is limited to `maxTurnRate`), then a Viterbi pass over
    /// postures at the chosen facings (`switchPenalty` per change); the facing is refined by a parabola around the
    /// chosen bin. Floor points lose the posture's foot offset (they come from the feet; poses stand on the pelvis);
    /// airborne runs get the take-off-to-landing line and their jump measured there. `facingPrior` (radians, e.g.
    /// toward the net) gently resolves frames without evidence.
    public func fitTrack(_ frames: [PoseTrackFrame], camera: VideoCamera, facingPrior: Double? = nil) -> PoseTrackResult {
        let n = frames.count
        guard n > 0 else { return PoseTrackResult(estimates: [], floor: []) }
        let nb = Self.yawBins, np = Self.postures.count
        let tables = frames.map { f in f.keypoints.flatMap { self.costs(keypoints: $0, floor: f.floor, camera: camera) } }
        // Facing: unary = the frame's best posture at that bin.
        var unary = [[Double]](repeating: [Double](repeating: 0, count: nb), count: n)
        for t in 0..<n {
            for b in 0..<nb {
                var u = 0.0
                if let c = tables[t] {
                    var m = Double.infinity
                    for p in 0..<np { m = min(m, c[p, b]) }
                    u = c.weight * m
                }
                if let prior = facingPrior {
                    u += settings.facingPriorWeight * (1 - cos(Double(b) * Self.yawStep - prior)) / 2
                }
                unary[t][b] = u
            }
        }
        func binDistance(_ a: Int, _ b: Int) -> Int { let d = abs(a - b) % nb; return min(d, nb - d) }
        var bins = [Int](repeating: 0, count: n)
        do {
            var score = unary[0]
            var back = [[Int]](repeating: [Int](repeating: 0, count: nb), count: n)
            for t in 1..<max(n, 1) {
                let dt = max(frames[t].time - frames[t - 1].time, 1e-3)
                let limit = settings.maxTurnRate * dt + Self.yawStep
                var next = [Double](repeating: 0, count: nb)
                for b in 0..<nb {
                    var best = (Double.infinity, 0)
                    for a in 0..<nb {
                        let angle = Double(binDistance(a, b)) * Self.yawStep
                        var c = score[a] + settings.turnPenalty * angle
                        if angle > limit { c += 1 + (angle - limit) }
                        if c < best.0 { best = (c, a) }
                    }
                    next[b] = best.0 + unary[t][b]
                    back[t][b] = best.1
                }
                score = next
            }
            var b = score.indices.min { score[$0] < score[$1] }!
            for t in stride(from: n - 1, through: 0, by: -1) {
                bins[t] = b
                if t > 0 { b = back[t][b] }
            }
        }
        // Postures at the chosen facings.
        var postureIndex = [Int](repeating: 0, count: n)
        do {
            func u(_ t: Int, _ p: Int) -> Double { tables[t].map { $0.weight * $0[p, bins[t]] } ?? 0 }
            // Without evidence a frame prefers the ready posture slightly, so an unseen track is not arbitrary.
            let ready = Self.index(.ready)
            func unaryP(_ t: Int, _ p: Int) -> Double { u(t, p) + (tables[t] == nil && p != ready ? 1e-6 : 0) }
            var score = (0..<np).map { unaryP(0, $0) }
            var back = [[Int]](repeating: [Int](repeating: 0, count: np), count: n)
            for t in 1..<max(n, 1) {
                var next = [Double](repeating: 0, count: np)
                var bestPrev = (Double.infinity, 0)
                for a in 0..<np where score[a] < bestPrev.0 { bestPrev = (score[a], a) }
                for p in 0..<np {
                    let stay = score[p], move = bestPrev.0 + settings.switchPenalty
                    if stay <= move { next[p] = stay; back[t][p] = p } else { next[p] = move; back[t][p] = bestPrev.1 }
                    next[p] += unaryP(t, p)
                }
                score = next
            }
            var p = score.indices.min { score[$0] < score[$1] }!
            for t in stride(from: n - 1, through: 0, by: -1) {
                postureIndex[t] = p
                if t > 0 { p = back[t][p] }
            }
        }
        var estimates: [PoseEstimate] = []
        for t in 0..<n {
            let p = postureIndex[t]
            let yaw: Double
            var conf = 0.0
            if let c = tables[t] {
                yaw = refinedYaw(c, posture: p, bin: bins[t])
                conf = confidence(c, best: c[p, bins[t]])
            } else {
                yaw = (Double(bins[t]) * Self.yawStep).wrappedAngle
            }
            estimates.append(PoseEstimate(posture: Self.postures[p], yaw: yaw, jump: 0, confidence: conf))
        }
        // Floor points come from the feet; SkeletonModel stands the pelvis on its position, so each grounded frame
        // loses its posture's foot offset (up to 0.3 m in a lunge). Jumps: a straight floor path through the air,
        // then the measured height. With raw measurements the path is re-smoothed from the corrected ones without
        // the airborne frames (the tracker's smoothed path has their bias smeared into take-off and landing).
        let airborne = estimates.map { isAirborne($0.posture) }
        let times = frames.map(\.time)
        func root(_ feet: FloorPoint, _ t: Int) -> FloorPoint {
            guard !airborne[t] else { return feet }
            let o = Matrix3.yaw(estimates[t].yaw) * footOffset[postureIndex[t]]
            return FloorPoint(x: feet.x - o.x, z: feet.z - o.z)
        }
        var floor = Self.correctAirborneFloor((0..<n).map { root(frames[$0].floor, $0) }, times: times, airborne: airborne,
                                              maxAirTime: settings.maxAirTime)
        let runs = Self.airborneRuns(times: times, airborne: airborne, maxAirTime: settings.maxAirTime)
        if let first = frames.firstIndex(where: { $0.measured != nil }), let last = frames.lastIndex(where: { $0.measured != nil }),
           first < last {
            var kept = (0..<n).map { k in frames[k].measured.map { root($0, k) } }
            for run in runs { for k in run { kept[k] = nil } }
            let path = PlayerTracker.smoothedPath(times: Array(times[first...last]), measurements: Array(kept[first...last]))
            if path.count == last - first + 1 {
                // Inside the observed span the re-smoothed path; outside it the ends hold.
                for k in 0..<n { floor[k] = path[min(max(k, first), last) - first] }
            }
        }
        // Jump heights where the keypoints show them; frames of a jump without keypoints interpolate their
        // neighbours in the same run, a run without any falls back to the library's jump.
        var measuredJump = [Double?](repeating: nil, count: n)
        for t in 0..<n where airborne[t] {
            let e = estimates[t]
            measuredJump[t] = frames[t].keypoints.flatMap {
                estimateJump(posture: e.posture, yaw: e.yaw, keypoints: $0, floor: floor[t], camera: camera)
            }
        }
        var i = 0
        while i < n {
            guard airborne[i] else { i += 1; continue }
            var j = i
            while j + 1 < n && airborne[j + 1] { j += 1 }
            let known = (i...j).filter { measuredJump[$0] != nil }
            for t in i...j {
                if let m = measuredJump[t] { estimates[t].jump = m; continue }
                let before = known.last { $0 < t }, after = known.first { $0 > t }
                switch (before, after) {
                case let (b?, a?):
                    let u = (times[t] - times[b]) / max(times[a] - times[b], 1e-9)
                    estimates[t].jump = measuredJump[b]! + (measuredJump[a]! - measuredJump[b]!) * u
                case let (b?, nil): estimates[t].jump = measuredJump[b]!
                case let (nil, a?): estimates[t].jump = measuredJump[a]!
                default: estimates[t].jump = libraryJump(estimates[t].posture)
                }
            }
            i = j + 1
        }
        return PoseTrackResult(estimates: estimates, floor: floor)
    }

    /// During a jump the feet are in the air, so a floor point taken from them is wrong (it slides away from the
    /// camera). Every airborne run is replaced by linear interpolation in time between the last grounded point before
    /// it (take-off) and the first after it (landing): constant horizontal velocity in flight. A run at the start or
    /// end of the track holds its one grounded neighbour; runs longer than `maxAirTime` are left alone.
    public static func correctAirborneFloor(_ floor: [FloorPoint], times: [Double], airborne: [Bool],
                                            maxAirTime: Double = 1.5) -> [FloorPoint] {
        var out = floor
        let n = min(floor.count, times.count, airborne.count)
        for run in airborneRuns(times: times, airborne: airborne, maxAirTime: maxAirTime) {
            let before = run.lowerBound > 0 ? run.lowerBound - 1 : nil, after = run.upperBound + 1 < n ? run.upperBound + 1 : nil
            for k in run {
                switch (before, after) {
                case let (b?, a?):
                    let u = (times[k] - times[b]) / max(times[a] - times[b], 1e-9)
                    out[k] = FloorPoint(x: floor[b].x + (floor[a].x - floor[b].x) * u, z: floor[b].z + (floor[a].z - floor[b].z) * u)
                case let (b?, nil): out[k] = floor[b]
                case let (nil, a?): out[k] = floor[a]
                default: break
                }
            }
        }
        return out
    }

    /// Maximal runs of airborne frames whose span from take-off to landing is at most `maxAirTime` (longer runs are
    /// a misreading, not a jump).
    static func airborneRuns(times: [Double], airborne: [Bool], maxAirTime: Double) -> [ClosedRange<Int>] {
        let n = min(times.count, airborne.count)
        var runs: [ClosedRange<Int>] = []
        var i = 0
        while i < n {
            guard airborne[i] else { i += 1; continue }
            var j = i
            while j + 1 < n && airborne[j + 1] { j += 1 }
            let start = i > 0 ? times[i - 1] : times[i], end = j + 1 < n ? times[j + 1] : times[j]
            if end - start <= maxAirTime { runs.append(i...j) }
            i = j + 1
        }
        return runs
    }

    /// Postures that 2D keypoints cannot tell apart reliably, for evaluating fits: their keypoint layouts differ by
    /// under about 4% of the body height at the best facing (measured on the library), which is what 3 px of noise
    /// on a 150 px player amounts to. Not transitive across groups; each posture is equivalent to itself.
    public static func equivalent(_ a: Posture, _ b: Posture) -> Bool {
        a == b || equivalenceGroups.contains { $0.contains(a) && $0.contains(b) }
    }

    public static let equivalenceGroups: [Set<Posture>] = [
        [.ready, .readyHigh, .lowDefence],
        [.lowDefence, .cover],
        [.blockReady, .blockLanding],
        [.set, .overheadPass, .backSet, .jumpSet],
        [.attack, .jumpServe, .quickAttack, .floatServe],
    ]
}
