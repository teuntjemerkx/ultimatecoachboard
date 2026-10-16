import SwiftUI
import CoachBoardCore

/// Screen 3 (Live Canvas, Solo) with the Panic state (Screen 5) and the Set Break panel (Screen 6).
struct LiveView: View {
    @Bindable var controller: LiveController
    var onExit: () -> Void
    @AppStorage("gripRight") private var gripRight = true
    @State private var showCorrection = false

    var body: some View {
        ZStack {
            Tokens.canvasBase.color.ignoresSafeArea()
            if isPanic {
                BoardView(controller: controller).ignoresSafeArea()
                PanicOverlay(controller: controller)
            } else {
                HStack(spacing: 0) {
                    // The rail docks on the edge opposite the gripping hand (Section 1.4).
                    if gripRight { Rail(controller: controller, onExit: onExit) }
                    VStack(spacing: 0) {
                        StatusStrip(controller: controller, showCorrection: $showCorrection)
                        BoardView(controller: controller)
                    }
                    if !gripRight { Rail(controller: controller, onExit: onExit) }
                }
                thumbCluster
                overlays
            }
            if controller.state.context == .setBreak || controller.state.context == .matchOver {
                SetBreakPanel(controller: controller, onExit: onExit)
            }
            EdgePulse(cue: Feedback.shared.cue)
        }
        .sheet(isPresented: $showCorrection) { RotationCorrectionSheet(controller: controller) }
        .persistentSystemOverlays(.hidden)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }       // no auto-lock during Live (C6)
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private var isPanic: Bool {
        if case .panicTimeOut = controller.state.context { return true }
        return false
    }

    private var thumbCluster: some View {
        VStack {
            Spacer()
            HStack(spacing: 16) {
                if gripRight { Spacer() }
                if !gripRight { PointWheel(controller: controller) }
                Button { controller.panic() } label: {
                    VStack(spacing: 2) {
                        Text("PANIC").font(.system(size: 15, weight: .heavy).width(.expanded))
                        Text("T/O").font(.sectionLabel)
                    }
                    .foregroundStyle(Tokens.accent.color)
                    .frame(width: Tokens.targetLiveCritical, height: Tokens.targetLiveCritical)
                    .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.accent.color, lineWidth: 2))
                }
                .accessibilityLabel("Panic time-out")
                if gripRight { PointWheel(controller: controller) }
                if !gripRight { Spacer() }
            }
            .padding(16)
        }
    }

    @ViewBuilder private var overlays: some View {
        VStack {
            Spacer()
            HStack(spacing: 12) {
                if controller.undoChipVisible {
                    Button { controller.undo() } label: {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                            .font(.system(size: 15, weight: .semibold))
                            .padding(.horizontal, 16).frame(height: 44)
                            .background(Tokens.canvasRaised.color, in: Capsule())
                            .overlay(Capsule().stroke(Tokens.hairline.color))
                    }
                    .foregroundStyle(Tokens.white.color)
                }
                if let card = controller.matchupCard {
                    Text(card)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Tokens.white.color)
                        .padding(.horizontal, 12).frame(height: 36)
                        .background(Tokens.canvasBase.withAlpha(0.9).color, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.accent.withAlpha(0.6).color))
                }
                Spacer()
            }
            .padding(.leading, Tokens.railWidth + 16)
            .padding(.bottom, 24)
        }
        .allowsHitTesting(controller.undoChipVisible)
    }
}

/// The Point Swipe Wheel (Section 2.5): one swipe toward a half logs that team's rally.
struct PointWheel: View {
    let controller: LiveController
    @State private var drag: CGFloat = 0

    var body: some View {
        let homeDirection = controller.geometry.screenDirection(of: .home)
        ZStack {
            HalfDisc().fill(Tokens.canvasRaised.color)
            HalfDisc().stroke(Tokens.accent.withAlpha(0.8).color, lineWidth: 2)
            VStack(spacing: 4) {
                HStack {
                    Text(homeDirection < 0 ? "\u{25C0} US" : "\u{25C0} THEM")
                    Spacer()
                    Text(homeDirection < 0 ? "THEM \u{25B6}" : "US \u{25B6}")
                }
                .font(.sectionLabel)
                .foregroundStyle(Tokens.textSecondary.color)
                HStack(spacing: 18) {
                    Text("R\(controller.homeRotation)").foregroundStyle(Tokens.accent.color)
                    Text("R\(controller.opponentRotation)").foregroundStyle(Tokens.opponent.color)
                }
                .font(.system(size: 22, weight: .bold).width(.expanded).monospacedDigit())
            }
            .padding(.horizontal, 18)
            .padding(.top, 22)
            .offset(x: drag / 6)
        }
        .frame(width: 176, height: 96)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { drag = $0.translation.width }
                .onEnded { value in
                    drag = 0
                    let dx = value.translation.width
                    guard abs(dx) > 40 else { return }
                    let towardHome = (dx < 0) == (homeDirection < 0)
                    controller.swipe(winner: towardHome ? .home : .opponent)
                }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Point wheel")
        .accessibilityAction(named: "Home won rally") { controller.swipe(winner: .home) }
        .accessibilityAction(named: "Opponent won rally") { controller.swipe(winner: .opponent) }
    }
}

struct HalfDisc: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.midX, y: rect.maxY), radius: rect.width / 2,
                 startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.closeSubpath()
        return p
    }
}

struct StatusStrip: View {
    @Bindable var controller: LiveController
    @Binding var showCorrection: Bool

    var body: some View {
        HStack(spacing: 18) {
            Text("SET \(controller.setNumber)").font(.sectionLabel)
            Text("\(controller.score.home) : \(controller.score.opponent)")
                .font(.system(size: 20, weight: .bold).width(.expanded).monospacedDigit())
            HStack(spacing: 6) {
                Circle().fill(controller.serving == .home ? Tokens.accent.color : Tokens.opponent.color).frame(width: 8, height: 8)
                Text("\(controller.serving == .home ? controller.homeName : controller.opponentName) SERVES #\(controller.serverLabel)")
                    .font(.sectionLabel)
            }
            Text("R\(controller.homeRotation) \u{21C4} R\(controller.opponentRotation)")
                .font(.dataMono)
                .onLongPressGesture(minimumDuration: 0.6) { showCorrection = true }
                .accessibilityHint("Long-press to correct the rotation")
            Text("SUB \(controller.substitutionsUsed)/6").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            Spacer()
            Button("SWITCH ENDS") { controller.switchEnds() }.font(.sectionLabel)
            Text(controller.state.mode == .solo ? "SOLO" : "ADV")
                .font(.sectionLabel)
                .padding(.horizontal, 10).frame(height: 24)
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(Tokens.accent.color))
                .onLongPressGesture(minimumDuration: 0.6) { controller.toggleMode() }
                .accessibilityHint("Long-press to switch between Solo and Advanced")
        }
        .foregroundStyle(Tokens.white.color)
        .padding(.horizontal, 16)
        .frame(height: Tokens.statusHeight)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }
}

struct Rail: View {
    @Bindable var controller: LiveController
    var onExit: () -> Void
    @AppStorage("feedbackSound") private var soundOn = false

    var body: some View {
        VStack(spacing: 8) {
            railButton("RING", "circle.dashed") { controller.resetTokens() }
            railButton(controller.attacksVisible ? "LINES" : "LINES OFF", "arrow.up.right") { controller.attacksVisible.toggle() }
            railButton(soundOn ? "SOUND" : "SILENT", soundOn ? "speaker.wave.2" : "speaker.slash") { soundOn.toggle() }
            Spacer()
            railButton("EXIT", "xmark") { controller.close(); onExit() }
        }
        .padding(.vertical, 12)
        .frame(width: Tokens.railWidth)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .trailing) { Rectangle().fill(Tokens.hairline.color).frame(width: 1) }
    }

    private func railButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                Text(title).font(.system(size: 9, weight: .semibold).width(.expanded))
            }
            .frame(width: Tokens.targetLivePrimary, height: Tokens.targetLivePrimary)
        }
        .foregroundStyle(Tokens.white.color)
    }
}

struct PanicOverlay: View {
    @Bindable var controller: LiveController

    var body: some View {
        VStack {
            HStack {
                Spacer()
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    let remaining = controller.panicSecondsRemaining ?? 0
                    ZStack {
                        Circle().stroke(Tokens.hairline.color, lineWidth: 6)
                        Circle().trim(from: 0, to: CGFloat(remaining / 30))
                            .stroke(Tokens.accentActive.color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(String(format: "0:%02d", Int(remaining.rounded(.up))))
                            .font(.system(size: 20, weight: .bold).width(.expanded).monospacedDigit())
                            .foregroundStyle(Tokens.white.color)
                    }
                    .frame(width: 88, height: 88)
                }
            }
            Spacer()
            HStack(spacing: 12) {
                panicButton(controller.playerFacingFlip ? "UNFLIP" : "FLIP FOR PLAYERS") { controller.playerFacingFlip.toggle() }
                panicButton(controller.attacksVisible ? "ATTACKS ON" : "ATTACKS OFF") { controller.attacksVisible.toggle() }
                panicButton("CLEAR") { controller.clearPanicInk() }
                Spacer()
                Text("two-finger tap = undo").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                panicButton("DONE") { controller.panicDone() }
            }
        }
        .padding(16)
    }

    private func panicButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 13, weight: .bold).width(.expanded))
                .padding(.horizontal, 16).frame(height: Tokens.targetLivePrimary)
                .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.accentActive.color, lineWidth: 1.5))
        }
        .foregroundStyle(Tokens.white.color)
    }
}

struct RotationCorrectionSheet: View {
    @Bindable var controller: LiveController
    @Environment(\.dismiss) private var dismiss
    @State private var homeSetter = 1
    @State private var opponentSetter = 1
    @State private var serving: Side = .home

    var body: some View {
        NavigationStack {
            Form {
                Picker("Home setter position", selection: $homeSetter) { ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) } }
                Picker("Opponent setter position", selection: $opponentSetter) { ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) } }
                Picker("Serving", selection: $serving) {
                    Text(controller.homeName).tag(Side.home)
                    Text(controller.opponentName).tag(Side.opponent)
                }
            }
            .navigationTitle("Correct rotation")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        controller.correctRotation(side: .home, setterPosition: CourtPosition(rawValue: homeSetter)!, serving: serving)
                        controller.correctRotation(side: .opponent, setterPosition: CourtPosition(rawValue: opponentSetter)!, serving: serving)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .onAppear {
            homeSetter = controller.homeRotation
            opponentSetter = controller.opponentRotation
            serving = controller.serving
        }
    }
}

/// The visual confirmation channel: a luminance pulse around the whole screen edge (1 to 3 pulses),
/// visible in peripheral vision while the coach watches the rally.
struct EdgePulse: View {
    let cue: Feedback.Cue?
    @State private var opacity: Double = 0

    var body: some View {
        RoundedRectangle(cornerRadius: 18)
            .strokeBorder((cue?.color ?? Tokens.accent).color, lineWidth: 8)
            .shadow(color: (cue?.color ?? Tokens.accent).color, radius: 12)
            .opacity(opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onChange(of: cue) { _, newCue in
                guard let newCue else { return }
                Task { @MainActor in
                    for _ in 0..<newCue.pulses {
                        withAnimation(.easeOut(duration: 0.06)) { opacity = 1 }
                        try? await Task.sleep(nanoseconds: 70_000_000)
                        withAnimation(.easeIn(duration: 0.12)) { opacity = 0 }
                        try? await Task.sleep(nanoseconds: 110_000_000)
                    }
                }
            }
    }
}
