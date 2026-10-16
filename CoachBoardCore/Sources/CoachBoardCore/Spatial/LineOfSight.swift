import Foundation

/// Parts of the occluder model (Section 5.6), named for readouts such as "blocked by #14 left forearm".
public enum OccluderPart: String, Codable, Sendable, Hashable {
    case head, torso
    case leftUpperArm, leftForearm, leftHand, rightUpperArm, rightForearm, rightHand
    case leftThigh, leftShank, rightThigh, rightShank
    case netTape, netBand, antenna, post

    public var title: String {
        switch self {
        case .head: return "head"
        case .torso: return "torso"
        case .leftUpperArm: return "left upper arm"
        case .leftForearm: return "left forearm"
        case .leftHand: return "left hand"
        case .rightUpperArm: return "right upper arm"
        case .rightForearm: return "right forearm"
        case .rightHand: return "right hand"
        case .leftThigh: return "left thigh"
        case .leftShank: return "left shank"
        case .rightThigh: return "right thigh"
        case .rightShank: return "right shank"
        case .netTape: return "net tape"
        case .netBand: return "net bottom band"
        case .antenna: return "antenna"
        case .post: return "post"
        }
    }
}

/// A capsule (segment a-b inflated by `radius`; a sphere when a == b) in the shared body model of Section 5.
public struct Capsule: Hashable, Sendable {
    public var a: V3
    public var b: V3
    public var radius: Double
    public var owner: UUID?
    /// Short owner label for readouts, e.g. "#14".
    public var ownerLabel: String
    public var part: OccluderPart

    public init(a: V3, b: V3, radius: Double, owner: UUID? = nil, ownerLabel: String = "", part: OccluderPart) {
        self.a = a
        self.b = b
        self.radius = radius
        self.owner = owner
        self.ownerLabel = ownerLabel
        self.part = part
    }

    public var title: String { ownerLabel.isEmpty ? part.title : "\(ownerLabel) \(part.title)" }

    /// Nearest intersection distance along a ray (unit direction) at or beyond the origin, or nil.
    public func intersect(origin o: V3, direction d: V3) -> Double? {
        if (b - a).length < 1e-9 { return Self.raySphere(o, d, a, radius) }
        return Self.rayCapsule(o, d, a, b, radius)
    }

    /// Ray versus capsule, Quilez's closed form: the cylinder body first, then the end caps.
    static func rayCapsule(_ o: V3, _ d: V3, _ a: V3, _ b: V3, _ r: Double) -> Double? {
        let ba = b - a, oa = o - a
        let baba = ba.dot(ba), bard = ba.dot(d), baoa = ba.dot(oa)
        let rdoa = d.dot(oa), oaoa = oa.dot(oa)
        let k2 = baba - bard * bard
        let k1 = baba * rdoa - baoa * bard
        let k0 = baba * oaoa - baoa * baoa - r * r * baba
        if k2 > 1e-12 {
            let h = k1 * k1 - k2 * k0
            if h < 0 { return nil }
            let t = (-k1 - h.squareRoot()) / k2
            let y = baoa + t * bard
            if y > 0 && y < baba { return t >= 0 ? t : nil }
            return raySphere(o, d, y <= 0 ? a : b, r)
        }
        // Parallel to the axis: only the caps can be hit first.
        return [raySphere(o, d, a, r), raySphere(o, d, b, r)].compactMap { $0 }.min()
    }

    static func raySphere(_ o: V3, _ d: V3, _ c: V3, _ r: Double) -> Double? {
        let oc = o - c
        let b = oc.dot(d), c2 = oc.dot(oc) - r * r
        let h = b * b - c2
        guard h >= 0 else { return nil }
        let t = -b - h.squareRoot()
        return t >= 0 ? t : nil
    }
}

/// The capsule model of every body and the net (Section 5.6).
public enum OccluderModel {
    /// Capsules of a posed avatar. Radii are the blueprint's for a 1.90 m athlete, scaled by stature.
    public static func body(_ s: SkeletonModel, posed: [Rigid], owner: UUID? = nil, label: String = "") -> [Capsule] {
        let k = s.metrics.stature / 1.90
        func p(_ j: Joint) -> V3 { posed[j.rawValue].translation }
        func cap(_ a: V3, _ b: V3, _ r: Double, _ part: OccluderPart) -> Capsule {
            Capsule(a: a, b: b, radius: r * k, owner: owner, ownerLabel: label, part: part)
        }
        let h = s.metrics.stature
        let headCentre = posed[Joint.head.rawValue].apply(V3(0, 0.06 * h, 0.01 * h))
        return [
            cap(p(.pelvis), p(.neck), 0.15, .torso),
            cap(headCentre, headCentre, 0.10, .head),
            cap(p(.lShoulder), p(.lElbow), 0.05, .leftUpperArm),
            cap(p(.lElbow), p(.lWrist), 0.04, .leftForearm),
            cap(p(.lWrist), s.fingertip(posed, left: true), 0.045, .leftHand),
            cap(p(.rShoulder), p(.rElbow), 0.05, .rightUpperArm),
            cap(p(.rElbow), p(.rWrist), 0.04, .rightForearm),
            cap(p(.rWrist), s.fingertip(posed, left: false), 0.045, .rightHand),
            cap(p(.lHip), p(.lKnee), 0.08, .leftThigh),
            cap(p(.lKnee), p(.lAnkle), 0.06, .leftShank),
            cap(p(.rHip), p(.rKnee), 0.08, .rightThigh),
            cap(p(.rKnee), p(.rAnkle), 0.06, .rightShank),
        ]
    }

    /// The opaque parts of the net: the 7 cm tape, the 5 cm bottom band, the antennas (5 mm radius) and the posts.
    /// The 10 cm mesh transmits about 94% of light and is not an occluder (rays through it are labelled instead).
    public static func net(height nh: Double) -> [Capsule] {
        var out = [
            Capsule(a: V3(-4.95, nh - 0.035, 0), b: V3(4.95, nh - 0.035, 0), radius: 0.035, part: .netTape),
            Capsule(a: V3(-4.95, nh - 0.975, 0), b: V3(4.95, nh - 0.975, 0), radius: 0.025, part: .netBand),
        ]
        for s in [-1.0, 1.0] {
            out.append(Capsule(a: V3(s * 4.55, nh - 1, 0), b: V3(s * 4.55, nh + 0.8, 0), radius: 0.005, part: .antenna))
            out.append(Capsule(a: V3(s * 5.5, 0, 0), b: V3(s * 5.5, nh + 0.12, 0), radius: 0.05, part: .post))
        }
        return out
    }

    /// The ray passes through the net mesh (between the bands and the antennas) before reaching `distance`.
    public static func crossesMesh(origin o: V3, direction d: V3, distance: Double, netHeight nh: Double) -> Bool {
        guard abs(d.z) > 1e-9 else { return false }
        let t = -o.z / d.z
        guard t > 0, t < distance else { return false }
        let p = o + d * t
        return abs(p.x) < 4.5 && p.y > nh - 1 && p.y < nh
    }
}

/// Line of sight to a target sphere (Section 5.6): 16 rays from the eye to well-spread points on the target's disc;
/// a ray is visible if its first hit is farther than the target.
public struct Visibility: Hashable, Sendable {
    public var fraction: Double
    /// The occluder that blocks the most rays, for the readout.
    public var blocker: Capsule?
    /// Where the central ray (or the first blocked ray) is first occluded.
    public var occlusionPoint: V3?
    public var throughNet: Bool

    /// "27% visible - blocked by #14 left forearm", or "visible" / "visible through net".
    public var readout: String {
        let pct = Int((fraction * 100).rounded())
        if let blocker, pct < 100 { return "\(pct)% visible \u{2014} blocked by \(blocker.title)" }
        return throughNet ? "\(pct)% visible through net" : "\(pct)% visible"
    }
}

public enum LineOfSight {
    /// Unit-disc sample points: a golden-angle (Vogel) spiral, an even, deterministic stand-in for Poisson disc samples.
    public static let disc: [(Double, Double)] = (0..<16).map { i in
        let r = ((Double(i) + 0.5) / 16).squareRoot()
        let a = Double(i) * 2.399963229728653
        return (r * cos(a), r * sin(a))
    }

    /// `viewer` is the POV player: their own head and torso never occlude (the eye sits there), but their arms and
    /// hands do, so a blocker sees their own hands. Capsules of `targetOwner` that overlap the target are skipped.
    public static func visibility(eye: V3, target: V3, radius: Double, occluders: [Capsule], netHeight: Double = 2.43,
                                  viewer: UUID? = nil, targetOwner: UUID? = nil) -> Visibility {
        let occluders = occluders.filter { c in
            if let viewer, c.owner == viewer, c.part == .head || c.part == .torso { return false }
            if let targetOwner, c.owner == targetOwner, segmentDistance(target, c.a, c.b) < c.radius + radius { return false }
            return true
        }
        let axis = (target - eye).normalized
        let ref = abs(axis.y) < 0.9 ? V3.up : V3(1, 0, 0)
        let u = axis.cross(ref).normalized, v = axis.cross(u)
        var visible = 0
        var counts: [Capsule: Int] = [:]
        var occlusion: V3?
        var throughNet = false
        for (i, (x, y)) in disc.enumerated() {
            let p = target + u * (x * radius) + v * (y * radius)
            let d = (p - eye).normalized
            let dist = (p - eye).length
            var first: (Double, Capsule)?
            for c in occluders {
                if let t = c.intersect(origin: eye, direction: d), t < dist - 1e-6, t < (first?.0 ?? .infinity) { first = (t, c) }
            }
            if let (t, c) = first {
                counts[c, default: 0] += 1
                if occlusion == nil || i == 0 { occlusion = eye + d * t }
            } else {
                visible += 1
                if OccluderModel.crossesMesh(origin: eye, direction: d, distance: dist, netHeight: netHeight) { throughNet = true }
            }
        }
        let blocker = counts.max { $0.value < $1.value }?.key
        return Visibility(fraction: Double(visible) / Double(disc.count), blocker: blocker, occlusionPoint: occlusion, throughNet: throughNet)
    }

    static func segmentDistance(_ p: V3, _ a: V3, _ b: V3) -> Double {
        let ab = b - a
        let l2 = ab.dot(ab)
        let t = l2 > 0 ? max(0, min(1, (p - a).dot(ab) / l2)) : 0
        return (p - (a + ab * t)).length
    }
}

/// The three visual-field bands of Section 5.7 around the head-forward direction.
public enum VisualBand: String, Codable, Sendable, Hashable {
    case foveal, central, peripheral, outside

    public var title: String { rawValue }
}

public struct VisualField: Hashable, Sendable {
    /// Half-angles in degrees.
    public var foveal = 2.5
    public var central = 30.0
    public var peripheralHorizontal = 90.0
    public var peripheralUp = 50.0
    public var peripheralDown = 70.0

    public init() {}

    /// The band of a direction and its angle from forward (degrees). Foveal and central are cones; the peripheral
    /// limit is an ellipse in (horizontal, vertical) angle with the upper or lower vertical limit by sign.
    public func classify(_ direction: V3, forward f: V3, up: V3) -> (band: VisualBand, angle: Double) {
        let u = direction.normalized, fw = f.normalized
        let right = fw.cross(up).normalized
        let w = right.cross(fw)
        let angle = acos(max(-1, min(1, u.dot(fw)))) * 180 / .pi
        if angle <= foveal { return (.foveal, angle) }
        if angle <= central { return (.central, angle) }
        let th = atan2(u.dot(right), u.dot(fw)) * 180 / .pi
        let tv = atan2(u.dot(w), (u.dot(fw) * u.dot(fw) + u.dot(right) * u.dot(right)).squareRoot()) * 180 / .pi
        let av = tv >= 0 ? peripheralUp : peripheralDown
        let e = (th / peripheralHorizontal) * (th / peripheralHorizontal) + (tv / av) * (tv / av)
        return (e <= 1 ? .peripheral : .outside, angle)
    }
}
