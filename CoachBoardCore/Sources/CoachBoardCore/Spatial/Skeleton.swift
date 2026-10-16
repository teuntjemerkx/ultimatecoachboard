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
    /// (radians from world +Z toward +X), lifted by `jump` metres. Feet are put on the floor unless airborne.
    public func pose(_ posture: Posture, position: FloorPoint, facing: Double, jump: Double = 0) -> [Rigid] {
        var world = [Rigid](repeating: .identity, count: Joint.allCases.count)
        let rot = posture.rotations
        for j in Joint.allCases {
            var offset = restOffsets[j.rawValue]
            // Raising an arm overhead lifts the shoulder (clavicle elevation), which the reach measurement includes.
            if j == .lShoulder || j == .rShoulder {
                offset.y += Self.shoulderElevation * metrics.stature * posture.shoulderLift(left: j == .lShoulder)
            }
            let local = Rigid(rotation: rot[j] ?? .identity, translation: offset)
            if let p = j.parent {
                world[j.rawValue] = world[p.rawValue] * local
            } else {
                // Root: pelvis height reduced by the posture's crouch, rotated to face the requested direction.
                world[j.rawValue] = Rigid(rotation: Quat(axis: .up, angle: facing), translation: .zero) * local
            }
        }
        // Ground contact: the lower ankle sits at ankle height (feet on the floor); a jump lifts the body.
        let lowest = min(world[Joint.lAnkle.rawValue].translation.y, world[Joint.rAnkle.rawValue].translation.y)
        let lift = ankleHeight - lowest + max(jump, 0)
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

/// The posture library (Section 5.2): joint rotations relative to the rest pose. Angles are anatomical:
/// flexion bends a limb forward (+Z in the body frame), abduction lifts it sideways.
public enum Posture: String, CaseIterable, Codable, Sendable {
    case standing, ready, pass, set, attack, block, dig, reach

    /// How far each shoulder is elevated (0...1): arms overhead lift it fully.
    public func shoulderLift(left: Bool) -> Double {
        switch self {
        case .reach: return left ? 1 : 0
        case .block, .set: return 1
        case .attack: return left ? 0 : 1
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
        case .dig:
            return [.spine: Self.lean(35), .chest: Self.lean(10),
                    .lHip: Self.flex(75) * Self.abduct(15, left: true), .rHip: Self.flex(75) * Self.abduct(15, left: false),
                    .lKnee: Self.bend(110), .rKnee: Self.bend(110),
                    .lShoulder: Self.flex(50), .rShoulder: Self.flex(50)]
        }
    }
}

/// A procedural, skinned avatar mesh: capsules along the bones, a sphere for the head, each vertex bound to
/// up to two joints so elbows and knees bend smoothly under dual-quaternion skinning.
public struct AvatarMesh: Sendable {
    public var positions: [V3] = []
    public var normals: [V3] = []
    public var joints: [(Int, Int)] = []
    public var weights: [(Double, Double)] = []
    public var indices: [UInt32] = []

    public init(skeleton s: SkeletonModel, rings: Int = 8, segments: Int = 12) {
        let rest = s.restPose
        let h = s.metrics.stature
        func pos(_ j: Joint) -> V3 { rest[j.rawValue].translation }
        // (from joint, to point, radius, joint that drives it, joint it blends into near the far end)
        let hand = { (w: Joint) -> V3 in pos(w) + V3(0, -s.handLength, 0) }
        let foot = { (a: Joint) -> V3 in pos(a) + V3(0, -s.ankleHeight * 0.6, 0.12 * h) }
        let bones: [(Joint, V3, Double, Joint, Joint?)] = [
            (.pelvis, pos(.spine), 0.085 * h, .pelvis, .spine),
            (.spine, pos(.chest), 0.095 * h, .spine, .chest),
            (.chest, pos(.neck), 0.105 * h, .chest, nil),
            (.neck, pos(.head), 0.032 * h, .neck, .head),
            (.lShoulder, pos(.lElbow), 0.036 * h, .lShoulder, .lElbow),
            (.lElbow, pos(.lWrist), 0.030 * h, .lElbow, .lWrist),
            (.lWrist, hand(.lWrist), 0.024 * h, .lWrist, nil),
            (.rShoulder, pos(.rElbow), 0.036 * h, .rShoulder, .rElbow),
            (.rElbow, pos(.rWrist), 0.030 * h, .rElbow, .rWrist),
            (.rWrist, hand(.rWrist), 0.024 * h, .rWrist, nil),
            (.lHip, pos(.lKnee), 0.055 * h, .lHip, .lKnee),
            (.lKnee, pos(.lAnkle), 0.042 * h, .lKnee, .lAnkle),
            (.lAnkle, foot(.lAnkle), 0.030 * h, .lAnkle, nil),
            (.rHip, pos(.rKnee), 0.055 * h, .rHip, .rKnee),
            (.rKnee, pos(.rAnkle), 0.042 * h, .rKnee, .rAnkle),
            (.rAnkle, foot(.rAnkle), 0.030 * h, .rAnkle, nil),
            (.chest, pos(.lShoulder), 0.045 * h, .chest, .lShoulder),
            (.chest, pos(.rShoulder), 0.045 * h, .chest, .rShoulder),
        ]
        for (from, to, radius, driver, blend) in bones {
            capsule(from: pos(from), to: to, radius: radius, driver: driver.rawValue, blend: blend?.rawValue,
                    rings: rings, segments: segments)
        }
        sphere(center: pos(.head) + V3(0, 0.06 * h, 0.01 * h), radius: 0.065 * h, joint: Joint.head.rawValue,
               rings: rings * 2, segments: segments)
    }

    private mutating func capsule(from a: V3, to b: V3, radius r: Double, driver: Int, blend: Int?, rings: Int, segments: Int) {
        let axis = b - a
        let len = axis.length
        guard len > 1e-6 else { return }
        let dir = axis * (1 / len)
        let ref = abs(dir.y) < 0.9 ? V3.up : V3(1, 0, 0)
        let u = dir.cross(ref).normalized, v = dir.cross(u)
        let base = UInt32(positions.count)
        // Hemisphere at a, cylinder, hemisphere at b: latitude from -pi/2 to pi/2 split around the cylinder.
        let lat = rings * 2 + 2
        for i in 0...lat {
            let f = Double(i) / Double(lat)
            let theta = -Double.pi / 2 + .pi * f
            let along = f < 0.5 ? 0.0 : len
            let center = a + dir * along
            for k in 0..<segments {
                let phi = 2 * Double.pi * Double(k) / Double(segments)
                let radial = u * cos(phi) + v * sin(phi)
                let n = (radial * cos(theta) + dir * sin(theta)).normalized
                positions.append(center + n * r)
                normals.append(n)
                // Blend into the child joint over the last 30% of the bone so the bend is smooth.
                let s = (center + n * r - a).dot(dir) / len
                let w = blend == nil ? 0 : max(0, min(0.5, (s - 0.7) / 0.6))
                joints.append((driver, blend ?? driver))
                weights.append((1 - w, w))
            }
        }
        for i in 0..<lat {
            for k in 0..<segments {
                let a0 = base + UInt32(i * segments + k), a1 = base + UInt32(i * segments + (k + 1) % segments)
                let b0 = a0 + UInt32(segments), b1 = a1 + UInt32(segments)
                indices += [a0, b0, a1, a1, b0, b1]
            }
        }
    }

    private mutating func sphere(center c: V3, radius r: Double, joint: Int, rings: Int, segments: Int) {
        let base = UInt32(positions.count)
        for i in 0...rings {
            let theta = -Double.pi / 2 + .pi * Double(i) / Double(rings)
            for k in 0..<segments {
                let phi = 2 * Double.pi * Double(k) / Double(segments)
                let n = V3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi))
                positions.append(c + n * r)
                normals.append(n)
                joints.append((joint, joint))
                weights.append((1, 0))
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
