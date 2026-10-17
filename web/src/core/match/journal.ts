// Port of Journal/Journal.swift: the append-only match journal (Appendix B3).
//
// The binary record format (CBJ1 header, length-prefixed little-endian records, CRC-32C) is byte-identical to the
// Swift journal. File IO becomes in-memory: JournalWriter keeps the journal bytes and hands each commit's records to
// the caller, who persists them (IndexedDB in the web app).
//
// Simplification: Swift writes payloads as binary property lists; here a payload is the UTF-8 JSON of the same
// Codable type, in the shape Swift's JSONEncoder writes. Reading a journal written by the iPad app therefore needs a
// binary-plist-to-JSON conversion of its payloads first.
import {
  type Codec, type JsonValue, JsonReader, DecodingError, compact, decodeFlatDictionary, decodeInt, decodeString,
  decodeUUID, encodeFlatDictionary,
} from "./codable";
import { Side } from "./court";
import { CoachMode, InkStroke } from "./liveTypes";
import { type PlayerID, TeamSheet } from "./matchState";
import { TeamSystem } from "./teamSystem";

// MARK: - CRC-32C

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli), reflected polynomial 0x82F63B78. */
export const CRC32C = {
  checksum(bytes: ArrayLike<number>): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  },
};

// MARK: - Records

const recordTypes = {
  matchStarted: 0x0001,
  rallyWon: 0x0002,
  undo: 0x0003,
  redo: 0x0004,
  substitution: 0x0005,
  liberoOverride: 0x0006,
  timeOutStarted: 0x0007,
  timeOutEnded: 0x0008,
  sketchStrokes: 0x0009,
  scoutLine: 0x000A,
  tokenMoved: 0x000B,
  modeChanged: 0x000C,
  skillCode: 0x000D,
  switchEnds: 0x000E,
  note: 0x000F,
  checkpoint: 0x0010,
  matchEnded: 0x0011,
  rotationCorrection: 0x0012,
  setStarted: 0x0013,
} as const;

/** Journal record types (Appendix B3). Values are never reused. */
export type JournalRecordType = (typeof recordTypes)[keyof typeof recordTypes];

export const JournalRecordType = {
  ...recordTypes,
  allCases: Object.values(recordTypes) as readonly JournalRecordType[],

  /** Swift `JournalRecordType(rawValue:)`. */
  fromRawValue(raw: number): JournalRecordType | undefined {
    return JournalRecordType.allCases.find((t) => t === raw);
  },
};

export interface JournalRecord {
  type: number;
  origin: number;
  seq: number;
  lamport: number;
  wallClock: number;
  payload: Uint8Array;
}

const TWO32 = 4294967296;
/** Bytes of a record body before the payload: type, origin, seq, lamport, wall clock. */
const minimumBody = 2 + 2 + 8 + 8 + 8;

function setUint64(v: DataView, offset: number, n: number): void {
  v.setUint32(offset, n % TWO32, true);
  v.setUint32(offset + 4, Math.floor(n / TWO32), true);
}

function setInt64(v: DataView, offset: number, n: number): void {
  const hi = Math.floor(n / TWO32);
  v.setUint32(offset, n - hi * TWO32, true);
  v.setInt32(offset + 4, hi, true);
}

/** Exact below 2^53, like every number in this port. */
function getUint64(v: DataView, offset: number): number {
  return v.getUint32(offset + 4, true) * TWO32 + v.getUint32(offset, true);
}

function getInt64(v: DataView, offset: number): number {
  return v.getInt32(offset + 4, true) * TWO32 + v.getUint32(offset, true);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export const JournalRecord = {
  make({ type, origin = 0, seq, lamport, wallClock, payload }:
       { type: number; origin?: number; seq: number; lamport: number; wallClock: number; payload: Uint8Array }): JournalRecord {
    return { type, origin, seq, lamport, wallClock, payload };
  },

  knownType(r: JournalRecord): JournalRecordType | undefined {
    return JournalRecordType.fromRawValue(r.type);
  },

  /** Length (u32), body = type ... end of payload, CRC-32C of exactly the body (u32); all little-endian. */
  encoded(r: JournalRecord): Uint8Array {
    const length = minimumBody + r.payload.length;
    const out = new Uint8Array(4 + length + 4);
    const v = new DataView(out.buffer);
    v.setUint32(0, length, true);
    v.setUint16(4, r.type, true);
    v.setUint16(6, r.origin, true);
    setUint64(v, 8, r.seq);
    setUint64(v, 16, r.lamport);
    setInt64(v, 24, r.wallClock);
    out.set(r.payload, 4 + minimumBody);
    v.setUint32(4 + length, CRC32C.checksum(out.subarray(4, 4 + length)), true);
    return out;
  },
};

// MARK: - Header

export interface JournalHeader {
  version: number;
  flags: number;
  /** A UUID string. */
  matchID: string;
  createdAtNanoseconds: number;
  /** SHA-256 of the Rule & Court Profile JSON in use at match start (computed by the caller). */
  profileHash: Uint8Array;
}

export type JournalErrorKind = "badHeader" | "unsupportedVersion" | "io";

/** Swift `JournalError`: `.badHeader`, `.unsupportedVersion(version)` or `.io(message)`. */
export class JournalError extends Error {
  constructor(readonly kind: JournalErrorKind, readonly detail?: string | number) {
    super(detail === undefined ? kind : `${kind}: ${detail}`);
    this.name = "JournalError";
  }
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`${uuid} is not a UUID`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const JournalHeader = {
  size: 64,
  magic: Uint8Array.of(0x43, 0x42, 0x4A, 0x31),   // "CBJ1"

  make(matchID: string, createdAtNanoseconds: number, profileHash: Uint8Array): JournalHeader {
    if (profileHash.length !== 32) throw new Error("profile hash must be 32 bytes");
    return { version: 1, flags: 0, matchID, createdAtNanoseconds, profileHash: profileHash.slice() };
  },

  encoded(h: JournalHeader): Uint8Array {
    const out = new Uint8Array(JournalHeader.size);
    const v = new DataView(out.buffer);
    out.set(JournalHeader.magic, 0);
    v.setUint16(4, h.version, true);
    v.setUint16(6, h.flags, true);
    out.set(uuidBytes(h.matchID), 8);
    setInt64(v, 24, h.createdAtNanoseconds);
    out.set(h.profileHash, 32);
    return out;
  },

  decode(d: Uint8Array): JournalHeader {
    if (d.length < JournalHeader.size || !JournalHeader.magic.every((b, i) => d[i] === b)) throw new JournalError("badHeader");
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const version = v.getUint16(4, true);
    if (version !== 1) throw new JournalError("unsupportedVersion", version);
    return { version, flags: v.getUint16(6, true), matchID: uuidString(d.subarray(8, 24)),
             createdAtNanoseconds: getInt64(v, 24), profileHash: d.slice(32, 64) };
  },
};

/** Result of reading a journal: every intact record, and where the intact data ends. */
export interface JournalReadResult {
  header: JournalHeader;
  records: JournalRecord[];
  /** Byte offset just past the last intact record. */
  intactLength: number;
  /** True when bytes after `intactLength` were damaged or incomplete (a torn write). */
  hadTornTail: boolean;
}

export const JournalCodec = {
  read(data: Uint8Array): JournalReadResult {
    const header = JournalHeader.decode(data);
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = JournalHeader.size;
    const records: JournalRecord[] = [];
    while (offset + 4 <= data.length) {
      const length = v.getUint32(offset, true);
      if (length < minimumBody || offset + 4 + length + 4 > data.length) break;
      const rel = offset + 4;
      const storedCRC = v.getUint32(rel + length, true);
      if (CRC32C.checksum(data.subarray(rel, rel + length)) !== storedCRC) break;
      records.push({ type: v.getUint16(rel, true), origin: v.getUint16(rel + 2, true), seq: getUint64(v, rel + 4),
                     lamport: getUint64(v, rel + 12), wallClock: getInt64(v, rel + 20),
                     payload: data.slice(rel + minimumBody, rel + length) });
      offset += 4 + length + 4;
    }
    return { header, records, intactLength: offset, hadTornTail: offset !== data.length };
  },
};

/**
 * Append-only writer with group commit (Appendix B3), in memory: `data` is the journal file's bytes, and `commit()`
 * returns the records it made durable so the caller can persist them.
 */
export class JournalWriter {
  readonly header: JournalHeader;
  private committed: Uint8Array;
  private committedRecords: JournalRecord[];
  private pending: JournalRecord[] = [];
  private _nextSeq: number;
  private _lamport: number;

  /**
   * Opens (and recovers) an existing journal from its bytes, or creates a new one when `existing` is undefined.
   * A torn tail is truncated to the last intact record before anything new is appended.
   */
  constructor(header: JournalHeader, existing?: Uint8Array) {
    if (existing !== undefined) {
      const result = JournalCodec.read(existing);
      this.header = result.header;
      this.committed = existing.slice(0, result.intactLength);
      this.committedRecords = result.records;
      this._nextSeq = result.records.filter((r) => r.origin === 0).reduce((m, r) => Math.max(m, r.seq), 0) + 1;
      this._lamport = result.records.reduce((m, r) => Math.max(m, r.lamport), 0);
    } else {
      this.header = header;
      this.committed = JournalHeader.encoded(header);
      this.committedRecords = [];
      this._nextSeq = 1;
      this._lamport = 0;
    }
  }

  /** Resumes from records persisted elsewhere (IndexedDB), as if they had been read from the journal file. */
  static resuming(header: JournalHeader, records: readonly JournalRecord[]): JournalWriter {
    return new JournalWriter(header, concat([JournalHeader.encoded(header), ...records.map(JournalRecord.encoded)]));
  }

  get nextSeq(): number {
    return this._nextSeq;
  }

  get lamport(): number {
    return this._lamport;
  }

  /** The journal file: header and every committed record. */
  get data(): Uint8Array {
    return this.committed;
  }

  /** Every committed record, in order. */
  get records(): readonly JournalRecord[] {
    return this.committedRecords;
  }

  /** Buffers a record and returns its sequence number. */
  append(type: JournalRecordType, payload: Uint8Array, wallClock: number): number {
    this._lamport += 1;
    const record: JournalRecord = { type, origin: 0, seq: this._nextSeq, lamport: this._lamport, wallClock, payload };
    this._nextSeq += 1;
    this.pending.push(record);
    return record.seq;
  }

  /** Commits the buffered records and returns them (empty when nothing was pending). */
  commit(): JournalRecord[] {
    if (this.pending.length === 0) return [];
    const written = this.pending;
    this.pending = [];
    this.committed = concat([this.committed, ...written.map(JournalRecord.encoded)]);
    this.committedRecords = [...this.committedRecords, ...written];
    return written;
  }
}

// MARK: - Payloads

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Payloads are the UTF-8 JSON of these Codable types (Swift: binary property lists of the same types). */
export const JournalPayload = {
  encode<T>(codec: Codec<T>, value: T): Uint8Array {
    return utf8Encoder.encode(JSON.stringify(codec.encode(value)));
  },

  /** Swift `decode(_:from:)`: `JournalPayload.decode(RallyWonPayload, data)`. Throws DecodingError. */
  decode<T>(codec: Codec<T>, data: Uint8Array): T {
    let json: unknown;
    try {
      json = JSON.parse(utf8Decoder.decode(data));
    } catch (e) {
      throw new DecodingError(`payload is not UTF-8 JSON: ${(e as Error).message}`);
    }
    return codec.decode(json);
  },
};

export interface MatchStartedPayload {
  profileName: string;
  home: TeamSheet;
  opponent: TeamSheet;
  firstServer: Side;
  mode: CoachMode;
  templateID: string;
  /** Display facts needed to replay a match on another screen; optional for forward compatibility. */
  homeName?: string;
  opponentName?: string;
  jerseys?: Record<PlayerID, number>;
  netHeight?: number;
  /** The opponent's template; undefined means the default 5-1 (outside follows setter). */
  opponentTemplateID?: string;
  /** Display names of players, when the roster has them. */
  names?: Record<PlayerID, string>;
  /** Home players available as substitutes (roster players not in the starting lineup). */
  homeBench?: PlayerID[];
}

export const MatchStartedPayload = {
  defaultOpponentTemplateID: TeamSystem.fiveOneOutside as string,

  encode(p: MatchStartedPayload): JsonValue {
    return compact({
      profileName: p.profileName, home: TeamSheet.encode(p.home), opponent: TeamSheet.encode(p.opponent),
      firstServer: p.firstServer, mode: p.mode, templateID: p.templateID, homeName: p.homeName,
      opponentName: p.opponentName,
      jerseys: p.jerseys && encodeFlatDictionary(Object.entries(p.jerseys), (k) => k, (v) => v),
      netHeight: p.netHeight, opponentTemplateID: p.opponentTemplateID,
      names: p.names && encodeFlatDictionary(Object.entries(p.names), (k) => k, (v) => v),
      homeBench: p.homeBench && [...p.homeBench],
    });
  },

  decode(json: unknown, what = "MatchStartedPayload"): MatchStartedPayload {
    const r = new JsonReader(json, what);
    const jerseys = r.opt("jerseys", (j, w) => decodeFlatDictionary(j, w, decodeUUID, decodeInt));
    const names = r.opt("names", (j, w) => decodeFlatDictionary(j, w, decodeUUID, decodeString));
    return {
      profileName: r.str("profileName"), home: r.req("home", TeamSheet.decode), opponent: r.req("opponent", TeamSheet.decode),
      firstServer: r.req("firstServer", Side.decode), mode: r.req("mode", CoachMode.decode), templateID: r.str("templateID"),
      homeName: r.optStr("homeName"), opponentName: r.optStr("opponentName"),
      jerseys: jerseys && Object.fromEntries(jerseys), netHeight: r.optNum("netHeight"),
      opponentTemplateID: r.optStr("opponentTemplateID"), names: names && Object.fromEntries(names),
      homeBench: r.optArray("homeBench", decodeUUID),
    };
  },
} satisfies Codec<MatchStartedPayload> & { defaultOpponentTemplateID: string };

/** A coach's note (type 0x000F), typed after play and attached to a rally. */
export interface NotePayload {
  /** Sequence number of the rally record the note belongs to; undefined for the match as a whole. */
  afterSeq?: number;
  text: string;
}

export const NotePayload: Codec<NotePayload> = {
  encode: (p) => compact({ afterSeq: p.afterSeq, text: p.text }),
  decode: (json) => {
    const r = new JsonReader(json, "NotePayload");
    return { afterSeq: r.optInt("afterSeq"), text: r.str("text") };
  },
};

export interface RallyWonPayload { winner: Side }

export const RallyWonPayload: Codec<RallyWonPayload> = {
  encode: (p) => ({ winner: p.winner }),
  decode: (json) => ({ winner: new JsonReader(json, "RallyWonPayload").req("winner", Side.decode) }),
};

export interface SeqPayload { seq: number }

export const SeqPayload: Codec<SeqPayload> = {
  encode: (p) => ({ seq: p.seq }),
  decode: (json) => ({ seq: new JsonReader(json, "SeqPayload").int("seq") }),
};

export interface SubstitutionPayload {
  side: Side;
  outgoing: PlayerID;
  incoming: PlayerID;
  /**
   * The shirt number and name of an incoming player new to the match (web addition: a player not in the
   * MatchStarted record, such as one of theirs or one of ours not in the team). Undefined for a known player.
   */
  number?: number;
  name?: string;
}

export const SubstitutionPayload: Codec<SubstitutionPayload> = {
  encode: (p) => compact({ side: p.side, outgoing: p.outgoing, incoming: p.incoming, number: p.number, name: p.name }),
  decode: (json) => {
    const r = new JsonReader(json, "SubstitutionPayload");
    return { side: r.req("side", Side.decode), outgoing: r.req("outgoing", decodeUUID), incoming: r.req("incoming", decodeUUID),
             number: r.optInt("number"), name: r.optStr("name") };
  },
};

export interface ModeChangedPayload { mode: CoachMode }

export const ModeChangedPayload: Codec<ModeChangedPayload> = {
  encode: (p) => ({ mode: p.mode }),
  decode: (json) => ({ mode: new JsonReader(json, "ModeChangedPayload").req("mode", CoachMode.decode) }),
};

export interface RotationCorrectionPayload {
  side: Side;
  rotations?: number;
  setterPosition?: number;
  serving?: Side;
}

export const RotationCorrectionPayload: Codec<RotationCorrectionPayload> = {
  encode: (p) => compact({ side: p.side, rotations: p.rotations, setterPosition: p.setterPosition, serving: p.serving }),
  decode: (json) => {
    const r = new JsonReader(json, "RotationCorrectionPayload");
    return { side: r.req("side", Side.decode), rotations: r.optInt("rotations"), setterPosition: r.optInt("setterPosition"),
             serving: r.opt("serving", Side.decode) };
  },
};

export interface TimeOutPayload { side: Side }

export const TimeOutPayload: Codec<TimeOutPayload> = {
  encode: (p) => ({ side: p.side }),
  decode: (json) => ({ side: new JsonReader(json, "TimeOutPayload").req("side", Side.decode) }),
};

export interface SketchStrokesPayload { strokes: InkStroke[] }

export const SketchStrokesPayload: Codec<SketchStrokesPayload> = {
  encode: (p) => ({ strokes: p.strokes.map(InkStroke.encode) }),
  decode: (json) => ({ strokes: new JsonReader(json, "SketchStrokesPayload").array("strokes", InkStroke.decode) }),
};
