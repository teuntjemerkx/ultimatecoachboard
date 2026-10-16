import SwiftUI
import SwiftData
import CoachBoardCore

/// Screen 1: three tiles, Quick Match one tap away, recent sessions below, Roster and Settings top right (Appendix C2).
struct LauncherView: View {
    @Bindable var model: AppModel
    @Query private var players: [Player]

    private var hasRoster: Bool { !players.isEmpty }

    var body: some View {
        VStack(spacing: 28) {
            HStack {
                Text("THE ULTIMATE COACH BOARD")
                    .font(.system(size: 15, weight: .semibold).width(.expanded))
                    .foregroundStyle(Tokens.textSecondary.color)
                Spacer()
                iconButton("person.3", label: "Roster") { model.openRoster() }
                iconButton("gearshape", label: "Settings") { model.showSettings = true }
            }
            Spacer(minLength: 0)
            HStack(spacing: 24) {
                if hasRoster || model.lastSetup != nil {
                    tile(title: "MATCH", subtitle: model.lastSetup == nil ? "Set up a match" : "New lineup",
                         enabled: true, action: model.newMatch) {
                        if model.lastSetup?.homeSlots.allSatisfy({ $0 != nil }) == true {
                            Button { model.quickMatch() } label: {
                                Text("QUICK MATCH")
                                    .font(.system(size: 13, weight: .bold).width(.expanded))
                                    .padding(.horizontal, 14).frame(height: 44)
                                    .background(Tokens.accent.color, in: RoundedRectangle(cornerRadius: 4))
                                    .foregroundStyle(Tokens.canvasBase.color)
                            }
                        }
                    }
                } else {
                    // First launch without a roster (Screen 1 states).
                    tile(title: "MATCH", subtitle: "Add your team \u{2014} 30 seconds", enabled: true, action: model.openRoster) {
                        EmptyView()
                    }
                }
                tile(title: "TRAINING", subtitle: "Drill Architect \u{2014} phase 2", enabled: false, action: {}) { EmptyView() }
                tile(title: "STUDIO", subtitle: "2D/3D analysis \u{2014} phase 2", enabled: false, action: {}) { EmptyView() }
            }
            if let resumable = model.resumable {
                Button { model.resume(resumable.url) } label: {
                    Label("Resume \(resumable.title) · \(resumable.scoreLine)", systemImage: "arrow.clockwise")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 20).frame(height: 52)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.accent.color, lineWidth: 1.5))
                }
                .foregroundStyle(Tokens.white.color)
            }
            Spacer(minLength: 0)
            if !model.recents.isEmpty { recentsStrip }
        }
        .padding(32)
        .onAppear { model.refreshArchive() }
    }

    private var recentsStrip: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(model.recents.prefix(8)) { s in
                        RecentCard(summary: s)
                            .onTapGesture { model.open(s) }
                            .contextMenu {
                                ShareLink(item: s.url) { Label("Share journal", systemImage: "square.and.arrow.up") }
                                Button(role: .destructive) { model.delete(s) } label: {
                                    Label("Move to Recently Deleted", systemImage: "trash")
                                }
                            }
                    }
                }
            }
        }
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                .frame(width: Tokens.targetStandard, height: Tokens.targetStandard)
        }
        .foregroundStyle(Tokens.white.color)
        .accessibilityLabel(label)
    }

    private func tile<Extra: View>(title: String, subtitle: String, enabled: Bool, action: @escaping () -> Void,
                                   @ViewBuilder extra: () -> Extra) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 28, weight: .bold).width(.expanded))
            Text(subtitle).font(.system(size: 15)).foregroundStyle(Tokens.textSecondary.color)
            Spacer()
            extra()
        }
        .padding(20)
        .frame(width: 280, height: 200, alignment: .topLeading)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(enabled ? Tokens.accent.color : Tokens.hairline.color, lineWidth: enabled ? 2 : 1))
        .foregroundStyle(enabled ? Tokens.white.color : Tokens.textSecondary.color)
        .contentShape(Rectangle())
        .onTapGesture { if enabled { action() } }
        .opacity(enabled ? 1 : 0.55)
    }
}

/// A 160 × 110 pt recent-session card with a mini-court thumbnail.
struct RecentCard: View {
    let summary: MatchSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                Canvas { ctx, size in
                    let court = CGRect(x: 4, y: 4, width: size.width - 8, height: size.height - 8)
                    ctx.stroke(Path(court), with: .color(Tokens.courtLine.color), lineWidth: 1)
                    var net = Path()
                    net.move(to: CGPoint(x: court.midX, y: court.minY))
                    net.addLine(to: CGPoint(x: court.midX, y: court.maxY))
                    ctx.stroke(net, with: .color(Tokens.white.withAlpha(0.7).color), lineWidth: 1)
                }
                Text("\(summary.setsHome) : \(summary.setsOpponent)")
                    .font(.system(size: 20, weight: .bold).width(.expanded).monospacedDigit())
            }
            .frame(height: 50)
            Text(summary.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            Text(summary.finished ? summary.date.formatted(date: .abbreviated, time: .omitted) : "In progress · \(summary.scoreLine)")
                .font(.system(size: 11)).foregroundStyle(summary.finished ? Tokens.textSecondary.color : Tokens.accent.color)
                .lineLimit(1)
        }
        .padding(10)
        .frame(width: 160, height: 110, alignment: .topLeading)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Tokens.hairline.color))
        .foregroundStyle(Tokens.white.color)
        .accessibilityElement(children: .combine)
    }
}

/// Screen 23 (Phase 1 subset): grip side and the optional feedback click.
struct SettingsView: View {
    @AppStorage("gripRight") private var gripRight = true
    @AppStorage("feedbackSound") private var soundOn = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Sideline") {
                    Picker("Grip side", selection: $gripRight) {
                        Text("Left hand").tag(false)
                        Text("Right hand").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Toggle("Feedback click", isOn: $soundOn)
                } footer: {
                    Text("The Thumb Cluster and Start buttons sit on the grip side; the rail docks on the other edge. The edge pulse always confirms actions; the click is optional.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
