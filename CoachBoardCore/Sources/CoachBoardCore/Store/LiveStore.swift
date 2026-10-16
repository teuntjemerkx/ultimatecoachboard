import Foundation

public enum CoachMode: String, Codable, Sendable, Hashable {
    case solo
    case advanced
}

public enum LiveContext: Codable, Hashable, Sendable {
    case live
    case panicTimeOut(startedAt: Double)
    case setBreak
    case matchOver
}

/// Ink drawn on the board, stored in court metres so it survives 2D/3D and replay.
public struct InkStroke: Codable, Hashable, Sendable {
    public var points: [FloorPoint]
    public var width: Double

    public init(points: [FloorPoint], width: Double = 0.06) {
        self.points = points
        self.width = width
    }
}

public enum HapticPattern: String, Sendable, Hashable {
    case originAccepted, landingAccepted, rejected, point, sideOut, overlapWarning, overlapFault, panic, undo
}

public enum LiveEffect: Hashable, Sendable {
    case haptic(HapticPattern)
    /// Append a record; the record's sequence number equals `LiveState.nextSeq` before the event.
    case journal(JournalRecordType, Data)
    /// Commit the journal group now (rally ends, time-outs, match end).
    case commitJournal
}

public enum LiveEvent: Sendable {
    case pointSwipe(winner: Side)
    case scoutTap(side: Side, point: LocalPoint, time: Double)
    case tick(time: Double)
    case panicPressed(time: Double)
    case panicDone
    case ink(InkStroke)
    case moveToken(side: Side, position: CourtPosition, to: LocalPoint)
    case resetTokens
    case substitution(side: Side, outgoing: PlayerID, incoming: PlayerID)
    case toggleMode
    case undo
    case redo
    case startNextSet(firstServer: Side?)
    case correctRotation(side: Side, setterPosition: CourtPosition?, serving: Side?)
}

/// A token as drawn on the board.
public struct BoardToken: Hashable, Sendable {
    public var side: Side
    public var position: CourtPosition
    public var player: PlayerID
    public var role: String
    public var point: LocalPoint
    public var isServer: Bool
    public var isLibero: Bool
}

/// Undoable actions, kept in order; derived state is rebuilt from the active ones (exact undo).
public enum LiveAction: Codable, Hashable, Sendable {
    case rally(Side)
    case substitution(Side, PlayerID, PlayerID)
    case scout(ScoutLine)
    case ink(InkStroke)
    case nextSet(Side?)
    case rotationCorrection(Side, CourtPosition?, Side?)
}

public struct LoggedAction: Codable, Hashable, Sendable {
    public var seq: UInt64
    public var action: LiveAction
    public var active: Bool
}

/// The single source of truth for the Live screens; a pure reducer (blueprint Section 2.2).
public struct LiveState: Sendable {
    public let setup: MatchStartedPayload
    public let profile: RuleCourtProfile
    public let template: RotationTemplate
    public private(set) var mode: CoachMode
    public private(set) var context: LiveContext = .live
    public private(set) var match: MatchState
    public private(set) var scout = MicroScout()
    public private(set) var scoutLines: [ScoutLine] = []
    public private(set) var ink: [InkStroke] = []
    public private(set) var log: [LoggedAction] = []
    public private(set) var redoStack: [UInt64] = []
    public private(set) var overrides: [Side: [CourtPosition: LocalPoint]] = [:]
    public private(set) var nextSeq: UInt64

    public init(setup: MatchStartedPayload, profile: RuleCourtProfile, template: RotationTemplate, nextSeq: UInt64 = 2) {
        self.setup = setup
        self.profile = profile
        self.template = template
        self.mode = setup.mode
        self.match = MatchState(profile: profile, home: setup.home, opponent: setup.opponent, firstServer: setup.firstServer)
        self.nextSeq = nextSeq
    }

    // MARK: - Reducer

    public mutating func reduce(_ event: LiveEvent) -> [LiveEffect] {
        switch event {
        case .pointSwipe(let winner):
            guard context == .live, !match.isOver, match.current.winner == nil else { return [.haptic(.rejected)] }
            var probe = match
            guard let outcome = try? probe.applyRally(winner: winner) else { return [.haptic(.rejected)] }
            var effects = record(.rally(winner), type: .rallyWon, payload: RallyWonPayload(winner: winner))
            rebuild()
            overrides = [:]
            if outcome.matchEnded {
                effects += record(nil, type: .matchEnded,
                                  payload: MatchEndedPayload(setsHome: match.setsWonHome, setsOpponent: match.setsWonOpponent))
            }
            effects.append(.haptic(outcome.sideOut ? .sideOut : .point))
            effects.append(.commitJournal)
            return effects

        case .scoutTap(let side, let point, let time):
            guard context == .live else { return [] }
            let ctx = scoutContext()
            switch scout.tap(on: side, at: point, time: time, context: ctx) {
            case .originAccepted, .originReplaced:
                return [.haptic(.originAccepted)]
            case .committed(let line):
                var effects = record(.scout(line), type: .scoutLine, payload: line)
                rebuild()
                effects.append(.haptic(.landingAccepted))
                return effects
            case .rejected, .expired:
                return [.haptic(.rejected)]
            }

        case .tick(let time):
            return scout.tick(now: time) ? [.haptic(.rejected)] : []

        case .panicPressed(let time):
            guard context == .live else { return [] }
            context = .panicTimeOut(startedAt: time)
            scout.cancel()
            return record(nil, type: .timeOutStarted, payload: TimeOutPayload(side: .home))
                + [.haptic(.panic), .commitJournal]

        case .panicDone:
            guard case .panicTimeOut = context else { return [] }
            context = match.isOver ? .matchOver : (match.current.winner != nil ? .setBreak : .live)
            return record(nil, type: .timeOutEnded, payload: TimeOutPayload(side: .home)) + [.commitJournal]

        case .ink(let stroke):
            let effects = record(.ink(stroke), type: .sketchStrokes, payload: SketchStrokesPayload(strokes: [stroke]))
            rebuild()
            return effects

        case .moveToken(let side, let position, let to):
            overrides[side, default: [:]][position] = to
            let results = currentConstraints(side)
            if results.contains(where: { !$0.isLegal }) { return [.haptic(.overlapFault)] }
            if results.contains(where: { $0.margin < 0.25 }) { return [.haptic(.overlapWarning)] }
            return []

        case .resetTokens:
            overrides = [:]
            return []

        case .substitution(let side, let outgoing, let incoming):
            var probe = match
            guard (try? probe.substitute(side: side, outgoing: outgoing, incoming: incoming)) != nil else {
                return [.haptic(.rejected)]
            }
            let effects = record(.substitution(side, outgoing, incoming), type: .substitution,
                                 payload: SubstitutionPayload(side: side, outgoing: outgoing, incoming: incoming))
            rebuild()
            return effects + [.commitJournal]

        case .toggleMode:
            mode = mode == .solo ? .advanced : .solo
            return record(nil, type: .modeChanged, payload: ModeChangedPayload(mode: mode))

        case .undo:
            guard let index = log.lastIndex(where: { $0.active }) else { return [.haptic(.rejected)] }
            log[index].active = false
            redoStack.append(log[index].seq)
            let effects = record(nil, type: .undo, payload: SeqPayload(seq: log[index].seq))
            rebuild()
            return effects + [.haptic(.undo), .commitJournal]

        case .redo:
            guard let seq = redoStack.popLast(), let index = log.firstIndex(where: { $0.seq == seq }) else {
                return [.haptic(.rejected)]
            }
            log[index].active = true
            let effects = record(nil, type: .redo, payload: SeqPayload(seq: seq))
            rebuild()
            return effects + [.commitJournal]

        case .startNextSet(let firstServer):
            guard match.current.winner != nil, !match.isOver else { return [.haptic(.rejected)] }
            let effects = record(.nextSet(firstServer), type: .setStarted, payload: SetStartedPayload(firstServer: firstServer))
            rebuild()
            return effects + [.commitJournal]

        case .correctRotation(let side, let setterPosition, let serving):
            let effects = record(.rotationCorrection(side, setterPosition, serving), type: .rotationCorrection,
                                 payload: RotationCorrectionPayload(side: side, rotations: nil,
                                                                    setterPosition: setterPosition?.rawValue,
                                                                    serving: serving))
            rebuild()
            return effects + [.commitJournal]
        }
    }

    // MARK: - Journal bookkeeping

    private mutating func record<P: Encodable>(_ action: LiveAction?, type: JournalRecordType, payload: P) -> [LiveEffect] {
        let data = (try? JournalPayload.encode(payload)) ?? Data()
        let seq = nextSeq
        nextSeq += 1
        if let action {
            log.append(LoggedAction(seq: seq, action: action, active: true))
            redoStack.removeAll()
        }
        return [.journal(type, data)]
    }

    /// Re-derives match, scouting and ink from the active actions (exact undo and replay).
    private mutating func rebuild() {
        var m = MatchState(profile: profile, home: setup.home, opponent: setup.opponent, firstServer: setup.firstServer)
        var lines: [ScoutLine] = []
        var strokes: [InkStroke] = []
        for entry in log where entry.active {
            switch entry.action {
            case .rally(let winner): _ = try? m.applyRally(winner: winner)
            case .substitution(let side, let o, let i): _ = try? m.substitute(side: side, outgoing: o, incoming: i)
            case .scout(let line): lines.append(line)
            case .ink(let stroke): strokes.append(stroke)
            case .nextSet(let server): _ = try? m.startNextSet(firstServer: server)
            case .rotationCorrection(let side, let pos, let serving):
                m.correctRotation(side: side, setterPosition: pos, rotations: nil, serving: serving)
            }
        }
        match = m
        scoutLines = lines
        ink = strokes
        if case .panicTimeOut = context { return }
        context = m.isOver ? .matchOver : (m.current.winner != nil ? .setBreak : .live)
    }

    // MARK: - Derived board

    /// The template phase for a side: the serving team stands in its serve formation.
    public func phase(for side: Side) -> String { match.current.serving == side ? "serve" : "receive" }

    /// Tokens for both teams: template anchors by position, overridden by any drag in this rally.
    public func tokens() -> [BoardToken] {
        var out: [BoardToken] = []
        for side in Side.allCases {
            let onCourt = match.onCourt(side)
            let sheet = match.sheets[side]
            let formation = template.formation(rotation: match.rotationNumber(side), phase: phase(for: side))
            let anchors = formation?.positions ?? Self.genericAnchors(serving: match.current.serving == side)
            for pos in CourtPosition.allCases {
                guard let id = onCourt[pos] else { continue }
                let isLibero = sheet?.liberos.contains(id) ?? false
                let role = isLibero ? "L" : (sheet?.roles[id] ?? pos.label)
                let point = overrides[side]?[pos] ?? anchors[pos] ?? Self.genericAnchors(serving: false)[pos]!
                out.append(BoardToken(side: side, position: pos, player: id, role: role, point: point,
                                      isServer: pos == .p1 && match.current.serving == side, isLibero: isLibero))
            }
        }
        return out
    }

    /// Legality of a side's current pre-service positions.
    public func currentConstraints(_ side: Side) -> [ConstraintResult] {
        var positions: [CourtPosition: LocalPoint] = [:]
        for t in tokens() where t.side == side { positions[t.position] = t.point }
        let serving = match.current.serving == side
        let checked = serving ? profile.overlap.checkServingTeam : profile.overlap.checkReceivingTeam
        guard checked else { return [] }
        return OverlapEngine.evaluate(positions, serving: serving, serverExempt: profile.overlap.serverExempt,
                                      options: OverlapEngine.Options(profile: profile))
    }

    /// Fallback anchors when no template formation applies.
    public static func genericAnchors(serving: Bool) -> [CourtPosition: LocalPoint] {
        [.p4: LocalPoint(l: 1.5, d: 1.0), .p3: LocalPoint(l: 4.5, d: 1.0), .p2: LocalPoint(l: 7.5, d: 1.0),
         .p5: LocalPoint(l: 1.5, d: 6.5), .p6: LocalPoint(l: 4.5, d: 7.0),
         .p1: serving ? LocalPoint(l: 7.5, d: 10.0) : LocalPoint(l: 7.5, d: 6.5)]
    }

    func scoutContext() -> MicroScout.Context {
        var front: [CourtPosition: String] = [:]
        var back: [CourtPosition: String] = [:]
        let onCourt = match.onCourt(.opponent)
        let sheet = match.sheets[.opponent]
        for (pos, id) in onCourt {
            let role = sheet?.roles[id] ?? ""
            if pos.isFrontRow { front[pos] = role } else { back[pos] = role }
        }
        return MicroScout.Context(setNumber: match.current.number, score: match.current.score,
                                  homeRotation: match.rotationNumber(.home),
                                  opponentRotation: match.rotationNumber(.opponent),
                                  opponentFrontRowRoles: front, opponentBackRowRoles: back)
    }

    // MARK: - Replay

    /// Rebuilds a Live state from journal records (crash recovery, Match Log replay).
    public static func replay(records: [JournalRecord], profile: RuleCourtProfile,
                              template: RotationTemplate) throws -> LiveState? {
        guard let first = records.first, first.knownType == .matchStarted else { return nil }
        let setup = try JournalPayload.decode(MatchStartedPayload.self, from: first.payload)
        var state = LiveState(setup: setup, profile: profile, template: template, nextSeq: first.seq + 1)
        for r in records.dropFirst() {
            state.nextSeq = r.seq
            // A record whose payload cannot be decoded is skipped, never fatal: recovery must not lose a match.
            switch r.knownType {
            case .rallyWon:
                if let p = try? JournalPayload.decode(RallyWonPayload.self, from: r.payload) {
                    state.appendReplayed(.rally(p.winner), seq: r.seq)
                }
            case .scoutLine:
                if let line = try? JournalPayload.decode(ScoutLine.self, from: r.payload) {
                    state.appendReplayed(.scout(line), seq: r.seq)
                }
            case .sketchStrokes:
                if let p = try? JournalPayload.decode(SketchStrokesPayload.self, from: r.payload) {
                    for s in p.strokes { state.appendReplayed(.ink(s), seq: r.seq) }
                }
            case .substitution:
                if let p = try? JournalPayload.decode(SubstitutionPayload.self, from: r.payload) {
                    state.appendReplayed(.substitution(p.side, p.outgoing, p.incoming), seq: r.seq)
                }
            case .setStarted:
                if let p = try? JournalPayload.decode(SetStartedPayload.self, from: r.payload) {
                    state.appendReplayed(.nextSet(p.firstServer), seq: r.seq)
                }
            case .rotationCorrection:
                if let p = try? JournalPayload.decode(RotationCorrectionPayload.self, from: r.payload) {
                    state.appendReplayed(.rotationCorrection(p.side, p.setterPosition.flatMap(CourtPosition.init(rawValue:)), p.serving), seq: r.seq)
                }
            case .undo:
                if let p = try? JournalPayload.decode(SeqPayload.self, from: r.payload),
                   let i = state.log.firstIndex(where: { $0.seq == p.seq }) {
                    state.log[i].active = false
                    state.redoStack.append(p.seq)
                }
            case .redo:
                if let p = try? JournalPayload.decode(SeqPayload.self, from: r.payload),
                   let i = state.log.firstIndex(where: { $0.seq == p.seq }) {
                    state.log[i].active = true
                    state.redoStack.removeAll { $0 == p.seq }
                }
            case .modeChanged:
                if let p = try? JournalPayload.decode(ModeChangedPayload.self, from: r.payload) { state.mode = p.mode }
            default:
                break   // types without derived state (notes, time-outs, view facts) or unknown types
            }
            state.nextSeq = r.seq + 1
        }
        state.rebuild()
        return state
    }

    private mutating func appendReplayed(_ action: LiveAction, seq: UInt64) {
        log.append(LoggedAction(seq: seq, action: action, active: true))
        redoStack.removeAll()
    }
}

public struct SetStartedPayload: Codable, Hashable, Sendable { public var firstServer: Side? }
public struct MatchEndedPayload: Codable, Hashable, Sendable {
    public var setsHome: Int
    public var setsOpponent: Int
}
