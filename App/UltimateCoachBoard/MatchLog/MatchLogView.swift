import SwiftUI
import CoachBoardCore

/// Screen 7, Match Log: rows grouped by set; tapping a row shows the board as it stood before that rally.
/// Simple keeps the everyday filters and plain wording; Advanced adds the side-out, break and scouting filters,
/// the compact rotation labels and player stats even before any touch was coded.
struct MatchLogView: View {
    let summary: MatchSummary
    var onClose: () -> Void
    var onResume: (URL) -> Void

    @State private var state: LiveState?
    @State private var records: [JournalRecord] = []
    @State private var rows: [MatchLogRow] = []
    @State private var selected: UInt64?
    @State private var filter: LogFilter = .all
    @State private var noteTarget: MatchLogRow?
    @State private var noteText = ""
    @State private var loadError: String?
    @State private var showStats = false

    enum LogFilter: String, CaseIterable, Identifiable {
        case all = "All", sideOuts = "Side-outs", breaks = "Breaks", timeOuts = "Time-outs"
        case scouting = "Scouting", substitutions = "Substitutions"
        var id: String { rawValue }

        /// The chip label.
        var title: String {
            switch self {
            case .all: return "All"
            case .sideOuts: return "Side-outs"
            case .breaks: return "Break points"
            case .timeOuts: return "Timeouts"
            case .scouting: return "Scouted attacks"
            case .substitutions: return "Substitutions"
            }
        }

        /// Filters every coach needs; the others are for Advanced.
        var everyday: Bool { self == .all || self == .timeOuts || self == .substitutions }

        func includes(_ row: MatchLogRow) -> Bool {
            switch self {
            case .all: return true
            case .sideOuts: return row.rally.sideOut
            case .breaks: return !row.rally.sideOut
            case .timeOuts: return row.timeOuts > 0
            case .scouting: return row.scoutLines > 0
            case .substitutions: return row.substitutions > 0
            }
        }
    }

    private var advanced: Bool { ThemeStore.shared.advanced }
    private var filters: [LogFilter] { LogFilter.allCases.filter { advanced || $0.everyday } }
    /// A filter hidden in Simple (chosen in Advanced before switching) falls back to All.
    private var activeFilter: LogFilter { filters.contains(filter) ? filter : .all }
    private var hasSkillCodes: Bool { state?.skillCodes.isEmpty == false }

    var body: some View {
        NavigationStack {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    filterChips
                    rowList
                }
                .frame(width: 440)
                .background(Tokens.canvasRaised.color)
                Rectangle().fill(Tokens.hairline.color).frame(width: 1)
                boardPane
            }
            .background(Tokens.canvasBase.color)
            .foregroundStyle(Tokens.text.color)
            .navigationTitle(summary.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", action: onClose) }
                ToolbarItemGroup(placement: .primaryAction) {
                    if advanced || hasSkillCodes {
                        Button("Player stats") { showStats = true }
                            .disabled(state == nil)
                    }
                    ShareLink(item: summary.url) { Label("Share match file", systemImage: "square.and.arrow.up") }
                    if !summary.finished {
                        Button("Resume match") { onResume(summary.url) }
                            .fontWeight(.bold)
                    }
                }
            }
            .alert("Add a note", isPresented: Binding(get: { noteTarget != nil }, set: { if !$0 { noteTarget = nil } })) {
                TextField("What happened?", text: $noteText)
                Button("Save") { saveNote() }
                Button("Cancel", role: .cancel) {}
            } message: {
                if let r = noteTarget?.rally { Text("Set \(r.setNumber), \(r.scoreBefore.home):\(r.scoreBefore.opponent)") }
            }
            .sheet(isPresented: $showStats) {
                if let state { PlayerStatsSheet(state: state, labels: labels, teamName: summary.homeName) }
            }
            .task { load() }
        }
    }

    // MARK: - List

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(filters) { f in
                    let on = activeFilter == f
                    Button { filter = f } label: {
                        Text(f.title)
                            .font(.themed(16, .semibold))
                            .padding(.horizontal, 16).frame(height: Tokens.targetStandard)
                            .background(on ? Tokens.accent.color : Tokens.canvasBase.color, in: Capsule())
                            .overlay(Capsule().stroke(Tokens.hairline.color))
                            .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(12)
        }
    }

    private var rowList: some View {
        let visible = rows.filter(activeFilter.includes)
        let sets = Dictionary(grouping: visible, by: \.rally.setNumber)
        return List(selection: $selected) {
            if let loadError {
                Text(loadError).font(.scaled(.body)).foregroundStyle(Tokens.fault.color)
            }
            ForEach(sets.keys.sorted(), id: \.self) { n in
                Section {
                    ForEach(sets[n] ?? []) { row in
                        LogRowView(row: row, labels: labels)
                            .tag(row.rally.seq)
                            .listRowBackground(row.rally.seq == selected ? Tokens.accent.withAlpha(0.16).color : Color.clear)
                            .swipeActions(edge: .trailing) {
                                Button("Add note") { noteText = ""; noteTarget = row }.tint(Tokens.accent.color)
                            }
                    }
                } header: {
                    Text(setHeader(n)).font(.groupTitle).foregroundStyle(Tokens.textSecondary.color).textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay {
            if rows.isEmpty && loadError == nil {
                if summary.finished {
                    EmptyHint(symbol: "list.bullet", message: "No points in this match.")
                } else {
                    EmptyHint(symbol: "list.bullet", message: "No points in this match yet.",
                              actionTitle: "Resume match", action: { onResume(summary.url) })
                }
            } else if !rows.isEmpty && visible.isEmpty {
                EmptyHint(symbol: "line.3.horizontal.decrease.circle", message: "Nothing here for this filter.",
                          actionTitle: "Show all", action: { filter = .all })
            }
        }
    }

    private func setHeader(_ n: Int) -> String {
        guard let state, state.match.sets.indices.contains(n - 1) else { return "Set \(n)" }
        let s = state.match.sets[n - 1].score
        return "Set \(n) \u{00B7} \(s.home)\u{2013}\(s.opponent)"
    }

    private var labels: [PlayerID: String] { state?.setup.playerLabels ?? [:] }

    // MARK: - Board

    @ViewBuilder private var boardPane: some View {
        if let state, let row = rows.first(where: { $0.rally.seq == selected }) {
            let before = state.rewound(before: row.rally.seq)
            let lines = state.scoutLines.filter { $0.setNumber == row.rally.setNumber && $0.score == row.rally.scoreBefore }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 16) {
                    Text("Set \(row.rally.setNumber)").font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
                    Text("\(row.rally.scoreBefore.home) : \(row.rally.scoreBefore.opponent)").font(.liveNumerals)
                    Text(serveLine(row.rally))
                        .font(.themed(17, .semibold))
                        .lineLimit(1)
                    Text(advanced ? "R\(row.rally.homeRotation) \u{21C4} R\(row.rally.opponentRotation)" : "Rotation \(row.rally.homeRotation)")
                        .font(advanced ? Font.dataMono : Font.themed(17, .regular))
                        .foregroundStyle(Tokens.textSecondary.color)
                    Spacer()
                    Text(row.rally.winner == .home ? "\(summary.homeName) won" : "\(summary.opponentName) won")
                        .font(.themed(17, .bold))
                        .foregroundStyle(Tokens.team(row.rally.winner).color)
                        .lineLimit(1)
                    Button { noteText = ""; noteTarget = row } label: {
                        Label("Add note", systemImage: "square.and.pencil")
                    }
                    .buttonStyle(CoachButtonStyle(kind: .secondary, minHeight: Tokens.targetStandard))
                }
                .foregroundStyle(Tokens.text.color)
                .padding(.horizontal, 16).padding(.top, 12)
                if !row.skills.isEmpty {
                    Text(row.skills.map { skillText($0) }.joined(separator: "   "))
                        .font(advanced ? Font.dataMono : Font.themed(16, .medium))
                        .foregroundStyle(Tokens.text.color)
                        .padding(.horizontal, 16)
                }
                StaticBoardView(scene: BoardScene.snapshot(before, labels: labels, lines: lines))
                ForEach(row.notes, id: \.self) { n in
                    Label(n, systemImage: "note.text").font(.scaled(.body)).padding(.horizontal, 16)
                }
                Text(advanced ? "Read-only: the formation before the serve, with this rally's scouted attacks."
                              : "Where everyone stood before the serve.")
                    .font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
                    .padding(.horizontal, 16).padding(.bottom, 12)
            }
        } else {
            VStack {
                Spacer()
                EmptyHint(symbol: "sportscourt", message: rows.isEmpty ? "The board appears here once the match has points."
                                                                       : "Pick a point on the left to see where everyone stood.")
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func serveLine(_ r: RallyRecord) -> String {
        let team = r.serving == .home ? summary.homeName : summary.opponentName
        let server = r.server.flatMap { labels[$0] }.map { " #\($0)" } ?? ""
        return "\(team) serves" + server
    }

    private func skillText(_ s: SkillCode) -> String {
        let who = (s.side == .home ? "" : (advanced ? "them " : "Them ")) + "#\(labels[s.player] ?? "?")"
        if advanced { return "\(who) \(s.skill.rawValue)\(s.grade.symbol)" }
        return "\(who) \(s.skill.name): \(PlainWords.grade(s.grade))"
    }

    // MARK: - Data

    private func load() {
        do {
            let loaded = try MatchArchive.load(summary.url)
            state = loaded.state
            records = loaded.records
            rows = MatchLog.rows(state: loaded.state, records: loaded.records)
            if selected == nil { selected = rows.last?.rally.seq }
            loadError = nil
        } catch {
            loadError = "Could not read this match: \(error.localizedDescription)"
        }
    }

    private func saveNote() {
        let text = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let row = noteTarget, !text.isEmpty else { return }
        do {
            try MatchArchive.appendNote(to: summary.url, afterSeq: row.rally.seq, text: text)
            load()
        } catch {
            loadError = "Could not save the note: \(error.localizedDescription)"
        }
        noteTarget = nil
    }
}

struct LogRowView: View {
    let row: MatchLogRow
    let labels: [PlayerID: String]

    var body: some View {
        let r = row.rally
        let advanced = ThemeStore.shared.advanced
        HStack(spacing: 12) {
            Circle().fill(Tokens.team(r.winner).color).frame(width: 12, height: 12)
            Text("\(r.scoreAfter.home):\(r.scoreAfter.opponent)").font(.themed(18, .bold).monospacedDigit())
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(advanced ? expertLine(r) : plainLine(r))
                    .font(.themed(16, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Text(advanced ? "R\(r.homeRotation) \u{21C4} R\(r.opponentRotation)" : "Rotation \(r.homeRotation)")
                    .font(advanced ? Font.dataMono : Font.themed(15, .regular))
                    .foregroundStyle(Tokens.textSecondary.color)
            }
            Spacer()
            HStack(spacing: 8) {
                if !row.skills.isEmpty { icon("list.bullet.clipboard", row.skills.count, "touches coded") }
                if row.scoutLines > 0 { icon("scope", row.scoutLines, "attacks scouted") }
                if row.sketchStrokes > 0 { icon("pencil.tip", nil, "drawing") }
                if row.substitutions > 0 { icon("arrow.left.arrow.right", row.substitutions, "substitutions") }
                if row.timeOuts > 0 { icon("timer", nil, "timeout") }
                if !row.notes.isEmpty { icon("note.text", nil, "note") }
            }
            .foregroundStyle(Tokens.textSecondary.color)
        }
        .frame(minHeight: Tokens.targetLivePrimary)
    }

    /// "We served #8 · Won" in Simple.
    private func plainLine(_ r: RallyRecord) -> String {
        let serve = (r.serving == .home ? "We served" : "They served") + (r.server.flatMap { labels[$0] }.map { " #\($0)" } ?? "")
        return serve + (r.winner == .home ? " \u{00B7} Won" : " \u{00B7} Lost")
    }

    /// "We serve #8 · side-out" in Advanced.
    private func expertLine(_ r: RallyRecord) -> String {
        let serve = (r.serving == .home ? "We serve" : "They serve") + (r.server.flatMap { labels[$0] }.map { " #\($0)" } ?? "")
        return serve + (r.sideOut ? " \u{00B7} side-out" : " \u{00B7} break")
    }

    private func icon(_ name: String, _ count: Int?, _ meaning: String) -> some View {
        HStack(spacing: 2) {
            Image(systemName: name)
            if let count, count > 1 { Text("\(count)").font(.themed(13, .semibold)) }
        }
        .font(.system(size: 15))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count.map { "\($0) \(meaning)" } ?? meaning)
    }
}

/// Player statistics from the Detailed live mode's skill codes: per skill the number of touches, the share of
/// # and +, and (Advanced) the efficiency (# − / − =) / total.
struct PlayerStatsSheet: View {
    let state: LiveState
    let labels: [PlayerID: String]
    let teamName: String
    @Environment(\.dismiss) private var dismiss
    @State private var setFilter = 0          // 0 = whole match

    private let skills: [Skill] = [.serve, .reception, .set, .attack, .block, .dig]

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        let setNumber = setFilter == 0 ? nil : setFilter
        let table = SkillStats.table(state.skillCodes, side: .home, setNumber: setNumber)
        let team = SkillStats.team(state.skillCodes, side: .home, setNumber: setNumber)
        let players = table.keys.sorted { (Int(labels[$0] ?? "") ?? 999) < (Int(labels[$1] ?? "") ?? 999) }
        NavigationStack {
            ScrollView {
                if players.isEmpty {
                    EmptyHint(symbol: "tablecells",
                              message: advanced
                                ? "No skill codes yet. In Live, set the mode to Detailed and tap a player to code a touch."
                                : "No touches recorded yet. In a match, tap More, then More detail, and tap a player.")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 12) {
                        GridRow {
                            Text(advanced ? "#" : "Player").font(.groupTitle)
                            ForEach(skills, id: \.self) { Text($0.name).font(.groupTitle) }
                        }
                        .foregroundStyle(Tokens.textSecondary.color)
                        Divider()
                        ForEach(players, id: \.self) { p in
                            GridRow {
                                Text(advanced ? (labels[p] ?? "?") : PlainWords.player(labels[p], advanced: false))
                                    .font(.themed(22, .bold).monospacedDigit())
                                ForEach(skills, id: \.self) { s in cell(table[p]?[s], advanced: advanced) }
                            }
                        }
                        Divider()
                        GridRow {
                            Text(teamName).font(.groupTitle)
                            ForEach(skills, id: \.self) { s in cell(team[s], advanced: advanced) }
                        }
                    }
                    .padding(24)
                    if !advanced {
                        Text("Touches, and the share that was perfect or good.")
                            .font(.scaled(.subheadline))
                            .foregroundStyle(Tokens.textSecondary.color)
                            .padding(.horizontal, 24)
                    }
                }
            }
            .background(Tokens.canvasBase.color)
            .foregroundStyle(Tokens.text.color)
            .navigationTitle("Player stats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Picker("Set", selection: $setFilter) {
                        Text("Whole match").tag(0)
                        ForEach(state.match.sets.map(\.number), id: \.self) { Text("Set \($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    @ViewBuilder private func cell(_ line: SkillLine?, advanced: Bool) -> some View {
        if let line, line.total > 0 {
            let rate = line.positiveRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "\u{2013}"
            VStack(alignment: .leading, spacing: 2) {
                if advanced {
                    Text("\(line.total)  \(rate)").font(.dataMono)
                    Text("eff \(line.efficiency.map { String(format: "%+.0f", $0 * 100) } ?? "\u{2013}")")
                        .font(.themed(13, .regular)).foregroundStyle(Tokens.textSecondary.color)
                } else {
                    Text("\(line.total)").font(.themed(18, .bold).monospacedDigit())
                    Text("\(rate) good").font(.themed(14, .regular)).foregroundStyle(Tokens.textSecondary.color)
                }
            }
        } else {
            Text("\u{2013}").foregroundStyle(Tokens.textSecondary.color)
        }
    }
}
