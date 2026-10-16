import SwiftUI
import SwiftData
import CoachBoardCore

/// A roster player placed in a lineup slot.
struct SlotPlayer: Codable, Equatable, Hashable {
    var id: UUID
    var jersey: Int
    var name: String?
}

/// Everything Match Setup collects (Screen 2), saved for Quick Match.
struct MatchSetupData: Codable, Equatable {
    enum SetupError: Error { case incomplete }

    var homeName = "Home"
    var opponentName = "Opponent"
    var system: TeamSystem = .fiveOneOutside
    /// Home players by court position; index 0 is P1.
    var homeSlots: [SlotPlayer?] = Array(repeating: nil, count: 6)
    var homeLibero: SlotPlayer?
    /// Where the system's first role (the setter) starts; it names the starting rotation.
    var setterPosition = 1
    /// Opponent jersey numbers by court position; unknown is allowed.
    var opponentNumbers: [Int?] = Array(repeating: nil, count: 6)
    var opponentLibero: Int?
    var opponentSetterPosition = 1
    var firstServer: Side = .home
    var mode: CoachMode = .solo
    var netHeight = 2.43
}

/// Screen 2: a mini half-court with six position slots and a libero slot, fed by a strip of jersey chips;
/// settings in one column on the grip side with the Start button (Appendix C2).
struct MatchSetupView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Team.createdAt) private var teams: [Team]
    @AppStorage("gripRight") private var gripRight = true
    @State private var setup: MatchSetupData
    @State private var armed: Armed?
    @State private var quickJersey = ""
    @State private var showOpponent = false
    var onStart: (MatchSetupData) -> Void
    var onCancel: () -> Void

    /// What a tap on a slot does next: place a bench player, move a placed player (slot index, -1 = libero),
    /// or mark the setter.
    enum Armed: Equatable {
        case player(SlotPlayer)
        case slot(Int)
        case setter
    }

    init(initial: MatchSetupData, onStart: @escaping (MatchSetupData) -> Void, onCancel: @escaping () -> Void) {
        _setup = State(initialValue: initial)
        self.onStart = onStart
        self.onCancel = onCancel
    }

    private static let profile = try? RuleCourtProfile.fivbSenior()

    private var ownTeam: Team? { teams.first { $0.isOwnTeam } ?? teams.first }
    private var template: RotationTemplate? { try? TemplateLibrary.template(id: setup.system.templateID) }
    private var hasLibero: Bool { template?.libero != nil }
    private var anchor: CourtPosition {
        setup.system.hasSetter ? (CourtPosition(rawValue: setup.setterPosition) ?? .p1) : .p1
    }
    private var roles: [CourtPosition: String] {
        guard let order = template?.lineupOrder else { return [:] }
        return LineupBuilder.roles(order: order, anchor: anchor)
    }
    private var placedIDs: Set<UUID> {
        Set(setup.homeSlots.compactMap { $0?.id } + [setup.homeLibero?.id].compactMap { $0 })
    }
    private var bench: [Player] { ownTeam?.sortedPlayers.filter { !placedIDs.contains($0.id) } ?? [] }

    var body: some View {
        NavigationStack {
            HStack(alignment: .top, spacing: 28) {
                if !gripRight { settingsColumn }
                lineupColumn.frame(maxWidth: .infinity)
                if gripRight { settingsColumn }
            }
            .padding(24)
            .navigationTitle("Match setup")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            }
            .sheet(isPresented: $showOpponent) { OpponentLineupSheet(setup: $setup) }
        }
    }

    // MARK: - Lineup

    private var lineupColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            TextField("Our team", text: $setup.homeName)
                .font(.system(size: 24, weight: .bold).width(.expanded))
            VStack(spacing: 10) {
                HStack {
                    Text("NET").font(.sectionLabel).foregroundStyle(Tokens.accent.color)
                    Rectangle().fill(Tokens.accent.color).frame(height: 3)
                }
                HStack(spacing: 10) { slotView(.p4); slotView(.p3); slotView(.p2) }
                Rectangle().fill(Tokens.courtLine.color).frame(height: 1).padding(.vertical, 4)
                HStack(spacing: 10) { slotView(.p5); slotView(.p6); slotView(.p1) }
                if hasLibero {
                    HStack {
                        liberoView.frame(width: 180)
                        Spacer()
                    }
                }
            }
            .padding(16)
            .background(Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.courtLine.color, lineWidth: 1))
            rosterStrip
            Text(hint).font(.system(size: 13)).foregroundStyle(Tokens.textSecondary.color)
        }
    }

    private var hint: String {
        switch armed {
        case .player(let p): return "Tap a slot for #\(p.jersey)."
        case .slot: return "Tap another slot to move or swap, or the same slot to take the player off."
        case .setter: return "Tap the setter's slot; it names the starting rotation."
        case nil: return "Tap a jersey, then a slot (or drag). Typing numbers fills P1, P2, … in order."
        }
    }

    private func slotView(_ pos: CourtPosition) -> some View {
        let index = pos.rawValue - 1
        let player = setup.homeSlots[index]
        let isSetter = setup.system.hasSetter && pos == anchor
        let highlighted = armed == .slot(index) || (armed != nil && armed != .slot(index) && player == nil)
        return Button { tapSlot(index) } label: {
            VStack(spacing: 4) {
                Text(pos.label).font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text(player.map { "\($0.jersey)" } ?? "—")
                    .font(.system(size: 34, weight: .bold).width(.expanded).monospacedDigit())
                Text(roles[pos] ?? "").font(.sectionLabel)
                    .foregroundStyle(isSetter ? Tokens.accent.color : Tokens.textSecondary.color)
            }
            .foregroundStyle(Tokens.white.color)
            .frame(maxWidth: .infinity, minHeight: 112)
            .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6)
                .stroke(highlighted || isSetter ? Tokens.accent.color : Tokens.hairline.color,
                        lineWidth: armed == .slot(index) ? 3 : (highlighted || isSetter ? 1.5 : 1)))
        }
        .buttonStyle(.plain)
        .draggable(player?.id.uuidString ?? "")
        .dropDestination(for: String.self) { items, _ in return dropped(items, at: index) }
        .accessibilityLabel("\(pos.label), \(player.map { "number \($0.jersey)" } ?? "empty"), \(roles[pos] ?? "")")
    }

    private var liberoView: some View {
        Button { tapSlot(-1) } label: {
            HStack(spacing: 10) {
                Text("L").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
                Text(setup.homeLibero.map { "\($0.jersey)" } ?? "—")
                    .font(.system(size: 26, weight: .bold).width(.expanded).monospacedDigit())
                Text("LIBERO").font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            }
            .foregroundStyle(Tokens.white.color)
            .frame(maxWidth: .infinity, minHeight: 60)
            .background(Tokens.canvasBase.color, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(armed == .slot(-1) ? Tokens.accent.color : Tokens.hairline.color,
                                                             lineWidth: armed == .slot(-1) ? 3 : 1))
        }
        .buttonStyle(.plain)
        .dropDestination(for: String.self) { items, _ in return dropped(items, at: -1) }
    }

    private var rosterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                if setup.system.hasSetter {
                    chip(title: "SETTER", subtitle: "mark", selected: armed == .setter) {
                        armed = armed == .setter ? nil : .setter
                    }
                }
                ForEach(bench) { p in
                    let slot = SlotPlayer(id: p.id, jersey: p.jersey, name: p.displayName)
                    chip(title: "\(p.jersey)", subtitle: p.role.short, selected: armed == .player(slot)) {
                        armed = armed == .player(slot) ? nil : .player(slot)
                    }
                    .draggable(p.id.uuidString)
                }
                HStack(spacing: 4) {
                    Text("+#").font(.system(size: 15, weight: .bold)).foregroundStyle(Tokens.accent.color)
                    TextField("new", text: $quickJersey)
                        .keyboardType(.numberPad)
                        .font(.system(size: 20, weight: .semibold).monospacedDigit())
                        .frame(width: 60)
                        .onSubmit(quickAdd)
                }
                .padding(.horizontal, 12)
                .frame(height: Tokens.targetLivePrimary)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Tokens.hairline.color))
            }
            .padding(.vertical, 2)
        }
    }

    private func chip(title: String, subtitle: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 0) {
                Text(title).font(.system(size: title.count > 3 ? 13 : 22, weight: .bold).width(.expanded).monospacedDigit())
                Text(subtitle).font(.system(size: 10, weight: .semibold)).foregroundStyle(Tokens.textSecondary.color)
            }
            .foregroundStyle(selected ? Tokens.canvasBase.color : Tokens.white.color)
            .frame(minWidth: Tokens.targetLivePrimary, minHeight: Tokens.targetLivePrimary)
            .padding(.horizontal, 6)
            .background(selected ? Tokens.accent.color : Tokens.canvasRaised.color, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Tokens.hairline.color))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Placing players

    private func player(at index: Int) -> SlotPlayer? { index < 0 ? setup.homeLibero : setup.homeSlots[index] }

    private func setPlayer(_ p: SlotPlayer?, at index: Int) {
        if index < 0 { setup.homeLibero = p } else { setup.homeSlots[index] = p }
    }

    private func location(of id: UUID) -> Int? {
        if setup.homeLibero?.id == id { return -1 }
        return setup.homeSlots.firstIndex { $0?.id == id }
    }

    /// Places a player; a player already on court swaps places with the one displaced.
    private func place(_ p: SlotPlayer, at index: Int) {
        let from = location(of: p.id)
        let displaced = player(at: index)
        if let from { setPlayer(nil, at: from) }
        setPlayer(p, at: index)
        if let from, let displaced, displaced.id != p.id { setPlayer(displaced, at: from) }
        if index >= 0, setup.system.hasSetter, ownTeam?.players.first(where: { $0.id == p.id })?.role == .setter {
            setup.setterPosition = index + 1
        }
    }

    private func tapSlot(_ index: Int) {
        switch armed {
        case .player(let p):
            place(p, at: index)
            armed = nil
        case .slot(let from):
            if from == index {
                setPlayer(nil, at: index)
            } else if let p = player(at: from) {
                place(p, at: index)
            }
            armed = nil
        case .setter:
            if index >= 0 { setup.setterPosition = index + 1 }
            armed = nil
        case nil:
            if player(at: index) != nil { armed = .slot(index) }
        }
    }

    private func dropped(_ items: [String], at index: Int) -> Bool {
        guard let s = items.first, let id = UUID(uuidString: s) else { return false }
        if let from = location(of: id), let p = player(at: from) {
            place(p, at: index)
        } else if let p = ownTeam?.players.first(where: { $0.id == id }) {
            place(SlotPlayer(id: p.id, jersey: p.jersey, name: p.displayName), at: index)
        } else {
            return false
        }
        armed = nil
        return true
    }

    /// Jersey-only quick add from the strip: adds to the roster and fills the next empty slot.
    private func quickAdd() {
        defer { quickJersey = "" }
        guard let n = Int(quickJersey.trimmingCharacters(in: .whitespaces)), (0...99).contains(n) else { return }
        let team: Team
        if let ownTeam {
            team = ownTeam
        } else {
            team = Team(name: setup.homeName.isEmpty ? "My team" : setup.homeName, isOwnTeam: true)
            context.insert(team)
        }
        let p: Player
        if let existing = team.players.first(where: { $0.jersey == n }) {
            p = existing
        } else {
            p = Player(jersey: n)
            context.insert(p)
            p.team = team
        }
        let slot = SlotPlayer(id: p.id, jersey: p.jersey, name: p.displayName)
        if location(of: p.id) == nil, let empty = setup.homeSlots.firstIndex(where: { $0 == nil }) {
            place(slot, at: empty)
        }
    }

    // MARK: - Settings

    private var settingsColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            group("OPPONENT") {
                TextField("Opponent", text: $setup.opponentName).textFieldStyle(.roundedBorder)
                Button { showOpponent = true } label: {
                    let known = setup.opponentNumbers.compactMap { $0 }.count
                    Label("Lineup: \(known) of 6 numbers · setter P\(setup.opponentSetterPosition)", systemImage: "list.number")
                }
            }
            group("SYSTEM") {
                Picker("System", selection: $setup.system) {
                    ForEach(TeamSystem.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .pickerStyle(.menu)
            }
            group("FIRST SERVE") {
                Picker("First serve", selection: $setup.firstServer) {
                    Text("Us").tag(Side.home)
                    Text("Them").tag(Side.opponent)
                }
                .pickerStyle(.segmented)
            }
            group("NET HEIGHT") {
                HStack {
                    ForEach([2.43, 2.24], id: \.self) { h in
                        Button(String(format: "%.2f", h)) { setup.netHeight = h }
                            .buttonStyle(.bordered)
                            .tint(abs(setup.netHeight - h) < 0.001 ? Tokens.accent.color : Tokens.textSecondary.color)
                    }
                }
                Stepper(String(format: "Custom %.2f m", setup.netHeight), value: $setup.netHeight, in: 2.00...2.43, step: 0.01)
            }
            group("RULES") {
                Text(Self.profile?.name ?? "FIVB senior indoor").font(.system(size: 15, weight: .semibold))
            }
            Toggle("Working alone today?", isOn: Binding(get: { setup.mode == .solo },
                                                          set: { setup.mode = $0 ? .solo : .advanced }))
            if let problem = validationProblem {
                Text(problem).font(.system(size: 14, weight: .semibold)).foregroundStyle(Tokens.accentActive.color)
            } else {
                Label(templateBadge, systemImage: "checkmark.seal.fill")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Tokens.accent.color)
            }
            ForEach(roleWarnings, id: \.self) { w in
                Text(w).font(.system(size: 13)).foregroundStyle(Tokens.textSecondary.color)
            }
            Spacer(minLength: 8)
            Button { onStart(setup) } label: {
                Text("START")
                    .font(.system(size: 20, weight: .heavy).width(.expanded))
                    .frame(maxWidth: .infinity, minHeight: Tokens.targetLiveCritical)
                    .background(validationProblem == nil ? Tokens.accent.color : Tokens.hairline.color, in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(Tokens.canvasBase.color)
            }
            .disabled(validationProblem != nil)
        }
        .frame(width: 320)
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.sectionLabel).foregroundStyle(Tokens.textSecondary.color)
            content()
        }
    }

    /// Inline validation, never a dialog (Appendix C2): Start stays disabled with a one-line reason.
    private var validationProblem: String? {
        let placed = setup.homeSlots.compactMap { $0 }.count
        if placed < 6 { return "Place six players on court (\(placed) of 6)." }
        let numbers = setup.homeSlots.compactMap { $0?.jersey } + [setup.homeLibero?.jersey].compactMap { $0 }
        if Set(numbers).count != numbers.count { return "Two players share a jersey number." }
        let theirs = setup.opponentNumbers.compactMap { $0 } + [setup.opponentLibero].compactMap { $0 }
        if Set(theirs).count != theirs.count { return "Opponent numbers must be different." }
        if let failing = Self.templateFailure(setup.system) { return failing }
        return nil
    }

    private var templateBadge: String {
        let margin = Self.templateMargin(setup.system)
        return "\(setup.system.displayName) verified" + (margin.map { String(format: " · smallest margin %.2f m", $0) } ?? "")
    }

    private static func validations(_ system: TeamSystem) -> [FormationValidation] {
        guard let profile, let t = try? TemplateLibrary.template(id: system.templateID) else { return [] }
        return TemplateLibrary.validate(t, profile: profile)
    }

    private static func templateFailure(_ system: TeamSystem) -> String? {
        guard let bad = validations(system).first(where: { !$0.isLegal }), let pair = bad.failing.first else { return nil }
        return "Template R\(bad.rotation) \(bad.phase): \(pair.a.label) and \(pair.b.label) overlap."
    }

    private static func templateMargin(_ system: TeamSystem) -> Double? {
        validations(system).map(\.minMargin).min()
    }

    /// Roster roles that disagree with the role the lineup order gives a player (non-blocking).
    private var roleWarnings: [String] {
        guard let team = ownTeam else { return [] }
        var out: [String] = []
        for pos in CourtPosition.allCases {
            guard let slot = setup.homeSlots[pos.rawValue - 1], let role = roles[pos],
                  let player = team.players.first(where: { $0.id == slot.id }) else { continue }
            if !player.role.fits(templateRole: role) {
                out.append("#\(slot.jersey) is listed as \(player.role.label.lowercased()) but plays \(role) here.")
            }
        }
        return out
    }
}

/// Optional opponent numbers by position, their libero and where their setter starts.
struct OpponentLineupSheet: View {
    @Binding var setup: MatchSetupData
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Numbers by position (unknown is fine)") {
                    ForEach(0..<6, id: \.self) { i in
                        LabeledContent("P\(i + 1)") {
                            TextField("—", value: Binding(get: { setup.opponentNumbers[i] }, set: { setup.opponentNumbers[i] = $0 }),
                                      format: .number)
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 80)
                        }
                    }
                    LabeledContent("Libero") {
                        TextField("—", value: $setup.opponentLibero, format: .number)
                            .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 80)
                    }
                }
                Section("Their setter starts in") {
                    Picker("Setter position", selection: $setup.opponentSetterPosition) {
                        ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Opponent lineup")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
