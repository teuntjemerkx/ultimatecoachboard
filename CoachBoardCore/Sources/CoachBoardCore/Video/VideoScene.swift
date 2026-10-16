import Foundation

/// One reconstructed instant of a player.
public struct VideoPlayerSample: Hashable, Codable, Sendable {
    public var time: Double
    public var x: Double
    public var z: Double
    /// Facing, radians from +Z toward +X.
    public var yaw: Double
    public var posture: Posture
    /// Feet above their standing contact, metres (replaces the posture's library jump).
    public var jump: Double
    public var confidence: Double
    /// Not seen in this frame (position interpolated).
    public var occluded: Bool

    public init(time: Double, x: Double, z: Double, yaw: Double, posture: Posture, jump: Double = 0,
                confidence: Double = 1, occluded: Bool = false) {
        self.time = time
        self.x = x
        self.z = z
        self.yaw = yaw
        self.posture = posture
        self.jump = jump
        self.confidence = confidence
        self.occluded = occluded
    }

    public var point: FloorPoint { FloorPoint(x: x, z: z) }
}

/// A player of a video scene through time.
public struct VideoPlayerTrack: Hashable, Codable, Sendable, Identifiable {
    public var id: UUID
    public var side: Side
    public var label: String
    /// Role code ("S", "OH1", "MB2", "OPP", "L" ...); "" when unknown.
    public var role: String
    /// Stature in metres; nil uses the role's default.
    public var stature: Double?
    /// Samples in time order.
    public var samples: [VideoPlayerSample]

    public init(id: UUID = UUID(), side: Side, label: String, role: String = "", stature: Double? = nil,
                samples: [VideoPlayerSample]) {
        self.id = id
        self.side = side
        self.label = label
        self.role = role
        self.stature = stature
        self.samples = samples
    }

    public var effectiveStature: Double { stature ?? SceneToken.defaultStature(role: role) }
}

/// A scene reconstructed from a rally video (Section 4.6): the calibrated camera, the hall, every player's path,
/// facing, posture and jump, and the ball's flights. Stored next to the video and its clean plate.
public struct VideoScene: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var createdAt: Date
    /// Seconds; sample and flight times are seconds from the start of the video.
    public var duration: Double
    public var camera: VideoCamera
    public var environment: HallEnvironment
    /// File names the app stores next to the scene (the video, the clean plate image).
    public var videoFile: String?
    public var plateFile: String?
    /// Where time 0 of the scene sits in the video file, seconds (nil: at its start).
    public var clipStart: Double?
    public var players: [VideoPlayerTrack]
    public var ball: [BallSegment]
    public var netHeight: Double

    public init(id: UUID = UUID(), title: String, createdAt: Date = Date(), duration: Double, camera: VideoCamera,
                environment: HallEnvironment = HallEnvironment(), videoFile: String? = nil, plateFile: String? = nil,
                players: [VideoPlayerTrack] = [], ball: [BallSegment] = [], netHeight: Double = 2.43) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.duration = duration
        self.camera = camera
        self.environment = environment
        self.videoFile = videoFile
        self.plateFile = plateFile
        self.players = players
        self.ball = ball
        self.netHeight = netHeight
    }

    /// The scene at time t: players between their samples (positions, jump and confidence linearly, facing along the
    /// shortest arc, a posture blend while the posture changes) and the ball on its flight. A player is present from
    /// its first to its last sample. Between two flights less than 0.25 s apart the ball moves in a straight line.
    public func frame(at t: Double) -> VideoFrame {
        var frame = VideoFrame(tokens: [], yaw: [:], jump: [:], postureBlends: [:], confidence: [:], ball: nil)
        for track in players {
            let s = track.samples
            guard let first = s.first, let last = s.last, t >= first.time - 1e-9, t <= last.time + 1e-9 else { continue }
            var i = 0, j = s.count - 1
            while j - i > 1 {
                let m = (i + j) / 2
                if s[m].time <= t { i = m } else { j = m }
            }
            let a = s[i], b = s[j]
            let u = b.time > a.time ? max(0, min(1, (t - a.time) / (b.time - a.time))) : 0
            let point = FloorPoint(x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u)
            let posture = u >= 1 ? b.posture : a.posture
            let token = SceneToken(id: track.id, side: track.side, label: track.label, role: track.role, point: point,
                                   posture: posture, stature: track.stature)
            frame.tokens.append(token)
            frame.yaw[track.id] = (a.yaw + (b.yaw - a.yaw).wrappedAngle * u).wrappedAngle
            frame.jump[track.id] = a.jump + (b.jump - a.jump) * u
            frame.confidence[track.id] = a.confidence + (b.confidence - a.confidence) * u
            if a.posture != b.posture && u > 0 && u < 1 {
                frame.postureBlends[track.id] = PostureBlend(from: a.posture, to: b.posture, t: u)
            }
        }
        frame.ball = ballPosition(at: t)
        return frame
    }

    /// The ball at time t, nil outside every flight.
    public func ballPosition(at t: Double) -> V3? {
        let flights = ball.sorted { $0.t0 < $1.t0 }
        if let f = flights.first(where: { t >= $0.t0 - 1e-9 && t <= $0.t1 + 1e-9 }) { return f.position(at: t) }
        for (a, b) in zip(flights, flights.dropFirst()) where t > a.t1 && t < b.t0 && b.t0 - a.t1 < 0.25 {
            let u = (t - a.t1) / (b.t0 - a.t1)
            let p = a.position(at: a.t1), q = b.position(at: b.t0)
            return p + (q - p) * u
        }
        return nil
    }

    /// Every player in view at time t as tap targets on the video: feet and top of the head in normalised frame
    /// coordinates (0...1, v down), nearest the camera first.
    public func markers(at t: Double) -> [VideoMarker] {
        let f = frame(at: t)
        var out: [(VideoMarker, Double)] = []
        for token in f.tokens {
            let lift = f.jump[token.id] ?? 0
            let feet = V3(token.point, y: lift), top = V3(token.point, y: lift + token.effectiveStature)
            guard let a = camera.project(feet), let b = camera.project(top), camera.contains(a, margin: -40) || camera.contains(b) else { continue }
            let marker = VideoMarker(id: token.id, label: token.label, side: token.side,
                                     foot: ImagePoint(x: a.x / camera.width, y: a.y / camera.height),
                                     head: ImagePoint(x: b.x / camera.width, y: b.y / camera.height))
            out.append((marker, (feet - camera.center).length))
        }
        return out.sorted { $0.1 < $1.1 }.map(\.0)
    }

    /// The same moment for code that consumes SceneFrame (tokens and posture blends; no zones), each token facing
    /// the reconstructed way.
    public func sceneFrame(at t: Double) -> SceneFrame {
        let f = frame(at: t)
        var tokens = f.tokens
        for i in tokens.indices { tokens[i].yaw = f.yaw[tokens[i].id] }
        return SceneFrame(tokens: tokens, postureBlends: f.postureBlends, zones: [], intensities: [:], morphs: [:])
    }
}

/// A video scene at one moment. Tokens carry the position and posture; facing, jump and blends are by token id.
public struct VideoFrame: Sendable {
    public var tokens: [SceneToken]
    /// Facing per token, radians from +Z toward +X.
    public var yaw: [UUID: Double]
    /// Feet above the floor per token, metres; replaces the posture's library jump.
    public var jump: [UUID: Double]
    /// Postures changing between two samples (the token's posture is the blend's start).
    public var postureBlends: [UUID: PostureBlend]
    public var confidence: [UUID: Double]
    public var ball: V3?

    /// Every player posed with the reconstructed facing and jump (for the 3D view and POV analysis).
    public func posedPlayers() -> [PosedPlayer] {
        tokens.map { t in
            let s = SkeletonModel(BodyMetrics(stature: t.effectiveStature))
            let posture = t.posture ?? SceneToken.automaticPosture(at: t.point)
            var params = postureBlends[t.id].map {
                PoseParams.blend($0.from.params(for: s, role: t.role), $0.to.params(for: s, role: t.role), $0.t)
            } ?? posture.params(for: s, role: t.role)
            if let j = jump[t.id], params.airborne || j > 0.02 { params.jump = max(0, j) }
            let joints = s.pose(params, position: t.point, facing: yaw[t.id] ?? t.facing, jump: 0)
            return PosedPlayer(token: t, skeleton: s, joints: joints)
        }
    }
}

/// The video-to-3D pipeline the app calls after running Vision on sampled frames (Section 4): player tracking, pose
/// fitting with temporal smoothing, jump correction, ball segmentation and reconstruction, then labels and roles.
public enum VideoReconstructor {
    /// Builds the scene. Home players are labelled by their rotational position at their first frame (P1 right back,
    /// P2 right front, P3 middle front, P4 left front, P5 left back, P6 middle back, from the team's own view facing
    /// the net): `homeLabels[position]` or "1"..."6"; opponents "A"..."F" in the same order. `homeRoles` sets roles by
    /// position ("" = unknown, which also picks the default stature). `progress` reports a fraction and a short stage
    /// name ("Tracking players", "Reading body positions", "Tracking the ball", then "Done" at 1).
    public static func reconstruct(frames input: [VideoFrameObservation], camera: VideoCamera,
                                   homeLabels: [CourtPosition: String] = [:], homeRoles: [CourtPosition: String] = [:],
                                   netHeight: Double = 2.43, title: String = "Video rally",
                                   environment: HallEnvironment = HallEnvironment(), tracker: PlayerTracker = PlayerTracker(),
                                   progress: ((Double, String) -> Void)? = nil) -> VideoScene {
        let frames = input.sorted { $0.time < $1.time }
        progress?(0, "Tracking players")
        let tracked = tracker.track(frames, camera: camera)
        progress?(0.15, "Tracking players")

        // Labels and roles by rotational position at the first sample.
        var labels: [UUID: (String, String)] = [:]
        for side in Side.allCases {
            let mine = tracked.filter { $0.side == side }
            let spots = CourtPosition.allCases
            let cost = mine.map { tr -> [Double] in
                let p = CourtFrame.local(tr.samples.first!.floor, for: side)
                return spots.map { s in
                    let c = canonical(s)
                    return (p.l - c.l) * (p.l - c.l) + (p.d - c.d) * (p.d - c.d)
                }
            }
            let assignment = Hungarian.solve(cost)
            for (i, tr) in mine.enumerated() {
                guard let k = assignment[i] else { continue }
                let pos = spots[k]
                if side == .home {
                    labels[tr.id] = (homeLabels[pos] ?? "\(pos.rawValue)", homeRoles[pos] ?? "")
                } else {
                    labels[tr.id] = (String(UnicodeScalar(UInt8(64 + pos.rawValue))), "")
                }
            }
        }

        progress?(0.2, "Reading body positions")
        var fitters: [String: PoseFitter] = [:]
        var players: [VideoPlayerTrack] = []
        for (n, tr) in tracked.enumerated() {
            let (label, role) = labels[tr.id] ?? ("?", "")
            let stature = SceneToken.defaultStature(role: role)
            let key = "\(role)|\(Int((stature * 100).rounded()))"
            let fitter = fitters[key] ?? PoseFitter(stature: stature, role: role)
            fitters[key] = fitter
            let poseFrames = tr.samples.map { PoseTrackFrame(time: $0.time, floor: $0.floor, measured: $0.measured, keypoints: $0.keypoints) }
            let fit = fitter.fitTrack(poseFrames, camera: camera, facingPrior: tr.side == .home ? .pi : 0)
            var samples: [VideoPlayerSample] = []
            for (k, s) in tr.samples.enumerated() {
                let e = fit.estimates[k]
                samples.append(VideoPlayerSample(time: s.time, x: fit.floor[k].x, z: fit.floor[k].z, yaw: e.yaw,
                                                 posture: e.posture, jump: e.jump, confidence: e.confidence, occluded: s.occluded))
            }
            players.append(VideoPlayerTrack(id: tr.id, side: tr.side, label: label, role: role, samples: samples))
            progress?(0.2 + 0.6 * Double(n + 1) / Double(max(tracked.count, 1)), "Reading body positions")
        }
        players.sort { ($0.side == .home ? 0 : 1, $0.label) < ($1.side == .home ? 0 : 1, $1.label) }

        progress?(0.8, "Tracking the ball")
        var scene = VideoScene(title: title, duration: frames.last?.time ?? 0, camera: camera, environment: environment,
                               players: players, netHeight: netHeight)
        let ballObs = frames.compactMap { f in f.ball.map { BallObservation(time: f.time, image: $0) } }
        let flights = BallReconstruction.split(ballObs, camera: camera)
        var anchors: [BallAnchor] = []
        for flight in flights {
            if let a = contactAnchor(flight, scene: scene, atStart: true) { anchors.append(a) }
            if let a = contactAnchor(flight, scene: scene, atStart: false) {
                anchors.append(a)
            } else if let last = flight.last, let free = BallReconstruction.fit(flight, camera: camera, drag: false),
                      free.position(at: last.time).y < 0.4 {
                anchors.append(.floor(at: last.time))
            }
        }
        scene.ball = BallReconstruction.reconstruct(flights: flights, camera: camera, anchors: anchors)
        progress?(1, "Done")
        return scene
    }

    /// A contact at a flight's start (or end): the ball's image track, extrapolated by up to 1.5 frames (the contact
    /// happens between frames), passes within `maxDistance` of a hand or forearm of a posed player. The anchor is the
    /// point of the ball's viewing ray nearest that hand, at that moment, with the spin the player's posture gives.
    static func contactAnchor(_ flight: [BallObservation], scene: VideoScene, atStart: Bool, maxDistance: Double = 0.6) -> BallAnchor? {
        guard flight.count >= 4, let first = flight.first, let last = flight.last,
              let free = BallReconstruction.fit(flight, camera: scene.camera, drag: false) else { return nil }
        let frameTime = (last.time - first.time) / Double(flight.count - 1)
        let edge = atStart ? first.time : last.time
        var best: (d: Double, t: Double, point: V3, posture: Posture?)?
        for k in 0...6 {
            let t = edge + (atStart ? -1 : 1) * 1.5 * frameTime * Double(k) / 6
            guard let px = scene.camera.project(free.unclamped(at: t)) else { continue }
            let ray = scene.camera.ray(through: px)
            for player in scene.frame(at: t).posedPlayers() {
                let j = player.joints, s = player.skeleton
                let elbows = [j[Joint.lElbow.rawValue].translation, j[Joint.rElbow.rawValue].translation]
                let wrists = [j[Joint.lWrist.rawValue].translation, j[Joint.rWrist.rawValue].translation]
                let hands = [s.fingertip(j, left: true), s.fingertip(j, left: false)] + wrists
                    + zip(elbows, wrists).map { ($0 + $1) * 0.5 }
                for q in hands {
                    let w = q - ray.origin
                    let along = w.dot(ray.direction)
                    guard along > 0 else { continue }
                    let onRay = ray.origin + ray.direction * along
                    let d = (q - onRay).length
                    if best == nil || d < best!.d { best = (d, t, onRay, player.token.posture) }
                }
            }
        }
        guard let best, best.d <= maxDistance else { return nil }
        return .hand(at: best.t, position: best.point,
                     aero: atStart ? best.posture.flatMap { BallReconstruction.expectedAero(after: $0) } : nil)
    }

    /// Nominal spot of each rotational position in the team's own frame (l from its left sideline, d from the net).
    static func canonical(_ p: CourtPosition) -> LocalPoint {
        switch p {
        case .p1: return LocalPoint(l: 7.5, d: 7)
        case .p2: return LocalPoint(l: 7.5, d: 1.5)
        case .p3: return LocalPoint(l: 4.5, d: 1.5)
        case .p4: return LocalPoint(l: 1.5, d: 1.5)
        case .p5: return LocalPoint(l: 1.5, d: 7)
        case .p6: return LocalPoint(l: 4.5, d: 7)
        }
    }
}

/// A player as a tap target on the video frame.
public struct VideoMarker: Hashable, Sendable {
    public var id: UUID
    public var label: String
    public var side: Side
    /// Normalised frame coordinates (0...1, v down) of the feet and the top of the head.
    public var foot: ImagePoint
    public var head: ImagePoint
}
