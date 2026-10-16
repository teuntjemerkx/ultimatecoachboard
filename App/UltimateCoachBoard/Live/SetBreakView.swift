import SwiftUI
import CoachBoardCore

/// Screen 6, Set Break Summary: decide the next set's start in the 3-minute interval.
/// Left: side-out record per home rotation; centre: opponent attacks per opponent rotation; right: next-set controls.
struct SetBreakPanel: View {
    @Bindable var controller: LiveController
    var onExit: () -> Void
    @State private var firstServer: Side?
    @State private var startRotation = 1
    @State private var rallyListRotation: Int?

    private var state: LiveState { controller.state }
    private var finishedSet: Int { state.match.current.number }
    private var over: Bool { state.context == .matchOver }
    private var records: [RotationRecord] { RotationStats.records(state.rallies, side: .home, setNumber: finishedSet) }
    private var suggested: RotationRecord? { RotationStats.suggestedStart(records) }
    private var nextIsDeciding: Bool { finishedSet + 1 == state.profile.scoring.setsToWin * 2 - 1 }
    private var setLines: [ScoutLine] { state.scoutLines.filter { $0.setNumber == finishedSet } }

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 20) {
                header
                HStack(alignment: .top, spacing: 28) {
                    sideOutBars.frame(width: 300)
                    attackFans.frame(maxWidth: .infinity)
                    controls.frame(width: 260)
                }
            }
            .foregroundStyle(Tokens.text.color)
            .padding(28)
            .frame(maxWidth: 1080)
            .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.accent.withAlpha(0.6).color))
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
            Text(over ? "MATCH OVER" : "SET \(finishedSet) COMPLETE").font(.sectionLabel).foregroundStyle(Tokens.accent.color)
            Text("\(controller.homeName) \(controller.score.home) : \(controller.score.opponent) \(controller.opponentName)")
                .font(.liveNumerals)
            Text("Sets \(state.match.setsWonHome) : \(state.match.setsWonOpponent)   ·   "
                 + state.match.sets.map { "\($0.score.home)–\($0.score.opponent)" }.joined(separator: "  "))
                .font(.dataMono).foregroundStyle(Tokens.textSecondary.color)
        }
    }

    // MARK: - Side-out bars

    private var sideOutBars: some View {
        let maxTotal = max(records.map(\.receiveTotal).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 10) {
            Text("SIDE-OUT BY ROTATION").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(records) { r in
                    Button { rallyListRotation = r.rotation } label: {
                        VStack(spacing: 6) {
                            Text(r.receiveTotal == 0 ? "–" : "\(r.receiveWon)/\(r.receiveTotal)").font(.dataMono)
                            VStack(spacing: 2) {
                                Rectangle().fill(Tokens.text.withAlpha(0.28).color)
                                    .frame(height: 140 * CGFloat(r.receiveLost) / CGFloat(maxTotal))
                                Rectangle().fill(Tokens.accent.color)
                                    .frame(height: 140 * CGFloat(r.receiveWon) / CGFloat(maxTotal))
                            }
                            .frame(width: 34, height: 140, alignment: .bottom)
                            .background(Tokens.hairline.color)
                            Text("R\(r.rotation)").font(.sectionLabel)
                                .foregroundStyle(r.rotation == suggested?.rotation ? Tokens.accent.color : Tokens.text.color)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Rotation \(r.rotation): \(r.receiveWon) of \(r.receiveTotal) side-outs")
                }
            }
            Text("Filled: rallies won while receiving. Tap a bar for its rallies.")
                .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
        }
    }

    // MARK: - Opponent attack fans

    private var attackFans: some View {
        let byRotation = Dictionary(grouping: setLines, by: \.opponentRotation)
        return VStack(alignment: .leading, spacing: 10) {
            Text("OPPONENT ATTACKS BY THEIR ROTATION").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            if byRotation.isEmpty {
                Text("No attacks scouted this set.").font(.system(size: 14)).foregroundStyle(Tokens.textSecondary.color)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    ForEach(byRotation.keys.sorted(), id: \.self) { rot in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("R\(rot) · \(byRotation[rot]?.count ?? 0)").font(.sectionLabel)
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
        VStack(alignment: .leading, spacing: 16) {
            if over {
                Button { controller.close(); onExit() } label: {
                    Text("BACK TO START").font(.themed(15, .heavy))
                        .frame(maxWidth: .infinity, minHeight: Tokens.targetLivePrimary)
                        .background(Tokens.accent.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .foregroundStyle(Tokens.canvasBase.color)
                }
                Button("Undo last action") { controller.undo() }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("SUGGESTED START").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                    if let s = suggested {
                        Text("R\(s.rotation): \(s.receiveWon) of \(s.receiveTotal)").font(.themed(22, .bold))
                    } else {
                        Text("No receptions yet").font(.system(size: 15))
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("START NEXT SET IN").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                    HStack(spacing: 6) {
                        ForEach(1...6, id: \.self) { r in
                            Button("R\(r)") { startRotation = r }
                                .font(.themed(13, .bold))
                                .frame(width: 38, height: Tokens.targetStandard)
                                .background(startRotation == r ? Tokens.accent.color : Tokens.canvasBase.color,
                                            in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
                                .foregroundStyle(startRotation == r ? Tokens.canvasBase.color : Tokens.text.color)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(nextIsDeciding ? "FIRST SERVE (DECIDING SET: TOSS)" : "FIRST SERVE").font(.sectionLabel)
                        .foregroundStyle(Tokens.textSecondary.color)
                    Picker("First serve", selection: $firstServer) {
                        Text(controller.homeName).tag(Optional(Side.home))
                        Text(controller.opponentName).tag(Optional(Side.opponent))
                    }
                    .pickerStyle(.segmented)
                }
                Button { controller.nextSet(firstServer: firstServer, homeStartRotation: startRotation) } label: {
                    Text("NEXT SET").font(.themed(17, .heavy))
                        .frame(maxWidth: .infinity, minHeight: Tokens.targetLiveCritical)
                        .background(firstServer == nil ? Tokens.hairline.color : Tokens.accent.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                        .foregroundStyle(Tokens.canvasBase.color)
                }
                .disabled(firstServer == nil)
                Button("Undo last action") { controller.undo() }
            }
        }
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
        let rallies = controller.state.rallies.filter { $0.setNumber == setNumber && $0.homeRotation == rotation && $0.serving == .opponent }
        NavigationStack {
            List(rallies) { r in
                HStack {
                    Circle().fill(Tokens.team(r.winner).color).frame(width: 10, height: 10)
                    Text("\(r.scoreBefore.home):\(r.scoreBefore.opponent) → \(r.scoreAfter.home):\(r.scoreAfter.opponent)").font(.dataMono)
                    Spacer()
                    Text(r.winner == .home ? "side-out" : "lost").foregroundStyle(Tokens.textSecondary.color)
                    Text("vs R\(r.opponentRotation)").font(.dataMono)
                }
            }
            .overlay { if rallies.isEmpty { Text("No receptions in R\(rotation) this set.").foregroundStyle(Tokens.textSecondary.color) } }
            .navigationTitle("R\(rotation) receiving · set \(setNumber)")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
