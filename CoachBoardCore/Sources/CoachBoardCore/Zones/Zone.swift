import Foundation

/// Zone geometry in world X, Z (blueprint Section 3.5.1). Angles are radians from the world X axis toward Z.
public enum ZoneGeometry: Codable, Hashable, Sendable {
    case rect(center: FloorPoint, halfWidth: Double, halfDepth: Double, angle: Double)
    case circle(center: FloorPoint, radius: Double)
    case ellipse(center: FloorPoint, a: Double, b: Double, angle: Double)
    /// Simple polygon, counter-clockwise.
    case polygon([FloorPoint])
    /// Closed centripetal Catmull-Rom through the control points.
    case freeform([FloorPoint])
}

public enum ZonePattern: String, Codable, CaseIterable, Sendable, Hashable {
    case crossHatch, diagonal, dots, glowFill, outline
}

public enum ZoneEdge: String, Codable, Sendable, Hashable { case solid, dashed }

public enum ZoneExtrusion: Codable, Hashable, Sendable {
    case flat
    case wall(height: Double)
    case cylinder(height: Double)
}

public enum ZoneTint: String, Codable, CaseIterable, Sendable, Hashable { case pink, cyan }

public struct ZoneStyle: Codable, Hashable, Sendable {
    public var pattern: ZonePattern = .diagonal
    /// Metres between hatch lines or dot centres.
    public var spacing = 0.25
    /// Metres; the renderer keeps at least one pixel.
    public var lineWidth = 0.035
    public var angle = Double.pi / 4
    public var opacity = 0.55
    public var edge: ZoneEdge = .solid
    public var glow = 0.6
    public var extrusion: ZoneExtrusion = .flat
    public var tint: ZoneTint = .pink

    public init() {}
}

/// Semantic tags of Section 3.5.6, each with its default style.
public enum ZoneTag: String, Codable, CaseIterable, Sendable, Hashable {
    case noFly, serveTarget, tipAlert, freeBall, responsibility, custom

    public var title: String {
        switch self {
        case .noFly: return "No-Fly Zone"
        case .serveTarget: return "Primary Serve Target"
        case .tipAlert: return "Tip/Dump Alert"
        case .freeBall: return "Free Ball Target"
        case .responsibility: return "Responsibility"
        case .custom: return "Custom"
        }
    }

    public var defaultStyle: ZoneStyle {
        var s = ZoneStyle()
        switch self {
        case .noFly:
            s.pattern = .crossHatch
            s.extrusion = .wall(height: 0.5)
        case .serveTarget:
            s.pattern = .dots
            s.spacing = 0.3
            s.extrusion = .cylinder(height: 1.5)
        case .tipAlert:
            s.pattern = .diagonal
            s.edge = .dashed
            s.extrusion = .wall(height: 0.3)
        case .freeBall:
            s.pattern = .glowFill
        case .responsibility:
            s.pattern = .outline
            s.glow = 0.3
        case .custom:
            break
        }
        return s
    }
}

public struct ZoneSemantic: Codable, Hashable, Sendable {
    public var tag: ZoneTag
    public var label: String
    public var linked: [UUID]

    public init(tag: ZoneTag, label: String? = nil, linked: [UUID] = []) {
        self.tag = tag
        self.label = label ?? tag.title
        self.linked = linked
    }
}

public struct Zone: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var geometry: ZoneGeometry
    public var style: ZoneStyle
    public var semantic: ZoneSemantic
    /// Keyframes at later phase markers (Section 3.5.7); `geometry` is the first marker's.
    public var keys: [ZoneKey]?

    public init(id: UUID = UUID(), geometry: ZoneGeometry, style: ZoneStyle? = nil, semantic: ZoneSemantic = ZoneSemantic(tag: .custom),
                keys: [ZoneKey]? = nil) {
        self.id = id
        self.geometry = geometry
        self.style = style ?? semantic.tag.defaultStyle
        self.semantic = semantic
        self.keys = keys
    }

    /// The court side of the zone's centroid.
    public var side: Side { CourtFrame.side(of: centroid) }

    public var centroid: FloorPoint {
        switch geometry {
        case .rect(let c, _, _, _), .circle(let c, _), .ellipse(let c, _, _, _): return c
        case .polygon(let p), .freeform(let p):
            let n = Double(max(p.count, 1))
            return FloorPoint(x: p.map(\.x).reduce(0, +) / n, z: p.map(\.z).reduce(0, +) / n)
        }
    }

    /// Signed distance from a world point to the zone boundary: negative inside.
    public func distance(to p: FloorPoint) -> Double { ZoneSDF.distance(geometry, p) }

    public func contains(_ p: FloorPoint) -> Bool { distance(to: p) <= 0 }

    /// The boundary as a closed polygon (exact vertices, or sampled for curves), for snapping and hit tests.
    public var outline: [FloorPoint] { ZoneSDF.outline(geometry) }

    public func translated(by dx: Double, _ dz: Double) -> Zone {
        func t(_ p: FloorPoint) -> FloorPoint { FloorPoint(x: p.x + dx, z: p.z + dz) }
        var z = self
        switch geometry {
        case let .rect(c, hw, hd, a): z.geometry = .rect(center: t(c), halfWidth: hw, halfDepth: hd, angle: a)
        case let .circle(c, r): z.geometry = .circle(center: t(c), radius: r)
        case let .ellipse(c, a, b, ang): z.geometry = .ellipse(center: t(c), a: a, b: b, angle: ang)
        case let .polygon(p): z.geometry = .polygon(p.map(t))
        case let .freeform(p): z.geometry = .freeform(p.map(t))
        }
        return z
    }
}

/// Exact signed distance functions of Section 3.5.4 (Quilez), shared with the Metal floor shader.
public enum ZoneSDF {
    static func local(_ p: FloorPoint, center c: FloorPoint, angle: Double) -> P2 {
        let dx = p.x - c.x, dz = p.z - c.z
        let co = cos(angle), si = sin(angle)
        return P2(co * dx + si * dz, -si * dx + co * dz)
    }

    public static func box(_ p: P2, _ b: P2) -> Double {
        let d = P2(abs(p.x) - b.x, abs(p.y) - b.y)
        let outside = P2(max(d.x, 0), max(d.y, 0))
        return (outside.x * outside.x + outside.y * outside.y).squareRoot() + min(max(d.x, d.y), 0)
    }

    /// Distance to an axis-aligned ellipse with semi-axes ab (Inigo Quilez's closed form).
    public static func ellipse(_ point: P2, _ semiAxes: P2) -> Double {
        if abs(semiAxes.x - semiAxes.y) < 1e-6 { return (point.x * point.x + point.y * point.y).squareRoot() - semiAxes.x }
        var p = P2(abs(point.x), abs(point.y))
        var ab = semiAxes
        if p.x > p.y { p = P2(p.y, p.x); ab = P2(ab.y, ab.x) }
        let l = ab.y * ab.y - ab.x * ab.x
        let m = ab.x * p.x / l, m2 = m * m
        let n = ab.y * p.y / l, n2 = n * n
        let c = (m2 + n2 - 1) / 3, c3 = c * c * c
        let q = c3 + m2 * n2 * 2
        let d = c3 + m2 * n2
        let g = m + m * n2
        var co: Double
        if d < 0 {
            let h = acos(max(-1, min(1, q / c3))) / 3
            let s = cos(h), t = sin(h) * 3.0.squareRoot()
            let rx = max(-c * (s + t + 2) + m2, 0).squareRoot()
            let ry = max(-c * (s - t + 2) + m2, 0).squareRoot()
            co = (ry + (l < 0 ? -1 : 1) * rx + abs(g) / max(rx * ry, 1e-12) - m) / 2
        } else {
            let h = 2 * m * n * d.squareRoot()
            let s = (q + h < 0 ? -1.0 : 1.0) * pow(abs(q + h), 1.0 / 3)
            let u = (q - h < 0 ? -1.0 : 1.0) * pow(abs(q - h), 1.0 / 3)
            let rx = -s - u - c * 4 + 2 * m2
            let ry = (s - u) * 3.0.squareRoot()
            let rm = (rx * rx + ry * ry).squareRoot()
            co = (ry / max((rm - rx).squareRoot(), 1e-12) + 2 * g / max(rm, 1e-12) - m) / 2
        }
        co = max(-1, min(1, co))
        let r = P2(ab.x * co, ab.y * (1 - co * co).squareRoot())
        let dist = ((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y)).squareRoot()
        return p.y - r.y < 0 ? -dist : dist
    }

    /// Distance to a simple polygon with the winding sign (negative inside).
    public static func polygon(_ p: P2, _ v: [P2]) -> Double {
        guard v.count >= 3 else { return .infinity }
        var d = simd_len2(p - v[0])
        var s = 1.0
        var j = v.count - 1
        for i in 0..<v.count {
            let e = v[j] - v[i], w = p - v[i]
            let t = max(0, min(1, (w.x * e.x + w.y * e.y) / max(e.x * e.x + e.y * e.y, 1e-12)))
            let b = w - e * t
            d = min(d, simd_len2(b))
            let c1 = p.y >= v[i].y, c2 = p.y < v[j].y, c3 = e.x * w.y > e.y * w.x
            if (c1 && c2 && c3) || (!c1 && !c2 && !c3) { s = -s }
            j = i
        }
        return s * d.squareRoot()
    }

    private static func simd_len2(_ v: P2) -> Double { v.x * v.x + v.y * v.y }

    public static func distance(_ g: ZoneGeometry, _ p: FloorPoint) -> Double {
        switch g {
        case let .rect(c, hw, hd, a): return box(local(p, center: c, angle: a), P2(hw, hd))
        case let .circle(c, r): return ((p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z)).squareRoot() - r
        case let .ellipse(c, a, b, ang): return ellipse(local(p, center: c, angle: ang), P2(a, b))
        case let .polygon(v): return polygon(P2(p.x, p.z), v.map { P2($0.x, $0.z) })
        case let .freeform(v): return polygon(P2(p.x, p.z), catmullRom(v.map { P2($0.x, $0.z) }).map { P2($0.x, $0.y) })
        }
    }

    /// Closed centripetal Catmull-Rom through the control points, `perSegment` samples per span.
    public static func catmullRom(_ c: [P2], perSegment: Int = 12) -> [P2] {
        let n = c.count
        guard n >= 3 else { return c }
        var out: [P2] = []
        for i in 0..<n {
            let p0 = c[(i - 1 + n) % n], p1 = c[i], p2 = c[(i + 1) % n], p3 = c[(i + 2) % n]
            func knot(_ a: P2, _ b: P2) -> Double { max(pow(simd_len2(b - a), 0.25), 1e-6) }   // alpha = 0.5
            let t0 = 0.0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3)
            for k in 0..<perSegment {
                let t = t1 + (t2 - t1) * Double(k) / Double(perSegment)
                let a1 = p0 * ((t1 - t) / (t1 - t0)) + p1 * ((t - t0) / (t1 - t0))
                let a2 = p1 * ((t2 - t) / (t2 - t1)) + p2 * ((t - t1) / (t2 - t1))
                let a3 = p2 * ((t3 - t) / (t3 - t2)) + p3 * ((t - t2) / (t3 - t2))
                let b1 = a1 * ((t2 - t) / (t2 - t0)) + a2 * ((t - t0) / (t2 - t0))
                let b2 = a2 * ((t3 - t) / (t3 - t1)) + a3 * ((t - t1) / (t3 - t1))
                out.append(b1 * ((t2 - t) / (t2 - t1)) + b2 * ((t - t1) / (t2 - t1)))
            }
        }
        return out
    }

    public static func outline(_ g: ZoneGeometry, samples: Int = 64) -> [FloorPoint] {
        func ring(_ f: (Double) -> FloorPoint) -> [FloorPoint] {
            (0..<samples).map { f(2 * Double.pi * Double($0) / Double(samples)) }
        }
        switch g {
        case let .rect(c, hw, hd, a):
            let co = cos(a), si = sin(a)
            return [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].map { (u, v) in
                FloorPoint(x: c.x + co * u - si * v, z: c.z + si * u + co * v)
            }
        case let .circle(c, r):
            return ring { FloorPoint(x: c.x + r * cos($0), z: c.z + r * sin($0)) }
        case let .ellipse(c, a, b, ang):
            let co = cos(ang), si = sin(ang)
            return ring { t in
                let u = a * cos(t), v = b * sin(t)
                return FloorPoint(x: c.x + co * u - si * v, z: c.z + si * u + co * v)
            }
        case let .polygon(v):
            return v
        case let .freeform(v):
            return catmullRom(v.map { P2($0.x, $0.z) }).map { FloorPoint(x: $0.x, z: $0.y) }
        }
    }
}
