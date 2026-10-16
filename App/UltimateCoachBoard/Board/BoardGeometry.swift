import CoreGraphics
import CoachBoardCore

/// Maps the world frame (metres) to view points for the 2D blueprint camera (blueprint Section 1.4).
/// Sideline-true orientation: the net is vertical in the middle of the canvas; by default the home half
/// is on the left, as seen from the bench. `flipped` rotates the canvas 180 degrees (Switch Ends,
/// Player-Facing Flip).
struct BoardGeometry: Equatable {
    var size: CGSize
    var margin: Double = 1.5          // visible free zone in metres
    var homeOnLeft: Bool = true
    var playerFacingFlip: Bool = false

    private var flipped: Bool { homeOnLeft == playerFacingFlip }

    var scale: CGFloat {
        let m = margin * 2
        return min(size.width / CGFloat(18 + m), size.height / CGFloat(9 + m))
    }

    var center: CGPoint { CGPoint(x: size.width / 2, y: size.height / 2) }

    /// Home on the left: world +Z (home half) maps to screen left, world +X (home team's right) to screen down.
    func toView(_ p: FloorPoint) -> CGPoint {
        let s = scale
        if !flipped {
            return CGPoint(x: center.x - CGFloat(p.z) * s, y: center.y + CGFloat(p.x) * s)
        }
        return CGPoint(x: center.x + CGFloat(p.z) * s, y: center.y - CGFloat(p.x) * s)
    }

    func toWorld(_ v: CGPoint) -> FloorPoint {
        let s = scale
        if !flipped {
            return FloorPoint(x: Double((v.y - center.y) / s), z: Double((center.x - v.x) / s))
        }
        return FloorPoint(x: Double((center.y - v.y) / s), z: Double((v.x - center.x) / s))
    }

    func toView(_ p: LocalPoint, side: Side) -> CGPoint { toView(CourtFrame.world(p, of: side)) }

    func toLocal(_ v: CGPoint) -> (Side, LocalPoint) {
        let w = toWorld(v)
        let side = CourtFrame.side(of: w)
        return (side, CourtFrame.local(w, for: side))
    }

    /// Which screen direction (x sign) points toward a side's half: used by the Point Wheel.
    func screenDirection(of side: Side) -> CGFloat {
        let probe = toView(FloorPoint(x: 0, z: side == .home ? 4 : -4))
        return probe.x < center.x ? -1 : 1
    }

    func metres(_ m: Double) -> CGFloat { CGFloat(m) * scale }
}
