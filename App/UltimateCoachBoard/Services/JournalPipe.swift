import Foundation
import CryptoKit
import CoachBoardCore

/// Ordered, durable journaling off the main thread (Appendix B3): records flow through one AsyncStream
/// into one actor, so their order on disk is exactly the order the reducer emitted them.
final class JournalPipe {
    enum Command: Sendable {
        case append(JournalRecordType, Data, Int64)
        case commitNow
    }

    private let continuation: AsyncStream<Command>.Continuation
    private let consumer: Task<Void, Never>
    let url: URL
    let firstFreeSeq: UInt64

    init(url: URL, header: JournalHeader) throws {
        let store = try JournalStore(url: url, header: header)
        self.url = url
        self.firstFreeSeq = store.nextSeqAtOpen
        let (stream, continuation) = AsyncStream.makeStream(of: Command.self)
        self.continuation = continuation
        consumer = Task.detached(priority: .userInitiated) {
            for await command in stream { await store.handle(command) }
            await store.flush()
        }
    }

    func send(_ command: Command) { continuation.yield(command) }

    func close() { continuation.finish() }

    static func journalsDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Journals", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func profileHash(_ profile: RuleCourtProfile) -> [UInt8] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys          // deterministic: dictionary key order is not stable otherwise
        let data = (try? encoder.encode(profile)) ?? Data()
        return Array(SHA256.hash(data: data))
    }
}

private actor JournalStore {
    private let writer: JournalWriter
    private var pendingCommit: Task<Void, Never>?
    nonisolated let nextSeqAtOpen: UInt64

    init(url: URL, header: JournalHeader) throws {
        let w = try JournalWriter(url: url, header: header)
        writer = w
        nextSeqAtOpen = w.nextSeq
    }

    func handle(_ command: JournalPipe.Command) {
        switch command {
        case let .append(type, payload, wallClock):
            writer.append(type: type, payload: payload, wallClock: wallClock)
            scheduleCommit()
        case .commitNow:
            flush()
        }
    }

    /// Group commit every 250 ms.
    private func scheduleCommit() {
        guard pendingCommit == nil else { return }
        pendingCommit = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            self.flush()
        }
    }

    func flush() {
        try? writer.commit()
        pendingCommit = nil
    }
}
