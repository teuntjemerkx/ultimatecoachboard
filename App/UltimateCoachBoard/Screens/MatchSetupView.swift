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
    /// Roster players not in the lineup, available as substitutes.
    var homeBench: [SlotPlayer]?
    var firstServer: Side = .home
    var mode: CoachMode = .solo
    var netHeight = 2.43
}

/// Screen 2: a mini half-court with six position slots and a libero slot, fed by a strip of jersey chips;
/// settings in one column on the grip side with the Start button (Appendix C2). Simple asks only what every match
/// needs; Advanced adds the opponent lineup, a custom net height, the rule profile and the template check details.
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

    private var advanced: Bool { ThemeStore.shared.advanced }
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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Tokens.background.color)
            .foregroundStyle(Tokens.text.color)
            .navigationTitle("New match")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            }
            .sheet(isPresented: $showOpponent) { OpponentLineupSheet(setup: $setup) }
        }
    }

    // MARK: - Lineup

    private var lineupColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Our team").font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
                TextField("Team name", text: $setup.homeName)
                    .font(.themed(26, .bold))
            }
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    Text("Net").font(.groupTitle).foregroundStyle(Tokens.accent.color)
                    Rectangle().fill(Tokens.accent.color).frame(height: 3)
                }
                HStack(spacing: 10) { slotView(.p4); slotView(.p3); slotView(.p2) }
                Rectangle().fill(Tokens.courtLine.color).frame(height: 1).padding(.vertical, 4)
                HStack(spacing: 10) { slotView(.p5); slotView(.p6); slotView(.p1) }
                if hasLibero {
                    HStack {
                        liberoView.frame(width: 220)
                        Spacer()
                    }
                }
            }
            .coachCard(padding: 16)
            rosterStrip
            Label(hint, systemImage: "hand.tap")
                .font(.scaled(.body))
                .foregroundStyle(Tokens.textSecondary.color)
        }
    }

    private var hint: String {
        switch armed {
        case .player(let p): return "Now tap a position for #\(p.jersey)."
        case .slot: return "Tap another position to move or swap. Tap the same one again to take the player off."
        case .setter: return "Tap the position where your setter starts."
        case nil:
            return advanced ? "Tap a number, then a position (or drag it). New numbers fill P1, P2, \u{2026} in order."
                            : "Tap a number, then a position. Or drag it there."
        }
    }

    private func slotView(_ pos: CourtPosition) -> some View {
        let index = pos.rawValue - 1
        let player = setup.homeSlots[index]
        let isSetter = setup.system.hasSetter && pos == anchor
        let highlighted = armed == .slot(index) || (armed != nil && armed != .slot(index) && player == nil)
        let role = roles[pos] ?? ""
        return Button { tapSlot(index) } label: {
            VStack(spacing: 4) {
                Text(advanced ? pos.label : "Position \(pos.rawValue)")
                    .font(.themed(15, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                Text(player.map { "\($0.jersey)" } ?? "\u{2014}")
                    .font(.themed(38, .bold).monospacedDigit())
                Text(advanced ? role : PlainWords.role(role))
                    .font(.themed(15, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(isSetter ? Tokens.accent.color : Tokens.textSecondary.color)
            }
            .padding(.horizontal, 6)
            .foregroundStyle(Tokens.text.color)
            .frame(maxWidth: .infinity, minHeight: 120)
            .background(Tokens.background.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius)
                .stroke(highlighted || isSetter ? Tokens.accent.color : Tokens.hairline.color,
                        lineWidth: armed == .slot(index) ? 3 : (highlighted || isSetter ? 1.5 : 1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .draggable(player?.id.uuidString ?? "")
        .dropDestination(for: String.self) { items, _ in return dropped(items, at: index) }
        .accessibilityLabel("Position \(pos.rawValue), \(player.map { "number \($0.jersey)" } ?? "empty"), \(PlainWords.role(role))")
    }

    private var liberoView: some View {
        Button { tapSlot(-1) } label: {
            HStack(spacing: 12) {
                Text("Libero").font(.themed(15, .semibold)).foregroundStyle(Tokens.textSecondary.color)
                Text(setup.homeLibero.map { "\($0.jersey)" } ?? "\u{2014}")
                    .font(.themed(28, .bold).monospacedDigit())
            }
            .foregroundStyle(Tokens.text.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.targetLivePrimary)
            .background(Tokens.background.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(armed == .slot(-1) ? Tokens.accent.color : Tokens.hairline.color,
                                                                                 lineWidth: armed == .slot(-1) ? 3 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .dropDestination(for: String.self) { items, _ in return dropped(items, at: -1) }
        .accessibilityLabel("Libero, \(setup.homeLibero.map { "number \($0.jersey)" } ?? "empty")")
    }

    private var rosterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                if setup.system.hasSetter {
                    setterChip
                }
                ForEach(bench) { p in
                    let slot = SlotPlayer(id: p.id, jersey: p.jersey, name: p.displayName)
                    chip(title: "\(p.jersey)", subtitle: advanced ? p.role.short : Self.roleWord(p.role), selected: armed == .player(slot)) {
                        armed = armed == .player(slot) ? nil : .player(slot)
                    }
                    .draggable(p.id.uuidString)
                }
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.themed(17, .bold)).foregroundStyle(Tokens.accent.color)
                    TextField("Add #", text: $quickJersey)
                        .keyboardType(.numberPad)
                        .font(.themed(20, .semibold).monospacedDigit())
                        .frame(width: 70)
                        .onSubmit(quickAdd)
                }
                .padding(.horizontal, 12)
                .frame(height: Tokens.targetLivePrimary)
                .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.hairline.color))
                .accessibilityLabel("Add a player by jersey number")
            }
            .padding(.vertical, 2)
        }
    }

    private var setterChip: some View {
        let on = armed == .setter
        return Button { armed = on ? nil : .setter } label: {
            Label("Mark setter", systemImage: "hand.point.up.left")
                .font(.themed(16, .semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: Tokens.targetLivePrimary)
                .foregroundStyle(on ? Tokens.onAccent.color : Tokens.text.color)
                .background(on ? Tokens.accent.color : Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.hairline.color))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// The roster role in one short word for the jersey chips (Simple).
    private static func roleWord(_ role: PlayerRole) -> String {
        switch role {
        case .unknown: return ""
        case .defensive: return "Defence"
        default: return role.label
        }
    }

    private func chip(title: String, subtitle: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title).font(.system(size: 22, weight: .bold).width(.expanded).monospacedDigit())
                if !subtitle.isEmpty {
                    Text(subtitle).font(.themed(13, .semibold)).lineLimit(1)
                        .foregroundStyle(selected ? Tokens.onAccent.color : Tokens.textSecondary.color)
                }
            }
            .foregroundStyle(selected ? Tokens.onAccent.color : Tokens.text.color)
            .frame(minWidth: 64, minHeight: Tokens.targetLivePrimary)
            .padding(.horizontal, 6)
            .background(selected ? Tokens.accent.color : Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Tokens.cornerRadius).stroke(Tokens.hairline.color))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Number \(title)" + (subtitle.isEmpty ? "" : ", \(subtitle)"))
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
        VStack(alignment: .leading, spacing: 16) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    group("Opponent") {
                        TextField("Opponent name", text: $setup.opponentName)
                            .font(.scaled(.body))
                            .textFieldStyle(.roundedBorder)
                        if advanced {
                            Button { showOpponent = true } label: {
                                let known = setup.opponentNumbers.compactMap { $0 }.count
                                Label("Lineup: \(known) of 6 numbers \u{00B7} setter P\(setup.opponentSetterPosition)", systemImage: "list.number")
                                    .font(.scaled(.body, .semibold))
                                    .frame(minHeight: Tokens.targetStandard)
                            }
                        }
                    }
                    group("Team system") {
                        systemMenu
                    }
                    group("Who serves first?") {
                        ChoiceBar(options: [(value: Side.home, title: "Us"), (value: Side.opponent, title: "Them")],
                                  selection: $setup.firstServer)
                    }
                    group("Net height") {
                        ChoiceBar(options: [(value: 2.43, title: "2.43 m"), (value: 2.24, title: "2.24 m")],
                                  selection: $setup.netHeight)
                        Text("2.43 m for men, 2.24 m for women.")
                            .font(.scaled(.subheadline)).foregroundStyle(Tokens.textSecondary.color)
                        if advanced {
                            Stepper(String(format: "Custom %.2f m", setup.netHeight), value: $setup.netHeight, in: 2.00...2.43, step: 0.01)
                                .font(.scaled(.body))
                        }
                    }
                    if advanced {
                        group("Rules") {
                            Text(Self.profile?.name ?? "FIVB senior indoor").font(.scaled(.body, .semibold))
                        }
                    }
                    // The way into Detailed mode; Simple shows it only when it is already on, so it can be turned off.
                    if advanced || setup.mode == .advanced {
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle("Record every touch", isOn: Binding(get: { setup.mode == .advanced },
                                                                       set: { setup.mode = $0 ? .advanced : .solo }))
                                .font(.scaled(.body, .semibold))
                            Text("Best with a second coach. You can switch during the match.")
                                .font(.scaled(.subheadline)).foregroundStyle(Tokens.textSecondary.color)
                        }
                    }
                    status
                }
                .padding(.bottom, 8)
            }
            Button { onStart(withBench(setup)) } label: {
                Label("Start match", systemImage: "play.fill")
            }
            .buttonStyle(CoachButtonStyle(fullWidth: true, minHeight: 64))
            .disabled(validationProblem != nil)
        }
        .frame(width: 320)
    }

    private var systemMenu: some View {
        Menu {
            Picker("Team system", selection: $setup.system) {
                ForEach(TeamSystem.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
        } label: {
            HStack {
                Text(setup.system.displayName).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down").font(.themed(14, .semibold))
            }
            .font(.scaled(.body, .semibold))
            .foregroundStyle(Tokens.text.color)
            .padding(.horizontal, 14)
            .frame(minHeight: Tokens.targetStandard + 4)
            .background(Tokens.surface.color, in: RoundedRectangle(cornerRadius: Tokens.radiusSmall))
            .overlay(RoundedRectangle(cornerRadius: Tokens.radiusSmall).stroke(Tokens.hairline.color))
        }
        .accessibilityLabel("Team system: \(setup.system.displayName)")
    }

    @ViewBuilder private var status: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let problem = validationProblem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.scaled(.body, .semibold)).foregroundStyle(Tokens.fault.color)
            } else {
                Label(advanced ? templateBadge : "Lineup ready", systemImage: "checkmark.seal.fill")
                    .font(.scaled(.body, .semibold)).foregroundStyle(Tokens.accent.color)
            }
            ForEach(roleWarnings, id: \.self) { w in
                Text(w).font(.scaled(.subheadline)).foregroundStyle(Tokens.textSecondary.color)
            }
        }
    }

    /// The roster players left off the lineup become the substitutes' bench.
    private func withBench(_ s: MatchSetupData) -> MatchSetupData {
        var s = s
        s.homeBench = bench.map { SlotPlayer(id: $0.id, jersey: $0.jersey, name: $0.displayName) }
        return s
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.groupTitle).foregroundStyle(Tokens.textSecondary.color)
            content()
        }
    }

    /// Inline validation, never a dialog (Appendix C2): Start stays disabled with a one-line reason.
    private var validationProblem: String? {
        let placed = setup.homeSlots.compactMap { $0 }.count
        if placed < 6 { return "Put 6 players on court (\(placed) of 6)." }
        let numbers = setup.homeSlots.compactMap { $0?.jersey } + [setup.homeLibero?.jersey].compactMap { $0 }
        if Set(numbers).count != numbers.count { return "Two players share a jersey number." }
        let theirs = setup.opponentNumbers.compactMap { $0 } + [setup.opponentLibero].compactMap { $0 }
        if Set(theirs).count != theirs.count { return "Their jersey numbers must all be different." }
        if let failing = Self.templateFailure(setup.system, plain: !advanced) { return failing }
        return nil
    }

    private var templateBadge: String {
        let margin = Self.templateMargin(setup.system)
        return "\(setup.system.displayName) verified" + (margin.map { String(format: " \u{00B7} smallest margin %.2f m", $0) } ?? "")
    }

    private static func validations(_ system: TeamSystem) -> [FormationValidation] {
        guard let profile, let t = try? TemplateLibrary.template(id: system.templateID) else { return [] }
        return TemplateLibrary.validate(t, profile: profile)
    }

    private static func templateFailure(_ system: TeamSystem, plain: Bool) -> String? {
        guard let bad = validations(system).first(where: { !$0.isLegal }), let pair = bad.failing.first else { return nil }
        if plain { return "This system has an overlap in rotation \(bad.rotation) (\(bad.phase))." }
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
                let plays = advanced ? role : PlainWords.role(role).lowercased()
                out.append("#\(slot.jersey) is listed as \(player.role.label.lowercased()) but plays \(plays) here.")
            }
        }
        return out
    }
}

/// Optional opponent numbers by position, their libero and where their setter starts (Advanced).
struct OpponentLineupSheet: View {
    @Binding var setup: MatchSetupData
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(0..<6, id: \.self) { i in
                        LabeledContent("P\(i + 1)") {
                            TextField("\u{2014}", value: Binding(get: { setup.opponentNumbers[i] }, set: { setup.opponentNumbers[i] = $0 }),
                                      format: .number)
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 80)
                        }
                    }
                    LabeledContent("Libero") {
                        TextField("\u{2014}", value: $setup.opponentLibero, format: .number)
                            .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 80)
                    }
                } header: {
                    Text("Their numbers by position")
                } footer: {
                    Text("All optional. Leave a number empty if you don't know it.")
                }
                Section("Their setter starts in") {
                    Picker("Setter position", selection: $setup.opponentSetterPosition) {
                        ForEach(1...6, id: \.self) { Text("P\($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
            .font(.scaled(.body))
            .navigationTitle("Their lineup")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
