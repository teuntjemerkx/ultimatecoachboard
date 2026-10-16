import SwiftUI
import CoachBoardCore

/// Layout of the live screen.
enum LiveLayout {
    /// The rail: wide enough for a readable word under each icon.
    static let rail: CGFloat = 80
    /// Room the Thumb Cluster (Timeout and the point wheel) takes along the bottom edge.
    static let cluster: CGFloat = 350
}

/// Screen 3 (Live Canvas, Solo) with the Panic state (Screen 5) and the Set Break panel (Screen 6).
/// Simple keeps the score, serve, rotation, Timeout, Undo and Swap sides in plain words; the Detailed live mode
/// (Screen 4) stays one menu away as "More detail". Advanced shows every tool and the compact expert labels.
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
                            .overlay { RouteChips(controller: controller).allowsHitTesting(false) }
                            .overlay { SkillPadOverlay(controller: controller) }
                            .overlay(alignment: gripRight ? .topLeading : .topTrailing) {
                                if controller.ringOpen || controller.preview != nil {
                                    RingPanel(controller: controller).padding(12)
                                }
                            }
                        if controller.state.mode == .advanced { LiveStatStrip(controller: controller) }
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
                timeoutButton
                if gripRight { PointWheel(controller: controller) }
                if !gripRight { Spacer() }
            }
            .padding(16)
        }
    }

    private var timeoutButton: some View {
        Button { controller.panic() } label: {
            VStack(spacing: 6) {
                Image(systemName: "timer").font(.themed(28, .semibold))
                Text("Timeout").font(.themed(16, .heavy)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(Tokens.accent.color)
            .frame(width: Tokens.targetLiveCritical, height: Tokens.targetLiveCritical)
            .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.accent.color, lineWidth: 2))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Timeout")
        .accessibilityHint("Shows the board full screen to draw on, with a countdown.")
    }

    /// The Undo chip after a point, the matchup card and the substitution bench, next to the rail.
    @ViewBuilder private var overlays: some View {
        VStack(alignment: gripRight ? .leading : .trailing, spacing: 10) {
            Spacer()
            if controller.subTarget != nil {
                BenchStrip(controller: controller)
            }
            HStack(spacing: 12) {
                if !gripRight { Spacer() }
                if controller.undoChipVisible {
                    Button { controller.undo() } label: {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                            .font(.themed(17, .semibold))
                            .padding(.horizontal, 20).frame(height: Tokens.targetPrimary)
                            .background(Tokens.canvasRaised.color, in: Capsule())
                            .overlay(Capsule().stroke(Tokens.hairline.color))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.text.color)
                }
                if let card = controller.matchupCard {
                    Text(card)
                        .font(.themed(16, .semibold))
                        .foregroundStyle(Tokens.text.color)
                        .lineLimit(1)
                        .padding(.horizontal, 14).frame(height: Tokens.targetStandard)
                        .background(Tokens.canvasBase.withAlpha(0.92).color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall).stroke(Tokens.accent.withAlpha(0.6).color))
                }
                if gripRight { Spacer() }
            }
        }
        .padding(gripRight ? .leading : .trailing, LiveLayout.rail + 16)
        .padding(.bottom, controller.state.mode == .advanced ? Tokens.statusHeight + 20 : 20)
        .allowsHitTesting(controller.undoChipVisible || controller.subTarget != nil)
    }
}

/// The Point Swipe Wheel (Section 2.5): one swipe toward a half logs that team's rally.
struct PointWheel: View {
    let controller: LiveController
    @State private var drag: CGFloat = 0

    var body: some View {
        let homeDirection = controller.geometry.screenDirection(of: .home)
        let homeLeft = homeDirection < 0
        let advanced = ThemeStore.shared.advanced
        ZStack {
            HalfDisc().fill(Tokens.canvasRaised.color)
            HalfDisc().stroke(Tokens.accent.withAlpha(0.8).color, lineWidth: 2)
            VStack(spacing: 6) {
                HStack {
                    Text("\u{25C0} " + (homeLeft ? "Us" : "Them"))
                        .foregroundStyle((homeLeft ? Tokens.home : Tokens.opponent).color)
                    Spacer()
                    Text((homeLeft ? "Them" : "Us") + " \u{25B6}")
                        .foregroundStyle((homeLeft ? Tokens.opponent : Tokens.home).color)
                }
                .font(.themed(17, .heavy))
                if advanced {
                    HStack(spacing: 18) {
                        Text("R\(controller.homeRotation)").foregroundStyle(Tokens.home.color)
                        Text("R\(controller.opponentRotation)").foregroundStyle(Tokens.opponent.color)
                    }
                    .font(.themed(22, .bold).monospacedDigit())
                } else {
                    Text("Swipe toward the winner")
                        .font(.themed(14, .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .foregroundStyle(Tokens.textSecondary.color)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 26)
            .offset(x: drag / 6)
        }
        .frame(width: 200, height: 104)
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
        .accessibilityLabel("Point wheel: swipe toward the team that won the point")
        .accessibilityAction(named: "Point to us") { controller.swipe(winner: .home) }
        .accessibilityAction(named: "Point to them") { controller.swipe(winner: .opponent) }
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
        let advanced = ThemeStore.shared.advanced
        HStack(spacing: 16) {
            Text("Set \(controller.setNumber)")
                .font(.themed(17, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                .fixedSize()
            // The score is what a glance at the sideline is for: big, with each team in its colour.
            HStack(spacing: 10) {
                Text(controller.homeName).font(.themed(17, .heavy)).foregroundStyle(Tokens.home.color).lineLimit(1)
                Text("\(controller.score.home) : \(controller.score.opponent)").font(.liveScore).fixedSize()
                Text(controller.opponentName).font(.themed(17, .heavy)).foregroundStyle(Tokens.opponent.color).lineLimit(1)
            }
            .layoutPriority(1)
            HStack(spacing: 6) {
                Circle().fill(Tokens.team(controller.serving).color).frame(width: 10, height: 10)
                Text(serveText(advanced))
                    .font(.themed(16, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Button { showCorrection = true } label: {
                Text(advanced ? "R\(controller.homeRotation) \u{21C4} R\(controller.opponentRotation)" : "Rotation \(controller.homeRotation)")
                    .font(advanced ? Font.dataMono : Font.themed(16, .semibold))
                    .padding(.horizontal, 10)
                    .frame(minHeight: Tokens.targetStandard)
                    .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall).stroke(Tokens.hairline.color))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("Rotation \(controller.homeRotation)")
            .accessibilityHint("Opens Fix rotation")
            if advanced {
                Text("Subs \(controller.substitutionsUsed)/6")
                    .font(.themed(15, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                    .fixedSize()
            }
            if let badge = controller.pointBadge {
                Text(badge).font(.themed(15, .heavy)).foregroundStyle(Tokens.accentActive.color).lineLimit(1)
            }
            if let p = controller.preview {
                Text(advanced ? "Preview R\(p.rotation) \(p.phase)" : "Showing rotation \(p.rotation)")
                    .font(.themed(14, .bold))
                    .lineLimit(1)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(Tokens.accent.color, in: Capsule())
                    .foregroundStyle(Tokens.onAccent.color)
            }
            Spacer(minLength: 8)
            Button { controller.switchEnds() } label: {
                Label("Swap sides", systemImage: "arrow.left.arrow.right")
                    .font(.themed(15, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.horizontal, 12)
                    .frame(minHeight: Tokens.targetStandard)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Swap sides")
            modeControl(advanced)
        }
        .foregroundStyle(Tokens.text.color)
        .padding(.horizontal, 16)
        .frame(height: Tokens.statusHeight + 8)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.hairline.color).frame(height: 1) }
    }

    private func serveText(_ advanced: Bool) -> String {
        if advanced { return "Serve #\(controller.serverLabel)" }
        let label = controller.serverLabel
        let number = Int(label) != nil ? " \u{00B7} #\(label)" : ""
        return (controller.serving == .home ? "Our serve" : "Their serve") + number
    }

    /// The way into the Detailed live mode (Screen 4). Simple keeps it in a quiet More menu as "More detail";
    /// Advanced shows the mode by name, one tap away. A menu, so a stray tap never switches the mode.
    @ViewBuilder private func modeControl(_ advanced: Bool) -> some View {
        let solo = controller.state.mode == .solo
        if advanced {
            Menu {
                Button { if !solo { controller.toggleMode() } } label: { menuItem("Solo: score and lineup", checked: solo) }
                Button { if solo { controller.toggleMode() } } label: { menuItem("Detailed: code every touch", checked: !solo) }
            } label: {
                HStack(spacing: 6) {
                    Text(solo ? "Solo" : "Detailed")
                    Image(systemName: "chevron.down").font(.themed(12, .bold))
                }
                .font(.themed(15, .bold))
                .foregroundStyle(Tokens.text.color)
                .padding(.horizontal, 14)
                .frame(minHeight: Tokens.targetStandard)
                .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall).stroke(Tokens.accent.color, lineWidth: 1.5))
                .contentShape(Rectangle())
            }
            .fixedSize()
            .accessibilityLabel("Live mode: \(solo ? "Solo" : "Detailed")")
        } else {
            Menu {
                Button { showCorrection = true } label: { Label("Fix rotation", systemImage: "arrow.triangle.2.circlepath") }
                Button { controller.toggleMode() } label: {
                    Label(solo ? "More detail" : "Less detail", systemImage: solo ? "plus.magnifyingglass" : "minus.magnifyingglass")
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
                    .font(.themed(15, .semibold))
                    .foregroundStyle(Tokens.text.color)
                    .padding(.horizontal, 10)
                    .frame(minHeight: Tokens.targetStandard)
                    .contentShape(Rectangle())
            }
            .fixedSize()
            .accessibilityLabel("More options")
        }
    }

    @ViewBuilder private func menuItem(_ title: String, checked: Bool) -> some View {
        if checked { Label(title, systemImage: "checkmark") } else { Text(title) }
    }
}

struct Rail: View {
    @Bindable var controller: LiveController
    var onExit: () -> Void
    @AppStorage("feedbackSound") private var soundOn = false
    @AppStorage("gripRight") private var gripRight = true

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        let previewing = controller.preview != nil
        VStack(spacing: 6) {
            railButton("Undo", "arrow.uturn.backward", on: nil) { controller.undo() }
            Rectangle().fill(Tokens.hairline.color).frame(width: 44, height: 1).padding(.vertical, 4)
            railButton(previewing ? "Back to live" : "Rotations", previewing ? "play.circle" : "circle.dashed",
                       on: controller.ringOpen || previewing) { controller.ringTapped() }
            railButton("Attacks", "arrow.up.right", on: controller.attacksVisible) { controller.attacksVisible.toggle() }
            // Routes are an expert tool; Simple shows the switch only while routes are on, so they can be turned off.
            if advanced || controller.routesVisible {
                railButton("Routes", "point.topleft.down.to.point.bottomright.curvepath", on: controller.routesVisible) {
                    controller.routesVisible.toggle()
                }
            }
            railButton(soundOn ? "Sound" : "Muted", soundOn ? "speaker.wave.2" : "speaker.slash", on: nil) { soundOn.toggle() }
            Spacer()
            railButton("Exit", "xmark", on: nil) { controller.close(); onExit() }
                .accessibilityHint("The match is saved. Resume it from the home screen.")
        }
        .padding(.vertical, 12)
        .frame(width: LiveLayout.rail)
        .background(Tokens.canvasRaised.color)
        .overlay(alignment: gripRight ? .trailing : .leading) { Rectangle().fill(Tokens.hairline.color).frame(width: 1) }
    }

    /// A rail button with its word under the icon; a switch (`on` not nil) is filled while it is on.
    private func railButton(_ title: String, _ symbol: String, on: Bool?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.themed(22, .semibold))
                Text(title)
                    .font(.themed(13, .semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle((on == false ? Tokens.textSecondary : Tokens.text).color)
            .frame(width: LiveLayout.rail - 12, height: 64)
            .background((on == true ? Tokens.accent.withAlpha(0.16) : Tokens.accent.withAlpha(0)).color,
                        in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(Self.stateWord(on))
    }

    private static func stateWord(_ on: Bool?) -> String {
        guard let on else { return "" }
        return on ? "On" : "Off"
    }
}

/// "Late 0.4 s" chips at the end of late routes (Section 2.6), in board coordinates.
struct RouteChips: View {
    let controller: LiveController

    var body: some View {
        if controller.routesVisible, controller.state.context == .live {
            let geometry = controller.geometry
            ForEach(controller.routePlan.filter(\.late)) { r in
                Text(String(format: "Late %.1f s", -(r.slack ?? 0)))
                    .font(.themed(13, .heavy))
                    .padding(.horizontal, 8).frame(height: 26)
                    .background(Tokens.accent.color, in: Capsule())
                    .foregroundStyle(Tokens.onAccent.color)
                    .position(geometry.toView(r.to, side: .home))
            }
        }
    }
}

/// Screen 5: the timeout board, full screen, to draw on with a countdown.
struct PanicOverlay: View {
    @Bindable var controller: LiveController

    var body: some View {
        VStack {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Timeout").font(.themed(24, .heavy))
                    Text("Draw on the board. Tap with two fingers to undo.")
                        .font(.themed(16, .medium))
                        .foregroundStyle(Tokens.textSecondary.color)
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(Tokens.canvasRaised.withAlpha(0.92).color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
                .allowsHitTesting(false)
                Spacer()
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    let remaining = controller.panicSecondsRemaining ?? 0
                    ZStack {
                        Circle().fill(Tokens.canvasRaised.withAlpha(0.92).color)
                        Circle().stroke(Tokens.hairline.color, lineWidth: 6)
                        Circle().trim(from: 0, to: CGFloat(remaining / 30))
                            .stroke(Tokens.accentActive.color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(String(format: "0:%02d", Int(remaining.rounded(.up))))
                            .font(.themed(24, .bold).monospacedDigit())
                            .foregroundStyle(Tokens.text.color)
                    }
                    .frame(width: 96, height: 96)
                }
                .allowsHitTesting(false)
                .accessibilityLabel("Time left")
            }
            Spacer()
            HStack(spacing: 12) {
                panicButton(controller.playerFacingFlip ? "Turn back" : "Turn for players", "rotate.right") {
                    controller.playerFacingFlip.toggle()
                }
                panicButton(controller.attacksVisible ? "Hide attacks" : "Show attacks", "arrow.up.right") {
                    controller.attacksVisible.toggle()
                }
                panicButton("Clear drawing", "eraser") { controller.clearPanicInk() }
                Spacer()
                Button { controller.panicDone() } label: {
                    Label("Done", systemImage: "checkmark")
                }
                .buttonStyle(CoachButtonStyle(minHeight: Tokens.targetLivePrimary))
            }
        }
        .foregroundStyle(Tokens.text.color)
        .padding(16)
    }

    private func panicButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(CoachButtonStyle(kind: .secondary, minHeight: Tokens.targetLivePrimary))
    }
}

/// Fixes the rotations and the server when the app and the score sheet disagree.
struct RotationCorrectionSheet: View {
    @Bindable var controller: LiveController
    @Environment(\.dismiss) private var dismiss
    @State private var homeSetter = 1
    @State private var opponentSetter = 1
    @State private var serving: Side = .home

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        NavigationStack {
            Form {
                Section {
                    Picker(advanced ? "Our setter in" : "Our rotation", selection: $homeSetter) {
                        ForEach(1...6, id: \.self) { Text(advanced ? "P\($0)" : "Rotation \($0)").tag($0) }
                    }
                    Picker(advanced ? "Their setter in" : "Their rotation", selection: $opponentSetter) {
                        ForEach(1...6, id: \.self) { Text(advanced ? "P\($0)" : "Rotation \($0)").tag($0) }
                    }
                    Picker("Serving now", selection: $serving) {
                        Text(controller.homeName).tag(Side.home)
                        Text(controller.opponentName).tag(Side.opponent)
                    }
                } footer: {
                    Text(advanced ? "The rotation is named by the position of the setter."
                                  : "Use this when the app and the score sheet disagree.")
                }
            }
            .font(.scaled(.body))
            .navigationTitle("Fix rotation")
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
