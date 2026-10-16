import Foundation

/// The body keypoints of Apple Vision's human body pose request (VNHumanBodyPoseObservation joint names). Left and
/// right are the subject's own.
public enum BodyKeypoint: String, CaseIterable, Codable, CodingKeyRepresentable, Sendable {
    case nose, leftEye, rightEye, leftEar, rightEar, neck
    case leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist
    case root, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle
}

/// One detected keypoint: its pixel and Vision's confidence (0...1).
public struct Keypoint2D: Hashable, Codable, Sendable {
    public var point: ImagePoint
    public var confidence: Double

    public init(point: ImagePoint, confidence: Double) {
        self.point = point
        self.confidence = confidence
    }
}

/// A person found in one sampled video frame.
public struct PersonDetection: Hashable, Codable, Sendable {
    /// Where the person stands, from the feet (see `init(keypoints:confidence:camera:boxHeight:boxBottom:)`).
    public var floor: FloorPoint
    /// The foot pixel the floor point came from.
    public var footImage: ImagePoint
    public var keypoints: [BodyKeypoint: Keypoint2D]
    public var confidence: Double
    /// Height of the person's bounding box in pixels, when known.
    public var boxHeight: Double?
    /// An optional appearance descriptor the app may compute, e.g. the mean jersey colour (r, g, b in 0...1) of the
    /// torso. When present the tracker uses it to keep identities apart where players nearly collide.
    public var appearance: [Double]?

    public init(floor: FloorPoint, footImage: ImagePoint, keypoints: [BodyKeypoint: Keypoint2D] = [:],
                confidence: Double = 1, boxHeight: Double? = nil, appearance: [Double]? = nil) {
        self.floor = floor
        self.footImage = footImage
        self.keypoints = keypoints
        self.confidence = confidence
        self.boxHeight = boxHeight
        self.appearance = appearance
    }

    /// A detection from Vision keypoints: the foot pixel is the confidence-weighted midpoint of the ankles, back-projected
    /// to ankle height (8 cm); without ankles the shanks are extrapolated from hips and knees; without legs the bottom
    /// of the bounding box is used. Nil when there is nothing to stand on.
    public init?(keypoints: [BodyKeypoint: Keypoint2D], confidence: Double, camera: VideoCamera,
                 boxHeight: Double? = nil, boxBottom: ImagePoint? = nil, appearance: [Double]? = nil,
                 minConfidence: Double = 0.1) {
        func kp(_ k: BodyKeypoint) -> Keypoint2D? { keypoints[k].flatMap { $0.confidence >= minConfidence ? $0 : nil } }
        func mid(_ a: Keypoint2D?, _ b: Keypoint2D?) -> ImagePoint? {
            switch (a, b) {
            case let (a?, b?):
                let w = a.confidence + b.confidence
                return (a.point * a.confidence + b.point * b.confidence) * (1 / w)
            case let (a?, nil): return a.point
            case let (nil, b?): return b.point
            default: return nil
            }
        }
        var foot: ImagePoint?
        var footHeight = 0.08
        if let ankles = mid(kp(.leftAnkle), kp(.rightAnkle)) {
            foot = ankles
        } else if let knees = mid(kp(.leftKnee), kp(.rightKnee)), let hips = mid(kp(.leftHip), kp(.rightHip)) ?? kp(.root)?.point {
            foot = knees + (knees - hips)
        } else if let b = boxBottom {
            foot = b
            footHeight = 0
        }
        guard let foot, let floor = camera.floorPoint(foot, height: footHeight) else { return nil }
        self.init(floor: floor, footImage: foot, keypoints: keypoints, confidence: confidence, boxHeight: boxHeight,
                  appearance: appearance)
    }
}

/// What the app hands over per sampled frame after running Vision: the frame time, the people and the ball pixel.
/// Frames without any person detection (e.g. extra ball-only frames between the pose frames) are not used for
/// player tracking.
public struct VideoFrameObservation: Hashable, Codable, Sendable {
    /// Seconds from the start of the clip; frames may be spaced unevenly.
    public var time: Double
    public var detections: [PersonDetection]
    public var ball: ImagePoint?

    public init(time: Double, detections: [PersonDetection], ball: ImagePoint? = nil) {
        self.time = time
        self.detections = detections
        self.ball = ball
    }
}

/// One frame of a tracked player.
public struct TrackSample: Hashable, Codable, Sendable {
    public var time: Double
    /// Smoothed floor position.
    public var floor: FloorPoint
    /// The detection's own floor point when the player was seen in this frame.
    public var measured: FloorPoint?
    public var footImage: ImagePoint?
    public var keypoints: [BodyKeypoint: Keypoint2D]?
    public var boxHeight: Double?
    /// Not detected in this frame: the position is interpolated.
    public var occluded: Bool
}

/// A player followed through the clip.
public struct TrackedPlayer: Hashable, Codable, Sendable, Identifiable {
    public var id: UUID
    public var side: Side
    public var samples: [TrackSample]

    /// Frames in which the player was actually detected.
    public var observedCount: Int { samples.filter { !$0.occluded }.count }
}

/// Multi-player tracking on the floor (Section 4.2): court gating, sides fixed per track, constant-velocity Kalman
/// prediction, Hungarian assignment (with miss and new-player options) on the detection's likelihood with a physical
/// gate, plus keypoint continuity in the picture and an optional appearance cue; at most six tracks per side
/// (fragments of one player merged, the most persistent kept), gap interpolation and Rauch-Tung-Striebel smoothing.
public struct PlayerTracker: Sendable {
    public struct Settings: Hashable, Codable, Sendable {
        /// Detections farther than this beyond the court lines are ignored (coaches, bench, spectators).
        public var courtMargin: Double = 2
        /// How far a track may reach under the net into the other half.
        public var netTolerance: Double = 0.5
        /// Highest foot (ankle) height of a jump. A floor point taken from airborne feet lies farther along the camera
        /// ray than the player (a blocker's lands behind the net), so with the camera known the side test accepts a
        /// detection whose foot ray passes over the track's half anywhere below this height. The pose fitter later
        /// replaces airborne floor points (`PoseFitter.fitTrack`).
        public var maxFootHeight: Double = 1.2
        /// Physical gate: a player moves at most maxSpeed * dt + gateSlack between detections.
        public var maxSpeed: Double = 8
        public var gateSlack: Double = 0.6
        public var maxPlayersPerSide: Int = 6
        /// A track not seen for longer than this stops taking detections (it may still be merged).
        public var maxCoast: Double = 1.0
        /// Fragments are merged across gaps up to this long when their ends are physically consistent.
        public var mergeGap: Double = 2.5
        /// Tracks with fewer detections are dropped as false positives.
        public var minDetections: Int = 4
        public var minConfidence: Double = 0.1
        /// Detection noise (metres, one sigma) and acceleration noise (m^2/s^3) of the constant-velocity model.
        public var measurementNoise: Double = 0.1
        public var accelerationNoise: Double = 8
        /// Unmatched detections this close to a matched one are duplicates, not new players.
        public var duplicateRadius: Double = 0.4
        /// Extra assignment cost for a track with fewer than three detections (established tracks win ties).
        public var tentativePenalty: Double = 3
        /// Cost of a track missing a frame, against which each pairing's negative log-likelihood is weighed: a
        /// well-tracked player (predicted sigma about 0.15 m) rather misses a frame than takes a detection beyond 8
        /// sigma (the apparent motion of a jump is fast). It is the same for every track, so a vague track does not win
        /// just because it is vague.
        public var missGate: Double = 64
        /// Image continuity: cost per squared median keypoint displacement (as a fraction of the person's pixel
        /// height) between a track's last detection and a new one, per frame interval of 1/15 s. Tells apart people
        /// who are close on the floor but not in the picture (a jumping blocker and the player across the net).
        public var keypointWeight: Double = 30
        /// Assignment cost per unit of squared appearance distance, and the largest squared distance at which two
        /// fragments may still be the same player.
        public var appearanceWeight: Double = 40
        public var appearanceMergeLimit: Double = 0.03

        public init() {}
    }

    public var settings: Settings

    public init(settings: Settings = Settings()) { self.settings = settings }

    /// A one-axis constant-velocity Kalman state.
    struct Axis {
        var p: Double, v: Double
        var ppp: Double, ppv: Double, pvv: Double

        func predicted(_ dt: Double, q: Double) -> Axis {
            var a = self
            a.p = p + v * dt
            a.ppp = ppp + 2 * dt * ppv + dt * dt * pvv + q * dt * dt * dt / 3
            a.ppv = ppv + dt * pvv + q * dt * dt / 2
            a.pvv = pvv + q * dt
            return a
        }

        mutating func update(_ z: Double, r: Double) {
            let s = ppp + r
            let kp = ppp / s, kv = ppv / s
            let y = z - p
            p += kp * y
            v += kv * y
            let (opp, opv, ovv) = (ppp, ppv, pvv)
            ppp = (1 - kp) * opp
            ppv = (1 - kp) * opv
            pvv = ovv - kv * opv
        }
    }

    final class Work {
        let side: Side
        var detections: [(frame: Int, det: PersonDetection)] = []
        var x: Axis, z: Axis
        var lastTime: Double
        /// Running mean of the detections' appearance.
        var appearance: [Double]?

        init(side: Side, det: PersonDetection, frame: Int, time: Double, r: Double) {
            self.side = side
            detections = [(frame, det)]
            appearance = det.appearance
            x = Axis(p: det.floor.x, v: 0, ppp: r, ppv: 0, pvv: 9)
            z = Axis(p: det.floor.z, v: 0, ppp: r, ppv: 0, pvv: 9)
            lastTime = time
        }

        func blendAppearance(_ a: [Double]?) {
            guard let a else { return }
            guard let m = appearance, m.count == a.count else { appearance = a; return }
            appearance = zip(m, a).map { $0 + 0.2 * ($1 - $0) }
        }

        var position: FloorPoint { FloorPoint(x: x.p, z: z.p) }
        var firstFrame: Int { detections.first!.frame }
        var lastFrame: Int { detections.last!.frame }
    }

    /// Median distance between the keypoints two detections share (at least four, confidence 0.2 and up), as a
    /// fraction of the first one's height in the picture; nil when they share too few.
    static func keypointDistance(_ a: [BodyKeypoint: Keypoint2D], _ b: [BodyKeypoint: Keypoint2D]) -> Double? {
        var d: [Double] = []
        var top = Double.infinity, bottom = -Double.infinity
        for k in BodyKeypoint.allCases {
            guard let p = a[k], p.confidence >= 0.2 else { continue }
            top = min(top, p.point.y)
            bottom = max(bottom, p.point.y)
            if let q = b[k], q.confidence >= 0.2 { d.append(p.point.distance(to: q.point)) }
        }
        guard d.count >= 4 else { return nil }
        d.sort()
        return d[d.count / 2] / max(bottom - top, 10)
    }

    func keypointCost(_ track: Work, _ d: PersonDetection, dt: Double) -> Double {
        guard settings.keypointWeight > 0, let last = track.detections.last?.det.keypoints,
              let m = Self.keypointDistance(last, d.keypoints) else { return 0 }
        return settings.keypointWeight * m * m / max(1, dt * 15)
    }

    /// Squared distance between two appearance descriptors (0 when either is missing).
    static func appearanceDistance(_ a: [Double]?, _ b: [Double]?) -> Double {
        guard let a, let b, a.count == b.count else { return 0 }
        return zip(a, b).reduce(0) { $0 + ($1.0 - $1.1) * ($1.0 - $1.1) }
    }

    func appearanceCost(_ a: [Double]?, _ b: [Double]?) -> Double { settings.appearanceWeight * Self.appearanceDistance(a, b) }

    func onCourt(_ p: FloorPoint) -> Bool {
        abs(p.x) <= CourtFrame.halfWidth + settings.courtMargin && abs(p.z) <= 9 + settings.courtMargin
    }

    func allowed(_ side: Side, _ d: PersonDetection, camera: VideoCamera?) -> Bool {
        var zs = [d.floor.z]
        if let camera, let high = camera.floorPoint(d.footImage, height: settings.maxFootHeight) { zs.append(high.z) }
        return side == .home ? zs.max()! > -settings.netTolerance : zs.min()! < settings.netTolerance
    }

    /// Tracks the players through the frames (sorted by time internally; frames without person detections skipped).
    /// With the camera, jumping players near the net keep their track (see `Settings.maxFootHeight`).
    public func track(_ input: [VideoFrameObservation], camera: VideoCamera? = nil) -> [TrackedPlayer] {
        let frames = input.filter { !$0.detections.isEmpty }.sorted { $0.time < $1.time }
        guard !frames.isEmpty else { return [] }
        let times = frames.map(\.time)
        let r = settings.measurementNoise * settings.measurementNoise, q = settings.accelerationNoise
        var all: [Work] = []
        for (k, frame) in frames.enumerated() {
            let t = frame.time
            let dets = frame.detections.filter { $0.confidence >= settings.minConfidence && onCourt($0.floor) }
            let active = all.filter { t - $0.lastTime <= settings.maxCoast && $0.lastFrame < k }
            var assigned = [Bool](repeating: false, count: dets.count)
            if !active.isEmpty && !dets.isEmpty {
                let forbidden = 1e9
                // Tracks x detections, augmented so that a track may miss the frame (the miss cost) and a detection may
                // stay unassigned (a new player or clutter, cost 0): a pair wins only when it beats both.
                let (nt, nd) = (active.count, dets.count)
                var cost = [[Double]](repeating: [Double](repeating: forbidden, count: nd + nt), count: nt + nd)
                for j in 0..<nd { for i in nt..<(nt + nd) { cost[i][j] = i - nt == j ? 0 : forbidden } }
                for i in nt..<(nt + nd) { for j in nd..<(nd + nt) { cost[i][j] = 0 } }
                for (i, tr) in active.enumerated() {
                    let dt = t - tr.lastTime
                    let px = tr.x.predicted(dt, q: q), pz = tr.z.predicted(dt, q: q)
                    let gate = settings.maxSpeed * dt + settings.gateSlack
                    let sx = px.ppp + r, sz = pz.ppp + r
                    let tentative = tr.detections.count < 3 ? settings.tentativePenalty : 0
                    cost[i][nd + i] = settings.missGate + 2 * log(0.15 * 0.15) + tentative
                    for (j, d) in dets.enumerated() where allowed(tr.side, d, camera: camera) {
                        guard hypot(d.floor.x - tr.x.p, d.floor.z - tr.z.p) <= gate else { continue }
                        let ex = d.floor.x - px.p, ez = d.floor.z - pz.p
                        // Negative log-likelihood of the detection under the prediction: the log-determinant keeps a
                        // vague (long-coasting or brand-new) track from winning just because it is vague.
                        cost[i][j] = ex * ex / sx + ez * ez / sz + log(sx * sz) + tentative
                            + appearanceCost(tr.appearance, d.appearance) + keypointCost(tr, d, dt: dt)
                    }
                }
                let match = Hungarian.solve(cost)
                for (i, j) in match.enumerated() where i < nt {
                    guard let j, j < nd, cost[i][j] < forbidden else { continue }
                    let tr = active[i]
                    let dt = t - tr.lastTime
                    tr.x = tr.x.predicted(dt, q: q)
                    tr.z = tr.z.predicted(dt, q: q)
                    tr.x.update(dets[j].floor.x, r: r)
                    tr.z.update(dets[j].floor.z, r: r)
                    tr.lastTime = t
                    tr.detections.append((k, dets[j]))
                    tr.blendAppearance(dets[j].appearance)
                    assigned[j] = true
                }
            }
            let matched = dets.indices.filter { assigned[$0] }.map { dets[$0].floor }
            for (j, d) in dets.enumerated() where !assigned[j] {
                if matched.contains(where: { hypot($0.x - d.floor.x, $0.z - d.floor.z) < settings.duplicateRadius }) { continue }
                all.append(Work(side: CourtFrame.side(of: d.floor), det: d, frame: k, time: t, r: r))
            }
        }
        var tracks = all.filter { $0.detections.count >= settings.minDetections }
        tracks = merge(tracks, times: times)
        // At most six per side: the most persistent.
        var kept: [Work] = []
        for side in Side.allCases {
            let mine = tracks.filter { $0.side == side }.sorted {
                $0.detections.count != $1.detections.count ? $0.detections.count > $1.detections.count : $0.firstFrame < $1.firstFrame
            }
            kept += mine.prefix(settings.maxPlayersPerSide)
        }
        return kept.map { smooth($0, times: times) }
    }

    /// Joins fragments of one player: a track ending before another of the same side starts, with the gap short and
    /// the jump between their ends physically possible. Cheapest joins first.
    func merge(_ input: [Work], times: [Double]) -> [Work] {
        var tracks = input
        while true {
            var best: (Double, Int, Int)?
            for (i, a) in tracks.enumerated() {
                for (j, b) in tracks.enumerated() where i != j && a.side == b.side && a.lastFrame < b.firstFrame {
                    let gap = times[b.firstFrame] - times[a.lastFrame]
                    guard gap <= settings.mergeGap else { continue }
                    let end = a.detections.last!.det.floor, start = b.detections.first!.det.floor
                    let d = hypot(start.x - end.x, start.z - end.z)
                    guard d <= settings.maxSpeed * gap + settings.gateSlack,
                          Self.appearanceDistance(a.appearance, b.appearance) <= settings.appearanceMergeLimit else { continue }
                    let c = d / (settings.maxSpeed * gap + settings.gateSlack) + gap / settings.mergeGap
                    if best == nil || c < best!.0 { best = (c, i, j) }
                }
            }
            guard let (_, i, j) = best else { return tracks }
            let a = tracks[i], b = tracks[j]
            a.detections += b.detections
            a.lastTime = b.lastTime
            for d in b.detections { a.blendAppearance(d.det.appearance) }
            tracks.remove(at: j)
        }
    }

    /// A floor path smoothed by a constant-velocity Kalman filter and the Rauch-Tung-Striebel smoother: frames without
    /// a measurement (nil) are bridged at constant velocity. Uses the settings' measurement and acceleration noise.
    /// Empty when there is no measurement at all.
    public static func smoothedPath(times: [Double], measurements: [FloorPoint?], settings: Settings = Settings()) -> [FloorPoint] {
        let n = min(times.count, measurements.count)
        guard let firstSeen = measurements.prefix(n).firstIndex(where: { $0 != nil }) else { return [] }
        let r = settings.measurementNoise * settings.measurementNoise, q = settings.accelerationNoise
        func run(_ value: (FloorPoint) -> Double) -> [Double] {
            var filtered: [Axis] = [], predicted: [Axis] = []
            var s = Axis(p: value(measurements[firstSeen]!), v: 0, ppp: firstSeen == 0 ? r : 100, ppv: 0, pvv: 9)
            for i in 0..<n {
                let p = i == 0 ? s : s.predicted(max(times[i] - times[i - 1], 0), q: q)
                predicted.append(p)
                s = p
                if let m = measurements[i], !(i == 0 && firstSeen == 0) { s.update(value(m), r: r) }
                filtered.append(s)
            }
            // Rauch-Tung-Striebel: x_s(k) = x_f(k) + G (x_s(k+1) - x_p(k+1)), G = P_f(k) F^T P_p(k+1)^-1.
            var out = filtered.map(\.p)
            var next = filtered[n - 1]
            for i in stride(from: n - 2, through: 0, by: -1) {
                let f = filtered[i], p = predicted[i + 1]
                let dt = times[i + 1] - times[i]
                // P_f F^T with F = [[1, dt], [0, 1]].
                let a00 = f.ppp + dt * f.ppv, a01 = f.ppv
                let a10 = f.ppv + dt * f.pvv, a11 = f.pvv
                let det = p.ppp * p.pvv - p.ppv * p.ppv
                guard abs(det) > 1e-300 else { next = f; out[i] = f.p; continue }
                let i00 = p.pvv / det, i01 = -p.ppv / det, i11 = p.ppp / det
                let g00 = a00 * i00 + a01 * i01, g01 = a00 * i01 + a01 * i11
                let g10 = a10 * i00 + a11 * i01, g11 = a10 * i01 + a11 * i11
                let dp = next.p - p.p, dv = next.v - p.v
                var sm = f
                sm.p = f.p + g00 * dp + g01 * dv
                sm.v = f.v + g10 * dp + g11 * dv
                out[i] = sm.p
                next = sm
            }
            return out
        }
        let xs = run(\.x), zs = run(\.z)
        return (0..<n).map { FloorPoint(x: xs[$0], z: zs[$0]) }
    }

    /// Kalman filter over every frame of the track's span (missing frames only predict), then the RTS smoother.
    func smooth(_ track: Work, times: [Double]) -> TrackedPlayer {
        let first = track.firstFrame, last = track.lastFrame
        var byFrame: [Int: PersonDetection] = [:]
        for d in track.detections { byFrame[d.frame] = d.det }
        let n = last - first + 1
        let path = Self.smoothedPath(times: Array(times[first...last]), measurements: (first...last).map { byFrame[$0]?.floor },
                                     settings: settings)
        var samples: [TrackSample] = []
        for i in 0..<n {
            let k = first + i
            let d = byFrame[k]
            var p = path[i]
            // Never across the net beyond the tolerance.
            if track.side == .home { p.z = max(p.z, -settings.netTolerance) } else { p.z = min(p.z, settings.netTolerance) }
            samples.append(TrackSample(time: times[k], floor: p, measured: d?.floor, footImage: d?.footImage,
                                       keypoints: d?.keypoints, boxHeight: d?.boxHeight, occluded: d == nil))
        }
        // Short gaps at the clip's ends hold the nearest position, so players do not pop in and out.
        if let s = samples.first {
            var k = first - 1
            while k >= 0 && s.time - times[k] <= settings.maxCoast {
                samples.insert(TrackSample(time: times[k], floor: s.floor, occluded: true), at: 0)
                k -= 1
            }
        }
        if let s = samples.last {
            var k = last + 1
            while k < times.count && times[k] - s.time <= settings.maxCoast {
                samples.append(TrackSample(time: times[k], floor: s.floor, occluded: true))
                k += 1
            }
        }
        return TrackedPlayer(id: UUID(), side: track.side, samples: samples)
    }
}

extension TrackSample {
    init(time: Double, floor: FloorPoint, occluded: Bool) {
        self.init(time: time, floor: floor, measured: nil, footImage: nil, keypoints: nil, boxHeight: nil, occluded: occluded)
    }
}
