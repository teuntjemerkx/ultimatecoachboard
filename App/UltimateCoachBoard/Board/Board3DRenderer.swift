import MetalKit
import simd
import CoachBoardCore

// Layouts; must match Shaders3D.metal byte for byte.
struct Scene3DUniforms {
    var viewProjection: simd_float4x4
    var eye: SIMD4<Float>
    var light: SIMD4<Float>            // xyz toward the light, w ambient
    var zoneCount: UInt32
    var pad: SIMD3<UInt32> = .zero
}

struct Quad3D {
    var origin: SIMD4<Float>
    var edgeU: SIMD4<Float>            // w = length in metres
    var edgeV: SIMD4<Float>
    var color: SIMD4<Float>
    var pattern: UInt32
    var pad0: UInt32 = 0, pad1: UInt32 = 0, pad2: UInt32 = 0
}

struct AvatarVertexGPU {
    var position: SIMD4<Float>
    var normal: SIMD4<Float>
    var skin: SIMD4<Float>             // weights, joint indices
}

struct AvatarInstanceGPU {
    var color: SIMD4<Float>
    var dqOffset: UInt32
    var selected: UInt32
    var pad0: UInt32 = 0, pad1: UInt32 = 0
}

struct WallVertexGPU {
    var position: SIMD4<Float>         // w = height fraction
    var color: SIMD4<Float>
}

/// What the 3D board shows: players as avatars, zones on the floor and as walls, ink and routes as floor ribbons.
struct Scene3D: Equatable {
    struct Player: Equatable {
        var id: UUID
        var side: Side
        var point: FloorPoint
        var label: String
        var posture: Posture
        var facing: Double
        var stature: Double
        var isLibero: Bool
        var selected: Bool
    }

    var players: [Player] = []
    var zones: [Zone] = []
    var selectedZone: UUID?
    var ink: [[FloorPoint]] = []
    var highlights: [BoardScene.Route] = []
    /// 2.43 m men, 2.24 m women.
    var netHeight = 2.43
}

extension simd_float4x4 {
    init(_ m: Mat4) {
        let f = m.m.map(Float.init)
        self.init(columns: (SIMD4(f[0], f[1], f[2], f[3]), SIMD4(f[4], f[5], f[6], f[7]),
                            SIMD4(f[8], f[9], f[10], f[11]), SIMD4(f[12], f[13], f[14], f[15])))
    }
}

/// The 3D board (Section 3.2): one camera, depth-tested and 4x multisampled. The floor pass is the same zone
/// engine as 2D; players are dual-quaternion skinned avatars; zone extrusions are additive walls.
/// Renders on demand; camera transitions run the display link until they settle.
final class Board3DRenderer: NSObject, MTKViewDelegate {
    static let sampleCount = 4

    let device: MTLDevice
    private let queue: MTLCommandQueue
    private var floorPipeline: MTLRenderPipelineState!
    private var quadPipeline: MTLRenderPipelineState!
    private var avatarPipeline: MTLRenderPipelineState!
    private var wallPipeline: MTLRenderPipelineState!
    private var glyphPipeline: MTLRenderPipelineState!
    private var depthWrite: MTLDepthStencilState!
    private var depthTestOnly: MTLDepthStencilState!
    private var depthOff: MTLDepthStencilState!
    private let atlas: GlyphAtlas?
    private var meshes: [Int: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)] = [:]
    private var skeletons: [Int: SkeletonModel] = [:]
    private var loggedFrame = false
    weak var view: MTKView?

    var scene = Scene3D() {
        didSet { if oldValue != scene { requestRedraw() } }
    }

    private(set) var camera: BoardCamera = .topDown(aspect: 1.5)
    private var transition: (from: BoardCamera, to: BoardCamera, start: CFTimeInterval, duration: Double, done: (() -> Void)?)?

    init?(view: MTKView) {
        assert(MemoryLayout<Scene3DUniforms>.stride == 128 && MemoryLayout<Quad3D>.stride == 80 && MemoryLayout<AvatarVertexGPU>.stride == 48
               && MemoryLayout<AvatarInstanceGPU>.stride == 32 && MemoryLayout<WallVertexGPU>.stride == 32, "must match Shaders3D.metal")
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
        self.atlas = GlyphAtlas(device: device)
        super.init()
        self.view = view
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount = Self.sampleCount
        view.clearDepth = 1
        view.clearColor = MTLClearColor(red: Tokens.canvasBase.r, green: Tokens.canvasBase.g, blue: Tokens.canvasBase.b, alpha: 1)
        view.preferredFramesPerSecond = 120
        view.enableSetNeedsDisplay = true
        view.isPaused = true
        guard buildPipelines(format: view.colorPixelFormat) else {
            DemoMode.note("3D: pipelines failed")
            return nil
        }
        view.delegate = self
    }

    private enum Blend { case none, premultiplied, additive }

    private func buildPipelines(format: MTLPixelFormat) -> Bool {
        guard let library = device.makeDefaultLibrary() else { return false }
        func make(_ vertex: String, _ fragment: String, _ blend: Blend) -> MTLRenderPipelineState? {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = library.makeFunction(name: vertex)
            d.fragmentFunction = library.makeFunction(name: fragment)
            d.rasterSampleCount = Self.sampleCount
            d.depthAttachmentPixelFormat = .depth32Float
            let c = d.colorAttachments[0]!
            c.pixelFormat = format
            if blend != .none {
                c.isBlendingEnabled = true
                c.rgbBlendOperation = .add
                c.alphaBlendOperation = .add
                c.sourceRGBBlendFactor = .one
                c.sourceAlphaBlendFactor = .one
                c.destinationRGBBlendFactor = blend == .additive ? .one : .oneMinusSourceAlpha
                c.destinationAlphaBlendFactor = blend == .additive ? .one : .oneMinusSourceAlpha
            }
            do {
                return try device.makeRenderPipelineState(descriptor: d)
            } catch {
                DemoMode.note("3D pipeline \(vertex)/\(fragment): \(error.localizedDescription)")
                return nil
            }
        }
        floorPipeline = make("floor3DVertex", "floor3DFragment", .none)
        quadPipeline = make("quad3DVertex", "quad3DFragment", .premultiplied)
        avatarPipeline = make("avatarVertex", "avatarFragment", .none)
        wallPipeline = make("wallVertex", "wallFragment", .additive)
        glyphPipeline = make("glyphVertex", "glyphFragment", .premultiplied)

        func depth(_ compare: MTLCompareFunction, write: Bool) -> MTLDepthStencilState? {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = compare
            d.isDepthWriteEnabled = write
            return device.makeDepthStencilState(descriptor: d)
        }
        depthWrite = depth(.less, write: true)
        depthTestOnly = depth(.lessEqual, write: false)
        depthOff = depth(.always, write: false)
        return [floorPipeline, quadPipeline, avatarPipeline, wallPipeline, glyphPipeline].allSatisfy { $0 != nil }
            && depthWrite != nil && depthTestOnly != nil && depthOff != nil
    }

    func requestRedraw() { view?.setNeedsDisplay() }

    var aspect: Double {
        guard let v = view, v.bounds.height > 0 else { return 1.5 }
        return Double(v.bounds.width / v.bounds.height)
    }

    // MARK: - Camera

    /// Sets the camera immediately (gestures), cancelling a running transition.
    func setCamera(_ c: BoardCamera) {
        transition = nil
        camera = c
        requestRedraw()
    }

    /// A critically damped move to `target`, as a dolly-zoom so the court keeps its size on screen (Section 3.2).
    func animateCamera(to target: BoardCamera, duration: Double = 0.9, completion: (() -> Void)? = nil) {
        transition = (camera, target, CACurrentMediaTime(), duration, completion)
        view?.enableSetNeedsDisplay = false
        view?.isPaused = false
    }

    var isAnimating: Bool { transition != nil }

    private func stepCamera(now: CFTimeInterval) {
        guard let t = transition else { return }
        let f = min(1, (now - t.start) / t.duration)
        camera = BoardCamera.dollyZoom(from: t.from, to: t.to, t: criticallyDamped(f))
        if f >= 1 {
            transition = nil
            view?.isPaused = true
            view?.enableSetNeedsDisplay = true
            t.done?()
        }
    }

    // MARK: - Hit testing

    /// The floor point under a touch (Section 3.5.2), or nil above the horizon.
    func floorPoint(at p: CGPoint) -> FloorPoint? {
        guard let v = view, v.bounds.width > 0 else { return nil }
        let ndcX = Double(p.x / v.bounds.width) * 2 - 1
        let ndcY = 1 - Double(p.y / v.bounds.height) * 2
        return camera.floorPoint(ndcX: ndcX, ndcY: ndcY, aspect: aspect)
    }

    /// Screen position (points) of a world point, or nil behind the camera.
    func screenPoint(_ w: V3) -> CGPoint? {
        guard let v = view, let c = camera.project(w, aspect: aspect) else { return nil }
        return CGPoint(x: (c.x + 1) / 2 * Double(v.bounds.width), y: (1 - c.y) / 2 * Double(v.bounds.height))
    }

    /// The player whose body (feet to head, projected) passes closest to a touch, within 36 points.
    func player(at p: CGPoint) -> UUID? {
        var best: (UUID, CGFloat)?
        for player in scene.players {
            guard let a = screenPoint(V3(player.point)), let b = screenPoint(V3(player.point, y: player.stature)) else { continue }
            let d = distance(p, segment: a, b)
            if d <= 36, d < (best?.1 ?? .infinity) { best = (player.id, d) }
        }
        return best?.0
    }

    private func distance(_ p: CGPoint, segment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let abx = b.x - a.x, aby = b.y - a.y
        let len2 = abx * abx + aby * aby
        let t = len2 > 0 ? max(0, min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0
        return hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
    }

    // MARK: - MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { requestRedraw() }

    func draw(in view: MTKView) {
        stepCamera(now: CACurrentMediaTime())
        guard view.bounds.width > 0,
              let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        let viewSize = SIMD2<Float>(Float(view.bounds.width), Float(view.bounds.height))
        let eye = camera.eye
        let light = SIMD3<Float>(0.3, 1, 0.45)
        let l = simd_normalize(light)
        let (zones, zoneVerts) = ZoneGPU.pack(scene.zones, selected: scene.selectedZone)
        var u = Scene3DUniforms(viewProjection: simd_float4x4(camera.viewProjection(aspect: aspect)),
                                eye: SIMD4(Float(eye.x), Float(eye.y), Float(eye.z), 1),
                                light: SIMD4(l.x, l.y, l.z, 0.35), zoneCount: UInt32(zones.count))

        func buffer<T>(_ items: [T]) -> MTLBuffer? {
            guard !items.isEmpty else { return nil }
            return items.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }
        }

        // 1. Floor with court lines and zones (writes depth).
        enc.setDepthStencilState(depthWrite)
        enc.setRenderPipelineState(floorPipeline)
        enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        enc.setFragmentBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        let zoneBuffer = buffer(zones.isEmpty ? [ZoneGPU(kind: 0, pattern: 0, vertexOffset: 0, vertexCount: 0, toLocal0: .zero,
                                                         toLocal1: .zero, params: .zero, color: .zero, spacing: 1, lineWidth: 0,
                                                         angle: 0, glow: 0, dashed: 0, selected: 0, tint: 0)] : zones)
        let vertBuffer = buffer(zoneVerts.isEmpty ? [SIMD2<Float>.zero] : zoneVerts)
        enc.setFragmentBuffer(zoneBuffer, offset: 0, index: 0)
        enc.setFragmentBuffer(vertBuffer, offset: 0, index: 2)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)

        // 2. Avatars (opaque, write depth).
        let avatarCount = encodeAvatars(enc, uniforms: &u)

        // 3. Floor ribbons, player rings and the net (blended, depth-tested).
        let quads = floorQuads() + netQuads()
        if let qb = buffer(quads) {
            enc.setDepthStencilState(depthTestOnly)
            enc.setRenderPipelineState(quadPipeline)
            enc.setVertexBuffer(qb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: quads.count)
        }

        // 4. Zone walls and cylinders (additive, depth-tested, no depth write).
        let walls = wallVertices()
        if let wb = buffer(walls) {
            enc.setDepthStencilState(depthTestOnly)
            enc.setRenderPipelineState(wallPipeline)
            enc.setVertexBuffer(wb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: walls.count)
        }

        // 5. Labels above the heads, always on top (screen-space SDF glyphs).
        if let atlas {
            var glyphs: [GlyphInstance] = []
            for p in scene.players {
                guard let s = screenPoint(V3(p.point, y: p.stature + 0.32)) else { continue }
                glyphs += atlas.layout(p.label, center: s, height: 20, color: (p.selected ? Tokens.white : Tokens.white.withAlpha(0.85)).simd)
            }
            if let gb = buffer(glyphs) {
                var vs = viewSize
                enc.setDepthStencilState(depthOff)
                enc.setRenderPipelineState(glyphPipeline)
                enc.setVertexBuffer(gb, offset: 0, index: 0)
                enc.setVertexBytes(&vs, length: MemoryLayout<SIMD2<Float>>.stride, index: 1)
                enc.setFragmentTexture(atlas.texture, index: 0)
                enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: glyphs.count)
            }
        }
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
        if !loggedFrame {
            loggedFrame = true
            DemoMode.note("3D frame: \(avatarCount) avatars, \(quads.count) quads, \(walls.count / 6) wall panels, \(zones.count) zones, "
                          + "camera pitch \(Int((camera.pitch * 180 / .pi).rounded()))\u{00B0} distance \(String(format: "%.1f", camera.distance)) m")
        }
    }

    // MARK: - Avatars

    private func mesh(stature: Double) -> (vertices: MTLBuffer, indices: MTLBuffer, count: Int, skeleton: SkeletonModel)? {
        let key = Int((stature * 100).rounded())
        let skeleton = skeletons[key] ?? SkeletonModel(BodyMetrics(stature: Double(key) / 100))
        skeletons[key] = skeleton
        if let m = meshes[key] { return (m.vertices, m.indices, m.count, skeleton) }
        let mesh = AvatarMesh(skeleton: skeleton)
        let verts = mesh.positions.indices.map { i -> AvatarVertexGPU in
            let p = mesh.positions[i], n = mesh.normals[i], j = mesh.joints[i], w = mesh.weights[i]
            return AvatarVertexGPU(position: SIMD4(Float(p.x), Float(p.y), Float(p.z), 1),
                                   normal: SIMD4(Float(n.x), Float(n.y), Float(n.z), 0),
                                   skin: SIMD4(Float(w.0), Float(w.1), Float(j.0), Float(j.1)))
        }
        guard let vb = verts.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let ib = mesh.indices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return nil }
        meshes[key] = (vb, ib, mesh.indices.count)
        return (vb, ib, mesh.indices.count, skeleton)
    }

    /// Poses every player, packs the skin dual quaternions, and draws one instanced call per stature.
    private func encodeAvatars(_ enc: MTLRenderCommandEncoder, uniforms u: inout Scene3DUniforms) -> Int {
        guard !scene.players.isEmpty else { return 0 }
        var dqs: [SIMD4<Float>] = []
        var groups: [Int: [AvatarInstanceGPU]] = [:]
        for p in scene.players {
            let key = Int((p.stature * 100).rounded())
            guard let m = mesh(stature: p.stature) else { continue }
            let offset = UInt32(dqs.count / 2)
            for dq in m.skeleton.skin(m.skeleton.pose(p.posture, position: p.point, facing: p.facing)) {
                dqs.append(SIMD4(Float(dq.real.x), Float(dq.real.y), Float(dq.real.z), Float(dq.real.w)))
                dqs.append(SIMD4(Float(dq.dual.x), Float(dq.dual.y), Float(dq.dual.z), Float(dq.dual.w)))
            }
            let color = p.isLibero ? Tokens.white : (p.side == .home ? Tokens.accent : Tokens.opponent)
            groups[key, default: []].append(AvatarInstanceGPU(color: color.simd, dqOffset: offset, selected: p.selected ? 1 : 0))
        }
        guard let dqBuffer = dqs.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return 0 }
        enc.setDepthStencilState(depthWrite)
        enc.setRenderPipelineState(avatarPipeline)
        enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        enc.setFragmentBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        enc.setVertexBuffer(dqBuffer, offset: 0, index: 3)
        var drawn = 0
        for (key, instances) in groups {
            guard let m = meshes[key],
                  let ib = instances.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
            else { continue }
            enc.setVertexBuffer(m.vertices, offset: 0, index: 0)
            enc.setVertexBuffer(ib, offset: 0, index: 2)
            enc.drawIndexedPrimitives(type: .triangle, indexCount: m.count, indexType: .uint32, indexBuffer: m.indices,
                                      indexBufferOffset: 0, instanceCount: instances.count)
            drawn += instances.count
        }
        return drawn
    }

    // MARK: - Quads

    private func quad(origin: V3, u: V3, v: V3, color: RGBA, pattern: UInt32 = 0) -> Quad3D {
        Quad3D(origin: SIMD4(Float(origin.x), Float(origin.y), Float(origin.z), 1),
               edgeU: SIMD4(Float(u.x), Float(u.y), Float(u.z), Float(u.length)),
               edgeV: SIMD4(Float(v.x), Float(v.y), Float(v.z), Float(v.length)),
               color: color.simd, pattern: pattern)
    }

    /// A ribbon lying on the floor from a to b, `width` metres wide, lifted 1 cm against z-fighting.
    private func ribbon(_ a: FloorPoint, _ b: FloorPoint, width: Double, color: RGBA) -> Quad3D? {
        let d = V3(b.x - a.x, 0, b.z - a.z)
        guard d.length > 1e-4 else { return nil }
        let n = V3(-d.z, 0, d.x).normalized * width
        return quad(origin: V3(a, y: 0.01) - n * 0.5, u: d, v: n, color: color)
    }

    private func floorQuads() -> [Quad3D] {
        var q: [Quad3D] = []
        for p in scene.players {
            let r = p.selected ? 0.55 : 0.45
            let color = p.isLibero ? Tokens.white : (p.side == .home ? Tokens.accent : Tokens.opponent)
            q.append(quad(origin: V3(p.point.x - r, 0.012, p.point.z - r), u: V3(2 * r, 0, 0), v: V3(0, 0, 2 * r),
                          color: color.withAlpha(p.selected ? 1 : 0.8), pattern: 3))
        }
        for stroke in scene.ink where stroke.count > 1 {
            for i in 1..<stroke.count {
                if let r = ribbon(stroke[i - 1], stroke[i], width: 0.06, color: Tokens.accentActive) { q.append(r) }
            }
        }
        for h in scene.highlights {
            if let r = ribbon(h.a, h.b, width: 0.05, color: Tokens.white.withAlpha(0.9)) { q.append(r) }
        }
        return q
    }

    /// The net (Section 3.2): 1 m mesh hanging from the tape at net height, antennas, side cables and posts.
    private func netQuads() -> [Quad3D] {
        let nh = scene.netHeight
        let up = V3(0, 1, 0)
        var q: [Quad3D] = [
            quad(origin: V3(-4.95, nh - 1, 0), u: V3(9.9, 0, 0), v: up * 0.93, color: Tokens.white.withAlpha(0.75), pattern: 1),
            quad(origin: V3(-4.95, nh - 0.07, 0), u: V3(9.9, 0, 0), v: up * 0.07, color: Tokens.white.withAlpha(0.95)),
            quad(origin: V3(-4.95, nh - 1, 0), u: V3(9.9, 0, 0), v: up * 0.05, color: Tokens.white.withAlpha(0.8)),
        ]
        for s in [-1.0, 1.0] {
            // Antennas: 1.8 m, 0.8 m above the tape, on the outer edge of the side bands.
            let x = s * 4.55
            q.append(quad(origin: V3(x - 0.015, nh - 1, 0), u: V3(0.03, 0, 0), v: up * 1.8, color: Tokens.white, pattern: 2))
            q.append(quad(origin: V3(x, nh - 1, -0.015), u: V3(0, 0, 0.03), v: up * 1.8, color: Tokens.white, pattern: 2))
            // Cables to the posts and the posts themselves.
            for y in [nh - 0.02, nh - 0.98] {
                q.append(quad(origin: V3(s * 4.95, y, 0), u: V3(s * 0.55, 0, 0), v: up * 0.02, color: Tokens.white.withAlpha(0.6)))
            }
            let px = s * 5.5
            q.append(quad(origin: V3(px - 0.05, 0, 0), u: V3(0.1, 0, 0), v: up * (nh + 0.12), color: RGBA(hex: 0x8A93B8)))
            q.append(quad(origin: V3(px, 0, -0.05), u: V3(0, 0, 0.1), v: up * (nh + 0.12), color: RGBA(hex: 0x6A7398)))
        }
        return q
    }

    // MARK: - Walls

    /// Extruded zone outlines (Section 3.5.5) as triangles; opacity falls with height in the shader.
    private func wallVertices() -> [WallVertexGPU] {
        var out: [WallVertexGPU] = []
        for zone in scene.zones {
            let height: Double
            switch zone.style.extrusion {
            case .flat: continue
            case .wall(let h), .cylinder(let h): height = h
            }
            let outline = zone.outline
            guard outline.count >= 2 else { continue }
            let tint = zone.style.tint == .pink ? Tokens.accent : Tokens.opponent
            let alpha = zone.id == scene.selectedZone ? 0.55 : 0.38
            let color = tint.withAlpha(alpha).simd
            func v(_ p: FloorPoint, _ f: Double) -> WallVertexGPU {
                WallVertexGPU(position: SIMD4(Float(p.x), Float(height * f + 0.005), Float(p.z), Float(f)), color: color)
            }
            for i in 0..<outline.count {
                let a = outline[i], b = outline[(i + 1) % outline.count]
                guard hypot(b.x - a.x, b.z - a.z) > 1e-4 else { continue }
                out += [v(a, 0), v(b, 0), v(a, 1), v(a, 1), v(b, 0), v(b, 1)]
            }
        }
        return out
    }
}
