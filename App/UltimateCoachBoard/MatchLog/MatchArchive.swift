import Foundation
import CoachBoardCore

/// One saved match, as listed on the launcher's recents strip.
struct MatchSummary: Identifiable, Hashable, Sendable {
    var id: UUID
    var url: URL
    var date: Date
    var homeName: String
    var opponentName: String
    var setScores: [Score]
    var setsHome: Int
    var setsOpponent: Int
    var rallies: Int
    var finished: Bool

    var title: String { "\(homeName) – \(opponentName)" }
    var scoreLine: String { setScores.map { "\($0.home)–\($0.opponent)" }.joined(separator: "  ") }
}

/// The match journals on disk (Appendix B3): listing, loading, notes, deletion.
enum MatchArchive {
    static func journals() -> [URL] {
        guard let dir = try? JournalPipe.journalsDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension == "cbj" }
    }

    /// Every readable journal, newest first. Each journal is replayed, so the summary is exactly what the log shows.
    static func list() -> [MatchSummary] {
        guard let profile = try? RuleCourtProfile.fivbSenior() else { return [] }
        var out: [MatchSummary] = []
        for url in journals() {
            guard let data = try? Data(contentsOf: url), let read = try? JournalCodec.read(data),
                  let state = try? LiveState.replay(records: read.records, profile: profile) else { continue }
            let match = state.match
            let sets = match.sets.filter { $0.score.home + $0.score.opponent > 0 || $0.number == 1 }
            out.append(MatchSummary(
                id: read.header.matchID, url: url,
                date: Date(timeIntervalSince1970: Double(read.header.createdAtNanoseconds) / 1_000_000_000),
                homeName: state.setup.homeName ?? "Home", opponentName: state.setup.opponentName ?? "Opponent",
                setScores: sets.map(\.score), setsHome: match.setsWonHome, setsOpponent: match.setsWonOpponent,
                rallies: state.rallies.count, finished: match.isOver))
        }
        return out.sorted { $0.date > $1.date }
    }

    static func load(_ url: URL) throws -> (state: LiveState, records: [JournalRecord]) {
        let read = try JournalCodec.read(Data(contentsOf: url))
        guard let state = try LiveState.replay(records: read.records, profile: try RuleCourtProfile.fivbSenior()) else {
            throw JournalError.badHeader
        }
        return (state, read.records)
    }

    /// Appends a Note record (type 0x000F) to a journal and commits it.
    static func appendNote(to url: URL, afterSeq: UInt64?, text: String) throws {
        let read = try JournalCodec.read(Data(contentsOf: url))
        let writer = try JournalWriter(url: url, header: read.header)
        writer.append(type: .note, payload: try JournalPayload.encode(NotePayload(afterSeq: afterSeq, text: text)),
                      wallClock: Int64(Date().timeIntervalSince1970 * 1_000_000_000))
        try writer.commit()
    }

    /// Moves a journal to Recently Deleted; files there older than 30 days are removed.
    static func moveToDeleted(_ url: URL) throws {
        let dir = try JournalPipe.journalsDirectory().appendingPathComponent("Recently Deleted", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: url, to: target)
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path)
        purgeDeleted(in: dir)
    }

    private static func purgeDeleted(in dir: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        for f in files {
            let modified = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            if modified < cutoff { try? fm.removeItem(at: f) }
        }
    }
}
