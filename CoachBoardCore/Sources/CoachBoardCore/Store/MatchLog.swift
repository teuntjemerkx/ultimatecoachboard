import Foundation

/// One rally with the facts from just before it was played (score, server, rotations).
public struct RallyRecord: Hashable, Sendable, Identifiable {
    /// Sequence number of the RallyWon record.
    public var seq: UInt64
    public var setNumber: Int
    public var scoreBefore: Score
    public var serving: Side
    public var homeRotation: Int
    public var opponentRotation: Int
    public var winner: Side
    public var server: PlayerID?

    public var id: UInt64 { seq }
    /// The receiving team won the rally and takes the serve.
    public var sideOut: Bool { winner != serving }

    public var scoreAfter: Score {
        var s = scoreBefore
        s[winner] += 1
        return s
    }

    public func rotation(of side: Side) -> Int { side == .home ? homeRotation : opponentRotation }
}

/// A team's record in one rotation: side-out (receiving) and break (serving) rallies.
public struct RotationRecord: Hashable, Sendable, Identifiable {
    public var rotation: Int
    public var receiveWon = 0
    public var receiveLost = 0
    public var serveWon = 0
    public var serveLost = 0

    public var id: Int { rotation }
    public var receiveTotal: Int { receiveWon + receiveLost }
    public var serveTotal: Int { serveWon + serveLost }
    public var sideOutRate: Double? { receiveTotal == 0 ? nil : Double(receiveWon) / Double(receiveTotal) }
}

public enum RotationStats {
    /// Records for R1 to R6 of one team, over one set or (with `setNumber` nil) the whole match.
    public static func records(_ rallies: [RallyRecord], side: Side, setNumber: Int? = nil) -> [RotationRecord] {
        var out = (1...6).map { RotationRecord(rotation: $0) }
        for r in rallies where setNumber == nil || r.setNumber == setNumber {
            let i = r.rotation(of: side) - 1
            guard out.indices.contains(i) else { continue }
            let won = r.winner == side
            if r.serving == side {
                if won { out[i].serveWon += 1 } else { out[i].serveLost += 1 }
            } else {
                if won { out[i].receiveWon += 1 } else { out[i].receiveLost += 1 }
            }
        }
        return out
    }

    /// The suggested starting rotation for the next set (Appendix C2, Screen 6): the best side-out record;
    /// ties go to the rotation with more receptions, then to the lower rotation number. Nil without receptions.
    public static func suggestedStart(_ records: [RotationRecord]) -> RotationRecord? {
        records.filter { $0.receiveTotal > 0 }.min { a, b in
            let ra = a.sideOutRate ?? 0, rb = b.sideOutRate ?? 0
            if ra != rb { return ra > rb }
            if a.receiveTotal != b.receiveTotal { return a.receiveTotal > b.receiveTotal }
            return a.rotation < b.rotation
        }
    }
}

/// A Match Log row (Appendix C2, Screen 7): a rally and what happened since the previous one.
public struct MatchLogRow: Hashable, Sendable, Identifiable {
    public var rally: RallyRecord
    public var scoutLines = 0
    public var sketchStrokes = 0
    public var substitutions = 0
    public var timeOuts = 0
    public var notes: [String] = []

    public var id: UInt64 { rally.seq }

    public init(rally: RallyRecord) { self.rally = rally }
}

public enum MatchLog {
    /// Rows for every active rally, with scouting, sketches, substitutions and time-outs attached to the
    /// rally they preceded, and notes attached to the rally they name.
    public static func rows(state: LiveState, records: [JournalRecord]) -> [MatchLogRow] {
        var rows: [MatchLogRow] = []
        var bySeq: [UInt64: RallyRecord] = [:]
        for r in state.rallies { bySeq[r.seq] = r }
        var pending = MatchLogRow(rally: RallyRecord(seq: 0, setNumber: 0, scoreBefore: Score(), serving: .home,
                                                     homeRotation: 1, opponentRotation: 1, winner: .home))
        for entry in state.log where entry.active {
            switch entry.action {
            case .rally:
                guard let rally = bySeq[entry.seq] else { continue }
                var row = pending
                row.rally = rally
                rows.append(row)
                pending = MatchLogRow(rally: rally)
            case .scout: pending.scoutLines += 1
            case .ink: pending.sketchStrokes += 1
            case .substitution: pending.substitutions += 1
            case .nextSet, .rotationCorrection: break
            }
        }
        for r in records {
            switch r.knownType {
            case .timeOutStarted:
                if let i = rows.firstIndex(where: { $0.rally.seq > r.seq }) { rows[i].timeOuts += 1 }
            case .note:
                guard let note = try? JournalPayload.decode(NotePayload.self, from: r.payload) else { continue }
                if let seq = note.afterSeq, let i = rows.firstIndex(where: { $0.rally.seq == seq }) {
                    rows[i].notes.append(note.text)
                } else if !rows.isEmpty {
                    rows[rows.count - 1].notes.append(note.text)
                }
            default:
                break
            }
        }
        return rows
    }
}
