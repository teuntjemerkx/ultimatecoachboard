import Foundation

/// One posture of the research library (Resources/Postures/library.json, built by Verification/build_postures.py
/// from the per-position research files). Angles are anatomical degrees relative to the standing anatomical position;
/// the conventions are in Verification/postures/SCHEMA.md.
public struct PostureSpec: Codable, Hashable, Sendable {
    public struct Root: Codable, Hashable, Sendable {
        public var jump_m: Double?
        public var stance_width_m: Double?
        public var stagger_m: Double?
        public var yaw_deg: Double?

        public init(jump_m: Double? = nil, stance_width_m: Double? = nil, stagger_m: Double? = nil, yaw_deg: Double? = nil) {
            self.jump_m = jump_m
            self.stance_width_m = stance_width_m
            self.stagger_m = stagger_m
            self.yaw_deg = yaw_deg
        }
    }

    public var id: String
    public var name: String
    public var phase: String?
    public var description: String?
    public var root: Root?
    public var angles: [String: Double]
    public var confidence: String?
    public var evidence: [String]?

    public init(id: String, name: String, root: Root? = nil, angles: [String: Double]) {
        self.id = id
        self.name = name
        self.root = root
        self.angles = angles
    }

    public var jump: Double { max(0, root?.jump_m ?? 0) }
}

/// Anthropometrics of a position from the research (metres).
public struct PositionTraits: Codable, Hashable, Sendable {
    public var stature_m: [String: Double]?
    public var standing_reach_m: [String: Double]?
    public var spike_reach_m: [String: Double]?
    public var block_reach_m: [String: Double]?
    public var build_notes: String?
}

/// The research-based posture library: technique id -> position -> posture.
public struct PostureLibrary: Sendable {
    public struct Position: Codable, Sendable {
        public var traits: PositionTraits?
        public var techniques: [PostureSpec]
    }

    struct File: Codable {
        var version: Int
        var positions: [String: Position]
    }

    public var positions: [String: Position]

    public static let shared: PostureLibrary = {
        guard let url = Bundle.module.url(forResource: "library", withExtension: "json", subdirectory: "Resources/Postures"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return PostureLibrary(positions: [:]) }
        return PostureLibrary(positions: file.positions)
    }()

    public init(positions: [String: Position]) { self.positions = positions }

    /// Positions in the order they are preferred when the player's own position has no variant of a technique.
    public static let fallbackOrder = ["outside_hitter", "opposite", "middle_blocker", "setter", "libero"]

    /// Role code (template roles such as "S", "OH1", "MB2", "OPP", "L") to research position.
    public static func position(forRole role: String?) -> String? {
        guard let role else { return nil }
        if role.hasPrefix("OH") { return "outside_hitter" }
        if role.hasPrefix("MB") || role.hasPrefix("M") && role.count <= 2 { return "middle_blocker" }
        if role.hasPrefix("OPP") || role == "O" { return "opposite" }
        if role.hasPrefix("S") { return "setter" }
        if role == "L" || role == "DS" { return "libero" }
        return nil
    }

    /// The variant of a technique for a role's position, else the first measured variant, else any variant.
    public func spec(_ technique: String, role: String?) -> PostureSpec? {
        if let p = Self.position(forRole: role), let s = positions[p]?.techniques.first(where: { $0.id == technique }) { return s }
        let all = Self.fallbackOrder.compactMap { positions[$0]?.techniques.first { $0.id == technique } }
        return all.first { $0.confidence?.hasPrefix("measured") == true } ?? all.first
    }
}

/// Joint rotations plus root motion for one instant: what `SkeletonModel.pose` consumes.
public struct PoseParams: Hashable, Sendable {
    public var rotations: [Joint: Quat]
    /// Feet above the floor (metres).
    public var jump: Double

    public init(rotations: [Joint: Quat], jump: Double = 0) {
        self.rotations = rotations
        self.jump = jump
    }

    /// Grounded postures get flat feet; airborne ones keep their ankle angles (pointed toes).
    public var airborne: Bool { jump > 0.02 }

    /// Joint-wise slerp and a linear jump (Section 3.3: postures blend by quaternion slerp per joint).
    public static func blend(_ a: PoseParams, _ b: PoseParams, _ t: Double) -> PoseParams {
        let t = max(0, min(1, t))
        if t == 0 { return a }
        if t == 1 { return b }
        var r: [Joint: Quat] = [:]
        for j in Joint.allCases {
            let qa = a.rotations[j] ?? .identity, qb = b.rotations[j] ?? .identity
            r[j] = qa.slerp(to: qb, t)
        }
        return PoseParams(rotations: r, jump: a.jump + (b.jump - a.jump) * t)
    }
}

extension PostureSpec {
    private func deg(_ key: String) -> Double { (angles[key] ?? 0) * .pi / 180 }

    private static func rx(_ a: Double) -> Quat { Quat(axis: V3(1, 0, 0), angle: a) }
    private static func ry(_ a: Double) -> Quat { Quat(axis: V3(0, 1, 0), angle: a) }
    private static func rz(_ a: Double) -> Quat { Quat(axis: V3(0, 0, 1), angle: a) }

    /// Anatomical angles to local joint rotations of the 17-joint skeleton (body frame: facing +Z, left +X, up +Y;
    /// limbs hang along -Y in the rest pose). Grounded postures are finished by two-bone leg IK that puts both feet
    /// at the stance width and stagger, flat on the floor.
    public func params(for s: SkeletonModel) -> PoseParams {
        var r: [Joint: Quat] = [:]
        let lateral = deg("trunk_lateral") / 2, twist = deg("trunk_twist") / 2
        r[.pelvis] = Self.ry((root?.yaw_deg ?? 0) * .pi / 180)
        r[.spine] = Self.rx(deg("lumbar_flex")) * Self.rz(lateral) * Self.ry(-twist)
        r[.chest] = Self.rx(deg("thoracic_flex")) * Self.rz(lateral) * Self.ry(-twist)
        r[.neck] = Self.rx(deg("neck_flex") / 2)
        r[.head] = Self.rx(deg("neck_flex") / 2)
        for left in [true, false] {
            let p = left ? "l_" : "r_", side = left ? 1.0 : -1.0
            r[left ? .lShoulder : .rShoulder] = Self.rx(-deg(p + "shoulder_flex")) * Self.rz(side * deg(p + "shoulder_abd"))
                * Self.ry(side * deg(p + "shoulder_ext_rot"))
            r[left ? .lElbow : .rElbow] = Self.rx(-deg(p + "elbow_flex"))
            r[left ? .lWrist : .rWrist] = Self.rx(deg(p + "wrist_ext"))
            r[left ? .lHip : .rHip] = Self.rx(-deg(p + "hip_flex")) * Self.rz(side * deg(p + "hip_abd"))
                * Self.ry(side * deg(p + "hip_ext_rot"))
            r[left ? .lKnee : .rKnee] = Self.rx(deg(p + "knee_flex"))
            r[left ? .lAnkle : .rAnkle] = Self.rx(-deg(p + "ankle_dorsi"))
        }
        var params = PoseParams(rotations: r, jump: jump)
        if !params.airborne { s.solveStance(&params, width: root?.stance_width_m, stagger: root?.stagger_m) }
        return params
    }
}

extension SkeletonModel {
    /// Two-bone IK for both legs in the body frame: the ankles move to the stance width (lateral) and stagger
    /// (right foot ahead positive) at the mean height the angles produce, and each knee keeps pointing where the
    /// angles put it. Hip and knee rotations are replaced; the rest of the posture is untouched.
    func solveStance(_ params: inout PoseParams, width: Double?, stagger: Double?) {
        let pelvisRot = params.rotations[.pelvis] ?? .identity
        let thigh = restOffsets[Joint.lKnee.rawValue].length, shank = restOffsets[Joint.lAnkle.rawValue].length
        struct Leg { var hip: V3; var knee: V3; var ankle: V3 }
        func fk(_ left: Bool) -> Leg {
            let hipJ: Joint = left ? .lHip : .rHip, kneeJ: Joint = left ? .lKnee : .rKnee
            let hip = pelvisRot.rotate(restOffsets[hipJ.rawValue])
            let tw = pelvisRot * (params.rotations[hipJ] ?? .identity)
            let knee = hip + tw.rotate(V3(0, -thigh, 0))
            let sw = tw * (params.rotations[kneeJ] ?? .identity)
            return Leg(hip: hip, knee: knee, ankle: knee + sw.rotate(V3(0, -shank, 0)))
        }
        let l = fk(true), rgt = fk(false)
        // Targets in the pelvis frame (yaw removed), then back.
        let inv = pelvisRot.conjugate
        var la = inv.rotate(l.ankle), ra = inv.rotate(rgt.ankle)
        let y = (la.y + ra.y) / 2
        la.y = y
        ra.y = y
        if let w = width, w > 0 {
            let cx = (la.x + ra.x) / 2
            la.x = cx + w / 2
            ra.x = cx - w / 2
        }
        if let st = stagger {
            let cz = (la.z + ra.z) / 2
            ra.z = cz + st / 2
            la.z = cz - st / 2
        }
        for (left, leg, target) in [(true, l, pelvisRot.rotate(la)), (false, rgt, pelvisRot.rotate(ra))] {
            let v = target - leg.hip
            let dist = max(abs(thigh - shank) + 1e-4, min(thigh + shank - 1e-4, v.length))
            let dir = v.normalized
            let cosA = max(-1, min(1, (thigh * thigh + dist * dist - shank * shank) / (2 * thigh * dist)))
            let sinA = (1 - cosA * cosA).squareRoot()
            // The knee keeps the side the angles gave it (forward and as far out as the hip rotation turns it).
            var pole = (leg.knee - leg.hip) - dir * (leg.knee - leg.hip).dot(dir)
            if pole.length < 1e-6 { pole = pelvisRot.rotate(V3(0, 0, 1)) - dir * pelvisRot.rotate(V3(0, 0, 1)).dot(dir) }
            pole = pole.normalized
            let knee = leg.hip + dir * (thigh * cosA) + pole * (thigh * sinA)
            let ankle = leg.hip + dir * dist
            let thighDir = (knee - leg.hip).normalized, shankDir = (ankle - knee).normalized
            let yAxis = -thighDir
            var zAxis = -(shankDir - thighDir * shankDir.dot(thighDir))
            if zAxis.length < 1e-6 { zAxis = pole }
            zAxis = (zAxis - yAxis * zAxis.dot(yAxis)).normalized
            let xAxis = yAxis.cross(zAxis)
            let thighWorld = Quat(basisX: xAxis, y: yAxis, z: zAxis)
            let kneeFlex = acos(max(-1, min(1, thighDir.dot(shankDir))))
            params.rotations[left ? .lHip : .rHip] = pelvisRot.conjugate * thighWorld
            params.rotations[left ? .lKnee : .rKnee] = Quat(axis: V3(1, 0, 0), angle: kneeFlex)
        }
    }
}
