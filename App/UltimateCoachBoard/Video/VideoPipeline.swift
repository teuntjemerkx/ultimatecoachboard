import Foundation
import CoreGraphics
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

    /// A hall box that holds the camera (filmed from the stands, it may stand beyond the default walls).
    static func environment(for camera: VideoCamera) -> HallEnvironment {
        let c = camera.center
        return HallEnvironment(sideClearance: max(7, abs(c.x) - 4.5 + 1.5), endClearance: max(8, abs(c.z) - 9 + 1.5),
                               height: max(10, c.y + 1.5))
    }
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
        let plan = rally.ballPlan()
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
                                              title: "Sample rally", environment: VideoPipeline.environment(for: cam))
    }

    /// The sample rally saved like an imported one (scene, plate), for the demo screens.
    static func saved() -> (VideoScene, URL)? {
        guard let folder = try? VideoStore.newFolder() else { return nil }
        var scene = scene()
        let plate = plate(camera: scene.camera, environment: scene.environment)
        guard VideoVision.writePNG(plate, width: Int(scene.camera.width), height: Int(scene.camera.height),
                                   to: folder.appendingPathComponent(VideoStore.plateName)) else { return nil }
        scene.plateFile = VideoStore.plateName
        try? VideoStore.save(scene, in: folder)
        return (scene, folder)
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
