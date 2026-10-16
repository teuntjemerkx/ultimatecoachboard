import SwiftUI
import CoachBoardCore

/// Screen 6, Set Break Summary: decide the next set's start in the 3-minute interval.
/// Left: side-out record per home rotation; centre: opponent attacks per opponent rotation; right: next-set controls.
/// Simple names rotations in words and shows the attack fans only when attacks were scouted.
struct SetBreakPanel: View {
    @Bindable var controller: LiveController
    var onExit: () -> Void
    @State private var firstServer: Side?
    @State private var startRotation = 1
    @State private var rallyListRotation: Int?

    private var advanced: Bool { ThemeStore.shared.advanced }
    private var state: LiveState { controller.state }
    private var finishedSet: Int { state.match.current.number }
    private var over: Bool { state.context == .matchOver }
    private var records: [RotationRecord] { RotationStats.records(state.rallies, side: .home, setNumber: finishedSet) }
    private var suggested: RotationRecord? { RotationStats.suggestedStart(records) }
    private var nextIsDeciding: Bool { finishedSet + 1 == state.profile.scoring.setsToWin * 2 - 1 }
    private var setLines: [ScoutLine] { state.scoutLines.filter { $0.setNumber == finishedSet } }

    var body: some View {
        ZStack {
            Tokens.background.withAlpha(0.8).color.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 24) {
                header
                HStack(alignment: .top, spacing: 28) {
                    sideOutBars.frame(width: 300)
                    if advanced || !setLines.isEmpty {
                        attackFans.frame(maxWidth: .infinity)
                    } else {
                        Spacer(minLength: 0)
                    }
                    controls.frame(width: 280)
                }
            }
            .foregroundStyle(Tokens.text.color)
            .padding(28)
            .frame(maxWidth: 1080)
            .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.hairline.color))
            .padding(24)
        }
        .sheet(item: Binding(get: { rallyListRotation.map(RotationID.init) }, set: { rallyListRotation = $0?.id })) { r in
            RallyListSheet(controller: controller, rotation: r.id, setNumber: finishedSet)
        }
        .onAppear(perform: prefill)
    }

    private struct RotationID: Identifiable { let id: Int }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(over ? "Match over" : "Set \(finishedSet) done").font(.themed(17, .bold)).foregroundStyle(Tokens.accent.color)
            Text("\(controller.homeName) \(controller.score.home) : \(controller.score.opponent) \(controller.opponentName)")
                .font(.liveNumerals)
            Text(setsLine)
                .font(.themed(17, .medium).monospacedDigit())
                .foregroundStyle(Tokens.textSecondary.color)
        }
    }

    private var setsLine: String {
        let prefix = advanced ? "Sets" : "Sets won"
        let scores = state.match.sets.map { "\($0.score.home)\u{2013}\($0.score.opponent)" }.joined(separator: "  ")
        return "\(prefix) \(state.match.setsWonHome) : \(state.match.setsWonOpponent)   \u{00B7}   \(scores)"
    }

    private var rotationOptions: [(value: Int, title: String)] {
        (1...6).map { r in (value: r, title: advanced ? "R\(r)" : "\(r)") }
    }

    // MARK: - Side-out bars

    private var sideOutBars: some View {
        let maxTotal = max(records.map(\.receiveTotal).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Side-out by rotation").font(.groupTitle)
                if !advanced {
                    Text("Points won on their serve").font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(records) { r in
                    Button { rallyListRotation = r.rotation } label: {
                        VStack(spacing: 6) {
                            Text(r.receiveTotal == 0 ? "\u{2013}" : "\(r.receiveWon)/\(r.receiveTotal)")
                                .font(.themed(15, .semibold).monospacedDigit())
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            VStack(spacing: 2) {
                                Rectangle().fill(Tokens.text.withAlpha(0.28).color)
                                    .frame(height: 140 * CGFloat(r.receiveLost) / CGFloat(maxTotal))
                                Rectangle().fill(Tokens.accent.color)
                                    .frame(height: 140 * CGFloat(r.receiveWon) / CGFloat(maxTotal))
                            }
                            .frame(width: 36, height: 140, alignment: .bottom)
                            .background(Tokens.hairline.color)
                            Text(advanced ? "R\(r.rotation)" : "\(r.rotation)").font(.themed(17, .bold))
                                .foregroundStyle(r.rotation == suggested?.rotation ? Tokens.accent.color : Tokens.text.color)
                        }
                        .frame(minWidth: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Rotation \(r.rotation): \(r.receiveWon) of \(r.receiveTotal) side-outs")
                }
            }
            if !advanced {
                Text("Rotation").font(.themed(15, .semibold)).foregroundStyle(Tokens.textSecondary.color)
            }
            Text(advanced ? "Filled: rallies won while receiving. Tap a bar for its rallies." : "Tap a bar to see those points.")
                .font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Opponent attack fans

    private var attackFans: some View {
        let byRotation = Dictionary(grouping: setLines, by: \.opponentRotation)
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(advanced ? "Opponent attacks by their rotation" : "Their attacks").font(.groupTitle)
                if !advanced {
                    Text("By their rotation").font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                }
            }
            if byRotation.isEmpty {
                Text("No attacks scouted this set.").font(.themed(16, .regular)).foregroundStyle(Tokens.textSecondary.color)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    ForEach(byRotation.keys.sorted(), id: \.self) { rot in
                        let count = byRotation[rot]?.count ?? 0
                        VStack(alignment: .leading, spacing: 4) {
                            Text(advanced ? "R\(rot) \u{00B7} \(count)" : "Rotation \(rot) \u{00B7} \(count)")
                                .font(.themed(15, .semibold))
                            MiniFan(lines: byRotation[rot] ?? [])
                                .frame(height: 76)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Next-set controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 20) {
            if over {
                Button { controller.close(); onExit() } label: {
                    Label("Back to home", systemImage: "house")
                }
                .buttonStyle(CoachButtonStyle(fullWidth: true, minHeight: Tokens.targetLivePrimary))
                undoButton
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Suggested start").font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
                    if let s = suggested {
                        Text(advanced ? "R\(s.rotation): \(s.receiveWon) of \(s.receiveTotal)" : "Rotation \(s.rotation)")
                            .font(.themed(24, .bold))
                        if !advanced {
                            Text("Won \(s.receiveWon) of \(s.receiveTotal) on their serve")
                                .font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                        }
                    } else {
                        Text("No points on their serve yet").font(.themed(17, .regular))
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(advanced ? "Start next set in" : "Start next set in rotation").font(.groupTitle)
                        .foregroundStyle(Tokens.textSecondary.color)
                    ChoiceBar(options: rotationOptions, selection: $startRotation)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Who serves first?").font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
                    if nextIsDeciding {
                        Text("Deciding set: use the coin toss.").font(.themed(15, .regular))
                            .foregroundStyle(Tokens.textSecondary.color)
                    }
                    ChoiceBar(options: [(value: Optional(Side.home), title: controller.homeName),
                                        (value: Optional(Side.opponent), title: controller.opponentName)],
                              selection: $firstServer)
                }
                Button { controller.nextSet(firstServer: firstServer, homeStartRotation: startRotation) } label: {
                    Label("Start set \(finishedSet + 1)", systemImage: "play.fill")
                }
                .buttonStyle(CoachButtonStyle(fullWidth: true, minHeight: Tokens.targetLivePrimary))
                .disabled(firstServer == nil)
                undoButton
            }
        }
    }

    private var undoButton: some View {
        Button { controller.undo() } label: {
            Label("Undo last point", systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(CoachButtonStyle(kind: .quiet, fullWidth: true, minHeight: Tokens.targetStandard))
    }

    private func prefill() {
        // First serve alternates; the deciding set is tossed, so it asks once.
        firstServer = nextIsDeciding ? nil : state.match.current.firstServer.other
        // Default: start where this set started, so the lineup stays as it was.
        startRotation = state.rallies.first { $0.setNumber == finishedSet }?.homeRotation ?? state.match.rotationNumber(.home)
    }
}

/// A small court with the opponent's attacks of one rotation, origin to landing.
struct MiniFan: View {
    let lines: [ScoutLine]

    var body: some View {
        Canvas { ctx, size in
            // World frame: x across the court (-4.5...4.5), z along it (-9...9, home half positive).
            let sx = size.width / 18, sy = size.height / 9
            func pt(_ p: FloorPoint) -> CGPoint { CGPoint(x: (9 - p.z) * sx, y: (p.x + 4.5) * sy) }
            ctx.stroke(Path(CGRect(origin: .zero, size: size)), with: .color(Tokens.courtLine.color), lineWidth: 1)
            var net = Path()
            net.move(to: CGPoint(x: size.width / 2, y: 0))
            net.addLine(to: CGPoint(x: size.width / 2, y: size.height))
            ctx.stroke(net, with: .color(Tokens.text.withAlpha(0.8).color), lineWidth: 1.5)
            for line in lines {
                let a = pt(CourtFrame.world(line.originRaw, of: .opponent))
                let b = pt(CourtFrame.world(line.landingRaw, of: .home))
                var p = Path()
                p.move(to: a)
                p.addLine(to: b)
                ctx.stroke(p, with: .color(Tokens.accent.color), lineWidth: 1.5)
                ctx.fill(Path(ellipseIn: CGRect(x: b.x - 2.5, y: b.y - 2.5, width: 5, height: 5)), with: .color(Tokens.accent.color))
            }
        }
        .background(Tokens.canvasBase.color)
        .accessibilityLabel("\(lines.count) attacks")
    }
}

/// The rallies of one home rotation while receiving (tap on a Set Break bar).
struct RallyListSheet: View {
    let controller: LiveController
    let rotation: Int
    let setNumber: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        let rallies = controller.state.rallies.filter { $0.setNumber == setNumber && $0.homeRotation == rotation && $0.serving == .opponent }
        NavigationStack {
            List(rallies) { r in
                HStack(spacing: 12) {
                    Circle().fill(Tokens.team(r.winner).color).frame(width: 12, height: 12)
                    Text("\(r.scoreBefore.home):\(r.scoreBefore.opponent) \u{2192} \(r.scoreAfter.home):\(r.scoreAfter.opponent)")
                        .font(.themed(17, .semibold).monospacedDigit())
                    Spacer()
                    Text(outcome(won: r.winner == .home, advanced: advanced))
                        .font(.themed(17, .regular))
                        .foregroundStyle(Tokens.textSecondary.color)
                    Text(advanced ? "vs R\(r.opponentRotation)" : "Their rotation \(r.opponentRotation)")
                        .font(advanced ? Font.dataMono : Font.themed(15, .regular))
                }
                .frame(minHeight: Tokens.targetStandard)
            }
            .overlay {
                if rallies.isEmpty {
                    EmptyHint(symbol: "list.bullet",
                              message: advanced ? "No receptions in R\(rotation) this set."
                                                : "No points on their serve in rotation \(rotation) this set.")
                }
            }
            .navigationTitle(advanced ? "R\(rotation) receiving \u{00B7} set \(setNumber)" : "Rotation \(rotation) \u{00B7} set \(setNumber)")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func outcome(won: Bool, advanced: Bool) -> String {
        if advanced { return won ? "side-out" : "lost" }
        return won ? "Won" : "Lost"
    }
}
