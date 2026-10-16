import SwiftUI
import AVFoundation
import CoachBoardCore

/// Watching a rebuilt video: the clip plays with a ring on every player; tapping one flies into that player's eyes,
/// and the eye view keeps running with the clip (shown small in the corner). "Court" shows the 3D court instead.
@MainActor
@Observable
final class VideoWatchController {
    enum Mode { case video, court }

    let scene: VideoScene
    let folder: URL
    let studio: StudioController
    let player: AVPlayer?
    private(set) var time = 0.0
    private(set) var playing = false
    private(set) var slowMotion = false
    var mode: Mode = .video
    @ObservationIgnored private var observer: Any?
    @ObservationIgnored private var clock: Task<Void, Never>?

    init(scene: VideoScene, folder: URL) {
        self.scene = scene
        self.folder = folder
        studio = StudioController(video: scene, folder: folder)
        let file = scene.videoFile.map { folder.appendingPathComponent($0) }
        if let file, FileManager.default.fileExists(atPath: file.path) {
            let p = AVPlayer(url: file)
            p.actionAtItemEnd = .pause
            player = p
            seekPlayer(to: 0)
            observer = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
                MainActor.assumeIsolated { self?.tick(t.seconds) }
            }
        } else {
            player = nil
        }
    }

    /// The player whose eyes the view shows, if any.
    var eyeOf: UUID? { studio.povPlayer }

    var markers: [VideoMarker] { scene.markers(at: time) }

    var duration: Double { scene.duration }

    var plateImage: UIImage? { scene.plateFile.flatMap { UIImage(contentsOfFile: folder.appendingPathComponent($0).path) } }

    private var clipStart: Double { scene.clipStart ?? 0 }

    private func tick(_ seconds: Double) {
        guard playing else { return }
        set(time: seconds - clipStart)
        if time >= duration - 1e-3, playing { pause() }
    }

    private func set(time t: Double) {
        time = max(0, min(duration, t))
        studio.followVideo(at: time)
    }

    private func seekPlayer(to t: Double) {
        player?.seek(to: CMTime(seconds: clipStart + t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func togglePlay() { playing ? pause() : play() }

    func play() {
        if time >= duration - 1e-3 { seek(to: 0) }
        playing = true
        let rate: Float = slowMotion ? 0.5 : 1
        if let player {
            player.rate = rate
        } else {
            // No clip on disk (the sample rally): a clock of our own.
            let start = Date(), from = time
            clock = Task { [weak self] in
                while !Task.isCancelled, let self, self.playing {
                    self.set(time: from + Date().timeIntervalSince(start) * Double(rate))
                    if self.time >= self.duration - 1e-3 { self.pause(); break }
                    try? await Task.sleep(nanoseconds: 16_000_000)
                }
            }
        }
    }

    func pause() {
        playing = false
        player?.pause()
        clock?.cancel()
        clock = nil
    }

    func seek(to t: Double) {
        set(time: t)
        seekPlayer(to: time)
    }

    func toggleSlowMotion() {
        slowMotion.toggle()
        if playing {
            pause()
            play()
        }
    }

    /// Into a player's eyes at the current moment.
    func watch(_ id: UUID) {
        studio.followVideo(at: time)
        studio.selectToken(id)
        studio.enterPOV()
    }

    func backToVideo() {
        studio.exitPOV()
        studio.selectToken(nil)
        mode = .video
    }

    func stop() {
        pause()
        if let observer { player?.removeTimeObserver(observer) }
        observer = nil
    }
}

struct VideoWatchView: View {
    @Bindable var controller: VideoWatchController
    var onExit: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .topTrailing) {
                if controller.eyeOf != nil || controller.mode == .court {
                    Studio3DBoardView(controller: controller.studio)
                    if controller.eyeOf != nil {
                        FieldRings().allowsHitTesting(false)
                        videoSurface(markers: false)
                            .frame(width: 300, height: 300 * aspectInverse)
                            .clipShape(RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.text.withAlpha(0.6).color, lineWidth: 2))
                            .shadow(radius: 10)
                            .padding(16)
                            .onTapGesture { controller.backToVideo() }
                            .accessibilityLabel("Back to the video")
                    }
                } else {
                    videoSurface(markers: true)
                }
                VStack {
                    Spacer()
                    bottomControls
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
                .frame(maxWidth: .infinity)
            }
            .background(Color.black)
        }
        .background(Tokens.canvasBase.color)
        .onDisappear { controller.stop() }
    }

    private var aspectInverse: CGFloat { CGFloat(controller.scene.camera.height / max(controller.scene.camera.width, 1)) }

    private var header: some View {
        HStack(spacing: 12) {
            Button { controller.stop(); onExit() } label: {
                Label("Home", systemImage: "chevron.left").font(.themed(17, .semibold))
            }
            .foregroundStyle(Tokens.text.color)
            Text(controller.scene.title).font(.themed(17, .semibold)).foregroundStyle(Tokens.text.color).lineLimit(1)
            Spacer()
            HStack(spacing: 2) {
                segment("Video", on: controller.eyeOf == nil && controller.mode == .video) { controller.backToVideo() }
                segment("Court", on: controller.eyeOf == nil && controller.mode == .court) {
                    controller.studio.exitPOV()
                    controller.mode = .court
                }
            }
            .padding(3)
            .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall + 3))
        }
        .padding(.horizontal, 16)
        .frame(height: Tokens.statusHeight + 8)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    private func segment(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.themed(14, .bold))
                .frame(width: 72, height: 38)
                .background(on ? Tokens.accent.color : .clear, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
        }
        .buttonStyle(.plain)
    }

    /// The clip (or its plate when there is no clip) fitted to the space, with tappable players on top.
    private func videoSurface(markers: Bool) -> some View {
        GeometryReader { g in
            let fit = fitRect(in: g.size)
            ZStack(alignment: .topLeading) {
                Color.black
                if let player = controller.player {
                    PlayerLayerView(player: player).frame(width: fit.width, height: fit.height).position(x: fit.midX, y: fit.midY)
                } else if let image = controller.plateImage {
                    Image(uiImage: image).resizable().frame(width: fit.width, height: fit.height).position(x: fit.midX, y: fit.midY)
                }
                if markers {
                    ForEach(controller.markers, id: \.id) { m in
                        PlayerMarker(marker: m, fit: fit) { controller.watch(m.id) }
                    }
                    Text("Tap a player to see through their eyes")
                        .font(.themed(16, .semibold))
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(Tokens.canvasRaised.withAlpha(0.92).color, in: Capsule())
                        .foregroundStyle(Tokens.text.color)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    private func fitRect(in size: CGSize) -> CGRect {
        let aspect = CGFloat(controller.scene.camera.width / max(controller.scene.camera.height, 1))
        let w = min(size.width, size.height * aspect), h = w / aspect
        return CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
    }

    private var bottomControls: some View {
        VStack(spacing: 8) {
            if let id = controller.eyeOf {
                let label = controller.studio.frame.tokens.first { $0.id == id }?.label ?? ""
                HStack(spacing: 8) {
                    Text("Eye view of \(label)").font(.themed(15, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                    StudioChip("Look ahead", on: controller.studio.povYaw == 0 && controller.studio.povPitch == 0) {
                        controller.studio.look(dx: controller.studio.povYaw, dy: -controller.studio.povPitch)
                    }
                    StudioChip("Back to video", symbol: "play.rectangle", prominent: true) { controller.backToVideo() }
                }
                .studioPanel(emphasis: true)
            } else if controller.mode == .court, let token = controller.studio.selectedTokenValue {
                StudioChip("See what \(token.label) sees", symbol: "eye", prominent: true) { controller.watch(token.id) }
                    .studioPanel(emphasis: true)
            }
            HStack(spacing: 12) {
                Button { controller.togglePlay() } label: {
                    Image(systemName: controller.playing ? "pause.fill" : "play.fill")
                        .font(.themed(18, .bold))
                        .frame(width: 56, height: 44)
                        .background(Tokens.accentActive.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .foregroundStyle(Tokens.onAccent.color)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(controller.playing ? "Pause" : "Play")
                Slider(value: Binding(get: { controller.time }, set: { controller.seek(to: $0) }), in: 0...max(controller.duration, 0.1))
                    .frame(minWidth: 240, maxWidth: 560)
                    .accessibilityLabel("Time in the rally")
                Text(String(format: "%.1f / %.1f s", controller.time, controller.duration))
                    .font(.dataMono).foregroundStyle(Tokens.text.color)
                    .frame(width: 120, alignment: .leading)
                StudioChip("Slow", symbol: "tortoise", on: controller.slowMotion) { controller.toggleSlowMotion() }
            }
            .studioPanel()
        }
    }
}

/// A ring at the player's feet and the number above the head; the whole body is the tap target.
struct PlayerMarker: View {
    let marker: VideoMarker
    let fit: CGRect
    let action: () -> Void

    var body: some View {
        let foot = CGPoint(x: fit.minX + marker.foot.x * fit.width, y: fit.minY + marker.foot.y * fit.height)
        let head = CGPoint(x: fit.minX + marker.head.x * fit.width, y: fit.minY + marker.head.y * fit.height)
        let tall = max(foot.y - head.y, 30)
        let tint = Tokens.team(marker.side)
        Button(action: action) {
            ZStack {
                Color.white.opacity(0.001)
                VStack(spacing: 0) {
                    Text(marker.label).font(.themed(13, .heavy))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(tint.color, in: Capsule())
                        .foregroundStyle(Tokens.onAccent.color)
                    Spacer()
                    Ellipse().stroke(tint.color, lineWidth: 3)
                        .frame(width: max(tall * 0.55, 30), height: max(tall * 0.16, 10))
                }
            }
            .frame(width: max(tall * 0.6, 44), height: tall + 30)
        }
        .buttonStyle(.plain)
        .position(x: (foot.x + head.x) / 2, y: (foot.y + head.y) / 2 - 8)
        .accessibilityLabel("Player \(marker.label): see through their eyes")
    }
}

/// An AVPlayerLayer as a view, the picture fitted inside.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let v = LayerView()
        v.playerLayer.videoGravity = .resizeAspect
        v.playerLayer.player = player
        v.backgroundColor = .black
        return v
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}
