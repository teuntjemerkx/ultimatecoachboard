import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// CRC-32C (Castagnoli), reflected polynomial 0x82F63B78.
public enum CRC32C {
    static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0x82F6_3B78 : c >> 1 }
        return c
    }

    public static func checksum<C: Collection>(_ bytes: C) -> UInt32 where C.Element == UInt8 {
        var crc: UInt32 = 0xFFFF_FFFF
        for b in bytes { crc = table[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFF_FFFF
    }
}

/// Journal record types (Appendix B3). Values are never reused.
public enum JournalRecordType: UInt16, Codable, Sendable {
    case matchStarted = 0x0001
    case rallyWon = 0x0002
    case undo = 0x0003
    case redo = 0x0004
    case substitution = 0x0005
    case liberoOverride = 0x0006
    case timeOutStarted = 0x0007
    case timeOutEnded = 0x0008
    case sketchStrokes = 0x0009
    case scoutLine = 0x000A
    case tokenMoved = 0x000B
    case modeChanged = 0x000C
    case skillCode = 0x000D
    case switchEnds = 0x000E
    case note = 0x000F
    case checkpoint = 0x0010
    case matchEnded = 0x0011
    case rotationCorrection = 0x0012
    case setStarted = 0x0013
}

public struct JournalRecord: Hashable, Sendable {
    public var type: UInt16
    public var origin: UInt16
    public var seq: UInt64
    public var lamport: UInt64
    public var wallClock: Int64
    public var payload: Data

    public init(type: UInt16, origin: UInt16 = 0, seq: UInt64, lamport: UInt64, wallClock: Int64, payload: Data) {
        self.type = type
        self.origin = origin
        self.seq = seq
        self.lamport = lamport
        self.wallClock = wallClock
        self.payload = payload
    }

    public var knownType: JournalRecordType? { JournalRecordType(rawValue: type) }

    /// Body = type ... end of payload; the CRC covers exactly these bytes.
    func encoded() -> Data {
        var body = Data()
        body.appendLE(type)
        body.appendLE(origin)
        body.appendLE(seq)
        body.appendLE(lamport)
        body.appendLE(UInt64(bitPattern: wallClock))
        body.append(payload)
        var out = Data()
        out.appendLE(UInt32(body.count))
        out.append(body)
        out.appendLE(CRC32C.checksum(body))
        return out
    }
}

public struct JournalHeader: Hashable, Sendable {
    public static let size = 64
    public static let magic: [UInt8] = Array("CBJ1".utf8)
    public var version: UInt16 = 1
    public var flags: UInt16 = 0
    public var matchID: UUID
    public var createdAtNanoseconds: Int64
    /// SHA-256 of the Rule & Court Profile JSON in use at match start (computed by the caller).
    public var profileHash: [UInt8]

    public init(matchID: UUID, createdAtNanoseconds: Int64, profileHash: [UInt8]) {
        precondition(profileHash.count == 32, "profile hash must be 32 bytes")
        self.matchID = matchID
        self.createdAtNanoseconds = createdAtNanoseconds
        self.profileHash = profileHash
    }

    func encoded() -> Data {
        var d = Data(Self.magic)
        d.appendLE(version)
        d.appendLE(flags)
        d.append(contentsOf: withUnsafeBytes(of: matchID.uuid) { Array($0) })
        d.appendLE(UInt64(bitPattern: createdAtNanoseconds))
        d.append(contentsOf: profileHash)
        precondition(d.count == Self.size)
        return d
    }

    static func decode(_ d: Data) throws -> JournalHeader {
        guard d.count >= size, Array(d.prefix(4)) == magic else { throw JournalError.badHeader }
        let version: UInt16 = d.readLE(at: 4)
        guard version == 1 else { throw JournalError.unsupportedVersion(version) }
        let uuidBytes = Array(d[d.startIndex + 8 ..< d.startIndex + 24])
        let uuid = UUID(uuid: (uuidBytes[0], uuidBytes[1], uuidBytes[2], uuidBytes[3], uuidBytes[4], uuidBytes[5],
                               uuidBytes[6], uuidBytes[7], uuidBytes[8], uuidBytes[9], uuidBytes[10], uuidBytes[11],
                               uuidBytes[12], uuidBytes[13], uuidBytes[14], uuidBytes[15]))
        let created: UInt64 = d.readLE(at: 24)
        var h = JournalHeader(matchID: uuid, createdAtNanoseconds: Int64(bitPattern: created),
                              profileHash: Array(d[d.startIndex + 32 ..< d.startIndex + 64]))
        h.version = version
        h.flags = d.readLE(at: 6)
        return h
    }
}

public enum JournalError: Error, Equatable {
    case badHeader
    case unsupportedVersion(UInt16)
    case io(String)
}

/// Result of reading a journal: every intact record, and where the intact data ends.
public struct JournalReadResult: Sendable {
    public var header: JournalHeader
    public var records: [JournalRecord]
    /// Byte offset just past the last intact record.
    public var intactLength: Int
    /// True when bytes after `intactLength` were damaged or incomplete (a torn write).
    public var hadTornTail: Bool
}

public enum JournalCodec {
    public static func read(_ data: Data) throws -> JournalReadResult {
        let header = try JournalHeader.decode(data)
        var offset = JournalHeader.size
        var records: [JournalRecord] = []
        let minimumBody = 2 + 2 + 8 + 8 + 8
        while offset + 4 <= data.count {
            let length = Int(data.readLE(at: offset) as UInt32)
            guard length >= minimumBody, offset + 4 + length + 4 <= data.count else { break }
            let bodyStart = data.startIndex + offset + 4
            let body = data[bodyStart ..< bodyStart + length]
            let storedCRC: UInt32 = data.readLE(at: offset + 4 + length)
            guard CRC32C.checksum(body) == storedCRC else { break }
            let rel = offset + 4
            let record = JournalRecord(type: data.readLE(at: rel),
                                       origin: data.readLE(at: rel + 2),
                                       seq: data.readLE(at: rel + 4),
                                       lamport: data.readLE(at: rel + 12),
                                       wallClock: Int64(bitPattern: data.readLE(at: rel + 20) as UInt64),
                                       payload: Data(body.dropFirst(minimumBody)))
            records.append(record)
            offset += 4 + length + 4
        }
        return JournalReadResult(header: header, records: records, intactLength: offset,
                                 hadTornTail: offset != data.count)
    }
}

/// Append-only writer with group commit (Appendix B3). Not thread-safe by itself:
/// the app wraps it in an actor.
public final class JournalWriter {
    public let url: URL
    private var handle: FileHandle
    private var pending = Data()
    public private(set) var nextSeq: UInt64
    public private(set) var lamport: UInt64

    /// Opens (and recovers) an existing journal or creates a new one.
    public init(url: URL, header: JournalHeader) throws {
        self.url = url
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            let result = try JournalCodec.read(data)
            if result.hadTornTail {
                // Truncate a torn tail to the last intact record before appending anything new.
                let h = try FileHandle(forWritingTo: url)
                try h.truncate(atOffset: UInt64(result.intactLength))
                try h.close()
            }
            nextSeq = (result.records.filter { $0.origin == 0 }.map(\.seq).max() ?? 0) + 1
            lamport = result.records.map(\.lamport).max() ?? 0
        } else {
            guard fm.createFile(atPath: url.path, contents: header.encoded()) else {
                throw JournalError.io("cannot create \(url.path)")
            }
            nextSeq = 1
            lamport = 0
        }
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
    }

    deinit {
        try? handle.close()
    }

    /// Buffers a record and returns its sequence number.
    @discardableResult
    public func append(type: JournalRecordType, payload: Data, wallClock: Int64) -> UInt64 {
        lamport += 1
        let record = JournalRecord(type: type.rawValue, origin: 0, seq: nextSeq, lamport: lamport,
                                   wallClock: wallClock, payload: payload)
        nextSeq += 1
        pending.append(record.encoded())
        return record.seq
    }

    /// Writes buffered records and forces them to stable storage.
    public func commit() throws {
        guard !pending.isEmpty else { return }
        try handle.write(contentsOf: pending)
        pending.removeAll(keepingCapacity: true)
        let fd = handle.fileDescriptor
        #if canImport(Darwin)
        // fsync does not flush the drive cache on Apple platforms; F_FULLFSYNC does.
        if fcntl(fd, F_FULLFSYNC) != 0 { _ = fsync(fd) }
        #else
        _ = fsync(fd)
        #endif
    }
}

// MARK: - Payloads

/// Payloads are binary property lists of these Codable types.
public enum JournalPayload {
    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        return try encoder.encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try PropertyListDecoder().decode(type, from: data)
    }
}

public struct MatchStartedPayload: Codable, Hashable, Sendable {
    public var profileName: String
    public var home: TeamSheet
    public var opponent: TeamSheet
    public var firstServer: Side
    public var mode: CoachMode
    public var templateID: String
    /// Display facts needed to replay a match on another screen; optional for forward compatibility.
    public var homeName: String?
    public var opponentName: String?
    public var jerseys: [PlayerID: Int]?
    public var netHeight: Double?

    public init(profileName: String, home: TeamSheet, opponent: TeamSheet, firstServer: Side,
                mode: CoachMode, templateID: String, homeName: String? = nil, opponentName: String? = nil,
                jerseys: [PlayerID: Int]? = nil, netHeight: Double? = nil) {
        self.profileName = profileName
        self.home = home
        self.opponent = opponent
        self.firstServer = firstServer
        self.mode = mode
        self.templateID = templateID
        self.homeName = homeName
        self.opponentName = opponentName
        self.jerseys = jerseys
        self.netHeight = netHeight
    }
}

public struct RallyWonPayload: Codable, Hashable, Sendable { public var winner: Side }
public struct SeqPayload: Codable, Hashable, Sendable { public var seq: UInt64 }
public struct SubstitutionPayload: Codable, Hashable, Sendable {
    public var side: Side
    public var outgoing: PlayerID
    public var incoming: PlayerID
}
public struct ModeChangedPayload: Codable, Hashable, Sendable { public var mode: CoachMode }
public struct RotationCorrectionPayload: Codable, Hashable, Sendable {
    public var side: Side
    public var rotations: Int?
    public var setterPosition: Int?
    public var serving: Side?
}
public struct TimeOutPayload: Codable, Hashable, Sendable { public var side: Side }
public struct SketchStrokesPayload: Codable, Hashable, Sendable { public var strokes: [InkStroke] }

// MARK: - Little-endian helpers

extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }

    func readLE<T: FixedWidthInteger>(at offset: Int) -> T {
        var value: T = 0
        let start = startIndex + offset
        for i in 0..<MemoryLayout<T>.size {
            value |= T(self[start + i]) << (8 * i)
        }
        return value
    }
}
