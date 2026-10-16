import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import Vision
import CoachBoardCore

/// Vision's findings to the core's video observations.
enum VideoPipeline {
    static let joints: [VNHumanBodyPoseObservation.JointName: BodyKeypoint] = [
        .nose: .nose, .leftEye: .leftEye, .rightEye: .rightEye, .leftEar: .leftEar, .rightEar: .rightEar, .neck: .neck,
        .leftShoulder: .leftShoulder, .rightShoulder: .rightShoulder, .leftElbow: .leftElbow, .rightElbow: .rightElbow,
        .leftWrist: .leftWrist, .rightWrist: .rightWrist, .root: .root, .leftHip: .leftHip, .rightHip: .rightHip,
        .leftKnee: .leftKnee, .rightKnee: .rightKnee, .leftAnkle: .leftAnkle, .rightAnkle: .rightAnkle,
    ]

    /// One observation per sampled frame (people with keypoints, standing where their feet meet the floor), plus
    /// ball-only frames from the trajectory detector.
    static func observations(_ frames: [VisionFrame], ball: [(t: Double, point: CGPoint)], camera: VideoCamera) -> [VideoFrameObservation] {
        var out = frames.map { f -> VideoFrameObservation in
            let detections = f.people.compactMap { p -> PersonDetection? in
                var kp: [BodyKeypoint: Keypoint2D] = [:]
                for (name, v) in p.keypoints {
                    if let k = joints[name] {
                        kp[k] = Keypoint2D(point: ImagePoint(x: Double(v.point.x), y: Double(v.point.y)), confidence: Double(v.confidence))
                    }
                }
                return PersonDetection(keypoints: kp, confidence: Double(p.confidence), camera: camera, boxHeight: Double(p.box.height),
                                       boxBottom: ImagePoint(x: Double(p.box.midX), y: Double(p.box.maxY)))
            }
            return VideoFrameObservation(time: f.time, detections: detections)
        }
        out += ball.map { VideoFrameObservation(time: $0.t, detections: [], ball: ImagePoint(x: Double($0.point.x), y: Double($0.point.y))) }
        return out.sorted { $0.time < $1.time }
    }

    /// The hall around the court at its usual distances; the 3D view widens it on the camera's side as needed.
    static func environment(for camera: VideoCamera) -> HallEnvironment { HallEnvironment() }
}

extension VideoCamera {
    /// The same camera for a frame of another size (same aspect): the focal length scales with the width.
    func scaled(toWidth w: Double, height h: Double) -> VideoCamera {
        let s = w / max(width, 1)
        return VideoCamera(focalLength: focalLength * s, width: w, height: h, rotation: rotation, center: center)
    }
}

/// A rally filmed by a synthetic camera in a synthetic hall: the demo and CI path through the real reconstruction.
/// The hall is ray-cast per pixel (court, free zone, stands, windows, banners, a lit ceiling) so the 3D view has a
/// background plate to project, and the players are the autopilot's rally seen through the camera as keypoints.
enum VideoDemo {
    static let camera = VideoCamera(center: V3(1.8, 6.5, 14.5), lookAt: V3(0, 0, -1.5), focalLength: 1100, width: 1280, height: 720)

    /// RGBA8 pixels of the empty hall as the camera sees it.
    static func plate(camera: VideoCamera, environment: HallEnvironment) -> [UInt8] {
        let w = Int(camera.width), h = Int(camera.height)
        var out = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let ray = camera.ray(through: ImagePoint(x: Double(x) + 0.5, y: Double(y) + 0.5))
                let c = environment.exitPoint(from: ray.origin, direction: ray.direction).map { colour(at: $0, environment) } ?? (40, 40, 48)
                let i = (y * w + x) * 4
                out[i] = c.0
                out[i + 1] = c.1
                out[i + 2] = c.2
            }
        }
        return out
    }

    private static func colour(at p: V3, _ e: HallEnvironment) -> (UInt8, UInt8, UInt8) {
        func rgb(_ hex: UInt32, _ k: Double = 1) -> (UInt8, UInt8, UInt8) {
            func ch(_ s: UInt32) -> UInt8 { UInt8(max(0, min(255, Double((hex >> s) & 0xFF) * k))) }
            return (ch(16), ch(8), ch(0))
        }
        if p.y < 0.01 {
            // Floor: court lines, the court, the free zone, the hall floor.
            let ax = abs(p.x), az = abs(p.z)
            let onLine = (ax <= 4.55 && (abs(az - 9) < 0.05 || abs(az - 3) < 0.05 || az < 0.025)) || (az <= 9.05 && abs(ax - 4.5) < 0.05)
            if onLine { return rgb(0xF4F4F0) }
            if ax <= 4.5 && az <= 9 { return rgb(0xD9823B) }
            if ax <= 7.5 && az <= 12 { return rgb(0x2E6DB4) }
            return rgb(0x7C828A)
        }
        if p.y > e.height - 0.01 {
            // Ceiling: light panels on a grid.
            let fx = (p.x / 3).rounded() * 3 - p.x, fz = (p.z / 3).rounded() * 3 - p.z
            return abs(fx) < 0.5 && abs(fz) < 0.9 ? rgb(0xF6F3E6) : rgb(0x4B4F57)
        }
        let along = abs(p.x) > e.halfWidth - 0.01 ? p.z : p.x
        let endWall = abs(p.z) > e.halfLength - 0.01
        if p.y < 0.9 { return rgb(0x31363E) }
        if p.y < 4.2 {
            // Stands: rows of seats with people here and there.
            let row = Int((p.y - 0.9) / 0.42)
            let seat = Int((along + 40) / 0.5)
            let person = (seat * 7 + row * 13) % 5 == 0
            if person { return [rgb(0x1F2A44), rgb(0xE8E2D0), rgb(0xB23A2E), rgb(0x3D6B3A)][(seat + row) % 4] }
            return row % 2 == 0 ? rgb(0xA9322A) : rgb(0x8A2721)
        }
        if p.y < 6.6 {
            // Banners on the end walls, windows on the side walls.
            if endWall && abs(along) < 6 && p.y > 4.6 && p.y < 6.0 {
                return Int((along + 6) / 1.5) % 2 == 0 ? rgb(0x1E4E8C) : rgb(0xF2C230)
            }
            if !endWall && p.y > 4.8 && abs(along.truncatingRemainder(dividingBy: 3.2)) < 1.1 { return rgb(0xBFD8EE) }
            return rgb(0xD8D1C3)
        }
        return rgb(0xB8B1A4, 1 - 0.25 * (p.y - 6.6) / max(e.height - 6.6, 1))
    }

    /// The autopilot's rally (attack on the left) filmed at 12 frames per second for `seconds`, rebuilt by the real
    /// pipeline: keypoints of the posed players and the ball pixel go in, a VideoScene comes out.
    static func scene(seconds: Double = 6.0) -> VideoScene {
        var rally = TacticalScene.placed(title: "Video rally", setup: SceneSetup())
        rally.playOut(.left)
        let plan = rally.ballPlan(netHeight: PlayerBodies.netHeight)
        let cam = camera
        let markers = Double(max(rally.timeline.count - 1, 1))
        var frames: [VideoFrameObservation] = []
        let fps = 12.0
        for k in 0...Int(seconds * fps) {
            let t = Double(k) / fps
            let phase = t / seconds * markers
            let f = rally.liveFrame(at: phase, plan: plan)
            var detections: [PersonDetection] = []
            for token in f.tokens {
                let s = SkeletonModel(BodyMetrics(stature: token.effectiveStature))
                let posture = token.posture ?? SceneToken.automaticPosture(at: token.point)
                let joints = f.postureBlends[token.id].map { s.pose($0, position: token.point, facing: token.facing, role: token.role) }
                    ?? s.pose(posture, position: token.point, facing: token.facing, role: token.role)
                var kp: [BodyKeypoint: Keypoint2D] = [:]
                for (name, p) in s.keypoints(joints) {
                    if let px = cam.project(p), cam.contains(px) { kp[name] = Keypoint2D(point: px, confidence: 0.9) }
                }
                if let d = PersonDetection(keypoints: kp, confidence: 0.9, camera: cam) { detections.append(d) }
            }
            let ball = plan.position(at: phase).flatMap { cam.project($0) }.flatMap { cam.contains($0) ? $0 : nil }
            frames.append(VideoFrameObservation(time: t, detections: detections, ball: ball))
        }
        return VideoReconstructor.reconstruct(frames: frames, camera: cam,
                                              homeLabels: [.p1: "8", .p2: "12", .p3: "4", .p4: "9", .p5: "14", .p6: "2"],
                                              netHeight: PlayerBodies.netHeight, title: "Sample rally",
                                              environment: VideoPipeline.environment(for: cam))
    }

    /// The sample rally saved like an imported one (scene, plate and a clip of it), for the demo screens.
    static func saved() -> (VideoScene, URL)? {
        guard let folder = try? VideoStore.newFolder() else { return nil }
        var scene = scene()
        let plate = plate(camera: scene.camera, environment: scene.environment)
        guard VideoVision.writePNG(plate, width: Int(scene.camera.width), height: Int(scene.camera.height),
                                   to: folder.appendingPathComponent(VideoStore.plateName)) else { return nil }
        scene.plateFile = VideoStore.plateName
        if writeClip(scene, plate: plate, to: folder.appendingPathComponent("clip.mp4")) { scene.videoFile = "clip.mp4" }
        scene.clipStart = 0
        try? VideoStore.save(scene, in: folder)
        return (scene, folder)
    }

    /// A clip of the sample rally: the hall plate with the players drawn as figures (limbs and head in team colours)
    /// and the ball, 24 frames per second, H.264.
    static func writeClip(_ scene: VideoScene, plate: [UInt8], to url: URL) -> Bool {
        let w = Int(scene.camera.width), h = Int(scene.camera.height), fps: Int32 = 24
        try? FileManager.default.removeItem(at: url)
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: .zero)
        var plateCopy = plate
        guard let plateImage = plateCopy.withUnsafeMutableBytes({ buf -> CGImage? in
            CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
        }) else { return false }
        let cam = scene.camera
        let bones: [(BodyKeypoint, BodyKeypoint)] = [(.leftAnkle, .leftKnee), (.leftKnee, .leftHip), (.rightAnkle, .rightKnee),
                                                     (.rightKnee, .rightHip), (.leftHip, .rightHip), (.leftHip, .leftShoulder),
                                                     (.rightHip, .rightShoulder), (.leftShoulder, .rightShoulder),
                                                     (.leftShoulder, .leftElbow), (.leftElbow, .leftWrist),
                                                     (.rightShoulder, .rightElbow), (.rightElbow, .rightWrist), (.neck, .nose)]
        let frames = Int(scene.duration * Double(fps))
        for k in 0...frames {
            let t = Double(k) / Double(fps)
            var buffer: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
                  let pb = buffer else { return false }
            CVPixelBufferLockBaseAddress(pb, [])
            if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                ctx.draw(plateImage, in: CGRect(x: 0, y: 0, width: w, height: h))
                // Image coordinates are y down; the context's are y up.
                ctx.translateBy(x: 0, y: CGFloat(h))
                ctx.scaleBy(x: 1, y: -1)
                ctx.setLineCap(.round)
                let frame = scene.frame(at: t)
                // Far players first so near ones overlap them.
                let posed = frame.posedPlayers().sorted { ($0.token.point.z) < ($1.token.point.z) }
                for p in posed {
                    let kp = p.skeleton.keypoints(p.joints).compactMapValues { cam.project($0) }
                    let team = p.token.side == .home ? Tokens.home : Tokens.opponent
                    let colour = CGColor(red: CGFloat(team.r), green: CGFloat(team.g), blue: CGFloat(team.b), alpha: 1)
                    let depth = max(4, (V3(p.token.point) - cam.center).length)
                    ctx.setStrokeColor(colour)
                    ctx.setLineWidth(CGFloat(cam.focalLength * 0.11 / depth))
                    for (a, b) in bones {
                        guard let pa = kp[a], let pb = kp[b] else { continue }
                        ctx.move(to: CGPoint(x: pa.x, y: pa.y))
                        ctx.addLine(to: CGPoint(x: pb.x, y: pb.y))
                    }
                    ctx.strokePath()
                    if let nose = kp[.nose] {
                        let r = CGFloat(cam.focalLength * 0.11 / depth)
                        ctx.setFillColor(CGColor(red: 0.85, green: 0.68, blue: 0.55, alpha: 1))
                        ctx.fillEllipse(in: CGRect(x: nose.x - r, y: nose.y - r, width: 2 * r, height: 2 * r))
                    }
                }
                if let b = frame.ball, let px = cam.project(b) {
                    let r = CGFloat(cam.focalLength * 0.105 / max(2, (b - cam.center).length))
                    ctx.setFillColor(CGColor(red: 0.98, green: 0.85, blue: 0.2, alpha: 1))
                    ctx.fillEllipse(in: CGRect(x: px.x - r, y: px.y - r, width: 2 * r, height: 2 * r))
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(k), timescale: fps)) else { return false }
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        return writer.status == .completed
    }

    /// A GIF (CI's real broadcast sample) as an H.264 movie with the GIF's own frame timing.
    static func movie(fromGIF gif: URL, to url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(gif as CFURL, nil) else { return false }
        let count = CGImageSourceGetCount(source)
        guard count > 1, let first = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
        let w = first.width / 2 * 2, h = first.height / 2 * 2
        try? FileManager.default.removeItem(at: url)
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: .zero)
        var t = 0.0
        for i in 0..<count {
            guard let image = CGImageSourceCreateImageAtIndex(source, i, nil) else { continue }
            let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any]
            let gifProps = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gifProps?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (gifProps?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
            var buffer: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
                  let pb = buffer else { return false }
            CVPixelBufferLockBaseAddress(pb, [])
            CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?
                .draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            CVPixelBufferUnlockBaseAddress(pb, [])
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard adaptor.append(pb, withPresentationTime: CMTime(seconds: t, preferredTimescale: 600)) else { return false }
            t += max(delay, 0.02)
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        return writer.status == .completed
    }

    /// The empty hall as a still, for the court-marking screen.
    static func still() -> CGImage? {
        let env = VideoPipeline.environment(for: camera)
        var pixels = plate(camera: camera, environment: env)
        let w = Int(camera.width), h = Int(camera.height)
        return pixels.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
        }
    }
}
