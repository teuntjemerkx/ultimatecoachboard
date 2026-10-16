import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import CoachBoardCore

/// A movie file from the photo library, copied into the app's container (the picker hands out a temporary file).
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Import", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let copy = dir.appendingPathComponent("\(UUID().uuidString).\(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// Video to 3D (Section 4): choose a clip, drag four dots onto the court corners, and the app builds a 3D rally
/// from the video with Apple's on-device Vision models. The hall in 3D is painted from the clip itself.
struct VideoImportView: View {
    @State private var model = VideoImportModel()
    var onDone: (VideoScene, URL) -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                switch model.step {
                case .choose: chooseStep
                case .mark: markStep
                case .building: buildingStep
                case .failed(let message): failedStep(message)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Tokens.canvasBase.color)
        .onChange(of: model.finished) { _, done in
            if done, let scene = model.result, let folder = model.folder { onDone(scene, folder) }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { onCancel() } label: {
                Label("Home", systemImage: "chevron.left").font(.themed(17, .semibold))
            }
            .foregroundStyle(Tokens.text.color)
            Spacer()
            Text("Video to 3D").font(.themed(20, .bold)).foregroundStyle(Tokens.text.color)
            Spacer()
            stepDots
        }
        .padding(.horizontal, 20)
        .frame(height: Tokens.statusHeight + 8)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    private var stepDots: some View {
        let index: Int
        switch model.step {
        case .choose: index = 0
        case .mark: index = 1
        case .building, .failed: index = 2
        }
        return HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { i in
                Capsule().fill((i <= index ? Tokens.accent : Tokens.hairline).color).frame(width: i == index ? 22 : 8, height: 8)
            }
        }
        .accessibilityLabel("Step \(index + 1) of 3")
    }

    // MARK: Step 1

    @State private var pickerItem: PhotosPickerItem?

    private var chooseStep: some View {
        VStack(spacing: 22) {
            Image(systemName: "video.badge.waveform").font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Tokens.accent.color)
            Text("Turn a rally video into 3D").font(.themed(28, .bold)).foregroundStyle(Tokens.text.color)
            Text("Then watch it from any player's eyes, in the hall from your video.")
                .font(.themed(17, .regular)).foregroundStyle(Tokens.textSecondary.color)
            PhotosPicker(selection: $pickerItem, matching: .videos) {
                Label("Choose a video", systemImage: "photo.on.rectangle")
                    .font(.themed(19, .bold))
                    .frame(width: 320, height: 60)
                    .background(Tokens.accentActive.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                    .foregroundStyle(Tokens.onAccent.color)
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task { await model.load(item) }
            }
            if model.loading { ProgressView("Opening the video…").font(.themed(15, .medium)) }
            VStack(alignment: .leading, spacing: 10) {
                tip("arrow.up.circle", "Best filmed from high up, behind an end line.")
                tip("timer", "4 to 10 seconds: one rally.")
                tip("iphone.gen3", "Hold the camera still, or use a tripod.")
            }
            .padding(18)
            .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        }
        .padding(32)
    }

    private func tip(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.themed(17, .semibold)).foregroundStyle(Tokens.accent.color).frame(width: 26)
            Text(text).font(.themed(17, .regular)).foregroundStyle(Tokens.text.color)
        }
    }

    // MARK: Step 2

    @State private var dragging: Int?
    @State private var dragPoint: CGPoint = .zero

    private var markStep: some View {
        VStack(spacing: 14) {
            Text("Drag the dots onto the court's four corners")
                .font(.themed(20, .bold)).foregroundStyle(Tokens.text.color)
            Text("Put US on the two corners of your end line and THEM on theirs. The court lines show how well it fits.")
                .font(.themed(16, .regular)).foregroundStyle(Tokens.textSecondary.color)
                .multilineTextAlignment(.center)
            if let image = model.still {
                GeometryReader { g in
                    let fit = fitRect(CGSize(width: image.width, height: image.height), in: g.size)
                    ZStack(alignment: .topLeading) {
                        Image(decorative: image, scale: 1).resizable().frame(width: fit.width, height: fit.height)
                            .position(x: fit.midX, y: fit.midY)
                        CourtOverlay(lines: model.courtLines, fit: fit, imageSize: model.imageSize)
                            .stroke(Tokens.accent.color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .allowsHitTesting(false)
                        ForEach(model.corners.indices, id: \.self) { i in
                            cornerDot(i, fit: fit)
                        }
                        if let i = dragging {
                            Magnifier(image: image, fit: fit, imagePoint: model.corners[i].point, label: model.corners[i].label)
                                .position(x: min(max(dragPoint.x, 90), g.size.width - 90), y: max(dragPoint.y - 120, 80))
                                .allowsHitTesting(false)
                        }
                    }
                }
                .padding(.horizontal, 20)
            }
            HStack(spacing: 16) {
                fitBadge
                Spacer()
                if model.duration > 10.5 {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Start at \(String(format: "%.1f", model.start)) s").font(.themed(15, .semibold))
                        Slider(value: Binding(get: { model.start }, set: { model.setStart($0) }), in: 0...max(0, model.duration - 4))
                            .frame(width: 260)
                    }
                    .foregroundStyle(Tokens.text.color)
                }
                Button { Task { await model.build() } } label: {
                    Label("Build 3D", systemImage: "cube.transparent")
                        .font(.themed(19, .bold))
                        .frame(width: 220, height: 60)
                        .background(Tokens.accentActive.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .foregroundStyle(Tokens.onAccent.color)
                }
                .disabled(!model.canBuild)
                .opacity(model.canBuild ? 1 : 0.4)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 18)
        }
        .padding(.top, 14)
    }

    private var fitBadge: some View {
        let info: (text: String, symbol: String) = {
            switch model.fit {
            case .good: return ("Good fit", "checkmark.circle.fill")
            case .rough: return ("Rough fit: move the dots closer to the corners", "exclamationmark.triangle.fill")
            case .unknown: return ("The dots don't make a court yet", "questionmark.circle")
            }
        }()
        return Label(info.text, systemImage: info.symbol).font(.themed(16, .semibold))
            .foregroundStyle((model.fit == .good ? Tokens.accent : Tokens.text).color)
    }

    private func cornerDot(_ i: Int, fit: CGRect) -> some View {
        let c = model.corners[i]
        let p = view(c.point, fit: fit)
        let tint = c.ours ? Tokens.home : Tokens.opponent
        return ZStack {
            Circle().fill(tint.withAlpha(0.25).color).frame(width: 56, height: 56)
            Circle().stroke(tint.color, lineWidth: 3).frame(width: 30, height: 30)
            Circle().fill(tint.color).frame(width: 6, height: 6)
            Text(c.label).font(.themed(12, .heavy)).foregroundStyle(Tokens.onAccent.color)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(tint.color, in: Capsule())
                .offset(y: -30)
        }
        .position(p)
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { v in
                dragging = i
                dragPoint = v.location
                model.move(corner: i, to: image(v.location, fit: fit))
            }
            .onEnded { _ in dragging = nil; model.solve() })
        .accessibilityLabel("\(c.label) corner")
    }

    private func fitRect(_ size: CGSize, in box: CGSize) -> CGRect {
        let s = min(box.width / size.width, box.height / size.height)
        let w = size.width * s, h = size.height * s
        return CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h)
    }

    private func view(_ p: CGPoint, fit: CGRect) -> CGPoint {
        CGPoint(x: fit.minX + p.x / model.imageSize.width * fit.width, y: fit.minY + p.y / model.imageSize.height * fit.height)
    }

    private func image(_ v: CGPoint, fit: CGRect) -> CGPoint {
        CGPoint(x: min(max(0, (v.x - fit.minX) / fit.width), 1) * model.imageSize.width,
                y: min(max(0, (v.y - fit.minY) / fit.height), 1) * model.imageSize.height)
    }

    // MARK: Step 3

    private var buildingStep: some View {
        VStack(spacing: 20) {
            ProgressView(value: model.progress).frame(width: 420).tint(Tokens.accent.color)
            Text(model.stage).font(.themed(20, .semibold)).foregroundStyle(Tokens.text.color)
            Text("This runs on your iPad. Nothing leaves the device.")
                .font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
        }
    }

    private func failedStep(_ message: String) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 44, weight: .semibold)).foregroundStyle(Tokens.fault.color)
            Text(message).font(.themed(18, .semibold)).foregroundStyle(Tokens.text.color).multilineTextAlignment(.center)
            Button("Try again") { model.step = model.still == nil ? .choose : .mark }
                .font(.themed(17, .bold)).frame(width: 200, height: 52)
                .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                .foregroundStyle(Tokens.text.color)
        }
        .padding(32)
    }
}

/// The court model projected into the still, as line segments in image pixels.
struct CourtOverlay: Shape {
    var lines: [(CGPoint, CGPoint)]
    var fit: CGRect
    var imageSize: CGSize

    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard imageSize.width > 0 else { return p }
        func v(_ q: CGPoint) -> CGPoint {
            CGPoint(x: fit.minX + q.x / imageSize.width * fit.width, y: fit.minY + q.y / imageSize.height * fit.height)
        }
        for (a, b) in lines {
            p.move(to: v(a))
            p.addLine(to: v(b))
        }
        return p
    }
}

/// A 3x loupe above the finger while a dot is dragged, so the corner can be hit exactly.
struct Magnifier: View {
    let image: CGImage
    let fit: CGRect
    let imagePoint: CGPoint
    let label: String
    private let size: CGFloat = 150
    private let zoom: CGFloat = 3

    var body: some View {
        let scale = fit.width / CGFloat(image.width) * zoom
        let w = CGFloat(image.width) * scale, h = CGFloat(image.height) * scale
        ZStack {
            Image(decorative: image, scale: 1).resizable().frame(width: w, height: h)
                .offset(x: w / 2 - imagePoint.x * scale, y: h / 2 - imagePoint.y * scale)
                .frame(width: size, height: size)
                .clipShape(Circle())
            Circle().stroke(Tokens.text.color, lineWidth: 3)
            Image(systemName: "plus").font(.system(size: 22, weight: .light)).foregroundStyle(Tokens.text.color)
        }
        .frame(width: size, height: size)
        .shadow(radius: 8)
    }
}
