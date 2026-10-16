import SwiftUI
import CoachBoardCore

/// Screen 7, Match Log: rows grouped by set; tapping a row shows the board as it stood before that rally.
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
            .navigationTitle(summary.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", action: onClose) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { showStats = true } label: { Label("Player stats", systemImage: "tablecells") }
                        .disabled(state == nil)
                    if !summary.finished {
                        Button("Resume match") { onResume(summary.url) }
                    }
                    ShareLink(item: summary.url) { Label("Export journal", systemImage: "square.and.arrow.up") }
                }
            }
            .alert("Note", isPresented: Binding(get: { noteTarget != nil }, set: { if !$0 { noteTarget = nil } })) {
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
                ForEach(LogFilter.allCases) { f in
                    Button(f.rawValue) { filter = f }
                        .font(.themed(13, .semibold))
                        .padding(.horizontal, 12).frame(height: 36)
                        .background(filter == f ? Tokens.accent.color : Tokens.canvasBase.color, in: Capsule())
                        .foregroundStyle(filter == f ? Tokens.canvasBase.color : Tokens.text.color)
                }
            }
            .padding(12)
        }
    }

    private var rowList: some View {
        let visible = rows.filter(filter.includes)
        let sets = Dictionary(grouping: visible, by: \.rally.setNumber)
        return List(selection: $selected) {
            if let loadError {
                Text(loadError).foregroundStyle(Tokens.fault.color)
            }
            ForEach(sets.keys.sorted(), id: \.self) { n in
                Section(header: Text(setHeader(n))) {
                    ForEach(sets[n] ?? []) { row in
                        LogRowView(row: row, labels: labels)
                            .tag(row.rally.seq)
                            .listRowBackground(row.rally.seq == selected ? Tokens.accent.withAlpha(0.16).color : Color.clear)
                            .swipeActions(edge: .trailing) {
                                Button("Note") { noteText = ""; noteTarget = row }.tint(Tokens.accent.color)
                            }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay {
            if rows.isEmpty && loadError == nil { Text("No rallies logged.").foregroundStyle(Tokens.textSecondary.color) }
        }
    }

    private func setHeader(_ n: Int) -> String {
        guard let state, state.match.sets.indices.contains(n - 1) else { return "SET \(n)" }
        let s = state.match.sets[n - 1].score
        return "SET \(n) · \(s.home)–\(s.opponent)"
    }

    private var labels: [PlayerID: String] { state?.setup.playerLabels ?? [:] }

    // MARK: - Board

    @ViewBuilder private var boardPane: some View {
        if let state, let row = rows.first(where: { $0.rally.seq == selected }) {
            let before = state.rewound(before: row.rally.seq)
            let lines = state.scoutLines.filter { $0.setNumber == row.rally.setNumber && $0.score == row.rally.scoreBefore }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 16) {
                    Text("SET \(row.rally.setNumber)").font(.sectionLabel)
                    Text("\(row.rally.scoreBefore.home) : \(row.rally.scoreBefore.opponent)").font(.liveNumerals)
                    Text("\(row.rally.serving == .home ? summary.homeName : summary.opponentName) serves"
                         + (row.rally.server.flatMap { labels[$0] }.map { " #\($0)" } ?? ""))
                        .font(.sectionLabel)
                    Text("R\(row.rally.homeRotation) \u{21C4} R\(row.rally.opponentRotation)").font(.dataMono)
                    Spacer()
                    Text(row.rally.winner == .home ? "\(summary.homeName) won" : "\(summary.opponentName) won")
                        .font(.sectionLabel)
                        .foregroundStyle(Tokens.team(row.rally.winner).color)
                }
                .foregroundStyle(Tokens.text.color)
                .padding(.horizontal, 16).padding(.top, 12)
                if !row.skills.isEmpty {
                    Text(row.skills.map { "\($0.side == .home ? "" : "them ")#\(labels[$0.player] ?? "?") \($0.skill.rawValue)\($0.grade.symbol)" }
                        .joined(separator: "   "))
                        .font(.dataMono)
                        .foregroundStyle(Tokens.text.color)
                        .padding(.horizontal, 16)
                }
                StaticBoardView(scene: BoardScene.snapshot(before, labels: labels, lines: lines))
                ForEach(row.notes, id: \.self) { n in
                    Label(n, systemImage: "note.text").font(.system(size: 14)).padding(.horizontal, 16)
                }
                Text("Read-only: the formation before the serve, with this rally's scouted attacks.")
                    .font(.system(size: 12)).foregroundStyle(Tokens.textSecondary.color)
                    .padding(.horizontal, 16).padding(.bottom, 12)
            }
        } else {
            VStack {
                Spacer()
                Text("Select a rally to see the board as it stood before the serve.")
                    .foregroundStyle(Tokens.textSecondary.color)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
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
        HStack(spacing: 10) {
            Circle().fill(Tokens.team(r.winner).color).frame(width: 10, height: 10)
            Text("\(r.scoreAfter.home):\(r.scoreAfter.opponent)").font(.themed(17, .bold).monospacedDigit())
                .frame(width: 58, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text((r.serving == .home ? "Us" : "Them") + " serve" + (r.server.flatMap { labels[$0] }.map { " #\($0)" } ?? "")
                     + (r.sideOut ? " · side-out" : " · break"))
                    .font(.themed(13, .semibold))
                Text("R\(r.homeRotation) \u{21C4} R\(r.opponentRotation)").font(.dataMono).foregroundStyle(Tokens.textSecondary.color)
            }
            Spacer()
            HStack(spacing: 6) {
                if !row.skills.isEmpty { icon("list.bullet.clipboard", row.skills.count) }
                if row.scoutLines > 0 { icon("scope", row.scoutLines) }
                if row.sketchStrokes > 0 { icon("pencil.tip", nil) }
                if row.substitutions > 0 { icon("arrow.left.arrow.right", row.substitutions) }
                if row.timeOuts > 0 { icon("timer", nil) }
                if !row.notes.isEmpty { icon("note.text", nil) }
            }
            .foregroundStyle(Tokens.textSecondary.color)
        }
        .frame(minHeight: Tokens.targetStandard)
    }

    private func icon(_ name: String, _ count: Int?) -> some View {
        HStack(spacing: 2) {
            Image(systemName: name)
            if let count, count > 1 { Text("\(count)").font(.system(size: 11)) }
        }
        .font(.system(size: 13))
    }
}

/// Player statistics from the Advanced Mode skill codes: per skill the number of touches, the share of # and +,
/// and the efficiency (# − / − =) / total.
struct PlayerStatsSheet: View {
    let state: LiveState
    let labels: [PlayerID: String]
    let teamName: String
    @Environment(\.dismiss) private var dismiss
    @State private var setFilter = 0          // 0 = whole match

    private let skills: [Skill] = [.serve, .reception, .set, .attack, .block, .dig]

    var body: some View {
        let setNumber = setFilter == 0 ? nil : setFilter
        let table = SkillStats.table(state.skillCodes, side: .home, setNumber: setNumber)
        let team = SkillStats.team(state.skillCodes, side: .home, setNumber: setNumber)
        let players = table.keys.sorted { (Int(labels[$0] ?? "") ?? 999) < (Int(labels[$1] ?? "") ?? 999) }
        NavigationStack {
            ScrollView {
                if players.isEmpty {
                    Text("No skill codes yet. Long-press the mode badge in Live to switch to Advanced and code touches.")
                        .foregroundStyle(Tokens.textSecondary.color)
                        .padding(24)
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
                        GridRow {
                            Text("#").font(.sectionLabel)
                            ForEach(skills, id: \.self) { Text($0.name.uppercased()).font(.sectionLabel) }
                        }
                        .foregroundStyle(Tokens.textSecondary.color)
                        Divider()
                        ForEach(players, id: \.self) { p in
                            GridRow {
                                Text(labels[p] ?? "?").font(.themed(20, .bold).monospacedDigit())
                                ForEach(skills, id: \.self) { s in cell(table[p]?[s]) }
                            }
                        }
                        Divider()
                        GridRow {
                            Text(teamName.uppercased()).font(.sectionLabel)
                            ForEach(skills, id: \.self) { s in cell(team[s]) }
                        }
                    }
                    .padding(24)
                }
            }
            .background(Tokens.canvasBase.color)
            .navigationTitle("Player stats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Picker("Set", selection: $setFilter) {
                        Text("Match").tag(0)
                        ForEach(state.match.sets.map(\.number), id: \.self) { Text("Set \($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    @ViewBuilder private func cell(_ line: SkillLine?) -> some View {
        if let line, line.total > 0 {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(line.total)  \(line.positiveRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")")
                    .font(.dataMono)
                Text("eff \(line.efficiency.map { String(format: "%+.0f", $0 * 100) } ?? "–")")
                    .font(.system(size: 11)).foregroundStyle(Tokens.textSecondary.color)
            }
        } else {
            Text("–").foregroundStyle(Tokens.textSecondary.color)
        }
    }
}
