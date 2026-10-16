import Foundation
import CoreGraphics
import PhotosUI
import SwiftUI
import CoachBoardCore

/// The Video to 3D flow: load a clip, mark the court, then run Vision and the reconstruction.
@MainActor
@Observable
final class VideoImportModel {
    enum Step: Equatable { case choose, mark, building, failed(String) }
    enum Fit { case good, rough, unknown }

    struct Corner {
        var label: String
        var ours: Bool
        var point: CGPoint
    }

    var step: Step = .choose
    private(set) var loading = false
    private(set) var still: CGImage?
    private(set) var imageSize: CGSize = .zero
    private(set) var duration = 0.0
    private(set) var start = 0.0
    private(set) var corners: [Corner] = []
    private(set) var fit: Fit = .unknown
    private(set) var courtLines: [(CGPoint, CGPoint)] = []
    private(set) var progress = 0.0
    private(set) var stage = ""
    private(set) var finished = false
    private(set) var result: VideoScene?
    private(set) var folder: URL?

    private var clip: VideoVision.Clip?
    private var sourceURL: URL?
    private var calibration: CalibrationResult?
    private var stillTask: Task<Void, Never>?

    var canBuild: Bool { calibration != nil && fit != .unknown }

    /// The clip's length used for the rally (Section 4.1: 4 to 10 s).
    var end: Double { min(duration, start + 10) }

    func load(_ item: PhotosPickerItem) async {
        loading = true
        defer { loading = false }
        do {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                step = .failed("That video could not be opened.")
                return
            }
            let clip = try await VideoVision.open(movie.url)
            guard clip.duration >= 1 else {
                step = .failed("That video is too short. Choose a clip of 4 to 10 seconds.")
                return
            }
            self.clip = clip
            sourceURL = movie.url
            duration = clip.duration
            start = 0
            let image = try await VideoVision.image(clip, at: 0.2)
            still = image
            imageSize = CGSize(width: image.width, height: image.height)
            placeDefaultCorners()
            solve()
            step = .mark
        } catch {
            step = .failed("That video could not be read: \(error.localizedDescription)")
        }
    }

    /// Demo and CI: the court-marking step on a still, the dots near (not on) the corners.
    func demo(still image: CGImage, camera: VideoCamera) {
        still = image
        imageSize = CGSize(width: image.width, height: image.height)
        duration = 8
        func at(_ p: V3, _ dx: Double, _ dy: Double) -> CGPoint {
            let q = camera.project(p) ?? ImagePoint(x: 0, y: 0)
            return CGPoint(x: q.x + dx, y: q.y + dy)
        }
        corners = [
            Corner(label: "THEM", ours: false, point: at(V3(4.5, 0, -9), 3, -2)),
            Corner(label: "THEM", ours: false, point: at(V3(-4.5, 0, -9), -2, 2)),
            Corner(label: "US", ours: true, point: at(V3(-4.5, 0, 9), 4, -3)),
            Corner(label: "US", ours: true, point: at(V3(4.5, 0, 9), -3, 3)),
        ]
        solve()
        step = .mark
    }

    /// Starting dots in a typical end-line view: their end line narrow and high, ours wide and low.
    private func placeDefaultCorners() {
        let w = imageSize.width, h = imageSize.height
        corners = [
            Corner(label: "THEM", ours: false, point: CGPoint(x: w * 0.36, y: h * 0.30)),
            Corner(label: "THEM", ours: false, point: CGPoint(x: w * 0.64, y: h * 0.30)),
            Corner(label: "US", ours: true, point: CGPoint(x: w * 0.92, y: h * 0.86)),
            Corner(label: "US", ours: true, point: CGPoint(x: w * 0.08, y: h * 0.86)),
        ]
    }

    func setStart(_ t: Double) {
        start = max(0, min(t, max(0, duration - 4)))
        stillTask?.cancel()
        guard let clip else { return }
        let at = start + 0.2
        stillTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled, let image = try? await VideoVision.image(clip, at: at) else { return }
            self?.still = image
        }
    }

    func move(corner i: Int, to p: CGPoint) {
        guard corners.indices.contains(i) else { return }
        corners[i].point = p
        solve()
    }

    /// Calibrates the camera from the dots and projects the court lines back as the coach's check.
    func solve() {
        let ours = corners.filter(\.ours).map { ImagePoint(x: Double($0.point.x), y: Double($0.point.y)) }
        let theirs = corners.filter { !$0.ours }.map { ImagePoint(x: Double($0.point.x), y: Double($0.point.y)) }
        guard let r = CourtCalibration.solveCorners(ourEnd: ours, theirEnd: theirs,
                                                    imageWidth: Double(imageSize.width), imageHeight: Double(imageSize.height)) else {
            calibration = nil
            fit = .unknown
            courtLines = []
            return
        }
        calibration = r
        fit = r.quality == .good ? .good : (r.quality == .rough ? .rough : .unknown)
        courtLines = Self.courtSegments().compactMap { a, b in
            guard let pa = r.camera.project(a), let pb = r.camera.project(b) else { return nil }
            return (CGPoint(x: pa.x, y: pa.y), CGPoint(x: pb.x, y: pb.y))
        }
    }

    /// The court's lines and the net's top edge, split into short pieces so they bend with the lens.
    static func courtSegments(netHeight: Double = 2.43) -> [(V3, V3)] {
        var lines: [(V3, V3)] = [
            (V3(-4.5, 0, -9), V3(4.5, 0, -9)), (V3(-4.5, 0, 9), V3(4.5, 0, 9)),
            (V3(-4.5, 0, -9), V3(-4.5, 0, 9)), (V3(4.5, 0, -9), V3(4.5, 0, 9)),
            (V3(-4.5, 0, 0), V3(4.5, 0, 0)), (V3(-4.5, 0, -3), V3(4.5, 0, -3)), (V3(-4.5, 0, 3), V3(4.5, 0, 3)),
            (V3(-4.5, netHeight, 0), V3(4.5, netHeight, 0)),
            (V3(-4.5, 0, 0), V3(-4.5, netHeight, 0)), (V3(4.5, 0, 0), V3(4.5, netHeight, 0)),
        ]
        lines = lines.flatMap { a, b -> [(V3, V3)] in
            (0..<6).map { k in
                let t0 = Double(k) / 6, t1 = Double(k + 1) / 6
                return (a + (b - a) * t0, a + (b - a) * t1)
            }
        }
        return lines
    }

    /// Runs Vision on the clip, reconstructs the 3D rally and stores it with the clip and its background plate.
    func build() async {
        guard let clip, let calibration, let sourceURL else { return }
        step = .building
        progress = 0
        stage = "Finding players"
        let start = self.start, end = self.end
        do {
            let folder = try VideoStore.newFolder()
            let frames = try await VideoVision.people(clip, from: start, to: end) { p in
                Task { @MainActor [weak self] in self?.progress = 0.05 + 0.5 * p }
            }
            stage = "Tracking the ball"
            progress = 0.58
            let size = frames.first?.size ?? imageSize
            let ball = (try? await VideoVision.ball(clip, from: start, to: end, size: size)) ?? []
            stage = "Building the hall"
            progress = 0.68
            let pw = 960, ph = Int((960 * size.height / max(size.width, 1)).rounded())
            let (stills, masks) = try await VideoVision.plateFrames(clip, from: start, to: end, size: CGSize(width: pw, height: ph))
            // The temporal median removes the players and the ball: what stays is the hall.
            let plate = await Task.detached(priority: .userInitiated) {
                CleanPlate.median(frames: stills, masks: masks, width: pw, height: ph)
            }.value
            _ = VideoVision.writePNG(plate, width: pw, height: ph, to: folder.appendingPathComponent(VideoStore.plateName))
            stage = "Reading body positions"
            progress = 0.8
            // The camera was calibrated on the still; Vision frames may be a different size.
            let camera = calibration.camera.scaled(toWidth: Double(size.width), height: Double(size.height))
            let observations = VideoPipeline.observations(frames, ball: ball, camera: camera)
            let title = "Video \(Date().formatted(date: .abbreviated, time: .shortened))"
            var scene = await Task.detached(priority: .userInitiated) {
                VideoReconstructor.reconstruct(frames: observations, camera: camera, netHeight: 2.43, title: title,
                                               environment: VideoPipeline.environment(for: camera))
            }.value
            guard !scene.players.isEmpty else {
                step = .failed("No players were found. Try a clip where the whole court is in view.")
                return
            }
            let videoName = "clip." + (sourceURL.pathExtension.isEmpty ? "mov" : sourceURL.pathExtension)
            try? FileManager.default.copyItem(at: sourceURL, to: folder.appendingPathComponent(videoName))
            scene.videoFile = videoName
            scene.plateFile = VideoStore.plateName
            try VideoStore.save(scene, in: folder)
            progress = 1
            self.folder = folder
            result = scene
            finished = true
        } catch {
            step = .failed("Building the 3D rally failed: \(error.localizedDescription)")
        }
    }
}

/// Video scenes on disk: Application Support/Videos/<id>/ with scene.json, the clip and plate.png.
enum VideoStore {
    static let plateName = "plate.png"

    static func directory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Videos", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func newFolder() throws -> URL {
        let dir = try directory().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func save(_ scene: VideoScene, in folder: URL) throws {
        try JSONEncoder().encode(scene).write(to: folder.appendingPathComponent("scene.json"), options: .atomic)
    }

    static func list() -> [SavedVideo] {
        guard let dir = try? directory(),
              let folders = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return folders.compactMap { f in
            guard let data = try? Data(contentsOf: f.appendingPathComponent("scene.json")),
                  let s = try? JSONDecoder().decode(VideoScene.self, from: data) else { return nil }
            return SavedVideo(scene: s, folder: f)
        }
        .sorted { $0.scene.createdAt > $1.scene.createdAt }
    }
}

struct SavedVideo: Identifiable {
    var scene: VideoScene
    var folder: URL
    var id: UUID { scene.id }
}
