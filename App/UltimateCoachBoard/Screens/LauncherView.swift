import SwiftUI
import SwiftData
import CoachBoardCore

/// Screen 1 (Appendix C2): a header with the day and the team, one big primary action, the modes as an adaptive grid
/// that uses the whole width in either orientation, and recent sessions below.
struct LauncherView: View {
    @Bindable var model: AppModel
    @Query private var players: [Player]

    private var hasRoster: Bool { !players.isEmpty }
    private var canQuickStart: Bool { model.lastSetup?.homeSlots.allSatisfy({ $0 != nil }) == true }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                primaryCard
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 18)], spacing: 18) {
                    tile(title: "Match", subtitle: hasRoster || model.lastSetup != nil ? "Lineup, rotations and live scouting"
                                                                                           : "Add your team first \u{2014} 30 seconds",
                         symbol: "sportscourt", enabled: true, action: hasRoster || model.lastSetup != nil ? model.newMatch : model.openRoster)
                    tile(title: "Studio", subtitle: "Scenes in 2D and 3D, zones, POV and the ball", symbol: "cube.transparent",
                         enabled: true, action: model.openStudio)
                    tile(title: "Roster", subtitle: hasRoster ? "\(players.count) players" : "Jersey-only quick add",
                         symbol: "person.3", enabled: true, action: model.openRoster)
                    tile(title: "Training", subtitle: "Drill Architect \u{2014} coming next", symbol: "figure.volleyball",
                         enabled: false, action: {})
                }
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
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)).uppercased())
                    .font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text("Coach Board").font(.themed(40, .heavy))
            }
            Spacer()
            iconButton("gearshape", label: "Settings") { model.showSettings = true }
        }
    }

    /// The one thing most visits are for: start (or resume) a match.
    private var primaryCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let resumable = model.resumable {
                Text("MATCH IN PROGRESS").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text("\(resumable.title) \u{00B7} \(resumable.scoreLine)").font(.themed(26, .bold))
                primaryButton("Resume", symbol: "play.fill") { model.resume(resumable.url) }
            } else if canQuickStart {
                Text("READY WHEN YOU ARE").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text("Same lineup as last time").font(.themed(26, .bold))
                HStack(spacing: 12) {
                    primaryButton("Quick match", symbol: "bolt.fill") { model.quickMatch() }
                    secondaryButton("New lineup") { model.newMatch() }
                }
            } else {
                Text("GET STARTED").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text(hasRoster ? "Set up your first match" : "Add your team, then start a match").font(.themed(26, .bold))
                primaryButton(hasRoster ? "New match" : "Add players", symbol: hasRoster ? "plus" : "person.badge.plus") {
                    hasRoster ? model.newMatch() : model.openRoster()
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius * 1.4))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius * 1.4).stroke(Tokens.hairline.color))
    }

    private func primaryButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.themed(18, .bold))
                .padding(.horizontal, 26).frame(minHeight: Tokens.targetLivePrimary)
                .background(Tokens.accent.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                .foregroundStyle(Tokens.onAccent.color)
        }
        .buttonStyle(.plain)
    }

    private func secondaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.themed(17, .semibold))
                .padding(.horizontal, 22).frame(minHeight: Tokens.targetLivePrimary)
                .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.text.withAlpha(0.35).color, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
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
            Image(systemName: symbol).font(.themed(22, .semibold))
                .frame(width: Tokens.targetStandard + 8, height: Tokens.targetStandard + 8)
                .background(Tokens.surface.color, in: Circle())
                .overlay(Circle().stroke(Tokens.hairline.color))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func tile(title: String, subtitle: String, symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol).font(.themed(30, .semibold))
                    .foregroundStyle(enabled ? Tokens.home.color : Tokens.textSecondary.color)
                Spacer(minLength: 0)
                Text(title).font(.themed(24, .bold))
                Text(subtitle).font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                    .lineLimit(2, reservesSpace: true)
            }
            .padding(20)
            .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
            .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius * 1.4))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius * 1.4).stroke(Tokens.hairline.color))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
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
                    ctx.stroke(net, with: .color(Tokens.text.withAlpha(0.7).color), lineWidth: 1)
                }
                Text("\(summary.setsHome) : \(summary.setsOpponent)")
                    .font(.themed(20, .bold).monospacedDigit())
            }
            .frame(height: 50)
            Text(summary.title).font(.themed(12, .semibold)).lineLimit(1)
            Text(summary.finished ? summary.date.formatted(date: .abbreviated, time: .omitted) : "In progress · \(summary.scoreLine)")
                .font(.system(size: 11)).foregroundStyle(summary.finished ? Tokens.textSecondary.color : Tokens.accent.color)
                .lineLimit(1)
        }
        .padding(10)
        .frame(width: 160, height: 110, alignment: .topLeading)
        .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.hairline.color))
        .foregroundStyle(Tokens.text.color)
        .accessibilityElement(children: .combine)
    }
}

/// Screen 23: appearance (template and court orientation), grip side and the optional feedback click.
struct SettingsView: View {
    @AppStorage("gripRight") private var gripRight = true
    @AppStorage("feedbackSound") private var soundOn = false
    @Environment(\.dismiss) private var dismiss
    private let store = ThemeStore.shared

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
                        ForEach(Theme.all) { theme in
                            ThemeCard(theme: theme, selected: store.theme.id == theme.id) { store.select(theme) }
                        }
                    }
                    .padding(.vertical, 6)
                    Picker("Court", selection: Binding(get: { store.courtOrientation }, set: { store.setCourtOrientation($0) })) {
                        ForEach(CourtOrientation.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Sports hall is recommended for live use: in a lit hall dark text on a light background reads best, and blue against orange stays distinct with colour blindness. \"Fill the screen\" stands the court upright when the iPad is held upright.")
                }
                Section {
                    Picker("Grip side", selection: $gripRight) {
                        Text("Left hand").tag(false)
                        Text("Right hand").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Toggle("Feedback click", isOn: $soundOn)
                } header: {
                    Text("Sideline")
                } footer: {
                    Text("The Thumb Cluster and Start buttons sit on the grip side; the rail docks on the other edge. The edge pulse always confirms actions; the click is optional.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
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
                    Text(theme.name).font(.system(size: 16, weight: .bold, design: theme.fontDesign).width(theme.fontWidth))
                    if theme.recommended {
                        Text("RECOMMENDED").font(.system(size: 10, weight: .bold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                    }
                    Spacer()
                    if selected { Image(systemName: "checkmark.circle.fill").font(.system(size: 18)) }
                }
                Text(theme.summary).font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(3, reservesSpace: true)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Color.accentColor : Color.clear, lineWidth: 2.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(theme.name)\(theme.recommended ? ", recommended" : ""). \(theme.summary)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
