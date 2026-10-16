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

extension SceneToken {
    /// Default stature by role when none is set (metres): liberos shortest, middles tallest.
    public static func defaultStature(role: String) -> Double {
        switch role {
        case "L": return 1.80
        case "S", "S1", "S2": return 1.90
        case "MB", "MB1", "MB2", "M", "M1", "M2": return 2.02
        default: return 1.95
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
            let joints = postureBlends[t.id].map { s.pose($0, position: t.point, facing: t.facing) }
                ?? s.pose(posture, position: t.point, facing: t.facing)
            return PosedPlayer(token: t, skeleton: s, joints: joints)
        }
    }
}

/// One gaze ray of a POV player (Section 5.6) with its visual-field band (5.7).
public struct GazeReadout: Hashable, Sendable {
    public enum Aim: String, Sendable { case head, hittingShoulder }

    public var targetID: UUID
    public var targetLabel: String
    public var aim: Aim
    public var point: V3
    public var visibility: Visibility
    public var band: VisualBand
    public var angle: Double

    /// "MB1 hitting shoulder · central 12° · 100% visible"
    public var text: String {
        "\(targetLabel) \(aim == .head ? "head" : "hitting shoulder") \u{00B7} \(band.title) \(Int(angle.rounded()))\u{00B0} \u{00B7} \(visibility.readout)"
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

    /// Visibility and band of each target from the viewer's eye; the occluders are every body and the net.
    public static func readouts(viewer: PosedPlayer, pov: CameraPose, targets: [(UUID, GazeReadout.Aim)], players: [PosedPlayer],
                                netHeight: Double, field: VisualField = VisualField()) -> [GazeReadout] {
        let occluders = players.flatMap { OccluderModel.body($0.skeleton, posed: $0.joints, owner: $0.id, label: $0.label) }
            + OccluderModel.net(height: netHeight)
        return targets.compactMap { id, aim in
            guard let t = players.first(where: { $0.id == id }), id != viewer.id else { return nil }
            let k = t.skeleton.metrics.stature / 1.90
            let point = aim == .head ? t.headCentre : t.hittingShoulder
            let radius = (aim == .head ? 0.10 : 0.08) * k
            let vis = LineOfSight.visibility(eye: pov.eye, target: point, radius: radius, occluders: occluders,
                                             netHeight: netHeight, viewer: viewer.id, targetOwner: id)
            let (band, angle) = field.classify(point - pov.eye, forward: pov.forward, up: .up)
            return GazeReadout(targetID: id, targetLabel: t.label, aim: aim, point: point, visibility: vis, band: band, angle: angle)
        }
    }
}
