import Foundation
import Observation
import QuartzCore
import CoachBoardCore

/// Everything Match Setup collects (Screen 2), saved for Quick Match.
struct MatchSetupData: Codable, Equatable {
    var homeName = "Home"
    var opponentName = "Opponent"
    /// Jersey numbers in template lineup order: S, OH1, MB1, OPP, OH2, MB2.
    var homeNumbers: [Int] = [1, 2, 3, 4, 5, 6]
    var homeLibero: Int? = 7
    var opponentNumbers: [Int?] = [nil, nil, nil, nil, nil, nil]
    var opponentLibero: Int?
    /// Starting rotation named by the setter's position (R1 = setter in P1).
    var homeStartRotation = 1
    var opponentStartRotation = 1
    var firstServer: Side = .home
    var mode: CoachMode = .solo
    var netHeight = 2.43

    static let roleOrder = ["S", "OH1", "MB1", "OPP", "OH2", "MB2"]
}

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

    static func now() -> Double { Date().timeIntervalSinceReferenceDate }

    // MARK: - Creation

    init(setup: MatchSetupData) throws {
        let profile = try RuleCourtProfile.fivbSenior()
        let template = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        func sheet(numbers: [Int?], libero: Int?, start: Int, labels: inout [PlayerID: String], jerseys: inout [PlayerID: Int]) -> TeamSheet {
            let ids = (0..<6).map { _ in UUID() }
            var roles: [PlayerID: String] = [:]
            for (i, id) in ids.enumerated() {
                roles[id] = MatchSetupData.roleOrder[i]
                if let n = numbers[i] { labels[id] = String(n); jerseys[id] = n } else { labels[id] = MatchSetupData.roleOrder[i] }
            }
            // P_i holds order[(i - R) mod 6] when the setter starts in P_R.
            let lineup = (1...6).map { i in ids[((i - start) % 6 + 6) % 6] }
            var liberos: [PlayerID] = []
            if let libero {
                let liberoID = UUID()
                liberos.append(liberoID)
                roles[liberoID] = "L"
                labels[liberoID] = String(libero)
                jerseys[liberoID] = libero
            }
            return TeamSheet(startingLineup: lineup, roles: roles, liberos: liberos,
                             liberoPartners: liberos.isEmpty ? [] : [ids[2], ids[5]])
        }
        var labels: [PlayerID: String] = [:]
        var jerseys: [PlayerID: Int] = [:]
        let home = sheet(numbers: setup.homeNumbers.map { Optional($0) }, libero: setup.homeLibero,
                         start: setup.homeStartRotation, labels: &labels, jerseys: &jerseys)
        let opponent = sheet(numbers: setup.opponentNumbers, libero: setup.opponentLibero,
                             start: setup.opponentStartRotation, labels: &labels, jerseys: &jerseys)
        let payload = MatchStartedPayload(profileName: profile.name, home: home, opponent: opponent,
                                          firstServer: setup.firstServer, mode: setup.mode, templateID: template.id,
                                          homeName: setup.homeName, opponentName: setup.opponentName,
                                          jerseys: jerseys, netHeight: setup.netHeight)
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
        self.state = LiveState(setup: payload, profile: profile, template: template, nextSeq: pipe.firstFreeSeq + 1)
        self.labels = labels
    }

    /// Resumes a match from its journal after a crash, a kill or a dead battery (Appendix B3 recovery).
    init(resuming url: URL) throws {
        let profile = try RuleCourtProfile.fivbSenior()
        let template = try TemplateLibrary.shipped("5-1-outside-follows-setter")
        let data = try Data(contentsOf: url)
        let read = try JournalCodec.read(data)
        guard let replayed = try LiveState.replay(records: read.records, profile: profile, template: template) else {
            throw JournalError.badHeader
        }
        let pipe = try JournalPipe(url: url, header: read.header)
        var labels: [PlayerID: String] = [:]
        for side in Side.allCases {
            guard let sheet = replayed.match.sheets[side] else { continue }
            for (id, role) in sheet.roles { labels[id] = replayed.setup.jerseys?[id].map { String($0) } ?? role }
        }
        self.homeName = replayed.setup.homeName ?? "Home"
        self.opponentName = replayed.setup.opponentName ?? "Opponent"
        self.journal = pipe
        self.state = replayed
        self.labels = labels
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

    func nextSet(firstServer: Side?) {
        let before = state.match.current.number
        dispatch(.startNextSet(firstServer: firstServer))
        if state.match.current.number > before { homeOnLeft.toggle() }   // teams change ends between sets
    }

    func correctRotation(side: Side, setterPosition: CourtPosition, serving: Side) {
        dispatch(.correctRotation(side: side, setterPosition: setterPosition, serving: serving))
    }

    // MARK: - Touch

    /// A single tap on the court: Micro-Scouting first; otherwise a home token shows its matchup card.
    func tap(at point: CGPoint) {
        let (side, local) = geometry.toLocal(point)
        if case .panicTimeOut = state.context { return }
        let armed = scoutArmed
        if side == .home && !armed, let token = hitToken(point, side: .home) {
            showMatchup(for: token)
            return
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
        guard state.context == .live else { return false }
        for side in Side.allCases {
            if let token = hitToken(point, side: side) {
                dragging = (side, token.position)
                return true
            }
        }
        return false
    }

    func dragChanged(to point: CGPoint) {
        guard let (side, position) = dragging else { return }
        let local = CourtFrame.local(geometry.toWorld(point), for: side)
        dispatch(.moveToken(side: side, position: position, to: local))
    }

    func dragEnded() { dragging = nil }

    func ink(_ points: [CGPoint]) {
        guard case .panicTimeOut = state.context, points.count > 1 else { return }
        dispatch(.ink(InkStroke(points: points.map { geometry.toWorld($0) })))
    }

    private func hitToken(_ point: CGPoint, side: Side) -> BoardToken? {
        // Voronoi nearest-token resolution within 40 pt (Section 1.5).
        var best: (BoardToken, CGFloat)?
        for t in state.tokens() where t.side == side {
            let p = geometry.toView(t.point, side: side)
            let d = hypot(p.x - point.x, p.y - point.y)
            if d <= 40, d < (best?.1 ?? .infinity) { best = (t, d) }
        }
        return best?.0
    }

    private func showMatchup(for token: BoardToken) {
        let me = "\(labels[token.player] ?? "?") \(token.role) \u{00B7} \(token.position.label)"
        let opposite: [CourtPosition: CourtPosition] = [.p4: .p2, .p3: .p3, .p2: .p4]
        if let theirPos = opposite[token.position],
           let them = state.tokens().first(where: { $0.side == .opponent && $0.position == theirPos }) {
            matchupCard = "\(me) faces \(labels[them.player] ?? "?") \(them.role) (their \(theirPos.label))"
        } else {
            matchupCard = "\(me) \u{00B7} back row"
        }
        cardTask?.cancel()
        cardTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { self?.matchupCard = nil }
        }
    }

    // MARK: - Board scene

    var boardScene: BoardScene {
        var scene = BoardScene()
        let tokens = state.tokens()
        for t in tokens {
            scene.tokens.append(.init(id: t.player, side: t.side, point: CourtFrame.world(t.point, of: t.side),
                                      label: labels[t.player] ?? t.role, isLibero: t.isLibero, isServer: t.isServer,
                                      selected: dragging.map { $0.side == t.side && $0.position == t.position } ?? false))
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
                for c in state.currentConstraints(side) where c.margin < 0.25 {
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
