import Foundation
import Observation
import QuartzCore
import CoachBoardCore

/// Bridges the pure LiveState reducer to the screen: runs effects (haptics, journal),
/// converts touches to court coordinates and builds the board scene.
@MainActor
@Observable
final class LiveController {
    private(set) var state: LiveState
    private(set) var labels: [PlayerID: String] = [:]
    let homeName: String
    let opponentName: String
    private let journal: JournalPipe?

    // View state
    var homeOnLeft = true
    var playerFacingFlip = false
    var attacksVisible = true
    /// ROUTES on the rail: the home team's routes after the serve, checked against the timing model (Section 2.6).
    var routesVisible = false
    var boardSize: CGSize = .zero
    var geometry: BoardGeometry {
        BoardGeometry(size: boardSize, homeOnLeft: homeOnLeft, playerFacingFlip: playerFacingFlip)
    }
    private(set) var dragging: (side: Side, position: CourtPosition)?
    private(set) var matchupCard: String?
    private(set) var undoChipVisible = false
    private(set) var panicInkStart = 0
    private(set) var scoutArmed = false
    private var undoChipTask: Task<Void, Never>?
    private var scoutTimer: Task<Void, Never>?
    private var cardTask: Task<Void, Never>?

    /// A home position picked up with a long-press: tapping a bench chip substitutes that player (Screen 3).
    private(set) var subTarget: CourtPosition?
    private var subTask: Task<Void, Never>?
    private var dragMoved = false

    /// RING tool: rotation and phase chips; a chosen one previews the template formation with routes.
    var ringOpen = false
    struct RingPreview: Equatable {
        var rotation: Int
        var phase: String
    }
    private(set) var preview: RingPreview?

    /// Advanced Mode: the skill-coding pad around a token (Screen 4).
    struct SkillPadTarget: Equatable {
        var side: Side
        var position: CourtPosition
        var player: PlayerID
        var point: LocalPoint
        var predicted: Skill
    }
    private(set) var skillPad: SkillPadTarget?

    static func now() -> Double { Date().timeIntervalSinceReferenceDate }

    // MARK: - Creation

    init(setup: MatchSetupData) throws {
        let profile = try RuleCourtProfile.fivbSenior()
        let homeTemplate = try TemplateLibrary.template(id: setup.system.templateID)
        let opponentTemplate = try TemplateLibrary.template(id: MatchStartedPayload.defaultOpponentTemplateID)
        var jerseys: [PlayerID: Int] = [:]
        var names: [PlayerID: String] = [:]

        // Home: roster players placed on P1...P6; roles follow from the system's lineup order and the setter's slot.
        var homePlayers: [CourtPosition: PlayerID] = [:]
        for (i, slot) in setup.homeSlots.enumerated() {
            guard let slot, let pos = CourtPosition(rawValue: i + 1) else { throw MatchSetupData.SetupError.incomplete }
            homePlayers[pos] = slot.id
            jerseys[slot.id] = slot.jersey
            if let n = slot.name { names[slot.id] = n }
        }
        if let l = setup.homeLibero {
            jerseys[l.id] = l.jersey
            if let n = l.name { names[l.id] = n }
        }
        let bench = setup.homeBench ?? []
        for b in bench {
            jerseys[b.id] = b.jersey
            if let n = b.name { names[b.id] = n }
        }
        let homeAnchor = setup.system.hasSetter ? (CourtPosition(rawValue: setup.setterPosition) ?? .p1) : .p1
        let home = LineupBuilder.sheet(players: homePlayers, order: homeTemplate.lineupOrder, anchor: homeAnchor,
                                       libero: homeTemplate.libero == nil ? nil : setup.homeLibero?.id,
                                       liberoReplaces: homeTemplate.libero?.replaces ?? [])

        // Opponent: positions with optional numbers; unknown players are labelled by role.
        var opponentPlayers: [CourtPosition: PlayerID] = [:]
        for pos in CourtPosition.allCases {
            let id = UUID()
            opponentPlayers[pos] = id
            if let n = setup.opponentNumbers[pos.rawValue - 1] { jerseys[id] = n }
        }
        let opponentLibero = setup.opponentLibero.map { n -> PlayerID in
            let id = UUID()
            jerseys[id] = n
            return id
        }
        let opponent = LineupBuilder.sheet(players: opponentPlayers, order: opponentTemplate.lineupOrder,
                                           anchor: CourtPosition(rawValue: setup.opponentSetterPosition) ?? .p1,
                                           libero: opponentLibero, liberoReplaces: opponentTemplate.libero?.replaces ?? [])

        let payload = MatchStartedPayload(profileName: profile.name, home: home, opponent: opponent,
                                          firstServer: setup.firstServer, mode: setup.mode, templateID: homeTemplate.id,
                                          homeName: setup.homeName, opponentName: setup.opponentName,
                                          jerseys: jerseys, netHeight: setup.netHeight,
                                          opponentTemplateID: opponentTemplate.id, names: names.isEmpty ? nil : names,
                                          homeBench: bench.map(\.id))
        let matchID = UUID()
        let url = try JournalPipe.journalsDirectory().appendingPathComponent("\(matchID.uuidString).cbj")
        let header = JournalHeader(matchID: matchID,
                                   createdAtNanoseconds: Int64(Date().timeIntervalSince1970 * 1_000_000_000),
                                   profileHash: JournalPipe.profileHash(profile))
        let pipe = try JournalPipe(url: url, header: header)
        pipe.send(.append(.matchStarted, try JournalPayload.encode(payload), Self.wallClock()))
        pipe.send(.commitNow)
        self.homeName = setup.homeName
        self.opponentName = setup.opponentName
        self.journal = pipe
        self.state = LiveState(setup: payload, profile: profile, template: homeTemplate,
                               opponentTemplate: opponentTemplate, nextSeq: pipe.firstFreeSeq + 1)
        self.labels = payload.playerLabels
    }

    /// Resumes a match from its journal after a crash, a kill or a dead battery (Appendix B3 recovery).
    init(resuming url: URL) throws {
        let profile = try RuleCourtProfile.fivbSenior()
        let data = try Data(contentsOf: url)
        let read = try JournalCodec.read(data)
        guard let replayed = try LiveState.replay(records: read.records, profile: profile) else {
            throw JournalError.badHeader
        }
        let pipe = try JournalPipe(url: url, header: read.header)
        self.homeName = replayed.setup.homeName ?? "Home"
        self.opponentName = replayed.setup.opponentName ?? "Opponent"
        self.journal = pipe
        self.state = replayed
        self.labels = replayed.setup.playerLabels
    }

    static func wallClock() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000_000_000) }

    func close() {
        journal?.send(.commitNow)
        journal?.close()
    }

    // MARK: - Events

    private func dispatch(_ event: LiveEvent) {
        for effect in state.reduce(event) {
            switch effect {
            case .haptic(let pattern): Feedback.shared.play(pattern)
            case .journal(let type, let payload): journal?.send(.append(type, payload, Self.wallClock()))
            case .commitJournal: journal?.send(.commitNow)
            }
        }
        if case .originSet = state.scout.state { scoutArmed = true } else { scoutArmed = false }
    }

    private func showUndoChip() {
        undoChipVisible = true
        undoChipTask?.cancel()
        undoChipTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            if !Task.isCancelled { self?.undoChipVisible = false }
        }
    }

    func swipe(winner: Side) {
        dispatch(.pointSwipe(winner: winner))
        showUndoChip()
    }

    func undo() { dispatch(.undo) }

    /// RING tool: snap every token back to the template formation of the current rotation.
    func resetTokens() {
        dragging = nil
        dispatch(.resetTokens)
    }
    func redo() { dispatch(.redo) }

    func toggleMode() { dispatch(.toggleMode) }

    func switchEnds() { homeOnLeft.toggle() }

    func panic() {
        panicInkStart = state.ink.count
        dispatch(.panicPressed(time: Self.now()))
    }

    func panicDone() { dispatch(.panicDone) }

    func clearPanicInk() { panicInkStart = state.ink.count }

    func nextSet(firstServer: Side?, homeStartRotation: Int?) {
        let before = state.match.current.number
        dispatch(.startNextSet(firstServer: firstServer, homeStartRotation: homeStartRotation))
        if state.match.current.number > before { homeOnLeft.toggle() }   // teams change ends between sets
    }

    func correctRotation(side: Side, setterPosition: CourtPosition, serving: Side) {
        dispatch(.correctRotation(side: side, setterPosition: setterPosition, serving: serving))
    }

    // MARK: - Touch

    /// A single tap on the court. An armed scouting origin always takes the tap; otherwise a home token shows its
    /// matchup card (Solo) or opens the skill pad (Advanced, also for a direct hit on an opponent token).
    func tap(at point: CGPoint) {
        let (side, local) = geometry.toLocal(point)
        if case .panicTimeOut = state.context { return }
        if skillPad != nil { skillPad = nil; return }        // a tap elsewhere closes the pad
        subTarget = nil
        if preview != nil { return }                          // the RING preview is read-only
        let armed = scoutArmed
        if !armed {
            if state.mode == .advanced {
                if let token = hitToken(point, side: .home) ?? hitToken(point, side: .opponent, radius: 22) {
                    openSkillPad(for: token)
                    return
                }
            } else if side == .home, let token = hitToken(point, side: .home) {
                showMatchup(for: token)
                return
            }
        }
        let linesBefore = state.scoutLines.count
        dispatch(.scoutTap(side: side, point: local, time: Self.now()))
        if scoutArmed {
            startScoutTimer()
        } else if state.scoutLines.count > linesBefore {
            showUndoChip()
        }
    }

    private func startScoutTimer() {
        scoutTimer?.cancel()
        scoutTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self else { return }
                self.dispatch(.tick(time: Self.now()))
                if !self.scoutArmed { return }
            }
        }
    }

    func dragBegan(at point: CGPoint) -> Bool {
        guard state.context == .live, preview == nil else { return false }
        skillPad = nil
        for side in Side.allCases {
            if let token = hitToken(point, side: side) {
                dragging = (side, token.position)
                dragMoved = false
                if side == .home { armSubstitution(token.position) }
                return true
            }
        }
        return false
    }

    func dragChanged(to point: CGPoint) {
        guard let (side, position) = dragging else { return }
        dragMoved = true
        subTarget = nil                                       // moving means a drag, not a substitution
        let local = CourtFrame.local(geometry.toWorld(point), for: side)
        dispatch(.moveToken(side: side, position: position, to: local))
    }

    func dragEnded() {
        // In Advanced the matchup card moves to the long-press (Screen 4): a long-press without a drag shows it.
        if let (side, position) = dragging, !dragMoved, state.mode == .advanced,
           let token = state.tokens().first(where: { $0.side == side && $0.position == position }) {
            showMatchup(for: token)
        }
        dragging = nil
    }

    // MARK: - Substitutions

    private func armSubstitution(_ position: CourtPosition) {
        subTarget = position
        subTask?.cancel()
        subTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled { self?.subTarget = nil }
        }
    }

    /// Bench chips for the strip: roster substitutes and starters who went off.
    var benchChips: [(id: PlayerID, label: String)] {
        state.homeBench.map { ($0, labels[$0] ?? "?") }
    }

    var subTargetLabel: String? {
        guard let pos = subTarget else { return nil }
        return labels[state.match.current.home.player(at: pos)].map { "#\($0)" } ?? pos.label
    }

    func substitute(with incoming: PlayerID) {
        guard let pos = subTarget else { return }
        let outgoing = state.match.current.home.player(at: pos)
        dispatch(.substitution(side: .home, outgoing: outgoing, incoming: incoming))
        subTarget = nil
        dragging = nil
        showUndoChip()
    }

    // MARK: - RING preview

    func ringTapped() {
        if preview != nil {
            preview = nil
            ringOpen = false
        } else {
            ringOpen.toggle()
        }
    }

    func showPreview(rotation: Int, phase: String) {
        preview = RingPreview(rotation: rotation, phase: phase)
        dragging = nil
        subTarget = nil
        skillPad = nil
    }

    func endPreview() {
        preview = nil
        ringOpen = false
    }

    /// What the board shows: the live state, or the RING preview of another rotation.
    var shownState: LiveState {
        preview.map { state.previewing(homeRotation: $0.rotation, phase: $0.phase) } ?? state
    }

    // MARK: - Advanced Mode: skill coding

    func openSkillPad(for token: BoardToken) {
        let predicted = SkillPredictor.next(side: token.side, isServer: token.isServer, isFrontRow: token.position.isFrontRow,
                                            role: token.role, serving: state.match.current.serving,
                                            codesThisRally: state.codesThisRally)
        skillPad = SkillPadTarget(side: token.side, position: token.position, player: token.player,
                                  point: token.point, predicted: predicted)
    }

    func code(skill: Skill, grade: SkillGrade) {
        guard let pad = skillPad else { return }
        dispatch(.skill(side: pad.side, player: pad.player, skill: skill, grade: grade))
        skillPad = nil
        showUndoChip()
    }

    func closeSkillPad() { skillPad = nil }

    /// The live stat strip (Screen 4): side-out and break rate per home rotation over its last 10 rallies.
    struct RotationCell: Identifiable {
        var id: Int
        var sideOutWon: Int
        var sideOutTotal: Int
        var breakWon: Int
        var breakTotal: Int
    }

    var rotationCells: [RotationCell] {
        (1...6).map { r in
            let recent = state.rallies.filter { $0.homeRotation == r }.suffix(10)
            let receiving = recent.filter { $0.serving == .opponent }
            let serving = recent.filter { $0.serving == .home }
            return RotationCell(id: r, sideOutWon: receiving.filter { $0.winner == .home }.count, sideOutTotal: receiving.count,
                                breakWon: serving.filter { $0.winner == .home }.count, breakTotal: serving.count)
        }
    }

    /// "Set point for Orion" / "Match point for Dynamo" for the status strip, in the ink colour (Screen 3 states).
    var pointBadge: String? {
        for side in Side.allCases {
            if let status = state.match.pointStatus(side) {
                let name = side == .home ? homeName : opponentName
                return (status == .matchPoint ? "Match point for " : "Set point for ") + name
            }
        }
        return nil
    }

    func ink(_ points: [CGPoint]) {
        guard case .panicTimeOut = state.context, points.count > 1 else { return }
        dispatch(.ink(InkStroke(points: points.map { geometry.toWorld($0) })))
    }

    private func hitToken(_ point: CGPoint, side: Side, radius: CGFloat = 40) -> BoardToken? {
        // Voronoi nearest-token resolution within 40 pt (Section 1.5).
        var best: (BoardToken, CGFloat)?
        for t in state.tokens() where t.side == side {
            let p = geometry.toView(t.point, side: side)
            let d = hypot(p.x - point.x, p.y - point.y)
            if d <= radius, d < (best?.1 ?? .infinity) { best = (t, d) }
        }
        return best?.0
    }

    private func showMatchup(for token: BoardToken) {
        let opposite: [CourtPosition: CourtPosition] = [.p4: .p2, .p3: .p3, .p2: .p4]
        let theirPos = opposite[token.position]
        let them = theirPos.flatMap { pos in state.tokens().first(where: { $0.side == .opponent && $0.position == pos }) }
        if ThemeStore.shared.advanced {
            let me = "\(labels[token.player] ?? "?") \(token.role) \u{00B7} \(token.position.label)"
            if let theirPos, let them {
                matchupCard = "\(me) faces \(labels[them.player] ?? "?") \(them.role) (their \(theirPos.label))"
            } else {
                matchupCard = "\(me) \u{00B7} back row"
            }
        } else if let them {
            matchupCard = "\(plainName(token)) faces \(plainName(them))"
        } else {
            matchupCard = "\(plainName(token)) is in the back row"
        }
        cardTask?.cancel()
        cardTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { self?.matchupCard = nil }
        }
    }

    /// "#8 (Outside 1)" for the Simple matchup card, or the role alone when the number is unknown.
    private func plainName(_ token: BoardToken) -> String {
        let role = PlainWords.role(token.role)
        guard let label = labels[token.player], Int(label) != nil else { return role }
        return "#\(label) (\(role))"
    }

    // MARK: - Board scene

    var boardScene: BoardScene {
        var scene = BoardScene()
        let shown = shownState
        let tokens = shown.tokens()
        for t in tokens {
            let selected = dragging.map { $0.side == t.side && $0.position == t.position } ?? false
            let padOpen = skillPad.map { $0.side == t.side && $0.position == t.position } ?? false
            scene.tokens.append(.init(id: t.player, side: t.side, point: CourtFrame.world(t.point, of: t.side),
                                      label: labels[t.player] ?? t.role, isLibero: t.isLibero, isServer: t.isServer,
                                      selected: selected || padOpen || (t.side == .home && t.position == subTarget)))
        }
        if (routesVisible || preview != nil) && state.context == .live {
            scene.routes = routePlan(for: shown).map { BoardScene.Route(a: CourtFrame.world($0.from, of: .home),
                                                                        b: CourtFrame.world($0.to, of: .home), late: $0.late) }
        }
        if attacksVisible {
            let lines = state.scoutLines.suffix(6)
            for (i, line) in lines.enumerated() {
                let opacity = i == lines.count - 1 ? 1.0 : 0.4
                scene.scoutLines.append((CourtFrame.world(line.originRaw, of: .opponent),
                                         CourtFrame.world(line.landingRaw, of: .home), opacity))
            }
        }
        if state.context == .live {
            for side in Side.allCases {
                for c in shown.currentConstraints(side) where c.margin < 0.25 {
                    var boundary: (FloorPoint, FloorPoint)?
                    if c.margin <= 0 {
                        let a: LocalPoint
                        let b: LocalPoint
                        switch c.kind {
                        case .frontBack:
                            a = LocalPoint(l: c.witnessB.l - 0.6, d: c.witnessA.d)
                            b = LocalPoint(l: c.witnessB.l + 0.6, d: c.witnessA.d)
                        case .leftCentre, .rightCentre:
                            a = LocalPoint(l: c.witnessB.l, d: c.witnessA.d - 0.6)
                            b = LocalPoint(l: c.witnessB.l, d: c.witnessA.d + 0.6)
                        }
                        boundary = (CourtFrame.world(a, of: side), CourtFrame.world(b, of: side))
                    }
                    scene.tethers.append(.init(a: CourtFrame.world(c.witnessA, of: side),
                                               b: CourtFrame.world(c.witnessB, of: side),
                                               margin: c.margin, boundary: boundary))
                }
            }
            if let (side, position) = dragging {
                var positions: [CourtPosition: LocalPoint] = [:]
                for t in tokens where t.side == side { positions[t.position] = t.point }
                let env = LegalEnvelope.compute(for: position, positions: positions,
                                                serving: state.match.current.serving == side, profile: state.profile)
                if !env.isEmpty {
                    scene.envelope = (CourtFrame.world(LocalPoint(l: max(env.lMin, -1), d: max(env.dMin, 0)), of: side),
                                      CourtFrame.world(LocalPoint(l: min(env.lMax, 10), d: min(env.dMax, 9)), of: side))
                }
            }
        }
        if case .panicTimeOut = state.context {
            scene.ink = state.ink.dropFirst(panicInkStart).map(\.points)
        }
        return scene
    }

    // MARK: - Routes

    struct PlannedRoute: Identifiable {
        var id: CourtPosition
        var from: LocalPoint
        var to: LocalPoint
        var late: Bool
        var slack: Double?
    }

    /// The home team's routes from where its players stand now: receive routes with their timing, or the
    /// serving team's switches to base. Dragging a token re-times its route at once.
    var routePlan: [PlannedRoute] { routePlan(for: shownState) }

    func routePlan(for state: LiveState) -> [PlannedRoute] {
        let template = state.template
        let phase = state.phase(for: .home)
        guard var formation = template.formation(for: state.match, side: .home, phase: phase) else { return [] }
        var current: [CourtPosition: LocalPoint] = [:]
        for t in state.tokens() where t.side == .home { current[t.position] = t.point }
        for i in formation.players.indices {
            if let pos = formation.players[i].courtPosition, let p = current[pos] { formation.players[i].anchor = [p.l, p.d] }
        }
        if phase == "receive" {
            let checks = RouteTiming.check(formation, targets: template.routeTargets)
            return checks.compactMap { c in
                guard let pos = CourtPosition(rawValue: c.position), let from = current[pos],
                      let dest = template.routeTargets[c.route] else { return nil }
                return PlannedRoute(id: pos, from: from, to: LocalPoint(dest), late: c.isLate, slack: c.slack)
            }
        }
        return formation.players.compactMap { p in
            guard let pos = p.courtPosition, let from = current[pos], let to = p.switchTo, to.count == 2 else { return nil }
            return PlannedRoute(id: pos, from: from, to: LocalPoint(to), late: false, slack: nil)
        }
    }

    // MARK: - Status

    var score: Score { state.match.current.score }
    var setNumber: Int { state.match.current.number }
    var serving: Side { state.match.current.serving }
    var serverLabel: String {
        let id = state.match.onCourt(serving)[.p1]
        return id.flatMap { labels[$0] } ?? "?"
    }
    var homeRotation: Int { state.match.rotationNumber(.home) }
    var opponentRotation: Int { state.match.rotationNumber(.opponent) }
    var substitutionsUsed: Int { state.match.current.home.substitutionsUsed }

    var panicSecondsRemaining: Double? {
        guard case let .panicTimeOut(startedAt) = state.context else { return nil }
        return max(0, Double(state.profile.timeOuts.seconds) - (Self.now() - startedAt))
    }

    var scoutSummaryLines: [String] {
        let summary = ScoutSummary(lines: state.scoutLines.filter { $0.setNumber == setNumber })
        return summary.total.keys.sorted { ($0.opponentRotation, $0.lane.rawValue) < ($1.opponentRotation, $1.lane.rawValue) }.map { key in
            let dirs = summary.counts[key, default: [:]]
            let total = summary.total[key] ?? 0
            let parts = AttackDirection.allCasesOrdered.compactMap { d in dirs[d].map { "\($0) \(d.rawValue)" } }
            return "R\(key.opponentRotation) \(key.lane.rawValue): \(total) attack\(total == 1 ? "" : "s") \u{2014} " + parts.joined(separator: ", ")
                + ((summary.deep[key] ?? 0) > 0 ? ", \(summary.deep[key]!) deep" : "")
        }
    }
}

extension AttackDirection {
    static let allCasesOrdered: [AttackDirection] = [.line, .cross, .cut]
}
