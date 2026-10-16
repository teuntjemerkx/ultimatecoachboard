import Foundation

/// A player of a scene frame with its fitted skeleton and posed joints.
public struct PosedPlayer: Sendable {
    public var token: SceneToken
    public var skeleton: SkeletonModel
    public var joints: [Rigid]

    public var id: UUID { token.id }
    public var label: String { token.side == .home ? "#\(token.label)" : token.label }

    public var headCentre: V3 {
        joints[Joint.head.rawValue].apply(V3(0, 0.06 * skeleton.metrics.stature, 0.01 * skeleton.metrics.stature))
    }

    /// Right-handed by default: the right shoulder.
    public var hittingShoulder: V3 { joints[Joint.rShoulder.rawValue].translation }
}

/// Whose bodies the defaults describe: women or men (the research library's "elite_women" and "elite_men" figures,
/// and the net height that goes with them). The app sets it once from its settings.
public enum PlayerBodies {
    nonisolated(unsafe) public static var women = false

    public static var group: String { women ? "elite_women" : "elite_men" }

    /// The net: 2.24 m women, 2.43 m men.
    public static var netHeight: Double { women ? 2.24 : 2.43 }
}

extension SceneToken {
    /// Default stature by role when none is set (metres): the research library's elite figure for the position
    /// (women or men, see `PlayerBodies`) when it has one, else liberos shortest and middles tallest.
    public static func defaultStature(role: String) -> Double {
        if let position = PostureLibrary.position(forRole: role),
           let h = PostureLibrary.shared.positions[position]?.traits?.stature_m?[PlayerBodies.group], (1.5...2.3).contains(h) {
            return h
        }
        let shift = PlayerBodies.women ? -0.13 : 0
        switch role {
        case "L": return 1.80 + shift
        case "S", "S1", "S2": return 1.90 + shift
        case "MB", "MB1", "MB2", "M", "M1", "M2": return 2.02 + shift
        default: return 1.95 + shift
        }
    }

    public var effectiveStature: Double { stature ?? Self.defaultStature(role: role) }
}

extension SceneFrame {
    /// Every player posed for this frame (posture blends applied).
    public func posedPlayers() -> [PosedPlayer] {
        tokens.map { t in
            let s = SkeletonModel(BodyMetrics(stature: t.effectiveStature))
            let posture = t.posture ?? SceneToken.automaticPosture(at: t.point)
            let joints = postureBlends[t.id].map { s.pose($0, position: t.point, facing: t.facing, role: t.role) }
                ?? s.pose(posture, position: t.point, facing: t.facing, role: t.role)
            return PosedPlayer(token: t, skeleton: s, joints: joints)
        }
    }
}

/// One gaze ray of a POV player (Section 5.6) with its visual-field band (5.7).
public struct GazeReadout: Hashable, Sendable {
    public enum Aim: String, Sendable { case head, hittingShoulder, ball }

    public var targetID: UUID
    public var targetLabel: String
    public var aim: Aim
    public var point: V3
    public var visibility: Visibility
    public var band: VisualBand
    public var angle: Double

    /// "MB1 hitting shoulder · central 12° · 100% visible"
    public var text: String {
        let what: String
        switch aim {
        case .head: what = "\(targetLabel) head"
        case .hittingShoulder: what = "\(targetLabel) hitting shoulder"
        case .ball: what = "Ball"
        }
        return "\(what) \u{00B7} \(band.title) \(Int(angle.rounded()))\u{00B0} \u{00B7} \(visibility.readout)"
    }
}

public enum Gaze {
    /// Default targets for a POV player in a manual scene: the opposing setter's head and the opposing front row's
    /// hitting shoulders (the read cues of Section 5.3).
    public static func defaultTargets(for viewer: PosedPlayer, among players: [PosedPlayer]) -> [(UUID, GazeReadout.Aim)] {
        let opponents = players.filter { $0.token.side != viewer.token.side }
        var out: [(UUID, GazeReadout.Aim)] = []
        if let setter = opponents.first(where: { ["S", "S1", "S2"].contains($0.token.role) }) { out.append((setter.id, .head)) }
        for p in opponents where abs(p.token.point.z) < 4.5 && !["S", "S1", "S2"].contains(p.token.role) {
            out.append((p.id, .hittingShoulder))
        }
        return out
    }

    /// The ball's identity as a gaze target.
    public static let ballID = UUID(uuidString: "BA11BA11-0000-4000-8000-000000000000")!

    /// Visibility and band of each target from the viewer's eye; the occluders are every body and the net.
    /// With a ball position, the ball (radius 0.105 m) is the first target.
    public static func readouts(viewer: PosedPlayer, pov: CameraPose, targets: [(UUID, GazeReadout.Aim)], players: [PosedPlayer],
                                netHeight: Double, ball: V3? = nil, field: VisualField = VisualField()) -> [GazeReadout] {
        let occluders = players.flatMap { OccluderModel.body($0.skeleton, posed: $0.joints, owner: $0.id, label: $0.label) }
            + OccluderModel.net(height: netHeight)
        var out: [GazeReadout] = []
        if let ball {
            let vis = LineOfSight.visibility(eye: pov.eye, target: ball, radius: BallFlight.radius, occluders: occluders,
                                             netHeight: netHeight, viewer: viewer.id)
            let (band, angle) = field.classify(ball - pov.eye, forward: pov.forward, up: .up)
            out.append(GazeReadout(targetID: ballID, targetLabel: "Ball", aim: .ball, point: ball, visibility: vis, band: band, angle: angle))
        }
        return out + targets.compactMap { id, aim in
            guard let t = players.first(where: { $0.id == id }), id != viewer.id else { return nil }
            let k = t.skeleton.metrics.stature / 1.90
            let point = aim == .head ? t.headCentre : t.hittingShoulder
            let radius = (aim == .head ? 0.10 : 0.08) * k
            guard aim != .ball else { return nil }
            let vis = LineOfSight.visibility(eye: pov.eye, target: point, radius: radius, occluders: occluders,
                                             netHeight: netHeight, viewer: viewer.id, targetOwner: id)
            let (band, angle) = field.classify(point - pov.eye, forward: pov.forward, up: .up)
            return GazeReadout(targetID: id, targetLabel: t.label, aim: aim, point: point, visibility: vis, band: band, angle: angle)
        }
    }
}
