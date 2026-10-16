import CoreGraphics
import CoachBoardCore

/// Maps the world frame (metres) to view points for the 2D blueprint camera (blueprint Section 1.4).
///
/// Landscape, sideline-true: the net is vertical in the middle; by default the home half is on the left, as seen
/// from the bench. Portrait (when Settings > Court is "Fill the screen"): the court stands upright so it fills the
/// screen, the home half at the bottom as seen from behind the home end line. `flipped` turns either 180 degrees
/// (Switch Ends, Player-Facing Flip).
struct BoardGeometry: Equatable {
    var size: CGSize
    var margin: Double = 2.4          // visible free zone in metres (keeps a server behind the end line in view)
    var homeOnLeft: Bool = true
    var playerFacingFlip: Bool = false

    private var flipped: Bool { homeOnLeft == playerFacingFlip }
    var isFlipped: Bool { flipped }

    /// The court's long axis runs down the screen (portrait views, when the orientation setting allows it).
    var vertical: Bool {
        ThemeStore.shared.courtOrientation == .auto && size.height > size.width * 1.1
    }

    /// view = centre + scale * M * (x, z): M's rows as (a, b) and (c, d).
    private var m: (a: CGFloat, b: CGFloat, c: CGFloat, d: CGFloat) {
        switch (vertical, flipped) {
        case (false, false): return (0, -1, 1, 0)      // home (+Z) left, home's right (+X) down
        case (false, true): return (0, 1, -1, 0)
        case (true, false): return (1, 0, 0, 1)        // home (+Z) at the bottom, home's right (+X) to the right
        case (true, true): return (-1, 0, 0, -1)
        }
    }

    /// World from view offsets, for shaders: x = dot(r.xy, d), z = dot(r.zw, d) with d = (view - centre) / scale.
    var toWorldRows: SIMD4<Float> {
        let m = self.m
        return SIMD4(Float(m.a), Float(m.c), Float(m.b), Float(m.d))
    }

    var scale: CGFloat {
        let m = margin * 2
        if vertical { return min(size.width / CGFloat(9 + m), size.height / CGFloat(18 + m)) }
        return min(size.width / CGFloat(18 + m), size.height / CGFloat(9 + m))
    }

    var center: CGPoint { CGPoint(x: size.width / 2, y: size.height / 2) }

    func toView(_ p: FloorPoint) -> CGPoint {
        let s = scale, m = self.m
        return CGPoint(x: center.x + s * (m.a * CGFloat(p.x) + m.b * CGFloat(p.z)),
                       y: center.y + s * (m.c * CGFloat(p.x) + m.d * CGFloat(p.z)))
    }

    func toWorld(_ v: CGPoint) -> FloorPoint {
        let s = scale, m = self.m
        let dx = (v.x - center.x) / s, dy = (v.y - center.y) / s
        return FloorPoint(x: Double(m.a * dx + m.c * dy), z: Double(m.b * dx + m.d * dy))
    }

    func toView(_ p: LocalPoint, side: Side) -> CGPoint { toView(CourtFrame.world(p, of: side)) }

    func toLocal(_ v: CGPoint) -> (Side, LocalPoint) {
        let w = toWorld(v)
        let side = CourtFrame.side(of: w)
        return (side, CourtFrame.local(w, for: side))
    }

    /// Which horizontal direction stands for a side on the Point Wheel: toward its half in landscape; in portrait,
    /// where the halves are above and below, home keeps the left unless the ends are switched.
    func screenDirection(of side: Side) -> CGFloat {
        if vertical {
            let homeLeft: CGFloat = flipped ? 1 : -1
            return side == .home ? homeLeft : -homeLeft
        }
        let probe = toView(FloorPoint(x: 0, z: side == .home ? 4 : -4))
        return probe.x < center.x ? -1 : 1
    }

    func metres(_ m: Double) -> CGFloat { CGFloat(m) * scale }
}
