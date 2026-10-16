import Foundation

/// What a snap attached to, so the canvas can highlight it briefly (Section 3.5.3).
public enum SnapTarget: Hashable, Sendable {
    case line(FloorPoint, FloorPoint)
    case point(FloorPoint)
    case cell(min: FloorPoint, max: FloorPoint)
}

public struct ZoneBuildResult: Hashable, Sendable {
    public var zone: Zone
    public var kind: ShapeKind
    /// The one-tap alternative, when the recognizer was unsure.
    public var alternative: ShapeKind?
    public var snapped: [SnapTarget]
}

/// Court-aware snapping (Section 3.5.3), in world metres.
public enum ZoneSnapping {
    public static let axisTolerance = 7.0 * Double.pi / 180
    public static let lineTolerance = 0.25
    public static let pointTolerance = 0.30
    public static let vertexTolerance = 0.20
    public static let radiusStep = 0.25

    /// Court lines across the court (constant z) and along it (constant x).
    public static let crossLines: [Double] = [-9, -3, 0, 3, 9]
    public static let sideLines: [Double] = [-4.5, 4.5]

    /// The 1.5 m grid of zone cells and sub-cells on both halves.
    static let gridX: [Double] = stride(from: -4.5, through: 4.5, by: 1.5).map { $0 }
    static let gridZ: [Double] = stride(from: -9.0, through: 9.0, by: 1.5).map { $0 }

    /// Centres of 3 x 3 m zones and 1.5 m sub-cells, and the seams (grid crossings) between them.
    static let anchorPoints: [FloorPoint] = {
        var pts: [FloorPoint] = []
        for x in stride(from: -3.75, through: 3.75, by: 1.5) {
            for z in stride(from: -8.25, through: 8.25, by: 1.5) { pts.append(FloorPoint(x: x, z: z)) }
        }
        for x in gridX { for z in gridZ { pts.append(FloorPoint(x: x, z: z)) } }
        for x in [-3.0, 0, 3] { for z in [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5] { pts.append(FloorPoint(x: x, z: z)) } }
        return pts
    }()

    static let lineIntersections: [FloorPoint] = {
        var pts: [FloorPoint] = []
        for x in sideLines + [-1.5, 1.5] { for z in crossLines + [-6, 6] { pts.append(FloorPoint(x: x, z: z)) } }
        return pts
    }()

    static func nearest(_ v: Double, in values: [Double], within tol: Double) -> Double? {
        values.filter { abs($0 - v) <= tol }.min { abs($0 - v) < abs($1 - v) }
    }

    static func nearest(_ p: FloorPoint, in points: [FloorPoint], within tol: Double) -> FloorPoint? {
        points.map { ($0, hypot($0.x - p.x, $0.z - p.z)) }.filter { $0.1 <= tol }.min { $0.1 < $1.1 }?.0
    }

    public static func snap(_ zone: Zone, tokens: [FloorPoint] = [], otherZones: [Zone] = []) -> (Zone, [SnapTarget]) {
        var z = zone
        var hits: [SnapTarget] = []
        switch zone.geometry {
        case let .rect(c, hw, hd, angle):
            var a = angle, w = hw, d = hd
            // Axis alignment within 7 degrees; normalize so the half extents follow the world axes.
            let quarter = Double.pi / 2
            let k = (a / quarter).rounded()
            if abs(a - k * quarter) <= axisTolerance {
                if Int(k) % 2 != 0 { swap(&w, &d) }
                a = 0
            }
            var minX = c.x - w, maxX = c.x + w, minZ = c.z - d, maxZ = c.z + d
            if a == 0 {
                // A rectangle within 0.25 m of a cell or sub-cell on all sides becomes that cell exactly.
                if let x0 = nearest(minX, in: gridX, within: lineTolerance), let x1 = nearest(maxX, in: gridX, within: lineTolerance),
                   let z0 = nearest(minZ, in: gridZ, within: lineTolerance), let z1 = nearest(maxZ, in: gridZ, within: lineTolerance),
                   x1 > x0, z1 > z0 {
                    (minX, maxX, minZ, maxZ) = (x0, x1, z0, z1)
                    hits.append(.cell(min: FloorPoint(x: x0, z: z0), max: FloorPoint(x: x1, z: z1)))
                } else {
                    // Otherwise each edge within 0.25 m of a court line snaps onto it.
                    if let v = nearest(minX, in: sideLines, within: lineTolerance) { minX = v; hits.append(.line(FloorPoint(x: v, z: -9), FloorPoint(x: v, z: 9))) }
                    if let v = nearest(maxX, in: sideLines, within: lineTolerance) { maxX = v; hits.append(.line(FloorPoint(x: v, z: -9), FloorPoint(x: v, z: 9))) }
                    if let v = nearest(minZ, in: crossLines, within: lineTolerance) { minZ = v; hits.append(.line(FloorPoint(x: -4.5, z: v), FloorPoint(x: 4.5, z: v))) }
                    if let v = nearest(maxZ, in: crossLines, within: lineTolerance) { maxZ = v; hits.append(.line(FloorPoint(x: -4.5, z: v), FloorPoint(x: 4.5, z: v))) }
                }
                z.geometry = .rect(center: FloorPoint(x: (minX + maxX) / 2, z: (minZ + maxZ) / 2),
                                   halfWidth: (maxX - minX) / 2, halfDepth: (maxZ - minZ) / 2, angle: 0)
            } else {
                z.geometry = .rect(center: c, halfWidth: w, halfDepth: d, angle: a)
            }
        case let .circle(c, r):
            let (center, hit) = snapCenter(c, tokens: tokens)
            if let hit { hits.append(hit) }
            z.geometry = .circle(center: center, radius: quantize(r))
        case let .ellipse(c, a, b, ang):
            let (center, hit) = snapCenter(c, tokens: tokens)
            if let hit { hits.append(hit) }
            z.geometry = .ellipse(center: center, a: quantize(a), b: quantize(b), angle: ang)
        case let .polygon(v):
            let others = otherZones.flatMap(\.outline)
            z.geometry = .polygon(v.map { p in
                if let q = nearest(p, in: lineIntersections + others, within: vertexTolerance) {
                    hits.append(.point(q))
                    return q
                }
                return p
            })
        case .freeform:
            break
        }
        return (z, hits)
    }

    static func snapCenter(_ c: FloorPoint, tokens: [FloorPoint]) -> (FloorPoint, SnapTarget?) {
        if let t = nearest(c, in: tokens, within: pointTolerance) { return (t, .point(t)) }
        if let a = nearest(c, in: anchorPoints, within: pointTolerance + 0.05) { return (a, .point(a)) }
        return (c, nil)
    }

    static func quantize(_ r: Double) -> Double { max(radiusStep, (r / radiusStep).rounded() * radiusStep) }
}

/// From a stroke on the court to a zone: recognize (Section 3.5.3), build the geometry in world metres, snap.
public enum ZoneBuilder {
    /// - Parameters:
    ///   - stroke: the stroke in world metres.
    ///   - forced: a shape chosen on the SHAPE row (nil = AUTO, the recognizer decides).
    ///   - snapping: false while a second finger rests or the Pencil Pro is squeezed.
    public static func build(stroke: [FloorPoint], forced: ShapeKind? = nil, tag: ZoneTag = .custom, style: ZoneStyle? = nil,
                             snapping: Bool = true, parameters: RecognizerParameters = .normalHand,
                             tokens: [FloorPoint] = [], otherZones: [Zone] = []) -> ZoneBuildResult? {
        let pts = stroke.map { P2($0.x, $0.z) }
        guard pts.count >= 3 else { return nil }
        let recognized = SmartGeometry.recognize(pts, parameters: parameters)
        let kind = forced ?? recognized.kind
        guard let geometry = geometry(kind, stroke: pts, recognized: recognized) else { return nil }
        var zone = Zone(geometry: geometry, style: style ?? tag.defaultStyle, semantic: ZoneSemantic(tag: tag))
        var hits: [SnapTarget] = []
        if snapping { (zone, hits) = ZoneSnapping.snap(zone, tokens: tokens, otherZones: otherZones) }
        return ZoneBuildResult(zone: zone, kind: kind, alternative: forced == nil ? recognized.alternative : nil, snapped: hits)
    }

    /// Geometry for a kind; fits it directly when it is not the recognizer's own winner (SHAPE row, alternative chip).
    public static func geometry(_ kind: ShapeKind, stroke pts: [P2], recognized: RecognizedShape) -> ZoneGeometry? {
        func fp(_ p: P2) -> FloorPoint { FloorPoint(x: p.x, z: p.y) }
        let own = recognized.kind == kind
        switch kind {
        case .circle:
            if own { return .circle(center: fp(recognized.center), radius: recognized.radius) }
            let f = SmartGeometry.fitCircle(pts)
            return .circle(center: fp(f.center), radius: f.radius)
        case .ellipse:
            if own { return .ellipse(center: fp(recognized.center), a: recognized.semiAxes.x, b: recognized.semiAxes.y, angle: recognized.angle) }
            guard let e = SmartGeometry.fitEllipse(pts) else { return nil }
            return .ellipse(center: fp(e.center), a: e.semiAxes.x, b: e.semiAxes.y, angle: e.angle)
        case .rect:
            let corners = own ? recognized.vertices : SmartGeometry.minAreaRect(pts)
            guard corners.count == 4 else { return nil }
            let c = corners.reduce(P2.zero, +) / 4
            let e1 = corners[1] - corners[0], e2 = corners[3] - corners[0]
            let w = (e1.x * e1.x + e1.y * e1.y).squareRoot() / 2, d = (e2.x * e2.x + e2.y * e2.y).squareRoot() / 2
            return .rect(center: fp(c), halfWidth: w, halfDepth: d, angle: atan2(e1.y, e1.x))
        case .polygon:
            var v = own ? recognized.vertices : SmartGeometry.rdp(SmartGeometry.resample(pts, n: SmartGeometry.sampleCount).0,
                                                                  epsilon: 0.04 * diagonal(pts))
            if v.count > 3, let first = v.first, let last = v.last, (first - last).x * (first - last).x + (first - last).y * (first - last).y < 1e-6 {
                v.removeLast()
            }
            guard v.count >= 3 else { return nil }
            return .polygon(counterClockwise(v).map(fp))
        case .freeform:
            let ring = SmartGeometry.resample(pts, n: 16).0
            return .freeform(ring.map(fp))
        case .line, .openPath:
            return nil
        }
    }

    static func diagonal(_ p: [P2]) -> Double {
        let xs = p.map(\.x), ys = p.map(\.y)
        let dx = (xs.max() ?? 0) - (xs.min() ?? 0), dy = (ys.max() ?? 0) - (ys.min() ?? 0)
        return (dx * dx + dy * dy).squareRoot()
    }

    static func counterClockwise(_ v: [P2]) -> [P2] {
        var area = 0.0
        for i in 0..<v.count {
            let a = v[i], b = v[(i + 1) % v.count]
            area += a.x * b.y - b.x * a.y
        }
        return area < 0 ? v.reversed() : v
    }
}
