import SwiftUI
import SwiftData

/// Screen 18 (Phase 1 subset): team switcher, jersey-only quick add, one row per player.
/// Simple shows number, name and role; Advanced adds the body measurements.
struct RosterView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Team.createdAt) private var teams: [Team]
    @State private var selectedTeamID: UUID?
    @State private var newJersey = ""
    @State private var problem: String?
    @State private var detail: Player?
    @State private var creatingTeam = false
    @State private var newTeamName = ""
    @FocusState private var addFocused: Bool
    var onDone: () -> Void

    private var team: Team? {
        teams.first { $0.id == selectedTeamID } ?? teams.first { $0.isOwnTeam } ?? teams.first
    }

    var body: some View {
        let players = team?.sortedPlayers ?? []
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        Text("#").font(.themed(28, .bold)).foregroundStyle(Tokens.accent.color)
                        TextField("Jersey number", text: $newJersey)
                            .keyboardType(.numberPad)
                            .font(.themed(24, .semibold).monospacedDigit())
                            .focused($addFocused)
                            .submitLabel(.next)
                            .onSubmit(add)
                        Button(action: add) {
                            Label("Add player", systemImage: "plus")
                        }
                        .buttonStyle(CoachButtonStyle(minHeight: Tokens.targetStandard + 4))
                        .disabled(newJersey.isEmpty)
                    }
                    .frame(minHeight: Tokens.targetLivePrimary)
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.circle")
                            .font(.scaled(.body, .semibold))
                            .foregroundStyle(Tokens.fault.color)
                    }
                } header: {
                    sectionHeader("Add a player")
                } footer: {
                    Text("Type a jersey number and tap Add player. The box stays ready for the next one. Names and roles are optional.")
                        .font(.scaled(.subheadline))
                }
                .listRowBackground(Tokens.surface.color)
                Section {
                    if players.isEmpty {
                        Text("No players yet. Add your first one above.")
                            .font(.scaled(.body))
                            .foregroundStyle(Tokens.textSecondary.color)
                            .frame(minHeight: Tokens.targetStandard)
                    }
                    ForEach(players) { player in
                        Button { detail = player } label: { PlayerRow(player: player) }
                            .foregroundStyle(Tokens.text.color)
                    }
                    .onDelete(perform: delete)
                } header: {
                    sectionHeader(team.map { "\($0.name) \u{00B7} \($0.players.count) players" } ?? "Team")
                } footer: {
                    if !players.isEmpty {
                        Text("Tap a player to add a name or role. Swipe left on a player to delete.")
                            .font(.scaled(.subheadline))
                    }
                }
                .listRowBackground(Tokens.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.canvasBase.color)
            .textCase(nil)
            .navigationTitle("Players")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { teamSwitcher }
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
            }
            .sheet(item: $detail) { PlayerDetailView(player: $0) }
            .alert("New team", isPresented: $creatingTeam) {
                TextField("Team name", text: $newTeamName)
                Button("Create") { createTeam() }
                Button("Cancel", role: .cancel) {}
            }
            .onAppear {
                ensureOwnTeam()
                addFocused = true
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title).font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
    }

    private var teamSwitcher: some View {
        Menu {
            ForEach(teams) { t in
                Button { selectedTeamID = t.id } label: {
                    if t.id == team?.id { Label(t.name, systemImage: "checkmark") } else { Text(t.name) }
                }
            }
            Divider()
            Button("New team\u{2026}") { newTeamName = ""; creatingTeam = true }
        } label: {
            Label(team?.name ?? "Team", systemImage: "person.3")
        }
        .accessibilityLabel("Team: \(team?.name ?? "none"). Change team")
    }

    private func ensureOwnTeam() {
        guard teams.isEmpty else { return }
        context.insert(Team(name: "My team", isOwnTeam: true))
    }

    private func createTeam() {
        let name = newTeamName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let t = Team(name: name, isOwnTeam: false)
        context.insert(t)
        selectedTeamID = t.id
    }

    private func add() {
        defer { addFocused = true }
        guard let team else { return }
        guard let n = Int(newJersey.trimmingCharacters(in: .whitespaces)), (0...99).contains(n) else {
            problem = "Jersey numbers run from 0 to 99."
            return
        }
        guard !team.players.contains(where: { $0.jersey == n }) else {
            problem = "#\(n) is already on \(team.name)."
            return
        }
        let p = Player(jersey: n)
        context.insert(p)
        p.team = team
        team.modifiedAt = .now
        problem = nil
        newJersey = ""
    }

    private func delete(_ offsets: IndexSet) {
        let players = team?.sortedPlayers ?? []
        for i in offsets where players.indices.contains(i) { context.delete(players[i]) }
    }
}

struct PlayerRow: View {
    let player: Player

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        HStack(spacing: 16) {
            Text("\(player.jersey)")
                .font(.themed(30, .bold).monospacedDigit())
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(player.displayName ?? "No name")
                    .font(.themed(17, .semibold))
                    .foregroundStyle(player.displayName == nil ? Tokens.textSecondary.color : Tokens.text.color)
                Text(player.role.label).font(.themed(15, .regular)).foregroundStyle(Tokens.textSecondary.color)
            }
            Spacer()
            if advanced {
                biometric("Height", player.stature, estimated: false)
                biometric("Reach", player.standingReachOrEstimate, estimated: player.standingReach == nil)
                biometric("Spike", player.spikeReach, estimated: false)
                biometric("Block", player.blockReach, estimated: false)
            }
            Image(systemName: "chevron.right")
                .font(.themed(15, .semibold))
                .foregroundStyle(Tokens.textSecondary.color)
        }
        .frame(minHeight: Tokens.targetLivePrimary)
        .contentShape(Rectangle())
    }

    private func biometric(_ label: String, _ value: Double?, estimated: Bool) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(label).font(.themed(13, .semibold)).foregroundStyle(Tokens.textSecondary.color)
            Text(value.map { String(format: "%.2f", $0) + (estimated ? " est." : "") } ?? "\u{2014}").font(.dataMono)
        }
        .frame(width: 84, alignment: .trailing)
    }
}

/// Screen 19 (Phase 1 subset): jersey, name and role; Advanced adds handedness and biometrics with inline range checks.
struct PlayerDetailView: View {
    @Bindable var player: Player
    @Environment(\.dismiss) private var dismiss
    @State private var jersey = ""
    @State private var name = ""
    @State private var stature = ""
    @State private var standing = ""
    @State private var spike = ""
    @State private var block = ""
    @State private var problem: String?

    var body: some View {
        let advanced = ThemeStore.shared.advanced
        NavigationStack {
            Form {
                Section("Player") {
                    LabeledContent("Jersey number") {
                        TextField("0\u{2013}99", text: $jersey).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Name") {
                        TextField("Optional", text: $name).multilineTextAlignment(.trailing)
                    }
                    Picker("Role", selection: Binding(get: { player.role }, set: { player.role = $0 })) {
                        ForEach(PlayerRole.allCases) { Text($0.label).tag($0) }
                    }
                    if advanced {
                        Picker("Handedness", selection: Binding(get: { player.handedness }, set: { player.handedness = $0 })) {
                            ForEach(Handedness.allCases) { Text($0.label).tag($0) }
                        }
                    }
                }
                if advanced {
                    Section {
                        metreField("Height", $stature, placeholder: "1.20\u{2013}2.25")
                        metreField("Standing reach", $standing,
                                   placeholder: player.stature.map { String(format: "est. %.2f", $0 * 1.31) } ?? "Optional")
                        metreField("Spike reach", $spike, placeholder: "Optional")
                        metreField("Block reach", $block, placeholder: "Optional")
                    } header: {
                        Text("Body measurements (metres)")
                    } footer: {
                        Text("Used for the 3D players and the block. Leave a field empty to use an estimate.")
                    }
                }
                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.circle").foregroundStyle(Tokens.fault.color)
                    }
                }
            }
            .font(.scaled(.body))
            .navigationTitle("Player #\(player.jersey)")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save) }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .onAppear(perform: load)
        }
    }

    private func metreField(_ title: String, _ text: Binding<String>, placeholder: String) -> some View {
        LabeledContent(title) {
            TextField(placeholder, text: text).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
        }
    }

    private func load() {
        jersey = String(player.jersey)
        name = player.displayName ?? ""
        stature = player.stature.map { String(format: "%.2f", $0) } ?? ""
        standing = player.standingReach.map { String(format: "%.2f", $0) } ?? ""
        spike = player.spikeReach.map { String(format: "%.2f", $0) } ?? ""
        block = player.blockReach.map { String(format: "%.2f", $0) } ?? ""
    }

    private func parse(_ s: String) -> Double?? {
        let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if t.isEmpty { return .some(nil) }
        guard let v = Double(t) else { return nil }
        return .some(v)
    }

    private func save() {
        guard let n = Int(jersey), (0...99).contains(n) else { problem = "Jersey numbers run from 0 to 99."; return }
        if let team = player.team, team.players.contains(where: { $0.jersey == n && $0.id != player.id }) {
            problem = "#\(n) is already on \(team.name)."
            return
        }
        guard let h = parse(stature), let st = parse(standing), let sp = parse(spike), let bl = parse(block) else {
            problem = "Enter metres, for example 1.92."
            return
        }
        if let reason = Biometrics.problem(stature: h, standing: st ?? h.map { $0 * 1.31 }, spike: sp, block: bl) {
            problem = reason
            return
        }
        player.jersey = n
        player.displayName = name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : name
        player.stature = h
        player.standingReach = st
        player.spikeReach = sp
        player.blockReach = bl
        player.modifiedAt = .now
        dismiss()
    }
}
