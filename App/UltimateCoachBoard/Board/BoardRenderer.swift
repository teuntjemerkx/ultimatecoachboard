import MetalKit
import CoachBoardCore

// Instance layouts; must match Shaders.metal byte for byte.
struct SegmentInstance {
    var p0: SIMD2<Float>
    var p1: SIMD2<Float>
    var halfWidth: Float
    var dash: Float = 0
    var gap: Float = 0
    var pad: Float = 0
    var color: SIMD4<Float>
}

struct TokenInstance {
    var center: SIMD2<Float>
    var radius: Float
    var ring: Float
    var shape: Float
    var glow: Float
    var pad: SIMD2<Float> = .zero
    var fill: SIMD4<Float>
    var ringColor: SIMD4<Float>
}

struct GlyphInstance {
    var origin: SIMD2<Float>
    var size: SIMD2<Float>
    var uvOrigin: SIMD2<Float>
    var uvSize: SIMD2<Float>
    var color: SIMD4<Float>
}

/// One zone for the floor pass; must match `ZoneGPU` in ZoneShading.h byte for byte (176 bytes).
struct ZoneGPU {
    var kind: UInt32
    var pattern: UInt32
    var vertexOffset: UInt32
    var vertexCount: UInt32
    var toLocal0: SIMD4<Float>
    var toLocal1: SIMD4<Float>
    var params: SIMD4<Float>
    var color: SIMD4<Float>
    var spacing: Float
    var lineWidth: Float
    var angle: Float
    var glow: Float
    var dashed: UInt32
    var selected: UInt32
    var tint: UInt32
    var intensity: Float = 1
    var kind2: UInt32 = 0
    var vertexOffset2: UInt32 = 0
    var vertexCount2: UInt32 = 0
    var blend: Float = 0
    var toLocal2_0: SIMD4<Float> = .zero
    var toLocal2_1: SIMD4<Float> = .zero
    var params2: SIMD4<Float> = .zero
}

extension ZoneGPU {
    /// Packs zones for the floor pass (shared by the 2D and 3D boards): one record per zone, polygon outlines
    /// in a separate vertex buffer. Outlines outside 3...256 vertices are skipped.
    static func pack(_ zones: [Zone], selected: UUID?, morphs: [UUID: ZoneMorph] = [:],
                     intensities: [UUID: Double] = [:]) -> ([ZoneGPU], [SIMD2<Float>]) {
        var gpu: [ZoneGPU] = []
        var verts: [SIMD2<Float>] = []
        /// Shape fields of one geometry: kind, frame rows, parameters and polygon vertices; nil when unusable.
        func shape(_ g: ZoneGeometry) -> (UInt32, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, UInt32, UInt32)? {
            func frame(_ c: FloorPoint, _ a: Double) -> (SIMD4<Float>, SIMD4<Float>) {
                let co = cos(a), si = sin(a)
                return (SIMD4(Float(co), Float(si), Float(-(co * c.x + si * c.z)), 0),
                        SIMD4(Float(-si), Float(co), Float(si * c.x - co * c.z), 0))
            }
            switch g {
            case let .rect(c, hw, hd, a):
                let f = frame(c, a); return (0, f.0, f.1, SIMD4(Float(hw), Float(hd), 0, 0), 0, 0)
            case let .circle(c, r):
                let f = frame(c, 0); return (1, f.0, f.1, SIMD4(Float(r), 0, 0, 0), 0, 0)
            case let .ellipse(c, a, b, ang):
                let f = frame(c, ang); return (2, f.0, f.1, SIMD4(Float(a), Float(b), 0, 0), 0, 0)
            case .polygon, .freeform:
                let outline = ZoneSDF.outline(g)
                guard (3...256).contains(outline.count) else { return nil }
                let offset = UInt32(verts.count)
                verts += outline.map { SIMD2(Float($0.x), Float($0.z)) }
                return (3, .zero, .zero, .zero, offset, UInt32(outline.count))
            }
        }
        for zone in zones {
            let intensity = intensities[zone.id] ?? 1
            // Frames scale the style opacity by the intensity; the shader applies the intensity to the whole zone.
            let opacity = intensity > 1e-6 ? zone.style.opacity / intensity : zone.style.opacity
            guard let s = shape(zone.geometry) else { continue }
            var z = ZoneGPU(kind: s.0, pattern: 0, vertexOffset: s.4, vertexCount: s.5, toLocal0: s.1, toLocal1: s.2,
                            params: s.3, color: SIMD4(1, 1, 1, Float(opacity)),
                            spacing: Float(zone.style.spacing), lineWidth: Float(zone.style.lineWidth),
                            angle: Float(zone.style.angle), glow: Float(zone.style.glow),
                            dashed: zone.style.edge == .dashed ? 1 : 0, selected: zone.id == selected ? 1 : 0,
                            tint: zone.style.tint == .pink ? 0 : 1, intensity: Float(intensity))
            switch zone.style.pattern {
            case .crossHatch: z.pattern = 0
            case .diagonal: z.pattern = 1
            case .dots: z.pattern = 2
            case .glowFill: z.pattern = 3
            case .outline: z.pattern = 4
            }
            if let m = morphs[zone.id], let s2 = shape(m.to) {
                z.kind2 = s2.0
                z.toLocal2_0 = s2.1
                z.toLocal2_1 = s2.2
                z.params2 = s2.3
                z.vertexOffset2 = s2.4
                z.vertexCount2 = s2.5
                z.blend = Float(m.t)
            }
            gpu.append(z)
        }
        return (gpu, verts)
    }
}

struct FloorUniforms {
    var viewSize: SIMD2<Float>
    var center: SIMD2<Float>
    var toWorld: SIMD4<Float>
    var scale: Float
    var zoneCount: UInt32
    var pad: SIMD2<Float> = .zero
    var court: SIMD4<Float>
    var freeZone: SIMD4<Float>
    var hall: SIMD4<Float>
    var tintA: SIMD4<Float>
    var tintB: SIMD4<Float>
}

struct HatchInstance {
    var center: SIMD2<Float>
    var halfSize: SIMD2<Float>
    var angle: Float
    var spacing: Float
    var lineWidth: Float
    var pad: Float = 0
    var color: SIMD4<Float>
}

/// Everything the board shows, as a value snapshot built by the Live controller.
struct BoardScene: Equatable {
    struct Token: Equatable {
        var id: UUID
        var side: Side
        var point: FloorPoint
        var label: String
        var isLibero: Bool
        var isServer: Bool
        var selected: Bool
    }

    struct Tether: Equatable {
        var a: FloorPoint
        var b: FloorPoint
        var margin: Double
        /// For faults: the boundary the offending player must not cross, drawn across their lane.
        var boundary: (FloorPoint, FloorPoint)?

        static func == (l: Tether, r: Tether) -> Bool {
            l.a == r.a && l.b == r.b && l.margin == r.margin && l.boundary?.0 == r.boundary?.0 && l.boundary?.1 == r.boundary?.1
        }
    }

    /// A planned route after the serve: a receive route checked by the timing model, or a serve-team switch.
    struct Route: Equatable {
        var a: FloorPoint
        var b: FloorPoint
        var late: Bool
    }

    var tokens: [Token] = []
    var routes: [Route] = []
    /// Tactical zones (Section 3.5), drawn in the floor pass under the tokens.
    var zones: [Zone] = []
    var zoneMorphs: [UUID: ZoneMorph] = [:]
    var zoneIntensities: [UUID: Double] = [:]
    var selectedZone: UUID?
    /// Brief highlights of what a zone snapped to.
    var highlights: [Route] = []
    var scoutLines: [(FloorPoint, FloorPoint, Double)] = []      // origin, landing, opacity
    var tethers: [Tether] = []
    var ink: [[FloorPoint]] = []
    var envelope: (FloorPoint, FloorPoint)?                      // two opposite corners in world metres
    /// The ball (Section 5.4): its flights projected on the floor, and where it is now (with its height).
    var ballPaths: [[FloorPoint]] = []
    var ball: FloorPoint?
    var ballHeight = 0.0

    static func == (l: BoardScene, r: BoardScene) -> Bool {
        l.tokens == r.tokens && l.routes == r.routes && l.tethers == r.tethers && l.ink == r.ink
            && l.zones == r.zones && l.selectedZone == r.selectedZone && l.highlights == r.highlights
            && l.zoneMorphs == r.zoneMorphs && l.zoneIntensities == r.zoneIntensities
            && l.scoutLines.count == r.scoutLines.count
            && zip(l.scoutLines, r.scoutLines).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 && $0.2 == $1.2 }
            && l.envelope?.0 == r.envelope?.0 && l.envelope?.1 == r.envelope?.1
            && l.ballPaths == r.ballPaths && l.ball == r.ball && l.ballHeight == r.ballHeight
    }
}

/// The Phase 1 2D Metal renderer: court, zone grid, tokens, vectors, tethers, ink and the Legal Envelope.
/// It renders only when something changes (render-on-demand, Section 6.3) and animates token moves.
final class BoardRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    private let queue: MTLCommandQueue
    private var segmentPipeline: MTLRenderPipelineState!
    private var tokenPipeline: MTLRenderPipelineState!
    private var glyphPipeline: MTLRenderPipelineState!
    private var hatchPipeline: MTLRenderPipelineState!
    private var zonePipeline: MTLRenderPipelineState!
    private var loggedZonePass = false
    private let atlas: GlyphAtlas?

    var geometry = BoardGeometry(size: .zero)
    var scene = BoardScene() {
        didSet { if oldValue != scene { beginAnimation(from: oldValue, to: scene) } }
    }

    // Token animation: player id -> start position; positions interpolate over 0.35 s.
    private var animationStart: CFTimeInterval = 0
    private var fromPositions: [UUID: FloorPoint] = [:]
    private let animationDuration: CFTimeInterval = 0.35
    weak var view: MTKView?

    init?(view: MTKView) {
        assert(MemoryLayout<ZoneGPU>.stride == 176 && MemoryLayout<FloorUniforms>.stride == 128, "must match Shaders.metal")
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
        self.atlas = GlyphAtlas(device: device)
        DemoMode.note(atlas.map { "glyph atlas \($0.texture.width)x\($0.texture.height), \($0.glyphs.count) glyphs" } ?? "glyph atlas unavailable")
        super.init()
        self.view = view
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: Tokens.hall.r, green: Tokens.hall.g, blue: Tokens.hall.b, alpha: 1)
        view.preferredFramesPerSecond = 120
        view.enableSetNeedsDisplay = true
        view.isPaused = true
        guard buildPipelines(format: view.colorPixelFormat) else { return nil }
        view.delegate = self
    }

    private func buildPipelines(format: MTLPixelFormat) -> Bool {
        guard let library = device.makeDefaultLibrary() else { return false }
        func make(_ vertex: String, _ fragment: String) -> MTLRenderPipelineState? {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = library.makeFunction(name: vertex)
            d.fragmentFunction = library.makeFunction(name: fragment)
            let c = d.colorAttachments[0]!
            c.pixelFormat = format
            c.isBlendingEnabled = true
            c.rgbBlendOperation = .add
            c.alphaBlendOperation = .add
            c.sourceRGBBlendFactor = .one
            c.sourceAlphaBlendFactor = .one
            c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            return try? device.makeRenderPipelineState(descriptor: d)
        }
        segmentPipeline = make("segmentVertex", "segmentFragment")
        tokenPipeline = make("tokenVertex", "tokenFragment")
        glyphPipeline = make("glyphVertex", "glyphFragment")
        hatchPipeline = make("hatchVertex", "hatchFragment")
        zonePipeline = make("floorVertex", "zoneFragment")
        return segmentPipeline != nil && tokenPipeline != nil && glyphPipeline != nil && hatchPipeline != nil && zonePipeline != nil
    }

    func requestRedraw() { view?.setNeedsDisplay() }

    private func beginAnimation(from old: BoardScene, to new: BoardScene) {
        let now = CACurrentMediaTime()
        var from: [UUID: FloorPoint] = [:]
        let targets = Dictionary(new.tokens.map { ($0.id, $0.point) }, uniquingKeysWith: { a, _ in a })
        for t in old.tokens {
            let shown = currentPosition(of: t.id, target: t.point, now: now)
            guard let target = targets[t.id] else { continue }
            let dx = target.x - shown.x, dz = target.z - shown.z
            // Large moves (rotations, formation loads) animate; drags follow the finger 1:1.
            if (dx * dx + dz * dz).squareRoot() > 0.4 { from[t.id] = shown }
        }
        fromPositions = from
        animationStart = now
        if !from.isEmpty {
            // Run the display link until the move settles; on-demand mode is switched off meanwhile.
            view?.enableSetNeedsDisplay = false
            view?.isPaused = false
        }
        requestRedraw()
    }

    private func currentPosition(of id: UUID, target: FloorPoint, now: CFTimeInterval) -> FloorPoint {
        guard let start = fromPositions[id] else { return target }
        let t = min(max((now - animationStart) / animationDuration, 0), 1)
        let e = 1 - pow(1 - t, 3)    // ease-out cubic, critically damped feel
        return FloorPoint(x: start.x + (target.x - start.x) * e, z: start.z + (target.z - start.z) * e)
    }

    // MARK: - MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        requestRedraw()
    }

    func draw(in view: MTKView) {
        view.clearColor = MTLClearColor(red: Tokens.hall.r, green: Tokens.hall.g, blue: Tokens.hall.b, alpha: 1)
        let now = CACurrentMediaTime()
        if now - animationStart > animationDuration, !view.isPaused {
            fromPositions = [:]
            view.isPaused = true
            view.enableSetNeedsDisplay = true
        }
        geometry.size = view.bounds.size
        guard geometry.size.width > 0,
              let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        var uniforms = SIMD2<Float>(Float(geometry.size.width), Float(geometry.size.height))

        let (court, overlays) = buildSegments()
        let (tokens, glyphs) = buildTokens(now: now)
        let hatches = buildHatches()

        func encode<T>(_ items: [T], pipeline: MTLRenderPipelineState, texture: MTLTexture? = nil) {
            guard !items.isEmpty, let buffer = items.withUnsafeBytes({ raw in
                device.makeBuffer(bytes: raw.baseAddress!, length: raw.count, options: .storageModeShared)
            }) else { return }
            enc.setRenderPipelineState(pipeline)
            enc.setVertexBuffer(buffer, offset: 0, index: 0)
            enc.setVertexBytes(&uniforms, length: MemoryLayout<SIMD2<Float>>.stride, index: 1)
            if let texture { enc.setFragmentTexture(texture, index: 0) }
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: items.count)
        }

        encodeFloor(enc)
        encode(court, pipeline: segmentPipeline)
        encode(hatches, pipeline: hatchPipeline)
        encode(overlays, pipeline: segmentPipeline)
        encode(tokens, pipeline: tokenPipeline)
        if let atlas { encode(glyphs, pipeline: glyphPipeline, texture: atlas.texture) }
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
    }

    /// The floor pass: one full-view quad that paints the hall, the free zone and the court in the template's
    /// colours and evaluates every zone (Section 3.5.4).
    private func encodeFloor(_ enc: MTLRenderCommandEncoder) {
        var (gpu, verts) = ZoneGPU.pack(scene.zones, selected: scene.selectedZone, morphs: scene.zoneMorphs,
                                        intensities: scene.zoneIntensities)
        if verts.isEmpty { verts = [.zero] }
        let zoneCount = gpu.count
        if gpu.isEmpty {
            gpu = [ZoneGPU(kind: 0, pattern: 0, vertexOffset: 0, vertexCount: 0, toLocal0: .zero, toLocal1: .zero, params: .zero,
                           color: .zero, spacing: 1, lineWidth: 0, angle: 0, glow: 0, dashed: 0, selected: 0, tint: 0)]
        }
        if !loggedZonePass && zoneCount > 0 {
            loggedZonePass = true
            DemoMode.note("zone pass: \(zoneCount) zones, \(verts.count) vertices, kinds \(gpu.map(\.kind))")
        }
        var u = FloorUniforms(viewSize: SIMD2(Float(geometry.size.width), Float(geometry.size.height)),
                              center: SIMD2(Float(geometry.center.x), Float(geometry.center.y)),
                              toWorld: geometry.toWorldRows, scale: Float(geometry.scale), zoneCount: UInt32(zoneCount),
                              court: Tokens.court.simd, freeZone: Tokens.freeZone.simd, hall: Tokens.hall.simd,
                              tintA: Tokens.zoneA.simd, tintB: Tokens.zoneB.simd)
        guard let zoneBuffer = gpu.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let vertexBuffer = verts.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return }
        enc.setRenderPipelineState(zonePipeline)
        enc.setVertexBytes(&u, length: MemoryLayout<FloorUniforms>.stride, index: 1)
        enc.setFragmentBuffer(zoneBuffer, offset: 0, index: 0)
        enc.setFragmentBytes(&u, length: MemoryLayout<FloorUniforms>.stride, index: 1)
        enc.setFragmentBuffer(vertexBuffer, offset: 0, index: 2)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }

    // MARK: - Scene to instances

    private func v(_ p: FloorPoint) -> SIMD2<Float> {
        let q = geometry.toView(p)
        return SIMD2(Float(q.x), Float(q.y))
    }

    private func segment(_ a: FloorPoint, _ b: FloorPoint, width: CGFloat, color: RGBA, dash: CGFloat = 0, gap: CGFloat = 0) -> SegmentInstance {
        SegmentInstance(p0: v(a), p1: v(b), halfWidth: Float(width / 2), dash: Float(dash), gap: Float(gap), color: color.simd)
    }

    private func buildSegments() -> ([SegmentInstance], [SegmentInstance]) {
        let lineWidth = max(geometry.metres(0.05), 1.5)
        var court: [SegmentInstance] = []
        // Faint nine-zone grid on both halves (Micro-Scouting orientation aid).
        for x in [-1.5, 1.5] {
            court.append(segment(FloorPoint(x: x, z: -9), FloorPoint(x: x, z: 9), width: 1, color: Tokens.gridMinor))
        }
        for z in [-6.0, 6.0] {
            court.append(segment(FloorPoint(x: -4.5, z: z), FloorPoint(x: 4.5, z: z), width: 1, color: Tokens.gridMinor))
        }
        // Court boundary, attack lines, centre line.
        let corners = [FloorPoint(x: -4.5, z: -9), FloorPoint(x: 4.5, z: -9), FloorPoint(x: 4.5, z: 9), FloorPoint(x: -4.5, z: 9)]
        for i in 0..<4 { court.append(segment(corners[i], corners[(i + 1) % 4], width: lineWidth, color: Tokens.courtLine)) }
        for z in [-3.0, 3.0] {
            court.append(segment(FloorPoint(x: -4.5, z: z), FloorPoint(x: 4.5, z: z), width: lineWidth, color: Tokens.courtLine))
        }
        // Net (drawn beyond the sidelines to the posts) and antennas.
        court.append(segment(FloorPoint(x: -5.0, z: 0), FloorPoint(x: 5.0, z: 0), width: max(lineWidth * 2.2, 3.5), color: Tokens.net.withAlpha(0.9)))
        for x in [-4.55, 4.55] {
            court.append(segment(FloorPoint(x: x, z: -0.08), FloorPoint(x: x, z: 0.08), width: 4, color: Tokens.fault))
        }

        var overlays: [SegmentInstance] = []
        // Snap highlights: the line, cell edge or point a zone snapped to.
        for h in scene.highlights {
            overlays.append(segment(h.a, h.b, width: 3, color: Tokens.text.withAlpha(0.9)))
        }
        // Routes (Section 2.6): dashed when on time, solid pink when late.
        for route in scene.routes {
            let color = route.late ? Tokens.fault : Tokens.text.withAlpha(0.6)
            overlays.append(segment(route.a, route.b, width: route.late ? 3 : 2, color: color,
                                    dash: route.late ? 0 : 7, gap: route.late ? 0 : 6))
            overlays += arrowhead(from: route.a, to: route.b, width: route.late ? 3 : 2, color: color, size: 0.3)
        }
        // Micro-Scouting vectors with arrowheads.
        for (o, t, opacity) in scene.scoutLines {
            let color = Tokens.opponent.withAlpha(opacity)
            overlays.append(segment(o, t, width: 3, color: color))
            overlays += arrowhead(from: o, to: t, width: 3, color: color, size: 0.45)
        }
        // Overlap tethers (Section 3.4.4).
        for tether in scene.tethers {
            if tether.margin <= 0 {
                overlays.append(segment(tether.a, tether.b, width: 3, color: Tokens.fault))
                if let (b0, b1) = tether.boundary {
                    overlays.append(segment(b0, b1, width: 2, color: Tokens.fault, dash: 6, gap: 5))
                }
            } else {
                let alpha = max(0.15, 1 - tether.margin / 0.25)
                overlays.append(segment(tether.a, tether.b, width: 1.5 + 1.5 * CGFloat(alpha), color: Tokens.fault.withAlpha(alpha)))
            }
        }
        // Ball flights: their floor track, dashed white.
        for path in scene.ballPaths where path.count > 1 {
            for i in stride(from: 1, to: path.count, by: 1) {
                overlays.append(segment(path[i - 1], path[i], width: 1.5, color: Tokens.text.withAlpha(0.45)))
            }
        }
        // Ink in #FF1493, 4 pt.
        for stroke in scene.ink where stroke.count > 1 {
            for i in 1..<stroke.count { overlays.append(segment(stroke[i - 1], stroke[i], width: 4, color: Tokens.ink)) }
        }
        return (court, overlays)
    }

    private func arrowhead(from o: FloorPoint, to t: FloorPoint, width: CGFloat, color: RGBA, size: Double) -> [SegmentInstance] {
        let dx = t.x - o.x, dz = t.z - o.z
        let len = max((dx * dx + dz * dz).squareRoot(), 1e-6)
        let ux = dx / len, uz = dz / len
        let wing = size * 0.55
        return [-1.0, 1.0].map { s in
            segment(t, FloorPoint(x: t.x - ux * size + (-uz) * wing * s, z: t.z - uz * size + ux * wing * s), width: width, color: color)
        }
    }

    private func buildTokens(now: CFTimeInterval) -> ([TokenInstance], [GlyphInstance]) {
        let radius = max(geometry.metres(0.30), 17)
        var tokens: [TokenInstance] = []
        var glyphs: [GlyphInstance] = []
        for t in scene.tokens {
            let p = currentPosition(of: t.id, target: t.point, now: now)
            let c = v(p)
            let home = t.side == .home
            let ringColor = Tokens.team(t.side).simd
            let scale: Float = t.selected ? 1.15 : 1
            tokens.append(TokenInstance(center: c, radius: Float(radius) * scale, ring: 3, shape: home ? 0 : 1,
                                        glow: t.selected ? 1 : 0, fill: Tokens.tokenFill.simd, ringColor: ringColor))
            if t.isLibero {
                tokens.append(TokenInstance(center: c, radius: Float(radius) * scale - 6, ring: 1.5, shape: home ? 0 : 1,
                                            glow: 0, fill: SIMD4(0, 0, 0, 0), ringColor: ringColor))
            }
            if t.isServer {
                // Server marker: a short bar outside the ring.
                tokens.append(TokenInstance(center: c + SIMD2(0, Float(radius) * 1.45), radius: 3, ring: 3, shape: 0,
                                            glow: 0, fill: ringColor, ringColor: ringColor))
            }
            if let atlas {
                glyphs += atlas.layout(t.label, center: CGPoint(x: CGFloat(c.x), y: CGFloat(c.y)),
                                       height: radius * 1.45, color: Tokens.tokenLabel.simd)
            }
        }
        if let b = scene.ball {
            // The ball over its floor point; it grows a little with height so a high set reads as high.
            let c = v(b)
            let r = Float(6 + min(scene.ballHeight, 8) * 0.8)
            tokens.append(TokenInstance(center: c, radius: r, ring: 2, shape: 0, glow: 1,
                                        fill: Tokens.ball.simd, ringColor: Tokens.text.simd))
        }
        return (tokens, glyphs)
    }

    private func buildHatches() -> [HatchInstance] {
        guard let (a, b) = scene.envelope else { return [] }
        let pa = v(a), pb = v(b)
        let center = (pa + pb) / 2
        let half = SIMD2<Float>(abs(pb.x - pa.x), abs(pb.y - pa.y)) / 2
        guard half.x > 1, half.y > 1 else { return [] }
        return [HatchInstance(center: center, halfSize: half, angle: .pi / 4, spacing: 9, lineWidth: 1.5,
                              color: Tokens.home.withAlpha(0.45).simd)]
    }
}
