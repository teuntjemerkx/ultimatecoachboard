import AVFoundation
import CoreGraphics
import CoreImage
import CoreML
import ImageIO
import Vision

extension VNRequest {
    /// The Simulator has no Neural Engine, and Vision's people models fail to set up there unless they run on the CPU.
    /// On an iPad this does nothing: the models pick the Neural Engine themselves.
    func runsOnCPUInSimulator() -> Self {
        #if targetEnvironment(simulator)
        let stages = (try? self.supportedComputeStageDevices) ?? [:]
        for (stage, devices) in stages {
            for device in devices {
                guard case .cpu = device else { continue }
                setComputeDevice(device, for: stage)
                break
            }
        }
        #endif
        return self
    }
}

/// What Apple's on-device Vision models see in one frame of a clip: people with their body keypoints, and a mask
/// of where people are (for the clean background plate). Pixel coordinates of the upright frame, origin top-left.
struct VisionFrame {
    struct Person {
        /// Bounding box in pixels.
        var box: CGRect
        /// Keypoints by Vision joint name, in pixels, with confidence 0...1.
        var keypoints: [VNHumanBodyPoseObservation.JointName: (point: CGPoint, confidence: Float)]
        var confidence: Float
    }

    var time: Double
    var size: CGSize
    var people: [Person]
}

/// Reads a clip with AVFoundation and runs Vision on it: body pose and person boxes on sampled frames, ball
/// trajectories on every frame, person segmentation and frames for the clean plate.
enum VideoVision {
    struct Clip {
        var asset: AVURLAsset
        var duration: Double
        var size: CGSize
        var fps: Double
        var orientation: CGImagePropertyOrientation
    }

    static func open(_ url: URL) async throws -> Clip {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw NSError(domain: "VideoVision", code: 1, userInfo: [NSLocalizedDescriptionKey: "This file has no video."])
        }
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let fps = Double(try await track.load(.nominalFrameRate))
        let upright = natural.applying(transform)
        return Clip(asset: asset, duration: duration, size: CGSize(width: abs(upright.width), height: abs(upright.height)),
                    fps: fps > 0 ? fps : 30, orientation: orientation(of: transform))
    }

    /// The display orientation of a track's preferred transform, for Vision requests on raw sample buffers.
    static func orientation(of t: CGAffineTransform) -> CGImagePropertyOrientation {
        switch (t.a, t.b, t.c, t.d) {
        case (0, 1, -1, 0): return .right
        case (0, -1, 1, 0): return .left
        case (-1, 0, 0, -1): return .down
        default: return .up
        }
    }

    /// An upright still at a time, at most `maxSide` pixels on its long side.
    static func image(_ clip: Clip, at time: Double, maxSide: CGFloat = 1920) async throws -> CGImage {
        let g = AVAssetImageGenerator(asset: clip.asset)
        g.appliesPreferredTrackTransform = true
        g.maximumSize = CGSize(width: maxSide, height: maxSide)
        g.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 60)
        g.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 60)
        return try await g.image(at: CMTime(seconds: time, preferredTimescale: 600)).image
    }

    /// People in sampled frames of [start, end] at `rate` frames per second.
    static func people(_ clip: Clip, from start: Double, to end: Double, rate: Double = 10, maxSide: CGFloat = 1920,
                       progress: @escaping (Double) -> Void) async throws -> [VisionFrame] {
        let g = AVAssetImageGenerator(asset: clip.asset)
        g.appliesPreferredTrackTransform = true
        g.maximumSize = CGSize(width: maxSide, height: maxSide)
        g.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 120)
        g.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 120)
        let count = max(2, Int(((end - start) * rate).rounded()) + 1)
        let times = (0..<count).map { CMTime(seconds: start + (end - start) * Double($0) / Double(count - 1), preferredTimescale: 600) }
        var out: [VisionFrame] = []
        for await result in g.images(for: times) {
            guard case let .success(requestedTime: _, image: image, actualTime: actual) = result else { continue }
            out.append(try detect(image, time: actual.seconds - start))
            progress(Double(out.count) / Double(count))
        }
        return out.sorted { $0.time < $1.time }
    }

    /// Body pose plus person boxes; each pose is paired with the box that holds most of its keypoints.
    static func detect(_ image: CGImage, time: Double) throws -> VisionFrame {
        let size = CGSize(width: image.width, height: image.height)
        let pose = VNDetectHumanBodyPoseRequest().runsOnCPUInSimulator()
        let boxes = VNDetectHumanRectanglesRequest().runsOnCPUInSimulator()
        boxes.upperBodyOnly = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([pose, boxes])
        func px(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height) }
        func rect(_ r: CGRect) -> CGRect {
            CGRect(x: r.minX * size.width, y: (1 - r.maxY) * size.height, width: r.width * size.width, height: r.height * size.height)
        }
        var people: [VisionFrame.Person] = []
        var freeBoxes = (boxes.results ?? []).map { (rect($0.boundingBox), $0.confidence) }
        for obs in pose.results ?? [] {
            guard let points = try? obs.recognizedPoints(.all) else { continue }
            var kp: [VNHumanBodyPoseObservation.JointName: (point: CGPoint, confidence: Float)] = [:]
            for (name, p) in points where p.confidence > 0.1 { kp[name] = (px(p.location), p.confidence) }
            guard kp.count >= 4 else { continue }
            let xs = kp.values.map(\.point.x), ys = kp.values.map(\.point.y)
            var box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
            // The person box (when one matches) reaches the feet even when the ankles were not found.
            if let i = freeBoxes.indices.max(by: { overlap(freeBoxes[$0].0, box) < overlap(freeBoxes[$1].0, box) }),
               overlap(freeBoxes[i].0, box) > 0.5 {
                box = freeBoxes[i].0.union(box)
                freeBoxes.remove(at: i)
            }
            people.append(.init(box: box, keypoints: kp, confidence: obs.confidence))
        }
        // People found by the box detector only (small and far away): a box and no keypoints.
        for (b, c) in freeBoxes where c > 0.5 { people.append(.init(box: b, keypoints: [:], confidence: c * 0.5)) }
        return VisionFrame(time: time, size: size, people: people)
    }

    /// Share of `b`'s area inside `a`.
    static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        guard !i.isNull, b.width * b.height > 0 else { return 0 }
        return i.width * i.height / max(b.width * b.height, 1)
    }

    /// Ball candidates on every frame of [start, end]: Vision's parabolic trajectory detection (stationary cameras),
    /// as (clip time from `start`, pixel in the upright frame of `size`).
    static func ball(_ clip: Clip, from start: Double, to end: Double, size: CGSize) async throws -> [(t: Double, point: CGPoint)] {
        guard let track = try await clip.asset.loadTracks(withMediaType: .video).first else { return [] }
        let reader = try AVAssetReader(asset: clip.asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                                       end: CMTime(seconds: end, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { return [] }
        var points: [Double: CGPoint] = [:]
        let request = VNDetectTrajectoriesRequest(frameAnalysisSpacing: .zero, trajectoryLength: 8).runsOnCPUInSimulator()
        // A volleyball is about 0.21 m across: a small object, never a person.
        request.objectMinimumNormalizedRadius = 0.002
        request.objectMaximumNormalizedRadius = 0.03
        let handler = VNSequenceRequestHandler()
        while let sample = output.copyNextSampleBuffer() {
            guard (try? handler.perform([request], on: sample, orientation: clip.orientation)) != nil else { continue }
            // Trajectories grow frame by frame; the same point comes back on later frames, keyed by its time.
            for obs in request.results ?? [] where obs.confidence > 0.6 {
                let t0 = obs.timeRange.start.seconds, t1 = obs.timeRange.end.seconds
                let n = obs.detectedPoints.count
                for (i, p) in obs.detectedPoints.enumerated() {
                    let t = n > 1 ? t0 + (t1 - t0) * Double(i) / Double(n - 1) : t0
                    points[(t * 240).rounded() / 240] = CGPoint(x: CGFloat(p.x) * size.width, y: (1 - CGFloat(p.y)) * size.height)
                }
            }
        }
        return points.map { (t: $0.key - start, point: $0.value) }.sorted { $0.t < $1.t }
    }

    /// Frames and person masks for the clean background plate, `count` stills across [start, end] at `size`
    /// (RGBA8, row-major), masks non-zero where a person is.
    static func plateFrames(_ clip: Clip, from start: Double, to end: Double, count: Int = 24,
                            size: CGSize) async throws -> (frames: [[UInt8]], masks: [[UInt8]]) {
        let g = AVAssetImageGenerator(asset: clip.asset)
        g.appliesPreferredTrackTransform = true
        g.maximumSize = CGSize(width: max(size.width, size.height), height: max(size.width, size.height))
        g.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 10)
        g.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
        let times = (0..<count).map { CMTime(seconds: start + (end - start) * (Double($0) + 0.5) / Double(count), preferredTimescale: 600) }
        var frames: [[UInt8]] = [], masks: [[UInt8]] = []
        let w = Int(size.width), h = Int(size.height)
        for await result in g.images(for: times) {
            guard case let .success(requestedTime: _, image: image, actualTime: _) = result,
                  let rgba = pixels(image, width: w, height: h) else { continue }
            frames.append(rgba)
            masks.append(personMask(image, width: w, height: h) ?? [UInt8](repeating: 0, count: w * h))
        }
        return (frames, masks)
    }

    /// RGBA8 pixels of an image scaled to width x height.
    static func pixels(_ image: CGImage, width: Int, height: Int) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let ok = data.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return ok ? data : nil
    }

    /// Where people are (Vision person segmentation), grown a little so edges and shadows stay out of the plate.
    static func personMask(_ image: CGImage, width: Int, height: Int) -> [UInt8]? {
        let request = VNGeneratePersonSegmentationRequest().runsOnCPUInSimulator()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        guard (try? VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])) != nil,
              let buffer = request.results?.first?.pixelBuffer else { return nil }
        let mask = CIImage(cvPixelBuffer: buffer)
        let sx = CGFloat(width) / mask.extent.width, sy = CGFloat(height) / mask.extent.height
        let grown = mask.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .applyingFilter("CIMorphologyMaximum", parameters: [kCIInputRadiusKey: 6])
            .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
        var out = [UInt8](repeating: 0, count: width * height)
        let ctx = CIContext(options: [.workingColorSpace: NSNull()])
        out.withUnsafeMutableBytes { buf in
            ctx.render(grown, toBitmap: buf.baseAddress!, rowBytes: width, bounds: CGRect(x: 0, y: 0, width: width, height: height),
                       format: .L8, colorSpace: nil)
        }
        return out.map { $0 > 40 ? 255 : 0 }
    }

    /// RGBA8 pixels to a PNG file.
    static func writePNG(_ rgba: [UInt8], width: Int, height: Int, to url: URL) -> Bool {
        var data = rgba
        guard let image = data.withUnsafeMutableBytes({ buf -> CGImage? in
            CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
        }), let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest)
    }
}
