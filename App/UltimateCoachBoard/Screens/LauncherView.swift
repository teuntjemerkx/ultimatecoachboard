import SwiftUI
import SwiftData
import CoachBoardCore

/// Screen 1 (Appendix C2): a header with the day, one big primary action, the tools as an adaptive grid that uses
/// the whole width in either orientation, and recent matches below. Simple shows the essentials in plain words;
/// Advanced adds the expert descriptions and the upcoming Training tile.
struct LauncherView: View {
    @Bindable var model: AppModel
    @Query private var players: [Player]

    private var hasRoster: Bool { !players.isEmpty }
    private var canQuickStart: Bool { model.lastSetup?.homeSlots.allSatisfy({ $0 != nil }) == true }
    private var advanced: Bool { ThemeStore.shared.advanced }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                header
                primaryCard
                tiles
                if !model.recents.isEmpty { recentsStrip }
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(Tokens.text.color)
        .onAppear { model.refreshArchive() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                    .font(.themed(17, .semibold))
                    .foregroundStyle(Tokens.textSecondary.color)
                Text("Coach Board").font(.themed(40, .heavy))
            }
            Spacer()
            Button { model.showSettings = true } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .buttonStyle(CoachButtonStyle(kind: .secondary, minHeight: Tokens.targetStandard + 4))
        }
    }

    /// The one thing most visits are for: start (or resume) a match.
    private var primaryCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let resumable = model.resumable {
                cardHeading("Match in progress", title: resumable.title, detail: resumable.scoreLine)
                Button { model.resume(resumable.url) } label: {
                    Label("Resume match", systemImage: "play.fill")
                }
                .buttonStyle(CoachButtonStyle())
            } else if canQuickStart {
                cardHeading("Ready to play", title: "Same lineup as last time", detail: nil)
                HStack(spacing: 12) {
                    Button { model.quickMatch() } label: {
                        Label("Start match", systemImage: "play.fill")
                    }
                    .buttonStyle(CoachButtonStyle())
                    Button("Change lineup") { model.newMatch() }
                        .buttonStyle(CoachButtonStyle(kind: .secondary))
                }
            } else {
                cardHeading("Get started", title: hasRoster ? "Set up your first match" : "Add your players, then start a match",
                            detail: nil)
                Button { hasRoster ? model.newMatch() : model.openRoster() } label: {
                    Label(hasRoster ? "New match" : "Add players", systemImage: hasRoster ? "plus" : "person.badge.plus")
                }
                .buttonStyle(CoachButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .coachCard(padding: 28)
    }

    private func cardHeading(_ label: String, title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
            Text(title).font(.themed(28, .bold)).lineLimit(2)
            if let detail, !detail.isEmpty {
                Text(detail).font(.themed(20, .semibold).monospacedDigit()).foregroundStyle(Tokens.textSecondary.color)
            }
        }
    }

    // MARK: - Tools

    private var tiles: some View {
        let ready = hasRoster || model.lastSetup != nil
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: advanced ? 230 : 300), spacing: 18)], spacing: 18) {
            tile(title: "Match",
                 subtitle: ready ? (advanced ? "Lineup, rotations and live scouting" : "Pick your lineup and keep score")
                                 : (advanced ? "Add your team first \u{2014} 30 seconds" : "Add your players first"),
                 symbol: "sportscourt", enabled: true, action: ready ? model.newMatch : model.openRoster)
            tile(title: "Studio",
                 subtitle: advanced ? "Scenes in 2D and 3D, zones, POV and the ball" : "Draw plays on a 2D or 3D court",
                 symbol: "cube.transparent", enabled: true, action: model.openStudio)
            tile(title: "Video to 3D",
                 subtitle: advanced ? "Rebuild a rally from video, on device; eye view in the clip's hall"
                                    : "Turn a rally video into 3D",
                 symbol: "video.badge.waveform", enabled: true, action: model.openVideoImport)
            tile(title: "Players",
                 subtitle: hasRoster ? "\(players.count) players" : (advanced ? "Jersey-only quick add" : "Add your players by number"),
                 symbol: "person.3", enabled: true, action: model.openRoster)
            if advanced {
                tile(title: "Training", subtitle: "Drill Architect \u{2014} coming soon", symbol: "figure.volleyball",
                     enabled: false, action: {})
            }
        }
    }

    private func tile(title: String, subtitle: String, symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: symbol).font(.themed(30, .semibold))
                    .foregroundStyle(enabled ? Tokens.home.color : Tokens.textSecondary.color)
                Spacer(minLength: 12)
                Text(title).font(.themed(24, .bold))
                Text(subtitle).font(.themed(17, .regular)).foregroundStyle(Tokens.textSecondary.color)
                    .lineLimit(2, reservesSpace: true)
            }
            .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
            .coachCard(padding: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
    }

    // MARK: - Recent matches

    private var recentsStrip: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recent matches").font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(model.recents.prefix(8)) { s in
                        RecentCard(summary: s)
                            .onTapGesture { model.open(s) }
                            .contextMenu {
                                ShareLink(item: s.url) { Label("Share match file", systemImage: "square.and.arrow.up") }
                                Button(role: .destructive) { model.delete(s) } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
                .padding(.vertical, 2)
            }
            if advanced {
                Text("Touch and hold a match to share or delete it.")
                    .font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
            }
        }
    }
}

/// A recent-match card with a mini-court thumbnail and the sets score.
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
                    ctx.stroke(net, with: .color(Tokens.text.withAlpha(0.7).color), lineWidth: 1)
                }
                Text("\(summary.setsHome) : \(summary.setsOpponent)")
                    .font(.themed(24, .bold).monospacedDigit())
            }
            .frame(height: 56)
            Text(summary.title).font(.themed(15, .semibold)).lineLimit(1)
            Text(summary.finished ? summary.date.formatted(date: .abbreviated, time: .omitted) : "In progress \u{00B7} \(summary.scoreLine)")
                .font(.themed(14, .medium))
                .foregroundStyle(summary.finished ? Tokens.textSecondary.color : Tokens.accent.color)
                .lineLimit(1)
        }
        .padding(12)
        .frame(width: 200, height: 132, alignment: .topLeading)
        .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard).stroke(Tokens.hairline.color))
        .foregroundStyle(Tokens.text.color)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Screen 23: the coach level (Simple or Advanced), appearance (template and court orientation), grip side and
/// the optional feedback click.
struct SettingsView: View {
    @AppStorage("gripRight") private var gripRight = true
    @AppStorage("feedbackSound") private var soundOn = false
    @Environment(\.dismiss) private var dismiss
    private let store = ThemeStore.shared

    var body: some View {
        let advanced = store.advanced
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        ChoiceBar(options: [(value: false, title: "Simple"), (value: true, title: "Advanced")],
                                  selection: Binding(get: { store.advanced }, set: { store.setAdvanced($0) }))
                        Text(advanced ? "All tools and detailed stats." : "The essentials, in plain words.")
                            .font(.scaled(.body))
                            .foregroundStyle(Tokens.textSecondary.color)
                    }
                    .padding(.vertical, 6)
                } header: {
                    sectionHeader("Coach level")
                }
                .listRowBackground(Tokens.surface.color)
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        ChoiceBar(options: [(value: true, title: "Women"), (value: false, title: "Men")],
                                  selection: Binding(get: { store.women }, set: { store.setWomen($0) }))
                        Text(store.women ? "Net 2.24 m; player heights of women's teams in 3D."
                                         : "Net 2.43 m; player heights of men's teams in 3D.")
                            .font(.scaled(.body))
                            .foregroundStyle(Tokens.textSecondary.color)
                    }
                    .padding(.vertical, 6)
                } header: {
                    sectionHeader("Players")
                }
                .listRowBackground(Tokens.surface.color)
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
                        ForEach(Theme.all) { theme in
                            ThemeCard(theme: theme, selected: store.theme.id == theme.id) { store.select(theme) }
                        }
                    }
                    .padding(.vertical, 6)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Court on screen").font(.scaled(.body, .semibold))
                        ChoiceBar(options: CourtOrientation.allCases.map { (value: $0, title: $0.title) },
                                  selection: Binding(get: { store.courtOrientation }, set: { store.setCourtOrientation($0) }))
                    }
                    .padding(.vertical, 6)
                } header: {
                    sectionHeader("Appearance")
                } footer: {
                    Text(advanced
                         ? "Sports hall is recommended for live use: it reads best under hall lights and stays clear with colour blindness. \"Fill the screen\" stands the court upright when you hold the iPad upright."
                         : "Sports hall reads best in a bright gym.")
                        .font(.scaled(.subheadline))
                }
                .listRowBackground(Tokens.surface.color)
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Hand that holds the iPad").font(.scaled(.body, .semibold))
                        ChoiceBar(options: [(value: false, title: "Left hand"), (value: true, title: "Right hand")],
                                  selection: $gripRight)
                    }
                    .padding(.vertical, 6)
                    Toggle("Click sound", isOn: $soundOn)
                        .font(.scaled(.body))
                        .frame(minHeight: Tokens.targetStandard)
                } header: {
                    sectionHeader("During a match")
                } footer: {
                    Text(advanced
                         ? "The Thumb Cluster and Start buttons sit on the side of the hand that holds the iPad; the rail docks on the other edge. The screen edge always pulses to confirm an action; the click is optional."
                         : "The big buttons sit on that side, so your thumb reaches them. The screen edge always pulses to confirm; the click is optional.")
                        .font(.scaled(.subheadline))
                }
                .listRowBackground(Tokens.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.background.color)
            .textCase(nil)
            .foregroundStyle(Tokens.text.color)
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title).font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
    }
}

/// A template with a miniature of its board: hall, free zone, court, lines, net and one token per team.
struct ThemeCard: View {
    let theme: Theme
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Canvas { ctx, size in
                    ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(theme.hall.color))
                    let court = CGRect(x: size.width * 0.14, y: size.height * 0.2, width: size.width * 0.72, height: size.height * 0.6)
                    ctx.fill(Path(court.insetBy(dx: -size.width * 0.07, dy: -size.height * 0.12)), with: .color(theme.freeZone.color))
                    ctx.fill(Path(court), with: .color(theme.court.color))
                    ctx.stroke(Path(court), with: .color(theme.courtLine.color), lineWidth: 1.5)
                    var net = Path()
                    net.move(to: CGPoint(x: court.midX, y: court.minY - 4))
                    net.addLine(to: CGPoint(x: court.midX, y: court.maxY + 4))
                    ctx.stroke(net, with: .color(theme.net.color), lineWidth: 2.5)
                    for (i, color) in [theme.home, theme.home, theme.opponent, theme.opponent].enumerated() {
                        let x = court.minX + court.width * [0.2, 0.36, 0.64, 0.8][i]
                        let y = court.minY + court.height * [0.3, 0.7, 0.3, 0.7][i]
                        let r = CGRect(x: x - 7, y: y - 7, width: 14, height: 14)
                        let shape = i < 2 ? Path(ellipseIn: r) : Path { p in
                            p.move(to: CGPoint(x: x, y: y - 8)); p.addLine(to: CGPoint(x: x + 8, y: y))
                            p.addLine(to: CGPoint(x: x, y: y + 8)); p.addLine(to: CGPoint(x: x - 8, y: y)); p.closeSubpath()
                        }
                        ctx.fill(shape, with: .color(theme.tokenFill.color))
                        ctx.stroke(shape, with: .color(color.color), lineWidth: 2.5)
                    }
                }
                .frame(height: 96)
                .clipShape(RoundedRectangle(cornerRadius: theme.cornerRadius))
                HStack(spacing: 6) {
                    Text(theme.name).font(.system(size: 17, weight: .bold, design: theme.fontDesign).width(theme.fontWidth))
                    if theme.recommended {
                        Text("Recommended").font(.themed(13, .bold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Tokens.accent.withAlpha(0.15).color, in: Capsule())
                    }
                    Spacer()
                    if selected {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(Tokens.accent.color)
                    }
                }
                Text(theme.summary).font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                    .lineLimit(3, reservesSpace: true)
            }
            .foregroundStyle(Tokens.text.color)
            .padding(12)
            .background(Tokens.background.color, in: RoundedRectangle(cornerRadius: Tokens.radiusCard))
            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusCard)
                .stroke(selected ? Tokens.accent.color : Tokens.hairline.color, lineWidth: selected ? 3 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(theme.name)\(theme.recommended ? ", recommended" : ""). \(theme.summary)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
