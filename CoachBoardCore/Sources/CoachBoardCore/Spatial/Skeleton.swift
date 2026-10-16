import Foundation

/// The 17-joint avatar skeleton of the 3D board (Section 5.2 uses 24 joints for reconstruction; the manual-scene
/// avatars need these 17). Joint order is parent-before-child.
public enum Joint: Int, CaseIterable, Codable, Sendable {
    case pelvis, spine, chest, neck, head
    case lShoulder, lElbow, lWrist, rShoulder, rElbow, rWrist
    case lHip, lKnee, lAnkle, rHip, rKnee, rAnkle

    public var parent: Joint? {
        switch self {
        case .pelvis: return nil
        case .spine: return .pelvis
        case .chest: return .spine
        case .neck: return .chest
        case .head: return .neck
        case .lShoulder, .rShoulder: return .chest
        case .lElbow: return .lShoulder
        case .lWrist: return .lElbow
        case .rElbow: return .rShoulder
        case .rWrist: return .rElbow
        case .lHip, .rHip: return .pelvis
        case .lKnee: return .lHip
        case .lAnkle: return .lKnee
        case .rKnee: return .rHip
        case .rAnkle: return .rKnee
        }
    }
}

/// Body dimensions (Appendix B2 `Biometrics`), in metres.
public struct BodyMetrics: Hashable, Codable, Sendable {
    public var stature: Double
    /// Standing reach, one hand, flat-footed; defaults to 1.31 x stature.
    public var standingReach: Double

    public init(stature: Double, standingReach: Double? = nil) {
        self.stature = stature
        self.standingReach = standingReach ?? 1.31 * stature
    }

    /// Eye height standing, 0.936 x stature (Appendix B2).
    public var eyeHeight: Double { 0.936 * stature }
}

/// Segment lengths from stature (Drillis and Contini proportions as tabulated by Winter), with the arm scaled
/// so that the reach posture reproduces the measured standing reach.
public struct SkeletonModel: Hashable, Sendable {
    public let metrics: BodyMetrics
    /// Joint offsets from the parent in the rest pose (standing, arms down, facing +Z in the body frame).
    public let restOffsets: [V3]
    public let ankleHeight: Double
    public let armScale: Double

    /// Shoulder elevation when the arm is raised overhead (clavicle), as a fraction of stature.
    public static let shoulderElevation = 0.045

    public init(_ metrics: BodyMetrics) {
        self.metrics = metrics
        let h = metrics.stature
        // Reach = shoulder height + elevation + arm length (upper arm + forearm + hand = 0.440 H nominal).
        let nominalArm = 0.186 + 0.146 + 0.108
        let scale = (metrics.standingReach - (0.818 + Self.shoulderElevation) * h) / (nominalArm * h)
        armScale = max(0.8, min(1.25, scale))
        ankleHeight = 0.039 * h
        var o = [V3](repeating: .zero, count: Joint.allCases.count)
        o[Joint.pelvis.rawValue] = V3(0, 0.530 * h, 0)
        o[Joint.spine.rawValue] = V3(0, 0.130 * h, 0)
        o[Joint.chest.rawValue] = V3(0, 0.106 * h, 0)
        o[Joint.neck.rawValue] = V3(0, 0.052 * h, 0)          // shoulder line at 0.818 H, chin at 0.870 H
        o[Joint.head.rawValue] = V3(0, 0.052 * h, 0)
        o[Joint.lShoulder.rawValue] = V3(0.129 * h, 0.052 * h, 0)
        o[Joint.rShoulder.rawValue] = V3(-0.129 * h, 0.052 * h, 0)
        o[Joint.lElbow.rawValue] = V3(0, -0.186 * h * armScale, 0)
        o[Joint.rElbow.rawValue] = V3(0, -0.186 * h * armScale, 0)
        o[Joint.lWrist.rawValue] = V3(0, -0.146 * h * armScale, 0)
        o[Joint.rWrist.rawValue] = V3(0, -0.146 * h * armScale, 0)
        o[Joint.lHip.rawValue] = V3(0.095 * h, 0, 0)
        o[Joint.rHip.rawValue] = V3(-0.095 * h, 0, 0)
        o[Joint.lKnee.rawValue] = V3(0, -0.245 * h, 0)
        o[Joint.rKnee.rawValue] = V3(0, -0.245 * h, 0)
        o[Joint.lAnkle.rawValue] = V3(0, -0.246 * h, 0)
        o[Joint.rAnkle.rawValue] = V3(0, -0.246 * h, 0)
        restOffsets = o
    }

    public var handLength: Double { 0.108 * metrics.stature * armScale }

    /// World transforms of every joint for a posture, standing at `position` on the floor facing `facing`
    /// (radians from world +Z toward +X), lifted by `jump` metres on top of the posture's own jump. `role` picks the
    /// research variant of the technique for that position (Resources/Postures).
    public func pose(_ posture: Posture, position: FloorPoint, facing: Double, jump: Double = 0, role: String? = nil) -> [Rigid] {
        pose(posture.params(for: self, role: role), position: position, facing: facing, jump: jump)
    }

    /// A pose between two postures: every joint rotation slerps, the jump interpolates (Section 3.3).
    public func pose(_ blend: PostureBlend, position: FloorPoint, facing: Double, jump: Double = 0, role: String? = nil) -> [Rigid] {
        let a = blend.from.params(for: self, role: role), b = blend.to.params(for: self, role: role)
        return pose(PoseParams.blend(a, b, blend.t), position: position, facing: facing, jump: jump)
    }

    /// How far a shoulder is elevated (0...1) for its arm's angle: arms overhead lift the clavicle fully.
    static func shoulderLift(_ shoulder: Quat) -> Double {
        let arm = shoulder.rotate(V3(0, -1, 0))
        let elevation = acos(max(-1, min(1, -arm.y))) * 180 / .pi
        return max(0, min(1, (elevation - 100) / 70))
    }

    public func pose(_ params: PoseParams, position: FloorPoint, facing: Double, jump: Double = 0) -> [Rigid] {
        var world = [Rigid](repeating: .identity, count: Joint.allCases.count)
        for j in Joint.allCases {
            var offset = restOffsets[j.rawValue]
            var rotation = params.rotations[j] ?? .identity
            // Raising an arm overhead lifts the shoulder (clavicle elevation), which the reach measurement includes.
            if j == .lShoulder || j == .rShoulder {
                offset.y += Self.shoulderElevation * metrics.stature * Self.shoulderLift(rotation)
            }
            if let p = j.parent {
                // Grounded feet stay flat, pointing where the shank points.
                if (j == .lAnkle || j == .rAnkle) && !params.airborne {
                    let parent = world[p.rawValue].rotation
                    let fwd = parent.rotate(V3(0, 0, 1))
                    let heading = hypot(fwd.x, fwd.z) > 1e-6 ? atan2(fwd.x, fwd.z) : facing
                    rotation = parent.conjugate * Quat(axis: .up, angle: heading)
                }
                world[j.rawValue] = world[p.rawValue] * Rigid(rotation: rotation, translation: offset)
            } else {
                world[j.rawValue] = Rigid(rotation: Quat(axis: .up, angle: facing), translation: .zero)
                    * Rigid(rotation: rotation, translation: offset)
            }
        }
        // Ground contact: the lower ankle sits at ankle height (feet on the floor); a jump lifts the body.
        let lowest = min(world[Joint.lAnkle.rawValue].translation.y, world[Joint.rAnkle.rawValue].translation.y)
        let lift = ankleHeight - lowest + params.jump + max(jump, 0)
        let shift = V3(position.x, lift, position.z)
        return world.map { Rigid(rotation: $0.rotation, translation: $0.translation + shift) }
    }

    /// The rest pose at the origin (the bind pose for skinning).
    public var restPose: [Rigid] { pose(.standing, position: FloorPoint(x: 0, z: 0), facing: 0) }

    /// Skin transforms (posed * inverse(rest)) as dual quaternions, one per joint.
    public func skin(_ posed: [Rigid]) -> [DualQuat] {
        zip(posed, restPose).map { DualQuat($0 * $1.inverse) }
    }

    /// Fingertip height of a hand in a pose (the wrist plus the hand along the forearm direction).
    public func fingertip(_ posed: [Rigid], left: Bool) -> V3 {
        let w = posed[(left ? Joint.lWrist : Joint.rWrist).rawValue]
        return w.apply(V3(0, -handLength, 0))
    }

    /// Eye position: in front of the head joint by 0.066 H up and 0.04 H forward.
    public func eye(_ posed: [Rigid]) -> V3 {
        let h = metrics.stature
        return posed[Joint.head.rawValue].apply(V3(0, 0.066 * h, 0.04 * h))
    }
}

/// The posture library (Sections 3.2 and 5.2). Each posture names a technique of the research library
/// (Resources/Postures, per position); `rotations` is the hand-made fallback when the library has no variant.
/// Angles are anatomical: flexion bends a limb forward (+Z in the body frame), abduction lifts it sideways.
public enum Posture: String, CaseIterable, Codable, Sendable {
    case standing, ready, pass, set, attack, block, dig, reach
    case readyHigh, lowDefence, angledPass, overheadPass, sprawl, backSet, jumpSet, approach, armCock, landing
    case quickAttack, blockReady, blockLanding, floatServe, jumpServe, cover

    /// The technique id in the research library.
    public var techniqueID: String? {
        switch self {
        case .standing, .reach: return nil
        case .ready: return "ready_medium"
        case .readyHigh: return "ready_high"
        case .lowDefence: return "ready_low"
        case .pass: return "pass_platform"
        case .angledPass: return "pass_platform_angled"
        case .overheadPass: return "overhead_pass"
        case .dig: return "dig_low"
        case .sprawl: return "dig_sprawl"
        case .set: return "set_front_contact"
        case .backSet: return "set_back_contact"
        case .jumpSet: return "set_jump_contact"
        case .approach: return "approach_takeoff"
        case .armCock: return "attack_arm_cock"
        case .attack: return "attack_contact"
        case .landing: return "attack_landing"
        case .quickAttack: return "quick_attack_contact"
        case .blockReady: return "block_ready"
        case .block: return "block_jump_peak"
        case .blockLanding: return "block_landing"
        case .floatServe: return "serve_float_contact"
        case .jumpServe: return "serve_jump_contact"
        case .cover: return "cover"
        }
    }

    public var title: String {
        switch self {
        case .readyHigh: return "HIGH READY"
        case .lowDefence: return "LOW DEFENCE"
        case .angledPass: return "ANGLED PASS"
        case .overheadPass: return "OVERHEAD PASS"
        case .backSet: return "BACK SET"
        case .jumpSet: return "JUMP SET"
        case .armCock: return "ARM COCK"
        case .quickAttack: return "QUICK"
        case .blockReady: return "BLOCK READY"
        case .blockLanding: return "BLOCK LANDING"
        case .floatServe: return "FLOAT SERVE"
        case .jumpServe: return "JUMP SERVE"
        default: return rawValue.uppercased()
        }
    }

    /// Joint rotations and jump for a skeleton: the research variant for the role's position when there is one.
    public func params(for skeleton: SkeletonModel, role: String? = nil) -> PoseParams {
        if let id = techniqueID, let spec = PostureLibrary.shared.spec(id, role: role) { return spec.params(for: skeleton) }
        return PoseParams(rotations: rotations, jump: fallbackJump)
    }

    var fallbackJump: Double {
        switch self {
        case .jumpSet: return 0.35
        case .attack, .jumpServe: return 0.6
        case .quickAttack: return 0.55
        case .armCock: return 0.5
        default: return 0
        }
    }

    static func flex(_ deg: Double) -> Quat { Quat(axis: V3(1, 0, 0), angle: -deg * .pi / 180) }   // forward swing for limbs pointing down
    static func bend(_ deg: Double) -> Quat { Quat(axis: V3(1, 0, 0), angle: deg * .pi / 180) }    // knee: shank backward
    static func lean(_ deg: Double) -> Quat { Quat(axis: V3(1, 0, 0), angle: deg * .pi / 180) }    // trunk forward
    static func abduct(_ deg: Double, left: Bool) -> Quat { Quat(axis: V3(0, 0, 1), angle: (left ? 1 : -1) * deg * .pi / 180) }

    public var rotations: [Joint: Quat] {
        switch self {
        case .standing:
            return [:]
        case .reach:
            return [.lShoulder: Self.flex(180)]
        case .ready:
            return [.spine: Self.lean(20), .chest: Self.lean(5),
                    .lHip: Self.flex(55), .rHip: Self.flex(55), .lKnee: Self.bend(85), .rKnee: Self.bend(85),
                    .lShoulder: Self.flex(35) * Self.abduct(10, left: true), .rShoulder: Self.flex(35) * Self.abduct(10, left: false),
                    .lElbow: Self.flex(35), .rElbow: Self.flex(35)]
        case .pass:
            return [.spine: Self.lean(25), .chest: Self.lean(5),
                    .lHip: Self.flex(60), .rHip: Self.flex(60), .lKnee: Self.bend(90), .rKnee: Self.bend(90),
                    .lShoulder: Self.flex(55) * Self.abduct(-8, left: true), .rShoulder: Self.flex(55) * Self.abduct(-8, left: false)]
        case .set:
            return [.lHip: Self.flex(20), .rHip: Self.flex(20), .lKnee: Self.bend(30), .rKnee: Self.bend(30),
                    .lShoulder: Self.flex(160) * Self.abduct(15, left: true), .rShoulder: Self.flex(160) * Self.abduct(15, left: false),
                    .lElbow: Self.flex(75), .rElbow: Self.flex(75)]
        case .attack:
            return [.spine: Self.lean(-10),
                    .lHip: Self.flex(25), .rHip: Self.flex(15), .lKnee: Self.bend(40), .rKnee: Self.bend(25),
                    .rShoulder: Self.flex(170), .rElbow: Self.flex(10),
                    .lShoulder: Self.flex(70), .lElbow: Self.flex(40)]
        case .block:
            return [.lHip: Self.flex(10), .rHip: Self.flex(10), .lKnee: Self.bend(15), .rKnee: Self.bend(15),
                    .lShoulder: Self.flex(170) * Self.abduct(5, left: true), .rShoulder: Self.flex(170) * Self.abduct(5, left: false),
                    .chest: Self.lean(8)]
        case .dig, .lowDefence, .sprawl, .cover:
            return [.spine: Self.lean(35), .chest: Self.lean(10),
                    .lHip: Self.flex(75) * Self.abduct(15, left: true), .rHip: Self.flex(75) * Self.abduct(15, left: false),
                    .lKnee: Self.bend(110), .rKnee: Self.bend(110),
                    .lShoulder: Self.flex(50), .rShoulder: Self.flex(50)]
        case .readyHigh, .landing, .blockLanding:
            return [.spine: Self.lean(10), .lHip: Self.flex(30), .rHip: Self.flex(30), .lKnee: Self.bend(45), .rKnee: Self.bend(45),
                    .lShoulder: Self.flex(30), .rShoulder: Self.flex(30), .lElbow: Self.flex(60), .rElbow: Self.flex(60)]
        case .angledPass:
            return Posture.pass.rotations
        case .overheadPass, .backSet, .jumpSet:
            return Posture.set.rotations
        case .approach:
            return [.spine: Self.lean(35), .lHip: Self.flex(70), .rHip: Self.flex(70), .lKnee: Self.bend(100), .rKnee: Self.bend(100),
                    .lShoulder: Self.flex(-60), .rShoulder: Self.flex(-60)]
        case .armCock, .quickAttack, .floatServe, .jumpServe:
            return Posture.attack.rotations
        case .blockReady:
            return [.lHip: Self.flex(20), .rHip: Self.flex(20), .lKnee: Self.bend(30), .rKnee: Self.bend(30),
                    .lShoulder: Self.flex(60) * Self.abduct(20, left: true), .rShoulder: Self.flex(60) * Self.abduct(20, left: false),
                    .lElbow: Self.flex(100), .rElbow: Self.flex(100)]
        }
    }
}

/// Surface materials of the avatar mesh (the renderer colours them; the jersey takes the team colour).
public enum AvatarMaterial: UInt8, Sendable {
    case skin = 0, jersey, shorts, pads, shoes, hair, socks
}

/// A procedural, anatomically shaped, skinned avatar mesh: tapered limbs with oval cross-sections and muscle bulges,
/// an oval trunk, deltoids, hands, shoes, knee pads and a head with hair, each vertex bound to up to two joints so
/// elbows and knees bend smoothly under dual-quaternion skinning. Built in the rest pose (standing, facing +Z).
public struct AvatarMesh: Sendable {
    public var positions: [V3] = []
    public var normals: [V3] = []
    public var joints: [(Int, Int)] = []
    public var weights: [(Double, Double)] = []
    public var materials: [AvatarMaterial] = []
    public var indices: [UInt32] = []

    public init(skeleton s: SkeletonModel, segments: Int = 16) {
        let rest = s.restPose
        let h = s.metrics.stature
        func pos(_ j: Joint) -> V3 { rest[j.rawValue].translation }
        let x = V3(1, 0, 0), up = V3.up
        let sleeve: (Double) -> AvatarMaterial = { $0 < 0.3 ? .jersey : .skin }
        // Trunk: shorts over the pelvis, jersey from the waist to the shoulders.
        tube(pos(.pelvis) - up * (0.06 * h), pos(.pelvis) + up * (0.045 * h), side: x, r0: (0.104 * h, 0.07 * h),
             r1: (0.094 * h, 0.062 * h), capLength: 0.02 * h,
             driver: .pelvis, blend: .spine, blendFrom: 0.5, material: { _ in .shorts }, segments: segments)
        // The jersey hangs over the waistband: it starts below the shorts' top and is a little wider there.
        tube(pos(.pelvis) + up * (0.03 * h), pos(.chest), side: x, r0: (0.099 * h, 0.067 * h), r1: (0.104 * h, 0.068 * h),
             capLength: 0.01 * h, driver: .spine, blend: .chest, material: { _ in .jersey }, segments: segments)
        // Chest: broadest at the shoulders, sloping to the neck (trapezius) through a long top cap.
        tube(pos(.chest) - up * (0.02 * h), pos(.neck) - up * (0.035 * h), side: x, r0: (0.106 * h, 0.07 * h), r1: (0.116 * h, 0.064 * h),
             capLength: 0.055 * h, driver: .chest, blend: nil, material: { _ in .jersey }, segments: segments)
        // Neck and head (hair over the top and back).
        tube(pos(.neck), pos(.head) + up * (0.025 * h), side: x, r0: (0.03 * h, 0.031 * h), r1: (0.028 * h, 0.03 * h),
             driver: .neck, blend: .head, material: { _ in .skin }, segments: segments)
        let headCentre = pos(.head) + V3(0, 0.06 * h, 0.01 * h)
        ellipsoid(headCentre, radii: V3(0.05 * h, 0.066 * h, 0.058 * h), driver: .head, segments: segments) { p in
            (p.y > headCentre.y + 0.012 * h && p.z < headCentre.z + 0.03 * h) || p.z < headCentre.z - 0.03 * h ? .hair : .skin
        }
        for left in [true, false] {
            let shoulder: Joint = left ? .lShoulder : .rShoulder, elbow: Joint = left ? .lElbow : .rElbow
            let wrist: Joint = left ? .lWrist : .rWrist
            let hip: Joint = left ? .lHip : .rHip, knee: Joint = left ? .lKnee : .rKnee, ankle: Joint = left ? .lAnkle : .rAnkle
            // Deltoid under the sleeve, upper arm, forearm, flat hand (palm toward the thigh at rest).
            tube(pos(shoulder) - up * (0.008 * h), pos(shoulder) - up * (0.06 * h), side: x, r0: (0.034 * h, 0.033 * h),
                 r1: (0.031 * h, 0.031 * h), capLength: 0.022 * h, driver: shoulder, blend: nil, material: { _ in .jersey }, segments: segments)
            tube(pos(shoulder), pos(elbow), side: x, r0: (0.031 * h, 0.032 * h), r1: (0.022 * h, 0.023 * h), bulge: 0.14, bulgeAt: 0.42,
                 driver: shoulder, blend: elbow, material: sleeve, segments: segments)
            tube(pos(elbow), pos(wrist), side: x, r0: (0.022 * h, 0.023 * h), r1: (0.015 * h, 0.017 * h), bulge: 0.16, bulgeAt: 0.25,
                 driver: elbow, blend: wrist, material: { _ in .skin }, segments: segments)
            tube(pos(wrist), pos(wrist) - up * s.handLength, side: x, r0: (0.011 * h, 0.026 * h), r1: (0.008 * h, 0.021 * h),
                 driver: wrist, blend: nil, material: { _ in .skin }, segments: segments)
            // Thigh (shorts over the top), knee pad, shank with the calf, sock, shoe.
            tube(pos(hip), pos(knee), side: x, r0: (0.056 * h, 0.06 * h), r1: (0.034 * h, 0.036 * h), bulge: 0.08, bulgeAt: 0.3,
                 driver: hip, blend: knee, material: { $0 < 0.32 ? .shorts : .skin }, segments: segments)
            tube(pos(knee) + up * (0.032 * h) + V3(0, 0, 0.004 * h), pos(knee) - up * (0.03 * h) + V3(0, 0, 0.004 * h), side: x,
                 r0: (0.038 * h, 0.04 * h), r1: (0.037 * h, 0.039 * h), capLength: 0.012 * h,
                 driver: hip, blend: knee, blendFrom: 0, material: { _ in .pads }, segments: segments)
            tube(pos(knee), pos(ankle), side: x, r0: (0.033 * h, 0.036 * h), r1: (0.02 * h, 0.022 * h), bulge: 0.22, bulgeAt: 0.28,
                 driver: knee, blend: ankle, material: { $0 > 0.78 ? .socks : .skin }, segments: segments)
            tube(pos(ankle) + V3(0, -0.024 * h, -0.032 * h), pos(ankle) + V3(0, -0.03 * h, 0.118 * h), side: x,
                 r0: (0.025 * h, 0.024 * h), r1: (0.027 * h, 0.016 * h), capLength: 0.02 * h,
                 driver: ankle, blend: nil, material: { _ in .shoes }, segments: segments)
        }
    }

    /// A tapered tube from a to b with an elliptical cross-section (half-width along `side`, half-depth across),
    /// a muscle bulge, and ellipsoidal end caps. Vertices near b blend into `blend` so joints bend smoothly.
    private mutating func tube(_ a: V3, _ b: V3, side: V3, r0: (Double, Double), r1: (Double, Double),
                               bulge: Double = 0, bulgeAt: Double = 0.5, capLength: Double? = nil,
                               driver: Joint, blend: Joint?, blendFrom: Double = 0.7,
                               material: (Double) -> AvatarMaterial, rings: Int = 10, segments: Int) {
        let axis = b - a
        let len = axis.length
        guard len > 1e-6 else { return }
        let dir = axis * (1 / len)
        var u = side - dir * side.dot(dir)
        if u.length < 1e-6 { u = V3(0, 0, 1) - dir * dir.z }
        u = u.normalized
        let v = dir.cross(u)
        func radii(_ t: Double) -> (Double, Double) {
            let t = max(0, min(1, t))
            let k = 1 + bulge * exp(-((t - bulgeAt) / 0.28) * ((t - bulgeAt) / 0.28))
            return ((r0.0 + (r1.0 - r0.0) * t) * k, (r0.1 + (r1.1 - r0.1) * t) * k)
        }
        let slope = ((r1.0 + r1.1) - (r0.0 + r0.1)) / 2 / len
        // Rows: start cap (pole to equator), tube, end cap (equator to pole). Each row: (t along a-b, centre, w, d, cap angle).
        let capRings = 4
        var rows: [(t: Double, centre: V3, w: Double, d: Double, theta: Double, capLen: Double)] = []
        let c0 = capLength ?? min(r0.0, r0.1) * 0.9, c1 = capLength ?? min(r1.0, r1.1) * 0.9
        for i in 0..<capRings {
            let theta = -Double.pi / 2 * (1 - Double(i) / Double(capRings)) * 0.98
            let (w, d) = radii(0)
            rows.append((sin(theta) * c0 / len, a + dir * (sin(theta) * c0), w * cos(theta), d * cos(theta), theta, c0))
        }
        for i in 0...rings {
            let t = Double(i) / Double(rings)
            let (w, d) = radii(t)
            rows.append((t, a + dir * (len * t), w, d, 0, 0))
        }
        for i in 1...capRings {
            let theta = Double.pi / 2 * Double(i) / Double(capRings) * 0.98
            let (w, d) = radii(1)
            rows.append((1 + sin(theta) * c1 / len, b + dir * (sin(theta) * c1), w * cos(theta), d * cos(theta), theta, c1))
        }
        let base = UInt32(positions.count)
        for row in rows {
            let (wFull, dFull) = radii(row.t)
            for k in 0..<segments {
                let phi = 2 * Double.pi * Double(k) / Double(segments)
                let p = row.centre + u * (row.w * cos(phi)) + v * (row.d * sin(phi))
                var n = u * (cos(phi) / max(wFull, 1e-6)) + v * (sin(phi) / max(dFull, 1e-6))
                if row.theta != 0 {
                    n = n * cos(row.theta) + dir * (sin(row.theta) / max(row.capLen, 1e-6))
                } else {
                    n = n.normalized - dir * slope
                }
                positions.append(p)
                normals.append(n.normalized)
                let w = blend == nil ? 0 : max(0, min(0.5, (row.t - blendFrom) / (2 * max(1 - blendFrom, 1e-6))))
                joints.append((driver.rawValue, (blend ?? driver).rawValue))
                weights.append((1 - w, w))
                materials.append(material(max(0, min(1, row.t))))
            }
        }
        for i in 0..<(rows.count - 1) {
            for k in 0..<segments {
                let a0 = base + UInt32(i * segments + k), a1 = base + UInt32(i * segments + (k + 1) % segments)
                let b0 = a0 + UInt32(segments), b1 = a1 + UInt32(segments)
                indices += [a0, b0, a1, a1, b0, b1]
            }
        }
    }

    private mutating func ellipsoid(_ c: V3, radii r: V3, driver: Joint, segments: Int, material: (V3) -> AvatarMaterial) {
        let rings = segments
        let base = UInt32(positions.count)
        for i in 0...rings {
            let theta = -Double.pi / 2 + .pi * Double(i) / Double(rings)
            for k in 0..<segments {
                let phi = 2 * Double.pi * Double(k) / Double(segments)
                let unit = V3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi))
                let p = c + V3(unit.x * r.x, unit.y * r.y, unit.z * r.z)
                positions.append(p)
                normals.append(V3(unit.x / r.x, unit.y / r.y, unit.z / r.z).normalized)
                joints.append((driver.rawValue, driver.rawValue))
                weights.append((1, 0))
                materials.append(material(p))
            }
        }
        for i in 0..<rings {
            for k in 0..<segments {
                let a0 = base + UInt32(i * segments + k), a1 = base + UInt32(i * segments + (k + 1) % segments)
                let b0 = a0 + UInt32(segments), b1 = a1 + UInt32(segments)
                indices += [a0, a1, b0, a1, b1, b0]
            }
        }
    }
}
