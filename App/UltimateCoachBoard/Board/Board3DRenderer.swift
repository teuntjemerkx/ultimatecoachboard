import MetalKit
import simd
import CoachBoardCore

// Layouts; must match Shaders3D.metal byte for byte.
struct Scene3DUniforms {
    var viewProjection: simd_float4x4
    var eye: SIMD4<Float>
    var light: SIMD4<Float>            // xyz toward the light, w ambient
    // Template colours.
    var hall: SIMD4<Float>
    var freeZone: SIMD4<Float>
    var court: SIMD4<Float>
    var lines: SIMD4<Float>
    var tintA: SIMD4<Float>
    var tintB: SIMD4<Float>
    var skin: SIMD4<Float>
    var shorts: SIMD4<Float>
    var pads: SIMD4<Float>
    var shoes: SIMD4<Float>
    var hair: SIMD4<Float>
    var zoneCount: UInt32
    var pad0: UInt32 = 0, pad1: UInt32 = 0, pad2: UInt32 = 0
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
    /// Jersey colour.
    var color: SIMD4<Float>
    /// Team colour of the fresnel rim (Section 3.2).
    var rim: SIMD4<Float>
    var dqOffset: UInt32
    var selected: UInt32
    /// POV: the viewer's own head and neck are culled (Section 5.1).
    var hideHead: UInt32 = 0
    var pad1: UInt32 = 0
}

/// A textured quad in the world: jersey numbers on the chest and back.
struct Decal3D {
    var origin: SIMD4<Float>
    var edgeU: SIMD4<Float>
    var edgeV: SIMD4<Float>
    var uvOrigin: SIMD2<Float>
    var uvSize: SIMD2<Float>
    var color: SIMD4<Float>
}

struct WallVertexGPU {
    var position: SIMD4<Float>         // w = height fraction
    var color: SIMD4<Float>
}

/// The hall from a video: walls and ceiling around the court, painted from the clip's clean background plate.
struct EnvUniformsGPU {
    var worldToImage: simd_float4x4
    /// rgb: the fill where the video never saw; a: brightness of the plate.
    var fallback: SIMD4<Float>
    /// Half width, half length and height of the hall box.
    var box: SIMD4<Float>
}

/// What the 3D board shows: players as avatars, zones on the floor and as walls, ink and routes as floor ribbons.
struct Scene3D: Equatable {
    struct Player: Equatable {
        var id: UUID
        var side: Side
        var point: FloorPoint
        var label: String
        /// Template role ("S", "OH1", "MB2", "L"...): picks the research posture variant of the position.
        var role: String
        var posture: Posture
        /// Between keyframes: the posture blend (joints slerp), which overrides `posture`.
        var blend: PostureBlend?
        var facing: Double
        var stature: Double
        var isLibero: Bool
        var selected: Bool
    }

    var players: [Player] = []
    var zones: [Zone] = []
    var zoneMorphs: [UUID: ZoneMorph] = [:]
    var zoneIntensities: [UUID: Double] = [:]
    var selectedZone: UUID?
    var ink: [[FloorPoint]] = []
    var highlights: [BoardScene.Route] = []
    /// 2.43 m men, 2.24 m women.
    var netHeight = 2.43

    /// The player whose eyes the camera uses (Section 5.1), with free-look offsets in radians.
    struct POV: Equatable {
        var player: UUID
        var yaw: Double
        var pitch: Double
    }
    var pov: POV?

    /// Gaze lasers (Section 5.6): eye to target; red and dashed from the first occlusion when under 50% visible.
    struct GazeRay: Equatable {
        var from: V3
        var to: V3
        var occlusion: V3?
        var visible: Bool
        var side: Side
    }
    var gaze: [GazeRay] = []

    /// Visual-field bands drawn as cones from the eye in third-person views (Section 5.7).
    struct FieldCones: Equatable {
        var eye: V3
        var forward: V3
        var side: Side
        var field: VisualField
    }
    var field: FieldCones?

    /// The ball and its solved flights (Section 5.4).
    var ball: V3?
    var ballPaths: [[V3]] = []

    /// A video scene's hall: the background plate projected through the video camera onto walls around the court.
    struct Backdrop: Equatable {
        var plate: URL
        /// World point to normalized image coordinates (u right, v down): q = M (p, 1), uv = q.xy / q.w, seen when q.w > 0.
        var worldToImage: simd_float4x4
        /// The hall box: walls at minX/maxX and minZ/maxZ, the ceiling at `height`. It holds the video camera, so the
        /// wall on the camera's side may stand much further out than the others.
        var minX: Double = -11.5
        var maxX: Double = 11.5
        var minZ: Double = -17
        var maxZ: Double = 17
        var height: Double = 10
    }
    var backdrop: Backdrop?
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
    private var decalPipeline: MTLRenderPipelineState!
    private var envPipeline: MTLRenderPipelineState!
    private var plateTexture: (url: URL, texture: MTLTexture)?
    /// Posed players of the last frame, for the jersey-number decals.
    private var posedPlayers: [(player: Scene3D.Player, joints: [Rigid], stature: Double)] = []
    private var depthWrite: MTLDepthStencilState!
    private var depthTestOnly: MTLDepthStencilState!
    private var depthOff: MTLDepthStencilState!
    private let atlas: GlyphAtlas?
    private var meshes: [Int: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)] = [:]
    private var skeletons: [Int: SkeletonModel] = [:]
    private var ballMesh: (vertices: MTLBuffer, indices: MTLBuffer, count: Int)?
    private var loggedFrame = false
    weak var view: MTKView?

    var scene = Scene3D() {
        didSet { if oldValue != scene { requestRedraw() } }
    }

    /// The orbit rig: gestures and presets move it.
    private(set) var camera: BoardCamera = .topDown(aspect: 1.5)
    /// The pose this frame renders from: the orbit, a player's POV, or a transition between them.
    private(set) var pose: CameraPose = BoardCamera.topDown(aspect: 1.5).pose
    private enum Move {
        case dolly(BoardCamera, BoardCamera)
        case flight(CameraPose)
    }
    private var transition: (move: Move, start: CFTimeInterval, duration: Double, done: (() -> Void)?)?
    /// While in POV the camera follows the player's eyes every frame (head-locked plus free-look).
    private(set) var inPOV = false

    init?(view: MTKView) {
        assert(MemoryLayout<Scene3DUniforms>.stride == 288 && MemoryLayout<Quad3D>.stride == 80 && MemoryLayout<AvatarVertexGPU>.stride == 48
               && MemoryLayout<EnvUniformsGPU>.stride == 96
               && MemoryLayout<AvatarInstanceGPU>.stride == 48 && MemoryLayout<WallVertexGPU>.stride == 32
               && MemoryLayout<Decal3D>.stride == 80, "must match Shaders3D.metal")
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
        view.clearDepth = 0            // reversed-Z (Section 3.2): near is 1, infinity 0
        view.clearColor = MTLClearColor(red: Tokens.hall.r, green: Tokens.hall.g, blue: Tokens.hall.b, alpha: 1)
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
        decalPipeline = make("decalVertex", "decalFragment", .premultiplied)
        envPipeline = make("envVertex", "envFragment", .none)

        func depth(_ compare: MTLCompareFunction, write: Bool) -> MTLDepthStencilState? {
            let d = MTLDepthStencilDescriptor()
            d.depthCompareFunction = compare
            d.isDepthWriteEnabled = write
            return device.makeDepthStencilState(descriptor: d)
        }
        depthWrite = depth(.greater, write: true)
        depthTestOnly = depth(.greaterEqual, write: false)
        depthOff = depth(.always, write: false)
        return [floorPipeline, quadPipeline, avatarPipeline, wallPipeline, glyphPipeline, decalPipeline, envPipeline].allSatisfy { $0 != nil }
            && depthWrite != nil && depthTestOnly != nil && depthOff != nil
    }

    func requestRedraw() { view?.setNeedsDisplay() }

    var aspect: Double {
        guard let v = view, v.bounds.height > 0 else { return 1.5 }
        return Double(v.bounds.width / v.bounds.height)
    }

    // MARK: - Camera

    /// Sets the orbit camera immediately (gestures), cancelling a running transition.
    func setCamera(_ c: BoardCamera) {
        transition = nil
        camera = c
        if !inPOV { pose = c.pose }
        requestRedraw()
    }

    /// A critically damped move to `target`: a dolly-zoom between orbit poses so the court keeps its size on screen
    /// (Section 3.2), or, when leaving a POV, the fly-out arc.
    func animateCamera(to target: BoardCamera, duration: Double = 0.9, completion: (() -> Void)? = nil) {
        let now = CACurrentMediaTime()
        if inPOV {
            inPOV = false
            camera = target
            transition = (.flight(pose), now, CameraPose.flightDuration(from: pose, to: target.pose), completion)
        } else {
            transition = (.dolly(camera, target), now, duration, completion)
        }
        runDisplayLink()
    }

    /// Fly into the POV player's eyes (Section 5.1: raised Bezier arc, slerped orientation, eased field of view).
    func flyToPOV() {
        guard let target = povPose() else { return }
        inPOV = true
        transition = (.flight(pose), CACurrentMediaTime(), CameraPose.flightDuration(from: pose, to: target), nil)
        runDisplayLink()
    }

    /// Fly back out of the POV to the orbit camera.
    func flyToOrbit() {
        guard inPOV else { return }
        inPOV = false
        transition = (.flight(pose), CACurrentMediaTime(), CameraPose.flightDuration(from: pose, to: camera.pose), nil)
        runDisplayLink()
    }

    private func runDisplayLink() {
        view?.enableSetNeedsDisplay = false
        view?.isPaused = false
    }

    var isAnimating: Bool { transition != nil }

    private func stepCamera(now: CFTimeInterval) {
        let target = inPOV ? (povPose() ?? camera.pose) : camera.pose
        guard let t = transition else {
            pose = target
            return
        }
        let f = min(1, (now - t.start) / t.duration)
        let e = criticallyDamped(f)
        switch t.move {
        case let .dolly(a, b):
            camera = BoardCamera.dollyZoom(from: a, to: b, t: e)
            pose = camera.pose
        case let .flight(from):
            pose = CameraPose.flight(from: from, to: target, t: e)
        }
        if f >= 1 {
            transition = nil
            pose = inPOV ? (povPose() ?? camera.pose) : camera.pose
            view?.isPaused = true
            view?.enableSetNeedsDisplay = true
            t.done?()
        }
    }

    /// The POV player's head-locked eye pose with free-look, from the same posed skeleton the avatar uses.
    private func povPose() -> CameraPose? {
        guard let spec = scene.pov, let p = scene.players.first(where: { $0.id == spec.player }),
              let m = mesh(stature: p.stature) else { return nil }
        let posed = p.blend.map { m.skeleton.pose($0, position: p.point, facing: p.facing, role: p.role) }
            ?? m.skeleton.pose(p.posture, position: p.point, facing: p.facing, role: p.role)
        return m.skeleton.povPose(posed, aspect: aspect, yaw: spec.yaw, pitch: spec.pitch)
    }

    // MARK: - Hit testing

    /// The floor point under a touch (Section 3.5.2), or nil above the horizon.
    func floorPoint(at p: CGPoint) -> FloorPoint? {
        guard let v = view, v.bounds.width > 0 else { return nil }
        let ndcX = Double(p.x / v.bounds.width) * 2 - 1
        let ndcY = 1 - Double(p.y / v.bounds.height) * 2
        return pose.floorPoint(ndcX: ndcX, ndcY: ndcY, aspect: aspect)
    }

    /// Screen position (points) of a world point, or nil behind the camera.
    func screenPoint(_ w: V3) -> CGPoint? {
        guard let v = view, let c = pose.project(w, aspect: aspect) else { return nil }
        return CGPoint(x: (c.x + 1) / 2 * Double(v.bounds.width), y: (1 - c.y) / 2 * Double(v.bounds.height))
    }

    /// The player whose body (feet to head, projected) passes closest to a touch, within 36 points.
    func player(at p: CGPoint) -> UUID? {
        var best: (UUID, CGFloat)?
        for player in scene.players where player.id != scene.pov?.player || !inPOV {
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
        let eye = pose.eye
        let light = SIMD3<Float>(0.3, 1, 0.45)
        let l = simd_normalize(light)
        let (zones, zoneVerts) = ZoneGPU.pack(scene.zones, selected: scene.selectedZone, morphs: scene.zoneMorphs,
                                              intensities: scene.zoneIntensities)
        view.clearColor = MTLClearColor(red: Tokens.hall.r, green: Tokens.hall.g, blue: Tokens.hall.b, alpha: 1)
        var u = Scene3DUniforms(viewProjection: simd_float4x4(pose.viewProjection(aspect: aspect)),
                                eye: SIMD4(Float(eye.x), Float(eye.y), Float(eye.z), 1),
                                light: SIMD4(l.x, l.y, l.z, Tokens.theme.isDark ? 0.35 : 0.5),
                                hall: Tokens.hall.simd, freeZone: Tokens.freeZone.simd, court: Tokens.court.simd,
                                lines: Tokens.courtLine.simd, tintA: Tokens.zoneA.simd, tintB: Tokens.zoneB.simd,
                                skin: Tokens.theme.skin.simd, shorts: Tokens.theme.shorts.simd, pads: Tokens.theme.pads.simd,
                                shoes: Tokens.theme.shoes.simd, hair: Tokens.theme.hair.simd, zoneCount: UInt32(zones.count))

        func buffer<T>(_ items: [T]) -> MTLBuffer? {
            guard !items.isEmpty else { return nil }
            return items.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }
        }

        // 0. A video scene's hall: walls and ceiling painted from the clip (opaque, writes depth).
        if let backdrop = scene.backdrop, let texture = plate(backdrop.plate) {
            let box = envBox(backdrop, eye: eye)
            if let vb = buffer(box) {
                var e = EnvUniformsGPU(worldToImage: backdrop.worldToImage,
                                       fallback: SIMD4(Float(Tokens.hall.r), Float(Tokens.hall.g), Float(Tokens.hall.b), 0.92),
                                       box: SIMD4(Float(backdrop.maxX - backdrop.minX) / 2, Float(backdrop.maxZ - backdrop.minZ) / 2,
                                                  Float(backdrop.height), 0))
                enc.setDepthStencilState(depthWrite)
                enc.setRenderPipelineState(envPipeline)
                enc.setVertexBuffer(vb, offset: 0, index: 0)
                enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
                enc.setFragmentBytes(&e, length: MemoryLayout<EnvUniformsGPU>.stride, index: 0)
                enc.setFragmentTexture(texture, index: 0)
                enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: box.count)
            }
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

        // 2. Avatars and the ball (opaque, write depth).
        let avatarCount = encodeAvatars(enc, uniforms: &u)
        encodeBall(enc, uniforms: &u)

        // 3. Floor ribbons, player rings and the net (blended, depth-tested).
        let quads = floorQuads() + netQuads() + gazeQuads(eye: eye) + ballQuads(eye: eye)
        if let qb = buffer(quads) {
            enc.setDepthStencilState(depthTestOnly)
            enc.setRenderPipelineState(quadPipeline)
            enc.setVertexBuffer(qb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: quads.count)
        }

        // 4. Zone walls and cylinders (additive, depth-tested, no depth write).
        let walls = wallVertices() + fieldCones()
        if let wb = buffer(walls) {
            enc.setDepthStencilState(depthTestOnly)
            enc.setRenderPipelineState(wallPipeline)
            enc.setVertexBuffer(wb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: walls.count)
        }

        // 5. Jersey numbers on the backs and chests (depth-tested decals).
        if let atlas, let db = buffer(numberDecals(atlas)) {
            enc.setDepthStencilState(depthTestOnly)
            enc.setRenderPipelineState(decalPipeline)
            enc.setVertexBuffer(db, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
            enc.setFragmentTexture(atlas.texture, index: 0)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: db.length / MemoryLayout<Decal3D>.stride)
        }

        // 6. Labels above the heads, always on top (screen-space SDF glyphs).
        if let atlas {
            var glyphs: [GlyphInstance] = []
            for p in scene.players where !(inPOV && p.id == scene.pov?.player) {
                guard let s = screenPoint(V3(p.point, y: p.stature + 0.32)) else { continue }
                glyphs += atlas.layout(p.label, center: s, height: 20, color: (p.selected ? Tokens.text : Tokens.text.withAlpha(0.85)).simd)
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
                          + "camera pitch \(Int((camera.pitch * 180 / .pi).rounded()))\u{00B0} distance \(String(format: "%.1f", camera.distance)) m"
                          + (scene.pov != nil ? ", POV" : "") + ", \(scene.gaze.count) gaze rays")
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
                                   normal: SIMD4(Float(n.x), Float(n.y), Float(n.z), Float(mesh.materials[i].rawValue)),
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
        posedPlayers = []
        for p in scene.players {
            let key = Int((p.stature * 100).rounded())
            guard let m = mesh(stature: p.stature) else { continue }
            let offset = UInt32(dqs.count / 2)
            let posed = p.blend.map { m.skeleton.pose($0, position: p.point, facing: p.facing, role: p.role) }
                ?? m.skeleton.pose(p.posture, position: p.point, facing: p.facing, role: p.role)
            posedPlayers.append((p, posed, p.stature))
            for dq in m.skeleton.skin(posed) {
                dqs.append(SIMD4(Float(dq.real.x), Float(dq.real.y), Float(dq.real.z), Float(dq.real.w)))
                dqs.append(SIMD4(Float(dq.dual.x), Float(dq.dual.y), Float(dq.dual.z), Float(dq.dual.w)))
            }
            // The libero wears a contrasting (white) jersey; the rim keeps the team colour.
            let team = Tokens.team(p.side)
            let jersey = p.isLibero ? Tokens.liberoJersey : team
            let hideHead: UInt32 = inPOV && transition == nil && p.id == scene.pov?.player ? 1 : 0
            groups[key, default: []].append(AvatarInstanceGPU(color: jersey.simd, rim: team.simd, dqOffset: offset,
                                                              selected: p.selected ? 1 : 0, hideHead: hideHead))
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
            let color = p.isLibero ? Tokens.liberoJersey : Tokens.team(p.side)
            q.append(quad(origin: V3(p.point.x - r, 0.012, p.point.z - r), u: V3(2 * r, 0, 0), v: V3(0, 0, 2 * r),
                          color: color.withAlpha(p.selected ? 1 : 0.8), pattern: 3))
        }
        for stroke in scene.ink where stroke.count > 1 {
            for i in 1..<stroke.count {
                if let r = ribbon(stroke[i - 1], stroke[i], width: 0.06, color: Tokens.ink) { q.append(r) }
            }
        }
        for h in scene.highlights {
            if let r = ribbon(h.a, h.b, width: 0.05, color: Tokens.text.withAlpha(0.9)) { q.append(r) }
        }
        return q
    }

    /// The net (Section 3.2): 1 m mesh hanging from the tape at net height, antennas, side cables and posts.
    private func netQuads() -> [Quad3D] {
        let nh = scene.netHeight
        let up = V3(0, 1, 0)
        var q: [Quad3D] = [
            quad(origin: V3(-4.95, nh - 1, 0), u: V3(9.9, 0, 0), v: up * 0.93, color: Tokens.net.withAlpha(0.75), pattern: 1),
            quad(origin: V3(-4.95, nh - 0.07, 0), u: V3(9.9, 0, 0), v: up * 0.07, color: Tokens.white.withAlpha(0.97)),
            quad(origin: V3(-4.95, nh - 1, 0), u: V3(9.9, 0, 0), v: up * 0.05, color: Tokens.white.withAlpha(0.9)),
        ]
        for s in [-1.0, 1.0] {
            // Antennas: 1.8 m, 0.8 m above the tape, on the outer edge of the side bands.
            let x = s * 4.55
            q.append(quad(origin: V3(x - 0.015, nh - 1, 0), u: V3(0.03, 0, 0), v: up * 1.8, color: Tokens.white, pattern: 2))
            q.append(quad(origin: V3(x, nh - 1, -0.015), u: V3(0, 0, 0.03), v: up * 1.8, color: Tokens.white, pattern: 2))
            // Cables to the posts and the posts themselves.
            for y in [nh - 0.02, nh - 0.98] {
                q.append(quad(origin: V3(s * 4.95, y, 0), u: V3(s * 0.55, 0, 0), v: up * 0.02, color: Tokens.net.withAlpha(0.6)))
            }
            let px = s * 5.5
            q.append(quad(origin: V3(px - 0.05, 0, 0), u: V3(0.1, 0, 0), v: up * (nh + 0.12), color: RGBA(hex: 0x8A93B8)))
            q.append(quad(origin: V3(px, 0, -0.05), u: V3(0, 0, 0.1), v: up * (nh + 0.12), color: RGBA(hex: 0x6A7398)))
        }
        return q
    }

    // MARK: - Jersey numbers

    /// Numbers as flat decals on the upper back (about 20 cm tall) and the chest (about 14 cm), following the chest
    /// joint, a few millimetres off the jersey.
    private func numberDecals(_ atlas: GlyphAtlas) -> [Decal3D] {
        var out: [Decal3D] = []
        for (p, joints, h) in posedPlayers where !(inPOV && transition == nil && p.id == scene.pov?.player) {
            let label = p.label
            guard label.allSatisfy(\.isNumber) else { continue }
            let chest = joints[Joint.chest.rawValue]
            // Numbers in white or ink, whichever stands out against the jersey.
            let jersey = p.isLibero ? Tokens.liberoJersey : Tokens.team(p.side)
            let ink = jersey.r * 0.299 + jersey.g * 0.587 + jersey.b * 0.114 > 0.62 ? RGBA(hex: 0x11183A) : Tokens.white
            let up = chest.rotation.rotate(V3(0, 1, 0))
            for front in [false, true] {
                let centre = chest.apply(front ? V3(0, -0.012 * h, 0.075 * h) : V3(0, -0.03 * h, -0.074 * h))
                // Text runs toward the player's left on the chest and toward the player's right on the back.
                let right = chest.rotation.rotate(V3(front ? 1 : -1, 0, 0))
                let height = (front ? 0.075 : 0.11) * h
                out += decalText(label, atlas: atlas, centre: centre, right: right, up: up, height: height, color: ink)
            }
        }
        return out
    }

    private func decalText(_ text: String, atlas: GlyphAtlas, centre: V3, right: V3, up: V3, height: Double, color: RGBA) -> [Decal3D] {
        let items = text.compactMap { atlas.glyphs[$0] }
        guard !items.isEmpty else { return [] }
        let tracking = 0.04 * height
        let total = items.reduce(0.0) { $0 + Double($1.advance) * height } + tracking * Double(items.count - 1)
        let margin = Double(GlyphAtlas.spread) / Double(GlyphAtlas.cell) * height
        var x = -total / 2
        var out: [Decal3D] = []
        func f4(_ v: V3) -> SIMD4<Float> { SIMD4(Float(v.x), Float(v.y), Float(v.z), 1) }
        for g in items {
            let origin = centre + right * (x - margin) - up * (height / 2)
            let width = Double(g.quadAspect) * height
            out.append(Decal3D(origin: f4(origin), edgeU: f4(right * width), edgeV: f4(up * height),
                               uvOrigin: g.uvOrigin, uvSize: g.uvSize, color: color.simd))
            x += Double(g.advance) * height + tracking
        }
        return out
    }

    // MARK: - Ball

    /// A 10.5 cm sphere drawn with the avatar pipeline: every vertex bound to one joint whose transform is the
    /// ball's translation.
    private func makeBallMesh() -> (vertices: MTLBuffer, indices: MTLBuffer, count: Int)? {
        let rings = 12, segments = 18, r = Float(BallFlight.radius)
        var verts: [AvatarVertexGPU] = []
        var idx: [UInt32] = []
        for i in 0...rings {
            let theta = -Float.pi / 2 + Float.pi * Float(i) / Float(rings)
            for k in 0..<segments {
                let phi = 2 * Float.pi * Float(k) / Float(segments)
                let n = SIMD3<Float>(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi))
                verts.append(AvatarVertexGPU(position: SIMD4(n * r, 1), normal: SIMD4(n, 1), skin: SIMD4(1, 0, 0, 0)))
            }
        }
        for i in 0..<rings {
            for k in 0..<segments {
                let a0 = UInt32(i * segments + k), a1 = UInt32(i * segments + (k + 1) % segments)
                let b0 = a0 + UInt32(segments), b1 = a1 + UInt32(segments)
                idx += [a0, a1, b0, a1, b1, b0]
            }
        }
        guard let vb = verts.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let ib = idx.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return nil }
        return (vb, ib, idx.count)
    }

    private func encodeBall(_ enc: MTLRenderCommandEncoder, uniforms u: inout Scene3DUniforms) {
        guard let b = scene.ball else { return }
        if ballMesh == nil { ballMesh = makeBallMesh() }
        guard let m = ballMesh else { return }
        let dq = DualQuat(Rigid(translation: b))
        var dqs: [SIMD4<Float>] = [SIMD4(Float(dq.real.x), Float(dq.real.y), Float(dq.real.z), Float(dq.real.w)),
                                   SIMD4(Float(dq.dual.x), Float(dq.dual.y), Float(dq.dual.z), Float(dq.dual.w))]
        var instance = AvatarInstanceGPU(color: Tokens.ball.simd, rim: Tokens.ball.simd, dqOffset: 0, selected: 1)
        enc.setDepthStencilState(depthWrite)
        enc.setRenderPipelineState(avatarPipeline)
        enc.setVertexBuffer(m.vertices, offset: 0, index: 0)
        enc.setVertexBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        enc.setFragmentBytes(&u, length: MemoryLayout<Scene3DUniforms>.stride, index: 1)
        enc.setVertexBytes(&instance, length: MemoryLayout<AvatarInstanceGPU>.stride, index: 2)
        enc.setVertexBytes(&dqs, length: MemoryLayout<SIMD4<Float>>.stride * 2, index: 3)
        enc.drawIndexedPrimitives(type: .triangle, indexCount: m.count, indexType: .uint32, indexBuffer: m.indices,
                                  indexBufferOffset: 0, instanceCount: 1)
    }

    /// The flight paths as thin dashed ribbons, and the ball's shadow ring on the floor.
    private func ballQuads(eye: V3) -> [Quad3D] {
        var q: [Quad3D] = []
        for path in scene.ballPaths where path.count > 1 {
            for i in 1..<path.count {
                if let r = billboard(path[i - 1], path[i], width: 0.025, eye: eye, color: Tokens.text.withAlpha(0.55), pattern: 4) { q.append(r) }
            }
        }
        if let b = scene.ball {
            let r = 0.16
            q.append(quad(origin: V3(b.x - r, 0.013, b.z - r), u: V3(2 * r, 0, 0), v: V3(0, 0, 2 * r),
                          color: Tokens.ball.withAlpha(0.7), pattern: 3))
        }
        return q
    }

    // MARK: - Gaze and field of view

    /// A ribbon from a to b that always faces the camera.
    private func billboard(_ a: V3, _ b: V3, width: Double, eye: V3, color: RGBA, pattern: UInt32 = 0) -> Quad3D? {
        let d = b - a
        guard d.length > 1e-4 else { return nil }
        let side = d.cross(eye - (a + b) * 0.5).normalized * width
        guard side.length > 1e-9 else { return nil }
        return quad(origin: a - side * 0.5, u: d, v: side, color: color, pattern: pattern)
    }

    private func gazeQuads(eye: V3) -> [Quad3D] {
        var q: [Quad3D] = []
        let red = RGBA(hex: 0xFF3B1A)
        for ray in scene.gaze {
            let team = Tokens.team(ray.side)
            let dir = (ray.to - ray.from).normalized
            // Out of the head; seen from the viewer's own eyes the first 1.2 m would fill the screen, so it is left out.
            let near = (eye - ray.from).length < 0.6 ? 1.2 : 0.12
            let length = (ray.to - ray.from).length
            guard length > near + 0.1 else { continue }
            let start = ray.from + dir * near
            if ray.visible || ray.occlusion == nil {
                if let r = billboard(start, ray.to, width: 0.035, eye: eye, color: team.withAlpha(0.9)) { q.append(r) }
            } else if let occlusion = ray.occlusion {
                let blockedEarly = (occlusion - ray.from).dot(dir) < near
                let o = blockedEarly ? start : occlusion
                if !blockedEarly, let r = billboard(start, o, width: 0.035, eye: eye, color: team.withAlpha(0.9)) { q.append(r) }
                if let r = billboard(o, ray.to, width: 0.035, eye: eye, color: red, pattern: 4) { q.append(r) }
                if blockedEarly { continue }
                // An X at the first occlusion.
                let toEye = (eye - o).normalized
                let ref = abs(toEye.y) < 0.9 ? V3.up : V3(1, 0, 0)
                let a = toEye.cross(ref).normalized, b = toEye.cross(a)
                for d in [(a + b).normalized, (a - b).normalized] {
                    if let r = billboard(o - d * 0.09, o + d * 0.09, width: 0.035, eye: eye, color: red) { q.append(r) }
                }
            }
        }
        return q
    }

    /// Nested translucent cones from the eye: central band at 20%, peripheral at 8% (Section 5.7).
    private func fieldCones() -> [WallVertexGPU] {
        guard let f = scene.field, !inPOV else { return [] }
        let fw = f.forward.normalized
        let right = fw.cross(.up).normalized
        let up = right.cross(fw)
        let tint = Tokens.team(f.side)
        func fan(_ directions: [V3], length: Double, alpha: Double) -> [WallVertexGPU] {
            let c = tint.withAlpha(alpha).simd
            func v(_ p: V3) -> WallVertexGPU { WallVertexGPU(position: SIMD4(Float(p.x), Float(p.y), Float(p.z), 0), color: c) }
            var out: [WallVertexGPU] = []
            for i in 0..<directions.count {
                let a = f.eye + directions[i] * length, b = f.eye + directions[(i + 1) % directions.count] * length
                out += [v(f.eye), v(a), v(b)]
            }
            return out
        }
        let n = 36
        let central = (0..<n).map { i -> V3 in
            let phi = 2 * Double.pi * Double(i) / Double(n)
            let s = sin(f.field.central * .pi / 180), c = cos(f.field.central * .pi / 180)
            return (fw * c + (right * cos(phi) + up * sin(phi)) * s).normalized
        }
        let peripheral = (0..<n).map { i -> V3 in
            let phi = 2 * Double.pi * Double(i) / Double(n)
            let th = f.field.peripheralHorizontal * cos(phi) * .pi / 180
            let tv = (sin(phi) >= 0 ? f.field.peripheralUp : f.field.peripheralDown) * sin(phi) * .pi / 180
            return ((fw * cos(th) + right * sin(th)) * cos(tv) + up * sin(tv)).normalized
        }
        return fan(peripheral, length: 2.2, alpha: 0.08) + fan(central, length: 3.5, alpha: 0.20)
    }

    // MARK: - Hall from video

    /// The clean plate as a texture, loaded once per file.
    private func plate(_ url: URL) -> MTLTexture? {
        if let p = plateTexture, p.url == url { return p.texture }
        guard let t = try? MTKTextureLoader(device: device).newTexture(URL: url, options: [.SRGB: false]) else { return nil }
        plateTexture = (url, t)
        return t
    }

    /// The hall box's walls and ceiling as triangles. A wall the eye is outside of is left out, so from the orbit
    /// camera the hall opens like a doll's house and from a player's eyes it closes all round.
    private func envBox(_ b: Scene3D.Backdrop, eye: V3) -> [SIMD4<Float>] {
        let x0 = b.minX, x1 = b.maxX, z0 = b.minZ, z1 = b.maxZ, h = b.height
        func quad(_ a: V3, _ bb: V3, _ c: V3, _ d: V3) -> [SIMD4<Float>] {
            [a, bb, c, a, c, d].map { SIMD4(Float($0.x), Float($0.y), Float($0.z), 1) }
        }
        var out: [SIMD4<Float>] = []
        if eye.x < x1 { out += quad(V3(x1, 0, z0), V3(x1, 0, z1), V3(x1, h, z1), V3(x1, h, z0)) }
        if eye.x > x0 { out += quad(V3(x0, 0, z0), V3(x0, 0, z1), V3(x0, h, z1), V3(x0, h, z0)) }
        if eye.z < z1 { out += quad(V3(x0, 0, z1), V3(x1, 0, z1), V3(x1, h, z1), V3(x0, h, z1)) }
        if eye.z > z0 { out += quad(V3(x0, 0, z0), V3(x1, 0, z0), V3(x1, h, z0), V3(x0, h, z0)) }
        if eye.y < h { out += quad(V3(x0, h, z0), V3(x1, h, z0), V3(x1, h, z1), V3(x0, h, z1)) }
        // The hall floor beyond the board's floor (x within +-10, z within +-17), where the hall is bigger.
        let fw = 10.0, fl = 17.0
        if z1 > fl { out += quad(V3(x0, 0, fl), V3(x1, 0, fl), V3(x1, 0, z1), V3(x0, 0, z1)) }
        if z0 < -fl { out += quad(V3(x0, 0, z0), V3(x1, 0, z0), V3(x1, 0, -fl), V3(x0, 0, -fl)) }
        let zz0 = max(z0, -fl), zz1 = min(z1, fl)
        if x1 > fw { out += quad(V3(fw, 0, zz0), V3(x1, 0, zz0), V3(x1, 0, zz1), V3(fw, 0, zz1)) }
        if x0 < -fw { out += quad(V3(x0, 0, zz0), V3(-fw, 0, zz0), V3(-fw, 0, zz1), V3(x0, 0, zz1)) }
        return out
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
            // A type-changing zone raises its wall along the morphing outline (both resampled and blended).
            var outline = zone.outline
            if let m = scene.zoneMorphs[zone.id],
               case let .polygon(blended) = ZoneInterpolation.interpolate(.polygon(outline), .polygon(ZoneSDF.outline(m.to)), m.t).0 {
                outline = blended
            }
            guard outline.count >= 2 else { continue }
            let intensity = scene.zoneIntensities[zone.id] ?? 1
            guard intensity > 0.001 else { continue }
            let tint = zone.style.tint == .pink ? Tokens.zoneA : Tokens.zoneB
            let alpha = (zone.id == scene.selectedZone ? 0.55 : 0.38) * intensity
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
